'use strict';
/**
 * 图像处理管线
 *
 * 核心原则（吸取 Emby 崩溃的教训）：
 *   1. 包围盒缩放：保持宽高比，绝不拉伸，绝不放大小图
 *   2. 严格并发闸门：ffmpeg 进程数硬限制
 *   3. 两级缓存：内存 LRU + 磁盘 LRU（O(1) 容量统计）
 *   4. 并发请求去重：同一张图同时请求只触发一次解码
 *   5. 超时强杀 + 失败黑名单，绝不无限重试
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { spawn } = require('child_process');
const crypto = require('crypto');

const FFMPEG = process.env.FFMPEG_PATH ||
  ['/var/packages/ffmpeg8/target/bin/ffmpeg', '/var/packages/ffmpeg7/target/bin/ffmpeg', '/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg']
    .find(p => { try { return fs.existsSync(p); } catch { return false; } }) || 'ffmpeg';

const MAGICK = process.env.MAGICK_PATH ||
  ['/usr/bin/convert', '/usr/local/bin/convert']
    .find(p => { try { return fs.existsSync(p); } catch { return false; } }) || null;

// ----------------------------------------------------------- 信号量
class Semaphore {
  constructor(n) {
    this.n = Math.max(1, n);
    this.active = 0;
    this.queue = [];
  }
  acquire() {
    if (this.active < this.n) {
      this.active++;
      return Promise.resolve();
    }
    return new Promise(res => this.queue.push(res));
  }
  release() {
    const next = this.queue.shift();
    if (next) next();
    else this.active--;
  }
  async run(fn) {
    await this.acquire();
    try { return await fn(); } finally { this.release(); }
  }
  setLimit(n) {
    this.n = Math.max(1, n);
    while (this.active < this.n && this.queue.length) {
      this.active++;
      this.queue.shift()();
    }
  }
}

// ----------------------------------------------------------- 内存 LRU（张数 + 字节双重上限，防 OOM）
class LRU {
  constructor(maxItems, maxBytes = 64 * 1024 * 1024) {
    this.max = Math.max(1, maxItems | 0);
    this.maxBytes = Math.max(1024 * 1024, maxBytes | 0);
    this.totalBytes = 0;
    this.map = new Map();
  }
  get(k) {
    if (!this.map.has(k)) return null;
    const v = this.map.get(k);
    this.map.delete(k);
    this.map.set(k, v);
    return v;
  }
  set(k, v) {
    const len = v ? v.length : 0;
    if (this.map.has(k)) {
      const old = this.map.get(k);
      this.totalBytes -= old ? old.length : 0;
      this.map.delete(k);
    }
    this.map.set(k, v);
    this.totalBytes += len;
    this._evict();
  }
  _evict() {
    while (this.map.size > this.max || (this.totalBytes > this.maxBytes && this.map.size > 1)) {
      const oldestKey = this.map.keys().next().value;
      const oldestVal = this.map.get(oldestKey);
      this.totalBytes -= oldestVal ? oldestVal.length : 0;
      this.map.delete(oldestKey);
    }
  }
  setLimits(maxItems, maxMB) {
    this.max = Math.max(1, maxItems | 0);
    if (maxMB) this.maxBytes = Math.max(1024 * 1024, (maxMB | 0) * 1024 * 1024);
    this._evict();
  }
  clear() { this.map.clear(); this.totalBytes = 0; }
  get size() { return this.map.size; }
}

// ----------------------------------------------------------- 磁盘缓存 LRU
class DiskCache {
  constructor(dir, maxMB) {
    this.dir = dir;
    this.maxBytes = maxMB * 1024 * 1024;
    this.index = new Map(); // filename -> { size, at }
    this.totalBytes = 0;
    this._loaded = false;
  }

  async init() {
    await fsp.mkdir(this.dir, { recursive: true });
    this.index.clear();
    this.totalBytes = 0;
    try {
      const names = await fsp.readdir(this.dir);
      for (const n of names) {
        if (!n.endsWith('.bin')) continue;
        try {
          const st = await fsp.stat(path.join(this.dir, n));
          this.index.set(n, { size: st.size, at: st.mtimeMs });
          this.totalBytes += st.size;
        } catch { /* skip */ }
      }
    } catch { /* skip */ }
    this._loaded = true;
    await this.prune();
  }

  key(id, opt) {
    const h = crypto.createHash('md5')
      .update(`${id}|${opt.maxWidth}x${opt.maxHeight}|${opt.format}|${opt.quality}|${opt.scaler}|${opt.pixFmt}|${opt.allowUpscale ? 1 : 0}`)
      .digest('hex').slice(0, 20);
    return h + '.bin';
  }

  get(name) {
    const meta = this.index.get(name);
    if (!meta) return null;
    meta.at = Date.now();
    return path.join(this.dir, name);
  }

  async putBuffer(name, buf) {
    const dest = path.join(this.dir, name);
    await fsp.writeFile(dest, buf);
    const old = this.index.get(name);
    if (old) this.totalBytes -= old.size;
    this.index.set(name, { size: buf.length, at: Date.now() });
    this.totalBytes += buf.length;
    await this.prune();
    return dest;
  }

  async prune() {
    if (this.totalBytes <= this.maxBytes) return;
    const entries = [...this.index.entries()].sort((a, b) => a[1].at - b[1].at);
    for (const [name, meta] of entries) {
      if (this.totalBytes <= this.maxBytes * 0.9) break;
      try { await fsp.unlink(path.join(this.dir, name)); } catch { /* skip */ }
      this.index.delete(name);
      this.totalBytes = Math.max(0, this.totalBytes - meta.size);
    }
  }

  clear() {
    const names = [...this.index.keys()];
    this.index.clear();
    this.totalBytes = 0;
    return Promise.all(names.map(n => fsp.unlink(path.join(this.dir, n)).catch(() => {})));
  }

  sizeBytes() { return this.totalBytes; }
  count() { return this.index.size; }
}

// ----------------------------------------------------------- 图像管线
class ImagePipeline {
  constructor(cfg, cacheDir) {
    this.cfg = cfg;
    this.sem = new Semaphore(cfg.image.concurrency);
    this.mem = new LRU(cfg.cache.memoryItems, (cfg.cache.memoryMaxMB || 64) * 1024 * 1024);
    this.disk = new DiskCache(cacheDir, cfg.cache.diskMaxMB);
    this.inflight = new Map();
    this.stats = { hits: 0, miss: 0, errors: 0, lastMs: 0 };
    this.tmpDir = path.join(cacheDir, 'tmp');
  }

  async init() {
    if (this.cfg.cache.diskEnabled) {
      await this.disk.init();
    } else {
      await fsp.mkdir(this.disk.dir, { recursive: true });
    }
    await fsp.mkdir(this.tmpDir, { recursive: true });
    try {
      const names = await fsp.readdir(this.tmpDir);
      await Promise.all(names.map(n => fsp.unlink(path.join(this.tmpDir, n)).catch(() => {})));
    } catch { /* skip */ }
  }

  setConcurrency(n) { this.sem.setLimit(n); }
  setMemoryLimits(items, maxMB) { this.mem.setLimits(items, maxMB); }

  _opts() {
    const i = this.cfg.image;
    return {
      maxWidth: i.maxWidth,
      maxHeight: i.maxHeight,
      format: i.format,
      quality: i.format === 'jpeg' ? i.jpegQuality : i.quality,
      scaler: i.scaler,
      pixFmt: i.pixFmt,
      allowUpscale: i.allowUpscale,
    };
  }

  contentType() {
    const f = this.cfg.image.format;
    if (f === 'jpeg') return 'image/jpeg';
    if (f === 'avif') return 'image/avif';
    return 'image/webp';
  }

  async get(idStr, localPath, streamFactory, ext) {
    const opt = this._opts();
    const key = this.disk.key(idStr, opt);

    // 1. 内存
    const memHit = this.mem.get(key);
    if (memHit) {
      this.stats.hits++;
      return { buffer: memHit, contentType: this.contentType(), from: 'mem' };
    }

    // 2. 磁盘（仅在启用磁盘缓存时读写）
    if (this.cfg.cache.diskEnabled) {
      const diskPath = this.disk.get(key);
      if (diskPath && fs.existsSync(diskPath)) {
        const buf = await fsp.readFile(diskPath);
        this.mem.set(key, buf);
        this.stats.hits++;
        return { buffer: buf, contentType: this.contentType(), from: 'disk' };
      }
    }

    // 3. 并发去重
    if (this.inflight.has(key)) {
      const buf = await this.inflight.get(key);
      return { buffer: buf, contentType: this.contentType(), from: 'dedup' };
    }

    // 4. 生成（受信号量控制）
    this.stats.miss++;
    const p = this.sem.run(() => this._generate(key, localPath, streamFactory, ext, opt))
      .then(buf => {
        this.mem.set(key, buf);
        return buf;
      })
      .finally(() => {
        this.inflight.delete(key);
      });

    this.inflight.set(key, p);
    const buf = await p;
    return { buffer: buf, contentType: this.contentType(), from: 'gen' };
  }

  async _generate(key, localPath, streamFactory, ext, opt) {
    const t0 = Date.now();
    const outTmp = path.join(this.tmpDir, `${crypto.randomBytes(8).toString('hex')}.out`);

    try {
      const isHeic = /\.(heic|heif)$/i.test(ext || '') ||
                     (localPath && /\.(heic|heif)$/i.test(localPath));

      let buf;
      if (isHeic && MAGICK) {
        buf = await this._viaMagick(localPath, streamFactory, opt, outTmp);
      } else {
        buf = await this._viaFfmpeg(localPath, streamFactory, opt, outTmp);
      }

      this.stats.lastMs = Date.now() - t0;
      if (this.cfg.cache.diskEnabled) {
        await this.disk.putBuffer(key, buf);
      }
      return buf;
    } catch (e) {
      this.stats.errors++;
      throw e;
    } finally {
      fsp.unlink(outTmp).catch(() => {});
    }
  }

  _buildFilter(opt) {
    const W = Math.max(2, opt.maxWidth | 0);
    const H = Math.max(2, opt.maxHeight | 0);
    const flags = opt.scaler || 'lanczos';

    let f = `scale=${W}:${H}:force_original_aspect_ratio=decrease:force_divisible_by=2:flags=${flags}`;
    if (!opt.allowUpscale) {
      f = `scale=w='min(iw,${W})':h='min(ih,${H})':force_original_aspect_ratio=decrease:force_divisible_by=2:flags=${flags}`;
    }
    return f;
  }

  _viaFfmpeg(localPath, streamFactory, opt) {
    return new Promise(async (resolve, reject) => {
      let inputArgs;
      let stdinStream = null;

      if (localPath) {
        inputArgs = ['-i', localPath];
      } else if (streamFactory) {
        inputArgs = ['-i', 'pipe:0'];
        try {
          stdinStream = await streamFactory();
        } catch (e) {
          return reject(e);
        }
      } else {
        return reject(new Error('no input'));
      }

      const vf = this._buildFilter(opt);
      const args = [
        '-hide_banner', '-loglevel', 'error',
        ...inputArgs,
        '-vf', vf,
        '-frames:v', '1',
        '-pix_fmt', opt.pixFmt === '444' ? 'yuv444p' : 'yuv420p',
      ];

      if (opt.format === 'jpeg') {
        args.push('-c:v', 'mjpeg', '-q:v', String(opt.quality));
      } else if (opt.format === 'avif') {
        args.push('-c:v', 'libaom-av1', '-crf', String(Math.round((100 - opt.quality) / 2)), '-still-picture', '1');
      } else {
        args.push('-c:v', 'libwebp', '-quality', String(opt.quality), '-compression_level', '4');
      }
      args.push('-f', 'image2pipe', '-');

      const child = spawn(FFMPEG, args, { stdio: [stdinStream ? 'pipe' : 'ignore', 'pipe', 'pipe'] });

      const chunks = [];
      const errs = [];
      let done = false;

      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        try { child.kill('SIGKILL'); } catch { /* skip */ }
        reject(new Error(`ffmpeg timeout ${this.cfg.image.timeoutSec}s`));
      }, (this.cfg.image.timeoutSec || 30) * 1000);

      child.stdout.on('data', c => chunks.push(c));
      child.stderr.on('data', c => { if (errs.length < 50) errs.push(c); });

      child.on('error', e => {
        if (done) return;
        done = true; clearTimeout(timer);
        reject(e);
      });

      child.on('close', code => {
        if (done) return;
        done = true; clearTimeout(timer);
        if (code !== 0 || !chunks.length) {
          return reject(new Error(`ffmpeg exit ${code}: ${Buffer.concat(errs).toString().slice(0, 300)}`));
        }
        resolve(Buffer.concat(chunks));
      });

      if (stdinStream) {
        const { Readable } = require('stream');
        const nodeStream = typeof stdinStream.pipe === 'function'
          ? stdinStream
          : Readable.fromWeb(stdinStream);
        nodeStream.on('error', e => { try { child.kill('SIGKILL'); } catch { /* skip */ } reject(e); });
        nodeStream.pipe(child.stdin);
      }
    });
  }

  _viaMagick(localPath, streamFactory, opt, outTmp) {
    return new Promise(async (resolve, reject) => {
      if (!localPath) {
        try {
          const s = await streamFactory();
          const { Readable } = require('stream');
          const ns = typeof s.pipe === 'function' ? s : Readable.fromWeb(s);
          const inTmp = outTmp + '.in';
          await new Promise((res, rej) => {
            const ws = fs.createWriteStream(inTmp);
            ns.pipe(ws);
            ws.on('finish', res);
            ws.on('error', rej);
            ns.on('error', rej);
          });
          localPath = inTmp;
        } catch (e) {
          return reject(e);
        }
      }

      const W = opt.maxWidth;
      const H = opt.maxHeight;
      const args = [
        localPath,
        '-auto-orient',
        '-resize', `${W}x${H}>`,
        '-quality', String(opt.quality),
        opt.format === 'jpeg' ? 'jpg:' + outTmp : 'webp:' + outTmp,
      ];
      const child = spawn(MAGICK, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      const errs = [];
      child.stderr.on('data', c => { if (errs.length < 50) errs.push(c); });
      child.on('close', async code => {
        if (code !== 0) {
          return reject(new Error(`magick exit ${code}: ${Buffer.concat(errs).toString().slice(0, 200)}`));
        }
        try {
          resolve(await fsp.readFile(outTmp));
        } catch (e) { reject(e); }
      });
      child.on('error', reject);
    });
  }
}

module.exports = { ImagePipeline, Semaphore, LRU, DiskCache, FFMPEG, MAGICK };

'use strict';
/**
 * LuminaSlide 主服务
 * HTTP / HTTPS + WebSocket 实时同步与控制
 */
const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');

const { Config } = require('./config');
const { Store } = require('./store');
const { createSource } = require('./sources');
const { Scanner } = require('./scanner');
const { Randomizer } = require('./randomizer');
const { ImagePipeline } = require('./pipeline');
const { WSHub } = require('./ws');
const { AuthManager, hashPassword } = require('./auth');

const BASE = path.resolve(__dirname, '..');
const PUBLIC = path.join(BASE, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

const SEC_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'SAMEORIGIN',
  'Referrer-Policy': 'same-origin',
};

function json(res, code, obj, extraHeaders = {}) {
  const b = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(code, {
    ...SEC_HEADERS,
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': b.length,
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
  res.end(b);
}

function text(res, code, s, ct = 'text/plain; charset=utf-8') {
  const b = Buffer.from(s, 'utf8');
  res.writeHead(code, { ...SEC_HEADERS, 'Content-Type': ct, 'Content-Length': b.length });
  res.end(b);
}

function readBody(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []; let n = 0;
    req.on('data', c => {
      n += c.length;
      if (n > limit) { req.destroy(); return reject(new Error('body too large')); }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

class App {
  constructor() {
    this.cfg = new Config(BASE);
    this.log = (...a) => console.log('[lumina]', ...a);
    this.ws = new WSHub();
    this.store = null;
    this.sources = [];
    this.scanner = null;
    this.randomizer = null;
    this.pipeline = null;
    this.server = null;
    this.auth = null;
    this.playState = { playing: true, interval: 8, current: null };
    this.filter = { sourceId: '', album: '', onlyFavorites: false };
    this._poolCache = null;
    this._poolKey = null;
    this._scanBroadcastTimer = null;
  }

  _reloadSources() {
    this.sources = (this.cfg.get().sources || [])
      .filter(s => s.enabled !== false)
      .map(createSource);
  }

  async init() {
    const dirs = [this.cfg.dataDir, this.cfg.cacheDir, path.join(this.cfg.cacheDir, 'tmp')];
    for (const d of dirs) await fsp.mkdir(d, { recursive: true });

    this.store = new Store(path.join(this.cfg.dataDir, 'index.db'));
    this.auth = new AuthManager(this.store, () => this.cfg.get().auth);
    this._reloadSources();

    const savedFilter = this.store.getState('filter', null);
    if (savedFilter && typeof savedFilter === 'object') {
      this.filter = {
        sourceId: savedFilter.sourceId || '',
        album: savedFilter.album || '',
        onlyFavorites: !!savedFilter.onlyFavorites,
      };
    }

    this.scanner = new Scanner(this.cfg.get(), this.store, this.sources, this.log);

    this.randomizer = new Randomizer(
      () => this._getPool(),
      { get: (k, d) => this.store.getState(k, d), set: (k, v) => this.store.setState(k, v) },
      {
        mode: this.cfg.get().play.mode,
        onRestart: this.cfg.get().play.onRestart,
        weakRecent: this.cfg.get().play.weakRecent,
        fairness: this.cfg.get().play.fairness,
      },
      () => this._pickByAlbum()
    );

    this.pipeline = new ImagePipeline(this.cfg.get(), this.cfg.cacheDir);
    await this.pipeline.init();

    this.playState.interval = this.cfg.get().play.interval;
    this.log(`索引: ${this.store.countFiles()} 张, 相册: ${this.store.totalAlbums()} 个, 收藏: ${this.store.countFavorites()} 张`);
  }

  _filterKey() {
    return `${this.filter.sourceId}|${this.filter.album}|${this.filter.onlyFavorites ? 1 : 0}|${this.store.countFiles()}|${this.store.countBlack()}|${this.store.countFavorites()}`;
  }

  _getPool() {
    const fk = this._filterKey();
    if (!this._poolCache || this._poolKey !== fk) {
      this._poolCache = this.store.allIds(this.filter);
      this._poolKey = fk;
    }
    return this._poolCache;
  }

  invalidatePool() {
    this._poolCache = null;
    this._poolKey = null;
    if (this.randomizer) this.randomizer.maybeReshuffle();
  }

  _pickByAlbum() {
    const albums = this.store.albumList({ sourceId: this.filter.sourceId });
    if (!albums.length) return null;
    const target = this.filter.album
      ? { album: this.filter.album, source_id: this.filter.sourceId }
      : albums[crypto.randomInt(0, albums.length)];
    const ids = this.store.idsByAlbum(target.album, target.source_id || '');
    if (!ids.length) return null;
    return ids[crypto.randomInt(0, ids.length)];
  }

  _formatPayload(file) {
    return {
      id: file.id,
      name: file.name,
      album: file.album,
      relDir: file.rel_dir,
      source: file.source_id,
      size: file.size || 0,
      ext: file.ext || '',
      isFavorite: this.store.isFavorite(file.id),
      img: `/img/${file.id}`,
      progress: this.randomizer.progress(),
    };
  }

  nextItem() {
    const id = this.randomizer.next();
    if (id == null) return null;
    const file = this.store.getFile(id);
    if (!file) return null;
    const src = this.sources.find(s => s.id === file.source_id);
    if (!src) return null;
    return { file, src };
  }

  // ---- 路由 ----
  async handle(req, res) {
    const u = new URL(req.url, 'http://localhost');
    const p = decodeURIComponent(u.pathname);
    const query = Object.fromEntries(u.searchParams);
    try {
      if (req.method === 'OPTIONS') {
        res.writeHead(204, { ...SEC_HEADERS });
        return res.end();
      }

      // 无需鉴权的公开路径
      if (p === '/api/health') return json(res, 200, { ok: true, name: 'LuminaSlide', version: '1.1.2' });
      if (p === '/favicon.ico' || p === '/icon.svg') return this._static(res, 'icon.svg');
      if (p === '/login') return this._static(res, 'login.html');
      if (p === '/api/auth/status') {
        const a = this.auth.authenticate(req);
        return json(res, 200, {
          enabled: this.auth.isEnabled(),
          authenticated: a.ok,
          user: a.ok ? a.user : null,
          isDefaultCredentials: this.auth.isDefaultCredentials(),
        });
      }
      if (p === '/api/auth/login' && req.method === 'POST') return this._apiLogin(req, res);
      if (p === '/api/auth/logout' && req.method === 'POST') {
        return json(res, 200, { ok: true }, { 'Set-Cookie': this.auth.clearCookieHeader() });
      }

      // 鉴权拦截（当 auth.enabled = true 时）
      const authRes = this.auth.authenticate(req);
      if (!authRes.ok) {
        if (p.startsWith('/api/') || p.startsWith('/img/')) {
          return json(res, 401, { error: '未登录或会话已过期' });
        }
        res.writeHead(302, { ...SEC_HEADERS, Location: '/login?next=' + encodeURIComponent(p) });
        return res.end();
      }

      // 静态资源
      if (p === '/') return this._static(res, 'index.html');
      if (p === '/admin') return this._static(res, 'admin.html');
      if (/^\/(app|admin)\.(js|css)$/.test(p)) {
        return this._static(res, p.slice(1));
      }

      // API
      if (p === '/api/state') return this._apiState(res);
      if (p === '/api/next') return this._apiNext(res);
      if (p === '/api/prev') return this._apiPrev(res);
      if (p === '/api/control' && req.method === 'POST') return this._apiControl(req, res);
      if (p === '/api/config') return this._apiConfig(req, res);
      if (p === '/api/sources/test' && req.method === 'POST') return this._apiTestSource(req, res);
      if (p === '/api/scan' && req.method === 'POST') return this._apiScan(req, res);
      if (p === '/api/scan/cancel' && req.method === 'POST') { this.scanner.cancel(); return json(res, 200, { ok: true }); }
      if (p === '/api/scan/status') return json(res, 200, this.scanner.status());
      if (p === '/api/stats') return json(res, 200, this._statsObj());
      if (p === '/api/albums') return this._apiAlbums(query, res);
      if (p === '/api/filter' && req.method === 'POST') return this._apiFilter(req, res);
      if (p === '/api/favorite' && req.method === 'POST') return this._apiFavorite(req, res);
      if (p === '/api/favorites') return this._apiFavorites(query, res);
      if (p === '/api/blacklist' && req.method === 'GET') return json(res, 200, { items: this.store.listBlack(), count: this.store.countBlack() });
      if (p === '/api/blacklist' && req.method === 'DELETE') {
        this.store.clearBlack();
        this.invalidatePool();
        return json(res, 200, { ok: true });
      }
      if (p === '/api/blacklist/remove' && req.method === 'POST') return this._apiBlacklistRemove(req, res);
      if (p === '/api/cache/clear' && req.method === 'POST') {
        this.pipeline.mem.clear();
        await this.pipeline.disk.clear();
        return json(res, 200, { ok: true });
      }
      if (p === '/api/reshuffle' && req.method === 'POST') {
        return json(res, 200, { ok: true, progress: this.randomizer.reshuffle() });
      }
      if (p.startsWith('/api/preview')) {
        const ids = this._getPool();
        if (!ids.length) return json(res, 404, { error: '索引为空' });
        const target = query.id ? Number(query.id) : ids[0];
        return this._serveImage(req, res, target);
      }
      if (p.startsWith('/img/')) {
        const id = Number(p.slice(5));
        if (!Number.isFinite(id)) return text(res, 400, 'bad id');
        return this._serveImage(req, res, id);
      }

      return text(res, 404, 'Not Found');
    } catch (e) {
      this.log('请求异常', p, e.message);
      if (!res.headersSent) return json(res, 500, { error: e.message });
      try { res.end(); } catch {}
    }
  }

  async _static(res, name) {
    const fp = path.resolve(PUBLIC, name);
    if (!fp.startsWith(PUBLIC + path.sep) && fp !== PUBLIC) {
      return text(res, 403, 'forbidden');
    }
    try {
      const b = await fsp.readFile(fp);
      res.writeHead(200, {
        ...SEC_HEADERS,
        'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream',
        'Content-Length': b.length,
        'Cache-Control': 'no-cache',
      });
      res.end(b);
    } catch {
      text(res, 404, 'not found');
    }
  }

  _apiState(res) {
    const cfg = this.cfg.get();
    const pool = this._getPool();
    json(res, 200, {
      playing: this.playState.playing,
      interval: this.playState.interval,
      current: this.playState.current,
      progress: this.randomizer.progress(),
      transition: cfg.play.transition,
      showInfo: cfg.play.showInfo,
      ambientBg: cfg.play.ambientBg !== false,
      prefetch: cfg.play.prefetch,
      filter: this.filter,
      poolTotal: pool.length,
      total: this.store.countFiles(),
      favorites: this.store.countFavorites(),
      clients: this.ws.count,
    });
  }

  _apiNext(res) {
    const item = this.nextItem();
    if (!item) {
      return json(res, 200, {
        empty: true,
        total: this.store.countFiles(),
        poolTotal: this._getPool().length,
        filter: this.filter,
      });
    }
    const payload = this._formatPayload(item.file);
    this.playState.current = payload;
    json(res, 200, payload);
  }

  _apiPrev(res) {
    const id = this.randomizer.prev();
    if (id == null) return this._apiNext(res);
    const file = this.store.getFile(id);
    if (!file) return this._apiNext(res);
    const payload = this._formatPayload(file);
    this.playState.current = payload;
    json(res, 200, payload);
  }

  async _apiControl(req, res) {
    const body = JSON.parse(await readBody(req) || '{}');
    if (body.action === 'play') this.playState.playing = true;
    if (body.action === 'pause') this.playState.playing = false;
    if (body.action === 'toggle') this.playState.playing = !this.playState.playing;
    if (body.action === 'interval' && Number(body.value) >= 2) {
      this.playState.interval = Math.min(600, Math.round(Number(body.value)));
    }
    this.ws.send({ type: 'control', ...this.playState });
    json(res, 200, { ok: true, ...this.playState });
  }

  _maskConfig(rawCfg) {
    const c = JSON.parse(JSON.stringify(rawCfg));
    (c.sources || []).forEach(s => { if (s.password) s.password = '••••••'; });
    c.auth = {
      enabled: !!(rawCfg.auth && rawCfg.auth.enabled),
      username: (rawCfg.auth && rawCfg.auth.username) || 'admin',
      hasCustomPassword: !!(rawCfg.auth && rawCfg.auth.passwordHash),
      isDefaultCredentials: this.auth ? this.auth.isDefaultCredentials() : true,
      sessionTtlHours: (rawCfg.auth && rawCfg.auth.sessionTtlHours) || 168,
    };
    return c;
  }

  async _apiLogin(req, res) {
    const ip = req.socket.remoteAddress || 'unknown';
    const rl = this.auth.checkRateLimit(ip);
    if (!rl.ok) {
      return json(res, 429, { error: `尝试过于频繁，请 ${rl.retrySec} 秒后再试` });
    }
    const body = JSON.parse(await readBody(req) || '{}');
    const username = String(body.username || '').trim();
    const password = String(body.password || '');
    if (!this.auth.verifyLogin(username, password)) {
      this.auth.recordFailure(ip);
      return json(res, 401, { error: '用户名或密码错误' });
    }
    this.auth.clearFailures(ip);
    const token = this.auth.createToken(username);
    const isHttps = !!req.socket.encrypted;
    return json(res, 200, {
      ok: true,
      user: username,
      isDefaultCredentials: this.auth.isDefaultCredentials(),
    }, { 'Set-Cookie': this.auth.makeCookieHeader(token, isHttps) });
  }

  async _apiConfig(req, res) {
    if (req.method === 'GET') {
      return json(res, 200, { config: this._maskConfig(this.cfg.get()), stats: this._statsObj() });
    }
    const body = JSON.parse(await readBody(req));
    const patch = body.config || body;
    if (patch.sources) {
      const orig = this.cfg.get().sources;
      patch.sources.forEach(s => {
        if (s.password === '••••••') {
          const o = orig.find(x => x.id === s.id);
          if (o) s.password = o.password || '';
        }
      });
    }
    if (patch.auth) {
      const origAuth = this.cfg.get().auth || {};
      const nextAuth = {
        enabled: !!patch.auth.enabled,
        username: String(patch.auth.username || origAuth.username || 'admin').trim() || 'admin',
        passwordHash: origAuth.passwordHash || '',
        sessionTtlHours: patch.auth.sessionTtlHours || origAuth.sessionTtlHours || 168,
      };
      if (typeof patch.auth.newPassword === 'string' && patch.auth.newPassword.length > 0) {
        nextAuth.passwordHash = hashPassword(patch.auth.newPassword);
      }
      patch.auth = nextAuth;
    }
    this.cfg.save(patch);
    this._applyConfig();
    json(res, 200, { ok: true, config: this._maskConfig(this.cfg.get()), stats: this._statsObj() });
  }

  _applyConfig() {
    const c = this.cfg.get();
    this._reloadSources();
    this.scanner.cfg = c;
    this.scanner.sources = this.sources;
    this.pipeline.cfg = c;
    this.pipeline.setConcurrency(c.image.concurrency);
    this.pipeline.setMemoryLimits(c.cache.memoryItems, c.cache.memoryMaxMB);
    this.pipeline.disk.maxBytes = c.cache.diskMaxMB * 1024 * 1024;
    if (c.cache.diskEnabled && !this.pipeline.disk._loaded) {
      this.pipeline.disk.init().catch(() => {});
    }
    this.randomizer.cfg.mode = c.play.mode;
    this.randomizer.cfg.onRestart = c.play.onRestart;
    this.randomizer.cfg.weakRecent = c.play.weakRecent;
    this.randomizer.cfg.fairness = c.play.fairness;
    this.playState.interval = c.play.interval;
    this.ws.send({
      type: 'config',
      interval: this.playState.interval,
      transition: c.play.transition,
      showInfo: c.play.showInfo,
      ambientBg: c.play.ambientBg !== false,
      prefetch: c.play.prefetch,
    });
  }

  async _apiTestSource(req, res) {
    const body = JSON.parse(await readBody(req));
    const s = createSource(body.source || {});
    try {
      const t0 = Date.now();
      const items = await s.list(body.source.root || s.root);
      json(res, 200, {
        ok: true,
        ms: Date.now() - t0,
        count: items.length,
        sample: items.slice(0, 8).map(i => ({ name: i.name, isDir: i.isDir, size: i.size })),
      });
    } catch (e) {
      json(res, 200, { ok: false, error: e.message });
    }
  }

  async _apiScan(req, res) {
    if (this.scanner.isRunning()) return json(res, 409, { error: '扫描进行中' });
    const body = JSON.parse(await readBody(req) || '{}');

    clearInterval(this._scanBroadcastTimer);
    this._scanBroadcastTimer = setInterval(() => {
      this.ws.send({ type: 'scan', status: this.scanner.status() });
    }, 800);

    this.scanner.run(body).then(() => {
      clearInterval(this._scanBroadcastTimer);
      this.invalidatePool();
      this.ws.send({ type: 'scan', status: this.scanner.status() });
    }).catch(e => {
      clearInterval(this._scanBroadcastTimer);
      this.log('扫描失败', e.message);
      this.ws.send({ type: 'scan', status: this.scanner.status(), error: e.message });
    });
    json(res, 200, { ok: true, started: true });
  }

  _apiAlbums(query, res) {
    const albums = this.store.albumList({
      q: query.q || '',
      sourceId: query.sourceId || '',
      limit: query.limit || 200,
    });
    json(res, 200, {
      albums,
      sources: this.sources.map(s => ({ id: s.id, type: s.type })),
      filter: this.filter,
    });
  }

  async _apiFilter(req, res) {
    const body = JSON.parse(await readBody(req) || '{}');
    this.filter = {
      sourceId: String(body.sourceId || ''),
      album: String(body.album || ''),
      onlyFavorites: !!body.onlyFavorites,
    };
    this.store.setState('filter', this.filter);
    this.invalidatePool();
    const pool = this._getPool();
    this.ws.send({ type: 'filter', filter: this.filter, poolTotal: pool.length });
    json(res, 200, { ok: true, filter: this.filter, poolTotal: pool.length });
  }

  async _apiFavorite(req, res) {
    const body = JSON.parse(await readBody(req) || '{}');
    const id = Number(body.id);
    if (!Number.isFinite(id)) return json(res, 400, { error: 'invalid id' });
    const isFav = typeof body.favorite === 'boolean'
      ? this.store.setFavorite(id, body.favorite)
      : this.store.toggleFavorite(id);
    if (this.filter.onlyFavorites) this.invalidatePool();
    this.ws.send({ type: 'favorite', id, isFavorite: isFav, favorites: this.store.countFavorites() });
    json(res, 200, { ok: true, id, isFavorite: isFav, favorites: this.store.countFavorites() });
  }

  _apiFavorites(query, res) {
    const limit = Number(query.limit) || 100;
    const offset = Number(query.offset) || 0;
    json(res, 200, {
      items: this.store.listFavorites(limit, offset),
      total: this.store.countFavorites(),
    });
  }

  async _apiBlacklistRemove(req, res) {
    const body = JSON.parse(await readBody(req) || '{}');
    if (!body.source_id || !body.path) return json(res, 400, { error: 'missing source_id or path' });
    this.store.removeBlack(body.source_id, body.path);
    this.invalidatePool();
    json(res, 200, { ok: true, count: this.store.countBlack() });
  }

  _statsObj() {
    const bySrc = this.store.countBySource();
    const pipe = this.pipeline.stats;
    const totalReq = (pipe.hits || 0) + (pipe.miss || 0);
    return {
      files: this.store.countFiles(),
      albums: this.store.totalAlbums(),
      favorites: this.store.countFavorites(),
      bySource: bySrc,
      blacklist: this.store.countBlack(),
      cacheMem: this.pipeline.mem.size,
      cacheMemMB: +(this.pipeline.mem.totalBytes / 1048576).toFixed(1),
      cacheDisk: this.pipeline.disk.count(),
      cacheDiskMB: +(this.pipeline.disk.sizeBytes() / 1048576).toFixed(1),
      diskCacheEnabled: !!this.cfg.get().cache.diskEnabled,
      authEnabled: this.auth ? this.auth.isEnabled() : false,
      hitRate: totalReq ? Math.round((pipe.hits / totalReq) * 100) : 0,
      pipe,
      sources: this.sources.map(s => ({ id: s.id, type: s.type, root: s.root })),
      scan: this.scanner.status(),
      randomizer: this.randomizer.progress(),
      filter: this.filter,
      clients: this.ws.count,
    };
  }

  async _serveImage(req, res, id) {
    const file = this.store.getFile(id);
    if (!file) return text(res, 404, 'no such file');
    if (this.store.isBlack(file.source_id, file.path)) return text(res, 410, 'blacklisted');
    const src = this.sources.find(s => s.id === file.source_id);
    if (!src) return text(res, 404, 'source removed');

    try {
      const localPath = src.localPath(file.path);
      const streamFactory = localPath ? null : () => src.openRead(file.path);

      const out = await this.pipeline.get(
        `${file.source_id}:${file.path}`,
        localPath,
        streamFactory,
        file.ext
      );

      const etag = '"' + crypto.createHash('md5').update(out.buffer).digest('hex').slice(0, 16) + '"';
      if (req.headers['if-none-match'] === etag) {
        res.writeHead(304, { ETag: etag });
        return res.end();
      }
      res.writeHead(200, {
        'Content-Type': out.contentType,
        'Content-Length': out.buffer.length,
        'Cache-Control': 'public, max-age=86400',
        ETag: etag,
        'X-Cache': out.from,
      });
      if (req.method === 'HEAD') return res.end();
      res.end(out.buffer);
    } catch (e) {
      this.store.addBlack(file.source_id, file.path, e.message.slice(0, 200));
      this.invalidatePool();
      this.log('取图失败，已加入黑名单', file.path, e.message);
      text(res, 502, 'image failed: ' + e.message);
    }
  }

  async start() {
    const sc = this.cfg.get().server;
    const port = sc.port;
    const host = sc.host;

    const handler = (req, res) => this.handle(req, res);
    const onUpgrade = (req, socket) => {
      if ((req.headers.upgrade || '').toLowerCase() === 'websocket') {
        if (!this.auth.authenticate(req).ok) {
          socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
          socket.destroy();
          return;
        }
        this.ws.handleUpgrade(req, socket);
      } else {
        socket.destroy();
      }
    };

    // ---- HTTP ----
    this.server = http.createServer(handler);
    this.server.on('upgrade', onUpgrade);
    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(port, host, resolve);
    });
    this.log(`HTTP 已启动: http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port}`);
    this.log(`播放页: http://<nas-ip>:${port}/   配置页: http://<nas-ip>:${port}/admin`);
    return this;
  }

  async stop() {
    clearInterval(this._scanBroadcastTimer);
    try { this.randomizer && this.randomizer.flush(); } catch {}
    try { this.ws && this.ws.close(); } catch {}
    try { this.server && this.server.close(); } catch {}
    try { this.store && this.store.close(); } catch {}
  }
}

if (require.main === module) {
  const app = new App();
  app.init().then(() => app.start()).catch(e => {
    console.error('启动失败:', e);
    process.exit(1);
  });
  const shutdown = async () => { await app.stop(); process.exit(0); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

module.exports = { App };

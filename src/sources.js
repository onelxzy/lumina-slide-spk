'use strict';
/**
 * 数据源抽象层
 * 支持 local（本地路径）与 webdav 两种，可在配置里任意混合叠加。
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

// ---------------------------------------------------------------- 本地
class LocalSource {
  constructor(cfg) {
    this.id = cfg.id;
    this.root = cfg.root;
    this.type = 'local';
  }

  async list(dir) {
    const ents = await fsp.readdir(dir, { withFileTypes: true });
    // 逐个 stat 拿 size/mtime（Dirent 不带这些字段）
    const out = [];
    for (const e of ents) {
      const isDir = e.isDirectory();
      let size = 0, mtimeMs = 0;
      if (!isDir) {
        try {
          const s = await fsp.stat(path.join(dir, e.name));
          size = s.size;
          mtimeMs = s.mtimeMs;
        } catch { /* 读不到就跳过元数据 */ }
      }
      out.push({ name: e.name, isDir, isFile: e.isFile(), size, mtimeMs });
    }
    return out;
  }

  async stat(p) {
    const s = await fsp.stat(p);
    return { size: s.size, mtimeMs: s.mtimeMs };
  }

  openRead(p) { return fs.createReadStream(p); }

  // 本地路径直接给 ffmpeg 用，零拷贝
  localPath(p) { return p; }

  join(...parts) { return path.join(...parts); }
}

// ---------------------------------------------------------------- WebDAV
class WebdavSource {
  constructor(cfg) {
    this.id = cfg.id;
    this.type = 'webdav';
    this.root = cfg.root || '/';
    this.url = (cfg.url || '').replace(/\/+$/, '');
    this.username = cfg.username || '';
    this.password = cfg.password || '';
    this.authHeader = 'Basic ' + Buffer.from(`${this.username}:${this.password}`).toString('base64');
    this.timeoutMs = (cfg.timeoutSec || 60) * 1000;
  }

  _full(p) {
    // p 是相对 root 的路径（以 / 开头）
    const rel = p.replace(/^\/+/, '');
    return `${this.url}/${encodeURI(rel).replace(/#/g, '%23')}`.replace(/\/+/g, '/').replace(':/', '://');
  }

  _headers(extra = {}) {
    return {
      Authorization: this.authHeader,
      'User-Agent': 'LuminaSlide/1.1',
      ...extra,
    };
  }

  async _fetch(url, opts = {}) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      return await fetch(url, { ...opts, signal: ctrl.signal });
    } finally {
      clearTimeout(t);
    }
  }

  async list(dir) {
    const url = this._full(dir);
    const res = await this._fetch(url, {
      method: 'PROPFIND',
      headers: this._headers({ Depth: '1', 'Content-Type': 'application/xml' }),
      body: `<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/><d:getcontentlength/><d:getlastmodified/></d:prop></d:propfind>`,
    });
    if (res.status !== 207 && res.status !== 200) {
      throw new Error(`PROPFIND ${url} -> ${res.status}`);
    }
    const xml = await res.text();
    return parsePropfind(xml, dir);
  }

  async stat(p) {
    const url = this._full(p);
    const res = await this._fetch(url, {
      method: 'PROPFIND',
      headers: this._headers({ Depth: '0', 'Content-Type': 'application/xml' }),
      body: `<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:getcontentlength/><d:getlastmodified/><d:resourcetype/></d:prop></d:propfind>`,
    });
    if (res.status !== 207 && res.status !== 200) {
      throw new Error(`PROPFIND ${url} -> ${res.status}`);
    }
    const items = parsePropfind(await res.text(), p);
    const me = items.find(i => !i.self);
    return me ? { size: me.size, mtimeMs: me.mtimeMs } : { size: 0, mtimeMs: 0 };
  }

  async openRead(p) {
    const url = this._full(p);
    const res = await this._fetch(url, { headers: this._headers() });
    if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
    return res.body; // Web Stream
  }

  localPath() { return null; }

  join(dir, name) {
    return dir.replace(/\/+$/, '') + '/' + name;
  }
}

// 解析 PROPFIND 多状态响应
function parsePropfind(xml, baseDir) {
  const out = [];
  // 极简解析：找所有 <d:response> 块
  const blocks = xml.split(/<\/(?:d:|D:|[a-zA-Z]+:)?response>/i).filter(b => /response/i.test(b) || /href/i.test(b));
  for (const b of blocks) {
    const hrefM = b.match(/<(?:d:|D:|[a-zA-Z]+:)?href>([^<]+)</i);
    if (!hrefM) continue;
    let href = decodeURIComponent(hrefM[1]);
    const isDir = /<(?:d:|D:)?collection\s*\/?>/i.test(b) || /<[a-zA-Z]*:?collection/i.test(b);
    const sizeM = b.match(/<(?:d:|D:|[a-zA-Z]+:)?getcontentlength>(\d+)</i);
    const modM = b.match(/<(?:d:|D:|[a-zA-Z]+:)?getlastmodified>([^<]+)</i);

    // 从 href 提取文件名
    let clean = href.replace(/\/+$/, '');
    const name = clean.substring(clean.lastIndexOf('/') + 1) || '';
    const self = clean.replace(/\/+$/, '') === String(baseDir).replace(/\/+$/, '') ||
                 name === '' || (baseDir && clean.endsWith(String(baseDir).replace(/^\/+|\/+$/g, '')));

    out.push({
      name,
      href: clean,
      isDir,
      isFile: !isDir,
      size: sizeM ? parseInt(sizeM[1], 10) : 0,
      mtimeMs: modM ? Date.parse(modM[1]) : 0,
      self,
    });
  }
  // 去掉代表目录自身的那条
  const rest = out.filter(o => !o.self);
  return rest.length ? rest : out.slice(1);
}

function createSource(cfg) {
  if (cfg.type === 'webdav') return new WebdavSource(cfg);
  return new LocalSource(cfg);
}

module.exports = { LocalSource, WebdavSource, createSource };

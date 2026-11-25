'use strict';
/**
 * 索引与状态存储（node:sqlite 内置，零依赖）
 *
 * 表结构：
 *   files      — 图片索引
 *   dirs       — 已扫描目录（增量刷新用，记录 mtime）
 *   state      — 键值状态（洗牌袋位置、配置快照等）
 *   blacklist  — 转换失败/403 的文件
 *   favorites  — 收藏的图片
 */
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

class Store {
  constructor(dbPath) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA synchronous = NORMAL');
    this.db.exec('PRAGMA busy_timeout = 5000');
    this._migrate();
    this._prep();
  }

  _migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS files (
        id        INTEGER PRIMARY KEY AUTOINCREMENT,
        source_id TEXT NOT NULL,
        path      TEXT NOT NULL,
        rel_dir   TEXT NOT NULL,
        album     TEXT NOT NULL DEFAULT '',
        name      TEXT NOT NULL,
        ext       TEXT NOT NULL,
        size      INTEGER NOT NULL DEFAULT 0,
        mtime     INTEGER NOT NULL DEFAULT 0,
        UNIQUE(source_id, path)
      );
      CREATE INDEX IF NOT EXISTS idx_files_album  ON files(album);
      CREATE INDEX IF NOT EXISTS idx_files_rel    ON files(rel_dir);
      CREATE INDEX IF NOT EXISTS idx_files_source ON files(source_id);

      CREATE TABLE IF NOT EXISTS dirs (
        source_id TEXT NOT NULL,
        path      TEXT NOT NULL,
        mtime     INTEGER NOT NULL DEFAULT 0,
        scanned_at INTEGER NOT NULL DEFAULT 0,
        file_count INTEGER NOT NULL DEFAULT 0,
        has_subdirs INTEGER NOT NULL DEFAULT 1,
        seen_token INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (source_id, path)
      );

      CREATE TABLE IF NOT EXISTS state (
        k TEXT PRIMARY KEY,
        v TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS blacklist (
        source_id TEXT NOT NULL,
        path      TEXT NOT NULL,
        reason    TEXT NOT NULL DEFAULT '',
        at        INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (source_id, path)
      );

      CREATE TABLE IF NOT EXISTS favorites (
        file_id    INTEGER PRIMARY KEY,
        created_at INTEGER NOT NULL DEFAULT 0
      );
    `);
    // 兼容旧库平滑迁移新字段
    const safeAlter = (sql) => { try { this.db.exec(sql); } catch { /* column exists */ } };
    safeAlter(`ALTER TABLE files ADD COLUMN seen_token INTEGER NOT NULL DEFAULT 0`);
    safeAlter(`ALTER TABLE dirs ADD COLUMN has_subdirs INTEGER NOT NULL DEFAULT 1`);
    safeAlter(`ALTER TABLE dirs ADD COLUMN seen_token INTEGER NOT NULL DEFAULT 0`);
  }

  _prep() {
    const d = this.db;
    this.st = {
      upsertFile: d.prepare(`
        INSERT INTO files (source_id, path, rel_dir, album, name, ext, size, mtime, seen_token)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(source_id, path) DO UPDATE SET
          rel_dir=excluded.rel_dir, album=excluded.album, name=excluded.name,
          ext=excluded.ext, size=excluded.size, mtime=excluded.mtime,
          seen_token=excluded.seen_token`),
      touchDir: d.prepare(`
        INSERT INTO dirs (source_id, path, mtime, scanned_at, file_count, has_subdirs, seen_token)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(source_id, path) DO UPDATE SET
          mtime=excluded.mtime, scanned_at=excluded.scanned_at, file_count=excluded.file_count,
          has_subdirs=excluded.has_subdirs, seen_token=excluded.seen_token`),
      getDir: d.prepare(`SELECT mtime, scanned_at, file_count, has_subdirs FROM dirs WHERE source_id=? AND path=?`),
      listFilesInRelDir: d.prepare(`SELECT id, path FROM files WHERE source_id=? AND rel_dir=?`),
      deleteFileById: d.prepare(`DELETE FROM files WHERE id=?`),
      deleteDir: d.prepare(`DELETE FROM dirs WHERE source_id=? AND path=?`),
      deleteFilesByRelPrefix: d.prepare(`DELETE FROM files WHERE source_id=? AND (rel_dir=? OR rel_dir LIKE ?)`),
      deleteDirsByPrefix: d.prepare(`DELETE FROM dirs WHERE source_id=? AND (path=? OR path LIKE ?)`),
      listSubdirsByPrefix: d.prepare(`SELECT path FROM dirs WHERE source_id=? AND path LIKE ?`),
      sweepUnseenFiles: d.prepare(`DELETE FROM files WHERE source_id=? AND seen_token != ?`),
      sweepUnseenDirs: d.prepare(`DELETE FROM dirs WHERE source_id=? AND seen_token != ?`),
      countFiles: d.prepare(`SELECT count(*) c FROM files`),
      countBySource: d.prepare(`SELECT source_id, count(*) c FROM files GROUP BY source_id`),
      totalAlbums: d.prepare(`SELECT count(DISTINCT album) c FROM files`),
      allIdsClean: d.prepare(`
        SELECT id FROM files f
        WHERE NOT EXISTS (
          SELECT 1 FROM blacklist b WHERE b.source_id = f.source_id AND b.path = f.path
        )
        ORDER BY id`),
      getFile: d.prepare(`SELECT * FROM files WHERE id=?`),
      getState: d.prepare(`SELECT v FROM state WHERE k=?`),
      setState: d.prepare(`INSERT INTO state(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v`),
      addBlack: d.prepare(`INSERT INTO blacklist(source_id,path,reason,at) VALUES(?,?,?,?)
                           ON CONFLICT(source_id,path) DO UPDATE SET reason=excluded.reason, at=excluded.at`),
      removeBlack: d.prepare(`DELETE FROM blacklist WHERE source_id=? AND path=?`),
      isBlack: d.prepare(`SELECT 1 FROM blacklist WHERE source_id=? AND path=?`),
      listBlack: d.prepare(`SELECT * FROM blacklist ORDER BY at DESC LIMIT 500`),
      countBlack: d.prepare(`SELECT count(*) c FROM blacklist`),
      clearBlack: d.prepare(`DELETE FROM blacklist`),
      idsByAlbum: d.prepare(`SELECT id FROM files WHERE album=? ORDER BY id`),
      albumList: d.prepare(`SELECT album, source_id, count(*) c FROM files GROUP BY album, source_id ORDER BY c DESC, album ASC`),
      isFav: d.prepare(`SELECT 1 FROM favorites WHERE file_id=?`),
      addFav: d.prepare(`INSERT INTO favorites(file_id, created_at) VALUES(?, ?) ON CONFLICT(file_id) DO NOTHING`),
      delFav: d.prepare(`DELETE FROM favorites WHERE file_id=?`),
      countFav: d.prepare(`SELECT count(*) c FROM favorites`),
      listFav: d.prepare(`
        SELECT f.id, f.source_id, f.album, f.name, f.rel_dir, fav.created_at
        FROM favorites fav
        JOIN files f ON f.id = fav.file_id
        ORDER BY fav.created_at DESC
        LIMIT ? OFFSET ?`),
      deleteBySource: d.prepare(`DELETE FROM files WHERE source_id=?`),
      deleteDirsBySource: d.prepare(`DELETE FROM dirs WHERE source_id=?`),
    };
  }

  transaction(fn) {
    this.db.exec('BEGIN');
    try {
      const r = fn();
      this.db.exec('COMMIT');
      return r;
    } catch (e) {
      try { this.db.exec('ROLLBACK'); } catch { /* ignore */ }
      throw e;
    }
  }

  // ---- files ----
  upsertFile(f, token = 0) {
    this.st.upsertFile.run(f.sourceId, f.path, f.relDir, f.album, f.name, f.ext, f.size, f.mtime || 0, token);
  }
  listFilesInRelDir(sourceId, relDir) {
    return this.st.listFilesInRelDir.all(sourceId, relDir);
  }
  deleteFilesByIds(ids) {
    for (const id of ids) this.st.deleteFileById.run(id);
  }
  deleteMissingDir(sourceId, dirPath, relDir) {
    this.st.deleteDir.run(sourceId, dirPath);
    if (relDir) {
      this.st.deleteFilesByRelPrefix.run(sourceId, relDir, relDir + '/%');
    }
    const sep = dirPath.includes('\\') ? '\\' : '/';
    this.st.deleteDirsByPrefix.run(sourceId, dirPath, dirPath.replace(/[\\/]+$/, '') + sep + '%');
  }
  listDirectSubdirs(sourceId, parentDir) {
    const clean = parentDir.replace(/[\\/]+$/, '');
    const sep = parentDir.includes('\\') ? '\\' : '/';
    const prefix = clean + sep;
    const rows = this.st.listSubdirsByPrefix.all(sourceId, prefix + '%');
    return rows
      .map(r => r.path)
      .filter(p => {
        const rest = p.slice(prefix.length);
        return rest.length > 0 && !rest.includes('/') && !rest.includes('\\');
      });
  }
  sweepUnseen(sourceId, token) {
    const rf = this.st.sweepUnseenFiles.run(sourceId, token);
    this.st.sweepUnseenDirs.run(sourceId, token);
    return rf.changes || 0;
  }
  countFiles() { return this.st.countFiles.get().c; }
  countBySource() { return this.st.countBySource.all(); }
  totalAlbums() { return this.st.totalAlbums.get().c; }

  allIds(filter = null) {
    if (!filter || (!filter.sourceId && !filter.album && !filter.onlyFavorites)) {
      return this.st.allIdsClean.all().map(r => r.id);
    }
    const conds = [
      `NOT EXISTS (SELECT 1 FROM blacklist b WHERE b.source_id = f.source_id AND b.path = f.path)`,
    ];
    const params = [];
    if (filter.sourceId) {
      conds.push(`f.source_id = ?`);
      params.push(filter.sourceId);
    }
    if (filter.album) {
      conds.push(`f.album = ?`);
      params.push(filter.album);
    }
    if (filter.onlyFavorites) {
      conds.push(`EXISTS (SELECT 1 FROM favorites fav WHERE fav.file_id = f.id)`);
    }
    const sql = `SELECT f.id FROM files f WHERE ${conds.join(' AND ')} ORDER BY f.id`;
    return this.db.prepare(sql).all(...params).map(r => r.id);
  }

  getFile(id) { return this.st.getFile.get(id); }

  albumList(opts = {}) {
    if (!opts.q && !opts.sourceId && !opts.limit) {
      return this.st.albumList.all();
    }
    const conds = [];
    const params = [];
    if (opts.sourceId) {
      conds.push(`source_id = ?`);
      params.push(opts.sourceId);
    }
    if (opts.q) {
      conds.push(`album LIKE ?`);
      params.push(`%${opts.q}%`);
    }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    const limit = Math.max(1, Math.min(500, Number(opts.limit) || 200));
    const sql = `SELECT album, source_id, count(*) c FROM files ${where} GROUP BY album, source_id ORDER BY c DESC, album ASC LIMIT ${limit}`;
    return this.db.prepare(sql).all(...params);
  }

  idsByAlbum(a, sourceId = '') {
    if (!sourceId) return this.st.idsByAlbum.all(a).map(r => r.id);
    return this.db.prepare(`SELECT id FROM files WHERE album=? AND source_id=? ORDER BY id`).all(a, sourceId).map(r => r.id);
  }

  // ---- dirs ----
  getDir(sourceId, p) { return this.st.getDir.get(sourceId, p); }
  touchDir(sourceId, p, mtime, count, hasSubdirs = 1, token = 0) {
    this.st.touchDir.run(sourceId, p, mtime, Date.now(), count, hasSubdirs ? 1 : 0, token);
  }

  // ---- state ----
  getState(k, dflt = null) {
    const r = this.st.getState.get(k);
    if (!r) return dflt;
    try { return JSON.parse(r.v); } catch { return dflt; }
  }
  setState(k, v) { this.st.setState.run(k, JSON.stringify(v)); }

  // ---- blacklist ----
  addBlack(sourceId, p, reason) { this.st.addBlack.run(sourceId, p, reason, Date.now()); }
  removeBlack(sourceId, p) { this.st.removeBlack.run(sourceId, p); }
  isBlack(sourceId, p) { return !!this.st.isBlack.get(sourceId, p); }
  listBlack() { return this.st.listBlack.all(); }
  countBlack() { return this.st.countBlack.get().c; }
  clearBlack() { this.st.clearBlack.run(); }

  // ---- favorites ----
  isFavorite(fileId) { return !!this.st.isFav.get(fileId); }
  setFavorite(fileId, on) {
    if (on) this.st.addFav.run(fileId, Date.now());
    else this.st.delFav.run(fileId);
    return !!on;
  }
  toggleFavorite(fileId) {
    const cur = this.isFavorite(fileId);
    return this.setFavorite(fileId, !cur);
  }
  countFavorites() { return this.st.countFav.get().c; }
  listFavorites(limit = 100, offset = 0) {
    return this.st.listFav.all(Math.min(500, limit), Math.max(0, offset));
  }

  resetSource(sourceId) {
    this.st.deleteBySource.run(sourceId);
    this.st.deleteDirsBySource.run(sourceId);
  }

  close() { try { this.db.close(); } catch { /* ignore */ } }
}

module.exports = { Store };

'use strict';
/**
 * 扫描器（支持真正的增量更新与全量重建）
 *
 * 两种模式：
 *   - 增量更新（full=false）：
 *       1. 若某目录为「无子目录的叶子目录」且 mtime 未变（mtime > 0），直接跳过 list，零开销
 *       2. 若某目录有子目录，仍会向下遍历子目录（防止父目录 mtime 不随深层文件变化而漏扫）
 *       3. 若目录 mtime 变化（或 mtime=0），重新 list 并对比清理该目录下已删除的文件记录
 *       4. 若目录已从磁盘/远端消失（ENOENT/404），自动清理该目录及其下失效索引
 *   - 全量重建（full=true）：
 *       使用本轮 scanToken 标记-清除（Mark & Sweep），完成后清理本来源下未命中的失效记录，
 *       且中途取消不会破坏原有索引。
 */
const path = require('path');

class Scanner {
  constructor(cfg, store, sources, log) {
    this.cfg = cfg;
    this.store = store;
    this.sources = sources;
    this.log = log || console.log;
    this.running = false;
    this.cancelled = false;
    this.stats = {
      startedAt: 0,
      finishedAt: 0,
      dirsScanned: 0,
      dirsSkipped: 0,
      filesAdded: 0,
      filesRemoved: 0,
      errors: 0,
      currentPath: '',
      phase: 'idle', // idle|scanning|done|cancelled|error
      message: '',
    };
    this._pending = [];
    this._scanToken = 0;
  }

  isRunning() { return this.running; }
  cancel() { if (this.running) this.cancelled = true; }

  status() {
    return {
      ...this.stats,
      running: this.running,
      totalFiles: this.store.countFiles(),
      elapsedMs: this.stats.startedAt ? (Date.now() - this.stats.startedAt) : 0,
    };
  }

  _wantExt(name) {
    const ext = (name.match(/\.[^.]+$/) || [''])[0].toLowerCase();
    if (!ext) return null;
    const sc = this.cfg.scan;
    if (sc.exclude.includes(ext)) return null;
    if (!sc.extensions.includes(ext)) return null;
    return ext;
  }

  _skipEntry(name) {
    if (this.cfg.scan.skipHidden && name.startsWith('.')) return true;
    if (name.startsWith('._')) return true;
    if (name === '@eaDir' || name === '#recycle') return true;
    if (name === '.DS_Store' || name === 'Thumbs.db') return true;
    return false;
  }

  _relDir(srcRoot, dirPath) {
    return dirPath.replace(srcRoot, '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  }

  _flush() {
    if (!this._pending.length) return;
    const batch = this._pending;
    this._pending = [];
    const token = this._scanToken;
    this.store.transaction(() => {
      for (const f of batch) this.store.upsertFile(f, token);
    });
    this.stats.filesAdded += batch.length;
  }

  async _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  async run(opts = {}) {
    if (this.running) throw new Error('扫描已在进行中');
    this.running = true;
    this.cancelled = false;
    this._pending = [];
    this._scanToken = Date.now();

    Object.assign(this.stats, {
      startedAt: this._scanToken,
      finishedAt: 0,
      dirsScanned: 0,
      dirsSkipped: 0,
      filesAdded: 0,
      filesRemoved: 0,
      errors: 0,
      currentPath: '',
      phase: 'scanning',
      message: '开始扫描',
    });

    const sc = this.cfg.scan;
    const full = !!opts.full || !sc.incremental;

    try {
      for (const src of this.sources) {
        if (this.cancelled) break;
        if (opts.sourceId && src.id !== opts.sourceId) continue;
        await this._scanSource(src, full);
      }
      this._flush();
      this.stats.phase = this.cancelled ? 'cancelled' : 'done';
      this.stats.message = this.cancelled ? '已取消' : '扫描完成';
    } catch (e) {
      this._flush();
      this.stats.phase = 'error';
      this.stats.message = e.message;
      this.log('[scan] 出错:', e.message);
      throw e;
    } finally {
      this.stats.finishedAt = Date.now();
      this.running = false;
      this.log(`[scan] 结束: 目录 ${this.stats.dirsScanned} 个, 跳过 ${this.stats.dirsSkipped}, 入库 ${this.stats.filesAdded}, 清理 ${this.stats.filesRemoved}, 错误 ${this.stats.errors}`);
    }
    return this.status();
  }

  async _scanSource(src, full) {
    const root = src.root;
    this.stats.currentPath = root;
    this.stats.message = `${full ? '全量' : '增量'}扫描 ${src.id}`;
    this.log(`[scan] 开始 ${src.id} (${src.type}, ${full ? 'full' : 'incremental'}) -> ${root}`);

    const stack = [{ dir: root, depth: 0 }];
    let dirCount = 0;

    while (stack.length) {
      if (this.cancelled) return;

      const { dir, depth } = stack.shift();
      this.stats.currentPath = dir;

      let dirMtime = 0;
      try {
        const st = await src.stat(dir);
        dirMtime = st.mtimeMs || 0;
      } catch (e) {
        // 目录已删除，清理失效索引
        if (e.code === 'ENOENT' || /404/.test(e.message || '')) {
          const relDir = this._relDir(src.root, dir);
          this.store.deleteMissingDir(src.id, dir, relDir);
        } else {
          this.stats.errors++;
          this.log(`[scan] stat 失败 ${dir}: ${e.message}`);
        }
        continue;
      }

      const prev = !full ? this.store.getDir(src.id, dir) : null;
      const mtimeSame = !!(prev && dirMtime > 0 && Math.abs(prev.mtime - dirMtime) < 10);

      // 仅当「无子目录的叶子目录」且 mtime 未变时，才安全跳过 list
      if (!full && mtimeSame && prev.has_subdirs === 0) {
        this.stats.dirsSkipped++;
        continue;
      }

      let entries;
      try {
        entries = await src.list(dir);
      } catch (e) {
        this.stats.errors++;
        this.log(`[scan] 列目录失败 ${dir}: ${e.message}`);
        this.store.touchDir(src.id, dir, dirMtime, 0, 1, this._scanToken);
        continue;
      }

      this.stats.dirsScanned++;
      const subdirs = [];
      const seenPaths = new Set();
      let fileCount = 0;
      const relDir = this._relDir(src.root, dir);
      const albumName = relDir.includes('/')
        ? relDir.substring(relDir.lastIndexOf('/') + 1)
        : (relDir || path.basename(src.root));

      for (const ent of entries) {
        if (this.cancelled) return;
        if (this._skipEntry(ent.name)) continue;

        if (ent.isDir) {
          if (depth < 32) subdirs.push({ dir: src.join(dir, ent.name), depth: depth + 1 });
          continue;
        }
        if (!ent.isFile) continue;

        // 若该非叶子目录自身 mtime 未变，只向下遍历子目录，不重复写文件记录
        if (!full && mtimeSame) continue;

        const ext = this._wantExt(ent.name);
        if (!ext) continue;
        if (ent.size && ent.size < this.cfg.scan.minSize) continue;

        const fullPath = src.join(dir, ent.name);
        seenPaths.add(fullPath);
        fileCount++;
        this._pending.push({
          sourceId: src.id,
          path: fullPath,
          relDir,
          album: albumName || '',
          name: ent.name,
          ext,
          size: ent.size || 0,
          mtime: ent.mtimeMs || 0,
        });

        if (this._pending.length >= this.cfg.scan.commitEvery) this._flush();
      }

      // 将子目录压入队列（DFS/BFS 均可，unshift 保持局部性）
      for (let i = subdirs.length - 1; i >= 0; i--) {
        stack.unshift(subdirs[i]);
      }

      // 增量模式下，若当前目录内容有变，对比清理该目录下已从磁盘删除的文件和子目录
      if (!full && !mtimeSame) {
        this._flush();
        const existing = this.store.listFilesInRelDir(src.id, relDir);
        const toDelete = [];
        for (const row of existing) {
          if (!seenPaths.has(row.path)) toDelete.push(row.id);
        }
        if (toDelete.length) {
          this.store.transaction(() => this.store.deleteFilesByIds(toDelete));
          this.stats.filesRemoved += toDelete.length;
        }

        const liveSubdirSet = new Set(subdirs.map(s => s.dir));
        const recordedSubs = this.store.listDirectSubdirs(src.id, dir);
        for (const oldSub of recordedSubs) {
          if (!liveSubdirSet.has(oldSub)) {
            const subRel = this._relDir(src.root, oldSub);
            const before = this.store.countFiles();
            this.store.deleteMissingDir(src.id, oldSub, subRel);
            this.stats.filesRemoved += Math.max(0, before - this.store.countFiles());
          }
        }
      }

      this.store.touchDir(src.id, dir, dirMtime, fileCount, subdirs.length > 0 ? 1 : 0, this._scanToken);

      dirCount++;
      if (this.cfg.scan.pauseEveryDirs > 0 && dirCount % this.cfg.scan.pauseEveryDirs === 0) {
        this._flush();
        this.log(`[scan] 已处理 ${dirCount} 个目录，暂停 ${this.cfg.scan.pauseMs}ms`);
        await this._sleep(this.cfg.scan.pauseMs);
      }
    }

    this._flush();
    // 全量重建完成且未取消：清扫本来源下已不存在的旧记录
    if (full && !this.cancelled) {
      const swept = this.store.sweepUnseen(src.id, this._scanToken);
      if (swept) this.stats.filesRemoved += swept;
    }
    this.log(`[scan] ${src.id} 完成`);
  }
}

module.exports = { Scanner };

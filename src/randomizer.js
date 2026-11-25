'use strict';
/**
 * 随机调度器
 *
 * 三种模式：
 *   shuffle — 洗牌袋：整池洗牌后顺序发牌，一轮内绝不重复；发完自动重洗
 *   random  — 纯随机：每次独立抽取，可能重复（数学意义上的真随机）
 *   weak    — 弱去重：纯随机 + 记住最近 N 张
 *
 * 扩展能力：
 *   - 播放历史环形缓冲（最多 200 条），所有模式下均支持「上一张 / 下一张」往返
 *   - 支持公平性策略：byImage（按图片数） / byAlbum（按相册均分）
 *   - 断点续播：持久化 { seed, pos, mode, sig }
 */
const crypto = require('crypto');

const MAX_HISTORY = 200;

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffleInPlace(arr, seed) {
  const rnd = mulberry32(seed);
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    const t = arr[i];
    arr[i] = arr[j];
    arr[j] = t;
  }
  return arr;
}

class Randomizer {
  constructor(getIdPool, stateApi, cfg, pickByAlbum = null) {
    this.getIdPool = getIdPool;
    this.state = stateApi;
    this.cfg = cfg;
    this.pickByAlbum = pickByAlbum;
    this.deck = [];
    this.pos = 0;
    this.seed = 0;
    this.poolVersion = null;
    this.recent = [];
    this.recentSet = new Set();
    this.history = [];
    this.historyIdx = -1;
    this._loaded = false;
  }

  get mode() { return this.cfg.mode; }
  set mode(m) { this.cfg.mode = m; }

  _poolSig(ids) {
    if (!ids.length) return '0';
    return `${ids.length}:${ids[0]}:${ids[ids.length - 1]}`;
  }

  init(force = false) {
    const ids = this.getIdPool();
    if (!ids.length) {
      this.deck = [];
      this.pos = 0;
      return this;
    }

    const saved = this.state.get('deck', null);
    const sig = this._poolSig(ids);
    const canResume =
      !force &&
      saved &&
      saved.mode === this.mode &&
      saved.sig === sig &&
      typeof saved.seed === 'number' &&
      typeof saved.pos === 'number' &&
      this.cfg.onRestart === 'resume';

    if (canResume && this.mode === 'shuffle') {
      this.seed = saved.seed;
      this.deck = shuffleInPlace(ids.slice(), this.seed);
      this.pos = Math.min(saved.pos || 0, this.deck.length);
      if (this.pos >= this.deck.length) {
        this._reshuffle();
      }
    } else if (this.mode === 'shuffle') {
      this._reshuffle();
    } else {
      this.deck = ids.slice();
      this.pos = 0;
    }

    this.poolVersion = sig;
    this._loaded = true;

    if (this.mode === 'weak' && saved && Array.isArray(saved.recent)) {
      this.recent = saved.recent.slice(-this.cfg.weakRecent);
      this.recentSet = new Set(this.recent);
    }
    return this;
  }

  _reshuffle() {
    const ids = this.getIdPool();
    if (!ids.length) return;
    this.seed = crypto.randomInt(1, 0x7FFFFFFF);
    this.deck = shuffleInPlace(ids.slice(), this.seed);
    this.pos = 0;
    this.poolVersion = this._poolSig(ids);
    this._persist();
  }

  _persist() {
    const payload = { mode: this.mode, seed: this.seed, pos: this.pos, sig: this.poolVersion };
    if (this.mode === 'weak') payload.recent = this.recent;
    this.state.set('deck', payload);
  }

  resetHistory() {
    this.history = [];
    this.historyIdx = -1;
  }

  /**
   * 池子规模或过滤条件变化时调用
   * 重要：池子为空时绝不重洗/写盘，否则会把已有的续播状态覆盖成空。
   */
  maybeReshuffle() {
    const ids = this.getIdPool();
    if (!ids.length) return;
    const sig = this._poolSig(ids);
    if (sig === this.poolVersion) return;

    this.resetHistory();
    if (this.mode === 'shuffle') {
      this._reshuffle();
    } else {
      this.deck = ids.slice();
      this.poolVersion = sig;
    }
  }

  _recordHistory(id) {
    if (this.historyIdx < this.history.length - 1) {
      this.history = this.history.slice(0, this.historyIdx + 1);
    }
    this.history.push(id);
    if (this.history.length > MAX_HISTORY) {
      this.history.shift();
    }
    this.historyIdx = this.history.length - 1;
  }

  _drawNew(ids) {
    // 按相册均分模式（非洗牌袋全量顺序时优先使用）
    if (this.cfg.fairness === 'byAlbum' && typeof this.pickByAlbum === 'function' && this.mode !== 'shuffle') {
      const picked = this.pickByAlbum();
      if (picked != null) {
        if (this.mode === 'weak') this._pushRecent(picked);
        return picked;
      }
    }

    if (this.mode === 'random') {
      return ids[crypto.randomInt(0, ids.length)];
    }

    if (this.mode === 'weak') {
      for (let i = 0; i < 50; i++) {
        const id = ids[crypto.randomInt(0, ids.length)];
        if (!this.recentSet.has(id)) {
          this._pushRecent(id);
          return id;
        }
      }
      const id = ids[crypto.randomInt(0, ids.length)];
      this._pushRecent(id);
      return id;
    }

    // shuffle
    if (this.pos >= this.deck.length) this._reshuffle();
    const id = this.deck[this.pos++];
    this._persistThrottled();
    return id;
  }

  /** 取下一张 id */
  next() {
    if (!this._loaded) this.init();

    const ids = this.getIdPool();
    if (!ids.length) return null;

    this.maybeReshuffle();

    // 若用户之前点过「上一张」，先沿历史前进
    if (this.historyIdx >= 0 && this.historyIdx < this.history.length - 1) {
      this.historyIdx++;
      return this.history[this.historyIdx];
    }

    const id = this._drawNew(ids);
    if (id != null) this._recordHistory(id);
    return id;
  }

  _persistThrottled() {
    this._dirty = true;
    if (this._flushTimer) return;
    this._flushTimer = setTimeout(() => {
      this._flushTimer = null;
      if (this._dirty) {
        this._dirty = false;
        this._persist();
      }
    }, 1000);
    if (this._flushTimer.unref) this._flushTimer.unref();
  }

  flush() {
    if (this._flushTimer) { clearTimeout(this._flushTimer); this._flushTimer = null; }
    this._dirty = false;
    this._persist();
  }

  _pushRecent(id) {
    this.recent.push(id);
    this.recentSet.add(id);
    while (this.recent.length > this.cfg.weakRecent) {
      const old = this.recent.shift();
      if (!this.recent.includes(old)) this.recentSet.delete(old);
    }
    this._persist();
  }

  reshuffle() {
    this.resetHistory();
    this._reshuffle();
    return this.progress();
  }

  /** 上一张：优先使用播放历史，支持全部模式 */
  prev() {
    if (this.historyIdx > 0) {
      this.historyIdx--;
      return this.history[this.historyIdx];
    }
    if (this.mode === 'shuffle' && this.pos > 1) {
      this.pos -= 2;
      this._persist();
      return this.deck[this.pos];
    }
    return null;
  }

  progress() {
    return {
      mode: this.mode,
      pos: this.pos,
      total: this.deck.length,
      remaining: Math.max(0, this.deck.length - this.pos),
      seed: this.seed,
      percent: this.deck.length ? +(this.pos / this.deck.length * 100).toFixed(2) : 0,
      canPrev: this.historyIdx > 0 || (this.mode === 'shuffle' && this.pos > 1),
    };
  }
}

module.exports = { Randomizer, shuffleInPlace, mulberry32 };

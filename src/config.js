'use strict';
/**
 * 配置管理
 * - 默认值 + config.json 覆盖
 * - 支持本地路径 / WebDAV / 混合（多个源同时生效）
 * - 热更新：改完调用 reload() 立即生效
 */
const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  server: {
    port: 18666,
    host: '0.0.0.0',
  },

  // ============ 访问控制 ============
  auth: {
    enabled: false,          // 设为 true 后需登录访问（公网部署建议开启）
    username: 'admin',
    passwordHash: '',        // 留空时默认密码为 admin
    sessionTtlHours: 168,
  },

  // ============ 数据来源：可多源叠加（混合模式）============
  // 每条 source 独立配置，扫描时全部遍历，合并成一个池子
  sources: [],

  // ============ 扫描 ============
  scan: {
    extensions: ['.jpg', '.jpeg', '.png', '.webp', '.bmp', '.tif', '.tiff', '.jfif', '.heic', '.avif'],
    // 明确排除
    exclude: ['.gif', '.mp4', '.mov', '.m4v', '.mkv', '.avi', '.wmv', '.flv', '.webm', '.ts', '.m2ts'],
    // 扫描并发（FUSE/网盘上务必低）
    concurrency: 1,
    // 每扫多少条提交一次事务
    commitEvery: 500,
    // 单目录请求超时（秒）
    dirTimeoutSec: 60,
    // 扫描节奏：每处理 N 个目录后休息（毫秒），降低网盘风控风险
    pauseEveryDirs: 200,
    pauseMs: 200,
    // 增量：跳过 mtime 未变的目录
    incremental: true,
    // 是否跟随符号链接
    followSymlinks: false,
    // 跳过隐藏目录/文件
    skipHidden: true,
    // 最小文件大小（字节），过滤掉 ._xxx / 缩略图残渣
    minSize: 4096,
  },

  // ============ 画质 ============
  image: {
    // 包围盒。图片按比例缩放到能放进这个盒子里，绝不拉伸、绝不放大小图
    maxWidth: 1920,
    maxHeight: 1080,
    // 输出格式 webp | jpeg | avif
    format: 'webp',
    // WebP/AVIF 质量 0-100（实测 WebP 92 ≈ PSNR 45.7dB，肉眼无损）
    quality: 92,
    // JPEG 质量 1-31（数字越小越好，仅 format=jpeg 时生效）
    jpegQuality: 3,
    // 缩放算法 lanczos | bicubic | bilinear | neighbor
    scaler: 'lanczos',
    // 色度采样 420 | 444
    pixFmt: '420',
    // 允许放大小图（默认不允许，小图保持原样）
    allowUpscale: false,
    // ffmpeg 并发上限（实测单进程 150MB，2 并发安全）
    concurrency: 2,
    // 单张处理超时（秒）
    timeoutSec: 30,
  },

  // ============ 缓存 ============
  cache: {
    // 内存缓存上限（张数与字节双重封顶，防 OOM）
    memoryItems: 200,
    memoryMaxMB: 64,
    // 是否启用磁盘缓存（随机轮播一轮数十万张，关闭可避免频繁写盘）
    diskEnabled: false,
    // 磁盘缓存目录（相对程序目录）
    diskDir: 'cache',
    // 磁盘缓存上限 MB
    diskMaxMB: 4096,
  },

  // ============ 播放 ============
  play: {
    // 默认切换间隔（秒）
    interval: 8,
    // 随机模式：shuffle(洗牌袋) | random(纯随机) | weak(弱去重)
    mode: 'shuffle',
    // weak 模式记住最近多少张
    weakRecent: 500,
    // 程序重启后：resume(续播) | reshuffle(重洗)
    onRestart: 'resume',
    // 公平性：byImage(按图片数) | byAlbum(按相册均分)
    fairness: 'byImage',
    // 过渡动画：fade | none | kenburns
    transition: 'fade',
    // 是否显示信息角标
    showInfo: true,
    // 氛围模糊背景（非铺满画面时在背后显示柔光模糊）
    ambientBg: true,
    // 预取张数
    prefetch: 2,
  },

  // ============ 路径 ============
  paths: {
    dataDir: 'data',
  },
};

function deepMerge(base, override) {
  if (override === null || override === undefined) return base;
  if (Array.isArray(base) || Array.isArray(override)) return override;
  if (typeof base !== 'object' || typeof override !== 'object') return override;
  const out = { ...base };
  for (const k of Object.keys(override)) {
    out[k] = k in base ? deepMerge(base[k], override[k]) : override[k];
  }
  return out;
}

function clampInt(val, min, max, fallback) {
  const n = parseInt(val, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function sanitize(cfg) {
  cfg.server.port = clampInt(cfg.server.port, 1, 65535, 18666);
  cfg.auth = cfg.auth || {};
  cfg.auth.enabled = !!cfg.auth.enabled;
  cfg.auth.username = String(cfg.auth.username || 'admin').trim() || 'admin';
  cfg.auth.sessionTtlHours = clampInt(cfg.auth.sessionTtlHours, 1, 8760, 168);
  cfg.image.maxWidth = clampInt(cfg.image.maxWidth, 128, 7680, 1920);
  cfg.image.maxHeight = clampInt(cfg.image.maxHeight, 128, 4320, 1080);
  cfg.image.quality = clampInt(cfg.image.quality, 10, 100, 92);
  cfg.image.jpegQuality = clampInt(cfg.image.jpegQuality, 1, 31, 3);
  cfg.image.concurrency = clampInt(cfg.image.concurrency, 1, 8, 2);
  cfg.image.timeoutSec = clampInt(cfg.image.timeoutSec, 5, 300, 30);
  cfg.cache.memoryItems = clampInt(cfg.cache.memoryItems, 1, 2000, 200);
  cfg.cache.memoryMaxMB = clampInt(cfg.cache.memoryMaxMB, 8, 2048, 64);
  cfg.cache.diskEnabled = !!cfg.cache.diskEnabled;
  cfg.cache.diskMaxMB = clampInt(cfg.cache.diskMaxMB, 50, 102400, 4096);
  cfg.play.interval = clampInt(cfg.play.interval, 2, 600, 8);
  cfg.play.prefetch = clampInt(cfg.play.prefetch, 1, 4, 2);
  if (!Array.isArray(cfg.sources)) cfg.sources = [];
  return cfg;
}

class Config {
  constructor(baseDir) {
    // 套件模式下，配置文件与数据放在 LUMINA_HOME / SLIDESHOW_HOME（/var/packages/*/var）
    // 开发模式下就用程序目录
    this.homeDir = process.env.LUMINA_HOME || process.env.SLIDESHOW_HOME || baseDir;
    this.installDir = baseDir;
    this.baseDir = baseDir;
    this.file = path.join(this.homeDir, 'config.json');
    this.data = null;
    this.reload();
  }

  reload() {
    let user = {};
    try {
      if (fs.existsSync(this.file)) {
        user = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      }
    } catch (e) {
      console.error('[config] 解析 config.json 失败，使用默认值:', e.message);
    }
    this.data = sanitize(deepMerge(DEFAULTS, user));
    return this.data;
  }

  save(patch) {
    let user = {};
    try {
      if (fs.existsSync(this.file)) user = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch { /* ignore */ }
    const merged = sanitize(deepMerge(deepMerge(DEFAULTS, user), patch));
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(merged, null, 2), 'utf8');
    fs.renameSync(tmp, this.file);
    this.reload();
    return this.data;
  }

  get() { return this.data; }

  // 解析相对路径：数据/缓存一律落在 homeDir（套件模式下是持久化目录）
  resolve(p) {
    if (!p) return p;
    if (path.isAbsolute(p)) return p;
    return path.join(this.homeDir, p);
  }

  get dataDir() { return this.resolve(this.data.paths.dataDir); }
  get cacheDir() { return this.resolve(this.data.cache.diskDir); }
}

module.exports = { Config, DEFAULTS };

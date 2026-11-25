'use strict';
/**
 * 轻量级认证与会话管理（零外部依赖）
 * - scrypt 加盐哈希存储密码
 * - HMAC-SHA256 签名 HttpOnly Cookie 会话
 * - 登录失败频率限制，防止暴力破解
 */
const crypto = require('crypto');

const COOKIE_NAME = 'lumina_sid';

function hashPassword(password, salt = null) {
  const s = salt || crypto.randomBytes(16).toString('hex');
  const dk = crypto.scryptSync(String(password), s, 32).toString('hex');
  return `${s}:${dk}`;
}

function verifyPassword(password, stored) {
  if (!stored || typeof stored !== 'string' || !stored.includes(':')) return false;
  const [salt, hex] = stored.split(':');
  if (!salt || !hex) return false;
  try {
    const expected = Buffer.from(hex, 'hex');
    const actual = crypto.scryptSync(String(password), salt, 32);
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

function parseCookies(req) {
  const raw = req.headers.cookie || '';
  const out = {};
  for (const part of raw.split(';')) {
    const idx = part.indexOf('=');
    if (idx <= 0) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

class AuthManager {
  constructor(store, getAuthCfg) {
    this.store = store;
    this.getAuthCfg = getAuthCfg;
    this.attempts = new Map(); // ip -> { count, resetAt }
    this.secret = this.store.getState('auth_secret', null);
    if (!this.secret) {
      this.secret = crypto.randomBytes(32).toString('hex');
      this.store.setState('auth_secret', this.secret);
    }
  }

  isEnabled() {
    const cfg = this.getAuthCfg();
    return !!(cfg && cfg.enabled);
  }

  isDefaultCredentials() {
    const cfg = this.getAuthCfg();
    if (!cfg) return true;
    const user = cfg.username || 'admin';
    if (user !== 'admin') return false;
    if (!cfg.passwordHash) return true;
    return verifyPassword('admin', cfg.passwordHash);
  }

  verifyLogin(username, password) {
    const cfg = this.getAuthCfg() || {};
    const expectedUser = cfg.username || 'admin';
    if (username !== expectedUser) return false;
    if (!cfg.passwordHash) {
      return password === 'admin';
    }
    return verifyPassword(password, cfg.passwordHash);
  }

  checkRateLimit(ip) {
    const now = Date.now();
    const rec = this.attempts.get(ip);
    if (!rec || now > rec.resetAt) {
      return { ok: true };
    }
    if (rec.count >= 10) {
      return { ok: false, retrySec: Math.ceil((rec.resetAt - now) / 1000) };
    }
    return { ok: true };
  }

  recordFailure(ip) {
    const now = Date.now();
    const rec = this.attempts.get(ip);
    if (!rec || now > rec.resetAt) {
      this.attempts.set(ip, { count: 1, resetAt: now + 60 * 1000 });
    } else {
      rec.count++;
    }
  }

  clearFailures(ip) {
    this.attempts.delete(ip);
  }

  createToken(username) {
    const cfg = this.getAuthCfg() || {};
    const ttlMs = Math.max(1, Number(cfg.sessionTtlHours) || 168) * 3600 * 1000;
    const payload = Buffer.from(JSON.stringify({
      u: username,
      exp: Date.now() + ttlMs,
    })).toString('base64url');
    const sig = crypto.createHmac('sha256', this.secret).update(payload).digest('base64url');
    return `${payload}.${sig}`;
  }

  verifyToken(token) {
    if (!token || typeof token !== 'string' || !token.includes('.')) return null;
    const [payload, sig] = token.split('.');
    if (!payload || !sig) return null;
    const expected = crypto.createHmac('sha256', this.secret).update(payload).digest('base64url');
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    try {
      const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
      if (!data || !data.u || !data.exp || Date.now() > data.exp) return null;
      return data;
    } catch {
      return null;
    }
  }

  authenticate(req) {
    if (!this.isEnabled()) return { ok: true, user: 'anonymous' };
    const cookies = parseCookies(req);
    const token = cookies[COOKIE_NAME];
    const data = this.verifyToken(token);
    if (!data) return { ok: false };
    return { ok: true, user: data.u };
  }

  makeCookieHeader(token, isHttps) {
    const cfg = this.getAuthCfg() || {};
    const maxAge = Math.max(1, Number(cfg.sessionTtlHours) || 168) * 3600;
    const parts = [
      `${COOKIE_NAME}=${encodeURIComponent(token)}`,
      `Path=/`,
      `Max-Age=${maxAge}`,
      `HttpOnly`,
      `SameSite=Lax`,
    ];
    if (isHttps) parts.push('Secure');
    return parts.join('; ');
  }

  clearCookieHeader() {
    return `${COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`;
  }
}

module.exports = { AuthManager, hashPassword, verifyPassword };

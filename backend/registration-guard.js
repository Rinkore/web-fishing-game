'use strict';
const crypto = require('crypto');
const { clientIp, rate } = require('./security');
const WINDOW = 3600000;
const sources = new Map(), challenges = new Map();
const startedAt = Date.now();
const metrics = { attempts: 0, created: 0, rejected: 0, challenged: 0, duplicate: 0, limited: 0 };
function limit(name, fallback) { const n = Number(process.env[name]); return Number.isSafeInteger(n) && n > 0 ? n : fallback; }
function state(req) {
  const ip = clientIp(req), now = Date.now();
  let s = sources.get(ip);
  if (!s || s.until <= now) { s = { attempts: 0, until: now + WINDOW }; if (sources.size < 10000) sources.set(ip, s); else return { attempts: Infinity }; }
  return s;
}
function begin(req, username) {
  metrics.attempts++;
  const s = state(req); s.attempts++;
  const nameKey = crypto.createHash('sha256').update(username).digest('hex');
  if (!rate('registration-global-hour', limit('REGISTER_GLOBAL_HOURLY', 200), WINDOW) ||
      !rate('registration-ip-hour:' + clientIp(req), limit('REGISTER_IP_HOURLY', 10), WINDOW) ||
      !rate('registration-name:' + nameKey, 5, WINDOW)) {
    metrics.limited++; return { status: 429, error: '注册请求过于频繁，请稍后再试' };
  }
  return s.attempts > 3 ? { challenge: true } : {};
}
function issue(req) {
  if (!rate('register-challenge-global', 600, 60000) || !rate('register-challenge:' + clientIp(req), 20, 60000) || challenges.size >= 5000) return null;
  // Not a CAPTCHA: one-use, short-lived, source-bound proof of work.
  const id = crypto.randomBytes(20).toString('hex'), prefix = crypto.randomBytes(16).toString('hex');
  challenges.set(id, { ip: clientIp(req), prefix, expires: Date.now() + 120000 });
  return { id, prefix, difficulty: 4, expiresIn: 120 };
}
function consume(req, proof) {
  if (!proof || typeof proof.id !== 'string' || typeof proof.nonce !== 'string' || !/^\d{1,12}$/.test(proof.nonce)) return false;
  const c = challenges.get(proof.id); challenges.delete(proof.id);
  if (!c || c.expires <= Date.now() || c.ip !== clientIp(req)) return false;
  return crypto.createHash('sha256').update(c.prefix + ':' + proof.nonce).digest('hex').startsWith('0000');
}
setInterval(() => {
  const now = Date.now();
  for (const [k, s] of sources) if (s.until <= now) sources.delete(k);
  for (const [k, c] of challenges) if (c.expires <= now) challenges.delete(k);
}, 60000).unref();
function snapshot() {
  return { counters: metrics, startedAt, limits: { globalHourly: limit('REGISTER_GLOBAL_HOURLY', 200), ipHourly: limit('REGISTER_IP_HOURLY', 10), usernameHourly: 5 },
    attention: metrics.limited > 0 || metrics.duplicate >= 5 };
}
module.exports = { begin, issue, consume, metrics, snapshot };

'use strict';
const crypto = require('crypto');
const net = require('net');
class ValidationError extends Error {}
function int(v, name, min = 1, max = 10000) {
  if (!Number.isSafeInteger(v) || v < min || v > max) throw new ValidationError(name + '必须为 ' + min + '～' + max + ' 的整数');
  return v;
}
function string(v, name, min = 1, max = 200) {
  if (typeof v !== 'string' || v.length < min || v.length > max) throw new ValidationError(name + '格式错误');
}
function validate(p, d) {
  if (!d || typeof d !== 'object' || Array.isArray(d)) throw new ValidationError('请求体必须是对象');
  if (['/api/login', '/api/register', '/api/admin/login'].includes(p)) {
    string(d.username, '用户名', 1, 20); string(d.password, '密码', 1, 256);
    if (p === '/api/register') {
      if (d.name !== undefined) string(d.name, '显示名', 0, 40);
      if (d.confirmPassword !== undefined) string(d.confirmPassword, '确认密码', 1, 256);
      if (typeof d.qq !== 'string' || !/^[0-9]{5,12}$/.test(d.qq)) throw new ValidationError('QQ 号格式错误');
    }
  }
  const qtyRoutes = ['/api/sell', '/api/market/list', '/api/market/buy', '/api/mall/buy', '/api/chest/craft'];
  if (qtyRoutes.includes(p)) {
    if (d.qty !== undefined) int(d.qty, '数量', 1, p === '/api/chest/craft' ? 99 : 10000);
    if (d.id !== undefined) string(d.id, '物品', 1, 4096);
  }
  if (p === '/api/market/list') {
    int(d.price, '价格', 1, 100000000);
    if (d.hours !== undefined && ![6, 12, 24].includes(d.hours)) throw new ValidationError('时长必须为 6、12 或 24');
    if (d.rodSlot !== undefined) int(d.rodSlot, '钓竿槽位', 0, 7);
  }
  if (p === '/api/market/buy') int(d.lid, '挂单编号', 1, Number.MAX_SAFE_INTEGER);
  if (p === '/api/trade/set' || p === '/api/workshop/smelt') {
    const field = p === '/api/trade/set' ? 'items' : 'materials';
    const entries = d[field] === undefined && field === 'materials' ? [] : d[field];
    if (!Array.isArray(entries) || entries.length > 100) throw new ValidationError('物品列表格式错误');
    for (const e of entries) {
      if (!e || typeof e !== 'object' || Array.isArray(e)) throw new ValidationError('物品格式错误');
      string(e.id, '物品', 1, 4096); int(e.qty, '数量');
    }
    if (d.relics !== undefined) int(d.relics, '残片', 0, 99);
    if (d.pearl !== undefined && typeof d.pearl !== 'boolean') throw new ValidationError('宝珠开关必须为布尔值');
  }
}
function normalizeIp(ip) { return String(ip || '').replace(/^::ffff:/, ''); }
function clientIp(req) {
  const peer = normalizeIp(req.socket && req.socket.remoteAddress);
  const trusted = (process.env.TRUSTED_PROXY_IPS || '').split(',').map(x => normalizeIp(x.trim()));
  if (!trusted.includes(peer)) return peer || 'unknown';
  const chain = String(req.headers['x-forwarded-for'] || '').split(',').map(x => normalizeIp(x.trim()));
  if (!chain.length || chain.some(x => !net.isIP(x))) return peer;
  // Walk from the trusted proxy toward the client, never trust a client-supplied leftmost entry.
  for (let i = chain.length - 1; i >= 0; i--) if (!trusted.includes(chain[i])) return chain[i];
  return chain[0];
}
const limits = new Map();
function rate(key, max, windowMs) {
  const now = Date.now();
  let bucket = limits.get(key);
  if (!bucket || bucket.until <= now) {
    if (limits.size >= 20000) return false; // bounded memory, fail closed
    bucket = { count: 0, until: now + windowMs }; limits.set(key, bucket);
  }
  return ++bucket.count <= max;
}
setInterval(() => { const now = Date.now(); for (const [k, v] of limits) if (v.until <= now) limits.delete(k); }, 60000).unref();
function authRate(req, p) {
  if (!['/api/register', '/api/login', '/api/admin/login'].includes(p)) return true;
  const reg = p === '/api/register';
  return rate('global-auth', 1200, 60000) && rate((reg ? 'register:' : 'login:') + clientIp(req), reg ? 20 : 120, 60000);
}
function base32(bytes) {
  let bits = 0, value = 0, out = '';
  for (const b of bytes) { value = (value << 8) | b; bits += 8; while (bits >= 5) { bits -= 5; out += 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'[(value >>> bits) & 31]; } }
  if (bits) out += 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'[(value << (5 - bits)) & 31];
  return out;
}
function totp(secret, step = Math.floor(Date.now() / 30000)) {
  const counter = Buffer.alloc(8); counter.writeBigUInt64BE(BigInt(step));
  const h = crypto.createHmac('sha1', Buffer.from(secret, 'hex')).update(counter).digest();
  const offset = h[19] & 15;
  return String((h.readUInt32BE(offset) & 0x7fffffff) % 1000000).padStart(6, '0');
}
function verifyTotp(rec, code) {
  if (!rec.adminTotpSecret || typeof code !== 'string' || !/^\d{6}$/.test(code)) return false;
  const step = Math.floor(Date.now() / 30000);
  for (const n of [step - 1, step, step + 1]) {
    if (n <= (rec.adminTotpStep || 0)) continue;
    if (crypto.timingSafeEqual(Buffer.from(totp(rec.adminTotpSecret, n)), Buffer.from(code))) { rec.adminTotpStep = n; return true; }
  }
  return false;
}
module.exports = { ValidationError, int, validate, clientIp, authRate, rate, base32, totp, verifyTotp };

'use strict';
const crypto = require('crypto');
const { promisify } = require('util');
const scrypt = promisify(crypto.scrypt);
const { ValidationError } = require('./security');
const GAME_TTL = 24 * 3600 * 1000;
// v0.21.0：管理会话与游戏同寿命（本机测试服取消 30 分钟自动离线）
const ADMIN_TTL = GAME_TTL;
function trusted(req) {
  const peer = String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  return (process.env.TRUSTED_PROXY_IPS || '').split(',').map(x => x.trim()).includes(peer);
}
function secure(req) { return !!req.socket.encrypted || (trusted(req) && req.headers['x-forwarded-proto'] === 'https'); }
function origins() {
  return (process.env.ALLOWED_ORIGINS || '').split(',').map(x => x.trim()).filter(Boolean).map(x => {
    const u = new URL(x);
    if (!['https:', 'http:'].includes(u.protocol) || u.origin !== x) throw new Error('ALLOWED_ORIGINS must contain exact HTTP(S) origins');
    return x;
  });
}
const allowed = origins();
function headers(req, res) {
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Security-Policy', "frame-ancestors 'none'; object-src 'none'; base-uri 'self'");
  res.setHeader('Content-Security-Policy-Report-Only', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self' " + allowed.join(' ') + "; frame-ancestors 'none'; object-src 'none'; base-uri 'self'");
  if (secure(req)) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  if (allowed.length) res.setHeader('Vary', 'Origin');
  const origin = req.headers.origin;
  const own = (secure(req) ? 'https://' : 'http://') + req.headers.host;
  if (origin && origin !== own && !allowed.includes(origin)) return false;
  if (origin && allowed.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With, X-Session-Mode');
    res.setHeader('Access-Control-Max-Age', '600');
  }
  return true;
}
function cookieName(admin, isSecure) { return (isSecure ? '__Host-' : '') + (admin ? 'fish_admin' : 'fish_game'); }
function token(req, admin) {
  const auth = req.headers.authorization;
  if (auth !== undefined) return /^Bearer [A-Za-z0-9_-]+$/.test(auth) && auth.length < 300 ? auth.slice(7) : '';
  const name = cookieName(admin, secure(req));
  const parts = String(req.headers.cookie || '').split(';').map(x => x.trim()).filter(x => x.startsWith(name + '='));
  return parts.length === 1 ? parts[0].slice(name.length + 1) : '';
}
function setCookie(req, res, value, admin, clear = false) {
  const tls = secure(req);
  res.setHeader('Set-Cookie', cookieName(admin, tls) + '=' + value + '; Path=/; HttpOnly; SameSite=Strict; Max-Age=' + (clear ? 0 : Math.floor((admin ? ADMIN_TTL : GAME_TTL) / 1000)) + (tls ? '; Secure' : ''));
}
function loginToken(req, res, value, admin) {
  if (req.headers['x-session-mode'] !== 'cookie') return value;
  setCookie(req, res, value, admin);
  return 'cookie'; // client state marker, never an authentication credential
}
function csrf(req) {
  if (req.headers.authorization) return true;
  if (!req.headers.cookie && req.headers['x-session-mode'] !== 'cookie') return true;
  return req.headers['x-requested-with'] === 'FishGame' && String(req.headers['content-type'] || '').split(';')[0] === 'application/json';
}
function passwordPolicy(password, minLength = 12) {
  if (typeof password !== 'string' || password.length < minLength || password.length > 256) throw new ValidationError('新密码需为 ' + minLength + '～256 位');
  const common = ['password1234', '123456789012', 'qwerty123456', '123456abcdef', 'abcdefghijkl'];
  if (common.includes(password.toLowerCase()) || /^(.)\1+$/.test(password)) throw new ValidationError('请勿使用常见弱密码');
}
let activeKdf = 0;
async function derive(password, salt) {
  if (activeKdf >= 4) throw new ValidationError('密码验证繁忙，请稍后重试');
  activeKdf++;
  try { return await scrypt(password, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }); }
  finally { activeKdf--; }
}
async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  return 'scrypt$v1$' + salt + '$' + (await derive(password, salt)).toString('hex');
}
async function verifyPassword(rec, password) {
  if (!rec) return false;
  const stored = String(rec.pwHash || '');
  let actual, expected;
  if (stored.startsWith('scrypt$v1$')) {
    const parts = stored.split('$');
    if (parts.length !== 4 || !/^[a-f0-9]{32}$/.test(parts[2]) || !/^[a-f0-9]{64}$/.test(parts[3])) return false;
    actual = await derive(password, parts[2]); expected = Buffer.from(parts[3], 'hex');
  } else {
    actual = crypto.createHash('sha256').update(rec.salt + ':' + password).digest();
    expected = /^[a-f0-9]{64}$/.test(stored) ? Buffer.from(stored, 'hex') : Buffer.alloc(0);
  }
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}
module.exports = { GAME_TTL, ADMIN_TTL, headers, secure, token, setCookie, loginToken, csrf, passwordPolicy, hashPassword, verifyPassword };

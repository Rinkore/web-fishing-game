'use strict';
// 检查线上 https://ipv4.rinkore.com:9000 的增益钓点一览为何不见
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');
const { solve } = require('./_registration');
const BASE = 'https://ipv4.rinkore.com:9000';
const browserPath = process.env.CHROME_PATH || [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].find(fs.existsSync);
async function post(p, body, token) {
  const r = await fetch(BASE + p, { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, token ? { Authorization: 'Bearer ' + token } : {}), body: JSON.stringify(body || {}) });
  return { status: r.status, data: await r.json().catch(() => null) };
}
(async () => {
  const name = 'livechk' + Date.now().toString(36);
  let reg = await post('/api/register', { username: name, password: 'LiveCheck12345', name: '线上检查', qq: '10094' });
  if (reg.data && reg.data.code === 'REGISTRATION_CHALLENGE') {
    const c = await fetch(BASE + '/api/register/challenge').then(r => r.json());
    reg = await post('/api/register', { username: name, password: 'LiveCheck12345', name: '线上检查', qq: '10094', proof: solve(c) });
  }
  console.log('register:', reg.status, reg.data && reg.data.error ? reg.data.error : 'ok');
  if (reg.status !== 200) process.exit(1);

  const browser = await chromium.launch({ executablePath: browserPath, headless: true, ignoreHTTPSErrors: true });
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 1000 }, ignoreHTTPSErrors: true });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(4000);
  // 走登录 UI（HTTPS 下 Cookie 是 __Host- 前缀，直接注入不可靠）
  await page.fill('#auth-user', name);
  await page.fill('#auth-pass', 'LiveCheck12345');
  await page.click('#auth-submit');
  await page.waitForTimeout(6000);
  const info = await page.evaluate(() => ({
    version: document.querySelector('.brand small, .version, [class*=ver]') ? document.querySelector('.brand') ? document.querySelector('.brand').textContent.replace(/\s+/g, ' ').slice(0, 40) : '' : '',
    buffbar: !!document.querySelector('.px-buffbar'),
    buffChips: document.querySelectorAll('.pb-chip').length,
    boatRoute: !!document.querySelector('.px-boat-route'),
    grounds4: document.querySelectorAll('.g-card').length,
    buffedNodes: document.querySelectorAll('.px-node.buffed').length,
    spotBuffsInData: (window.GameData ? GameData.GROUNDS.flatMap(g => (g.spots || []).filter(s => s.buffs && s.buffs.length).map(s => g.id + '/' + s.id)) : ['no GameData']),
  }));
  console.log(JSON.stringify(info, null, 2));
  console.log('page errors:', errs.slice(0, 5).join(' | ') || 'none');
  await page.screenshot({ path: path.join(__dirname, 'shots', 'v019-live', 'live-9000.png') });
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });

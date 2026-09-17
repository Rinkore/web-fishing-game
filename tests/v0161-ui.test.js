/*
 * v0.16.1 界面回归（浏览器实测，独立套件）
 * 覆盖：
 *   · 一键出售预览的「品质」筛选：组件不再只剩「普通」一档。
 *     根因：组件品质是**实例生成时**掷出的（普通 / 稀有 / 史诗，宝匣突破件与重铸件是神话），
 *     而目录里的 30 个底材条目 rarity 恒为 common —— 档位照目录算就只剩一档。
 *     除了「列出四档」，还要真的能按档筛出行（只列标签不算修好）。
 *   · 背包页与钓鱼页顶部的说明行已移除（其余页面照旧保留）。
 *   · 点侧栏入口回到该页**主页签**：「钓鱼」不再停在「钓竿」、「图鉴」不再停在「记录」。
 * 运行： node tests/v0161-ui.test.js（需要 CHROME_PATH 或本机 Chrome/Edge）
 * 说明：FISHING_DATA_DIR 指向临时数据目录，不触碰真实存档；FISHING_DEV=1 开发接口。
 */
'use strict';
const { chromium } = require('playwright-core');
// 侧栏入口适配层：旧入口名（钓竿配置 / 渔获记录）折算出「入口 + 页签」
const { clickAppNav } = require('./_nav.js');
const { spawn, spawnSync } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { waitHttp } = require('./_util.js');

const ROOT = path.join(__dirname, '..');
const PORT = 8261;
const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'fishing-v0161ui-test-'));
const CHROME = process.env.CHROME_PATH || [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].find(p => fs.existsSync(p));

let pass = 0, fail = 0;
const failed = [];
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; failed.push(name); console.log('  FAIL  ' + name + (extra ? '  -> ' + extra : '')); }
}
function section(t) { console.log('\n=== [' + Math.round((Date.now() - T0) / 1000) + 's] ' + t + ' ==='); }
const T0 = Date.now();
const sleep = ms => new Promise(r => setTimeout(r, ms));
function killTree(p) { try { spawnSync('taskkill', ['/F', '/T', '/PID', String(p.pid)], { stdio: 'ignore' }); } catch (e) {} }
async function until(fn, ok, timeout) {
  const dl = Date.now() + (timeout || 10000);
  for (;;) { const v = await fn().catch(() => null); if (ok(v)) return v; if (Date.now() >= dl) return v; await sleep(80); }
}
function req(method, p, body) {
  return new Promise(res => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({ hostname: 'localhost', port: PORT, path: p, method,
      headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {} }, rs => {
      let d = ''; rs.on('data', c => d += c);
      rs.on('end', () => { let j = null; try { j = JSON.parse(d); } catch (e) {} res({ status: rs.statusCode, data: j }); });
    });
    r.on('error', () => res({ status: 0 }));
    if (data) r.write(data);
    r.end();
  });
}
const GET = p => req('GET', p), POST = (p, b) => req('POST', p, b);

// 三个同底材、不同品质的组件实例（实例签名：<底材>#<品质>#<词缀>）
const COMP_COMMON = 'reel_electric#common#spd+25';
const COMP_RARE = 'reel_electric#rare#spd+25';
const COMP_EPIC = 'reel_electric#epic#spd+25';
const give = (token, id) => POST('/api/dev/catch', { token: token, item: { kind: 'component', id: id } });

async function clickNav(page, name) {
  const target = await clickAppNav(page, name);
  await until(() => page.evaluate(n => Array.from(document.querySelectorAll('.nav-item')).some(x => x.textContent.includes(n)), target.nav), v => v === true, 30000);
}
// 弹窗内某个筛选下拉的 option 值列表
const modalOpts = (page, id) => page.evaluate(i => {
  const s = document.querySelector('.modal-overlay #' + i);
  return s ? Array.from(s.options).map(o => o.value) : null;
}, id);
const setModalSel = (page, id, val) => page.evaluate(a => {
  const s = document.querySelector('.modal-overlay #' + a.id);
  if (!s) return false;
  s.value = a.val;
  s.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
}, { id: id, val: val });
const bulkRows = page => page.evaluate(() => document.querySelectorAll('.modal-overlay .bulk-row-item').length);
const tabCls = (page, tab) => page.evaluate(t => {
  const b = document.querySelector('#main [data-sectiontab="' + t + '"]');
  return b ? b.className : null;
}, tab);

let srv = null, browser = null;
async function main() {
  srv = spawn(process.execPath, ['backend/server.js'], { cwd: ROOT,
    env: Object.assign({}, process.env, { PORT: String(PORT), FISHING_DEV: '1', FISHING_DATA_DIR: TMP_DATA }) });
  await waitHttp('http://localhost:' + PORT + '/shop', { timeout: 20000 });

  const rA = await POST('/api/register', { username: 'v161ui_a', password: 'abcd1234', name: '界面甲', qq: '41101' });
  const tok = rA.data.token;
  check('账号就绪', !!tok);
  await give(tok, COMP_COMMON);
  await give(tok, COMP_RARE);
  await give(tok, COMP_EPIC);
  const inv = (await GET('/api/me?token=' + tok)).data.inventory || {};
  check('前置：背包里有三个不同品质的同底材组件',
    !!(inv[COMP_COMMON] && inv[COMP_RARE] && inv[COMP_EPIC]), JSON.stringify(Object.keys(inv)));

  browser = await chromium.launch({ executablePath: CHROME, args: ['--disable-gpu'] });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const errs = [];
  const pErr = e => e.message + ' @ ' + (String(e.stack || '').split('\n')[1] || '').trim();
  const p1 = await ctx.newPage();
  p1.on('pageerror', e => errs.push('player ' + pErr(e)));
  await p1.goto('http://localhost:' + PORT + '/', { waitUntil: 'load' });
  await p1.evaluate(t => localStorage.setItem('fishing_token', t), tok);
  await p1.reload({ waitUntil: 'load' });
  await sleep(800);
  await until(() => p1.evaluate(() => !!window.Engine && !!window.Engine.state.me), v => v === true, 30000);

  // ---------------- 背包页：说明行已移除 + 组件子筛选的档位 ----------------
  section('背包页：说明行已移除；组件品质档不再是「普通」一档');
  await clickNav(p1, '背包');
  await until(() => p1.evaluate(() => !!document.querySelector('#main .bulk-sell')), v => v === true, 20000);
  const invHead = await p1.evaluate(() => ({
    help: document.querySelectorAll('#main .page-help').length,
    helpText: Array.from(document.querySelectorAll('#main .page-help')).map(x => x.textContent.trim()),
    hasTabs: !!document.querySelector('#main .inv-page-tabs .inv-cat'),
  }));
  check('背包页没有说明行（截图指定移除）', invHead.help === 0, JSON.stringify(invHead.helpText));
  check('背包页确实渲染出来了（放着分类页签）', invHead.hasTabs === true);
  await p1.evaluate(() => {
    const b = Array.from(document.querySelectorAll('#main .inv-page-tabs .inv-cat')).find(x => /组件/.test(x.textContent || ''));
    if (b) b.click();
  });
  // 对照：宝匣走的是「照着目录算」那条路（目录里宝匣只有稀有/史诗/神话），不能被组件的口径带偏
  await p1.evaluate(() => {
    const b = Array.from(document.querySelectorAll('#main .inv-page-tabs .inv-cat')).find(x => /宝匣/.test(x.textContent || ''));
    if (b) b.click();
  });
  await until(() => p1.evaluate(() => Array.from(document.querySelectorAll('#main .inv-subrow'))
    .some(r => /品质/.test((r.querySelector('.sub-label') || {}).textContent || ''))), v => v === true, 15000);
  const chestRar = await p1.evaluate(() => {
    const row = Array.from(document.querySelectorAll('#main .inv-subrow'))
      .find(r => /品质/.test((r.querySelector('.sub-label') || {}).textContent || ''));
    return row ? Array.from(row.querySelectorAll('.inv-cat.sub')).map(b => b.textContent.trim()) : null;
  });
  check('对照：宝匣品质档仍按目录实给（稀有 / 史诗 / 神话，没有普通）',
    !!chestRar && chestRar.some(t => t.indexOf('稀有') === 0) && chestRar.some(t => t.indexOf('史诗') === 0) &&
      chestRar.some(t => t.indexOf('神话') === 0) && !chestRar.some(t => t.indexOf('普通') === 0),
    JSON.stringify(chestRar));

  // ---------------- 一键出售预览：品质筛选 ----------------
  section('一键出售预览：组件的品质筛选（列四档 + 真能筛出对应行）');
  await p1.evaluate(() => {
    const b = Array.from(document.querySelectorAll('#main button')).find(x => /一键出售/.test(x.textContent || ''));
    if (b) b.click();
  });
  await until(() => p1.evaluate(() => !!document.querySelector('.modal-overlay #bulk-cat')), v => v === true, 15000);
  check('预览弹窗已打开', await p1.evaluate(() => !!document.querySelector('.modal-overlay #bulk-cat')));
  check('种类=全部时不给品质下拉（按分类才出细分）', (await modalOpts(p1, 'bulk-rar')) === null);
  await setModalSel(p1, 'bulk-cat', 'component');
  await until(async () => (await modalOpts(p1, 'bulk-rar')) !== null, v => v === true, 10000);
  const rarOpts = await modalOpts(p1, 'bulk-rar');
  check('组件品质下拉列出四档（普通 / 稀有 / 史诗 / 神话）',
    !!rarOpts && ['all', 'common', 'rare', 'epic', 'mythic'].every(k => rarOpts.indexOf(k) >= 0), JSON.stringify(rarOpts));
  const nAll = await bulkRows(p1);
  check('全部品质下列出三个组件行', nAll === 3, String(nAll));
  await setModalSel(p1, 'bulk-rar', 'rare');
  await until(async () => (await bulkRows(p1)) === 1, v => v === true, 8000);
  check('选「稀有」只剩那一行（筛选真的生效）', (await bulkRows(p1)) === 1, String(await bulkRows(p1)));
  await setModalSel(p1, 'bulk-rar', 'epic');
  await until(async () => (await bulkRows(p1)) === 1, v => v === true, 8000);
  check('选「史诗」只剩那一行', (await bulkRows(p1)) === 1, String(await bulkRows(p1)));
  await setModalSel(p1, 'bulk-rar', 'mythic');
  await until(async () => (await bulkRows(p1)) === 0, v => v === true, 8000);
  check('选「神话」为 0 行（该玩家没有重铸/突破件）', (await bulkRows(p1)) === 0);
  await setModalSel(p1, 'bulk-rar', 'all');
  await until(async () => (await bulkRows(p1)) === 3, v => v === true, 8000);
  check('切回「全部品质」恢复三行', (await bulkRows(p1)) === 3);
  await p1.evaluate(() => { const b = document.querySelector('.modal-overlay .modal-close'); if (b) b.click(); });
  await until(() => p1.evaluate(() => !document.querySelector('.modal-overlay')), v => v === true, 8000);

  // ---------------- 侧栏入口：回到主页签 ----------------
  section('侧栏入口：点「钓鱼」回「钓鱼」页签，不再停在「钓竿」');
  await clickNav(p1, '钓竿配置');
  await until(async () => /(^| )on( |$)/.test((await tabCls(p1, 'rod')) || ''), v => v === true, 20000);
  check('先经入口进到「钓竿」页签（前置）', /(^| )on( |$)/.test((await tabCls(p1, 'rod')) || ''), String(await tabCls(p1, 'rod')));
  await clickAppNav(p1, '钓鱼');
  await until(async () => /(^| )on( |$)/.test((await tabCls(p1, 'fishing')) || ''), v => v === true, 15000);
  const fishPage = await p1.evaluate(() => ({
    fishing: (document.querySelector('#main [data-sectiontab="fishing"]') || {}).className || '',
    rod: (document.querySelector('#main [data-sectiontab="rod"]') || {}).className || '',
    help: document.querySelectorAll('#main .page-help').length,
    map: !!document.querySelector('#main .fish-select'),
  }));
  check('点「钓鱼」后回到「钓鱼」页签（钓竿不再选中）',
    /(^| )on( |$)/.test(fishPage.fishing) && !/(^| )on( |$)/.test(fishPage.rod),
    JSON.stringify({ fishing: fishPage.fishing, rod: fishPage.rod }));
  check('钓鱼页确实渲染出来了（有选点地图面板）', fishPage.map === true);
  check('钓鱼页没有说明行（截图指定移除）', fishPage.help === 0, String(fishPage.help));

  section('同一规则对「图鉴 / 记录」也成立');
  await clickNav(p1, '渔获记录');
  await until(async () => /(^| )on( |$)/.test((await tabCls(p1, 'records')) || ''), v => v === true, 20000);
  check('先经入口进到「记录」页签（前置）', /(^| )on( |$)/.test((await tabCls(p1, 'records')) || ''), String(await tabCls(p1, 'records')));
  await clickAppNav(p1, '图鉴');
  await until(async () => /(^| )on( |$)/.test((await tabCls(p1, 'codex')) || ''), v => v === true, 15000);
  const codexPage = await p1.evaluate(() => ({
    codex: (document.querySelector('#main [data-sectiontab="codex"]') || {}).className || '',
    records: (document.querySelector('#main [data-sectiontab="records"]') || {}).className || '',
  }));
  check('点「图鉴」后回到「图鉴」页签（记录不再选中）',
    /(^| )on( |$)/.test(codexPage.codex) && !/(^| )on( |$)/.test(codexPage.records),
    JSON.stringify(codexPage));

  section('其余页面的说明行照旧保留（本次只删背包与钓鱼两处）');
  await clickNav(p1, '工坊');
  await until(() => p1.evaluate(() => !!document.querySelector('#main .page-help')), v => v === true, 15000);
  check('工坊页仍有说明行', await p1.evaluate(() => document.querySelectorAll('#main .page-help').length > 0));
  await clickNav(p1, '商城');
  await until(() => p1.evaluate(() => !!document.querySelector('#main .page-help')), v => v === true, 15000);
  check('商城页仍有说明行', await p1.evaluate(() => document.querySelectorAll('#main .page-help').length > 0));

  check('玩家页面没有 JS 报错', errs.length === 0, errs.join(' | '));

  await browser.close();
  killTree(srv);
  await sleep(300);
  console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  if (failed.length) console.log('失败明细：\n' + failed.map(x => '  - ' + x).join('\n'));
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error(e); try { killTree(srv); } catch (x) {} process.exit(1); });

/*
 * v0.14.1 界面回归（浏览器实测，独立套件）
 * 覆盖：
 *   · 记录页鱼名旁显示该鱼基准体型（小字，data.js 的 size 区间）
 *   · 排行榜弹窗每条大小后给「（基准 ±x%）」——超出基准上限为正（>0% 大型 / >80% 巨型），图例写明口径
 *   · 后台「纪录管理」改展开式：点鱼名出 日/周/总 × 最大/最小，按名次单独删一条（真删、真刷新）
 *   · 后台「反馈意见」重排：规则折叠 + 统计条 + 筛选 chips + 卡片；样式由 admin.css 提供
 *     （回归：这一页原来引用了游戏端 style.css 的类名，后台根本没加载 → 反馈是裸文本墙）
 * 运行： node tests/v0141-ui.test.js（需要 CHROME_PATH 或本机 Chrome/Edge）
 * 说明：FISHING_DATA_DIR 指向临时数据目录，不触碰真实存档；FISHING_DEV=1 开发接口。
 */
'use strict';
const { chromium } = require('playwright-core');
// 侧栏入口适配层：旧入口名（钓竿配置 / 渔获记录 / 系统商店 / 开放市集）折算出「入口 + 页签」
const { clickAppNav } = require('./_nav.js');
const { spawn, spawnSync } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { waitHttp } = require('./_util.js');

const ROOT = path.join(__dirname, '..');
const PORT = 8243;
const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'fishing-v0141ui-test-'));
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

const FISH = 'crucian';                       // 鲫鱼：基准 [10,35]cm → 50cm = +42.9%
const catchFish = (token, size) => POST('/api/dev/catch', { token: token, item: { id: FISH, kind: 'fish', rarity: 'common', size: size } });
const boardOf = async range => ((await GET('/api/records/top?id=' + FISH + '&range=' + (range || 'day'))).data || {}).top || [];
async function clickNav(page, name) {
  // v0.15.0 起旧入口（钓竿配置 / 渔获记录 …）折算成「新入口 + 页内页签」
  const target = await clickAppNav(page, name);
  await until(() => page.evaluate(n => Array.from(document.querySelectorAll('.nav-item')).some(x => x.textContent.includes(n)), target.nav), v => v === true, 30000);
}

let srv = null, browser = null;
async function main() {
  srv = spawn(process.execPath, ['backend/server.js'], { cwd: ROOT,
    env: Object.assign({}, process.env, { PORT: String(PORT), FISHING_DEV: '1', FISHING_DATA_DIR: TMP_DATA }) });
  await waitHttp('http://localhost:' + PORT + '/shop', { timeout: 20000 });

  const rA = await POST('/api/register', { username: 'v141ui_a', password: 'abcd1234', name: '界面甲', qq: '40101' });
  const rB = await POST('/api/register', { username: 'v141ui_b', password: 'abcd1234', name: '界面乙', qq: '40102' });
  const tok = rA.data.token, tokB = rB.data.token;
  await POST('/api/register', { username: 'v141ui_admin', password: 'abcd1234', name: '后台管理员', qq: '40103' });
  const adm = (await POST('/api/admin/login', { username: 'v141ui_admin', password: 'abcd1234' })).data || {};
  check('账号就绪（含管理员引导）', !!tok && !!tokB && !!adm.token);
  // 两条上榜渔获：50cm（+42.9%）与 20cm（−42.9%），两位钓者 → 日/周/总三榜各 2 条
  await catchFish(tok, 50);
  await catchFish(tokB, 20);
  // 两条反馈（两个账号各一条，绕开 CD）
  await POST('/api/feedback/submit', { token: tok, kind: 'idea', text: '希望渔获记录能直接看到基准大小（v0141 UI 用例）' });
  await POST('/api/feedback/submit', { token: tokB, kind: 'bug', text: '一键出售偶尔静默 0 件（v0141 UI 用例）' });
  check('前置：日榜 2 条', (await boardOf('day')).length === 2, JSON.stringify((await boardOf('day')).map(x => x.size)));

  browser = await chromium.launch({ executablePath: CHROME, args: ['--disable-gpu'] });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const errs = [];
  const pErr = e => e.message + ' @ ' + (String(e.stack || '').split('\n')[1] || '').trim();

  // ---------------- 玩家端：记录页基准小字 + 排行榜百分比 ----------------
  section('记录页：鱼名旁的基准体型小字');
  const p1 = await ctx.newPage();
  p1.on('pageerror', e => errs.push('player ' + pErr(e)));
  await p1.goto('http://localhost:' + PORT + '/', { waitUntil: 'load' });
  await p1.evaluate(t => localStorage.setItem('fishing_token', t), tok);
  await p1.reload({ waitUntil: 'load' });
  await sleep(800);
  await until(() => p1.evaluate(() => !!window.Engine && !!window.Engine.state.me), v => v === true, 30000);
  await clickNav(p1, '渔获记录');
  await until(() => p1.evaluate(() => !!document.querySelector('#main .record-cell')), v => v === true, 20000);
  const cell = await p1.evaluate(() => {
    const c = Array.from(document.querySelectorAll('#main .record-cell'))
      .find(x => /鲫鱼/.test((x.querySelector('.rc-name') || {}).textContent || ''));
    if (!c) return null;
    const nm = c.querySelector('.rc-name');
    const base = c.querySelector('.rc-base');
    return {
      name: (nm || {}).textContent || '',
      baseText: (base || {}).textContent || '',
      insideName: !!(nm && base && nm.contains(base)),
      css: base ? getComputedStyle(base).fontSize : '',
    };
  });
  check('鲫鱼卡片显示基准区间', !!cell && /基准 10~35cm/.test(cell.baseText), JSON.stringify(cell));
  check('基准是挂在鱼名那一行里的（不是另起一行）', !!cell && cell.insideName === true, JSON.stringify(cell && cell.name));
  check('基准是小字（≤11px）', !!cell && parseFloat(cell.css) <= 11, String(cell && cell.css));
  const noRecBase = await p1.evaluate(() => {
    const c = Array.from(document.querySelectorAll('#main .record-cell.none'))
      .find(x => !!x.querySelector('.rc-base'));
    return c ? c.querySelector('.rc-base').textContent : null;
  });
  check('暂无纪录的卡片也标了基准', /基准 \d+~\d+cm/.test(noRecBase || ''), String(noRecBase));

  section('排行榜弹窗：每条大小后的「基准 ±%」');
  await p1.evaluate(() => {
    const c = Array.from(document.querySelectorAll('#main .record-cell'))
      .find(x => /鲫鱼/.test((x.querySelector('.rc-name') || {}).textContent || ''));
    if (c) c.click();
  });
  await until(() => p1.evaluate(() => !!document.querySelector('.modal-overlay .top10-row')), v => v === true, 15000);
  const modal = await p1.evaluate(() => ({
    title: (document.querySelector('.modal-overlay .modal-title') || {}).textContent || '',
    rows: Array.from(document.querySelectorAll('.modal-overlay .top10-row')).map(r => ({
      size: (r.querySelector('.top10-size') || {}).textContent || '',
      pct: (r.querySelector('.top10-pct') || {}).textContent || null,
      cls: (r.querySelector('.top10-pct') || {}).className || '',
    })),
    legend: (document.querySelector('.modal-overlay .sd-legend') || {}).textContent || '',
  }));
  check('弹窗打开的是鲫鱼排行榜', /鲫鱼/.test(modal.title), modal.title);
  check('50cm 那条标出 +42.9%', modal.rows.some(r => r.size === '50cm' && /\+42\.9%/.test(r.pct || '')), JSON.stringify(modal.rows));
  check('20cm 那条标出 −42.9%（小于基准也如实标）', modal.rows.some(r => r.size === '20cm' && /-42\.9%/.test(r.pct || '')), JSON.stringify(modal.rows));
  check('百分比用淡色小字样式类', modal.rows.every(r => r.pct == null || /top10-pct/.test(r.cls)), JSON.stringify(modal.rows.map(r => r.cls)));
  check('图例写明口径（基准上限 / 大型 / 巨型）',
    /基准上限 35cm/.test(modal.legend) && /大型/.test(modal.legend) && /巨型/.test(modal.legend), modal.legend);
  await p1.evaluate(() => { const b = document.querySelector('.modal-overlay .modal-close'); if (b) b.click(); });

  // ---------------- 后台：纪录管理展开 + 单条删除 ----------------
  section('后台纪录管理：展开榜单并按名次删一条');
  const pa = await ctx.newPage();
  pa.on('pageerror', e => errs.push('admin ' + pErr(e)));
  await pa.goto('http://localhost:' + PORT + '/admin.html', { waitUntil: 'load' });
  await pa.evaluate(t => localStorage.setItem('fishing_admin_token', t), adm.token);
  await pa.reload({ waitUntil: 'load' });
  await until(() => pa.evaluate(() => !!document.querySelector('.nav-item')), v => v === true, 15000);
  await clickNav(pa, '纪录贴图');
  await until(() => pa.evaluate(() => !!document.querySelector('#rc-del-list .rcm-head')), v => v === true, 15000);
  const head = await pa.evaluate(() => {
    const h = Array.from(document.querySelectorAll('#rc-del-list .rcm-head'))
      .find(x => /鲫鱼/.test(x.textContent || ''));
    if (!h) return null;
    return {
      text: h.textContent,
      hasBase: /基准 10~35cm/.test(h.textContent || ''),
      btn: Array.from(h.querySelectorAll('button')).map(b => b.textContent.trim()),
    };
  });
  check('鱼种行有「删除该鱼种全部」按钮（不再是唯一个一个删除键）', !!head && head.btn.some(t => /删除该鱼种全部/.test(t)), JSON.stringify(head && head.btn));
  check('行上也带基准区间', !!head && head.hasBase === true, String(head && head.text));
  await pa.evaluate(() => {
    const h = Array.from(document.querySelectorAll('#rc-del-list .rcm-head')).find(x => /鲫鱼/.test(x.textContent || ''));
    if (h) h.click();
  });
  await until(() => pa.evaluate(() => !!document.querySelector('[data-rcboard] .rcm-row')), v => v === true, 15000);
  const openInfo = await pa.evaluate(() => ({
    ranges: Array.from(document.querySelectorAll('[data-rcrange]')).map(b => b.textContent.trim()),
    kinds: Array.from(document.querySelectorAll('[data-rckind]')).map(b => b.textContent.trim()),
    rows: Array.from(document.querySelectorAll('[data-rcboard] .rcm-row')).map(r => ({
      size: (r.querySelector('.rcm-size') || {}).textContent || '',
      pct: (r.querySelector('.rcm-pct') || {}).textContent || null,
      who: (r.querySelector('.rcm-who') || {}).textContent || '',
      hasDel: !!r.querySelector('[data-rcmdel]'),
    })),
  }));
  check('展开后有 日/周/总 三档范围', openInfo.ranges.join('/') === '日榜/周榜/总榜', JSON.stringify(openInfo.ranges));
  check('展开后有 最大/最小 两个榜单', openInfo.kinds.length === 2, JSON.stringify(openInfo.kinds));
  check('榜单行带尺寸、钓者与删除键', openInfo.rows.length === 2 && openInfo.rows.every(r => r.hasDel), JSON.stringify(openInfo.rows));
  check('榜单行也标出基准百分比（+42.9% / −42.9%）',
    openInfo.rows.some(r => /\+42\.9%/.test(r.pct || '')) && openInfo.rows.some(r => /-42\.9%/.test(r.pct || '')),
    JSON.stringify(openInfo.rows.map(r => r.pct)));
  // 切到总榜：应有 2 条
  await pa.evaluate(() => { const b = Array.from(document.querySelectorAll('[data-rcrange]')).find(x => x.textContent.trim() === '总榜'); if (b) b.click(); });
  await until(() => pa.evaluate(() => /总榜/.test((document.querySelector('[data-rcboard] .rcm-label') || {}).textContent || '')), v => v === true, 10000);
  check('切到总榜仍 2 条', (await pa.evaluate(() => document.querySelectorAll('[data-rcboard] .rcm-row').length)) === 2);
  // 删总榜第 1 名（50cm）：确认框 → 确认 → 前后端都少一条
  const beforeAll = (await boardOf('all')).length;
  await pa.evaluate(() => {
    const r = document.querySelector('[data-rcboard] .rcm-row');
    const b = r && r.querySelector('[data-rcmdel]');
    if (b) b.click();
  });
  await until(() => pa.evaluate(() => !!document.querySelector('.modal-overlay #rc-del-ok')), v => v === true, 8000);
  const cfText = await pa.evaluate(() => (document.querySelector('.modal-overlay .cf-text') || {}).textContent || '');
  check('确认框写明删的是哪条（榜别 + 名次 + 钓者 + 尺寸）',
    /总榜/.test(cfText) && /第 1 名/.test(cfText) && /界面甲/.test(cfText) && /50cm/.test(cfText), cfText.slice(0, 120));
  check('确认框提供「从其它榜单与纪录里一并移除」勾选', /最大 \/ 最小纪录/.test(cfText), cfText.slice(0, 200));
  await pa.evaluate(() => { const b = document.querySelector('#rc-del-ok'); if (b) b.click(); });
  await until(async () => (await boardOf('all')).length === beforeAll - 1, v => v === true, 10000);
  check('服务端总榜少一条（真删了）', (await boardOf('all')).length === beforeAll - 1, 'before=' + beforeAll);
  const dayAfter = await boardOf('day');
  check('purge 生效：日/周榜里那条同尺寸渔获也没了',
    !dayAfter.some(x => x.size === 50), JSON.stringify(dayAfter.map(x => x.size)));
  await until(() => pa.evaluate(() => document.querySelectorAll('[data-rcboard] .rcm-row').length === 1), v => v === true, 8000);
  check('页面上的榜单就地刷新为 1 条', (await pa.evaluate(() => document.querySelectorAll('[data-rcboard] .rcm-row').length)) === 1);

  // ---------------- 后台：反馈意见重排 ----------------
  section('后台反馈意见：折叠规则 + 统计 + chips + 卡片（样式必须来自 admin.css）');
  await clickNav(pa, '反馈意见');
  await until(() => pa.evaluate(() => !!document.querySelector('#fb-body .fb-card')), v => v === true, 15000);
  const fb = await pa.evaluate(() => {
    const card = document.querySelector('#fb-body .fb-card');
    const cs = card ? getComputedStyle(card) : null;
    return {
      hasRules: !!document.querySelector('.fb-rules'),
      rulesClosed: !!document.querySelector('.fb-rules') && !document.querySelector('.fb-rules').open,
      rulesNow: (document.querySelector('#fbc-now') || {}).textContent || '',
      stat: (document.querySelector('#fb-body .fb-stat') || {}).textContent || '',
      chips: Array.from(document.querySelectorAll('#fb-body .fb-chip')).map(b => b.textContent.trim()),
      cards: document.querySelectorAll('#fb-body .fb-card').length,
      cardRadius: cs ? cs.borderRadius : '',
      cardBg: cs ? cs.backgroundColor : '',
      statusSel: document.querySelectorAll('#fb-body .fb-status-sel').length,
      rewardBtn: document.querySelectorAll('#fb-body [data-reward]').length,
    };
  });
  check('规则收进折叠块（默认收起，摘要显示当前值）', fb.hasRules && fb.rulesClosed && /CD/.test(fb.rulesNow), JSON.stringify({ r: fb.rulesClosed, n: fb.rulesNow }));
  check('顶部统计条给出各状态条数', /共 2 条/.test(fb.stat) && /已提交/.test(fb.stat), fb.stat);
  check('筛选是 chips（含类型 / 状态 / 仅未奖励）',
    fb.chips.some(t => /全部类型/.test(t)) && fb.chips.some(t => /已完成/.test(t)) && fb.chips.some(t => /仅未奖励/.test(t)),
    JSON.stringify(fb.chips));
  check('两条反馈都渲染成卡片（含状态框与奖励键）', fb.cards === 2 && fb.statusSel === 2 && fb.rewardBtn === 2, JSON.stringify(fb));
  check('卡片样式来自 admin.css（圆角 + 非透明底，不再是裸文本墙）',
    fb.cardRadius === '8px' && fb.cardBg !== 'rgba(0, 0, 0, 0)' && fb.cardBg !== 'transparent',
    JSON.stringify({ r: fb.cardRadius, b: fb.cardBg }));
  // 点「已完成」chip → 0 条（两条都是已提交）；再点回「全部状态」→ 2 条
  await pa.evaluate(() => { const b = Array.from(document.querySelectorAll('#fb-body .fb-chip')).find(x => x.textContent.trim().indexOf('已完成') === 0); if (b) b.click(); });
  await until(() => pa.evaluate(() => !document.querySelector('#fb-body .fb-card')), v => v === true, 8000);
  check('点状态 chip 立刻筛掉不匹配的反馈', (await pa.evaluate(() => document.querySelectorAll('#fb-body .fb-card').length)) === 0);
  await pa.evaluate(() => { const b = Array.from(document.querySelectorAll('#fb-body .fb-chip')).find(x => x.textContent.trim().indexOf('全部状态') === 0); if (b) b.click(); });
  await until(() => pa.evaluate(() => document.querySelectorAll('#fb-body .fb-card').length === 2), v => v === true, 8000);
  check('点回「全部状态」恢复两条', (await pa.evaluate(() => document.querySelectorAll('#fb-body .fb-card').length)) === 2);

  check('玩家与后台页面都没有 JS 报错', errs.length === 0, errs.join(' | '));

  await browser.close();
  killTree(srv);
  await sleep(300);
  console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  if (failed.length) console.log('失败明细：\n' + failed.map(x => '  - ' + x).join('\n'));
  process.exit(fail ? 1 : 0);
}
main().catch(async e => { console.error(e); try { killTree(srv); } catch (x) {} try { if (browser) await browser.close(); } catch (x) {} process.exit(1); });

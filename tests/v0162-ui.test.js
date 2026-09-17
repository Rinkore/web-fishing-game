/*
 * v0.16.2 界面回归（浏览器实测，独立套件）
 * 覆盖：
 *   · 熔炼页：每条词缀**后面**高亮标出它的落成概率；汇总区高亮「完全成功概率」（= 熔炼成功 × 补缀命中）
 *   · 熔炼 / 重铸槽位的「卸下」按钮：清空槽位（主件卸下会一并清掉副件与已选词条）
 *   · 后台「资产快照」：新增物品覆盖全部物品（含宝匣）+ 物品搜索框 + 背包里组件实例的「改词条」替换
 *   · 后台「账号管理」：存档策略条 + 每行「存档/回档」列表 + 两步确认回档
 * 运行： node tests/v0162-ui.test.js（需要 CHROME_PATH 或本机 Chrome/Edge）
 * 说明：FISHING_DATA_DIR 指向临时数据目录，不触碰真实存档；FISHING_DEV=1 开发接口。
 */
'use strict';
const { chromium } = require('playwright-core');
const { clickAppNav } = require('./_nav.js');
const { spawn, spawnSync } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { waitHttp } = require('./_util.js');

const ROOT = path.join(__dirname, '..');
const PORT = 8264;
const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'fishing-v0162ui-test-'));
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
      rs.on('end', () => { let j = null; try { d && (j = JSON.parse(d)); } catch (e) {} res({ status: rs.statusCode, data: j }); });
    });
    r.on('error', () => res({ status: 0 }));
    if (data) r.write(data);
    r.end();
  });
}
const GET = p => req('GET', p), POST = (p, b) => req('POST', p, b);

// 主件带钓速（speed）、副件带技巧（skill）：熔炼两条词条各选一条
const MAIN = 'reel_electric#common#spd+25';
const SUB = 'reel_electric#common#skl+3';
const MYTHIC = 'reel_electric#mythic#spd+25,skl+3';   // 只有神话件能重铸

// 组件选择子页面：挑第一张**可操作**的卡片（列表里主件那张是「已被占用(disabled)」），
// 可按卡片文案再收敛（本用例用词条区分两件同名底材：主件带钓速、副件带技巧）
async function pickCard(page, want) {
  return await page.evaluate(function (w) {
    const cards = Array.from(document.querySelectorAll('.bec-card'));
    const pickBtnOf = function (c) {
      return Array.from(c.querySelectorAll('.bec-acts button')).find(function (b) { return !b.disabled; });
    };
    const list = w ? cards.filter(function (c) { return new RegExp(w).test(c.textContent); }) : cards;
    const card = (list.length ? list : cards).find(pickBtnOf);
    if (!card) return '';
    const b = pickBtnOf(card);
    b.click();
    return card.textContent.trim().slice(0, 30);
  }, want || '');
}
async function clickNav(page, name) {
  const target = await clickAppNav(page, name);
  await until(() => page.evaluate(n => Array.from(document.querySelectorAll('.nav-item')).some(x => x.textContent.includes(n)), target.nav), v => v === true, 30000);
}

let srv = null, browser = null;
async function main() {
  srv = spawn(process.execPath, ['backend/server.js'], { cwd: ROOT,
    env: Object.assign({}, process.env, { PORT: String(PORT), FISHING_DEV: '1', FISHING_DATA_DIR: TMP_DATA }) });
  await waitHttp('http://localhost:' + PORT + '/shop', { timeout: 20000 });

  const rA = await POST('/api/register', { username: 'v162ui_a', password: 'abcd1234', name: '界面甲', qq: '43101' });
  const tok = rA.data.token;
  const adm = await POST('/api/admin/login', { username: 'v162ui_a', password: 'abcd1234' });
  const AT = adm.data && adm.data.token;
  check('账号与管理员就绪', !!tok && !!AT);

  // 前置：主/副件各一件（同部位）+ 一件神话件（重铸用）+ 几种催化材料（补缀用）
  await POST('/api/dev/seed', { token: tok, coins: 500000, inventory: {} });
  for (const id of [MAIN, SUB, MYTHIC]) await POST('/api/dev/catch', { token: tok, item: { kind: 'component', id: id } });
  for (const id of ['rope', 'bait_pack', 'dragon_scale']) await POST('/api/dev/catch', { token: tok, item: { id: id } });
  const inv = (await GET('/api/me?token=' + tok)).data.inventory || {};
  check('前置：三件组件 + 三种材料就绪', !!(inv[MAIN] && inv[SUB] && inv[MYTHIC] && inv.rope), JSON.stringify(Object.keys(inv)));
  // 先留一份快照（金币 500000）：回档那一段要拿它当回档目标
  const snap0 = await POST('/api/admin/users/snapshot-now', { token: AT, target: 'v162ui_a' });
  check('前置：先存一份快照供回档用', snap0.status === 200 && snap0.data.count === 1, JSON.stringify(snap0.data));

  browser = await chromium.launch({ executablePath: CHROME, args: ['--disable-gpu'] });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 950 } });
  const errs = [];
  const pErr = e => e.message + ' @ ' + (String(e.stack || '').split('\n')[1] || '').trim();
  const p1 = await ctx.newPage();
  p1.on('pageerror', e => errs.push('player ' + pErr(e)));
  await p1.goto('http://localhost:' + PORT + '/', { waitUntil: 'load' });
  await p1.evaluate(t => localStorage.setItem('fishing_token', t), tok);
  await p1.reload({ waitUntil: 'load' });
  await sleep(800);
  await until(() => p1.evaluate(() => !!window.Engine && !!window.Engine.state.me), v => v === true, 30000);

  // ---------------- 熔炼：逐条词缀概率 + 完全成功概率 ----------------
  section('熔炼页：每条词缀后的落成概率 + 高亮的完全成功概率');
  await clickNav(p1, '工坊');
  // _nav.js 进「工坊」会顺带点「开箱」页签，这里显式切回「熔炼」
  await until(() => p1.evaluate(() => !!document.querySelector('[data-wstab="smelt"]')), v => v === true, 20000);
  await p1.evaluate(() => { const b = document.querySelector('[data-wstab="smelt"]'); if (b) b.click(); });
  await until(() => p1.evaluate(() => !!document.querySelector('.ws-pick[data-pick="main"]')), v => v === true, 20000);
  // 主件：选择器里挑卷线器（按底材名）
  await p1.click('.ws-pick[data-pick="main"]');
  await until(() => p1.evaluate(() => !!document.querySelector('.bec-card')), v => v === true, 15000);
  const mainPicked = await pickCard(p1, '钓速');
  check('主件选中带钓速的那件', !!mainPicked, mainPicked);
  await until(() => p1.evaluate(() => !!document.querySelector('.ws-pick.chosen[data-pick="main"]')), v => v === true, 10000);
  await p1.click('.ws-pick[data-pick="sub"]');
  await until(() => p1.evaluate(() => !!document.querySelector('.bec-card')), v => v === true, 15000);
  const subPicked = await pickCard(p1, '技巧');
  check('副件选中带技巧的那件（同部位）', !!subPicked, subPicked);
  await until(() => p1.evaluate(() => !!document.querySelector('.ws-pick.chosen[data-pick="sub"]')), v => v === true, 10000);
  // 各选一条词条：主件钓速、副件技巧
  await p1.click('.ws-aff[data-which="main"][data-type="speed"]');
  await p1.click('.ws-aff[data-which="sub"][data-type="skill"]');
  await until(() => p1.evaluate(() => !!document.querySelector('.ws-full-prob')), v => v === true, 10000);
  const smelt = await p1.evaluate(() => {
    const rateLine = Array.from(document.querySelectorAll('.ws-preview .ws-line'))
      .find(x => /熔炼成功率/.test(x.textContent || ''));
    const rate = rateLine ? Number((/熔炼成功率\s*([\d.]+)%/.exec(rateLine.textContent) || [])[1]) : NaN;
    const full = document.querySelector('.ws-full-prob');
    return {
      rate: rate,
      fullText: full ? full.textContent.trim() : null,
      fullCss: full ? getComputedStyle(full).fontSize : '',
      fullColor: full ? getComputedStyle(full).color : '',
      rows: Array.from(document.querySelectorAll('.ws-res-affs li')).map(li => ({
        text: (li.textContent || '').trim().slice(0, 60),
        prob: (li.querySelector('.ws-aff-prob') || {}).textContent || null,
      })),
      hasUnload: document.querySelectorAll('.ws-unload').length,
    };
  });
  check('汇总区出现「完全成功概率」高亮块', /^\d+(\.\d+)?%$/.test(smelt.fullText || ''), JSON.stringify(smelt.fullText));
  check('完全成功概率 = 熔炼成功率（无补缀时）', smelt.fullText === smelt.rate + '%', JSON.stringify({ full: smelt.fullText, rate: smelt.rate }));
  check('完全成功概率有明显高亮（更大字号 + 强调色）',
    parseFloat(smelt.fullCss) >= 15 && smelt.fullColor !== 'rgb(0, 0, 0)', JSON.stringify({ size: smelt.fullCss, color: smelt.fullColor }));
  check('保留 / 副件搬入两条词缀后面各带一个概率标签',
    smelt.rows.length >= 2 && /保留/.test(smelt.rows[0].text) && /成 \d/.test(smelt.rows[0].prob || '') &&
    /副件搬入/.test(smelt.rows[1].text) && /成 \d/.test(smelt.rows[1].prob || ''),
    JSON.stringify(smelt.rows));
  check('两处概率标签都等于熔炼成功率', smelt.rows[0].prob === '成 ' + smelt.rate + '%' && smelt.rows[1].prob === '成 ' + smelt.rate + '%',
    JSON.stringify({ p0: smelt.rows[0].prob, p1: smelt.rows[1].prob, rate: smelt.rate }));
  check('熔炼槽位有「卸下」按钮（主件 / 副件各一个）', smelt.hasUnload >= 2, String(smelt.hasUnload));
  // 排版：概率标签与「词条 n / 池长」都该贴着左边的文字，不能被顶到行尾（v0.16.2 修正）
  const hugging = await p1.evaluate(() => {
    const li = document.querySelector('.ws-res-affs li');
    const chip = document.querySelector('.ws-res-affs .ws-aff-prob');
    const card = document.querySelector('.ws-result-card');
    const nums = document.querySelector('.ws-result-nums');
    const gapOf = (outer, inner) => (outer && inner) ? Math.round(outer.getBoundingClientRect().right - inner.getBoundingClientRect().right) : null;
    return { chipTail: gapOf(li, chip), numsTail: gapOf(card, nums), chipLeft: chip ? Math.round(chip.getBoundingClientRect().left) : null, liLeft: li ? Math.round(li.getBoundingClientRect().left) : null };
  });
  check('每条词缀的概率标签贴着左边文字（没被推到行尾）',
    hugging.chipTail != null && hugging.chipTail >= 60, JSON.stringify(hugging));
  check('结果卡的「词条 n / 池长」也贴着底材名（没被推到卡最右）',
    hugging.numsTail != null && hugging.numsTail >= 60, JSON.stringify(hugging));

  // 补缀：投一份材料 → 补缀新增那条的概率 = 熔炼 × 补缀，完全成功跟着变
  // 材料行按规则过滤（补不了的那些加 .hide），持有为 0 的输入框是 disabled —— 只挑真正投得进去的那一行
  const fed = await p1.evaluate(() => {
    const inp = document.querySelector('.ws-mat:not(.hide) .ws-mat-qty:not([disabled])');
    if (!inp) return '';
    inp.value = '1';
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    return inp.getAttribute('data-mat');
  });
  check('投得进一份催化剂', !!fed, String(fed));
  await until(() => p1.evaluate(() => Array.from(document.querySelectorAll('.ws-preview .ws-line')).some(x => /补缀：/.test(x.textContent || ''))), v => v === true, 10000);
  const withExtra = await p1.evaluate(() => {
    const full = document.querySelector('.ws-full-prob');
    const add = Array.from(document.querySelectorAll('.ws-res-affs li')).find(li => /补缀新增/.test(li.textContent || ''));
    const rateLine = Array.from(document.querySelectorAll('.ws-preview .ws-line')).find(x => /熔炼成功率/.test(x.textContent || ''));
    const extraLine = Array.from(document.querySelectorAll('.ws-preview .ws-line')).find(x => /补缀：/.test(x.textContent || ''));
    return {
      full: full ? full.textContent.trim() : null,
      rate: rateLine ? Number((/熔炼成功率\s*([\d.]+)%/.exec(rateLine.textContent) || [])[1]) : NaN,
      extra: extraLine ? Number((/成功率\s*([\d.]+)%/.exec(extraLine.textContent) || [])[1]) : NaN,
      addProb: add ? ((add.querySelector('.ws-aff-prob') || {}).textContent || null) : null,
      addText: add ? (add.textContent || '').trim().slice(0, 50) : null,
    };
  });
  const expectFull = Math.round(withExtra.rate * withExtra.extra / 100 * 10) / 10;
  check('投料后补缀行出现且带成功率', withExtra.extra > 0, JSON.stringify(withExtra));
  check('补缀新增那条词缀的概率 = 熔炼 × 补缀', withExtra.addProb === '成 ' + expectFull + '%',
    JSON.stringify({ got: withExtra.addProb, want: expectFull, rate: withExtra.rate, extra: withExtra.extra }));
  check('完全成功概率随之变成「乘积」（不再是熔炼成功率）', withExtra.full === expectFull + '%',
    JSON.stringify({ full: withExtra.full, want: expectFull + '%' }));

  // ---------------- 熔炼「卸下」 ----------------
  section('熔炼槽位：卸下清空（主件连带副件与已选词条）');
  await p1.click('.ws-unload[data-unload="main"]');
  await until(() => p1.evaluate(() => !!document.querySelector('.ws-pick.empty[data-pick="main"]')), v => v === true, 10000);
  const afterUnload = await p1.evaluate(() => ({
    mainEmpty: !!document.querySelector('.ws-pick.empty[data-pick="main"]'),
    subEmpty: !!document.querySelector('.ws-pick.empty[data-pick="sub"]'),
    full: !!document.querySelector('.ws-full-prob'),
  }));
  check('主件被卸下（回到「点击选择组件」）', afterUnload.mainEmpty === true, JSON.stringify(afterUnload));
  check('副件与已选词条一并清掉', afterUnload.subEmpty === true && afterUnload.full === false, JSON.stringify(afterUnload));

  // ---------------- 重铸「卸下」 ----------------
  section('重铸槽位：卸下清空待重铸组件');
  await p1.evaluate(() => { const b = document.querySelector('[data-wstab="recast"]'); if (b) b.click(); });
  await until(() => p1.evaluate(() => !!document.querySelector('.ws-pick[data-recast-pick]')), v => v === true, 15000);
  await p1.click('.ws-pick[data-recast-pick]');
  await until(() => p1.evaluate(() => !!document.querySelector('.bd-equip-modal .bec-card')), v => v === true, 15000);
  await pickCard(p1, "");
  await until(() => p1.evaluate(() => !!document.querySelector('.ws-pick.chosen[data-recast-pick]')), v => v === true, 10000);
  const recastSlot = await p1.evaluate(() => ({
    chosen: !!document.querySelector('.ws-pick.chosen[data-recast-pick]'),
    unload: !!document.querySelector('.ws-unload[data-unload="recast"]'),
    affixRows: document.querySelectorAll('.rc-pick').length,
  }));
  check('重铸槽位有「卸下」按钮，且列出了可指定的词条', recastSlot.chosen && recastSlot.unload && recastSlot.affixRows >= 2, JSON.stringify(recastSlot));
  await p1.click('.ws-unload[data-unload="recast"]');
  await until(() => p1.evaluate(() => !!document.querySelector('.ws-pick.empty[data-recast-pick]')), v => v === true, 10000);
  check('点「卸下」后回到空槽（待重铸组件已清空）',
    await p1.evaluate(() => !!document.querySelector('.ws-pick.empty[data-recast-pick]')));

  // ---------------- 后台：资产快照（全部物品 + 搜索 + 改词条） ----------------
  section('后台资产快照：全部物品 / 物品搜索 / 组件改词条');
  const pa = await ctx.newPage();
  pa.on('pageerror', e => errs.push('admin ' + pErr(e)));
  await pa.goto('http://localhost:' + PORT + '/admin.html', { waitUntil: 'load' });
  await pa.evaluate(t => localStorage.setItem('fishing_admin_token', t), AT);
  await pa.reload({ waitUntil: 'load' });
  await until(() => pa.evaluate(() => !!document.querySelector('.nav-item')), v => v === true, 15000);
  await clickNav(pa, '账号管理');
  await until(() => pa.evaluate(() => !!document.querySelector('#snap-cfg-row')), v => v === true, 15000);
  // 策略值来自 /api/admin/world（异步），等回显完再断言
  await until(() => pa.evaluate(() => /当前/.test((document.getElementById('snap-cfg-state') || {}).textContent || '')), v => v === true, 15000);
  const cfgRow = await pa.evaluate(() => ({
    on: !!document.querySelector('#snap-cfg-on'),
    min: (document.querySelector('#snap-cfg-min') || {}).value,
    keep: (document.querySelector('#snap-cfg-keep') || {}).value,
    state: (document.querySelector('#snap-cfg-state') || {}).textContent || '',
  }));
  check('账号管理页有存档策略条（间隔 / 保留份数回显）', cfgRow.on && Number(cfgRow.min) > 0 && Number(cfgRow.keep) > 0, JSON.stringify(cfgRow));
  await until(() => pa.evaluate(() => !!document.querySelector('[data-snap="v162ui_a"]')), v => v === true, 15000);
  await pa.evaluate(() => { const b = document.querySelector('[data-snap="v162ui_a"]'); if (b) b.click(); });
  await until(() => pa.evaluate(() => !!document.querySelector('#snap-add-id')), v => v === true, 15000);
  const snapUi = await pa.evaluate(() => {
    const sel = document.getElementById('snap-add-id');
    if (!sel) return null;
    return {
      groups: Array.from(sel.querySelectorAll('optgroup')).map(g => g.label),
      opts: sel.querySelectorAll('option').length,
      hasSearch: !!document.getElementById('snap-add-search'),
      editBtns: document.querySelectorAll('[data-itemedit]').length,
    };
  });
  check('新增物品分组覆盖全部物品（含宝匣）', !!snapUi && snapUi.groups.join(',') === '鱼,材料,宝匣,组件（底材）', JSON.stringify(snapUi && snapUi.groups));
  check('新增物品带搜索框', !!snapUi && snapUi.hasSearch === true);
  // 排版：弹窗必须限高（不超出屏幕）+ 内部可滚动 + 宽屏两栏并排 + 底部操作栏始终在视口内
  const layout = await pa.evaluate(() => {
    const modal = document.querySelector('.snap-modal');
    const cols = Array.from(document.querySelectorAll('.snap-cols .snap-col'));
    const box = document.querySelector('.snap-cols');
    const acts = document.querySelector('.snap-actions');
    const r = modal ? modal.getBoundingClientRect() : null;
    const a = acts ? acts.getBoundingClientRect() : null;
    return {
      modalH: r ? Math.round(r.height) : null,
      vh: window.innerHeight,
      cols: cols.length,
      sideBySide: cols.length === 2 && Math.abs(cols[0].getBoundingClientRect().top - cols[1].getBoundingClientRect().top) < 4 &&
        cols[1].getBoundingClientRect().left > cols[0].getBoundingClientRect().left + 100,
      scrollable: box ? getComputedStyle(box).overflowY : '',
      bodyScroll: box ? box.scrollHeight > box.clientHeight + 4 : false,
      waitCloseY: box ? cols[1].getBoundingClientRect().top : null,
      actsVisible: !!a && a.bottom <= window.innerHeight + 1 && a.top >= 0,
    };
  });
  check('资产快照弹窗不超出屏幕（高度 ≤ 视口）', layout.modalH != null && layout.modalH <= layout.vh, JSON.stringify({ h: layout.modalH, vh: layout.vh }));
  check('弹窗内容区可上下滚动', layout.scrollable === 'auto', JSON.stringify({ overflowY: layout.scrollable }));
  check('宽屏把功能摆成两栏（背包 / 新增与定制）', layout.sideBySide === true, JSON.stringify({ cols: layout.cols, side: layout.sideBySide }));
  check('底部「保存快照」操作栏始终在视口内可见', layout.actsVisible === true, JSON.stringify(layout));
  // 搜索过滤
  const filtered = await pa.evaluate(() => {
    const s = document.getElementById('snap-add-search');
    s.value = '龙宫宝珠';
    s.dispatchEvent(new Event('input', { bubbles: true }));
    const sel = document.getElementById('snap-add-id');
    return { opts: sel.querySelectorAll('option').length, first: (sel.querySelector('option') || {}).textContent || '' };
  });
  check('搜索「龙宫宝珠」把下拉收敛到命中的物品', !!snapUi && filtered.opts > 0 && filtered.opts < snapUi.opts && /龙宫宝珠/.test(filtered.first),
    JSON.stringify({ before: snapUi && snapUi.opts, after: filtered.opts, first: filtered.first }));
  const cleared = await pa.evaluate(() => {
    const s = document.getElementById('snap-add-search');
    s.value = '';
    s.dispatchEvent(new Event('input', { bubbles: true }));
    return document.getElementById('snap-add-id').querySelectorAll('option').length;
  });
  check('清空搜索后选项恢复', cleared === snapUi.opts, JSON.stringify({ after: cleared, before: snapUi.opts }));
  check('背包里的组件实例带「改词条」按钮', snapUi.editBtns >= 1, String(snapUi.editBtns));
  // 改词条：载入 → 改品质 → 应用修改（替换原件）
  const beforeEdit = await pa.evaluate(() => document.querySelector('#snap-inv [data-itemedit]').getAttribute('data-itemedit'));
  await pa.evaluate(() => { const b = document.querySelector('#snap-inv [data-itemedit]'); if (b) b.click(); });
  await until(() => pa.evaluate(() => /正在修改/.test((document.getElementById('cus-edit-hint') || {}).textContent || '')), v => v === true, 8000);
  const editMode = await pa.evaluate(() => ({
    hint: (document.getElementById('cus-edit-hint') || {}).textContent || '',
    btn: (document.getElementById('cus-add') || {}).textContent || '',
    q: (document.getElementById('cus-quality') || {}).value,
    affs: document.querySelectorAll('#cus-affixes .cus-aff').length,
  }));
  check('「改词条」把该实例载入定制配件区（品质与词条都是现值）',
    /应用修改/.test(editMode.btn) && /正在修改/.test(editMode.hint) && editMode.affs >= 1, JSON.stringify(editMode));
  await pa.evaluate(() => {
    const q = document.getElementById('cus-quality');
    q.value = 'rare';
    q.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await pa.evaluate(() => { const b = document.getElementById('cus-qty'); if (b) b.value = '2'; });
  await pa.evaluate(() => { const b = document.getElementById('cus-add'); if (b) b.click(); });
  await until(() => pa.evaluate(() => !!document.querySelector('#snap-inv [data-inv="' + MAIN.replace('common', 'rare') + '"]')), v => v === true, 8000);
  const afterEdit = await pa.evaluate((oldId) => {
    const oldInp = document.querySelector('#snap-inv [data-inv="' + oldId + '"]');
    const newInp = document.querySelector('#snap-inv [data-inv="' + oldId.replace('#common#', '#rare#') + '"]');
    return {
      oldQty: oldInp ? Number(oldInp.value) : null,
      newQty: newInp ? Number(newInp.value) : null,
      editing: /正在修改/.test((document.getElementById('cus-edit-hint') || {}).textContent || ''),
    };
  }, MAIN);
  check('应用修改后：原件记 0 件、新品质的实例进了草稿', afterEdit.oldQty === 0 && afterEdit.newQty === 2, JSON.stringify(afterEdit));
  check('应用后退出改词条模式', afterEdit.editing === false);
  // 保存快照 → 服务端真的换了 id
  await pa.evaluate(() => { const b = document.getElementById('snap-save'); if (b) b.click(); });
  await until(async () => !(await pa.evaluate(() => !!document.querySelector('#snap-inv'))), v => v === true, 10000);
  const invAfter = (await GET('/api/me?token=' + tok)).data.inventory || {};
  const newId = MAIN.replace('#common#', '#rare#');
  check('保存后服务端背包里是新品质的实例（词条与数量跟着走）',
    !invAfter[MAIN] && invAfter[newId] === 2, JSON.stringify(Object.keys(invAfter).filter(k => /reel_electric/.test(k))));

  // ---------------- 后台：存档回档 ----------------
  section('后台存档回档：列表 + 两步确认');
  await pa.evaluate(() => { const b = document.querySelector('[data-snaps="v162ui_a"]'); if (b) b.click(); });
  await until(() => pa.evaluate(() => !!document.querySelector('#roll-list')), v => v === true, 15000);
  const rollUi = await pa.evaluate(() => ({
    rows: document.querySelectorAll('#roll-list .snap-line').length,
    firstText: (document.querySelector('#roll-list .snap-line') || {}).textContent || '',
    hasNow: !!document.getElementById('roll-now'),
  }));
  check('回档弹窗列出该账号的历史快照（带金币 / 件数）',
    rollUi.rows >= 1 && /💰/.test(rollUi.firstText) && /件/.test(rollUi.firstText), JSON.stringify(rollUi));
  check('弹窗里有「立即为这个账号存一份」', rollUi.hasNow === true);
  // 先改掉资产，再回档 → 应回到快照时点
  await POST('/api/admin/users/snapshot', { token: AT, target: 'v162ui_a', coins: 777 });
  const coinsBefore = (await GET('/api/me?token=' + tok)).data.coins;
  check('前置：金币已被改成 777', coinsBefore === 777, String(coinsBefore));
  await pa.evaluate(() => { const b = document.querySelector('#roll-list .snap-line [data-roll]'); if (b) b.click(); });
  await until(() => pa.evaluate(() => !!document.querySelector('#roll-list [data-roll-go]')), v => v === true, 8000);
  check('点「回档到这份」先出确认（不直接执行）', await pa.evaluate(() => !!document.querySelector('#roll-list [data-roll-go]')));
  check('确认前服务端资产未变', (await GET('/api/me?token=' + tok)).data.coins === 777);
  await pa.evaluate(() => { const b = document.querySelector('#roll-list [data-roll-go]'); if (b) b.click(); });
  await until(async () => ((await GET('/api/me?token=' + tok)).data.coins || 0) !== 777, v => v === true, 15000);
  const coinsAfter = (await GET('/api/me?token=' + tok)).data.coins;
  check('确认后真的回档（金币回到快照时点 500000）', coinsAfter === 500000, String(coinsAfter));

  check('玩家与后台页面都没有 JS 报错', errs.length === 0, errs.join(' | '));

  await browser.close();
  killTree(srv);
  await sleep(300);
  console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  if (failed.length) console.log('失败明细：\n' + failed.map(x => '  - ' + x).join('\n'));
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error(e); try { killTree(srv); } catch (x) {} process.exit(1); });

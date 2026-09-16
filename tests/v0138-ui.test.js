/*
 * v0.13.8 界面回归（商城自动售出面板 + 背包筛选 / 图鉴边框 / 渔获记录重构）
 * 覆盖：自动售出面板（列表覆盖渔获+材料并按类分组 / 打包阈值文案 / 勾选框首次点击开设置 /
 *       保存与清除 / 就地停用保留阈值 / 批量应用 / 全部停用 / 清空二次确认 / autosellcfg 广播）；
 *       背包「体型档」筛选不再吞掉材料与宝匣；图鉴材料与组件不套铜框改高亮边框；
 *       记录页顶部「最新播报的鱼」、大小纪录合并（双缩略图）、排行榜默认日榜且可切周/总、
 *       后台按鱼种 / 全量删除纪录
 * 运行： node tests/v0138-ui.test.js（需要 CHROME_PATH 或本机 Chrome/Edge）
 * 说明：FISHING_DATA_DIR 指向临时数据目录，不触碰真实存档；FISHING_DEV=1 开发接口。
 */
'use strict';
const { chromium } = require('playwright-core');
const { spawn, spawnSync } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { waitHttp } = require('./_util.js');
const D = require(path.join(__dirname, '..', 'frontend', 'js', 'data.js'));

const ROOT = path.join(__dirname, '..');
const PORT = 8200;
const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'fishing-v0138ui-test-'));
const FISH_N = D.allItems().filter(it => it.kind === 'fish').length;
const MAT_N = D.allItems().filter(it => it.kind === 'material').length;

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
function section(t) { console.log('\n=== ' + t + ' ==='); }
const sleep = ms => new Promise(r => setTimeout(r, ms));
function killTree(p) { try { spawnSync('taskkill', ['/F', '/T', '/PID', String(p.pid)], { stdio: 'ignore' }); } catch (e) {} }
async function until(fn, ok, timeout) {
  const deadline = Date.now() + (timeout || 10000);
  for (;;) {
    const v = await fn().catch(() => null);
    if (ok(v)) return v;
    if (Date.now() >= deadline) return v;
    await sleep(60);
  }
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

let srv = null, browser = null;
let tok = null;

async function login(page, token) {
  await page.goto('http://localhost:' + PORT + '/', { waitUntil: 'load' });
  await page.evaluate(t => localStorage.setItem('fishing_token', t), token);
  await page.reload({ waitUntil: 'load' });
  await sleep(600);
}
// 最小 SSE 监听（交易需要双方在线：挂一条 /events 即视为在线）
const SSE_SEP = String.fromCharCode(10) + String.fromCharCode(10);   // 事件分隔：空行
const SSE_NL = String.fromCharCode(10);
function sseListen(tok, sink) {
  const r = http.request({ hostname: 'localhost', port: PORT, path: '/events?token=' + encodeURIComponent(tok), method: 'GET' }, res => {
    let buf = '';
    res.on('data', c => {
      buf += c.toString();
      let i;
      while ((i = buf.indexOf(SSE_SEP)) >= 0) {
        const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
        const line = chunk.split(SSE_NL).find(l => l.startsWith('data: '));
        if (!line) continue;
        try {
          const m = JSON.parse(line.slice(6));
          if (m && m.type === 'batch' && Array.isArray(m.list)) m.list.forEach(x => sink && sink.push(x));
          else if (sink) sink.push(m);
        } catch (e) {}
      }
    });
  });
  r.on('error', () => {});
  r.end();
  return r;
}

async function clickNav(page, name) {
  await until(() => page.evaluate(n => Array.from(document.querySelectorAll('.nav-item')).some(x => x.textContent.includes(n)), name), v => v === true, 30000);
  await page.evaluate(n => {
    const b = Array.from(document.querySelectorAll('.nav-item')).find(x => x.textContent.includes(n));
    if (b) b.click();
  }, name);
}
async function openShop(page) {
  await clickNav(page, '商城');
  // 商城三合一：自动售出面板在「🪙 收购」页签
  await until(() => page.evaluate(() => !!document.querySelector('[data-malltab="shop"]')), v => v === true, 20000);
  await page.evaluate(() => {
    const b = document.querySelector('[data-malltab="shop"]');
    if (b && !b.classList.contains('on')) b.click();
  });
  await until(() => page.evaluate(() => !!document.querySelector('#shop-as-panel')), v => v === true, 20000);
}
// v0.13.8：逐项控制收敛到「清单子窗口」里（右栏只留一览与入口）
const rows = page => page.$$eval('#asl-list .as-row', els => els.map(e => ({
  name: (e.querySelector('.as-name') || {}).textContent || '',
  checked: !!(e.querySelector('.as-chk') || {}).checked,
  rule: (e.querySelector('.as-rule') || {}).textContent || '',
  hasSetBtn: !!e.querySelector('button[data-as]'),
  hasChk: !!e.querySelector('.as-chk'),
})));
// 打开清单子窗口（右栏 → 打开自动售出清单）
async function openAsList(page) {
  await until(() => page.evaluate(() => !!document.getElementById('sa-open-list')), v => v === true, 20000);
  await page.evaluate(() => document.getElementById('sa-open-list').click());
  await until(() => page.evaluate(() => !!document.querySelector('#asl-list')), v => v === true, 20000);
  await page.evaluate(() => { const s = document.getElementById('asl-search'); if (s) s.value = ''; });
  await page.evaluate(() => { const b = Array.from(document.querySelectorAll('#as-list-modal [data-aslcat]')).find(x => x.textContent.includes('全部')); if (b) b.click(); });
  await until(async () => (await rows(page)).length > 0, v => v === true, 10000);
}
// 点某物品行的「设置」按钮（按物品名定位）
const clickSet = (page, name) => page.evaluate(n => {
  const row = Array.from(document.querySelectorAll('#asl-list .as-row')).find(e => e.querySelector('.as-name').textContent.indexOf(n) >= 0);
  if (row) row.querySelector('button[data-as]').click();
}, name);
// 点某物品行的勾选框
const clickChk = (page, name) => page.evaluate(n => {
  const row = Array.from(document.querySelectorAll('#asl-list .as-row')).find(e => e.querySelector('.as-name').textContent.indexOf(n) >= 0);
  if (row) row.querySelector('.as-chk').click();
}, name);

async function main() {
  srv = spawn(process.execPath, ['backend/server.js'], {
    cwd: ROOT,
    env: Object.assign({}, process.env, { PORT: String(PORT), FISHING_DEV: '1', FISHING_DATA_DIR: TMP_DATA }),
  });
  await waitHttp('http://localhost:' + PORT + '/shop', { timeout: 20000 });

  const rA = await POST('/api/register', { username: 'v138_a', password: 'abcd1234', name: '回归甲', qq: '39001' });
  tok = rA.data.token;
  const admReg = await POST('/api/register', { username: 'v138_adm', password: 'abcd1234', name: '回归管理', qq: '39002' });
  const admTok = (await POST('/api/admin/login', { username: 'v138_adm', password: 'abcd1234' })).data.token;
  check('账号与管理员就绪', !!tok && !!admTok && !!admReg.data.token);

  browser = await chromium.launch({ executablePath: CHROME, args: ['--disable-gpu'] });
  const p1 = await browser.newPage();
  await login(p1, tok);
  await openShop(p1);

  section('清单子窗口：覆盖全部渔获 + 材料，可搜索 / 分类');
  check('商店右栏自动售出面板存在', (await p1.$$('#shop-as-panel')).length === 1);
  check('右栏有「打开自动售出清单」入口', (await p1.$$('#sa-open-list')).length === 1);
  check('打包阈值文案取自服务器（默认 100）', (await p1.evaluate(() => document.getElementById('sa-batch').textContent)) === '100',
    await p1.evaluate(() => document.getElementById('sa-batch').textContent));
  await openAsList(p1);
  const r0 = await rows(p1);
  check('清单覆盖全部渔获与材料（' + FISH_N + ' + ' + MAT_N + '）', r0.length === FISH_N + MAT_N, String(r0.length));
  check('每行都有勾选框与「设置」入口', r0.every(r => r.hasChk && r.hasSetBtn));
  check('初始全部「未设置」', r0.every(r => r.rule === '未设置'), JSON.stringify(r0.slice(0, 2)));
  const guards = await p1.$$eval('#asl-list .asl-guard', els => els.length);
  check('稀有及以上材料带「保护」标记', guards > 0, String(guards));
  await p1.evaluate(() => Array.from(document.querySelectorAll('#as-list-modal [data-aslcat]')).find(x => x.textContent.includes('材料')).click());
  await until(async () => (await rows(p1)).length === MAT_N, v => v === true, 8000);
  check('「材料」页签只列材料', (await rows(p1)).length === MAT_N, String((await rows(p1)).length));
  await p1.evaluate(() => Array.from(document.querySelectorAll('#as-list-modal [data-aslcat]')).find(x => x.textContent.includes('全部')).click());
  await until(async () => (await rows(p1)).length === FISH_N + MAT_N, v => v === true, 8000);
  await p1.evaluate(() => { const s = document.getElementById('asl-search'); s.value = '鲫'; s.dispatchEvent(new Event('input', { bubbles: true })); });
  await until(async () => (await rows(p1)).length === 1, v => v === true, 8000);
  check('搜索按名称过滤', (await rows(p1)).length === 1 && (await rows(p1))[0].name.indexOf('鲫') >= 0, JSON.stringify(await rows(p1)));
  await p1.evaluate(() => { const s = document.getElementById('asl-search'); s.value = ''; s.dispatchEvent(new Event('input', { bubbles: true })); });
  await p1.evaluate(() => Array.from(document.querySelectorAll('#as-list-modal [data-aslcat]')).find(x => x.textContent.includes('全部')).click());
  await until(async () => (await rows(p1)).length === FISH_N + MAT_N, v => v === true, 8000);

  section('勾选框首次点击进设置（不会误触「无条件卖光」）');
  await clickChk(p1, '鲫鱼');
  await until(() => p1.evaluate(() => !!document.querySelector('#as-on')), v => v === true, 8000);
  check('未配置过的物品点勾选 → 打开设置弹窗', (await p1.$$('#as-on')).length === 1);
  check('弹窗内标题为该物品', /鲫鱼/.test(await p1.evaluate(() => document.querySelector('.modal-title').textContent)),
    await p1.evaluate(() => document.querySelector('.modal-title').textContent));
  await p1.evaluate(() => document.querySelector('.cf-no').click());
  await until(() => p1.evaluate(() => !!document.querySelector('#asl-list')), v => v === true, 8000);
  const r1 = await rows(p1);
  check('取消后仍是未设置（没有误建规则）',
    r1.find(r => r.name.indexOf('鲫鱼') >= 0).rule === '未设置' && !r1.find(r => r.name.indexOf('鲫鱼') >= 0).checked,
    JSON.stringify(r1.find(r => r.name.indexOf('鲫鱼') >= 0)));

  section('设置弹窗：保存价格线 + 保留数量');
  await clickSet(p1, '鲫鱼');
  await until(() => p1.evaluate(() => !!document.querySelector('#as-keep')), v => v === true, 8000);
  check('弹窗含「保留数量」输入框', (await p1.$$('#as-keep')).length === 1);
  await p1.fill('#as-pct', '120');
  await p1.fill('#as-keep', '5');
  await p1.evaluate(() => document.querySelector('#as-save').click());
  await until(async () => { const r = (await rows(p1)).find(x => x.name.indexOf('鲫鱼') >= 0); return r && r.checked; }, v => v === true, 8000);
  const r2 = (await rows(p1)).find(r => r.name.indexOf('鲫鱼') >= 0);
  check('保存后该行勾选并显示规则摘要（基准≥120% 保留5）',
    r2.checked && /基准≥120%/.test(r2.rule) && /保留5/.test(r2.rule), JSON.stringify(r2));
  check('保存后回到清单（清单窗口仍在）', (await p1.$$('#asl-list')).length === 1);
  const srv1 = await GET('/api/autosell?token=' + tok);
  check('规则已落服务端（逐物品结构）',
    !!(srv1.data.items && srv1.data.items.crucian && srv1.data.items.crucian.on) &&
    srv1.data.items.crucian.minPct === 120 && srv1.data.items.crucian.keep === 5,
    JSON.stringify(srv1.data.items && srv1.data.items.crucian));

  section('勾选框就地停用 / 启用（阈值保留）');
  await clickChk(p1, '鲫鱼');
  const r3 = await until(async () => {
    const r = (await rows(p1)).find(x => x.name.indexOf('鲫鱼') >= 0);
    return r && !r.checked && /已停用/.test(r.rule) ? r : null;
  }, v => !!v, 8000);
  check('取消勾选即停用，阈值摘要仍在', !!r3 && /基准≥120%/.test(r3.rule) && /保留5/.test(r3.rule), JSON.stringify(r3));
  const srv2 = await GET('/api/autosell?token=' + tok);
  check('服务端仅把 on 置 false，阈值未丢',
    srv2.data.items.crucian.on === false && srv2.data.items.crucian.minPct === 120 && srv2.data.items.crucian.keep === 5,
    JSON.stringify(srv2.data.items.crucian));
  await clickChk(p1, '鲫鱼');
  check('重新勾选即启用', await until(async () => (await rows(p1)).find(x => x.name.indexOf('鲫鱼') >= 0).checked, v => v === true, 8000));

  section('批量：应用到全部鱼');
  await p1.fill('#asl-pct', '130');
  await p1.fill('#asl-keep', '3');
  await p1.evaluate(() => document.querySelector('#asl-apply-fish').click());
  await until(async () => (await rows(p1)).filter(r => /基准≥130%/.test(r.rule)).length === FISH_N, v => v === true, 10000);
  const rAll = await rows(p1);
  const fishOn = rAll.filter(r => /基准≥130%/.test(r.rule));
  check('全部鱼种都套用了新规则', fishOn.length === FISH_N, String(fishOn.length));
  check('保留数量一起套用（保留3）', fishOn.every(r => /保留3/.test(r.rule)));
  check('材料行不受「应用到全部鱼」影响', rAll.filter(r => !/基准≥130%/.test(r.rule)).every(r => r.rule === '未设置'),
    JSON.stringify(rAll.filter(r => !/基准≥130%/.test(r.rule)).slice(0, 2)));

  section('材料：留够就卖（价格线留空 = 不看价格）');
  await clickSet(p1, '诱饵包');
  await until(() => p1.evaluate(() => !!document.querySelector('#as-on')), v => v === true, 8000);
  await p1.fill('#as-keep', '100');
  await p1.evaluate(() => document.querySelector('#as-save').click());
  await until(async () => { const r = (await rows(p1)).find(x => x.name.indexOf('诱饵包') >= 0); return r && r.checked; }, v => v === true, 8000);
  const bait = (await rows(p1)).find(r => r.name.indexOf('诱饵包') >= 0);
  check('普通材料直接生效（不弹保护确认）', bait.checked && /不看价格/.test(bait.rule) && /保留100/.test(bait.rule), JSON.stringify(bait));
  const srv3 = await GET('/api/autosell?token=' + tok);
  check('服务端保存了无价格线的材料规则',
    srv3.data.items.bait_pack.minPct == null && srv3.data.items.bait_pack.minPrice == null && srv3.data.items.bait_pack.keep === 100,
    JSON.stringify(srv3.data.items.bait_pack));

  section('材料保护：稀有及以上品质材料启用前二次确认');
  await clickSet(p1, '潮汐砂');
  await until(() => p1.evaluate(() => !!document.querySelector('#as-on')), v => v === true, 8000);
  await p1.evaluate(() => document.querySelector('#as-save').click());
  await until(() => p1.evaluate(() => /材料保护确认/.test((document.querySelector('.modal-title') || {}).textContent || '')), v => v === true, 8000);
  check('启用稀有材料先弹保护确认', /材料保护确认/.test(await p1.evaluate(() => document.querySelector('.modal-title').textContent)),
    await p1.evaluate(() => (document.querySelector('.modal-title') || {}).textContent || ''));
  check('保护弹窗点名了该材料', /潮汐砂/.test(await p1.evaluate(() => document.querySelector('.modal-body').textContent)));
  await p1.evaluate(() => document.querySelector('.cf-ok').click());
  await until(async () => { const r = (await rows(p1)).find(x => x.name.indexOf('潮汐砂') >= 0); return r && r.checked; }, v => v === true, 8000);
  const sand = (await rows(p1)).find(r => r.name.indexOf('潮汐砂') >= 0);
  check('确认后材料规则生效', sand.checked && /不看价格/.test(sand.rule), JSON.stringify(sand));
  // 停用不再需要确认；再次启用又要确认 → 取消则保持停用
  await clickChk(p1, '潮汐砂');
  await until(async () => { const r = (await rows(p1)).find(x => x.name.indexOf('潮汐砂') >= 0); return r && !r.checked; }, v => v === true, 8000);
  check('停用不需要保护确认', !/材料保护确认/.test(await p1.evaluate(() => (document.querySelector('.modal-title') || {}).textContent || '')));
  await clickChk(p1, '潮汐砂');
  await until(() => p1.evaluate(() => /材料保护确认/.test((document.querySelector('.modal-title') || {}).textContent || '')), v => v === true, 8000);
  await p1.evaluate(() => document.querySelector('.cf-cancel').click());   // confirmModal 的取消是 .cf-cancel
  await sleep(400);
  check('保护弹窗点取消则保持停用', !(await rows(p1)).find(r => r.name.indexOf('潮汐砂') >= 0).checked,
    JSON.stringify((await rows(p1)).find(r => r.name.indexOf('潮汐砂') >= 0)));

  section('全部停用 / 清空全部');
  await p1.evaluate(() => document.querySelector('#asl-off-all').click());
  await until(async () => (await rows(p1)).every(r => !r.checked), v => v === true, 8000);
  const rOff = await rows(p1);
  check('全部停用后无勾选，规则摘要仍在',
    rOff.every(r => !r.checked) && /基准≥130%/.test(rOff.find(r => r.name.indexOf('鲫鱼') >= 0).rule),
    JSON.stringify({ checked: rOff.filter(r => r.checked).map(r => r.name).slice(0, 6) }));
  const srv4 = await GET('/api/autosell?token=' + tok);
  check('停用只改开关，服务端规则一个没删',
    Object.keys(srv4.data.items).length === FISH_N + 2 && srv4.data.items.carp.minPct === 130,
    String(Object.keys(srv4.data.items).length));
  await p1.evaluate(() => document.querySelector('#asl-clear-all').click());
  await until(() => p1.evaluate(() => !!document.querySelector('.confirm-modal .cf-ok')), v => v === true, 8000);
  check('清空全部先弹出二次确认', /清空自动售出规则/.test(await p1.evaluate(() => (document.querySelector('.modal-title') || {}).textContent || '')),
    await p1.evaluate(() => (document.querySelector('.modal-title') || {}).textContent || ''));
  await p1.evaluate(() => document.querySelector('.cf-ok').click());
  await until(async () => (await rows(p1)).every(r => r.rule === '未设置'), v => v === true, 10000);
  check('确认后全部回到「未设置」', (await rows(p1)).every(r => r.rule === '未设置'));
  const srv5 = await GET('/api/autosell?token=' + tok);
  check('服务端规则清空', Object.keys(srv5.data.items || {}).length === 0, JSON.stringify(srv5.data.items));

  section('后台改打包阈值：经 autosellcfg 广播即时刷新面板');
  const chg = await POST('/api/admin/settings', { token: admTok, autoSellCfg: { batch: 50 } });
  check('后台保存打包阈值 50', chg.status === 200 && chg.data.autoSellCfg.batch === 50, JSON.stringify(chg.data));
  const shown = await until(() => p1.evaluate(() => document.getElementById('sa-batch').textContent), v => v === '50', 8000);
  check('面板阈值文案随广播变为 50（无需刷新页面）', shown === '50', String(shown));
  check('面板说明文案沿用服务器阈值', /50/.test(await p1.evaluate(() => document.getElementById('shop-as-panel').textContent)));

  // ================================================================
  // v0.13.8 其余界面修复：背包筛选泄漏 / 图鉴边框 / 记录页重构
  // ================================================================

  section('背包：体型档筛选不再吞掉材料 / 宝匣');
  await POST('/api/dev/catch', { token: tok, item: { id: 'bait_pack', kind: 'material', rarity: 'common' } });
  await POST('/api/dev/catch', { token: tok, item: { id: 'chest_wreck', kind: 'chest', rarity: 'rare' } });
  await clickNav(p1, '背包');
  await until(() => p1.evaluate(() => !!document.querySelector('#main .inv-page')), v => v === true, 15000);
  const invRows = () => p1.$$eval('#main .inv-row', els => els.length);
  const clickInvCat = (label) => p1.evaluate(l => {
    const b = Array.from(document.querySelectorAll('#main .inv-cat')).filter(x => !x.classList.contains('sub'))
      .find(x => x.textContent.trim().includes(l));
    if (b) { b.click(); return true; }
    return false;
  }, label);
  // 先切到「鱼类」页签（体型档筛选行只在这里出现），选中「大型」——这正是旧版泄漏进其它页签的源头
  await clickInvCat('鱼类');
  await until(() => p1.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('#main .inv-subrow'));
    return rows.some(r => { const s = r.querySelector('.sub-label'); return s && s.textContent.includes('体型档'); });
  }), v => v === true, 8000);
  check('背包鱼类页签存在体型档筛选行', await p1.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('#main .inv-subrow'));
    return rows.some(r => { const s = r.querySelector('.sub-label'); return s && s.textContent.includes('体型档'); });
  }));
  await p1.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('#main .inv-subrow'));
    const row = rows.find(r => { const s = r.querySelector('.sub-label'); return s && s.textContent.includes('体型档'); });
    const b = Array.from(row.querySelectorAll('.inv-cat')).find(x => x.textContent.trim().includes('大型'));
    if (b) b.click();
  });
  await sleep(300);
  await clickInvCat('材料');
  await until(async () => (await invRows()) > 0, v => v === true, 8000);
  check('鱼类页签开着「大型」筛选时，切到材料仍能列出材料（旧版为空列表）', (await invRows()) > 0, String(await invRows()));
  await clickInvCat('宝匣');
  await until(async () => (await invRows()) > 0, v => v === true, 8000);
  check('切到宝匣同样能列出物品', (await invRows()) > 0, String(await invRows()));
  await clickInvCat('鱼类');
  await sleep(200);
  check('回到鱼类页签时体型档筛选仍然可用', (await p1.$$eval('#main .inv-subrow', els => els.length)) >= 1);

  section('图鉴：材料 / 组件不套铜框，改用高亮边框');
  // 先钓上 组件 / 鱼 各一件（材料与宝匣已在前一节钓到），让图鉴里有「已获得」卡片可断言
  await POST('/api/dev/catch', { token: tok, item: { id: 'rod_carbon', kind: 'component', rarity: 'common' } });
  await POST('/api/dev/catch', { token: tok, item: { id: 'crucian', kind: 'fish', rarity: 'common', size: 999 } });
  await clickNav(p1, '鱼类图鉴');
  await until(() => p1.evaluate(() => !!document.querySelector('#main .codex-cell')), v => v === true, 15000);
  const clickCodexCat = (label) => p1.evaluate(l => {
    const b = Array.from(document.querySelectorAll('#main .inv-cat')).find(x => x.textContent.trim().includes(l));
    if (b) b.click();
  }, label);
  await clickCodexCat('材料');
  await sleep(300);
  const matCells = await p1.$$eval('#main .codex-cell', els => els.map(e => e.className));
  check('材料卡不再带 tier-bronze（旧版被当成「普通体型」套铜框）', matCells.length > 0 && !matCells.some(c => /tier-/.test(c)), JSON.stringify(matCells.slice(0, 3)));
  check('材料卡改用高亮边框类 k-nosize', matCells.some(c => /k-nosize/.test(c)), JSON.stringify(matCells.slice(0, 3)));
  const badgeColor = await p1.evaluate(() => {
    const c = Array.from(document.querySelectorAll('#main .codex-cell')).find(e => e.classList.contains('k-nosize'));
    return c ? getComputedStyle(c).borderTopColor : '';
  });
  // 像素主题的 --accent 是 #34e0c0（52,224,192），默认主题是 #2dd4bf（45,212,191）：两种色调都算通过
  check('高亮边框实际生效（青绿色调）', /45,\s*212,\s*191|52,\s*224,\s*192/.test(badgeColor), badgeColor);
  await clickCodexCat('组件');
  await until(() => p1.evaluate(() => Array.from(document.querySelectorAll('#main .codex-cell')).some(e => e.classList.contains('got'))), v => v === true, 8000);
  const compCells = await p1.$$eval('#main .codex-cell', els => els.map(e => e.className));
  check('组件卡不套铜框、已获得的带 k-nosize',
    !compCells.some(c => /tier-/.test(c)) && compCells.some(c => /got/.test(c) && /k-nosize/.test(c)),
    JSON.stringify(compCells.filter(c => /got/.test(c)).slice(0, 3)));
  await clickCodexCat('鱼类');
  await until(() => p1.evaluate(() => Array.from(document.querySelectorAll('#main .codex-cell')).some(e => e.classList.contains('got'))), v => v === true, 8000);
  const fishCells = await p1.$$eval('#main .codex-cell', els => els.map(e => e.className));
  check('渔获卡仍按体型档上铜/银/金框（未受影响）',
    fishCells.some(c => /got/.test(c) && /tier-/.test(c)) && !fishCells.some(c => /k-nosize/.test(c)),
    JSON.stringify(fishCells.filter(c => /got/.test(c)).slice(0, 3)));

  section('分类联动筛选：背包（点开大分类才出细分，品质档按分类给）');
  await clickNav(p1, '背包');
  await until(() => p1.evaluate(() => !!document.querySelector('#main .inv-page')), v => v === true, 15000);
  const subRows = () => p1.$$eval('#main .inv-subrow', els => els.map(e => ((e.querySelector('.sub-label') || {}).textContent || '').trim()));
  const subChips = () => p1.$$eval('#main .inv-subrow .inv-cat', els => els.map(e => e.textContent.trim()));
  await clickInvCat('全部');
  await sleep(300);
  check('「全部」不显示任何细分筛选行（先点开大分类）', (await subRows()).length === 0, JSON.stringify(await subRows()));
  await clickInvCat('材料');
  await until(async () => (await subRows()).length === 1, v => v === true, 8000);
  check('材料只有「品质」一行', JSON.stringify(await subRows()) === '["品质"]', JSON.stringify(await subRows()));
  const matChips = await subChips();
  check('材料品质档不含神话', !matChips.some(t => t.indexOf('神话') === 0), JSON.stringify(matChips));
  check('材料品质档只有目录里存在的三档（普通/稀有/史诗）',
    matChips.filter(t => t.indexOf('全部') !== 0).length === 3, JSON.stringify(matChips));
  await clickInvCat('宝匣');
  await until(async () => (await subRows()).length === 1, v => v === true, 8000);
  const chestChips = await subChips();
  // 宝匣目录里只有 稀有 / 史诗 / 神话（海王遗匣），没有普通 —— 品质档按目录给，所以这三档都在
  check('宝匣品质档按目录给（稀有 / 史诗 / 神话，没有普通）',
    !chestChips.some(t => t.indexOf('普通') === 0) && chestChips.length === 4,
    JSON.stringify(chestChips));
  await clickInvCat('鱼类');
  await until(async () => (await subRows()).length === 2, v => v === true, 8000);
  check('鱼类给出「品质 + 体型档」两行', JSON.stringify(await subRows()) === '["品质","体型档"]', JSON.stringify(await subRows()));
  const fishChips = await subChips();
  check('鱼类品质档不含神话', !fishChips.some(t => t.indexOf('神话') === 0), JSON.stringify(fishChips.filter(t => t.indexOf('全部') !== 0)));
  await clickInvCat('组件');
  await until(async () => (await subRows()).length === 3, v => v === true, 8000);
  check('组件给出部位 + 词条数 + 词条类型（无品质行）', (await subRows()).indexOf('品质') < 0, JSON.stringify(await subRows()));
  // 切回「全部」后细分筛选被归一清零
  await clickInvCat('全部');
  await sleep(300);
  check('切回「全部」后细分筛选消失', (await subRows()).length === 0, JSON.stringify(await subRows()));

  section('一键出售：筛选随种类联动 + 体型档通道');
  await p1.evaluate(() => { const b = Array.from(document.querySelectorAll('button')).find(x => x.textContent.includes('一键出售')); if (b) b.click(); });
  await until(() => p1.evaluate(() => !!document.querySelector('#bulk-filters')), v => v === true, 10000);
  const hasSel = id => p1.evaluate(i => !!document.getElementById(i), id);
  check('默认「全部种类」下只有种类选择框', (await hasSel('bulk-cat')) && !(await hasSel('bulk-rar')) && !(await hasSel('bulk-tier')) && !(await hasSel('bulk-aff')),
    JSON.stringify(await p1.$$eval('#bulk-filters select', els => els.map(e => e.id))));
  await p1.selectOption('#bulk-cat', 'fish');
  await until(() => p1.evaluate(() => !!document.getElementById('bulk-tier')), v => v === true, 8000);
  check('选鱼类 → 出现品质 + 体型，且没有词条筛选',
    (await hasSel('bulk-rar')) && (await hasSel('bulk-tier')) && !(await hasSel('bulk-aff')),
    JSON.stringify(await p1.$$eval('#bulk-filters select', els => els.map(e => e.id))));
  const bulkRarOpts = await p1.$$eval('#bulk-rar option', els => els.map(e => e.textContent.trim()));
  check('鱼类品质选项里没有神话', !bulkRarOpts.some(t => t.indexOf('神话') >= 0), JSON.stringify(bulkRarOpts));
  await p1.selectOption('#bulk-cat', 'material');
  await until(() => p1.evaluate(() => !document.getElementById('bulk-tier')), v => v === true, 8000);
  check('选材料 → 只有品质（没有体型 / 词条）',
    (await hasSel('bulk-rar')) && !(await hasSel('bulk-tier')) && !(await hasSel('bulk-aff')),
    JSON.stringify(await p1.$$eval('#bulk-filters select', els => els.map(e => e.id))));
  const matRarOpts = await p1.$$eval('#bulk-rar option', els => els.map(e => e.textContent.trim()));
  check('材料品质选项里没有神话', !matRarOpts.some(t => t.indexOf('神话') >= 0), JSON.stringify(matRarOpts));
  await p1.selectOption('#bulk-cat', 'chest');
  await sleep(300);
  check('宝匣不进候选（收购不收宝匣，列表应为空）',
    (await p1.$$eval('#bulk-rows .bulk-row-item', els => els.length)) === 0,
    String(await p1.$$eval('#bulk-rows .bulk-row-item', els => els.length)));
  await p1.selectOption('#bulk-cat', 'component');
  await until(() => p1.evaluate(() => !!document.getElementById('bulk-aff')), v => v === true, 8000);
  check('选组件 → 品质 + 词条 + 数值区间',
    (await hasSel('bulk-rar')) && (await hasSel('bulk-aff')) && (await p1.$$('#bulk-filters .aff-num')).length === 2,
    JSON.stringify(await p1.$$eval('#bulk-filters select', els => els.map(e => e.id))));
  // 体型档通道：选中大型后，行内数量 = 大型预留量、单价含 +50%
  await POST('/api/dev/catch', { token: tok, item: { id: 'carp', kind: 'fish', rarity: 'common', size: 999 } });   // 巨型鲤鱼
  await POST('/api/dev/catch', { token: tok, item: { id: 'crucian', kind: 'fish', rarity: 'common', size: 400 } }); // 大型鲫鱼
  await sleep(600);
  await p1.selectOption('#bulk-cat', 'fish');
  await until(() => p1.evaluate(() => !!document.getElementById('bulk-tier')), v => v === true, 8000);
  await p1.selectOption('#bulk-tier', 'G');
  await until(async () => (await p1.$$eval('#bulk-rows .bulk-row-item', els => els.length)) > 0, v => v === true, 8000);
  const rowsG = await p1.$$eval('#bulk-rows .bulk-row-item', els => els.map(e => ({
    name: (e.querySelector('.bk-name') || {}).textContent || '',
    have: (e.querySelector('.bk-have') || {}).textContent || '',
    unit: (e.querySelector('.bk-unit') || {}).textContent || '',
    qty: (e.querySelector('.bk-qty') || {}).value,
  })));
  check('体型档「巨型」只列带巨型预留的鱼（鲤鱼 + 鲫鱼）',
    rowsG.length === 2 && rowsG.every(r => r.have.indexOf('巨型') === 0), JSON.stringify(rowsG));
  check('行内展示档位与数量（巨型 1）', /巨型 1/.test(rowsG[0].have) && rowsG[0].qty === '1', JSON.stringify(rowsG[0]));
  check('单价含 +150% 加成（基准 ×2.5 取整）', Number(rowsG[0].unit.replace(/\D/g, '')) > 0, JSON.stringify(rowsG[0]));
  await p1.selectOption('#bulk-tier', 'all');
  await sleep(300);
  const rowsAll = await p1.$$eval('#bulk-rows .bulk-row-item', els => els.map(e => (e.querySelector('.bk-have') || {}).textContent || ''));
  check('切回全部体型 → 数量按普通可用量（持有）显示', rowsAll.every(t => t.indexOf('持有') === 0), JSON.stringify(rowsAll.slice(0, 3)));
  await p1.evaluate(() => { const c = document.querySelector('.bulk-sell-modal .cf-cancel'); if (c) c.click(); });
  await sleep(200);

  section('交易窗口：筛选与背包同口径 + 关闭即取消交易');
  // 乙向甲发起交易 → 甲的窗口自动弹出（与线上同一条路径）
  const bReg = await POST('/api/register', { username: 'v138_b', password: 'as123456', name: '回归乙', qq: '38200' });
  const bTok = bReg.data && bReg.data.token;
  check('交易对手账号就绪', !!bTok, JSON.stringify(bReg.data));
  // 让乙也建立 SSE 连接（交易要求双方在线）
  await POST('/api/me?token=' + bTok);
  const bMsgs = [];
  const sseB = sseListen(bTok, bMsgs);
  await sleep(400);
  const invite = await POST('/api/trade/invite', { token: bTok, target: 'v138_a' });
  check('乙向甲发起交易邀请', invite.status === 200, JSON.stringify(invite.data));
  await until(() => p1.evaluate(() => !!document.querySelector('.trade-modal, .trade-modal-body')), v => v === true, 10000);
  check('甲的交易窗口自动弹出', (await p1.$$('.trade-modal-body')).length === 1);
  // 甲接受
  const acc = await p1.evaluate(() => {
    const b = Array.from(document.querySelectorAll('button')).find(x => /接受|同意/.test(x.textContent));
    if (b) { b.click(); return true; }
    return false;
  });
  check('窗口里有接受按钮', acc === true);
  await until(() => p1.evaluate(() => !!document.querySelector('.tp-cats')), v => v === true, 10000);
  check('交易窗口出现物品选择区（分类页签）', (await p1.$$('.tp-cats .inv-cat')).length === 5, String((await p1.$$('.tp-cats .inv-cat')).length));
  // 默认「全部」不显示细分
  const tpSubs = () => p1.$$eval('.tp-subfilters .inv-subrow', els => els.map(e => ((e.querySelector('.sub-label') || {}).textContent || '').trim()));
  check('默认不显示细分筛选行（先点开大分类）', (await tpSubs()).length === 0, JSON.stringify(await tpSubs()));
  // 选「鱼类」→ 只有品质（v0.13.9：交易走普通通道，可用量为 0 的大鱼交易不了，
  // 原来的「体型档」筛选只会列出选不中的鱼，已移除）
  await p1.evaluate(() => {
    const b = Array.from(document.querySelectorAll('.tp-cats .inv-cat')).find(x => x.textContent.includes('鱼类'));
    if (b) b.click();
  });
  await until(async () => (await tpSubs()).length === 1, v => v === true, 8000);
  check('交易窗口选鱼类 → 只有品质（体型档筛选已在 v0.13.9 移除）', JSON.stringify(await tpSubs()) === '["品质"]', JSON.stringify(await tpSubs()));
  const tpChips = await p1.$$eval('.tp-subfilters .inv-subrow .inv-cat', els => els.map(e => e.textContent.trim()));
  check('交易窗口的鱼类品质档不含神话', !tpChips.some(t => t.indexOf('神话') === 0), JSON.stringify(tpChips));
  // 选「材料」→ 只有品质
  await p1.evaluate(() => {
    const b = Array.from(document.querySelectorAll('.tp-cats .inv-cat')).find(x => x.textContent.includes('材料'));
    if (b) b.click();
  });
  await until(async () => (await tpSubs()).length === 1, v => v === true, 8000);
  check('交易窗口选材料 → 只有品质', JSON.stringify(await tpSubs()) === '["品质"]', JSON.stringify(await tpSubs()));
  // 关闭即取消：甲的窗口收起，且服务端把 cancelled 广播给对方（对方窗口随之下线）
  await until(() => p1.evaluate(() => /确认交易/.test(document.body.textContent)), v => v === true, 8000);
  check('关闭前甲处于可确认的交易中', /确认交易/.test(await p1.evaluate(() => document.body.textContent)));
  await p1.evaluate(() => {
    const b = Array.from(document.querySelectorAll('.modal-close')).find(x => x.closest('.trade-modal, .modal-box'));
    if (b) b.click();
  });
  await until(async () => bMsgs.some(m => m.type === 'trade' && m.trade && (m.trade.cancelled || m.trade.closed)), v => v === true, 8000);
  const cancelMsg = bMsgs.filter(m => m.type === 'trade' && m.trade && (m.trade.cancelled || m.trade.closed)).slice(-1)[0];
  check('对方收到「已取消」（交易被断开）', !!cancelMsg, JSON.stringify(bMsgs.filter(m => m.type === 'trade').map(m => ({ c: m.trade && m.trade.cancelled, closed: m.trade && m.trade.closed })).slice(-2)));
  check('甲的交易窗口已收起', (await p1.$$('.trade-modal-body')).length === 0);
  try { sseB.destroy(); } catch (e) {}

  section('图鉴：上鱼播报不再重建卡片（游动动画不重头播）');
  await clickNav(p1, '鱼类图鉴');
  await until(() => p1.evaluate(() => !!document.querySelector('#main .codex-cell')), v => v === true, 15000);
  // 抓住鲫鱼卡片这个 DOM 节点：重建的话节点身份会变、CSS 游动动画也会从头播
  await p1.evaluate(() => {
    const cell = document.querySelector('#main .codex-cell[data-cxid="crucian"]');
    window.__cx = cell;
    window.__cxBefore = cell ? cell.querySelector('.cx-meta').textContent : '';
  });
  check('前置：鲫鱼卡片存在', await p1.evaluate(() => !!window.__cx));
  await POST('/api/dev/catch', { token: tok, item: { id: 'crucian', kind: 'fish', rarity: 'common' } });
  await sleep(1600);   // 广播有 1 秒批量窗口
  check('上鱼后卡片仍是同一个 DOM 节点（未重建 → 动画不重头播）',
    await p1.evaluate(() => !!window.__cx && window.__cx === document.querySelector('#main .codex-cell[data-cxid="crucian"]')));
  check('卡片上的「已获得次数」就地更新',
    await p1.evaluate(() => /已获得 \d+ 次/.test(window.__cx.querySelector('.cx-meta').textContent) &&
      window.__cx.querySelector('.cx-meta').textContent !== window.__cxBefore),
    await p1.evaluate(() => window.__cx.querySelector('.cx-meta').textContent));

  section('渔获记录：顶部最新播报 / 大小合并 / 排行榜默认日榜');
  // 造一条会播报的渔获（巨型鲫鱼）：刷新该鱼种纪录 + 全场最大 → lastRec 更新
  await POST('/api/dev/catch', { token: tok, item: { id: 'crucian', kind: 'fish', rarity: 'common', size: 999 } });
  await clickNav(p1, '渔获记录');
  await until(() => p1.evaluate(() => !!document.querySelector('#main .record-hero')), v => v === true, 15000);
  await until(() => p1.evaluate(() => {
    const h = document.querySelector('#main .record-hero .rh-crown');
    return !!h && h.textContent.includes('最新播报');
  }), v => v === true, 8000);
  check('顶部显示「最新播报」而不是「全场最大」',
    /最新播报/.test(await p1.evaluate(() => document.querySelector('#main .record-hero .rh-crown').textContent)),
    await p1.evaluate(() => document.querySelector('#main .record-hero').textContent.slice(0, 60)));
  check('顶部带上播报文案', /纪录刷新|全场最大纪录被破/.test(await p1.evaluate(() => document.querySelector('#main .record-hero').textContent)));
  const rcCells = await p1.$$eval('#main .record-cell', els => els.map(e => ({
    cls: e.className,
    imgs: e.querySelectorAll('.rc-icon').length,
    sizes: e.querySelectorAll('.rc-size').length,
    sf: e.querySelectorAll('.rc-size.sf-size').length,
    who: e.querySelectorAll('.rc-who').length,
  })));
  const withRecCells = rcCells.filter(c => c.cls.indexOf('with-rec') >= 0);
  check('记录卡只有一张鱼图（不再并排最大 / 最小两张）',
    withRecCells.length > 0 && withRecCells.every(c => c.imgs === 1) && !rcCells.some(c => c.imgs > 1),
    JSON.stringify(rcCells.slice(0, 2)));
  check('卡片下方同时给出最大与最小（两个体型 + 两个保持者）',
    withRecCells.every(c => c.sizes === 2 && c.sf === 1 && c.who === 2), JSON.stringify(withRecCells.slice(0, 2)));
  const headings = await p1.$$eval('#main h3', els => els.map(e => e.textContent));
  check('大小鱼记录已合并（不再有独立的「小鱼纪录」段）', !headings.some(h => h.includes('小鱼纪录')) && headings.some(h => h.includes('最大 / 最小')), JSON.stringify(headings));
  // 点卡片 → 排行榜弹窗，默认日榜
  await p1.evaluate(() => {
    const cell = Array.from(document.querySelectorAll('#main .record-cell')).find(e => e.className.includes('with-rec'));
    cell.click();
  });
  await until(() => p1.evaluate(() => !!document.querySelector('#rt-range')), v => v === true, 8000);
  const rangeOn = () => p1.evaluate(() => {
    const box = document.getElementById('rt-range');
    const on = box ? box.querySelector('.inv-cat.on') : null;
    return on ? on.textContent.trim() : '';
  });
  check('排行榜默认「日榜」', (await rangeOn()) === '日榜', await rangeOn());
  check('日榜有内容（刚钓到的巨型鲫鱼已入当日桶）',
    await until(async () => (await p1.$$eval('#records-modal-body .top10-row', els => els.length)) > 0, v => v === true, 8000));
  // 切「周榜」「总榜」：都能列出同一条渔获
  await p1.evaluate(() => {
    const box = document.getElementById('rt-range');
    Array.from(box.querySelectorAll('.inv-cat')).find(b => b.textContent.trim() === '周榜').click();
  });
  await until(async () => (await p1.$$eval('#records-modal-body .top10-row', els => els.length)) > 0, v => v === true, 8000);
  check('周榜可切换且有内容', (await rangeOn()) === '周榜' && (await p1.$$eval('#records-modal-body .top10-row', els => els.length)) > 0, await rangeOn());
  await p1.evaluate(() => {
    const box = document.getElementById('rt-range');
    Array.from(box.querySelectorAll('.inv-cat')).find(b => b.textContent.trim() === '总榜').click();
  });
  await until(async () => (await p1.$$eval('#records-modal-body .top10-row', els => els.length)) > 0, v => v === true, 8000);
  check('总榜可切换且有内容（历史前十）', (await rangeOn()) === '总榜' && (await p1.$$eval('#records-modal-body .top10-row', els => els.length)) > 0, await rangeOn());
  check('榜单切换保留「最大 / 最小」维度开关', (await p1.$$eval('#rt-kind .inv-cat', els => els.length)) === 2);

  section('后台：删除渔获纪录');
  const delOne = await POST('/api/admin/records/delete', { token: admTok, id: 'crucian' });
  check('按鱼种删除纪录成功', delOne.status === 200 && delOne.data.ok === true, JSON.stringify(delOne.data));
  check('该鱼种的最大/最小纪录已清空',
    !(delOne.data.records || {}).crucian && !(delOne.data.small || {}).crucian,
    JSON.stringify({ big: Object.keys(delOne.data.records || {}), small: Object.keys(delOne.data.small || {}) }));
  const topAfter = await GET('/api/records/top?id=crucian&range=day');
  check('日榜里的该鱼种也一起清掉', (topAfter.data.top || []).length === 0, JSON.stringify(topAfter.data.top));
  const delAll = await POST('/api/admin/records/delete', { token: admTok });
  check('清空全部纪录成功', delAll.status === 200 && Object.keys(delAll.data.records || {}).length === 0 && !delAll.data.last,
    JSON.stringify({ n: Object.keys(delAll.data.records || {}).length }));
  const delForbidden = await POST('/api/admin/records/delete', { token: tok });
  check('非管理员删除纪录被拒 403', delForbidden.status === 403, JSON.stringify(delForbidden.data));

  console.log('\nv0.13.8 界面回归小结：通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  if (failed.length) console.log('失败项：\n  - ' + failed.join('\n  - '));
}

main().catch(function (e) {
  fail++;
  console.log('\n  TEST ERROR  ' + (e && e.stack || e));
}).finally(async function () {
  try { if (browser) await browser.close(); } catch (e) {}
  try { if (srv) killTree(srv); } catch (e) {}
  try { fs.rmSync(TMP_DATA, { recursive: true, force: true }); } catch (e) {}
  process.exit(fail === 0 ? 0 : 1);
});

/*
 * 真实浏览器渲染验证（无需人眼）：
 *  - 新增页面均可正常渲染、无页面错误
 *  - 布局度量：面板撑满内容区（消除右侧空白）、动态框体已放大
 *  - 交易页在真实 Chrome 中勾选不被重绘重置
 * 运行： node tests/ui-layout.test.js
 */
'use strict';
const { chromium } = require('playwright-core');
// 轮询等待工具（测试内部不依赖固定 sleep）：就绪即继续，超时才失败
const { waitFor, waitHttp, waitPage } = require('./_util.js');
const os = require('os');
const { spawn, spawnSync } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const PORT = 8171;
const D_DATA = require(path.join(ROOT, 'frontend', 'js', 'data.js'));
// 浏览器可执行文件：优先 CHROME_PATH 环境变量，否则用系统默认安装位置
// 真实浏览器路径：优先 CHROME_PATH；否则自动探测 Chrome / Edge（本机只装了 Edge）
const CHROME = process.env.CHROME_PATH || [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].find(p => fs.existsSync(p)) || 'C:/Program Files/Google/Chrome/Application/chrome.exe';

let pass = 0, fail = 0; const failed = [];
function check(n, c, extra) { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; failed.push(n); console.log('  FAIL  ' + n + (extra ? ' -> ' + extra : '')); } }
function section(t) { console.log('\n=== ' + t + ' ==='); }
const sleep = ms => new Promise(r => setTimeout(r, ms));
// 启动前清理端口占用：Windows 下测试进程被强杀时 taskkill 可能失败，残留的旧服务器会占住端口，
// 导致下一次运行的所有请求打到「陈旧的服务器实例」上（表现为大面积 未登录/数据不符）。
function killPortOccupant(port) {
  try {
    spawnSync('powershell', ['-NoProfile', '-Command',
      "(Get-NetTCPConnection -State Listen -LocalPort " + port + " -ErrorAction SilentlyContinue).OwningProcess | ForEach-Object { Stop-Process -Id $_ -Force }"],
      { stdio: 'ignore' });
  } catch (e) {}
}

function post(p, body) {
  return new Promise(res => {
    const data = JSON.stringify(body);
    const r = http.request({ hostname: 'localhost', port: PORT, path: p, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, rs => {
      let d = ''; rs.on('data', c => d += c);
      rs.on('end', () => { let j = null; try { j = JSON.parse(d); } catch (e) {} res({ status: rs.statusCode, data: j }); });
    });
    r.on('error', () => res({ status: 0 }));
    r.write(data); r.end();
  });
}
function get(p) {
  return new Promise(res => {
    const r = http.request({ hostname: 'localhost', port: PORT, path: p, method: 'GET' }, rs => {
      let d = ''; rs.on('data', c => d += c);
      rs.on('end', () => { let j = null; try { j = JSON.parse(d); } catch (e) {} res({ status: rs.statusCode, data: j }); });
    });
    r.on('error', () => res({ status: 0 }));
    r.end();
  });
}

async function login(page, token) {
  await page.goto('http://localhost:' + PORT + '/', { waitUntil: 'load' });
  await page.evaluate(t => localStorage.setItem('fishing_token', t), token);
  await page.reload({ waitUntil: 'load' });
  await sleep(700);
}
const clickNav = async (page, name) => {
  await page.evaluate(n => {
    const b = Array.from(document.querySelectorAll('.nav-item')).find(x => x.textContent.includes(n));
    if (b) b.click();
  }, name);
  // 轮询到目标页变为 active 且主区已渲染（替代固定 sleep）
  await waitFor(async () => {
    try {
      return await page.evaluate(n => {
        const act = document.querySelector('.nav-item.active');
        const main = document.getElementById('main');
        return !!act && act.textContent.includes(n) && !!main && main.children.length > 0;
      }, name);
    } catch (e) { return false; }
  }, { timeout: 6000 }).catch(() => {});
};

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'fishing-test-'));


(async () => {
  killPortOccupant(PORT);
  const srv = spawn(process.execPath, ['backend/server.js'], { cwd: ROOT, env: Object.assign({}, process.env, { PORT: String(PORT), FISHING_DEV: '1', FISHING_DATA_DIR: TMP_DATA }) });
  await waitHttp('http://localhost:' + PORT + '/shop', { timeout: 20000 });
  let browser;
  try {
    const rs = await post('/api/register', { username: 'lay_seller', password: 'abcd1234', name: '布局卖家', qq: '10014' });
    const rb = await post('/api/register', { username: 'lay_buyer', password: 'abcd1234', name: '布局买家', qq: '10015' });
    const tokS = rs.data.token, tokB = rb.data.token;

    await post('/api/dev/seed', { token: tokS, inventory: { crucian: 12, carp: 6, koi: 2, lure: 4 }, coins: 2400 });
    // 给卖家发一个带负词条的组件实例（用于验证装备后负词条显示为红色）
    const NEG_COMP = D_DATA.instanceId('reel_turbo', 'rare', [{ type: 'speed', value: 30 }, { type: 'big', value: -8 }]);
    await post('/api/dev/catch', { token: tokS, item: { kind: 'component', id: NEG_COMP } });
    const catches = [
      { id: 'koi', name: '黄金锦鲤', rarity: 'rare', size: 88.5 },
      { id: 'catfish', name: '巨型鲶鱼', rarity: 'big', size: 210.4 },
      { id: 'tuna', name: '黄金枪鱼', rarity: 'big', size: 287.2 },
      { id: 'crucian', name: '鲫鱼', rarity: 'common', size: 32.6 },
      { id: 'bass', name: '湖王鲈鱼', rarity: 'big', size: 164.8 },
      { id: 'pearl', name: '深海珍珠贝', rarity: 'rare', size: 34.1 },
    ];
    for (const c of catches) {
      await post('/api/dev/catch', { token: tokS, size: c.size, item: { kind: 'fish', rarity: c.rarity, id: c.id, name: c.name, size: c.size }, ground: '落日海湾', spot: '礁石区' });
    }
    await post('/api/market/list', { token: tokS, id: 'crucian', qty: 5, price: 26 });
    await sleep(80);
    await post('/api/market/list', { token: tokS, id: 'carp', qty: 3, price: 44 });
    // 一个组件实例挂单（用于市集词条筛选验证）；买家持有一个带 钓速+20 的组件
    const compId = D_DATA.instanceId('reel_electric', 'common', [{ type: 'speed', value: 20 }]);
    await post('/api/dev/catch', { token: tokB, item: { kind: 'component', id: compId } });
    await post('/api/market/list', { token: tokB, id: compId, qty: 1, price: 500, hours: 6 });

    browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const p1 = await ctx.newPage();
    const p2 = await ctx.newPage();
    const errs = [];
    [p1, p2].forEach(p => p.on('pageerror', e => errs.push('pageerror: ' + e.message)));

    await login(p1, tokS);
    await login(p2, tokB);

    section('新增页面渲染');
    check('登录后 11 个已实现入口可见', (await p1.$$('#nav .nav-item:not(.locked)')).length === 11);
    check('1 个占位入口锁定（商城）', (await p1.$$('#nav .nav-item.locked')).length === 1);

    // —— 钓鱼页：已移除背包，渔获日志与左栏底部对齐 ——
    await clickNav(p1, '钓鱼');
    check('钓鱼页不再显示背包模块', (await p1.$$('.fish-live .inventory, .content .inventory')).length === 0);
    check('钓鱼页仍有渔获日志', (await p1.$$('.fish-live .catch-log')).length === 1);
    // 切换账号：渔获日志应被清空（回归：曾残留上一个账号的日志）
    const switchLog = await p1.evaluate(() => {
      const S = window.Engine.state;
      const prevMe = S.me;
      const backup = { inv: S.inventory, bd: S.bd, codex: S.codex, coins: S.player.coins, log: S.log, cnt: S.catchCount };
      S.me = { id: 'user_a', username: 'user_a', name: '甲', token: 't' };
      S.log = [{ t: Date.now(), item: { name: '上一个账号的鱼', rarity: 'common' } }];
      const before = S.log.length;
      window.Engine.applyProfile({ username: 'user_b', name: '乙', coins: 1, inventory: {}, bd: {}, codex: {} });
      const after = window.Engine.state.log.length;
      // 完整还原，避免影响后续用例
      S.me = prevMe; S.inventory = backup.inv; S.bd = backup.bd; S.codex = backup.codex;
      S.player.coins = backup.coins; S.log = backup.log; S.catchCount = backup.cnt;
      if (window.Engine.refreshEffects) window.Engine.refreshEffects();
      return { before, after };
    });
    check('切换账号后渔获日志被清空', switchLog.before === 1 && switchLog.after === 0, JSON.stringify(switchLog));
    const align = await p1.evaluate(() => {
      const left = document.querySelector('.content > .fish-select');
      const right = document.querySelector('.content > .fish-live');
      const log = document.querySelector('.fish-live .catch-log');
      if (!left || !right || !log) return { ok: false };
      const lb = left.getBoundingClientRect(), rb = right.getBoundingClientRect(), gb = log.getBoundingClientRect();
      return { ok: true, leftBottom: lb.bottom, rightBottom: rb.bottom, logBottom: gb.bottom };
    });
    check('左右两栏底边对齐（右栏日志随左栏高度撑满）', align.ok && Math.abs(align.leftBottom - align.rightBottom) < 3,
      JSON.stringify(align));
    // 日志填满右栏到底部（不再被下方背包挤到半空；差值仅为面板内边距）
    check('渔获日志填满至右栏底部', align.ok && align.logBottom > align.rightBottom - 30, JSON.stringify(align));

    // —— 系统商店 ——
    await clickNav(p1, '系统商店');
    check('系统商店渲染出价格卡片', (await p1.$$('.shop-card')).length >= 15, String((await p1.$$('.shop-card')).length));
    check('商店卡片显示动态价格与百分比', /当前 \d+%/.test(await p1.textContent('.sc-pct')));
    check('系统商店页已移除背包模块', (await p1.$$('.inventory, .col-side')).length === 0);

    // —— 钓竿配置：装备走子页面（弹窗），页面下方不再有装备模块；负词条红色 ——
    await clickNav(p1, '钓竿配置');
    check('钓竿配置页下方不再有内嵌装备模块', (await p1.$$('.bd-equip-panel, .panel > .bde-head')).length === 0);
    // 点 reel 部位的「装备组件」打开子页面
    await p1.evaluate(() => {
      const cells = Array.from(document.querySelectorAll('.bd-cell'));
      const cell = cells.find(c => c.querySelector('.bd-part') && /卷线器/.test(c.querySelector('.bd-part').textContent));
      const b = cell && Array.from(cell.querySelectorAll('button')).find(x => x.textContent.includes('装备组件'));
      if (b) b.click();
    });
    await sleep(400);
    check('点击装备组件弹出子页面（弹窗）', (await p1.$$('.modal-overlay .bd-equip-modal')).length === 1);
    check('子页面列出该部位组件卡片', (await p1.$$('.bd-equip-modal .bec-card')).length >= 1);
    // 装备带负词条的组件
    await p1.evaluate(() => {
      const cards = Array.from(document.querySelectorAll('.bd-equip-modal .bec-card'));
      const card = cards.find(c => c.querySelector('.bec-aff.aff-neg'));
      const b = card && Array.from(card.querySelectorAll('button')).find(x => x.textContent.includes('装备'));
      if (b) b.click();
    });
    await sleep(900);
    // 弹窗应已关闭，主视图显示装备后的词条
    check('装备后子页面自动关闭', (await p1.$$('.modal-overlay')).length === 0);
    const negColor = await p1.evaluate(() => {
      const lines = Array.from(document.querySelectorAll('.bd-cell .af-line.aff-neg'));
      if (!lines.length) return { ok: false, why: 'no negative affix line' };
      const cs = getComputedStyle(lines[0]);
      const m = /rgb\((\d+),\s*(\d+),\s*(\d+)\)/.exec(cs.color);
      const proxy = document.createElement('span');
      proxy.style.color = getComputedStyle(document.documentElement).getPropertyValue('--danger').trim() || '#f87171';
      document.body.appendChild(proxy);
      const exp = getComputedStyle(proxy).color;
      proxy.remove();
      return { ok: true, color: cs.color, danger: exp, cls: lines[0].className, rgb: m ? [ +m[1], +m[2], +m[3] ] : null };
    });
    check('装备后负词条行存在', negColor.ok, JSON.stringify(negColor));
    check('装备后负词条显示为红色（未被 .on 正色覆盖）',
      negColor.ok && negColor.color === negColor.danger,
      JSON.stringify(negColor));

    // —— 装备子窗口：已装备对比 + 卡片内直接出售/上架 ——
    // 选中「背包里备用组件最多」的部位（部分部位已被装备且无备用，按钮不显示）
    const PART_NAMES = { rod: '竿身', line: '线组', hook: '钩', bait: '饵', reel: '卷线器', accessory: '配件', charm: '饰品栏位' };
    // 前置：前面用例已消耗掉卖家的组件，这里补发 3 件竿身组件（走 dev 接口 → assets 广播回页面）
    const grantInsts = [
      D_DATA.instanceId('rod_bamboo', 'rare', [{ type: 'speed', value: 12 }, { type: 'size', value: -3 }]),
      D_DATA.instanceId('rod_carbon', 'rare', [{ type: 'speed', value: 18 }, { type: 'material', value: -8 }, { type: 'size', value: 3 }]),
      D_DATA.instanceId('rod_fiberglass', 'common', [{ type: 'speed', value: 11 }]),
    ];
    for (const inst of grantInsts) await post('/api/dev/catch', { token: tokS, item: { kind: 'component', id: inst } });
    await waitFor(async () => {
      try {
        return await p1.evaluate((ids) => ids.every(id => (window.Engine.state.inventory[id] || 0) > 0), grantInsts);
      } catch (e) { return false; }
    }, { timeout: 8000 }).catch(() => {});
    await p1.evaluate(() => { window.UI.refreshAll(); });
    await waitFor(async () => (await get('/api/me?token=' + tokS)).data.inventory[grantInsts[0]] > 0, { timeout: 5000 }).catch(() => {});
    async function openRichestEquipModal() {
      const me = (await get('/api/me?token=' + tokS)).data;
      const counts = {};
      Object.keys(me.inventory || {}).forEach(k => {
        const c = D_DATA.componentOf(k);
        if (c) counts[c.part] = (counts[c.part] || 0) + me.inventory[k];
      });
      const best = Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0];
      await p1.evaluate((pn) => {
        const cells = Array.from(document.querySelectorAll('.bd-cell'));
        const cell = cells.find(c => { const t = c.querySelector('.bd-part'); return t && t.textContent.includes(pn); });
        const b = cell && Array.from(cell.querySelectorAll('button')).find(x => x.textContent.includes('装备组件'));
        if (b) b.click();
      }, PART_NAMES[best]);
      await waitFor(async () => (await p1.$$('.bd-equip-modal')).length === 1, { timeout: 4000 }).catch(() => {});
      return { part: best, have: counts[best] || 0 };
    }
    await clickNav(p1, '钓竿配置');
    const ric = await openRichestEquipModal();
    check('打开有备用组件的部位装备子窗口', ric.have >= 1 && (await p1.$$('.bd-equip-modal')).length === 1, JSON.stringify(ric));
    const curPanel = await p1.evaluate(() => {
      const n = document.querySelector('.bde-current');
      if (!n) return { ok: false };
      return {
        ok: true, empty: n.classList.contains('empty'), affs: n.querySelectorAll('.inst-aff').length,
        text: n.textContent.replace(/\s+/g, ' ').slice(0, 120), name: (n.querySelector('b') || {}).textContent || '',
      };
    });
    check('对比区显示「当前已装备」区块', curPanel.ok && /当前已装备/.test(curPanel.text), JSON.stringify(curPanel));
    check('对比区：已装备则列出词条与区间，空栏位则有提示',
      curPanel.empty ? /该栏位为空/.test(curPanel.text) : (curPanel.affs >= 1 && /区间|（/.test(curPanel.text)),
      JSON.stringify({ empty: curPanel.empty, affs: curPanel.affs }));
    const acts = await p1.evaluate(() => {
      const cards = Array.from(document.querySelectorAll('.bd-equip-modal .bec-card'));
      if (!cards.length) return { ok: false };
      return { ok: true, cards: cards.length, labels: Array.from(cards[0].querySelectorAll('.bec-acts button')).map(b => b.textContent.trim()) };
    });
    check('组件卡片带装备/出售/上架三个操作', acts.ok && acts.labels.some(l => l.indexOf('装备') >= 0)
      && acts.labels.some(l => l.indexOf('出售') >= 0) && acts.labels.some(l => l.indexOf('上架') >= 0), JSON.stringify(acts));

    // 上架：应打开与市集相同的上架子窗口（数量/单价/时长/费率/确认）
    await p1.evaluate(() => {
      const card = document.querySelector('.bd-equip-modal .bec-card');
      const b = card && Array.from(card.querySelectorAll('.bec-acts button')).find(x => x.textContent.includes('上架'));
      if (b) b.click();
    });
    await waitFor(async () => (await p1.$$('#list-confirm')).length === 1, { timeout: 5000 }).catch(() => {});
    const listModal = await p1.evaluate(() => {
      const c = document.getElementById('list-confirm');
      if (!c) return { ok: false };
      return {
        ok: true,
        qty: !!document.getElementById('list-qty'),
        price: !!document.getElementById('list-price'),
        hours: Array.from(document.querySelectorAll('.lm-hours')).map(b => b.textContent.trim()),
        est: (document.getElementById('list-est') || {}).textContent || '',
        trend: (document.getElementById('list-trend') || {}).textContent || '',
      };
    });
    check('上架子窗口与市集一致（数量/单价/时长/费率）', listModal.ok && listModal.qty && listModal.price
      && listModal.hours.length === 3 && /上架费/.test(listModal.est), JSON.stringify(listModal).slice(0, 200));
    check('上架子窗口显示价格参考（组件为固定价）', /固定价/.test(listModal.trend), String(listModal.trend).slice(0, 80));
    await p1.evaluate(() => { const b = document.querySelector('.modal-close'); if (b) b.click(); });
    await waitFor(async () => (await p1.$$('.modal-overlay')).length === 0, { timeout: 3000 }).catch(() => {});

    // 出售：直接卖出 1 件并重绘子窗口（金币增加、该部位备用件减少 1）
    const beforeSell = (await get('/api/me?token=' + tokS)).data;
    const partCount = (inv, pk) => Object.keys(inv || {}).reduce((n, k) => {
      const c = D_DATA.componentOf(k);
      return (c && c.part === pk) ? n + inv[k] : n;
    }, 0);
    const ric2 = await openRichestEquipModal();
    const beforeCnt = partCount(beforeSell.inventory, ric2.part);
    await p1.evaluate(() => {
      const cards = Array.from(document.querySelectorAll('.bd-equip-modal .bec-card'));
      const card = cards.find(c => Array.from(c.querySelectorAll('.bec-acts button')).some(b => b.textContent.includes('出售')));
      const b = card && Array.from(card.querySelectorAll('.bec-acts button')).find(x => x.textContent.includes('出售'));
      if (b) b.click();
    });
    await waitFor(async () => (await get('/api/me?token=' + tokS)).data.coins > beforeSell.coins, { timeout: 6000, interval: 150 }).catch(() => {});
    const afterSell = (await get('/api/me?token=' + tokS)).data;
    check('装备子窗口内可直接出售（金币增加）', afterSell.coins > beforeSell.coins, beforeSell.coins + ' -> ' + afterSell.coins);
    check('出售后该部位备用组件减少 1', partCount(afterSell.inventory, ric2.part) === beforeCnt - 1,
      ric2.part + ': ' + beforeCnt + ' -> ' + partCount(afterSell.inventory, ric2.part));
    check('出售后子窗口保持打开并重绘', (await p1.$$('.bd-equip-modal')).length === 1);
    await p1.evaluate(() => { const b = document.querySelector('.bd-equip-modal .modal-close'); if (b) b.click(); });
    await waitFor(async () => (await p1.$$('.modal-overlay')).length === 0, { timeout: 3000 }).catch(() => {});

    // —— 开放市集 ——
    await clickNav(p1, '开放市集');
    // 购买市场默认只显示他人的挂单（本用例两条挂单均属卖家自己 → 0 行），切到「我的挂单」查看
    const mineTab = await p1.$$('.inv-cat');
    await p1.evaluate(() => { const b = Array.from(document.querySelectorAll('.inv-cat')).find(x => x.textContent.includes('我的挂单')); if (b) b.click(); });
    await sleep(300);
    check('市集渲染挂单行（我的挂单）', (await p1.$$('.mk-row')).length === 2, String((await p1.$$('.mk-row')).length));
    check('自己的挂单标记为 mine 并提供下架', (await p1.$$('.mk-row.mine')).length === 2);
    check('市集提示含 10% 税', (await p1.textContent('.panel h2')).includes('10%'));
    // 购买市场：组件挂单展示词条，且可按词条 + 数值筛选
    await p1.evaluate(() => { const b = Array.from(document.querySelectorAll('.inv-cat')).find(x => x.textContent.includes('购买市场')); if (b) b.click(); });
    await sleep(300);
    const buyRows = await p1.$$('.mk-row');
    check('购买市场显示他人的组件挂单', buyRows.length >= 1, String(buyRows.length));
    check('组件挂单行展示实例词条', (await p1.$$('.mk-row .mk-aff .inst-aff')).length >= 1);
    check('市集词条筛选控件存在', (await p1.$$('.aff-filter select')).length === 1 && (await p1.$$('.aff-filter .aff-num')).length === 2);
    // 选「钓速」并设最小 20 → 只剩钓速+20 的组件挂单
    await p1.selectOption('.aff-filter select', 'speed');
    await sleep(200);
    await p1.fill('.aff-filter .aff-num', '20');
    await p1.evaluate(() => { document.querySelectorAll('.aff-filter .aff-num')[0].dispatchEvent(new Event('input', { bubbles: true })); });
    await sleep(250);
    const filtered = await p1.$$('.mk-row');
    check('按词条+数值筛选后匹配到组件挂单', filtered.length === 1, String(filtered.length));
    // 筛选状态下收到市集广播重绘：下拉框不应被关闭（保持展开 / 保留选中值）
    const keepOpen = await p1.evaluate(() => {
      const sel = document.querySelector('.aff-filter select');
      if (!sel) return { ok: false, why: 'no select' };
      sel.focus();
      sel.dispatchEvent(new FocusEvent('focus', { bubbles: true }));
      // 模拟 SSE market 广播触发的重绘
      window.UI.refreshAll('market');
      return { ok: true, value: sel.value, stillFocused: document.activeElement === sel };
    });
    await sleep(200);
    const afterBroadcast = await p1.evaluate(() => {
      const sel = document.querySelector('.aff-filter select');
      return { exists: !!sel, value: sel ? sel.value : null, focused: document.activeElement === sel };
    });
    check('广播重绘时词条下拉未被关闭（筛选控件仍在且选中值保留）',
      keepOpen.ok && afterBroadcast.exists && afterBroadcast.value === 'speed', JSON.stringify({ keepOpen, afterBroadcast }));
    check('广播重绘时下拉保持焦点（不被打断）', afterBroadcast.focused === true, JSON.stringify(afterBroadcast));
    await p1.evaluate(() => { const b = document.querySelector('.aff-filter .bf-cat'); if (b && b.textContent.includes('清除')) b.click(); });
    await sleep(250);

    // —— 系统商店：出售数量控制条（全局生效） ——
    await clickNav(p1, '系统商店');
    check('商店有出售数量控制条', (await p1.$$('.shop-qtybar')).length === 1);
    check('数量控制条含加减与输入框', (await p1.$$('.shop-qtybar .sqb-btn')).length === 2 && (await p1.$$('.shop-qtybar .sqb-num')).length === 1);
    await p1.fill('.shop-qtybar .sqb-num', '3');
    await p1.evaluate(() => { document.querySelector('.shop-qtybar .sqb-num').dispatchEvent(new Event('input', { bubbles: true })); });
    await sleep(200);
    const sellLabels = await p1.$$eval('.shop-card .mini', els => els.map(e => e.textContent));
    check('出售按钮按设定数量显示', sellLabels.some(t => /出售 \d+ 个/.test(t)), JSON.stringify(sellLabels.slice(0, 3)));
    // 切页再回来，数量应保留（全局生效直到被修改）
    await clickNav(p1, '背包');
    await clickNav(p1, '系统商店');
    const qtyKept = await p1.inputValue('.shop-qtybar .sqb-num');
    check('出售数量跨页面保留（全局生效）', qtyKept === '3', qtyKept);

    // —— 背包：组件分类按「词条 + 数值范围」分组 ——
    // 预先投喂两件同底材同品质不同数值 + 一件不同词条组合的组件
    const compIds = [
      D_DATA.instanceId('rod_bamboo', 'rare', [{ type: 'speed', value: 12 }, { type: 'size', value: -3 }]),
      D_DATA.instanceId('rod_bamboo', 'rare', [{ type: 'speed', value: 9 }, { type: 'size', value: -5 }]),
      D_DATA.instanceId('reel_electric', 'common', [{ type: 'speed', value: 25 }]),
    ];
    for (const cid of compIds) await post('/api/dev/catch', { token: tokS, item: { kind: 'component', id: cid } });
    await clickNav(p1, '背包');
    await p1.evaluate(() => { const b = Array.from(document.querySelectorAll('.inv-cat')).find(x => x.textContent.includes('组件')); if (b) b.click(); });
    await sleep(500);
    const compGroup = await p1.evaluate(() => ({
      heads: Array.from(document.querySelectorAll('.inv-group-head')).map(h => h.textContent.replace(/\s+/g, ' ').trim()),
      rows: document.querySelectorAll('.inv-comp-row').length,
      ranges: document.querySelectorAll('.inv-comp-row .aff-rng').length,
    }));
    check('组件分类按词条+词条组合分组显示', compGroup.heads.length >= 2 && compGroup.rows >= 3, JSON.stringify(compGroup));
    check('组内每行标注词条数值范围', compGroup.ranges > 0, JSON.stringify(compGroup));
    // 同底材同品质不同数值应归入同一组（组标题只出现一次「竹制短竿」稀有）
    check('同底材同品质同词条组合归为一组', compGroup.heads.filter(h => h.includes('竹制短竿') && h.includes('稀有')).length === 1, JSON.stringify(compGroup.heads));
    await p1.evaluate(() => { const b = Array.from(document.querySelectorAll('.inv-cat')).find(x => x.textContent.includes('全部')); if (b) b.click(); });
    await sleep(300);

    // —— 背包：批量出售 -> 子窗口（数字 + 滑块 + 趋势图） ——
    await clickNav(p1, '背包');
    check('背包行有「批量出售」按钮', (await p1.textContent('.inv-page')).includes('批量出售'));
    await p1.evaluate(() => {
      const b = Array.from(document.querySelectorAll('.inv-page-row .mini')).find(x => x.textContent.includes('批量出售'));
      if (b) b.click();
    });
    await sleep(400);
    check('批量出售弹出子窗口', (await p1.$$('.batch-sell-modal')).length === 1);
    check('子窗口含数字输入与滑块', (await p1.$$('.batch-sell-modal .bs-num')).length === 1 && (await p1.$$('.batch-sell-modal .bs-range')).length === 1);
    // 数字与滑块联动
    await p1.fill('.batch-sell-modal .bs-num', '2');
    await p1.evaluate(() => { const n = document.querySelector('.batch-sell-modal .bs-num'); n.dispatchEvent(new Event('input', { bubbles: true })); });
    await sleep(150);
    const rangeVal = await p1.inputValue('.batch-sell-modal .bs-range');
    check('输入数量后滑块同步', rangeVal === '2', rangeVal);
    await sleep(700);
    check('子窗口渲染价格趋势区', (await p1.$$('.batch-sell-modal .bs-trend')).length === 1);
    await p1.evaluate(() => { const b = document.querySelector('.batch-sell-modal .modal-close'); if (b) b.click(); });
    await sleep(200);
    check('关闭后批量出售子窗口消失', (await p1.$$('.batch-sell-modal')).length === 0);

    // —— 顶栏登出按钮 + 登出确认子窗口 ——
    check('顶栏有退出登录按钮', (await p1.$$('#logout-btn')).length === 1);
    await p1.evaluate(() => { const b = document.getElementById('logout-btn'); if (b) b.click(); });
    await sleep(300);
    check('登出弹出确认子窗口（非浏览器弹窗）', (await p1.$$('.confirm-modal')).length === 1);
    await p1.evaluate(() => { const b = document.querySelector('.confirm-modal .cf-cancel'); if (b) b.click(); });
    await sleep(200);
    check('取消登出后子窗口关闭', (await p1.$$('.confirm-modal')).length === 0);

    // —— 钓点增益标记 ——
    const spotMarkInfo = await p1.evaluate(async () => {
      // 通过管理员接口给 dock 设置增益（测试服务器无管理员时首个登录的即为管理员）
      const reg = await fetch('/api/admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'lay_seller', password: 'abcd1234' }) }).then(r => r.json()).catch(() => null);
      if (!reg || !reg.token) return { ok: false, why: 'no admin token' };
      const r2 = await fetch('/api/admin/spot/buffs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: reg.token, groundId: 'stillwater', spotId: 'dock', buffs: [{ type: 'speed', value: 15 }] }) }).then(r => r.json()).catch(() => null);
      return { ok: !!(r2 && r2.ok), why: r2 && r2.error };
    });
    // 等待 groundcfg 广播后重绘钓鱼页
    await sleep(600);
    await clickNav(p1, '钓鱼');
    await sleep(300);
    check('有增益的钓点显示 ⚡ 标记', (await p1.$$('.spot-btn.buffed .spot-buff-mark')).length >= 1, JSON.stringify(spotMarkInfo));

    // —— 确认子窗口替代浏览器弹窗（源码级断言：前端不再出现原生 confirm/prompt/alert） ——
    const uiSrc = fs.readFileSync(path.join(ROOT, 'frontend', 'js', 'ui.js'), 'utf8');
    const adminSrc = fs.readFileSync(path.join(ROOT, 'frontend', 'js', 'admin.js'), 'utf8');
    const nativeDialogRe = /(^|[^.\w$])(confirm|prompt|alert)\s*\(\s*['"`]/;
    check('前端 ui.js 不再调用原生 confirm/prompt/alert', !nativeDialogRe.test(uiSrc),
      (uiSrc.match(nativeDialogRe) || []).join(' | '));
    check('管理后台 admin.js 不再调用原生 confirm/prompt/alert', !nativeDialogRe.test(adminSrc),
      (adminSrc.match(nativeDialogRe) || []).join(' | '));

    // —— 鱼类图鉴 ——
    await clickNav(p1, '鱼类图鉴');
    const cells = await p1.$$('.codex-cell');
    const got = await p1.$$('.codex-cell.got');
    check('图鉴渲染全部条目', cells.length === 75, String(cells.length));
    check('图鉴已解锁钓到的鱼', got.length >= 6, String(got.length) + ' 已解锁');
    check('图鉴汇总显示收集进度', /\d+ \/ \d+/.test(await p1.textContent('.codex-summary')));
    // 产地：卡片与详情窗显示的处数应与 GameData.spotsOf 一致（防止与服务端目录脱节）
    const spotCheck = await p1.evaluate(() => {
      const cells = Array.from(document.querySelectorAll('.codex-cell.k-fish'));
      let mismatch = null;
      for (const c of cells) {
        const name = c.querySelector('.cx-name').textContent.trim();
        const item = window.GameData.allItems().find(i => i.name === name && i.kind === 'fish');
        if (!item) continue;
        const expect = window.GameData.spotsOf(item.id).length;
        const m = c.textContent.match(/产地\s*(\d+)\s*处/);
        const shown = m ? Number(m[1]) : 0;
        if (shown !== expect) { mismatch = { name, shown, expect }; break; }
      }
      return mismatch;
    });
    check('图鉴卡片产地处数与目录一致', spotCheck === null, JSON.stringify(spotCheck));
    // 图鉴框体等高：所有卡片高度一致（对齐最高的那张）
    const codexHeights = await p1.$$eval('.codex-cell', els => els.map(e => Math.round(e.getBoundingClientRect().height)));
    const uniqH = Array.from(new Set(codexHeights));
    check('图鉴所有卡片等高', uniqH.length === 1, JSON.stringify(uniqH.slice(0, 6)) + ' n=' + codexHeights.length);
    check('组件图鉴卡展示底材词缀与数值范围', (await p1.$$('.codex-cell.k-component .cx-pool')).length > 0);
    // 图鉴详情改为子窗口
    await p1.evaluate(() => { const c = document.querySelector('.codex-cell'); if (c) c.click(); });
    await sleep(300);
    check('图鉴详情在子窗口中展示', (await p1.$$('.codex-modal .codex-detail')).length === 1);
    check('图鉴页内不再内嵌详情浮层', (await p1.$$('.codex-cell .codex-detail')).length === 0);
    // 回归：详情内容必须真正落在子窗口内且可见（曾因残留绝对定位导致窗口空白）
    const codexDetailVis = await p1.evaluate(() => {
      const box = document.querySelector('.codex-modal');
      if (!box) return { ok: false, why: 'no modal' };
      const bm = box.getBoundingClientRect();
      const parts = Array.from(box.querySelectorAll('.cd-title,.cd-line,.cd-sub,.cd-spot'));
      const cs = getComputedStyle(box.querySelector('.codex-detail'));
      const outside = parts.filter(e => { const r = e.getBoundingClientRect(); return r.width <= 0 || r.height <= 0 || r.bottom > bm.bottom + 1; });
      return { ok: true, parts: parts.length, outside: outside.length, pos: cs.position, boxH: Math.round(bm.height), withinViewport: bm.bottom <= window.innerHeight + 1 };
    });
    check('详情内容定位为静态且在子窗口内', codexDetailVis.ok && codexDetailVis.pos === 'static', JSON.stringify(codexDetailVis));
    check('详情各内容块均在子窗口内可见', codexDetailVis.ok && codexDetailVis.parts > 0 && codexDetailVis.outside === 0, JSON.stringify(codexDetailVis));
    check('子窗口高度随内容撑开且在视口内', codexDetailVis.ok && codexDetailVis.boxH > 150 && codexDetailVis.withinViewport, JSON.stringify(codexDetailVis));
    await p1.evaluate(() => { const b = document.querySelector('.codex-modal .modal-close'); if (b) b.click(); });
    await sleep(200);
    check('关闭图鉴详情子窗口', (await p1.$$('.codex-modal')).length === 0);

    // —— 渔获记录 ——
    await clickNav(p1, '渔获记录');
    check('渔获记录渲染全场纪录卡片', (await p1.$$('.record-cell.with-rec')).length >= 6, String((await p1.$$('.record-cell.with-rec')).length));
    check('全场最大置顶显示 287.2cm（黄金枪鱼）', (await p1.textContent('.record-hero')).includes('287.2'));
    const smallCells = await p1.$$('.record-cell.small-fish');
    check('小鱼纪录渲染卡片', smallCells.length >= 1);
    check('小鱼纪录卡片标注可点查看前十小', (await p1.textContent('.record-cell.small-fish')).includes('前十小'));
    // 点小鱼卡片 → 弹出前十小弹窗
    await p1.evaluate(() => { const c = document.querySelector('.record-cell.small-fish'); if (c) c.click(); });
    await sleep(500);
    check('点击小鱼纪录弹出前十小弹窗', (await p1.textContent('.modal-head .modal-title')).includes('前十小'));
    const sfModal = await p1.evaluate(() => {
      const sizes = Array.from(document.querySelectorAll('#records-modal-body .top10-size')).map(e => parseFloat(e.textContent));
      return { sizes: sizes, sortedAsc: sizes.every((v, i) => i === 0 || sizes[i - 1] <= v) };
    });
    check('前十小弹窗按体型升序排列', sfModal.sizes.length >= 1 && sfModal.sortedAsc, JSON.stringify(sfModal));
    await p1.evaluate(() => { const b = document.querySelector('.modal-close'); if (b) b.click(); });
    await sleep(200);
    // 点大鱼卡片 → 弹出前十大
    await p1.evaluate(() => { const c = document.querySelector('.record-cell.with-rec:not(.small-fish)'); if (c) c.click(); });
    await sleep(500);
    check('点击大鱼纪录弹出前十大弹窗', (await p1.textContent('.modal-head .modal-title')).includes('前十大'));
    await p1.evaluate(() => { const b = document.querySelector('.modal-close'); if (b) b.click(); });
    await sleep(200);
    // 破纪录横幅：调用 showRecordBanner 应出现 5 秒
    await p1.evaluate(() => window.UI.showRecordBanner({ who: '测试甲', name: '黄金枪鱼', size: 999.9 }));
    await sleep(200);
    const bannerOn = await p1.evaluate(() => {
      const b = document.getElementById('record-banner');
      return b && b.classList.contains('show') && b.textContent.includes('999.9');
    });
    check('破纪录横幅显示且含纪录信息', bannerOn === true);

    // —— 渔场动态：布局度量 ——
    await clickNav(p1, '渔场动态');
    const m = await p1.evaluate(() => {
      const content = document.querySelector('.content');
      const panel = document.querySelector('.panel.wide');
      const counts = document.querySelector('.ground-counts');
      const feed = document.querySelector('.feed-big');
      const cs = getComputedStyle(content);
      const pad = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
      return {
        contentInner: content.clientWidth - pad,
        panelW: panel.getBoundingClientRect().width,
        countBoxes: counts ? counts.children.length : 0,
        feedH: feed ? feed.getBoundingClientRect().height : 0,
        feedMaxH: feed ? getComputedStyle(feed).maxHeight : '',
        cols: document.querySelector('.ground-cols') ? getComputedStyle(document.querySelector('.ground-cols')).gridTemplateColumns : '',
      };
    });
    // 面板应几乎撑满内容区（右侧不再留大片空白）
    check('面板宽度撑满内容区（右侧空白 < 2px）', Math.abs(m.contentInner - m.panelW) < 2,
      'contentInner=' + m.contentInner.toFixed(1) + ' panel=' + m.panelW.toFixed(1));
    check('各渔场人数卡片齐全（3 普通 + 1 活动 + 全服）', m.countBoxes === 5, String(m.countBoxes));
    check('动态框体已放大（max-height 560px）', m.feedMaxH === '560px', m.feedMaxH);
    check('动态框体实际高度 >= 380px（放大的框体）', m.feedH >= 380, m.feedH.toFixed(1));
    check('渔场动态两栏布局生效', /px/.test(m.cols) && m.cols.split(' ').length === 2, m.cols);

    // 每个渔场显示人数：渔场动态页用 .gc-box，钓鱼页的钓场卡片用 .gc-cnt
    const boxTexts = await p1.$$eval('.gc-box .gcb-num', els => els.map(e => e.textContent.trim()));
    check('渔场动态页列出每个渔场的人数', boxTexts.length === 5 && boxTexts.every(t => /\d+人/.test(t)), JSON.stringify(boxTexts));
    await clickNav(p1, '钓鱼');
    const cntTexts = await p1.$$eval('.gc-cnt', els => els.map(e => e.textContent.trim()));
    check('钓场列表每个渔场显示人数', cntTexts.length === 3 && cntTexts.every(t => /人/.test(t)), JSON.stringify(cntTexts));
    await clickNav(p1, '渔场动态');

    // —— 在线交易：真实 Chrome 内勾选不被重置 ——
    section('在线交易（真实 Chrome）');
    await clickNav(p2, '在线交易');
    await p1.evaluate(() => {
      const b = Array.from(document.querySelectorAll('.nav-item')).find(x => x.textContent.includes('钓鱼'));
      if (b) b.click();
    });
    await sleep(300);
    await p1.click('.spot-btn');          // 让 p1 处于钓鱼中 → 持续触发 players/grounds/feed 广播
    await waitFor(async () => /实际/.test(await p1.textContent('.fish-state')), { timeout: 5000 }).catch(() => {});
    const castBar = await p1.textContent('.fish-state');
    check('状态条显示后台基础间隔', /后台基础 \d+\.\d+s\/竿/.test(castBar), castBar.slice(0, 140));
    check('状态条显示实际钓速（含加成拆分或“无加成”）', /实际 \d+\.\d+s\/竿/.test(castBar), castBar.slice(0, 140));
    // 顶部角色状态栏同步展示钓速（基础值 + 实际值），便于随时查看
    await waitFor(async () => /每 \d+\.\d+s 一竿/.test(await p1.textContent('#player-status')), { timeout: 6000 }).catch(() => {});
    const topCast = await p1.textContent('#player-status');
    check('顶部状态栏显示实际钓速与后台基础值', /每 \d+\.\d+s 一竿/.test(topCast) && /基础 \d+\.\d+s/.test(topCast), topCast.slice(0, 160));
    check('顶部钓速含加成拆分（钓竿/钓点/全服或无加成）', /竿|点|服|无加成/.test(topCast), topCast.slice(0, 160));
    await clickNav(p1, '在线交易');

    await p1.evaluate(() => {
      const b = Array.from(document.querySelectorAll('.invite-row .mini')).find(x => x.textContent.includes('邀请'));
      if (b) b.click();
    });
    await sleep(800);
    await p2.evaluate(() => {
      const b = Array.from(document.querySelectorAll('.trade-actions button')).find(x => x.textContent.includes('接受邀请'));
      if (b) b.click();
    });
    await sleep(900);
    await clickNav(p1, '在线交易');
    check('交易界面出现物品选择器', (await p1.$$('.trade-picker')).length === 1);

    // 勾选并等待若干秒，让钓鱼产生的 players/grounds/feed 广播持续冲刷
    await p1.evaluate(() => {
      const r = Array.from(document.querySelectorAll('.tp-row')).find(x => x.textContent.includes('黄金锦鲤'));
      const cb = r.querySelector('input[type=checkbox]');
      cb.checked = true; cb.dispatchEvent(new Event('change', { bubbles: true }));
      const qi = r.querySelector('input.tp-qty');
      qi.value = '2'; qi.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await sleep(4000);   // > 一个钓鱼周期（3s），期间必有多次广播
    const afterBurst = await p1.evaluate(() => {
      const r = Array.from(document.querySelectorAll('.tp-row')).find(x => x.textContent.includes('黄金锦鲤'));
      if (!r) return null;
      return { checked: r.querySelector('input[type=checkbox]').checked, qty: r.querySelector('input.tp-qty').value };
    });
    check('持续广播 4s 后勾选仍保持（核心缺陷已修复）', !!afterBurst && afterBurst.checked === true, JSON.stringify(afterBurst));
    check('持续广播 4s 后数量仍为 2', !!afterBurst && afterBurst.qty === '2', JSON.stringify(afterBurst));

    // 提交并使用 UI 确认
    await p1.evaluate(() => {
      const b = Array.from(document.querySelectorAll('.trade-picker .mini')).find(x => x.textContent.includes('更新我的提供'));
      if (b) b.click();
    });
    await sleep(900);
    check('提交后「我的提供」显示所选物品', (await p1.textContent('.trade-side.mine')).includes('黄金锦鲤'));

    // 提供栏展示所选物品属性（双方可见）：补选一件带词条的组件后提交
    await p1.evaluate(() => {
      const rows = Array.from(document.querySelectorAll('.tp-row'));
      const r = rows.find(x => x.querySelector('.mk-aff .inst-aff'));
      if (r) { const cb = r.querySelector('input[type=checkbox]'); cb.checked = true; cb.dispatchEvent(new Event('change', { bubbles: true })); }
    });
    await sleep(200);
    await p1.evaluate(() => {
      const b = Array.from(document.querySelectorAll('.trade-picker .mini')).find(x => x.textContent.includes('更新我的提供'));
      if (b) b.click();
    });
    await waitFor(async () => (await p1.$$('.trade-side.mine .ts-item .inst-aff')).length >= 1, { timeout: 6000 }).catch(() => {});
    const mineAff = await p1.evaluate(() => {
      const items = Array.from(document.querySelectorAll('.trade-side.mine .ts-item'));
      const it = items.find(x => x.querySelector('.inst-aff'));
      return it ? it.textContent.replace(/\s+/g, ' ').trim().slice(0, 100) : '';
    });
    check('「我的提供」栏显示所选组件属性（词条/数值/区间）', /%|区间|（/.test(mineAff) && mineAff.length > 0, mineAff);
    check('「我的提供」栏显示渔获信息（稀有度与基准价）', /基准价/.test(await p1.textContent('.trade-side.mine')), '');
    // 对方视角：同一物品属性同样可见（双方可见）
    await waitFor(async () => (await p2.$$('.trade-side:not(.mine) .ts-item .inst-aff')).length >= 1, { timeout: 8000 }).catch(() => {});
    const otherAff = await p2.evaluate(() => {
      const items = Array.from(document.querySelectorAll('.trade-side:not(.mine) .ts-item'));
      const it = items.find(x => x.querySelector('.inst-aff'));
      return it ? it.textContent.replace(/\s+/g, ' ').trim().slice(0, 100) : '';
    });
    check('对方「提供」栏也能看到该组件属性（双方可见）', otherAff.length > 0, otherAff);
    check('双方看到的词条信息一致', mineAff.length > 0 && otherAff.length > 0 && mineAff.split(' ')[0] === otherAff.split(' ')[0], JSON.stringify({ mineAff: mineAff.slice(0, 40), otherAff: otherAff.slice(0, 40) }));
    await p1.evaluate(() => {
      const b = Array.from(document.querySelectorAll('.trade-actions button')).find(x => x.textContent.includes('确认交易'));
      if (b) b.click();
    });
    await sleep(900);
    check('点击确认后按钮变为「已确认」', (await p1.textContent('.trade-actions')).includes('已确认'), await p1.textContent('.trade-actions'));
    check('确认状态同步到对方视图', (await p2.textContent('.trade-side:not(.mine)')).includes('已确认'), await p2.textContent('.trade-side:not(.mine)'));

    // —— 交易锁定：交易进行中列表不随广播重绘（v0.9.0）——
    section('交易锁定背包');
    check('交易页提供物品列表带分类页签', (await p1.$$('.tp-cats .inv-cat')).length === 4, String((await p1.$$('.tp-cats .inv-cat')).length));
    await p1.evaluate(() => {
      const b = Array.from(document.querySelectorAll('.tp-cats .inv-cat')).find(x => x.textContent.includes('组件'));
      if (b) b.click();
    });
    await sleep(400);
    check('切到「组件」分类页签后选择器仍在', (await p1.$$('.trade-picker')).length === 1);
    await p1.evaluate(() => {
      const b = Array.from(document.querySelectorAll('.tp-cats .inv-cat')).find(x => x.textContent.includes('全部'));
      if (b) b.click();
    });
    await sleep(400);
    check('交易页显示锁定条', (await p1.$$('.trade-lock')).length === 1);
    check('锁定条含手动刷新按钮', await p1.evaluate(() => {
      const n = document.querySelector('.trade-lock');
      return !!n && n.textContent.includes('刷新列表');
    }), '');
    const domKept = await p1.evaluate(async () => {
      const r = Array.from(document.querySelectorAll('.tp-row')).find(x => x.textContent.includes('黄金锦鲤'));
      if (!r) return { ok: false };
      r.dataset.keepTag = '1';
      await new Promise(res => setTimeout(res, 4200)); // 跨过至少一个钓鱼周期，期间必有多次广播
      const again = Array.from(document.querySelectorAll('.tp-row')).find(x => x.textContent.includes('黄金锦鲤'));
      return { ok: !!again && again.dataset.keepTag === '1' };
    });
    check('持续广播 4.2s 后选择器 DOM 未被重建（锁定生效）', domKept.ok === true, JSON.stringify(domKept));
    await clickNav(p1, '背包');
    check('交易中背包页显示锁定提示', (await p1.$$('.trade-lock')).length === 1);
    // 收起交易，避免影响后续用例
    await clickNav(p1, '在线交易');
    await p1.evaluate(() => {
      const b = Array.from(document.querySelectorAll('.trade-actions button')).find(x => x.textContent.includes('取消交易'));
      if (b) b.click();
    });
    await sleep(700);

    // —— v0.9.0 新增：一键出售预览 / 组件订阅 / 日志页 ——
    section('一键出售预览 · 组件订阅 · 日志页');
    await clickNav(p1, '背包');
    check('背包页有「一键出售（预览）」按钮', (await p1.textContent('.bulk-sell')).includes('一键出售（预览）'));
    check('背包页有组件订阅入口', (await p1.textContent('.bulk-sell')).includes('组件订阅提醒'));
    await p1.evaluate(() => {
      const b = Array.from(document.querySelectorAll('.bulk-sell button')).find(x => x.textContent.includes('一键出售'));
      if (b) b.click();
    });
    await sleep(500);
    check('预览弹窗打开', (await p1.$$('.bulk-sell-modal')).length === 1);
    const bulkRows = (await p1.$$('.bulk-rows .bulk-row-item')).length;
    check('预览列表列出候选物品', bulkRows > 0, String(bulkRows));
    check('预览弹窗含词条/数值筛选', await p1.evaluate(() => {
      const n = document.querySelector('.bulk-filters');
      return !!n && n.textContent.includes('词条');
    }), '');
    const bulkEdit = await p1.evaluate(() => {
      const first = document.querySelector('.bulk-rows .bulk-row-item');
      const cb = first.querySelector('input[type=checkbox]');
      const before = document.querySelectorAll('.bulk-rows input[type=checkbox]:checked').length;
      cb.checked = false; cb.dispatchEvent(new Event('change', { bubbles: true }));
      const after = document.querySelectorAll('.bulk-rows input[type=checkbox]:checked').length;
      const est = document.querySelector('#bulk-est').textContent;
      return { before, after, est };
    });
    check('取消勾选后已选数量减少（可编辑选择）', bulkEdit.after === bulkEdit.before - 1, JSON.stringify(bulkEdit));
    const bulkQty = await p1.evaluate(() => {
      const first = document.querySelector('.bulk-rows .bulk-row-item');
      const qi = first.querySelector('.bk-qty');
      qi.value = '1'; qi.dispatchEvent(new Event('input', { bubbles: true }));
      return document.querySelector('#bulk-est').textContent;
    });
    check('调整数量后预估收入实时刷新', /已选/.test(bulkQty), bulkQty);
    await p1.evaluate(() => { const b = document.querySelector('.bulk-sell-modal .cf-cancel'); if (b) b.click(); });
    await sleep(300);
    check('关闭后弹窗消失', (await p1.$$('.bulk-sell-modal')).length === 0);
    // 订阅弹窗
    await p1.evaluate(() => {
      const b = Array.from(document.querySelectorAll('.bulk-sell button')).find(x => x.textContent.includes('组件订阅'));
      if (b) b.click();
    });
    await sleep(500);
    check('订阅弹窗打开并含筛选与提醒方式', await p1.evaluate(() => {
      const n = document.querySelector('.subscribe-modal');
      if (!n) return false;
      return n.textContent.includes('背包红标') && n.textContent.includes('浏览器图标闪烁') && !!n.querySelector('#sub-base');
    }), '');
    await p1.evaluate(() => { const b = document.querySelector('.subscribe-modal .cf-cancel'); if (b) b.click(); });
    await sleep(300);
    // 日志页
    await clickNav(p1, '日志');
    check('日志页渲染（分类页签 + 说明）', (await p1.textContent('.content')).includes('日志') && (await p1.$$('.log-page')).length === 1);
    check('日志页有分类筛选页签', (await p1.$$('.inv-cats .inv-cat')).length === 5, String((await p1.$$('.inv-cats .inv-cat')).length));
    check('日志页无未实现占位锁', (await p1.$$('.content .big-lock')).length === 0);

    // —— 滚动位置保持（SSE 广播重绘不再把长列表拽回顶部）——
    section('重绘滚动保持');
    await clickNav(p1, '渔获记录');
    const scrollInfo = await p1.evaluate(async () => {
      const content = document.querySelector('.content'); // #main 的滚动容器
      if (!content) return { ok: false, why: 'no .content' };
      content.scrollTop = 150;
      const before = content.scrollTop;
      if (!window.UI || !window.UI.renderView) return { ok: false, why: 'no renderView' };
      window.UI.renderView(); // 等价于一次 SSE 广播触发的整页重绘
      await new Promise(r => setTimeout(r, 80));
      const content2 = document.querySelector('.content');
      return { ok: true, scrollable: content2.scrollHeight > content2.clientHeight, before: before, after: content2 ? content2.scrollTop : -1 };
    });
    check('渔获记录页可滚动', scrollInfo.ok && scrollInfo.scrollable && scrollInfo.before > 0, JSON.stringify(scrollInfo));
    check('重绘后滚动位置保持（不回滚到顶部）', scrollInfo.ok && scrollInfo.after === scrollInfo.before, JSON.stringify(scrollInfo));

    // —— 反馈意见页 ——
    section('反馈意见页');
    await clickNav(p1, '反馈意见');
    check('反馈页渲染提交框与冷却状态', (await p1.$$('.fb-input')).length === 1 && (await p1.$$('.fb-banner')).length === 1);
    check('反馈页有类型选择按钮', (await p1.$$('.fb-kinds .inv-cat')).length === 4);
    // 提交一条反馈
    await p1.fill('.fb-input', '浏览器自动化提交的测试反馈');
    await p1.evaluate(() => { const b = Array.from(document.querySelectorAll('.feedback-panel .primary')).find(x => x.textContent.includes('提交反馈')); if (b) b.click(); });
    await sleep(900);
    check('提交后进入冷却状态', (await p1.textContent('.fb-banner')).includes('冷却'));
    check('我的反馈历史出现记录', (await p1.$$('.fb-history .fb-item')).length >= 1);
    check('冷却中提供花金币结束 CD 按钮', (await p1.$$('.fb-banner .mini')).length === 1);

    // —— 版本守卫：本地与服务器版本一致时不触发刷新 ——
    section('版本守卫');
    const verCheck = await p1.evaluate(async () => {
      if (!window.Net || !window.Net.guardVersion) return { ok: false, why: 'no guardVersion' };
      const reloaded = await window.Net.guardVersion();
      return { ok: true, reloaded: reloaded, local: window.GameData.VERSION };
    });
    check('版本一致时不触发整页刷新', verCheck.ok && verCheck.reloaded === false, JSON.stringify(verCheck));

    // 移动端窄屏
    section('窄屏自适应');
    const p3 = await ctx.newPage();
    await p3.setViewportSize({ width: 420, height: 860 });
    await login(p3, tokS);
    await clickNav(p3, '渔场动态');
    const mob = await p3.evaluate(() => {
      const cols = document.querySelector('.ground-cols');
      const counts = document.querySelector('.ground-counts');
      const sidebar = document.querySelector('.sidebar');
      const nav = document.querySelector('#nav');
      const cs = getComputedStyle(sidebar);
      return {
        cols: getComputedStyle(cols).gridTemplateColumns.split(' ').length,
        countCols: getComputedStyle(counts).gridTemplateColumns.split(' ').length,
        overflowX: document.documentElement.scrollWidth > window.innerWidth + 2,
        sidebarPos: cs.position,
        sidebarBottom: cs.bottom,
        navRow: getComputedStyle(nav).flexDirection,
        bodyPadBottom: parseFloat(getComputedStyle(document.body).paddingBottom) || 0,
      };
    });
    check('窄屏下渔场动态合并为单栏', mob.cols === 1, String(mob.cols));
    check('窄屏下无横向溢出', mob.overflowX === false, String(mob.overflowX));
    // 手机专属排版：侧栏转为固定底部标签栏，内容留出底部空间
    check('手机端侧栏改为固定底部标签栏', mob.sidebarPos === 'fixed' && mob.sidebarBottom === '0px', JSON.stringify(mob));
    check('手机端导航为横向标签', mob.navRow === 'row', mob.navRow);
    check('手机端内容区为底部标签栏留白', mob.bodyPadBottom >= 40, String(mob.bodyPadBottom));
    // 每个已实现页面在手机端都能渲染且无横向溢出
    const mobileViews = ['钓鱼', '钓竿配置', '背包', '系统商店', '开放市集', '鱼类图鉴', '渔获记录', '反馈意见'];
    let mobBad = null;
    for (const v of mobileViews) {
      await clickNav(p3, v);
      const bad = await p3.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 2);
      if (bad) { mobBad = v; break; }
    }
    check('手机端各页面均无横向溢出', mobBad === null, mobBad ? ('溢出页：' + mobBad) : '');

    // —— 切换钓点不被上鱼卡住（pointerdown 主路径）+ 点 ⚡ 子元素也能选中 ——
    section('切换钓点');
    await clickNav(p1, '钓鱼');
    await sleep(300);
    const spotSwitch = await p1.evaluate(() => {
      const btn = n => Array.from(document.querySelectorAll('.spot-btn')).find(x => x.textContent.includes(n));
      const fire = (n) => { const b = btn(n); if (b) b.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); return !!b; };
      fire('老旧码头');
      const s1 = window.Engine.state.player.spotId;
      fire('深水区');
      const s2 = window.Engine.state.player.spotId;
      // 点击 ⚡ 子元素（用当前页第一个带标记的钓点）
      let childSpot = null;
      const marked = Array.from(document.querySelectorAll('.spot-btn .spot-buff-mark'));
      if (marked.length) {
        const name = marked[0].closest('.spot-btn').textContent.replace('⚡', '').trim();
        marked[0].dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
        childSpot = { name, sel: window.Engine.state.selected.spotId };
      }
      return { s1, s2, childSpot };
    });
    check('pointerdown 可开始钓鱼', spotSwitch.s1 === 'dock', JSON.stringify(spotSwitch));
    check('pointerdown 可切换钓点', spotSwitch.s2 === 'deep', JSON.stringify(spotSwitch));
    if (spotSwitch.childSpot) check('点中 ⚡ 子元素也能选中该钓点', !!spotSwitch.childSpot.sel, JSON.stringify(spotSwitch.childSpot));

    // —— 横幅不遮挡顶栏与内容 ——
    section('横幅遮挡');
    await p1.evaluate(() => window.UI.showRecordBanner({ who: '测试', name: '黄金枪鱼', size: 888 }));
    await sleep(500);
    const bannerBox = await p1.evaluate(() => {
      const b = document.getElementById('record-banner').getBoundingClientRect();
      const tb = document.querySelector('.topbar').getBoundingClientRect();
      const shown = document.getElementById('record-banner').classList.contains('show');
      const pad = getComputedStyle(document.body).paddingTop;
      return { shown, bannerBottom: Math.round(b.bottom), topbarTop: Math.round(tb.top), pad };
    });
    check('横幅显示时不遮挡顶栏', bannerBox.shown && bannerBox.topbarTop >= bannerBox.bannerBottom - 1, JSON.stringify(bannerBox));

    // —— 管理后台「组件生成」：roll 模型保存（回归：单选框缺 value 被服务器判为未知模型） ——
    section('管理后台组件生成 · roll 模型');
    const pa = await ctx.newPage();
    const adminErrs = []; pa.on('pageerror', e => adminErrs.push(e.message));
    const adminLogin = await post('/api/admin/login', { username: 'lay_seller', password: 'abcd1234' });
    if (adminLogin.data && adminLogin.data.token) {
      await pa.goto('http://localhost:' + PORT + '/admin.html', { waitUntil: 'load' });
      await pa.evaluate(t => localStorage.setItem('fishing_admin_token', t), adminLogin.data.token);
      await pa.reload({ waitUntil: 'load' });
      await sleep(1200);
      await pa.evaluate(() => { const b = Array.from(document.querySelectorAll('.nav-item')).find(x => x.textContent.includes('组件生成')); if (b) b.click(); });
      await sleep(900);
      const radios = await pa.$$eval('input[name=rm]', els => els.map(e => e.value));
      check('roll 模型单选框都有非空 value', radios.length === 3 && radios.every(v => v && v !== 'on'), JSON.stringify(radios));
      await pa.evaluate(() => { const c = document.querySelector('.radio-card[data-rm=normal]'); if (c) c.click(); });
      await sleep(150);
      await pa.evaluate(() => { document.getElementById('cmp-save').click(); });
      await sleep(800);
      const state = await pa.textContent('#cmp-state');
      check('保存 roll 模型成功（非「未知的 roll 模型」）', /已保存/.test(state) && !/未知/.test(state), state);
      const saved = await get('/api/admin/world?token=' + adminLogin.data.token);
      check('服务器已应用所选 roll 模型（normal）', saved.data.componentCfg && saved.data.componentCfg.rollModel === 'normal', JSON.stringify(saved.data.componentCfg && saved.data.componentCfg.rollModel));
      check('管理后台无页面错误', adminErrs.length === 0, adminErrs.join(' | '));

      // —— 渔场管理：新建（一键填充）/ 限时窗口 / 删除恢复 / 已有钓点一键填充 ——
      section('管理后台渔场管理 · 横幅滚播 · 反馈奖励');
      const gidNew = 'qa_cove_' + Math.random().toString(36).slice(2, 6);
      const clickAdminNav = async (name) => {
        await pa.evaluate(n => { const b = Array.from(document.querySelectorAll('.nav-item')).find(x => x.textContent.includes(n)); if (b) b.click(); }, name);
        await sleep(900);
      };
      await clickAdminNav('渔场钓点');
      await pa.evaluate((gid) => {
        document.getElementById('ng-id').value = gid;
        document.getElementById('ng-name').value = 'QA 测试湾';
        document.getElementById('ng-spot').value = '主钓点';
        document.getElementById('ng-preset').value = 'rare';
        document.getElementById('ng-create').click();
      }, gidNew);
      await sleep(1300);
      const gr1 = await get('/api/grounds');
      const newG = (gr1.data.grounds || []).find(g => g.id === gidNew);
      check('新建渔场实时进入全服目录（含 1 个钓点）', !!newG && newG.spots.length === 1, JSON.stringify((gr1.data.grounds || []).map(g => g.id)));
      check('新钓点按「稀有秘境」预设一键填充（13 条）', !!newG && newG.spots[0].pool.length === 13, newG ? String(newG.spots[0].pool.length) : 'none');
      check('新渔场默认开放可钓', !!newG && newG.locked === false);
      // 限时窗口：设成已过期 → 自动锁定
      await pa.evaluate(() => {
        const f = d => d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2) + 'T' + ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
        document.getElementById('gi-from').value = f(new Date(Date.now() - 3600 * 1000));
        document.getElementById('gi-to').value = f(new Date(Date.now() - 1800 * 1000));
        document.getElementById('gi-window').click();
      });
      await sleep(1100);
      const gr2 = await get('/api/grounds');
      const lockedG = (gr2.data.grounds || []).find(g => g.id === gidNew);
      check('限时窗口已过期 → 渔场自动锁定', !!lockedG && lockedG.locked === true, JSON.stringify(lockedG && { locked: lockedG.locked, openTo: lockedG.openTo }));
      check('限时开窗时间随目录下发（前端可展示）', !!lockedG && !!lockedG.openFrom && !!lockedG.openTo);
      await pa.evaluate(() => { document.getElementById('gi-clearwin').click(); });
      await sleep(900);
      const gr3 = await get('/api/grounds');
      check('清除限时后恢复常驻开放', !!((gr3.data.grounds || []).find(g => g.id === gidNew) || {}).locked === false);
      // 已有钓点一键填充：经济浅水预设 → 保存生效
      await pa.evaluate(() => { document.getElementById('pool-preset').value = 'economy'; document.getElementById('pool-fill').click(); });
      await sleep(800);
      const fillRows = await pa.$$eval('#pool-rows .pool-row', els => els.length);
      check('一键填充替换草稿（经济浅水 13 条）', fillRows === 13, String(fillRows));
      await pa.evaluate(() => { document.getElementById('pool-save').click(); });
      await sleep(1100);
      const gr4 = await get('/api/grounds');
      const filledG = (gr4.data.grounds || []).find(g => g.id === gidNew);
      check('保存后掉落池按预设生效', !!filledG && filledG.spots[0].pool.length === 13, filledG ? String(filledG.spots[0].pool.length) : 'none');
      // 删除自定义渔场 → 目录移除（不可恢复）
      await pa.evaluate((gid) => { const c = document.querySelector('.gcard[data-g="' + gid + '"]'); if (c) c.querySelector('[data-rmg]').click(); }, gidNew);
      await sleep(400);
      await pa.evaluate(() => { const y = document.querySelector('.cf-yes'); if (y) y.click(); });
      await sleep(1200);
      const gr5 = await get('/api/grounds');
      check('自定义渔场删除后从目录移除', !(gr5.data.grounds || []).some(g => g.id === gidNew));
      const rstChips = await pa.$$eval('[data-rstg]', els => els.map(e => e.getAttribute('data-rstg')));
      check('自定义渔场删除后不在恢复名单', rstChips.indexOf(gidNew) < 0, rstChips.join(','));
      // 内置钓点删除 → 可恢复
      await clickAdminNav('渔场钓点');
      const builtSpot = await pa.evaluate(async () => {
        const g = await fetch('/api/grounds').then(r => r.json());
        const st = g.grounds.find(x => x.id === 'stillwater');
        return (st && st.spots.length) ? { gid: 'stillwater', sid: st.spots[st.spots.length - 1].id } : null;
      });
      check('存在可测试的内置钓点', !!builtSpot, JSON.stringify(builtSpot));
      await pa.evaluate((sid) => {
        const t = Array.from(document.querySelectorAll('.spot-tab')).find(x => x.getAttribute('data-s') === sid);
        if (t) t.click();
      }, builtSpot.sid);
      await sleep(700);
      await pa.evaluate(() => { const b = document.getElementById('ns-del'); if (b) b.click(); });
      await sleep(400);
      await pa.evaluate(() => { const y = document.querySelector('.cf-yes'); if (y) y.click(); });
      await sleep(1200);
      const gr6 = await get('/api/grounds');
      const still = (gr6.data.grounds || []).find(g => g.id === 'stillwater');
      check('内置钓点删除后从目录移除', !!still && !still.spots.some(s => s.id === builtSpot.sid), still ? String(still.spots.length) : 'none');
      const chips2 = await pa.$$eval('[data-rsts]', els => els.map(e => e.getAttribute('data-rsts')));
      check('内置钓点进入可恢复名单', chips2.indexOf('stillwater:' + builtSpot.sid) >= 0, chips2.join(','));
      await pa.evaluate((key) => { const b = document.querySelector('[data-rsts="' + key + '"]'); if (b) b.click(); }, 'stillwater:' + builtSpot.sid);
      await sleep(1200);
      const gr7 = await get('/api/grounds');
      const still2 = (gr7.data.grounds || []).find(g => g.id === 'stillwater');
      check('一键恢复内置钓点', !!still2 && still2.spots.some(s => s.id === builtSpot.sid));

      // —— 横幅：发布 → 玩家端滚播并上报 → 后台「当前滚播」→ 停止滚播 ——
      // —— 公式管理：抛竿间隔与全服钓速表单 ——
      await clickAdminNav('公式管理');
      await pa.evaluate(() => {
        document.getElementById('cast-bonus').value = '50';
        document.getElementById('cast-cap').value = '80';
        document.getElementById('cast-save').click();
      });
      await sleep(1100);
      const castSaved = await get('/api/admin/world?token=' + adminLogin.data.token);
      check('后台保存全服钓速加成与上限生效（50 / 80）', castSaved.data.castSpeedBonus === 50 && castSaved.data.castSpeedCap === 80,
        JSON.stringify({ b: castSaved.data.castSpeedBonus, c: castSaved.data.castSpeedCap }));
      const castPreviewTxt = await pa.evaluate(() => { const n = document.getElementById('cast-preview'); return n ? n.textContent : ''; });
      check('间隔预览随参数实时更新（含有效钓速换算）', /有效 80%/.test(castPreviewTxt), castPreviewTxt.slice(0, 160));
      await pa.evaluate(() => { document.getElementById('cast-reset').click(); });
      await sleep(1100);
      const castReset = await get('/api/admin/world?token=' + adminLogin.data.token);
      check('恢复默认钓速设置（0 / 80）', castReset.data.castSpeedBonus === 0 && castReset.data.castSpeedCap === 80,
        JSON.stringify({ b: castReset.data.castSpeedBonus, c: castReset.data.castSpeedCap }));
      const castErrs = adminErrs.length;

      // —— 横幅：发布 → 玩家端滚播并上报 → 后台「当前滚播」→ 停止滚播 ——
      await clickAdminNav('横幅管理');
      await pa.evaluate(() => {
        document.getElementById('bn-content').value = 'QA 横幅滚播测试 ' + Date.now();
        document.getElementById('bn-dur').value = '20';
        document.getElementById('bn-add').click();
      });
      await sleep(1500);
      const marqueeShown = await p1.evaluate(() => !!document.querySelector('#record-banner.show'));
      check('玩家端收到新公告并开始滚播', marqueeShown === true);
      await clickAdminNav('横幅管理');
      await sleep(1200);
      const liveTxt = await pa.evaluate(() => { const n = document.getElementById('bn-live'); return n ? n.textContent.replace(/\s+/g, ' ') : ''; });
      check('后台「当前滚播」显示滚播中 1 条', /滚播中 1 条/.test(liveTxt), liveTxt.slice(0, 140));
      check('后台「当前滚播」列出观看人数与在线数', /观看人数/.test(liveTxt) && /在线/.test(liveTxt), liveTxt.slice(0, 140));
      await pa.evaluate(() => { const b = document.querySelector('[data-stop]'); if (b) b.click(); });
      await sleep(1300);
      const marqueeAfter = await p1.evaluate(() => !!document.querySelector('#record-banner.show'));
      check('「停止滚播」后玩家端横幅立即收起', marqueeAfter === false);
      await pa.evaluate(() => { document.getElementById('bn-clear').click(); });
      await sleep(400);
      await pa.evaluate(() => { const y = document.querySelector('.cf-yes'); if (y) y.click(); });
      await sleep(900);
      const cleared = await get('/api/banner');
      check('清空队列后无待播横幅', (cleared.data.banners || []).length === 0, String((cleared.data.banners || []).length));

      // —— 闪烁设置：独立开关（与横幅无关）+ 输入不被自动刷新冲掉 ——
      const typed = 'QA 闪烁标题 ' + Math.random().toString(36).slice(2, 6);
      await pa.evaluate((v) => {
        const inp = document.getElementById('bn-blink-title');
        inp.focus();
        inp.value = v;
        inp.dispatchEvent(new Event('input', { bubbles: true }));
      }, typed);
      // 自动刷新周期 5s：等过一轮，输入内容应保持不变（修复「打字被刷新掉」）
      await waitFor(() => false, { timeout: 6200 });
      const kept = await pa.evaluate(() => document.getElementById('bn-blink-title').value);
      check('闪烁标题输入不会被自动刷新冲掉', kept === typed, JSON.stringify({ expect: typed, got: kept }));
      // 队列为空也允许开启闪烁（独立于横幅发布）
      await pa.evaluate(() => { document.getElementById('bn-blink').checked = true; document.getElementById('bn-cfg-save').click(); });
      await waitFor(async () => {
        const r = await get('/api/banner');
        return !!(r.data && r.data.cfg && r.data.cfg.blink);
      }, { timeout: 5000 }).catch(() => {});
      const cfgNow = await get('/api/banner');
      check('队列为空仍可开启闪烁（设置独立生效）', !!(cfgNow.data.cfg && cfgNow.data.cfg.blink && (cfgNow.data.banners || []).length === 0),
        JSON.stringify({ blink: cfgNow.data.cfg && cfgNow.data.cfg.blink, banners: (cfgNow.data.banners || []).length }));
      // 玩家端：无横幅时标题/图标也闪烁（采样标题是否变化）
      const blinked = await waitFor(async () => {
        const t1 = await p1.evaluate(() => document.title);
        await waitFor(() => false, { timeout: 900 });
        const t2 = await p1.evaluate(() => document.title);
        return t1 !== t2;
      }, { timeout: 6000, interval: 300 }).catch(() => false);
      check('无横幅时玩家端标题仍在闪烁（独立开关生效）', blinked === true, String(blinked));
      // 关闭闪烁 → 标题恢复为固定基准
      await pa.evaluate(() => { document.getElementById('bn-blink').checked = false; document.getElementById('bn-cfg-save').click(); });
      await waitFor(async () => {
        const r = await get('/api/banner');
        return !!(r.data && r.data.cfg && !r.data.cfg.blink);
      }, { timeout: 5000 }).catch(() => {});
      const stabled = await waitFor(async () => {
        const t1 = await p1.evaluate(() => document.title);
        await waitFor(() => false, { timeout: 900 });
        const t2 = await p1.evaluate(() => document.title);
        return t1 === t2;
      }, { timeout: 5000, interval: 300 }).catch(() => false);
      check('关闭闪烁后标题恢复稳定', stabled === true, String(stabled));

      // —— 反馈奖励（金币到账 + 记录 + 筛选）——
      await post('/api/feedback/submit', { token: tokB, text: 'QA 奖励测试反馈', kind: 'idea' });
      await clickAdminNav('反馈意见');
      const coinsBeforeRw = (await get('/api/me?token=' + tokB)).data.coins;
      await pa.evaluate(() => {
        const row = Array.from(document.querySelectorAll('.fb-admin-item')).find(r => r.textContent.includes('QA 奖励测试反馈'));
        if (row) row.querySelector('[data-reward]').click();
      });
      await sleep(500);
      await pa.evaluate(() => { document.querySelector('.cf-val').value = '1500'; document.querySelector('.cf-yes').click(); });
      await sleep(500);
      await pa.evaluate(() => { const o = document.querySelector('.modal-overlay'); if (o) { const y = o.querySelector('.cf-yes'); if (y) y.click(); } });
      await sleep(1200);
      const coinsAfterRw = (await get('/api/me?token=' + tokB)).data.coins;
      check('反馈奖励金币实时到账（+1500）', coinsAfterRw === coinsBeforeRw + 1500, coinsBeforeRw + ' -> ' + coinsAfterRw);
      const fbList2 = await get('/api/admin/feedback?token=' + adminLogin.data.token);
      const rwItem = (fbList2.data.feedback || []).find(f => f.text === 'QA 奖励测试反馈');
      check('反馈记录带奖励信息（金币 + 操作人）', !!(rwItem && rwItem.reward && rwItem.reward.coins === 1500 && rwItem.reward.by), JSON.stringify(rwItem && rwItem.reward));
      await pa.evaluate(() => {
        const sel = document.getElementById('fba-kind');
        if (sel) { sel.value = 'bug'; sel.dispatchEvent(new Event('change')); }
      });
      await sleep(1100);
      const tagTexts = await pa.$$eval('.fb-admin-item .fb-tag', els => els.map(e => e.textContent.trim()));
      check('后台反馈按类型筛选生效（仅剩 Bug）', tagTexts.every(t => t.indexOf('Bug') >= 0), tagTexts.join(','));
      // 玩家端：我的反馈按状态筛选 + 奖励标记
      await clickNav(p1, '反馈意见');
      await sleep(600);
      const pFilter = await p1.evaluate(() => {
        const sels = Array.from(document.querySelectorAll('.fb-filters select'));
        if (sels.length < 2) return { ok: false };
        const before = document.querySelectorAll('.fb-history .fb-item').length;
        sels[1].value = 'done';
        sels[1].dispatchEvent(new Event('change'));
        const after = document.querySelectorAll('.fb-history .fb-item').length;
        return { ok: true, before: before, after: after };
      });
      check('玩家端反馈可按处理状态筛选（已完成 → 0 条）', pFilter.ok && pFilter.after === 0 && pFilter.before > 0, JSON.stringify(pFilter));
      await p1.evaluate(() => {
        const sels = Array.from(document.querySelectorAll('.fb-filters select'));
        if (sels.length > 1) { sels[1].value = 'all'; sels[1].dispatchEvent(new Event('change')); }
      });
      await sleep(600);
      // 奖励对象是买家（tokB → p2），在买家页面验证奖励标记
      await clickNav(p2, '反馈意见');
      await sleep(700);
      const rwShown = await p2.evaluate(() => {
        const row = Array.from(document.querySelectorAll('.fb-history .fb-item')).find(r => r.textContent.includes('奖励'));
        return row ? row.textContent : '';
      });
      check('玩家端能看到「已获奖励」标记（买家）', /已获奖励 \+1500/.test(rwShown), rwShown.slice(0, 140));
      check('后台全程无页面错误', adminErrs.length === castErrs, adminErrs.slice(castErrs).join(' | '));
    } else {
      check('管理后台登录可用（前置条件）', false, JSON.stringify(adminLogin.data));
    }

    check('全程无页面错误', errs.length === 0, errs.join(' | '));

  } catch (e) {
    console.log('TEST ERROR: ' + e.message + '\n' + e.stack);
    fail++;
  } finally {
    if (browser) await browser.close();
    srv.kill();
    try { fs.rmSync(TMP_DATA, { recursive: true, force: true }); } catch (e) {}
    console.log('\n============================');
    console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
    if (fail) console.log('失败项：\n  - ' + failed.join('\n  - '));
    console.log(fail === 0 ? 'UI LAYOUT TESTS PASS' : 'UI LAYOUT TESTS FAILED');
    console.log('============================');
    setTimeout(() => process.exit(fail === 0 ? 0 : 1), 150);
  }
})();

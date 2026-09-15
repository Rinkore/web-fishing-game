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
// 段落带累计耗时，便于定位「时间花在哪一段」
const T0 = Date.now();
function section(t) { console.log('\n=== ' + t + ' ===  [' + ((Date.now() - T0) / 1000).toFixed(1) + 's]'); }
const sleep = ms => new Promise(r => setTimeout(r, ms));
// 轮询取数：ok(v) 成立即刻返回（本地往返通常几十 ms），超时返回最后一次取值，
// 让后续断言仍能报出真实失败信息。用于替代「点一下 → sleep(1s) → 读接口断言」的固定等待。
async function untilGet(fn, ok, timeout) {
  const deadline = Date.now() + (timeout || 10000);
  for (;;) {
    const v = await fn().catch(() => null);
    if (ok(v)) return v;
    if (Date.now() >= deadline) return v;
    await sleep(25);
  }
}
// 轮询等待某选择器出现（页面/弹窗渲染完成）
function untilSel(page, sel, timeout) {
  return waitFor(async () => (await page.$$(sel)).length > 0, { timeout: timeout || 8000, interval: 25 });
}
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
  // v0.11.3 起侧栏取消「更多」折叠组：全部入口平铺常驻，直接找即可
  const clicked = await page.evaluate(n => {
    const find = () => Array.from(document.querySelectorAll('.nav-item')).find(x => x.textContent.includes(n));
    const b = find();
    if (!b) return false;
    b.click();
    return true;
  }, name);
  if (!clicked) { console.log('  [clickNav] 未找到入口：' + name); }
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
    const NEG_COMP = D_DATA.instanceId('reel_turbo', 'rare', [{ type: 'speed', value: 30 }, { type: 'skill', value: -8 }]);
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
    // v0.11.3 起取消侧栏「更多」折叠组：14 个入口全部平铺常驻（管理员 +1 后台入口）
    check('侧栏 14 个入口全部常驻可见（无折叠组）', (await p1.$$('#nav .nav-item:not(.locked)')).length === 14,
      String((await p1.$$('#nav .nav-item:not(.locked)')).length));
    check('不再有「更多」折叠组与折叠组容器', (await p1.$$('#nav .nav-more')).length === 0 && (await p1.$$('#nav .nav-group')).length === 0);
    check('低频入口（图鉴/记录/反馈/日志）直接可见且顺序不变', await p1.evaluate(() => {
      const t = Array.from(document.querySelectorAll('#nav .nav-item')).map(n => n.textContent)
        .filter(x => /图鉴|记录|反馈|日志/.test(x));
      return t.length === 4 && /图鉴/.test(t[0]) && /记录/.test(t[1]) && /反馈/.test(t[2]) && /日志/.test(t[3]);
    }));
    check('无占位锁定入口（商城与工坊均已开放）', (await p1.$$('#nav .nav-item.locked')).length === 0);
    // 滚动条贴合像素主题：不与主题同色的灰白滚动条 = 回归
    check('侧栏滚动条走主题色（#2c4f74 主题蓝 + 细）', await p1.evaluate(() => {
      const nav = document.getElementById('nav');
      const cs = getComputedStyle(nav);
      const thumb = getComputedStyle(nav, '::-webkit-scrollbar-thumb');
      return /44, 79, 116/.test(cs.scrollbarColor) && cs.scrollbarWidth === 'thin' &&
        /44, 79, 116/.test(thumb.backgroundColor) && getComputedStyle(nav, '::-webkit-scrollbar-track').backgroundColor === 'rgba(0, 0, 0, 0)';
    }));
    check('全局滚动条同样主题化（标准属性，Firefox/新 Chrome 生效）', await p1.evaluate(() => {
      const cs = getComputedStyle(document.documentElement);
      return /44, 79, 116/.test(cs.scrollbarColor) && cs.scrollbarWidth === 'thin';
    }));
    // 矮窗口（1000×560）：14 项放不下时导航区自己滚动，底部提示仍可见
    const pShort = await ctx.newPage();
    await pShort.setViewportSize({ width: 1000, height: 560 });
    await login(pShort, tokS);
    const shortScroll = await pShort.evaluate(() => {
      const nav = document.getElementById('nav');
      const before = nav.scrollTop;
      nav.scrollTop = nav.scrollHeight;
      const foot = document.querySelector('.side-foot');
      const items = nav.querySelectorAll('.nav-item');
      return {
        canScroll: nav.scrollHeight > nav.clientHeight + 1,
        moved: nav.scrollTop > before,
        footVisible: !!foot && foot.getBoundingClientRect().bottom <= window.innerHeight + 1,
        lastVisible: items.length > 0 && items[items.length - 1].getBoundingClientRect().bottom <= window.innerHeight + 1,
      };
    });
    check('矮窗口下侧栏导航区自己滚动（页面不被撑高）',
      shortScroll.canScroll && shortScroll.moved && shortScroll.lastVisible && shortScroll.footVisible,
      JSON.stringify(shortScroll));
    await pShort.close();

    // —— 钓鱼页：已移除背包，渔获日志与左栏底部对齐 ——
    await clickNav(p1, '钓鱼');
    check('钓鱼页不再显示背包模块', (await p1.$$('.fish-live .inventory, .content .inventory')).length === 0);
    check('主界面保留渔获日志（并继续随上鱼刷新）', (await p1.$$('.fish-live .catch-log')).length === 1);
    check('主界面提示完整记录同步到「日志 · 渔获」', await p1.evaluate(() => {
      const n = document.querySelector('.fish-live');
      return !!n && /日志 · 🐟 渔获/.test(n.textContent);
    }), '');
    // 上鱼后主界面日志应自动滚动刷新（走服务器推送 → 前端 catch 分支 → 钓鱼页增量刷新）
    // v0.11.4：上鱼不再整页重建——地图节点 / 水面场景 / 日志旧行都必须是**原来的 DOM 节点**
    //（否则每次上鱼画面闪一下、CSS 动画从头播、底部水波带跟着整屏重绘）。
    const shellProbe = await p1.evaluate(() => {
      const node = document.querySelector('.px-node');
      if (node) node.dataset.probe = 'map';
      window.__probe = {
        node: node,
        water: document.querySelector('.px-scene-water'),
        log: document.querySelector('.fish-live .catch-log'),
        top: document.querySelector('#player-status'),
      };
      return { hasNode: !!node, hasWater: !!window.__probe.water };
    });
    check('钓鱼页探针就位（地图节点 / 水面场景）', shellProbe.hasNode && shellProbe.hasWater, JSON.stringify(shellProbe));
    await post('/api/dev/catch', { token: tokS, item: { kind: 'fish', id: 'minnow', rarity: 'common', name: '麦穗鱼', size: 21 }, ground: '静水湖', spot: '芦苇浅滩' });
    const logGrow = await waitFor(async () => {
      const n = await p1.evaluate(() => document.querySelectorAll('.fish-live .catch-log .log-line').length);
      return n >= 1 ? n : false;
    }, { timeout: 10000, interval: 300 }).catch(() => 0);
    check('主界面渔获日志随上鱼自动刷新', logGrow >= 1, String(logGrow));
    const keptShell = await p1.evaluate(() => {
      const pr = window.__probe || {};
      return {
        node: !!pr.node && document.contains(pr.node) && pr.node.dataset.probe === 'map',
        first: !!pr.node && pr.node === document.querySelector('.px-node'),
        water: !!pr.water && document.contains(pr.water),
        log: !!pr.log && document.contains(pr.log),
        top: !!pr.top && document.contains(pr.top),
      };
    });
    check('上鱼不重建地图节点与水面场景（DOM 原样保留、动画不从头播）',
      keptShell.node && keptShell.first && keptShell.water && keptShell.log, JSON.stringify(keptShell));
    check('顶栏 chips 未变时不重建', keptShell.top === true, JSON.stringify(keptShell));
    // 连续上鱼：新条目插到最前，旧行保持原节点（不整列重画 → 不重播入场动画、滚动位置不跳）
    await p1.evaluate(() => { window.__oldRow = document.querySelector('.fish-live .catch-log .log-line'); });
    await post('/api/dev/catch', { token: tokS, item: { kind: 'fish', id: 'carp', rarity: 'common', name: '鲤鱼', size: 44.2 }, ground: '静水湖', spot: '芦苇浅滩' });
    // waitFor 返回布尔（不是取值）：这里只判断「是否涨到 2 行」
    const logGrow2 = await waitFor(async () => {
      const n = await p1.evaluate(() => document.querySelectorAll('.fish-live .catch-log .log-line').length);
      return n >= 2;
    }, { timeout: 10000, interval: 300 }).catch(() => false);
    check('连续上鱼：日志行累加', logGrow2 === true, String(logGrow2));
    const logKeep = await p1.evaluate(() => {
      const rows = Array.from(document.querySelectorAll('.fish-live .catch-log .log-line'));
      const old = window.__oldRow;
      return { same: !!old && rows.indexOf(old) === 1, newest: rows.length ? rows[0].textContent.slice(0, 20) : '' };
    });
    check('新渔获插到最前、旧日志行保持原节点（旧行不重画）', logKeep.same === true, JSON.stringify(logKeep));
    // v0.11.6：底部滚动的斜纹网格动态层已删除（body::after 去掉，页面不再有一条持续滚动的底纹）
    const wavesGone = await p1.evaluate(() => {
      const cs = getComputedStyle(document.body, '::after');
      return { content: cs.content, anim: cs.animationName, h: cs.height, src: (window.getComputedStyle(document.body, '::before') || {}).content };
    });
    check('底部滚动网格动态层已删除（body::after 无内容、无动画）',
      (wavesGone.content === 'none' || wavesGone.content === '') && !/px-waves/.test(wavesGone.anim),
      JSON.stringify(wavesGone));
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
    // 先站到一个钓点（右栏实况列表仅在钓点时渲染），检查完再取消，保持原有流程状态
    await p1.evaluate(() => { const b = document.querySelector('.px-node'); if (b) b.click(); });
    await waitFor(async () => (await p1.$$('.fish-live .peeps')).length === 1, { timeout: 8000 }).catch(() => {});
    const align = await p1.evaluate(() => {
      const right = document.querySelector('.content > .fish-live');
      const peeps = document.querySelector('.fish-live .peeps');
      if (!right || !peeps) return { ok: false, why: 'no right panel or peeps', hasRight: !!right, hasPeeps: !!peeps };
      const cs = getComputedStyle(peeps);
      return { ok: true, rightBottom: right.getBoundingClientRect().bottom, peepsBottom: peeps.getBoundingClientRect().bottom, maxH: cs.maxHeight };
    });
    check('实况区高度受限（不再撑满/挤占下方）', align.ok && align.maxH !== 'none', JSON.stringify(align));

    // —— 渔场实况场景：游鱼必须来自当前钓点掉落池、朝向必须跟游动方向一致、钓线必须落在浮漂上 ——
    // 回归三处：① 三条写死的贴图（沙丁/鲤鱼/鲈鱼）与所钓钓点无关；② 左右两个方向都在用反的镜像，
    // 贴图鱼头朝左 => 向右游时看着就是「倒着游」；③ 钓线右端比浮漂偏左约 60px 且带 rotate，错位。
    const sceneChk = await p1.evaluate(() => {
      const S = window.Engine.state, G = window.GameData.GROUNDS;
      const ids = pool => (pool || []).filter(e => /^fish:/.test(e.pick)).map(e => e.pick.slice(5));
      const g = G.find(x => x.id === S.player.groundId);
      const sp = g && (g.spots || []).find(x => x.id === S.player.spotId);
      const scene = document.querySelector('.fish-live .px-scene');
      const imgs = scene ? Array.from(scene.querySelectorAll('.px-fish')) : [];
      const line = scene && scene.querySelector('.px-scene-line');
      const bob = scene && scene.querySelector('.px-scene-bobber');
      const lb = line && line.getBoundingClientRect(), bb = bob && bob.getBoundingClientRect();
      const r1 = v => Math.round(v * 10) / 10;
      return {
        atSpot: !!sp, poolAttr: scene && scene.getAttribute('data-pool'),
        allowed: sp ? ids(sp.pool) : (g ? [].concat.apply([], (g.spots || []).map(x => ids(x.pool))) : []),
        fish: imgs.map(im => {
          const anim = im.getAnimations()[0];
          const kf = (anim && anim.effect) ? anim.effect.getKeyframes() : [];
          return {
            id: im.dataset.fish, lane: im.dataset.lane, cls: im.className,
            w: Math.round(im.getBoundingClientRect().width),
            tf: kf.map(k => k.transform).filter(Boolean),
            left: kf.map(k => k.left).filter(Boolean),
          };
        }),
        line: lb && { right: r1(lb.right), bottom: r1(lb.bottom) },
        bob: bb && { cx: r1(bb.left + bb.width / 2), top: r1(bb.top) },
      };
    });
    check('实况游鱼都在当前钓点掉落池里', sceneChk.atSpot && !!sceneChk.poolAttr && sceneChk.allowed.length > 3 &&
      sceneChk.fish.length === 4 && sceneChk.fish.every(f => sceneChk.allowed.indexOf(f.id) >= 0),
      JSON.stringify({ poolAttr: !!sceneChk.poolAttr, allowed: sceneChk.allowed.length, fish: sceneChk.fish.map(f => f.id) }));
    // 朝向＝游动方向：贴图鱼头朝左，所以向右游的每一帧都必须是 scaleX(-1)、向左游必须是 scaleX(1)。
    // 两层证据：① 关键帧——镜像符号与类名一致，且起止位置一端是 100%（右侧画外）；
    // ② 行为——手动把动画时间轴拨到 25%/75% 量同一条鱼的实际位移方向（不依赖动画时钟是否在走，
    //    并行跑测试时页面被遮挡、动画时钟会停）。
    const kfOk = f => {
      const right = /swim-r/.test(f.cls);
      const tfOk = f.tf.length >= 2 && f.tf.every(t => {
        const m = /^matrix\((-?[\d.]+)/.exec(t) || /^scaleX\((-?[\d.]+)\)/.exec(t);
        return !!m && (parseFloat(m[1]) < 0) === right;
      });
      const a = f.left[0], b = f.left[1];
      return tfOk && (right ? (a !== '100%' && b === '100%') : (a === '100%' && b !== '100%'));
    };
    const moveChk = await p1.evaluate(() => {
      const scene = document.querySelector('.fish-live .px-scene');
      return Array.from(scene.querySelectorAll('.px-fish')).map(im => {
        try {
          const a = im.getAnimations()[0];
          const tm = (a && a.effect) ? a.effect.getTiming() : null;
          const dur = tm ? Number(tm.duration) : 0;
          if (!dur) return { id: im.dataset.fish };
          // 开局几条鱼用负延迟错开（animation-delay 为负），currentTime 是「本地时间」，
          // 要加上 delay 才落在有效进度上，否则会 seek 到动画还没开始的阶段、量到位移假象。
          const delay = Number(tm.delay) || 0;
          const keep = Number(a.currentTime) || 0;
          a.currentTime = delay + dur * .25;
          const x1 = im.getBoundingClientRect().left;
          a.currentTime = delay + dur * .75;
          const x2 = im.getBoundingClientRect().left;
          const cs = getComputedStyle(im);
          const m = /^matrix\((-?[\d.]+)/.exec(cs.transform) || /^scaleX\((-?[\d.]+)\)/.exec(cs.transform);
          a.currentTime = keep;                       // 拨回去，别把实况画面留在半路上
          return { id: im.dataset.fish, dx: Math.round(x2 - x1), sx: m ? parseFloat(m[1]) : null };
        } catch (e) { return { id: im.dataset.fish, err: String(e.message) }; }
      });
    });
    // ② 行为证据：把时间轴拨到 25%/75% 量同一条鱼的实际位移方向。9 路并行跑时页面被遮挡、
    //    动画时间轴会停摆，seek 未必真的作用到渲染上（位移量会是 0 或几像素的噪声），
    //    所以只采信「位移量 ≥ 画面宽 1/10」的样本；一个可用样本都没有时只由关键帧兜底。
    const sceneW = await p1.evaluate(() => document.querySelector('.px-scene').getBoundingClientRect().width);
    const usable = moveChk.filter(f => f.sx != null && f.dx != null && Math.abs(f.dx) >= sceneW * .1);
    check('实况游鱼朝向与游动方向一致（不再倒着游）',
      sceneChk.fish.every(kfOk) && (usable.length === 0 || usable.every(f => (f.sx < 0) === (f.dx > 0))),
      JSON.stringify({ kf: sceneChk.fish.map(f => f.cls), move: moveChk }));
    check('实况游鱼按泳道分层、按体型缩放', sceneChk.fish.map(f => f.lane).join(',') === '0,1,2,3' &&
      sceneChk.fish.every(f => f.w >= 26 && f.w <= 76),
      JSON.stringify(sceneChk.fish.map(f => f.lane + ':' + f.id + ':' + f.w)));
    check('钓线右端落在浮漂中心（不再错位）',
      !!sceneChk.line && !!sceneChk.bob && Math.abs(sceneChk.line.right - sceneChk.bob.cx) <= 2,
      JSON.stringify({ line: sceneChk.line, bob: sceneChk.bob }));
    // 钓线要比漂尾低一点（重叠），浮漂上下跳动 ±4px 时才不会跟钓线断开
    const overlap = sceneChk.line && sceneChk.bob ? sceneChk.line.bottom - sceneChk.bob.top : -1;
    check('钓线接到漂尾（浮漂跳动时也不脱开）', overlap >= 1 && overlap <= 12, '重叠 ' + overlap + 'px');

    // —— 系统商店 ——
    await clickNav(p1, '系统商店');
    // 商店卡片由 fetchShop 异步填充：并行负载下点击返回时数据可能刚到一半，轮询到再断言
    await waitFor(async () => (await p1.$$('.shop-card')).length >= 15, { timeout: 8000 }).catch(() => {});
    check('系统商店渲染出价格卡片', (await p1.$$('.shop-card')).length >= 15, String((await p1.$$('.shop-card')).length));
    check('商店卡片显示动态价格与百分比', /当前 \d+%/.test(await p1.textContent('.sc-pct')));
    check('系统商店页已移除背包模块', (await p1.$$('.inventory, .col-side')).length === 0);
    // 商店头部文案跟随后台经济参数（默认 每件 -0.75% / 60 分钟 / 2 倍）
    const shopSub = await p1.textContent('#shop-sub');
    check('商店头部文案由经济参数生成（-0.75% / 1 小时 / 2 倍）',
      /每卖一件约 -0\.75%/.test(shopSub) && /1 小时/.test(shopSub) && /2 倍/.test(shopSub), shopSub);

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
    // 选中词条 → 排序自动切到「按该词条数值」；切回「全部属性」再恢复稀有度。
    // （用钓速：卷线器的组件都带钓速词条；若用体型，卷线器没有该词条会得到空列表）
    const sortCheck = await p1.evaluate(() => {
      const modal = document.querySelector('.bd-equip-modal');
      const btn = (txt) => Array.from(modal.querySelectorAll('.bf-cat')).find(b => b.textContent.trim() === txt);
      const speed = btn('⚡ 钓速');
      if (!speed) return { ok: false, why: 'no speed filter' };
      speed.click();
      const on = Array.from(modal.querySelectorAll('.bf-sort-btn')).find(b => b.classList.contains('on'));
      const vals = Array.from(modal.querySelectorAll('.bec-card')).map(c => {
        const m = /([+-]?\d+)%\s*钓速/.exec(c.textContent);
        return m ? Number(m[1]) : null;
      }).filter(v => v !== null);
      const all = btn('全部属性');
      if (all) all.click();                      // 恢复筛选（模块级状态会跨用例保留）
      const on2 = Array.from(modal.querySelectorAll('.bf-sort-btn')).find(b => b.classList.contains('on'));
      return { ok: true, sortLabel: on ? on.textContent.trim() : '', vals: vals, restored: on2 ? on2.textContent.trim() : '' };
    });
    check('选中词条后排序自动切到该词条值', sortCheck.ok && /钓速值/.test(sortCheck.sortLabel) && sortCheck.sortLabel.includes('↓'),
      JSON.stringify(sortCheck));
    check('列表按该词条数值降序排列', (function (a) { if (!a.length) return false; for (let i = 1; i < a.length; i++) if (a[i] > a[i - 1]) return false; return true; })(sortCheck.vals),
      JSON.stringify(sortCheck.vals));
    check('切回全部属性后排序恢复稀有度', /稀有度/.test(sortCheck.restored), sortCheck.restored);
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
    // v0.11.4：技巧（skill）词缀必须进「加成总览」——旧代码的键集写的是已废弃的 big，
    // 少一个 skill 键就让「技巧」加成**整条不显示**（服务器侧键集一直是 7 个）。
    const effKeys = await p1.evaluate(() => Object.keys(window.Engine.bdEffects()));
    check('钓竿加成键集 = 组件词缀全集（含技巧，不含已废弃的 big）',
      effKeys.indexOf('skill') >= 0 && effKeys.indexOf('big') < 0, JSON.stringify(effKeys));
    const stripSkill = await p1.evaluate(() => ({
      text: (document.querySelector('.eff-strip') || {}).textContent.replace(/\s+/g, ' ').trim() || '',
      skill: window.Engine.bdEffects().skill,
    }));
    check('装备带「技巧」词缀的组件后加成总览显示技巧（含负值）',
      /技巧 -?\d+%/.test(stripSkill.text) && stripSkill.skill < 0, JSON.stringify(stripSkill));

      // —— 市集一键上架（简易分类 + 多选）· 实况滑动栏 · 日志渔获分列 ——
      section('市集一键上架（真实 Chrome）');
      await clickNav(p1, '开放市集');
      await waitFor(async () => (await p1.$$('.mkt-cats .inv-cat')).length >= 4, { timeout: 8000 }).catch(() => {});
      check('市集右栏「我的背包」有简易分类', (await p1.$$('.mkt-cats .inv-cat')).length >= 4, String((await p1.$$('.mkt-cats .inv-cat')).length));
      await p1.evaluate(() => { const b = Array.from(document.querySelectorAll('.mkt-cats .inv-cat')).find(x => x.textContent.includes('鱼类')); if (b) b.click(); });
      await sleep(500);
      const catFiltered = await p1.evaluate(() => ({
        rows: document.querySelectorAll('.mkt-sell-row').length,
        kinds: Array.from(document.querySelectorAll('.mkt-sell-row .kind-tag')).length,
      }));
      check('分类筛选后只列该类物品（鱼类行可勾选）', catFiltered.rows >= 1, JSON.stringify(catFiltered));
      // —— 组件行显示词条（便于挑选要挂单的组件；含数值区间）——
      // 先注入一件确定性的双词条组件，避免依赖此前用例留下的背包状态
      const AFF_COMP = D_DATA.instanceId('reel_turbo', 'epic', [{ type: 'speed', value: 35 }, { type: 'skill', value: -9 }]);
      await post('/api/dev/catch', { token: tokS, item: { kind: 'component', id: AFF_COMP } });
      let compAff = { rows: 0, withAff: 0, text: '', hasRange: false, hasName: false };
      const affOk = await waitFor(async () => {
        // 点「组件」分类（每次轮询重试：面板可能被行情广播重绘，点击需落在当前 DOM 上）
        await p1.evaluate(() => {
          const b = Array.from(document.querySelectorAll('.mkt-cats .inv-cat')).find(x => x.textContent.includes('组件'));
          if (b && !b.classList.contains('on')) b.click();
        });
        compAff = await p1.evaluate(() => {
          const rows = Array.from(document.querySelectorAll('.mkt-sell-row'));
          const withAff = rows.filter(r => r.querySelector('.mkt-sell-aff .inst-aff'));
          const first = withAff[0] ? withAff[0].querySelector('.mkt-sell-aff') : null;
          return {
            rows: rows.length, withAff: withAff.length,
            text: first ? first.textContent : '',
            hasRange: first ? !!first.querySelector('.aff-rng') : false,
            hasName: withAff[0] ? !!withAff[0].querySelector('.mkt-sell-name') : false,
          };
        });
        return compAff.withAff >= 1 && compAff.hasRange && compAff.hasName;
      }, { timeout: 12000, interval: 400 }).catch(() => false);
      check('挂单列表的组件行显示词条（含数值区间）', affOk === true, JSON.stringify(compAff).slice(0, 200));
      check('组件词条文案形如「+N% 效果（区间）」', /[+-]\d+%/.test(compAff.text) && /（.*%）/.test(compAff.text), compAff.text.slice(0, 120));
      // —— 滚动位置保持：勾选下方物品不再把列表弹回顶部（此前 change → renderView 整页重绘）——
      await p1.evaluate(() => { const b = Array.from(document.querySelectorAll('.mkt-cats .inv-cat')).find(x => x.textContent.includes('全部')); if (b) b.click(); });
      await waitFor(async () => (await p1.$$('.mkt-sell-row')).length >= 3, { timeout: 5000 }).catch(() => {});
      const scrollKeep = await p1.evaluate(() => {
        const list = document.querySelector('.mkt-sell-list');
        if (!list) return { ok: false };
        const scrollable = list.scrollHeight > list.clientHeight;
        list.scrollTop = 100;
        const before = list.scrollTop;
        const boxes = Array.from(list.querySelectorAll('input[type=checkbox]'));
        const last = boxes[boxes.length - 1];
        if (last) { last.checked = true; last.dispatchEvent(new Event('change', { bubbles: true })); }
        const list2 = document.querySelector('.mkt-sell-list');
        const btn = document.querySelector('.mkt-sell-foot .primary');
        return { ok: true, scrollable: scrollable, before: before, after: list2 ? list2.scrollTop : -1, same: list2 === list, btn: btn ? btn.textContent : '' };
      });
      check('挂单列表可滚动（前置条件）', scrollKeep.ok && scrollKeep.scrollable === true, JSON.stringify(scrollKeep));
      check('勾选最下方物品后列表不重绘（同一 DOM 节点）', scrollKeep.same === true, JSON.stringify(scrollKeep));
      check('勾选后滚动位置保持（不再弹回顶部）', scrollKeep.before > 0 && scrollKeep.after === scrollKeep.before, JSON.stringify(scrollKeep));
      check('勾选后底部按钮就地更新（已选数量）', /已选 \d/.test(scrollKeep.btn || ''), String(scrollKeep.btn));
      // —— 资产广播（上鱼）不再重建右栏：滚动位置、勾选与底部计数在广播后全部保留 ——
      // 此前 patchMarketAssets 是整块 replaceWith，每条广播都把列表弹回顶部、换掉正在点的勾选框，
      // 表现就是「选不到下面要上架的物品」。
      const bcastComp = D_DATA.instanceId('reel_turbo', 'rare', [{ type: 'speed', value: 12 }]);
      await p1.evaluate(inst => {
        window.__mktNewId = inst;
        const list = document.querySelector('.mkt-sell-list');
        if (!list) return;
        list.scrollTop = 100;
        window.__mktList = list;
        window.__mktScroll = list.scrollTop;
      }, bcastComp);
      await post('/api/dev/catch', { token: tokS, item: { kind: 'component', id: bcastComp } });
      await waitFor(async () => p1.evaluate(() => Array.from(document.querySelectorAll('.mkt-sell-row'))
        .some(r => r.getAttribute('data-mkt-id') === window.__mktNewId)), { timeout: 8000, interval: 100 }).catch(() => {});
      const bcast = await p1.evaluate(() => {
        const list = document.querySelector('.mkt-sell-list');
        const boxes = list ? Array.from(list.querySelectorAll('input[type=checkbox]')) : [];
        const batchBtn = document.querySelector('.mkt-sell-foot .primary');
        const rows = list ? Array.from(list.querySelectorAll('.mkt-sell-row')) : [];
        return {
          same: list === window.__mktList,
          before: window.__mktScroll,
          top: list ? list.scrollTop : -1,
          checked: boxes.filter(c => c.checked).length,
          hasNew: rows.some(r => r.getAttribute('data-mkt-id') === window.__mktNewId),
          rows: rows.length,
          btn: batchBtn ? batchBtn.textContent : '',
        };
      });
      check('上鱼广播后右栏列表仍是同一 DOM 节点（不重建）', bcast.same === true, JSON.stringify(bcast));
      check('上鱼广播后列表没被弹回顶部', bcast.before > 0 && bcast.top > 0, JSON.stringify(bcast));
      check('上鱼广播后的勾选与底部计数保留', bcast.checked === 1 && /已选 1/.test(bcast.btn || ''), JSON.stringify(bcast));
      check('上鱼广播后新渔获就地进列表（不是整页重绘的假象）', bcast.hasNew === true && bcast.rows >= 3, JSON.stringify(bcast));
      // 清理：取消刚才的勾选，回到鱼类分类（不影响后续「一键上架」用例）
      await p1.evaluate(() => {
        const list = document.querySelector('.mkt-sell-list');
        if (list) list.querySelectorAll('input[type=checkbox]').forEach(cb => { if (cb.checked) { cb.checked = false; cb.dispatchEvent(new Event('change', { bubbles: true })); } });
        const b = Array.from(document.querySelectorAll('.mkt-cats .inv-cat')).find(x => x.textContent.includes('鱼类'));
        if (b) b.click();
      });
      await sleep(300);
      // 多选两件 → 一键上架
      const beforeListings = (await get('/api/market')).data.listings.length;
      await p1.evaluate(() => {
        const boxes = Array.from(document.querySelectorAll('.mkt-sell-row input[type=checkbox]')).slice(0, 2);
        boxes.forEach(cb => { cb.checked = true; cb.dispatchEvent(new Event('change', { bubbles: true })); });
      });
      await waitFor(async () => (await p1.$$('.mkt-sell-foot .primary')).length === 1, { timeout: 5000 }).catch(() => {});
      const batchBtn = await p1.evaluate(() => { const b = document.querySelector('.mkt-sell-foot .primary'); return b ? b.textContent : ''; });
      check('多选后出现「一键上架」按钮并显示已选数量', /一键上架（已选 [12]）/.test(batchBtn), String(batchBtn));
      await p1.evaluate(() => { const b = document.querySelector('.mkt-sell-foot .primary'); if (b) b.click(); });
      await waitFor(async () => (await p1.$$('#bl-go')).length === 1, { timeout: 6000 }).catch(() => {});
      const blModal = await p1.evaluate(() => ({
        go: !!document.getElementById('bl-go'),
        mult: (document.getElementById('bl-mult') || {}).value || '',
        hours: document.querySelectorAll('.lm-hours').length,
        rows: document.querySelectorAll('.bl-rows .bl-row').length,
        est: (document.getElementById('bl-est') || {}).textContent || '',
      }));
      check('一键上架子窗口含倍率/时长/清单/预计费用', blModal.go && blModal.hours === 3 && blModal.rows >= 2 && /上架费合计/.test(blModal.est), JSON.stringify(blModal).slice(0, 160));
      await p1.evaluate(() => { const b = document.getElementById('bl-go'); if (b) b.click(); });
      const listed = await waitFor(async () => {
        const mk = await get('/api/market');
        return mk.data.listings.length - beforeListings >= 2;
      }, { timeout: 10000, interval: 250 }).catch(() => false);
      check('一键上架成功挂出多件（≥2 条新挂单）', listed === true, String(listed));
      await clickNav(p1, '钓鱼');
      // 站到一个钓点（右栏实况仅在钓点时渲染；点未激活的钓点，避免取消当前钓鱼）
      await p1.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('.spot-btn'));
        const target = btns.find(b => !b.classList.contains('on')) || btns[0];
        if (target) target.click();
      });
      await waitFor(async () => (await p1.$$('.peeps.scroll5')).length === 1, { timeout: 8000 }).catch(() => {});
      const peepArea = await p1.evaluate(() => {
        const n = document.querySelector('.peeps.scroll5');
        if (!n) return { ok: false };
        const cs = getComputedStyle(n);
        return { ok: true, maxH: cs.maxHeight, overflow: cs.overflowY, head: (document.querySelector('.peeps-head') || {}).textContent || '' };
      });
      check('实况列表限制同屏高度并可下滑（5 条）', peepArea.ok && peepArea.maxH !== 'none' && peepArea.overflow === 'auto', JSON.stringify(peepArea));
      check('实况标题显示同钓点人数与下滑提示', /同钓点/.test(peepArea.head || ''), String(peepArea.head));
      await clickNav(p1, '日志');
      await waitFor(async () => (await p1.$$('.inv-cats .inv-cat')).length >= 6, { timeout: 6000 }).catch(() => {});
      const logTabs = await p1.evaluate(() => Array.from(document.querySelectorAll('.inv-cats .inv-cat')).map(b => b.textContent.trim()));
      check('日志页新增「🐟 渔获」分列', logTabs.some(t => /渔获/.test(t)), JSON.stringify(logTabs).slice(0, 160));
      const catchTab = await p1.evaluate(() => {
        const b = Array.from(document.querySelectorAll('.inv-cats .inv-cat')).find(x => x.textContent.includes('渔获'));
        if (b) b.click();
        return true;
      });
      void catchTab;
      await sleep(500);
      const catchLog = await p1.evaluate(() => (document.querySelector('.log-page') || {}).textContent || '');
      check('渔获分列可筛选（有记录或空态提示）', /钓到|还没有|没有记录/.test(catchLog), catchLog.slice(0, 120));

      // —— 背包改版：子分类筛选（品质 / 部位 / 词条数值）+ 可展开分组 + 逐件出售 ——      // —— 背包改版：子分类筛选（品质 / 部位 / 词条数值）+ 可展开分组 + 逐件出售 ——
      section('背包分类改版（真实 Chrome）');
      // 前置：发一批不同部位/词条的组件与不同稀有度的鱼
      const bagInsts = [
        D_DATA.instanceId('rod_carbon', 'rare', [{ type: 'speed', value: 18 }, { type: 'material', value: -8 }, { type: 'size', value: 3 }]),
        D_DATA.instanceId('rod_carbon', 'common', [{ type: 'speed', value: 20 }]),
        D_DATA.instanceId('reel_turbo', 'rare', [{ type: 'speed', value: 30 }, { type: 'skill', value: -8 }]),
        D_DATA.instanceId('charm_jade', 'rare', [{ type: 'size', value: 21 }, { type: 'speed', value: -5 }]),
      ];
      for (const id of bagInsts) await post('/api/dev/catch', { token: tokS, item: { kind: 'component', id: id } });
      await post('/api/dev/catch', { token: tokS, item: { kind: 'fish', id: 'koi', rarity: 'rare', name: '黄金锦鲤', size: 70 } });
      await clickNav(p1, '背包');
      await waitFor(async () => (await p1.$$('.inv-cats .inv-cat')).length >= 4, { timeout: 6000 }).catch(() => {});
      // 组件分类 → 部位子筛选 + 折叠分组
      await p1.evaluate(() => { const b = Array.from(document.querySelectorAll('.inv-cats .inv-cat')).find(x => x.textContent.includes('组件')); if (b) b.click(); });
      await waitFor(async () => (await p1.$$('.inv-subrow')).length >= 2, { timeout: 5000 }).catch(() => {});
      const subInfo = await p1.evaluate(() => {
        const rows = Array.from(document.querySelectorAll('.inv-subrow'));
        return {
          rows: rows.length,
          partChips: rows[0] ? Array.from(rows[0].querySelectorAll('button')).map(b => b.textContent.trim()) : [],
          hasAffixSel: !!document.querySelector('.inv-subrow select'),
          nums: document.querySelectorAll('.inv-subrow .aff-num').length,
          heads: document.querySelectorAll('.inv-group-head').length,
          openRows: document.querySelectorAll('.inv-comp-row').length,
        };
      });
      check('组件分类有「部位」子分类（一级）', subInfo.partChips.some(t => /竿身/.test(t)) && subInfo.partChips.some(t => /卷线器/.test(t)), JSON.stringify(subInfo.partChips).slice(0, 120));
      check('组件分类有「词条 + 数值范围」子分类（二级）', subInfo.hasAffixSel && subInfo.nums === 2, JSON.stringify({ sel: subInfo.hasAffixSel, nums: subInfo.nums }));
      check('组件按底材名分组且默认折叠', subInfo.heads >= 2 && subInfo.openRows === 0, JSON.stringify({ heads: subInfo.heads, open: subInfo.openRows }));
      // 点开一个分组 → 逐件显示（属性 + 单独出售）
      await p1.evaluate(() => { const h = document.querySelector('.inv-group-head.clickable'); if (h) h.click(); });
      await waitFor(async () => (await p1.$$('.inv-comp-row')).length >= 1, { timeout: 5000 }).catch(() => {});
      const opened = await p1.evaluate(() => {
        const row = document.querySelector('.inv-comp-row');
        return row ? {
          affs: row.querySelectorAll('.inst-aff').length,
          acts: Array.from(row.querySelectorAll('.inv-acts button')).map(b => b.textContent.trim()),
        } : null;
      });
      check('展开分组后逐件显示词条属性', !!opened && opened.affs >= 1, JSON.stringify(opened).slice(0, 120));
      check('每件组件可单独出售/上架/看属性', !!opened && ['属性', '出售 1', '批量出售', '上架'].every(k => opened.acts.some(a => a.indexOf(k) >= 0)), JSON.stringify(opened && opened.acts));
      // 部位筛选：只看竿身
      await p1.evaluate(() => { const b = Array.from(document.querySelectorAll('.inv-subrow button')).find(x => x.textContent.includes('竿身')); if (b) b.click(); });
      await sleep(500);
      const partFiltered = await p1.evaluate(() => {
        const heads = Array.from(document.querySelectorAll('.inv-group-head')).map(h => h.textContent.replace(/\s+/g, ' '));
        return { heads: heads.length, text: heads.join('|') };
      });
      check('按部位筛选后只保留该部位的底材分组', partFiltered.heads >= 1 && !/卷线器/.test(partFiltered.text) && !/鲤玉/.test(partFiltered.text), JSON.stringify(partFiltered).slice(0, 140));
      check('筛选后仅一组时自动展开（省一次点击）', (await p1.$$('.inv-comp-row')).length >= 1, String((await p1.$$('.inv-comp-row')).length));
      // 词条数值筛选
      await p1.selectOption('.inv-subrow select', 'speed');
      await sleep(300);
      await p1.fill('.inv-subrow .aff-num', '19');
      await p1.evaluate(() => { const n = document.querySelectorAll('.inv-subrow .aff-num')[0]; n.dispatchEvent(new Event('change', { bubbles: true })); });
      await sleep(500);
      const affFiltered = await p1.evaluate(() => {
        const rows = Array.from(document.querySelectorAll('.inv-comp-row'));
        return { rows: rows.length, affs: rows.map(r => r.textContent.replace(/\s+/g, ' ').slice(0, 60)) };
      });
      check('按词条 + 数值范围筛选生效（钓速 ≥19）', affFiltered.rows >= 1 && affFiltered.affs.every(t => /钓速/.test(t)), JSON.stringify(affFiltered).slice(0, 160));
      // 鱼类：品质子分类
      await p1.evaluate(() => { const b = Array.from(document.querySelectorAll('.inv-cats .inv-cat')).find(x => x.textContent.includes('鱼类')); if (b) b.click(); });
      await waitFor(async () => (await p1.$$('.inv-subrow button')).length >= 3, { timeout: 5000 }).catch(() => {});
      const rarChips = await p1.evaluate(() => Array.from(document.querySelectorAll('.inv-subrow button')).map(b => b.textContent.trim()));
      check('鱼类分类显示「品质」子分类', rarChips.some(t => /普通/.test(t)) && rarChips.some(t => /稀有/.test(t)), JSON.stringify(rarChips).slice(0, 120));
      await p1.evaluate(() => { const b = Array.from(document.querySelectorAll('.inv-subrow button')).find(x => x.textContent.includes('稀有')); if (b) b.click(); });
      await sleep(500);
      const rarFiltered = await p1.evaluate(() => {
        const rows = Array.from(document.querySelectorAll('.col-main .inv-page .inv-row'));
        return { n: rows.length, common: rows.filter(r => r.querySelector('.r-common')).length, names: rows.map(r => (r.querySelector('span') || {}).textContent || '') };
      });
      check('按品质筛选后排除普通品质（无 r-common 行）', rarFiltered.n >= 1 && rarFiltered.common === 0, JSON.stringify(rarFiltered).slice(0, 140));

      // —— 钓竿存档：槽位栏 / 购买 / 保存命名 / 切换 / 锁定标记 / 市集钓竿分类 ——
      section('钓竿存档与槽位（真实 Chrome）');
      // 前置（走接口，UI 只测槽位栏本身）：发组件 → 装备 → 给金币
      const rodComp = D_DATA.instanceId('rod_carbon', 'rare', [{ type: 'speed', value: 18 }, { type: 'material', value: -8 }, { type: 'size', value: 3 }]);
      await post('/api/dev/catch', { token: tokS, item: { kind: 'component', id: rodComp } });
      await post('/api/dev/seed', { token: tokS, coins: 500000 });
      const eqRod = await post('/api/bd/set', { token: tokS, part: 'rod', compId: rodComp });
      check('前置：装备竿身组件成功', eqRod.status === 200, JSON.stringify(eqRod.data).slice(0, 100));
      await clickNav(p1, '钓竿配置');
      await waitFor(async () => (await p1.$$('.rs-card')).length === 8, { timeout: 8000 }).catch(() => {});
      check('钓竿配置页出现 8 个槽位卡片', (await p1.$$('.rs-card')).length === 8, String((await p1.$$('.rs-card')).length));
      check('槽位栏显示当前钓竿与命名入口', await p1.evaluate(() => {
        const n = document.querySelector('.rod-slots');
        return !!n && /我的钓竿/.test(n.textContent) && !document.getElementById('rs-rename-cur') && !document.getElementById('rs-stow');
      }), '');
      check('未购买槽位显示价格与购买按钮', await p1.evaluate(() => {
        const cards = Array.from(document.querySelectorAll('.rs-card'));
        const c = cards[1];
        return !!c && /购买需/.test(c.textContent) && Array.from(c.querySelectorAll('button')).some(b => b.textContent.includes('购买'));
      }), '');
      // 购买槽位 2
      const coinsBefore = (await get('/api/me?token=' + tokS)).data.coins;
      await p1.evaluate(() => {
        const cards = Array.from(document.querySelectorAll('.rs-card'));
        const b = cards[1] && Array.from(cards[1].querySelectorAll('button')).find(x => x.textContent.includes('购买'));
        if (b) b.click();
      });
      await waitFor(async () => (await p1.$$('.cf-ok')).length === 1, { timeout: 5000 }).catch(() => {});
      await p1.evaluate(() => { const b = document.querySelector('.cf-ok'); if (b) b.click(); });
      const bought = await waitFor(async () => (await get('/api/me?token=' + tokS)).data.rodSlotsCount === 2, { timeout: 8000, interval: 150 }).catch(() => false);
      const meBought = await get('/api/me?token=' + tokS);
      check('UI 购买槽位 2 成功（扣 1w）', bought === true && meBought.data.coins === coinsBefore - 10000, JSON.stringify({ bought: bought, coins: meBought.data.coins, before: coinsBefore }));
      // 保存当前钓竿到槽位 2 并命名
      await clickNav(p1, '钓竿配置');
      await p1.evaluate(() => {
        const cards = Array.from(document.querySelectorAll('.rs-card'));
        const b = cards[1] && Array.from(cards[1].querySelectorAll('button')).find(x => x.textContent.includes('保存当前钓竿'));
        if (b) b.click();
      });
      await waitFor(async () => (await p1.$$('.cf-input')).length === 1, { timeout: 6000 }).catch(() => {});
      check('保存弹窗可输入钓竿名', (await p1.$$('.cf-input')).length === 1);
      // v0.11.4：弹窗输入框（钓竿改名 / 存档命名）文字统一亮色，深底上不吃默认近黑色
      check('弹窗输入框文字为亮色（可辨识）', await p1.evaluate(() => {
        const inp = document.querySelector('.cf-input');
        if (!inp) return false;
        const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(getComputedStyle(inp).color || '');
        return !!m && (Number(m[1]) + Number(m[2]) + Number(m[3])) / 3 > 180;
      }));
      await p1.evaluate(() => {
        const inp = document.querySelector('.cf-input');
        if (inp) inp.value = 'QA·钓速竿';
        const ok = document.querySelector('.cf-ok');
        if (ok) ok.click();
      });
      const savedOk = await waitFor(async () => {
        const me = await get('/api/me?token=' + tokS);
        return !!(me.data.rodSlots && me.data.rodSlots[1] && me.data.rodSlots[1].name === 'QA·钓速竿');
      }, { timeout: 8000, interval: 200 }).catch(() => false);
      check('保存钓竿到槽位并命名（UI 流程）', savedOk === true, String(savedOk));
      const afterSave = await get('/api/me?token=' + tokS);
      check('存档后仍保持装戴（保存=占用槽位，不再收起）', !!(afterSave.data.bd && afterSave.data.bd.rod && afterSave.data.bd.rod.compId), JSON.stringify(afterSave.data.bd && afterSave.data.bd.rod));
      check('存档后槽位标记为使用中', afterSave.data.rodActiveSlot === 1, String(afterSave.data.rodActiveSlot));
      await clickNav(p1, '钓竿配置');
      const slotCard = await p1.evaluate(() => {
        const cards = Array.from(document.querySelectorAll('.rs-card'));
        const c = cards[1];
        return c ? { text: c.textContent.replace(/\s+/g, ' '), acts: Array.from(c.querySelectorAll('button')).map(b => b.textContent.trim()) } : null;
      });
      check('槽位卡片显示钓竿名与词条', !!slotCard && /QA·钓速竿/.test(slotCard.text) && /钓速/.test(slotCard.text), JSON.stringify(slotCard).slice(0, 140));
      check('槽位卡片提供 使用/改名/上架/删除', !!slotCard && ['使用', '改名', '上架', '删除'].every(k => slotCard.acts.some(a => a.indexOf(k) >= 0)), JSON.stringify(slotCard && slotCard.acts));
      await p1.evaluate(() => {
        const cards = Array.from(document.querySelectorAll('.rs-card'));
        const b = cards[1] && Array.from(cards[1].querySelectorAll('button')).find(x => x.textContent.trim() === '使用');
        if (b) b.click();
      });
      const usedOk = await waitFor(async () => {
        const me = await get('/api/me?token=' + tokS);
        return !!(me.data.bd && me.data.bd.rod && me.data.bd.rod.compId);
      }, { timeout: 8000, interval: 200 }).catch(() => false);
      check('点「使用」切换回该钓竿（装备恢复）', usedOk === true, String(usedOk));
      const afterUse = await get('/api/me?token=' + tokS);
      check('使用不腾空原槽位（钓竿留在槽位里）', !!(afterUse.data.rodSlots && afterUse.data.rodSlots[1] && afterUse.data.rodSlots[1].name === 'QA·钓速竿'),
        JSON.stringify((afterUse.data.rodSlots || []).map(function (x) { return x && x.name; })));
      check('槽位卡片显示「使用中」标记', await p1.evaluate(() => !!document.querySelector('.rs-active')), '');
      // 「收起」已移到使用中的槽位卡上（与「删除」并排）；页头不再有独立的命名/收起按钮
      const rodBtns = await p1.evaluate(() => {
        const card = Array.from(document.querySelectorAll('.rs-card')).find(c => c.querySelector('.rs-active'));
        const btns = card ? Array.from(card.querySelectorAll('button')).map(b => b.textContent.trim()) : [];
        return { btns: btns, hasStow: btns.some(t => t.indexOf('收起') >= 0), hasDel: btns.some(t => t === '删除') };
      });
      check('使用中槽位卡提供「收起」（与删除并排）', rodBtns.hasStow && rodBtns.hasDel, JSON.stringify(rodBtns));
      // —— 卸下配件前弹窗预警（会取消对应槽位），取消则不影响槽位 ——
      const offBtn = await p1.evaluate(() => {
        const b = Array.from(document.querySelectorAll('.bd-acts button')).find(x => x.textContent.trim() === '卸下');
        if (!b) return false;
        b.click();
        return true;
      });
      check('钓竿配置页有「卸下」按钮', offBtn === true);
      const warnShown = await waitFor(async () => p1.evaluate(() => {
        const o = document.querySelector('.modal-overlay');
        return !!o && /卸下配件会取消钓竿槽位/.test(o.textContent) && /会被取消/.test(o.textContent) && /仍要卸下/.test(o.textContent);
      }), { timeout: 6000, interval: 50 }).catch(() => false);
      check('卸下配件前弹窗预警（说明会取消槽位）', warnShown === true);
      await p1.evaluate(() => { const b = document.querySelector('.modal-overlay .cf-cancel'); if (b) b.click(); });
      await waitFor(async () => (await p1.$$('.modal-overlay')).length === 0, { timeout: 4000 }).catch(() => {});
      const afterCancel = await get('/api/me?token=' + tokS);
      check('取消预警后槽位不受影响', !!(afterCancel.data.rodSlots && afterCancel.data.rodSlots[1]),
        JSON.stringify((afterCancel.data.rodSlots || []).map(function (x) { return x && x.name; })));
      // 锁定标记：再发一件同签名组件 → 背包该行显示 🔒
      await post('/api/dev/catch', { token: tokS, item: { kind: 'component', id: rodComp } });
      await clickNav(p1, '背包');
      // 切到组件分类 → 重置子筛选（上一段用例留下了部位/词条筛选）→ 全部展开
      await p1.evaluate(() => { const b = Array.from(document.querySelectorAll('.inv-cats .inv-cat')).find(x => x.textContent.includes('组件')); if (b) b.click(); });
      await sleep(400);
      await p1.evaluate(() => {
        const chip = Array.from(document.querySelectorAll('.inv-subrow button')).find(x => x.textContent.trim().indexOf('全部') === 0);
        if (chip) chip.click();
      });
      await sleep(400);
      await p1.evaluate(() => { const c = Array.from(document.querySelectorAll('.inv-subrow button')).find(x => x.textContent.trim() === '清除'); if (c) c.click(); });
      await sleep(400);
      await p1.evaluate(() => { const b = Array.from(document.querySelectorAll('.inv-subrow button')).find(x => x.textContent.includes('全部展开')); if (b) b.click(); });
      const badge = await waitFor(async () => {
        const txt = await p1.evaluate(() => { const n = document.querySelector('.rod-lock'); return n ? n.textContent : ''; });
        return /🔒/.test(txt) ? txt : false;
      }, { timeout: 8000, interval: 200 }).catch(() => false);
      check('背包对钓竿占用的组件显示锁定标记', !!badge, String(badge));
      // 市集：整竿挂单 + 钓竿分类筛选 + 逐件词条
      // 「使用」已把槽位腾空：重新存一根到槽位 1 再上架
      const reSave = await post('/api/rod/save', { token: tokS, slot: 1, name: 'QA·上架竿' });
      check('上架前置：重新存档到槽位 1', reSave.status === 200 && !!reSave.data.rodSlots[1], JSON.stringify(reSave.data).slice(0, 120));
      const rodList = await post('/api/market/list', { token: tokS, rodSlot: 1, price: 7777, hours: 6 });
      check('整竿上架成功（前置）', rodList.status === 200, JSON.stringify(rodList.data).slice(0, 140));
      await clickNav(p1, '开放市集');
      await p1.evaluate(() => { const b = Array.from(document.querySelectorAll('.inv-cat')).find(x => x.textContent.includes('我的挂单')); if (b) b.click(); });
      await waitFor(async () => (await p1.$$('.mk-row')).length >= 1, { timeout: 8000 }).catch(() => {});
      await p1.evaluate(() => { const b = Array.from(document.querySelectorAll('.bf-cat')).find(x => x.textContent.includes('钓竿')); if (b) b.click(); });
      await waitFor(async () => (await p1.$$('.mk-row .mk-rod-part')).length >= 1, { timeout: 6000 }).catch(() => {});
      const rodRow = await p1.evaluate(() => {
        const row = document.querySelector('.mk-row');
        return row ? { text: row.textContent.replace(/\s+/g, ' '), parts: row.querySelectorAll('.mk-rod-part').length, tag: (row.querySelector('.mk-tag') || {}).textContent || '' } : null;
      });
      check('市集「钓竿」分类能筛出整竿挂单', !!rodRow && /整根钓竿/.test(rodRow.text), JSON.stringify(rodRow).slice(0, 140));
      check('整竿行展示逐件组件与词条', !!rodRow && rodRow.parts >= 1 && /🎣 整竿/.test(rodRow.tag), JSON.stringify(rodRow).slice(0, 140));
      // 清理：下架这单整竿，避免影响后续市集用例的挂单数量
      if (rodList.data && rodList.data.listing) await post('/api/market/cancel', { token: tokS, lid: rodList.data.listing.lid });

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
    const mineRows = (await p1.$$('.mk-row')).length;
    check('市集渲染挂单行（我的挂单 ≥2）', mineRows >= 2, String(mineRows));
    check('自己的挂单全部标记为 mine 并可下架', (await p1.$$('.mk-row.mine')).length === mineRows, String(mineRows));
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

    // —— v0.11.4：资产广播（上鱼/获得材料）不重建市集左栏（挂单 / 历史订单） ——
    // 以前每次上鱼都整页重绘：历史订单先被清成「加载中…」再重新请求，画面闪一下（滚动位置也丢）。
    // 前置：造一条成交记录（买家拍下卖家一件挂单，卖家侧才会出现在历史订单里）
    await post('/api/dev/catch', { token: tokS, item: { kind: 'material', id: 'relic' } });
    const histL = await post('/api/market/list', { token: tokS, id: 'relic', qty: 1, price: 120, hours: 6 });
    if (histL.data && histL.data.listing) await post('/api/market/buy', { token: tokB, lid: histL.data.listing.lid });
    await p1.evaluate(() => { const b = Array.from(document.querySelectorAll('.inv-cat')).find(x => x.textContent.includes('历史订单')); if (b) b.click(); });
    await untilSel(p1, '.market-history', 6000);
    await waitFor(async () => (await p1.$$('.market-history .hist-line')).length >= 1, { timeout: 8000 }).catch(() => {});
    const histProbe = await p1.evaluate(() => {
      const box = document.querySelector('.market-history');
      window.__mkProbe = { box: box, panel: document.querySelector('.content > .panel'), sellText: (document.querySelector('.mkt-sell') || {}).textContent };
      return { rows: box ? box.querySelectorAll('.hist-line').length : 0, loading: box ? /加载中/.test(box.textContent) : true };
    });
    check('历史订单渲染出成交记录（且不卡在「加载中…」）', histProbe.rows >= 1 && histProbe.loading === false, JSON.stringify(histProbe));
    await post('/api/dev/catch', { token: tokS, item: { kind: 'fish', id: 'minnow', rarity: 'common', name: '麦穗鱼', size: 21 }, ground: '静水湖', spot: '芦苇浅滩' });
    // 资产广播到达的信号：右栏「我的背包（上架）」内容变化（它会被原地重画）
    const sellRefreshed = await waitFor(async () => await p1.evaluate(() => {
      const pr = window.__mkProbe || {};
      const now = (document.querySelector('.mkt-sell') || {}).textContent;
      return !!now && now !== pr.sellText;
    }), { timeout: 8000, interval: 150 }).catch(() => false);
    check('上鱼后右栏上架面板随资产广播原地刷新', sellRefreshed === true, String(sellRefreshed));
    const mkKeep = await p1.evaluate(() => {
      const pr = window.__mkProbe || {};
      const box = document.querySelector('.market-history');
      return {
        sameBox: !!pr.box && pr.box === box,
        samePanel: !!pr.panel && pr.panel === document.querySelector('.content > .panel'),
        rows: box ? box.querySelectorAll('.hist-line').length : 0,
        loading: box ? /加载中/.test(box.textContent) : true,
      };
    });
    check('上鱼不重建市集主体与历史订单（DOM 原样、不闪「加载中…」）',
      mkKeep.sameBox === true && mkKeep.samePanel === true && mkKeep.rows >= 1 && mkKeep.loading === false, JSON.stringify(mkKeep));
    await p1.evaluate(() => { const b = Array.from(document.querySelectorAll('.inv-cat')).find(x => x.textContent.includes('购买市场')); if (b) b.click(); });
    await sleep(200);

    // —— 系统商店：出售数量控制条（全局生效） ——
    await clickNav(p1, '系统商店');
    check('商店有出售数量控制条', (await p1.$$('.shop-qtybar')).length === 1);
    check('数量控制条含加减与输入框', (await p1.$$('.shop-qtybar .sqb-btn')).length === 2 && (await p1.$$('.shop-qtybar .sqb-num')).length === 1);
    await p1.fill('.shop-qtybar .sqb-num', '3');
    await p1.evaluate(() => { document.querySelector('.shop-qtybar .sqb-num').dispatchEvent(new Event('input', { bubbles: true })); });
    await sleep(200);
    const sellLabels = await p1.$$eval('.shop-card .mini', els => els.map(e => e.textContent));
    check('出售按钮按设定数量显示', sellLabels.some(t => /出售 \d+ 个/.test(t)), JSON.stringify(sellLabels.slice(0, 3)));

    // —— 自动售出管理栏（右栏）+ 双向排序 ——
    check('商店有自动售出管理栏（右栏）', (await p1.$$('#shop-as-panel')).length === 1);
    const asRows = await p1.$$('#as-list .as-row');
    // 鱼类 40 种（龙宫宝珠 v0.11 起归入材料，不再算鱼）
    check('右栏逐鱼设置列表覆盖全部鱼类（40）', asRows.length === 40, String(asRows.length));
    check('逐鱼行带「设置」入口', (await p1.$$('#as-list .as-row button')).length === 40, String((await p1.$$('#as-list .as-row button')).length));
    // 双向排序：点「价格」降序（首卡最高），再点同键反向为升序（首卡最低）
    const cardPrices = () => p1.$$eval('#shop-panel .shop-grid .shop-card', els => els.map(e => {
      const m = /💰\s*(\d+)/.exec(e.querySelector('.sc-price').textContent);
      return m ? Number(m[1]) : 0;
    }));
    await p1.evaluate(() => { document.querySelector('.bf-cat[data-ss="price"]').click(); });
    const descP = await cardPrices();
    check('点「价格」按价格降序', descP.length >= 30 && descP.every((v, i) => i === 0 || v <= descP[i - 1]), JSON.stringify(descP.slice(0, 6)));
    check('排序按钮显示降序箭头', /价格 ↓/.test(await p1.evaluate(() => { const b = document.querySelector('.bf-cat[data-ss="price"]'); return b ? b.textContent : ''; })));
    await p1.evaluate(() => { document.querySelector('.bf-cat[data-ss="price"]').click(); });
    const ascP = await cardPrices();
    check('再点「价格」反向为升序', ascP.length >= 30 && ascP.every((v, i) => i === 0 || v >= ascP[i - 1]), JSON.stringify(ascP.slice(0, 6)));
    check('排序按钮显示升序箭头', /价格 ↑/.test(await p1.evaluate(() => { const b = document.querySelector('.bf-cat[data-ss="price"]'); return b ? b.textContent : ''; })));
    // 输入框不再被行情广播清空（回归：上鱼/售出会触发 shop 广播重绘，但只刷网格）
    await p1.evaluate(() => { document.getElementById('sa-pct').value = '175'; });
    await post('/api/dev/catch', { token: tokS, item: { kind: 'fish', id: 'crucian', rarity: 'common' } });
    await post('/api/sell', { token: tokS, id: 'crucian', qty: 1 });   // 触发 broadcastShop
    await sleep(500);
    check('行情广播后自动售出输入不被清空', await p1.evaluate(() => document.getElementById('sa-pct').value) === '175',
      await p1.evaluate(() => document.getElementById('sa-pct').value));
    check('行情广播后商品网格仍正常渲染', (await p1.$$('#shop-panel .shop-grid .shop-card')).length >= 30,
      String((await p1.$$('#shop-panel .shop-grid .shop-card')).length));
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
    check('组件分类按底材名分组（默认折叠）', compGroup.heads.length >= 1 && (await p1.$$('.inv-group-head.clickable')).length >= 1, JSON.stringify(compGroup.heads.slice(0, 3)));
    check('组标题展示词条类型与价格区间', compGroup.heads.every === undefined ? false : compGroup.heads.some(t => /共 \d+ 个/.test(t) && /💰/.test(t)), JSON.stringify(compGroup.heads.slice(0, 2)));
    // 同底材同品质不同数值应归入同一组（组标题只出现一次「竹制短竿」稀有）
    check('组件分组可点击展开（可折叠列表）', (await p1.$$('.inv-group-head.clickable')).length >= 1, String((await p1.$$('.inv-group-head.clickable')).length));

    // —— v0.11.4：出售组件就地更新（不整页重建 → 分组不重排、展开栏不收起） ——
    // 先临时停钓：自动上鱼会持续推 assets 广播（背包页随之整页重绘），会让 DOM 身份断言不稳
    const fishState0 = await p1.evaluate(() => ({
      active: !!window.Engine.state.fishing.active,
      g: window.Engine.state.player.groundId, s: window.Engine.state.player.spotId,
    }));
    if (fishState0.active) { await p1.evaluate(() => window.Engine.stopFishing()); await sleep(400); }
    await p1.evaluate(() => {
      const head = Array.from(document.querySelectorAll('.inv-group-head.clickable')).find(h => /竹制短竿/.test(h.textContent));
      if (head && !head.classList.contains('open')) head.click();
    });
    await sleep(350);
    const grpBefore = await p1.evaluate(() => {
      const head = Array.from(document.querySelectorAll('.inv-group-head.clickable')).find(h => /竹制短竿/.test(h.textContent));
      if (!head) return { ok: false, why: 'no group head' };
      const gk = head.getAttribute('data-group');
      const rows = Array.from(document.querySelectorAll('.inv-comp-row')).filter(r => r.getAttribute('data-group') === gk);
      // 挑一件「只有 1 个」的行来卖：卖完该行应消失、组头件数 -1
      const sell = rows.find(r => (r.querySelector('.cnt') || {}).textContent === '×1');
      const keep = rows.find(r => r !== sell);
      if (!sell || !keep) return { ok: false, why: 'need 2 rows (one ×1)', n: rows.length };
      const cntBox = head.querySelector('.inv-group-cnt');
      window.__sp = { head: head, gk: gk, sell: sell, keep: keep, sellId: sell.getAttribute('data-id'), keepId: keep.getAttribute('data-id') };
      return {
        ok: true, gk: gk, total: Number((cntBox.textContent.match(/共 (\d+) 个/) || [])[1] || -1),
        sellId: sell.getAttribute('data-id'), keepId: keep.getAttribute('data-id'),
      };
    });
    check('组件分组已展开（同底材两件可对照）', grpBefore.ok === true, JSON.stringify(grpBefore));
    await p1.evaluate(() => {
      const b = Array.from(window.__sp.sell.querySelectorAll('button')).find(x => x.textContent.trim() === '出售 1');
      if (b) b.click();
    });
    const sellTotal = await untilGet(async () => await p1.evaluate(() => {
      const head = document.querySelector('.inv-group-head[data-group="' + ((window.__sp || {}).gk || '') + '"]');
      const m = head && head.querySelector('.inv-group-cnt') ? head.querySelector('.inv-group-cnt').textContent.match(/共 (\d+) 个/) : null;
      return m ? Number(m[1]) : -1;
    }), v => v >= 0 && v !== grpBefore.total, 8000);
    const grpAfter = await p1.evaluate(() => {
      const sp = window.__sp || {};
      const head = document.querySelector('.inv-group-head[data-group="' + sp.gk + '"]');
      return {
        sameHead: !!sp.head && sp.head === head,
        exp: !!head && head.classList.contains('open'),
        keepSame: !!sp.keep && document.contains(sp.keep) && sp.keep === document.querySelector('.inv-comp-row[data-id="' + sp.keepId + '"]'),
        sellGone: !document.querySelector('.inv-comp-row[data-id="' + sp.sellId + '"]'),
        keepId: sp.keepId, sellId: sp.sellId, domIds: Array.prototype.map.call(document.querySelectorAll('.inv-comp-row'), function (r) { return r.getAttribute('data-id'); }),
      };
    });
    check('出售组件就地更新（组头与其余行保持原节点、不重排、展开态不丢）',
      grpAfter.sameHead === true && grpAfter.exp === true && grpAfter.keepSame === true && grpAfter.sellGone === true,
      JSON.stringify(grpAfter));
    check('组头件数随出售就地更新（不整页重建也能对上）',
      sellTotal === grpBefore.total - 1, JSON.stringify({ before: grpBefore.total, after: sellTotal }));

    // —— v0.11.6：出售不再让组件分类重新排序 ——
    // 组间顺序 = 「部位 → 底材名」，两个键都只由分组身份（baseId）决定、不含任何具体实例；
    // 旧实现的排序读「组内第一个遇到的实例」的品质与名字，售出那件（或整叠售罄）就会让整组换位。
    const orderRule = await p1.evaluate(() => {
      const D = window.GameData;
      const partIdx = {};
      D.ROD_PARTS.forEach((p, i) => { partIdx[p.key] = i; });
      const heads = Array.from(document.querySelectorAll('.inv-group-head')).map(h => h.getAttribute('data-group'));
      const expect = heads.slice().sort((a, b) => {
        const ba = D.componentBase(a), bb = D.componentBase(b);
        if (!ba) return 1;
        if (!bb) return -1;
        const pa = partIdx[ba.part] == null ? 99 : partIdx[ba.part];
        const pb = partIdx[bb.part] == null ? 99 : partIdx[bb.part];
        return (pa - pb) || ba.name.localeCompare(bb.name, 'zh');
      });
      return { heads: heads, expect: expect };
    });
    check('组件分组顺序 = 部位 → 底材名（与实例无关的固定顺序）',
      orderRule.heads.length > 0 && JSON.stringify(orderRule.heads) === JSON.stringify(orderRule.expect),
      JSON.stringify(orderRule.heads.slice(0, 6)));

    // 同底材不同品质仍归一组；卖掉组里品质最高的那一件（旧实现中它就是组头代表件）
    const compIds2 = [
      D_DATA.instanceId('rod_bamboo', 'epic', [{ type: 'speed', value: 20 }, { type: 'size', value: -2 }]),
      D_DATA.instanceId('rod_bamboo', 'common', [{ type: 'speed', value: 5 }]),
    ];
    for (const cid of compIds2) await post('/api/dev/catch', { token: tokS, item: { kind: 'component', id: cid } });
    await p1.evaluate(() => { const b = Array.from(document.querySelectorAll('.inv-cat')).find(x => x.textContent.includes('组件')); if (b) b.click(); });
    await sleep(500);
    const ordBefore = await p1.evaluate(() => Array.from(document.querySelectorAll('.inv-group-head')).map(h => h.getAttribute('data-group')));
    const bambooGk = await p1.evaluate(() => {
      const h = Array.from(document.querySelectorAll('.inv-group-head')).find(x => /竹制短竿/.test(x.textContent));
      if (!h) return null;
      const gk = h.getAttribute('data-group');
      if (!h.classList.contains('open')) h.click();
      return gk;
    });
    check('同底材混品质仍归一个分组（组头不随代表件漂移）', !!bambooGk, JSON.stringify(ordBefore));
    await sleep(450);
    const soldEpicId = await p1.evaluate((args) => {
      const row = document.querySelector('.inv-comp-row[data-id="' + args.id + '"]');
      if (!row) return null;
      const b = Array.from(row.querySelectorAll('button')).find(x => x.textContent.trim() === '出售 1');
      if (!b) return null;
      b.click();
      return args.id;
    }, { id: compIds2[0], gk: bambooGk });
    const epicRowGone = await untilGet(async () => await p1.evaluate((id) => !document.querySelector('.inv-comp-row[data-id="' + id + '"]'), compIds2[0]), v => v === true, 8000);
    check('卖掉组内品质最高的那件（旧实现的组头代表件）', !!soldEpicId && epicRowGone === true, JSON.stringify({ sold: soldEpicId, gone: epicRowGone }));
    const ordAfter = await p1.evaluate(() => Array.from(document.querySelectorAll('.inv-group-head')).map(h => h.getAttribute('data-group')));
    check('出售后其余组件分组顺序原样不变（不再重排）',
      JSON.stringify(ordAfter) === JSON.stringify(ordBefore),
      JSON.stringify({ before: ordBefore, after: ordAfter }));
    const headColorStable = await p1.evaluate((gk) => {
      const h = document.querySelector('.inv-group-head[data-group="' + gk + '"]');
      const nameEl = h && h.querySelector('span:not(.caret):not(.inv-group-tag):not(.inv-group-price):not(.inv-group-cnt)');
      return { cls: nameEl ? nameEl.className : '', text: h ? h.textContent.replace(/\s+/g, ' ').trim() : '' };
    }, bambooGk);
    check('组头仍指向同一底材（品质色由组内最高品质决定，不因售卖而错位）',
      /竹制短竿/.test(headColorStable.text) && /q-/.test(headColorStable.cls), JSON.stringify(headColorStable));
    if (fishState0.active && fishState0.g) {
      await p1.evaluate(async (st0) => { await window.Engine.startFishing(st0.g, st0.s); }, fishState0);
      await sleep(300);
    }

    await p1.evaluate(() => { const b = Array.from(document.querySelectorAll('.inv-cat')).find(x => x.textContent.includes('全部')); if (b) b.click(); });
    await sleep(300);

    // —— 背包：批量出售 -> 子窗口（数字 + 滑块 + 趋势图） ——
    await clickNav(p1, '背包');
    check('背包行有「批量出售」按钮', (await p1.textContent('.inv-page')).includes('批量出售'));
    await p1.evaluate(() => {
      // 选一件「持有 ≥2」的物品（数量为 1 时输入会被夹到 1，无法验证联动）
      const row = Array.from(document.querySelectorAll('.inv-page-row')).find(r => {
        const m = /×(\d+)/.exec((r.querySelector('.cnt') || {}).textContent || '');
        return m && Number(m[1]) >= 2 && Array.from(r.querySelectorAll('.mini')).some(b => b.textContent.includes('批量出售'));
      });
      const b = row && Array.from(row.querySelectorAll('.mini')).find(x => x.textContent.includes('批量出售'));
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

    // —— v0.11.8：背包物品简介（悬停浮标 + 点击完整简介，鱼 / 材料 / 宝匣） ——
    // 注意 untilSel 超时是静默返回 false：点分类前必须确认资产广播已到（背包里有这件东西），
    // 否则分类页是空的、点不到行，断言只会拿到 null。
    await post('/api/dev/catch', { token: tokS, item: { kind: 'chest', id: 'chest_wreck' } });
    await waitFor(async () => (await p1.evaluate(() => window.Engine.state.inventory.chest_wreck || 0)) > 0, { timeout: 8000 }).catch(() => {});
    await clickNav(p1, '背包');
    // 品质子筛选是模块级状态，前面「按品质筛选」那节把它留在「稀有」上没复位（模块级状态跨用例保留），
    // 这里先点回「全部」，否则材料/宝匣分类会被滤空、点不到行。
    await p1.evaluate(() => {
      const b = Array.from(document.querySelectorAll('.inv-cat')).find(x => !x.textContent.includes('📦') && x.textContent.trim().indexOf('全部') === 0);
      if (b) b.click();
    });
    await sleep(300);
    await untilSel(p1, '.inv-page-row.clickable', 8000);
    const pickRow = await p1.evaluate(() => {
      const row = document.querySelector('.inv-page-row.clickable');
      if (!row) return null;
      const b = row.getBoundingClientRect();
      return {
        name: (row.querySelector('span') || {}).textContent || '',
        kind: (row.querySelector('.kind-tag') || {}).textContent || '',
        // 点左侧名字区域：行的右侧是「出售 / 批量出售 / 上架」按钮，别点到按钮上
        x: Math.round(b.left + 24), y: Math.round(b.top + b.height / 2),
      };
    });
    check('背包里鱼/材料/宝匣行可点开简介（已标 clickable）', !!pickRow && /鱼|材料|宝匣/.test(pickRow.kind), JSON.stringify(pickRow));
    await p1.mouse.move(pickRow.x, pickRow.y, { steps: 3 });
    const tipChk = await untilGet(async () => await p1.evaluate(() => {
      const t = document.querySelector('.item-tip');
      if (!t || !t.classList.contains('show')) return null;
      return { txt: t.textContent.replace(/\s+/g, ' ').trim(), img: !!t.querySelector('img'), hint: /点击查看完整简介/.test(t.textContent) };
    }), o => !!o, 4000);
    check('悬停出现简介浮标（图片 + 一句话 + 点击提示）',
      !!tipChk && tipChk.img && tipChk.hint && /持有 ×\d+/.test(tipChk.txt), JSON.stringify(tipChk).slice(0, 180));
    // 原生 title 浮框（白底黑字）晚一拍才冒出来，还会叠在自绘浮标上，看着像卡出的白框：行上一律不许挂。
    check('悬停行没有原生 title 浮框（避免和自绘浮标重叠）',
      await p1.evaluate(() => Array.from(document.querySelectorAll('.inv-page-row')).every(r => !r.getAttribute('title'))),
      '仍有 .inv-page-row 带 title 属性');
    await p1.mouse.click(pickRow.x, pickRow.y);
    const readDetail = () => p1.evaluate(() => {
      const m = document.querySelector('.item-detail-modal');
      if (!m) return null;
      return {
        title: (m.querySelector('.modal-title') || {}).textContent || '',
        txt: (m.querySelector('.codex-detail') || {}).textContent.replace(/\s+/g, ' ').trim(),
        img: !!m.querySelector('.cd-icon'),
        uses: m.querySelectorAll('.cd-uses li').length,
        spots: m.querySelectorAll('.cd-spot').length,
      };
    });
    const closeDetail = async () => {
      await p1.evaluate(() => { const b = document.querySelector('.item-detail-modal .modal-close'); if (b) b.click(); });
      await sleep(200);
    };
    const detailChk = await untilGet(readDetail, o => !!o, 4000);
    check('点击背包行打开完整简介（图片 + 一句话 + 用途 + 产地或来源）',
      !!detailChk && detailChk.img && detailChk.uses >= 2 && /用途/.test(detailChk.txt) &&
      (/产出地点/.test(detailChk.txt) ? detailChk.spots >= 1 : /来源/.test(detailChk.txt)),
      JSON.stringify(detailChk).slice(0, 220));
    check('简介标题与所点行一致', !!detailChk && detailChk.title === pickRow.name,
      JSON.stringify({ t: detailChk && detailChk.title, row: pickRow.name }));
    await closeDetail();
    check('关闭后简介子窗口消失', (await p1.$$('.item-detail-modal')).length === 0);
    // 鱼类：简介要给出体型、产地清单与记录用途
    await p1.evaluate(() => { const b = Array.from(document.querySelectorAll('.inv-cat')).find(x => x.textContent.includes('鱼类')); if (b) b.click(); });
    await untilSel(p1, '.inv-page-row.clickable', 5000);
    await p1.evaluate(() => { const r = document.querySelector('.inv-page-row.clickable'); if (r) r.click(); });
    const fishDetail = await untilGet(readDetail, o => !!o, 4000);
    check('鱼类简介含体型、产地与「记入图鉴 / 渔获记录」用途',
      !!fishDetail && /体型 \d+~\d+ cm/.test(fishDetail.txt) && fishDetail.spots >= 1 &&
      /渔获记录/.test(fishDetail.txt) && /挂单/.test(fishDetail.txt), JSON.stringify(fishDetail).slice(0, 220));
    await closeDetail();
    // 材料：简介要说清熔炼用途（投料对应词缀 / 催化剂）；先确保背包里有材料（前面几节可能已卖掉）
    await post('/api/dev/catch', { token: tokS, item: { kind: 'material', id: 'rope' } });
    await waitFor(async () => (await p1.evaluate(() => window.Engine.state.inventory.rope || 0)) > 0, { timeout: 8000 }).catch(() => {});
    await p1.evaluate(() => { const b = Array.from(document.querySelectorAll('.inv-cat')).find(x => x.textContent.includes('材料')); if (b) b.click(); });
    await untilSel(p1, '.inv-page-row.clickable', 5000);
    await p1.evaluate(() => { const r = document.querySelector('.inv-page-row.clickable'); if (r) r.click(); });
    const matDetail = await untilGet(readDetail, o => !!o, 4000);
    check('材料简介含熔炼用途与产地', !!matDetail && /熔炼/.test(matDetail.txt) && matDetail.spots >= 1,
      JSON.stringify(matDetail).slice(0, 200));
    await closeDetail();
    // 宝匣：用途要写清合成消耗与产出（走配置里的 desc / costRelic / qualityWeights）
    await p1.evaluate(() => { const b = Array.from(document.querySelectorAll('.inv-cat')).find(x => x.textContent.includes('宝匣')); if (b) b.click(); });
    await untilSel(p1, '.inv-page-row.clickable', 5000);
    await p1.evaluate(() => { const r = document.querySelector('.inv-page-row.clickable'); if (r) r.click(); });
    const chestDetail = await untilGet(readDetail, o => !!o, 4000);
    check('宝匣简介写明合成消耗、产出品质与来源',
      !!chestDetail && /宝匣合成/.test(chestDetail.txt) && /消耗/.test(chestDetail.txt) &&
      /产出品质/.test(chestDetail.txt) && /残片/.test(chestDetail.txt) && /来源/.test(chestDetail.txt),
      JSON.stringify(chestDetail).slice(0, 240));
    await closeDetail();
    await p1.evaluate(() => { const b = Array.from(document.querySelectorAll('.inv-cat')).find(x => x.textContent.includes('全部')); if (b) b.click(); });
    await sleep(200);

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
    // 等 groundcfg 广播后重绘钓鱼页（增益标签出现即说明已重绘）
    await clickNav(p1, '钓鱼');
    const buffItems = await untilGet(() => p1.$$eval('.pn-bufftip',
      els => els.map(e => e.textContent.replace(/\s+/g, ' ').trim())), arr => !!(arr && arr.length), 8000);
    check('有增益的钓点显示 ⚡ 标记', (await p1.$$('.px-node.buffed .pn-buff')).length >= 1, JSON.stringify(spotMarkInfo));
    // 增益直接显示在地图钓点名牌下，不需要鼠标悬浮
    check('地图上直接列出钓点增益（钓速+15%）',
      buffItems.some(t => t.indexOf('钓速+15%') >= 0), JSON.stringify(buffItems));
    const buffMarkOk = await p1.evaluate(() => {
      const tip = document.querySelector('.pn-bufftip');
      if (!tip) return false;
      const node = tip.closest('.px-node');
      return !!(node && node.querySelector('.pn-buff') && node.querySelector('.pn-name') && /老旧码头/.test(node.textContent));
    });
    check('增益节点含 ⚡ 标记与钓点名', buffMarkOk === true, String(buffMarkOk));
    const noBuffTips = await p1.$$eval('.px-node:not(.buffed) .pn-bufftip', els => els.length);
    check('没有增益的钓点不显示增益标签', noBuffTips === 0, String(noBuffTips));
    const noNativeTip = await p1.$$eval('.px-node', els => els.filter(e => e.hasAttribute('title')).length);
    check('钓点节点不依赖原生 title 悬浮提示', noNativeTip === 0, String(noNativeTip));

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
    // 条目数 = 40 鱼 + 7 材料 + 30 组件底材（宝匣不是钓获物，不入图鉴）
    check('图鉴渲染全部条目', cells.length === 77, String(cells.length));
    // v0.11 品质规范：只有 普通/稀有/史诗/神话 四种，「大鱼」不再是品质也不再带皇冠前缀；
    // 图鉴不再按「是否拥有满词条」改色或加后缀。
    const colorCheck = await p1.evaluate(() => {
      const names = Array.from(document.querySelectorAll('.codex-cell .cx-name'));
      return {
        big: names.some(n => n.classList.contains('r-big')),
        rare: names.some(n => n.classList.contains('r-rare')),
        full: names.some(n => n.classList.contains('q-full')),
        tag: names.filter(n => n.querySelector('.full-tag')).length,
      };
    });
    check('渔获不再有「大鱼」配色条目（品质只有普通/稀有/史诗/神话）', colorCheck.big === false, JSON.stringify(colorCheck));
    check('稀有条目用稀有配色（黄）', colorCheck.rare === true, JSON.stringify(colorCheck));
    check('图鉴不再因满词条改金色', colorCheck.full === false, JSON.stringify(colorCheck));
    check('图鉴卡片不再显示「满词条」后缀', colorCheck.tag === 0, JSON.stringify(colorCheck.tag));
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

    // —— 钓点图鉴：按钓点分类 + 钓点详情（实时产出概率，随后台同步）——
    await p1.evaluate(() => { const b = Array.from(document.querySelectorAll('.inv-cat')).find(x => x.textContent.includes('钓点')); if (b) b.click(); });
    await sleep(300);
    const spotCells = await p1.$$('.codex-cell.k-spots');
    check('图鉴新增「钓点」分类（9 个钓点卡片）', spotCells.length === 9, String(spotCells.length));
    check('钓点视图不显示品级倒序按钮', (await p1.$$('.codex-sort')).length === 0, String((await p1.$$('.codex-sort')).length));
    // v0.11.6：可前往的钓点＝已解锁（点亮）；锁定的钓场（后台锁定 / 限时未开窗）保持压暗锁态
    const spotState = await p1.evaluate(() => {
      const cells = Array.from(document.querySelectorAll('.codex-cell.k-spots'));
      const unlocked = cells.filter(c => c.classList.contains('unlocked'));
      const locked = cells.filter(c => c.classList.contains('locked'));
      // 已解锁：卡片内容不再被「未解锁压暗」那条通用规则压暗（opacity 恒为 1）
      const lit = unlocked.length ? Number(getComputedStyle(unlocked[0]).opacity) : -1;
      const child = unlocked.length ? Number(getComputedStyle(unlocked[0].querySelector('.cx-meta')).opacity) : -1;
      return {
        total: cells.length, unlocked: unlocked.length, locked: locked.length, lit: lit, child: child,
        unlockedText: unlocked.length ? unlocked[0].textContent : '',
        lockedText: locked.length ? locked[0].textContent : '',
        bothClasses: cells.some(c => c.classList.contains('unlocked') && c.classList.contains('locked')),
      };
    });
    check('钓点卡片区分已解锁 / 未开放（两类互斥且覆盖全部卡片）',
      spotState.unlocked + spotState.locked === spotState.total && spotState.bothClasses === false,
      JSON.stringify(spotState));
    check('已解锁钓点点亮（不透明度 1，跳出未解锁压暗规则）',
      spotState.unlocked >= 1 && spotState.lit === 1 && spotState.child === 1, JSON.stringify(spotState));
    check('已解锁钓点标注「已解锁 · 可前往垂钓」', /已解锁 · 可前往垂钓/.test(spotState.unlockedText), spotState.unlockedText.slice(0, 60));
    check('锁定钓场标注「尚未开放」', spotState.locked === 0 || /尚未开放/.test(spotState.lockedText), spotState.lockedText.slice(0, 60));
    // 点开第一个钓点（静水湖·老旧码头）→ 概率与 /api/grounds 的目录一致
    await p1.evaluate(() => { const c = document.querySelector('.codex-cell.k-spots'); if (c) c.click(); });
    await waitFor(async () => (await p1.$$('.spot-detail .spot-pool-row')).length >= 1, { timeout: 6000 }).catch(() => false);
    const spotModal = await p1.evaluate(() => ({
      title: (document.querySelector('.codex-modal .modal-title') || {}).textContent || '',
      rows: Array.from(document.querySelectorAll('.spot-pool-row')).map(r => ({ pick: r.getAttribute('data-pick'), pct: Number(r.getAttribute('data-pct')) })),
    }));
    check('钓点详情弹窗展示掉落池与概率', spotModal.rows.length >= 1 && spotModal.title.indexOf('静水湖') >= 0, JSON.stringify(spotModal).slice(0, 200));
    const pctMatch = await p1.evaluate(async () => {
      const gr = await fetch('/api/grounds').then(r => r.json());
      const sp = gr.grounds.find(x => x.id === 'stillwater').spots.find(x => x.id === 'dock');
      const total = sp.pool.reduce((s, e) => s + e.weight, 0);
      const expect = {};
      sp.pool.forEach(e => { expect[e.pick] = Math.round(e.weight / total * 1000) / 10; });
      const rows = Array.from(document.querySelectorAll('.spot-pool-row')).map(r => ({ pick: r.getAttribute('data-pick'), pct: Number(r.getAttribute('data-pct')) }));
      const bad = rows.filter(r => expect[r.pick] === undefined || Math.abs(expect[r.pick] - r.pct) > 0.05);
      return { bad: bad, n: rows.length, expectN: sp.pool.length };
    });
    check('详情概率与服务器目录一致', pctMatch.n === pctMatch.expectN && pctMatch.bad.length === 0, JSON.stringify(pctMatch));
    // 与后台同步：改掉落池（管理员）→ SSE groundcfg → 打开中的详情自动刷新为单一 100%
    const syncCheck = await p1.evaluate(async () => {
      const login = await fetch('/api/admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'lay_seller', password: 'abcd1234' }) }).then(r => r.json());
      if (!login.token) return { ok: false, why: 'no admin token' };
      const gr = await fetch('/api/grounds').then(r => r.json());
      const sp = gr.grounds.find(x => x.id === 'stillwater').spots.find(x => x.id === 'dock');
      const old = sp.pool;
      await fetch('/api/admin/spot/pool', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: login.token, groundId: 'stillwater', spotId: 'dock', pool: [{ pick: 'fish:crucian', weight: 100 }] }) });
      for (let i = 0; i < 50; i++) {
        const now = await fetch('/api/grounds').then(r => r.json());
        const cur = now.grounds.find(x => x.id === 'stillwater').spots.find(x => x.id === 'dock');
        if (cur.pool.length === 1) break;
        await new Promise(r => setTimeout(r, 100));
      }
      const rows = Array.from(document.querySelectorAll('.spot-pool-row')).map(r => ({ pick: r.getAttribute('data-pick'), pct: Number(r.getAttribute('data-pct')) }));
      return { ok: true, rows: rows, old: old };
    });
    check('后台改掉落池后，打开中的钓点详情自动同步（鲫鱼 100%）',
      syncCheck.ok && syncCheck.rows.length === 1 && syncCheck.rows[0].pick === 'fish:crucian' && syncCheck.rows[0].pct === 100,
      JSON.stringify(syncCheck.rows));
    check('同步后弹窗仍开着（无需关闭重开）', (await p1.$$('.codex-modal')).length === 1, String((await p1.$$('.codex-modal')).length));
    // 恢复原掉落池，避免影响后续用例
    const admT = (await post('/api/admin/login', { username: 'lay_seller', password: 'abcd1234' })).data.token;
    check('管理端登录可用（恢复掉落池前置）', !!admT, String(!!admT));
    await post('/api/admin/spot/pool', { token: admT, groundId: 'stillwater', spotId: 'dock', pool: syncCheck.old });
    await p1.evaluate(() => { const b = document.querySelector('.codex-modal .modal-close'); if (b) b.click(); });
    await sleep(200);
    check('钓点详情可关闭', (await p1.$$('.codex-modal')).length === 0, String((await p1.$$('.codex-modal')).length));

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
    // 先停止钓鱼并清空两条轨道（真实渔获播报会占满纪录轨，顺序播放不会插播）
    await p1.evaluate(() => { const b = document.querySelector('.px-node.on'); if (b) b.click(); });
    await sleep(500);
    await p1.evaluate(() => window.UI.resetBanners && window.UI.resetBanners());
    await waitFor(async () => (await p1.$$('#record-banner.show')).length === 0, { timeout: 8000, interval: 200 }).catch(() => {});
    await p1.evaluate(() => window.UI.showRecordBanner({ who: '测试甲', name: '黄金枪鱼', size: 999.9 }));
    const bannerOn = await waitFor(async () => {
      const b = await p1.evaluate(() => { const n = document.getElementById('record-banner'); return n && n.classList.contains('show') ? n.textContent : ''; });
      return /999\.9/.test(b);
    }, { timeout: 15000, interval: 300 }).catch(() => false);
    check('破纪录横幅显示且含纪录信息（排队播放）', bannerOn === true, String(bannerOn));

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
    const cntTexts = await p1.$$eval('.px-region:not(.locked)', els => els.map(e => e.textContent.trim()));
    check('地图区域标签每个渔场显示人数', cntTexts.length === 3 && cntTexts.every(t => /人/.test(t)), JSON.stringify(cntTexts));
    await clickNav(p1, '渔场动态');

    // —— 在线交易：真实 Chrome 内勾选不被重置 ——
    section('在线交易（真实 Chrome）');
    await clickNav(p2, '在线交易');
    await p1.evaluate(() => {
      const b = Array.from(document.querySelectorAll('.nav-item')).find(x => x.textContent.includes('钓鱼'));
      if (b) b.click();
    });
    await sleep(300);
    // 让 p1 处于钓鱼中（若已在该钓点，换一个钓点，避免点到当前钓点把钓鱼取消）
    await p1.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('.px-node'));
      const target = btns.find(b => !b.classList.contains('on')) || btns[0];
      if (target) target.click();
    });
    await waitFor(async () => /实际/.test(await p1.textContent('.fish-state')), { timeout: 5000 }).catch(() => {});
    const castBar = await p1.textContent('.fish-state');
    check('状态条显示后台基础间隔', /后台基础 \d+\.\d+s\/竿/.test(castBar), castBar.slice(0, 140));
    check('状态条显示实际钓速（含加成拆分或“无加成”）', /实际 \d+\.\d+s\/竿/.test(castBar), castBar.slice(0, 140));
    // 顶部角色状态栏同步展示钓速（基础值 + 实际值），便于随时查看
    await waitFor(async () => /每 \d+\.\d+s 一竿/.test(await p1.textContent('#player-status')), { timeout: 6000 }).catch(() => {});
    const topCast = await p1.textContent('#player-status');
    check('顶部状态栏显示实际钓速与后台基础值', /每 \d+\.\d+s 一竿/.test(topCast) && /基础 \d+\.\d+s/.test(topCast), topCast.slice(0, 160));
    check('顶部钓速含加成拆分（钓竿/钓点/全服或无加成）', /竿|点|服|无加成/.test(topCast), topCast.slice(0, 160));
    check('顶部状态栏紧邻显示当前场地上鱼率', /🐟 上鱼率 \d+/.test(topCast), topCast.slice(0, 200));
    await clickNav(p1, '在线交易');

    await p1.evaluate(() => {
      const b = Array.from(document.querySelectorAll('.invite-row .mini')).find(x => x.textContent.includes('邀请'));
      if (b) b.click();
    });
    // 等邀请送达对方（按钮出现即可点），不等固定 800ms
    await untilGet(() => p2.$$eval('.trade-actions button', els => els.map(e => e.textContent)),
      arr => !!(arr && arr.some(t => t.includes('接受邀请'))), 8000);
    await p2.evaluate(() => {
      const b = Array.from(document.querySelectorAll('.trade-actions button')).find(x => x.textContent.includes('接受邀请'));
      if (b) b.click();
    });
    await clickNav(p1, '在线交易');
    await untilSel(p1, '.trade-picker', 8000);
    // 接受邀请后的同步可能晚于容器出现：等行列表真的填充出来再改数量
    await untilGet(() => p1.$$eval('.tp-row', els => els.map(e => e.textContent)),
      arr => !!(arr && arr.some(t => t.includes('黄金锦鲤'))), 8000);
    check('交易界面出现物品选择器', (await p1.$$('.trade-picker')).length === 1);

    // 勾选并等待若干秒，让钓鱼产生的 players/grounds/feed 广播持续冲刷
    // 期望数量取「持有量」与实际想选的 2 的较小值：持有只有 1 条时数量只能是 1
    const heldN = await p1.evaluate(() => {
      const r = Array.from(document.querySelectorAll('.tp-row')).find(x => x.textContent.includes('黄金锦鲤'));
      const m = r && /持有\s*(\d+)/.exec((r.querySelector('.tp-have') || {}).textContent || '');
      return m ? Number(m[1]) : 1;
    });
    const wantQty = String(Math.min(2, heldN));
    await p1.evaluate((q) => {
      const r = Array.from(document.querySelectorAll('.tp-row')).find(x => x.textContent.includes('黄金锦鲤'));
      const cb = r.querySelector('input[type=checkbox]');
      cb.checked = true; cb.dispatchEvent(new Event('change', { bubbles: true }));
      const qi = r.querySelector('input.tp-qty');
      qi.value = q; qi.dispatchEvent(new Event('input', { bubbles: true }));
    }, wantQty);
    await sleep(4000);   // > 一个钓鱼周期（3s），期间必有多次广播
    const afterBurst = await p1.evaluate(() => {
      const r = Array.from(document.querySelectorAll('.tp-row')).find(x => x.textContent.includes('黄金锦鲤'));
      if (!r) return null;
      const inv = (window.Engine && window.Engine.state && window.Engine.state.inventory) || {};
      return { checked: r.querySelector('input[type=checkbox]').checked, qty: r.querySelector('input.tp-qty').value,
        held: inv['koi'], haveTxt: (r.querySelector('.tp-have') || {}).textContent };
    });
    check('持续广播 4s 后勾选仍保持（核心缺陷已修复）', !!afterBurst && afterBurst.checked === true, JSON.stringify(afterBurst));
    check('持续广播 4s 后数量保持不变（持有 ' + heldN + ' 条 → ' + wantQty + '）', !!afterBurst && afterBurst.qty === wantQty, JSON.stringify(afterBurst));

    // 提交并使用 UI 确认
    await p1.evaluate(() => {
      const b = Array.from(document.querySelectorAll('.trade-picker .mini')).find(x => x.textContent.includes('更新我的提供'));
      if (b) b.click();
    });
    const mineTxt = await untilGet(() => p1.textContent('.trade-side.mine'), t => /黄金锦鲤/.test(t || ''), 8000);
    check('提交后「我的提供」显示所选物品', mineTxt.includes('黄金锦鲤'));

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
    check('交易页提供物品列表带分类页签', (await p1.$$('.tp-cats .inv-cat')).length === 5, String((await p1.$$('.tp-cats .inv-cat')).length));
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
    check('日志页有分类筛选页签（含渔获分列共 6 个）', (await p1.$$('.inv-cats .inv-cat')).length === 6, String((await p1.$$('.inv-cats .inv-cat')).length));
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
    // 版本号只有一个来源（data.js）：index.html 不得再硬编码，界面上的副本由 ui.js 启动时填入。
    // 曾出现「功能已是新版、左上角/标签页仍显示旧版本号」——就是 index.html 的副本没跟着改。
    const idxSrc = fs.readFileSync(path.join(ROOT, 'frontend', 'index.html'), 'utf8');
    check('index.html 不再硬编码版本号', !/v\d+\.\d+\.\d+/.test(idxSrc), (idxSrc.match(/v\d+\.\d+\.\d+/g) || []).join(','));
    const verUi = await p1.evaluate(() => ({
      local: window.GameData.VERSION,
      brand: (document.querySelector('.brand .ver') || {}).textContent || '',
      title: document.title,
      authSub: (document.querySelector('.auth-sub') || {}).textContent || '',
    }));
    check('顶栏版本号取自 data.js', verUi.brand === verUi.local, JSON.stringify(verUi));
    check('标签页标题含版本号', verUi.title.indexOf(verUi.local) >= 0, verUi.title);
    check('登录页副标题含版本号', verUi.authSub.indexOf(verUi.local) >= 0, verUi.authSub);

    // 热更新：SSE 重连带回服务器版本号 → 客户端发现自己是旧前端就强刷（同版本不刷、已刷过的不再刷）
    const pVer = await ctx.newPage();
    await login(pVer, tokS);
    const verGuard = await pVer.evaluate(() => {
      const local = window.GameData.VERSION;
      const same = window.Net.reloadForVersion(local);            // 版本一致 → 不刷
      try { sessionStorage.setItem('fishing_version_reload', 'v0.0.0-seen'); } catch (e) {}
      const seen = window.Net.reloadForVersion('v0.0.0-seen');    // 该版本已刷过 → 不再刷（防死循环）
      return { local: local, same: same, seen: seen };
    });
    check('版本一致时不触发强刷', verGuard.same === false, JSON.stringify(verGuard));
    check('同一服务器版本只刷一次（防死循环）', verGuard.seen === false, JSON.stringify(verGuard));
    // 真正触发一次：导航会重建页面，所以单独一步、不依赖返回值
    await pVer.evaluate(() => { window.Net.reloadForVersion('v0.0.0-probe'); }).catch(() => {});
    const jumped = await waitFor(() => /v=v0\.0\.0-probe/.test(pVer.url()), { timeout: 8000 }).catch(() => false);
    check('服务器版本不同时强刷并带 cache-bust 参数（热更新）', jumped === true, pVer.url());
    await pVer.close();

    // 连接状态：断线时顶栏给提示，恢复后自动消失（EventSource 会自动重连，不刷新页面）
    const connBadge = await p1.evaluate(() => {
      const prev = window.Net.connState;
      window.Net.connState = function () { return false; };
      window.UI.renderTopbar();
      const off = !!document.querySelector('.player-status .conn-off');
      window.Net.connState = prev;
      window.UI.renderTopbar();
      const cleared = !!document.querySelector('.player-status .conn-off');
      return { off: off, cleared: cleared, ok: window.Net.connState() };
    });
    check('断线时顶栏显示提示', connBadge.off === true, JSON.stringify(connBadge));
    check('重连后提示消失', connBadge.cleared === false && connBadge.ok === true, JSON.stringify(connBadge));
    check('暴露连接状态与轮询接口（供界面与探测使用）', await p1.evaluate(() => typeof window.Net.connState === 'function' && typeof window.Net.probeServer === 'function'));

    // 会话在服务端失效、且客户端没收到 SSE 通知（如 30 天过期 / 服务端清理）时，
    // 兜底探测应主动发现并回到登录页。这里只让 /api/me 返回 401 来隔离这条路径
    // （真实调用 /api/logout 会推 SSE 通知，走的是另一条分支）。
    const rgLost = await post('/api/register', { username: 'lay_lost', password: 'abcd1234', qq: '10031' });
    const pLost = await ctx.newPage();
    await login(pLost, rgLost.data.token);
    await pLost.evaluate(() => {
      const orig = window.fetch;
      window.fetch = function (u, o) {
        if (String(u).indexOf('/api/me') >= 0) {
          return Promise.resolve(new Response(JSON.stringify({ error: '未登录' }), { status: 401, headers: { 'Content-Type': 'application/json' } }));
        }
        return orig.apply(this, arguments);
      };
      return window.Net.probeServer();
    }).catch(() => {});
    const lostBack = await waitFor(async () => pLost.evaluate(() => document.getElementById('auth').style.display === 'flex'),
      { timeout: 6000 }).catch(() => false);
    check('会话失效且无 SSE 通知时，探测把玩家送回登录页', lostBack === true, String(lostBack));
    check('回登录页时给出失效原因', /登录状态已失效/.test(await pLost.textContent('#auth-msg')), await pLost.textContent('#auth-msg'));
    await pLost.close();

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
      const btn = n => Array.from(document.querySelectorAll('.px-node')).find(x => x.textContent.includes(n));
      const fire = (n) => { const b = btn(n); if (b) b.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); return !!b; };
      fire('老旧码头');
      const s1 = window.Engine.state.player.spotId;
      fire('深水区');
      const s2 = window.Engine.state.player.spotId;
      // 点击 ⚡ 子元素（用当前页第一个带标记的钓点）
      let childSpot = null;
      const marked = Array.from(document.querySelectorAll('.px-node .pn-buff'));
      if (marked.length) {
        const name = marked[0].closest('.px-node').textContent.replace('⚡', '').trim();
        marked[0].dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
        childSpot = { name, sel: window.Engine.state.selected.spotId };
      }
      return { s1, s2, childSpot };
    });
    check('pointerdown 可开始钓鱼', spotSwitch.s1 === 'dock', JSON.stringify(spotSwitch));
    check('pointerdown 可切换钓点', spotSwitch.s2 === 'deep', JSON.stringify(spotSwitch));
    if (spotSwitch.childSpot) check('点中 ⚡ 子元素也能选中该钓点', !!spotSwitch.childSpot.sel, JSON.stringify(spotSwitch.childSpot));

    // —— 横幅不遮挡顶栏与内容 ——
    section('横幅遮挡 · 双轨排队 · 公告颜色');
    // 跑马灯靠 CSS 动画 + animationend 推进队列：浏览器会**节流后台标签页的动画**，
    // 被抢到后台时会整段卡住（等待超时）。测横幅前先把玩家页拿到前台，消除这层环境噪声。
    await p1.bringToFront();
    await p1.evaluate(() => window.UI.resetBanners && window.UI.resetBanners());
    await sleep(300);
    // 纪录轨：先播 A；再入队 B → 不打断 A（排队），A 播完后接上 B
    await p1.evaluate(() => window.UI.showRecordBanner({ who: '甲', name: '测试鱼', size: 111, text: '短纪录A' }));
    const sawA = await waitFor(async () => /短纪录A/.test(await p1.textContent('#record-banner')), { timeout: 10000, interval: 200 }).catch(() => false);
    check('纪录横幅开始播放', sawA === true, String(sawA));
    await p1.evaluate(() => window.UI.showRecordBanner({ who: '乙', name: '测试鱼', size: 222, text: '短纪录B' }));
    const stillA = await p1.evaluate(() => (document.getElementById('record-banner').textContent || '').indexOf('短纪录A') >= 0);
    const bannerBox = await p1.evaluate(() => {
      const rec = document.getElementById('record-banner');
      const tb = document.querySelector('.topbar').getBoundingClientRect();
      return { shown: rec.classList.contains('show'), text: (rec.textContent || '').slice(0, 24), bannerBottom: Math.round(rec.getBoundingClientRect().bottom), topbarTop: Math.round(tb.top), pad: getComputedStyle(document.body).paddingTop };
    });
    check('横幅显示时不遮挡顶栏', bannerBox.shown && bannerBox.topbarTop >= bannerBox.bannerBottom - 1, JSON.stringify(bannerBox));
    check('新的纪录横幅不挤掉正在播放的那条（排队播放）', stillA === true, JSON.stringify(bannerBox.text));
    const advanced = await waitFor(async () => /短纪录B/.test(await p1.textContent('#record-banner')), { timeout: 20000, interval: 400 }).catch(() => false);
    check('第一条播完后自动接上第二条（顺序播放）', advanced === true, String(advanced));
    // 公告轨：独立成行 + 自定义颜色
    const adminLoginB = await post('/api/admin/login', { username: 'lay_seller', password: 'abcd1234' });
    if (adminLoginB.data && adminLoginB.data.token) {
      await post('/api/admin/banner/add', { token: adminLoginB.data.token, content: 'QA 公告·红色', duration: 8, color: '#ef4444' });
      await waitFor(async () => (await p1.$$('#notice-banner.show')).length === 1, { timeout: 10000 }).catch(() => {});
      const lane2 = await p1.evaluate(() => {
        const not = document.getElementById('notice-banner');
        const rec = document.getElementById('record-banner');
        const tb = document.querySelector('.topbar').getBoundingClientRect();
        return {
          notShown: not.classList.contains('show'), bg: getComputedStyle(not).backgroundColor,
          notBottom: Math.round(not.getBoundingClientRect().bottom), recShown: rec.classList.contains('show'),
          topbarTop: Math.round(tb.top), bodyPad: getComputedStyle(document.body).paddingTop,
        };
      });
      check('公告使用独立轨道（与纪录轨互不干扰）', lane2.notShown === true, JSON.stringify(lane2));
      check('公告自定义颜色生效（#ef4444）', /239, 68, 68/.test(lane2.bg), String(lane2.bg));
      check('两条轨道都在顶部状态栏之上（整体下移不遮挡）', lane2.topbarTop >= lane2.notBottom - 1 && parseInt(lane2.bodyPad, 10) >= 34, JSON.stringify(lane2));
      await post('/api/admin/banner/clear', { token: adminLoginB.data.token });
    } else {
      check('管理员登录可用（横幅双轨前置）', false, JSON.stringify(adminLoginB.data));
    }

    // ===================== v0.11：工坊 / 商城 / 地图选中 / 纪录图标 / 更新横幅 =====================
    section('v0.11 新页面与新视觉');
    {
      const adminLogin2 = await post('/api/admin/login', { username: 'lay_seller', password: 'abcd1234' });
      const tokAdmin = adminLogin2.data && adminLogin2.data.token;

      // —— 工坊：熔炼页渲染（主/副组件下拉 + 词条胶囊 + 投料行 + 预览） ——
      const wsMain = D_DATA.instanceId('rod_bamboo', 'epic', [{ type: 'speed', value: 12 }, { type: 'size', value: 3 }]);
      // 副件必须与主件同部位（v0.11.1）：同为竿身的龙骨巨竿（带技巧词缀，用于池外搬运）
      const wsSub = D_DATA.instanceId('rod_dragonbone', 'epic', [{ type: 'skill', value: 10 }, { type: 'size', value: 8 }, { type: 'speed', value: -12 }]);
      // 注意顺序：dev/seed 是「整体替换背包」，必须放在 dev/catch 之前
      //（dragon_scale 用于 v0.11.5 的「补缀可越过底材池边界」断言：双钓是竹制短竿池外的词缀）
      await post('/api/dev/seed', { token: tokS, inventory: { crucian: 12, carp: 6, rope: 6, dragon_scale: 6 }, coins: 200000 });
      await post('/api/dev/catch', { token: tokS, item: { kind: 'component', id: wsMain } });
      await post('/api/dev/catch', { token: tokS, item: { kind: 'component', id: wsSub } });
      // 重铸只收「宝匣产出的神话件」：发一件神话组件与足够的残片
      const wsMythic = D_DATA.instanceId('rod_bamboo', 'mythic', [{ type: 'speed', value: 9 }, { type: 'size', value: 3 }, { type: 'skill', value: 4 }, { type: 'rare', value: 2 }]);
      await post('/api/dev/catch', { token: tokS, item: { kind: 'component', id: wsMythic } });
      await post('/api/mall/buy', { token: tokS, id: 'relic', qty: 3 }).catch(() => {});
      const relicNow = await post('/api/dev/seed', { token: tokS, inventory: { crucian: 12, carp: 6, rope: 6, relic: 30, dragon_scale: 6 }, coins: 200000 });
      void relicNow;
      await post('/api/dev/catch', { token: tokS, item: { kind: 'component', id: wsMain } });
      await post('/api/dev/catch', { token: tokS, item: { kind: 'component', id: wsSub } });
      await post('/api/dev/catch', { token: tokS, item: { kind: 'component', id: wsMythic } });
      await clickNav(p1, '工坊');
      await untilSel(p1, '.ws-mat', 8000);
      const wsView = await p1.evaluate(() => ({
        mainPicks: document.querySelectorAll('.ws-pick[data-pick="main"]').length,
        subPicks: document.querySelectorAll('.ws-pick[data-pick="sub"]').length,
        mats: document.querySelectorAll('.ws-mat').length,
        pearl: !!document.getElementById('ws-pearl'),
        go: !!document.getElementById('ws-go'),
        tabs: Array.from(document.querySelectorAll('[data-wstab]')).map(b => b.textContent.trim()),
      }));
      check('工坊熔炼页渲染（主/副组件选择卡 + 投料行 + 宝珠选项 + 熔炼按钮 + 熔炼/重铸页签）',
        wsView.mainPicks === 1 && wsView.subPicks === 1 && wsView.mats >= 6 && wsView.pearl && wsView.go &&
        wsView.tabs.length === 2, JSON.stringify(wsView));

      // —— 组件选择走「与钓竿配置『装备组件』同一个子页面」——
      await p1.click('.ws-pick[data-pick="main"]');
      await untilSel(p1, '.bd-equip-modal .bec-card', 8000);
      const picker1 = await p1.evaluate(() => ({
        title: (document.querySelector('.bd-equip-modal .modal-title') || {}).textContent || '',
        filters: Array.from(document.querySelectorAll('.bd-equip-modal .bf-cat')).map(b => b.textContent.trim()),
        cards: document.querySelectorAll('.bd-equip-modal .bec-card').length,
        partChips: document.querySelectorAll('.bd-equip-modal .bde-controls .bf-cat').length,
      }));
      check('主件选择子页面 = 钓竿配置的组件子页面（标题/筛选/排序/卡片同款）',
        /选择主组件/.test(picker1.title) && picker1.cards >= 2 && picker1.filters.some(t => /全部属性/.test(t)) &&
        picker1.filters.some(t => /稀有度/.test(t)), JSON.stringify(picker1));
      // 选一件当主件（挑名字里带「竹制短竿」的那张卡；神话件排在最前 → 顺手用来验证残片保留入口）
      await p1.evaluate(() => {
        const cards = Array.from(document.querySelectorAll('.bd-equip-modal .bec-card'));
        const card = cards.find(c => c.textContent.includes('竹制短竿') && /神话/.test(c.textContent)) ||
          cards.find(c => c.textContent.includes('竹制短竿')) || cards[0];
        card.querySelector('.bec-acts button').click();
      });
      await untilGet(async () => await p1.textContent('.ws-col .ws-pick-name'), t => /竹制短竿/.test(t || ''), 4000);
      check('选定主件后卡片显示底材/品质/持有数', /竹制短竿/.test(await p1.textContent('.ws-col .ws-pick-name')));
      // 副件选择器应被限定在主件部位（竿身）
      await p1.click('.ws-pick[data-pick="sub"]');
      await untilSel(p1, '.bd-equip-modal .bec-card', 8000);
      const picker2 = await p1.evaluate(() => {
        // 卡片上的贴图文件名就是底材 id，用它判断「列表是否只剩主件的部位」
        const bases = Array.from(document.querySelectorAll('.bd-equip-modal .bec-card img.bec-icon'))
          .map(n => (n.getAttribute('src') || '').replace(/^.*\//, '').replace(/\.png$/, ''));
        const rodBases = (window.GameData.COMPONENT_BASES || []).filter(b => b.part === 'rod').map(b => b.id);
        return {
          title: (document.querySelector('.bd-equip-modal .modal-title') || {}).textContent || '',
          bases: bases,
          allRod: bases.length > 0 && bases.every(id => rodBases.indexOf(id) >= 0),
        };
      });
      check('副件选择器限定同部位（标题点明竿身、列表只剩竿身件）',
        /竿身/.test(picker2.title) && picker2.allRod === true, JSON.stringify(picker2));
      await p1.evaluate(() => {
        const cards = Array.from(document.querySelectorAll('.bd-equip-modal .bec-card'));
        const card = cards.find(c => c.textContent.includes('龙骨巨竿')) || cards[0];
        card.querySelector('.bec-acts button').click();
      });
      await untilGet(async () => await p1.textContent('.ws-col:nth-child(2) .ws-pick-name'), t => /龙骨巨竿/.test(t || ''), 4000);
      check('选定副件后卡片显示（副件只能同部位）', /龙骨巨竿/.test(await p1.textContent('.ws-col:nth-child(2) .ws-pick-name')));
      await p1.click('.ws-aff[data-which="main"][data-type="speed"]');
      await p1.click('.ws-aff[data-which="sub"][data-type="skill"]');
      const wsPrev = await untilGet(async () => await p1.textContent('#ws-preview'), t => /熔炼成功率/.test(t || ''), 4000);
      check('选定词条后出现成功率与花费预览',
        /熔炼成功率\s*\d+(\.\d+)?%/.test(wsPrev || '') && /💰/.test(wsPrev || ''), String(wsPrev).slice(0, 80));
      check('基础成功率 50%（无投料）', /熔炼成功率\s*50%/.test(wsPrev || ''), String(wsPrev).slice(0, 60));
      // —— v0.11.5：预览逐条列出三者的取值区间，并标注区间来源（副件那条按副件区间） ——
      const wsRng = await p1.evaluate(() => ({
        rows: Array.from(document.querySelectorAll('.ws-res-affs li')).map(n => n.textContent.replace(/\s+/g, ' ').trim()),
      }));
      check('预览逐条列出熔炼后词缀与取值区间（主件 / 副件来源）',
        wsRng.rows.length >= 2 && wsRng.rows.some(t => /钓速/.test(t) && /主件区间/.test(t)) &&
        wsRng.rows.some(t => /技巧/.test(t) && /副件区间/.test(t)),
        JSON.stringify(wsRng.rows));
      check('预览的副件区间取自副件底材（技巧 8~14，而非主件的池外 2~6）',
        wsRng.rows.some(t => /技巧/.test(t) && /\+8 ~ \+14%/.test(t)), JSON.stringify(wsRng.rows));
      // —— v0.11.8：词条整块填充高亮 + 投料只列「这次补得进去」的材料（服务端 smelt 校验的同一套判据） ——
      const wsFit = await p1.evaluate(() => {
        const shown = id => {
          const row = document.querySelector('.ws-mat[data-mat="' + id + '"]');
          return !!row && !row.classList.contains('hide');
        };
        const inp = document.querySelector('.ws-mat-qty[data-mat="rope"]');
        inp.value = '2';
        inp.dispatchEvent(new Event('input', { bubbles: true }));
        return {
          rope: shown('rope'),        // 耐磨绳 → 体型：结果里没有，可补 → 该显示
          lure: shown('lure'),        // 反光假饵 → 技巧：副件选中的词缀已在结果里 → 该隐藏
          tide: shown('tide_sand'),   // 潮汐砂 → 钓速：主件选中的词缀已在结果里 → 该隐藏
          qty: inp.value,
          note: (document.getElementById('ws-mats-note') || {}).textContent || '',
        };
      });
      check('投料只显示这次补得进去的材料（结果里已有的词缀不列出来）',
        wsFit.rope === true && wsFit.lure === false && wsFit.tide === false && wsFit.qty === '2' && /只显示/.test(wsFit.note),
        JSON.stringify(wsFit));
      // 改选主件词条 → 体型进了结果：该材料行被隐藏，已填份数一并清掉（否则是「看不见却仍在投」）
      await p1.click('.ws-aff[data-which="main"][data-type="size"]');
      const wsFit2 = await p1.evaluate(() => {
        const row = document.querySelector('.ws-mat[data-mat="rope"]');
        return {
          hidden: row.classList.contains('hide'),
          qty: document.querySelector('.ws-mat-qty[data-mat="rope"]').value,
          prev: (document.getElementById('ws-preview') || {}).textContent || '',
        };
      });
      check('词条改选后该材料被隐藏且份数清零（不再计入投料）',
        wsFit2.hidden === true && wsFit2.qty === '0' && /未投料/.test(wsFit2.prev), JSON.stringify(wsFit2));
      await p1.click('.ws-aff[data-which="main"][data-type="speed"]');   // 还原主件词条，后续断言照旧
      const wsPill = await p1.evaluate(() => {
        const cs = getComputedStyle(document.querySelector('.ws-aff[data-which="main"][data-type="speed"]'));
        return { bg: cs.backgroundColor, color: cs.color, weight: cs.fontWeight };
      });
      const lumOf = s => {
        const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(s || '');
        return m ? (Number(m[1]) + Number(m[2]) + Number(m[3])) / 3 : 0;
      };
      check('选中的词条整块填充高亮（亮底 + 深色字，不再只是文字变色）',
        lumOf(wsPill.bg) > 90 && lumOf(wsPill.color) < 90 && Number(wsPill.weight) >= 700, JSON.stringify(wsPill));
      // 投料：补一条主件池外的词缀（龙鳞碎屑 → 双钓），预览应标出「池外区间」并按池外区间取值
      const wsAddPrev = await p1.evaluate(async () => {
        const inp = document.querySelector('.ws-mat-qty[data-mat="dragon_scale"]');
        if (!inp || inp.disabled) return null;
        inp.value = '2';
        inp.dispatchEvent(new Event('input', { bubbles: true }));
        await new Promise(r => setTimeout(r, 120));
        return {
          rows: Array.from(document.querySelectorAll('.ws-res-affs li')).map(n => n.textContent.replace(/\s+/g, ' ').trim()),
          prev: (document.getElementById('ws-preview') || {}).textContent || '',
        };
      });
      check('投料可补主件池外的词缀（双钓标为池外区间，不再提示「没有可补」）',
        !!wsAddPrev && wsAddPrev.rows.some(t => /双钓/.test(t) && /池外区间/.test(t)) && !/没有可补/.test(wsAddPrev.prev || ''),
        JSON.stringify(wsAddPrev && wsAddPrev.rows));
      await p1.evaluate(() => {
        const inp = document.querySelector('.ws-mat-qty[data-mat="dragon_scale"]');
        inp.value = '0';
        inp.dispatchEvent(new Event('input', { bubbles: true }));
      });

      // —— v0.11.3：神话主件的「残片保留」入口（勾选后拉满片数 → 保留概率 100%） ——
      const relicRow0 = await p1.evaluate(() => ({
        row: !!document.getElementById('ws-relic-row'),
        on: !!(document.getElementById('ws-relic-on') || {}).checked,
        affs: (document.querySelector('.wrl-affs') || {}).textContent || '',
      }));
      check('神话（海王遗匣）主件出现 🛡 残片保留入口，并列出可保留的池外词缀',
        relicRow0.row && relicRow0.on === false && /技巧|稀有概率/.test(relicRow0.affs), JSON.stringify(relicRow0));
      await p1.click('#ws-relic-on');
      const relicRow1 = await untilGet(async () => await p1.evaluate(() => ({
        qty: (document.getElementById('ws-relic-qty') || {}).value,
        max: (document.getElementById('ws-relic-qty') || {}).max,
        chance: (document.getElementById('ws-relic-chance') || {}).textContent || '',
        prev: (document.getElementById('ws-preview') || {}).textContent || '',
      })), o => /保留概率/.test(o.chance), 4000);
      check('勾选残片后拉满片数（10 片）并即时算出保留概率 100%',
        relicRow1.qty === '10' && relicRow1.max === '10' && /100%/.test(relicRow1.chance) && /不影响成功率/.test(relicRow1.prev),
        JSON.stringify({ q: relicRow1.qty, m: relicRow1.max, c: relicRow1.chance }));
      check('预览提示残片不改变成功率（熔炼成功率仍为 50%）', /熔炼成功率\s*50%/.test(relicRow1.prev), String(relicRow1.prev).slice(0, 90));
      await p1.click('#ws-relic-on');
      const relicRow2 = await untilGet(async () => await p1.evaluate(() => {
        const row = document.getElementById('ws-relic-row');
        return {
          hidden: !row || row.offsetParent === null || getComputedStyle(row).display === 'none',
          on: !!(document.getElementById('ws-relic-on') || {}).checked,
          rowExists: !!row,
        };
      }), o => o.on === false, 4000);
      check('取消勾选后片数输入收起（不投入残片，入口仍在）',
        relicRow2.hidden === true && relicRow2.on === false && relicRow2.rowExists === true, JSON.stringify(relicRow2));

      // —— v0.11.4：资产广播（上鱼 / 获得材料）不再整页重建工坊 ——
      //  此前每次上鱼都会 main.innerHTML='' 重画整页：正在填的投料份数、输入焦点与光标全被冲掉，
      //  整页也跟着闪一下。现在只原地更新「持有」数字与预览。
      const wsFocus = await p1.evaluate(() => {
        const inp = Array.from(document.querySelectorAll('.ws-mat-qty')).find(x => !x.disabled);
        if (!inp) return null;
        const lab = inp.closest('.ws-mat');
        inp.focus();
        inp.value = '3';
        inp.dispatchEvent(new Event('input', { bubbles: true }));
        window.__wsProbe = { inp: inp, lab: lab, key: inp.getAttribute('data-mat') };
        return {
          id: lab.getAttribute('data-mat'), have: lab.querySelector('.wm-have').textContent,
          focused: document.activeElement === inp, color: getComputedStyle(inp).color,
        };
      });
      check('工坊投料输入框可聚焦并填入份数', !!wsFocus && wsFocus.focused === true, JSON.stringify(wsFocus));
      const lum = (m => m ? (Number(m[1]) + Number(m[2]) + Number(m[3])) / 3 : 0)(/rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec((wsFocus || {}).color || ''));
      check('工坊输入框文字为亮色（可辨识，不再是默认近黑色）', lum > 180, ((wsFocus || {}).color || '') + ' lum=' + lum);
      await post('/api/dev/catch', { token: tokS, item: { kind: 'material', id: wsFocus.id }, ground: '静水湖', spot: '芦苇浅滩' });
      await waitFor(async () => (await p1.evaluate(() => {
        const pr = window.__wsProbe;
        return pr && pr.lab && document.contains(pr.lab) ? pr.lab.querySelector('.wm-have').textContent : '';
      })) !== wsFocus.have, { timeout: 8000, interval: 200 }).catch(() => {});
      const wsAfter = await p1.evaluate(() => {
        const pr = window.__wsProbe || {};
        return {
          same: !!pr.inp && document.contains(pr.inp) && document.querySelector('.ws-mat-qty[data-mat="' + pr.key + '"]') === pr.inp,
          focused: document.activeElement === pr.inp,
          value: pr.inp ? pr.inp.value : '',
          have: pr.lab && document.contains(pr.lab) ? pr.lab.querySelector('.wm-have').textContent : '',
          page: !!document.querySelector('.ws-panel'),
        };
      });
      check('获得材料后工坊输入框节点未重建、焦点与已填份数保持',
        wsAfter.same === true && wsAfter.focused === true && wsAfter.value === '3' && wsAfter.page === true, JSON.stringify(wsAfter));
      check('「持有 N」随资产广播原地更新（页面其余部分不动）',
        wsAfter.have !== wsFocus.have, JSON.stringify({ before: wsFocus.have, after: wsAfter.have }));
      await p1.evaluate(() => { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); });

      // —— v0.11.4：选择器的筛选不再跨弹窗残留 ——
      // 曾经：在工坊主件选择器里按「竿身」筛过 → 关闭后去钓竿配置装备别的部位时，
      // 列表被上一个弹窗的部位筛选整个滤空，看起来像「组件都不见了」。
      await p1.click('.ws-pick[data-pick="main"]');
      await untilSel(p1, '.bd-equip-modal .bde-controls', 6000);
      const wsPartFilter = await p1.evaluate(async () => {
        const modal = document.querySelector('.bd-equip-modal');
        const b = Array.from(modal.querySelectorAll('.bde-controls .bf-cat')).find(x => x.textContent.trim() === '竿身');
        if (!b) return { ok: false, why: 'no part filter' };
        b.click();
        await new Promise(r => setTimeout(r, 120));
        return { ok: true, filtered: modal.querySelectorAll('.bec-card').length };
      });
      check('工坊选择器有部位筛选（竿身）', wsPartFilter.ok === true, JSON.stringify(wsPartFilter));
      await p1.evaluate(() => { document.querySelector('.bd-equip-modal .modal-close').click(); });
      await sleep(150);
      await clickNav(p1, '钓竿配置');
      await untilSel(p1, '.bd-cell', 6000);
      const afterPart = await p1.evaluate(async () => {
        const cells = Array.from(document.querySelectorAll('.bd-cell'));
        const cell = cells.find(c => Array.from(c.querySelectorAll('button')).some(x => x.textContent.includes('装备组件')));
        const btn = cell && Array.from(cell.querySelectorAll('button')).find(x => x.textContent.includes('装备组件'));
        if (!btn) return { ok: false, why: 'no equip button' };
        btn.click();
        await new Promise(r => setTimeout(r, 180));
        const m = document.querySelector('.bd-equip-modal');
        if (!m) return { ok: false, why: 'no modal' };
        const onPart = Array.from(m.querySelectorAll('.bde-controls .bf-cat')).find(x => x.classList.contains('on') && ['竿身', '线组', '钩', '饵', '卷线器', '配件', '饰品栏位'].indexOf(x.textContent.trim()) >= 0);
        return { ok: true, cards: m.querySelectorAll('.bec-card').length, part: cell.querySelector('.bd-part').textContent.trim(), onPart: onPart ? onPart.textContent.trim() : '' };
      });
      check('在别处按部位筛过后，重开选择器不会被那个筛选滤空（列表非空）',
        afterPart.ok === true && afterPart.cards >= 1 && afterPart.onPart !== '竿身',
        JSON.stringify({ part: afterPart.part, cards: afterPart.cards, onPart: afterPart.onPart, filteredInWs: wsPartFilter.filtered }));
      await p1.evaluate(() => { const b = document.querySelector('.bd-equip-modal .modal-close'); if (b) b.click(); });
      await sleep(120);
      await clickNav(p1, '工坊');
      await untilSel(p1, '#ws-go', 6000);

      // —— 重铸页：放入组件后自动列出所需材料 ——
      await p1.click('[data-wstab="recast"]');
      await untilSel(p1, '#ws-recast-go', 6000);
      const rc0 = await p1.evaluate(() => ({
        mats: Array.from(document.querySelectorAll('#ws-recast-mats .ws-mat')).map(n => n.textContent.replace(/\s+/g, ' ').trim()),
        btn: (document.getElementById('ws-recast-go') || {}).textContent || '',
        disabled: !!(document.getElementById('ws-recast-go') || {}).disabled,
      }));
      check('重铸页自动列出所需材料（沉船宝匣残片，未选组件时按钮禁用）',
        rc0.mats.length >= 1 && /沉船宝匣残片/.test(rc0.mats[0]) && /需要/.test(rc0.mats[0]) && rc0.disabled === true,
        JSON.stringify(rc0));
      await p1.click('[data-recast-pick]');
      await untilSel(p1, '.bd-equip-modal .bec-card', 8000);
      const rcPicker = await p1.evaluate(() => ({
        title: (document.querySelector('.bd-equip-modal .modal-title') || {}).textContent || '',
        cards: document.querySelectorAll('.bd-equip-modal .bec-card').length,
        quals: Array.from(document.querySelectorAll('.bd-equip-modal .inst-meta')).map(n => n.textContent),
      }));
      check('重铸选择器只列神话件（宝匣产出）',
        /重铸/.test(rcPicker.title) && rcPicker.cards >= 1 && rcPicker.quals.every(t => /神话/.test(t)),
        JSON.stringify({ t: rcPicker.title, n: rcPicker.cards, q: rcPicker.quals.slice(0, 2) }));
      await p1.evaluate(() => { document.querySelector('.bd-equip-modal .bec-acts button').click(); });
      const rcBtn = await untilGet(async () => await p1.textContent('#ws-recast-go'), t => /开始重铸/.test(t || ''), 4000);
      check('选定神话件后按钮可用并显示花费', /开始重铸/.test(rcBtn || ''), String(rcBtn).slice(0, 40));

      // —— v0.11.4：重铸选中的组件若被消耗（出售 / 熔炼 / 交易），重绘时自动清除悬空引用 ——
      // 曾经：重铸页选了 A，再去熔炼把 A 熔掉，重铸页依旧显示 A（点重铸只会报错）。
      const ghostMythic = D_DATA.instanceId('rod_bamboo', 'mythic', [{ type: 'speed', value: 9 }, { type: 'skill', value: 4 }, { type: 'rare', value: 2 }]);
      await post('/api/dev/catch', { token: tokS, item: { kind: 'component', id: ghostMythic } });
      await sleep(250);
      await p1.click('[data-recast-pick]');
      await untilSel(p1, '.bd-equip-modal .bec-card', 6000);
      const pickedGhost = await p1.evaluate(() => {
        const cards = Array.from(document.querySelectorAll('.bd-equip-modal .bec-card'));
        const card = cards.find(c => !/体型/.test(c.textContent)) || cards[0];   // 刚发的这件没有体型词条
        if (!card) return { ok: false };
        const name = (card.querySelector('.bec-name') || {}).textContent || '';
        card.querySelector('.bec-acts button').click();
        return { ok: true, name: name.replace(/\s+/g, ' ').trim().slice(0, 24) };
      });
      await sleep(250);
      const ghostBefore = await p1.evaluate(() => ({
        chosen: !!document.querySelector('.ws-col .ws-pick.chosen'),
        name: ((document.querySelector('.ws-col .ws-pick-name') || {}).textContent || '').trim(),
      }));
      check('重铸页选中组件后卡片显示该件', pickedGhost.ok === true && ghostBefore.chosen === true && ghostBefore.name !== '',
        JSON.stringify({ picked: pickedGhost, before: ghostBefore }));
      await post('/api/sell', { token: tokS, id: ghostMythic, qty: 1 });   // 卖掉 → 该实例从背包消失
      // 直连 API 出售不会推 assets（只有 UI 内的出售会用响应里的背包），
      // 这里再用一次 dev/catch 触发权威 assets 同步（等价于玩家自己卖掉后收到广播）
      await post('/api/dev/catch', { token: tokS, item: { kind: 'fish', id: 'crucian', rarity: 'common', name: '鲫鱼', size: 30 }, ground: '静水湖', spot: '芦苇浅滩' });
      await sleep(400);
      // 任意一次重绘（切页签）都会校验选中项是否还在背包
      await p1.click('[data-wstab="smelt"]');
      await sleep(200);
      await p1.click('[data-wstab="recast"]');
      await sleep(300);
      const ghostAfter = await p1.evaluate(() => ({
        empty: !!document.querySelector('.ws-col .ws-pick.empty'),
        name: ((document.querySelector('.ws-col .ws-pick-name') || {}).textContent || '').trim(),
        disabled: !!(document.getElementById('ws-recast-go') || {}).disabled,
      }));
      check('重铸选中的组件被卖掉后，重绘时自动清除（不再显示已不存在的件、按钮回到禁用）',
        ghostAfter.empty === true && ghostAfter.name === '' && ghostAfter.disabled === true,
        JSON.stringify({ before: ghostBefore, after: ghostAfter }));

      // —— 商城：商品卡 + 限购文案 + 购买 ——
      await clickNav(p1, '商城');
      await untilSel(p1, '.mall-card', 8000);
      const mallView = await p1.evaluate(() => ({
        cards: document.querySelectorAll('.mall-card').length,
        bar: (document.querySelector('.mall-bar') || {}).textContent || '',
        limit: (document.querySelector('.mc-limit') || {}).textContent || '',
      }));
      check('商城页渲染商品卡', mallView.cards >= 3, JSON.stringify(mallView.cards));
      check('商城顶部显示刷新时间与金币', /限购刷新时间/.test(mallView.bar) && /💰/.test(mallView.bar), mallView.bar.slice(0, 80));
      check('商品卡显示每日限购剩余', /限购/.test(mallView.limit), mallView.limit);
      await p1.click('.mall-card .mc-acts button');
      await untilSel(p1, '.modal-box', 4000);
      await p1.click('.modal-box .cf-ok');
      const bought = await waitFor(async () => {
        const mv = (await get('/api/mall?token=' + tokS)).data;
        return !!mv && mv.items.some(x => x.bought > 0);
      }, { timeout: 8000 }).catch(() => false);
      check('商城购买成功（服务器记入限购计数）', bought === true, String(bought));

      // —— 钓鱼页：选中钓点的框体变黄（与增益钓点同一套金色） ——
      if (tokAdmin) {
        await post('/api/admin/spot/buffs', { token: tokAdmin, groundId: 'stillwater', spotId: 'reed', buffs: [{ type: 'speed', value: 20 }] });
      }
      await clickNav(p1, '钓鱼');
      await untilSel(p1, '.px-node', 8000);
      const idleVsBuffed = await p1.evaluate(() => {
        const buffed = document.querySelector('.px-node.buffed .pn-name');
        const idle = document.querySelector('.px-node:not(.buffed):not(.on) .pn-name');
        return { buffed: buffed ? getComputedStyle(buffed).borderColor : null, idle: idle ? getComputedStyle(idle).borderColor : null };
      });
      check('普通钓点不是金色边框（增益钓点才是）',
        !!idleVsBuffed.buffed && idleVsBuffed.idle !== idleVsBuffed.buffed, JSON.stringify(idleVsBuffed));
      await p1.evaluate(() => {
        const n = Array.from(document.querySelectorAll('.px-node')).find(x => x.getAttribute('data-g') && !x.classList.contains('buffed'));
        n.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      });
      await untilSel(p1, '.px-node.on', 6000);
      const selColor = await p1.evaluate(() => {
        const sel = document.querySelector('.px-node.on .pn-name');
        const buffed = document.querySelector('.px-node.buffed .pn-name');
        return {
          sel: sel ? getComputedStyle(sel).borderColor : null,
          buffed: buffed ? getComputedStyle(buffed).borderColor : null,
        };
      });
      check('玩家选定钓点后框体变黄，且与增益钓点同色',
        !!selColor.sel && !!selColor.buffed && selColor.sel === selColor.buffed, JSON.stringify(selColor));
      await p1.evaluate(() => {
        const n = Array.from(document.querySelectorAll('.px-node')).find(x => x.classList.contains('on'));
        if (n) n.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      });
      await sleep(200);

      // —— 渔获记录：全场最大鱼图标放大到 175%（140×84 → 245×147） ——
      await clickNav(p1, '渔获记录');
      await untilSel(p1, '.rh-icon', 8000);
      const rhSize = await p1.evaluate(() => {
        const cs = getComputedStyle(document.querySelector('.rh-icon'));
        return { w: Math.round(parseFloat(cs.width)), h: Math.round(parseFloat(cs.height)) };
      });
      check('全场最大鱼图标为原来的 175%（245×147）', rhSize.w === 245 && rhSize.h === 147, JSON.stringify(rhSize));
      check('纪录页不再出现「大鱼」品质配色（r-big）', (await p1.$$('.content .r-big')).length === 0);

      // —— 桌面端侧栏：不高于视口且导航可滚动 ——
      const sidebarBox = await p1.evaluate(() => {
        const sb = document.querySelector('.sidebar');
        const nav = document.querySelector('.nav');
        const cs = getComputedStyle(nav);
        return {
          sbH: Math.round(sb.getBoundingClientRect().height), vh: window.innerHeight,
          overflowY: cs.overflowY, scrollable: nav.scrollHeight > nav.clientHeight + 1,
          items: document.querySelectorAll('.nav-item').length,
        };
      });
      check('侧边栏不超过视口高度', sidebarBox.sbH <= sidebarBox.vh, JSON.stringify(sidebarBox));
      check('导航区可滚动（overflow-y 生效）', sidebarBox.overflowY === 'auto' || sidebarBox.overflowY === 'scroll', JSON.stringify(sidebarBox));

      // —— 顶栏状态块点击跳转（判定以框体为准）——
      await clickNav(p1, '钓鱼');
      const topbarNav = await p1.evaluate(async () => {
        const out = {};
        const clickChip = async (re, expect) => {
          const btn = Array.from(document.querySelectorAll('#player-status .meta-btn')).find(b => re.test(b.textContent));
          if (!btn) return 'missing';
          btn.click();
          await new Promise(r => setTimeout(r, 250));
          const active = document.querySelector('.nav-item.active');
          out[expect] = active ? (active.textContent.includes(expect) ? 'ok' : active.textContent) : 'none';
          return 'ok';
        };
        // 状态 → 钓鱼
        await clickChip(/状态：/, '钓鱼');
        // 位置 → 钓鱼
        await clickChip(/位置：/, '钓鱼');
        // 抛竿间隔 → 钓竿配置
        await clickChip(/🎣.*s 一竿/, '钓竿配置');
        // 在线人数 → 渔场动态
        await clickChip(/在线：/, '渔场动态');
        return out;
      });
      check('点击「状态」跳到钓鱼页', topbarNav['钓鱼'] === 'ok', JSON.stringify(topbarNav));
      check('点击「抛竿间隔」跳到钓竿配置页', topbarNav['钓竿配置'] === 'ok', JSON.stringify(topbarNav));
      check('点击「在线人数」跳到渔场动态页', topbarNav['渔场动态'] === 'ok', JSON.stringify(topbarNav));
      check('顶栏状态块是按钮（整块可点）',
        (await p1.$$('#player-status button.meta-btn')).length >= 4, String((await p1.$$('#player-status button.meta-btn')).length));

      // —— 未开放的钓点：🔒 +（暂未开放） ——
      // 上面的顶栏跳转把页面带到了渔场动态，先回钓鱼页再测地图
      await clickNav(p1, '钓鱼');
      await untilSel(p1, '.px-map-tab', 8000);
      const lockedTab = await p1.evaluate(() => {
        const tabs = Array.from(document.querySelectorAll('.px-map-tab'));
        const t = tabs.find(x => /出海/.test(x.textContent));
        if (t) t.click();
        return !!t;
      });
      await sleep(300);
      const lockedNode = await p1.evaluate(() => {
        const node = document.querySelector('.px-node.locked');
        return node ? { lock: !!node.querySelector('.pn-lock'), text: (node.textContent || '').slice(0, 40), bob: !!node.querySelector('.pn-bob') } : null;
      });
      check('未开放钓点显示 🔒 图标 +（暂未开放）且不再显示浮漂',
        !!lockedNode && lockedNode.lock === true && /（暂未开放）/.test(lockedNode.text) && lockedNode.bob === false,
        JSON.stringify(lockedNode));
      check('未开放钓点整组都是锁定态（🎣 近岸活动场锁定后同样标注）',
        (await p1.$$('.px-node.locked')).length >= 3, String((await p1.$$('.px-node.locked')).length));
      if (lockedTab) {
        await p1.evaluate(() => {
          const tabs = Array.from(document.querySelectorAll('.px-map-tab'));
          const t = tabs.find(x => /近岸/.test(x.textContent));
          if (t) t.click();
        });
        await sleep(250);
      }

      // —— 渔获纪录贴图：后台调缩放 / 偏移后玩家端即时生效 ——
      if (tokAdmin) {
        await post('/api/admin/records/config', { token: tokAdmin, scale: 300, x: 12, y: -8 });
        await clickNav(p1, '渔获记录');
        await untilSel(p1, '.rh-icon', 8000);
        const rh = await untilGet(async () => await p1.evaluate(() => {
          const n = document.querySelector('.rh-icon');
          const cs = getComputedStyle(n);
          return { w: Math.round(parseFloat(cs.width)), h: Math.round(parseFloat(cs.height)), tf: cs.transform, inline: n.getAttribute('style') || '' };
        }), v => v && v.w === Math.round(140 * 3), 6000);
        check('纪录贴图按后台设置缩放（300% → 420×252）', rh && rh.w === 420 && rh.h === 252, JSON.stringify(rh));
        check('纪录贴图带 xy 偏移（translate 12,-8）', !!rh && /12[^0-9]/.test(rh.inline) && /-8/.test(rh.inline), rh && rh.inline);
        await post('/api/admin/records/config', { token: tokAdmin, reset: true });
        const rh2 = await untilGet(async () => await p1.evaluate(() => Math.round(parseFloat(getComputedStyle(document.querySelector('.rh-icon')).width))), w => w === 245, 6000);
        check('恢复默认后回到 175%（245px）', rh2 === 245, String(rh2));
      } else {
        check('管理员登录可用（纪录贴图前置）', false, '');
      }

      // —— 版本更新横幅：发布 → 60 秒倒计时横幅 → 取消后撤回 ——
      if (tokAdmin) {
        const upStart = await post('/api/admin/update/start', { token: tokAdmin, bat: 'run.bat', note: 'UI 验证', dryRun: true });
        check('发布更新成功（演练）', upStart.status === 200 && !!upStart.data.update, JSON.stringify(upStart.data).slice(0, 100));
        const shown = await waitFor(async () => (await p1.$$('#update-banner.show')).length === 1, { timeout: 8000 }).catch(() => false);
        check('全服出现更新通知横幅', shown === true, String(shown));
        const upBox = await p1.evaluate(() => {
          const u = document.getElementById('update-banner');
          const tb = document.querySelector('.topbar').getBoundingClientRect();
          return {
            text: (u.textContent || '').slice(0, 80),
            bottom: Math.round(u.getBoundingClientRect().bottom),
            topbarTop: Math.round(tb.top),
            pad: getComputedStyle(document.body).paddingTop,
          };
        });
        check('横幅文案含倒计时与脚本名', /秒后重启/.test(upBox.text) && /run\.bat/.test(upBox.text), upBox.text);
        check('更新横幅不遮挡顶栏（页面下移）', upBox.topbarTop >= upBox.bottom - 1 && parseInt(upBox.pad, 10) >= 44, JSON.stringify(upBox));
        await post('/api/admin/update/cancel', { token: tokAdmin });
        const gone = await waitFor(async () => (await p1.$$('#update-banner.show')).length === 0, { timeout: 8000 }).catch(() => false);
        check('取消更新后横幅撤回', gone === true, String(gone));
      } else {
        check('管理员登录可用（版本更新前置）', false, JSON.stringify(adminLogin2.data));
      }

      // ================= v0.11.11：市集组件部位筛选 + 钓竿自动配装 =================
      // —— 市集「组件」分类下的「部位」二级筛选（与背包物品明细同一套口径）——
      // 「购买市场」只列**别人**的挂单，所以这两单必须挂在 tokB 名下才看得到。
      section('市集组件部位筛选（真实 Chrome）');
      const mkRod = D_DATA.instanceId('rod_bamboo', 'rare', [{ type: 'speed', value: 15 }, { type: 'double', value: 4 }]);
      const mkHook = D_DATA.instanceId('hook_barb', 'rare', [{ type: 'double', value: 6 }, { type: 'size', value: 3 }]);
      await post('/api/dev/catch', { token: tokB, item: { kind: 'component', id: mkRod } });
      await post('/api/dev/catch', { token: tokB, item: { kind: 'component', id: mkHook } });
      const mkL1 = await post('/api/market/list', { token: tokB, id: mkRod, qty: 1, price: 800, hours: 6 });
      const mkL2 = await post('/api/market/list', { token: tokB, id: mkHook, qty: 1, price: 700, hours: 6 });
      check('前置：两件不同部位组件挂单成功（另一账号挂的）',
        mkL1.status === 200 && mkL2.status === 200, JSON.stringify(mkL1.data).slice(0, 140));
      await clickNav(p1, '开放市集');
      // 前面的用例可能把市集停在我的挂单页签，这里显式切回「购买市场」
      await p1.evaluate(() => { const b = Array.from(document.querySelectorAll('.inv-cat')).find(x => x.textContent.includes('购买市场')); if (b) b.click(); });
      await sleep(300);
      await p1.evaluate(() => { const b = Array.from(document.querySelectorAll('.bf-cat')).find(x => x.textContent.trim().indexOf('组件') === 0); if (b) b.click(); });
      const mkSub = await untilGet(async () => await p1.evaluate(() => {
        const row = document.querySelector('.bf-subrow');
        if (!row) return null;
        return {
          label: (row.querySelector('.sub-label') || {}).textContent || '',
          chips: Array.from(row.querySelectorAll('button')).map(b => b.textContent.trim()),
        };
      }), v => !!v, 6000);
      check('市集「组件」分类出现「部位」二级筛选行', !!mkSub && mkSub.label === '部位', JSON.stringify(mkSub));
      check('部位行按在售挂单数列出部位（竿身 / 钩）',
        !!mkSub && mkSub.chips.some(t => /^竿身 \d+$/.test(t)) && mkSub.chips.some(t => /^钩 \d+$/.test(t)),
        JSON.stringify(mkSub && mkSub.chips));
      await p1.evaluate(() => {
        const row = document.querySelector('.bf-subrow');
        const b = Array.from(row.querySelectorAll('button')).find(x => x.textContent.trim().indexOf('竿身') === 0);
        if (b) b.click();
      });
      const mkFilt = await untilGet(async () => await p1.evaluate(() => ({
        on: (document.querySelector('.bf-subrow button.on') || {}).textContent || '',
        rows: Array.from(document.querySelectorAll('.mk-row .mk-name')).map(n => n.textContent.replace(/\s+/g, ' ')),
      })), v => v && /^竿身/.test(v.on) && v.rows.some(t => t.indexOf('竹制短竿') >= 0), 6000);
      check('点「竿身」只剩竿身组件挂单（钩被筛掉）',
        mkFilt.rows.some(t => t.indexOf('竹制短竿') >= 0) && !mkFilt.rows.some(t => t.indexOf('倒刺钩') >= 0),
        JSON.stringify(mkFilt).slice(0, 220));
      // 清理：回到「全部」并下架这两单，避免影响别的用例的挂单计数
      await p1.evaluate(() => {
        const row = document.querySelector('.bf-subrow');
        const b = Array.from(row.querySelectorAll('button')).find(x => x.textContent.trim().indexOf('全部') === 0);
        if (b) b.click();
      });
      await sleep(200);
      await post('/api/market/cancel', { token: tokB, lid: mkL1.data.listing.lid });
      await post('/api/market/cancel', { token: tokB, lid: mkL2.data.listing.lid });

      // —— 钓竿自动配装：优先级 / 目标区间 / 可达上限 / 一键装配 ——
      section('钓竿自动配装（真实 Chrome）');
      const abA = D_DATA.instanceId('rod_bamboo', 'common', [{ type: 'speed', value: 20 }]);
      const abB = D_DATA.instanceId('rod_bamboo', 'common', [{ type: 'speed', value: 10 }, { type: 'double', value: 8 }]);
      const abC = D_DATA.instanceId('hook_barb', 'common', [{ type: 'double', value: 12 }]);
      const abD = D_DATA.instanceId('hook_barb', 'common', [{ type: 'skill', value: 9 }]);
      for (const id of [abA, abB, abC, abD]) await post('/api/dev/catch', { token: tokS, item: { kind: 'component', id: id } });
      await clickNav(p1, '钓竿配置');
      await untilSel(p1, '.bd-auto-bar .ab-open-btn', 6000);
      check('钓竿配置页出现「自动配装」入口', (await p1.$$('.bd-auto-bar .ab-open-btn')).length === 1, '');
      await p1.click('.bd-auto-bar .ab-open-btn');
      await untilSel(p1, '.ab-modal .ab-row', 6000);
      const ab0 = await p1.evaluate(() => ({
        rows: document.querySelectorAll('.ab-modal .ab-row').length,
        first: ((document.querySelector('.ab-modal .ab-row .ab-en') || {}).textContent || '').trim(),
        planRows: document.querySelectorAll('.ab-modal .ab-plan-row').length,
        diffRows: document.querySelectorAll('.ab-modal .ab-diff-row').length,
        peeks: Array.from(document.querySelectorAll('.ab-modal .ab-peek')).map(n => n.textContent),
      }));
      check('面板列出 6 个属性优先级行（默认钓速优先）',
        ab0.rows === 6 && /钓速/.test(ab0.first), JSON.stringify(ab0).slice(0, 180));
      check('面板列出 7 个部位的推荐 + 6 项属性对比',
        ab0.planRows === 7 && ab0.diffRows === 6, JSON.stringify({ p: ab0.planRows, d: ab0.diffRows }));
      check('每行显示该属性的「可达」上限',
        ab0.peeks.length === 6 && ab0.peeks.every(t => /可达/.test(t)), JSON.stringify(ab0.peeks).slice(0, 200));

      // 面板打开时会向服务器对齐装配（本地 bd 可能是旧的：整竿上架/收起后本地没跟着刷新）
      const AB_PART_KEYS = ['rod', 'line', 'hook', 'bait', 'reel', 'accessory', 'charm'];
      const bdSig = (bd) => AB_PART_KEYS.map(k => (bd && bd[k] && bd[k].compId) || '-').join('|');
      const srvBd = ((await get('/api/me?token=' + encodeURIComponent(tokS))).data || {}).bd || {};
      const cliSig = await untilGet(
        async () => await p1.evaluate(keys => keys.map(k => (window.Engine.state.bd[k] && window.Engine.state.bd[k].compId) || '-').join('|'), AB_PART_KEYS),
        v => v === bdSig(srvBd), 8000);
      check('打开配装器时把本地装配对齐到服务器（旧装配会被纠正）',
        cliSig === bdSig(srvBd), cliSig + ' vs ' + bdSig(srvBd));

      // 面板读数：属性对比顺序 = AFFIX_TYPES（speed/skill/rare/material/size/double）
      const AB_IDX = { speed: 0, skill: 1, rare: 2, material: 3, size: 4, double: 5 };
      const readAb = () => p1.evaluate(() => {
        const num = (node) => { const m = /(-?\d+)/.exec((node || {}).textContent || ''); return m ? Number(m[1]) : 0; };
        const diffs = Array.from(document.querySelectorAll('.ab-modal .ab-diff-row')).map(r => ({
          now: num(r.querySelector('.abd-cur')), next: num(r.querySelector('.abd-new')),
        }));
        const plan = Array.from(document.querySelectorAll('.ab-modal .ab-plan-row')).map(r => ({
          part: ((r.querySelector('.abp-part') || {}).textContent || '').trim(),
          next: ((r.querySelector('.abp-new') || {}).textContent || '').trim(),
          tag: ((r.querySelector('.abp-tag') || {}).textContent || '').trim(),
        }));
        const btn = document.querySelector('.ab-modal .ab-apply') || {};
        const peekRow = document.querySelectorAll('.ab-modal .ab-row')[1] || document.querySelector('.ab-modal .ab-row');
        return {
          diffs: diffs, plan: plan,
          prio: ((document.querySelector('.ab-modal .ab-res .ab-hint') || {}).textContent || '').trim(),
          warn: ((document.querySelector('.ab-modal .ab-warn') || {}).textContent || '').trim(),
          btn: btn.textContent || '', disabled: !!btn.disabled,
          peekCls: (peekRow.querySelector('.ab-peek') || {}).className || '',
        };
      });
      const abV0 = await readAb();
      const S0 = abV0.diffs[AB_IDX.speed].next, D0 = abV0.diffs[AB_IDX.double].next;
      check('默认（钓速优先）方案把钓速做到 ≥ 20（含刚发的钓速 20 那件）',
        S0 >= 20 && abV0.plan.length === 7, JSON.stringify({ S0: S0, D0: D0 }));
      // 双钓抬到优先级第 1 位 → 双钓只能更高、钓速只能更低（字典序最优的必然性质）
      await p1.evaluate(() => {
        const row = document.querySelectorAll('.ab-modal .ab-row')[0];
        row.querySelectorAll('.ab-mv')[1].click();   // ↓
      });
      const abV1 = await readAb();
      check('优先级调整：双钓升到第 1 位（面板提示同步）',
        /^优先级：🎣 双钓/.test(abV1.prio), abV1.prio.slice(0, 80));
      check('双钓优先后：双钓不降、钓速不升',
        abV1.diffs[AB_IDX.double].next >= D0 && abV1.diffs[AB_IDX.speed].next <= S0,
        JSON.stringify({ D1: abV1.diffs[AB_IDX.double].next, S1: abV1.diffs[AB_IDX.speed].next, D0: D0, S0: S0 }));
      // 把「钓速下限」设成默认方案的值 → 在双钓优先下也必须保住钓速，双钓回到该约束下的最优
      await p1.evaluate((s0) => {
        const row = document.querySelectorAll('.ab-modal .ab-row')[1];   // 钓速已降到第 2 行
        const inp = row.querySelectorAll('.ab-num')[0];
        inp.value = String(s0);
        inp.dispatchEvent(new Event('change', { bubbles: true }));
      }, S0);
      const abV2 = await readAb();
      check('目标区间生效：钓速 ≥ ' + S0 + ' 时双钓正好是 ' + D0,
        abV2.diffs[AB_IDX.speed].next === S0 && abV2.diffs[AB_IDX.double].next === D0,
        JSON.stringify({ s: abV2.diffs[AB_IDX.speed].next, d: abV2.diffs[AB_IDX.double].next }));
      check('目标达成时不告警', !abV2.warn, abV2.warn.slice(0, 80));
      // 目标设成配不出来的值 → 如实告知「最高只能到多少」，该行标红
      await p1.evaluate(() => {
        const row = document.querySelectorAll('.ab-modal .ab-row')[1];
        const inp = row.querySelectorAll('.ab-num')[0];
        inp.value = '9999';
        inp.dispatchEvent(new Event('change', { bubbles: true }));
      });
      const abV3 = await readAb();
      check('目标过高时如实告警（最高只能到多少）', /最高只能到/.test(abV3.warn), abV3.warn.slice(0, 120));
      check('该行的「可达」列标红提示低于目标', /over/.test(abV3.peekCls), abV3.peekCls);
      await p1.click('.ab-modal .ab-reset');
      const abV4 = await readAb();
      check('重置目标后回到默认方案（钓速优先、无告警）',
        !abV4.warn && abV4.diffs[AB_IDX.speed].next === S0 && abV4.diffs[AB_IDX.double].next === D0,
        JSON.stringify({ s: abV4.diffs[AB_IDX.speed].next, d: abV4.diffs[AB_IDX.double].next }));

      // 一键装配：以服务器 /api/me 为准核对面板给出的「方案后」每一笔加成
      const wantEff = {};
      D_DATA.AFFIX_TYPES.forEach((t, i) => { wantEff[t] = abV4.diffs[i].next; });
      // 包一层 bdSet，记录装配请求序列（失败时用来定位是哪个部位卡住）
      await p1.evaluate(() => {
        window.__bdCalls = [];
        const orig = window.Net.bdSet;
        window.Net.bdSet = function (part, compId) {
          const pr = orig.call(window.Net, part, compId);
          pr.then(
            r => window.__bdCalls.push(part + '=' + (r && r.ok ? 'ok' : JSON.stringify(r && r.data))),
            () => window.__bdCalls.push(part + '=reject'));
          return pr;
        };
      });
      const clientBd = () => p1.evaluate(() => window.Engine.state.bd);
      await p1.click('.ab-modal .ab-apply');
      const meFinal = await untilGet(async () => {
        const r = await get('/api/me?token=' + encodeURIComponent(tokS));
        if (r.status !== 200 || !r.data || !r.data.bd) return null;
        const eff = {};
        D_DATA.AFFIX_TYPES.forEach(t => { eff[t] = 0; });
        D_DATA.ROD_PARTS.forEach(p => {
          const c = D_DATA.componentOf(r.data.bd[p.key] && r.data.bd[p.key].compId);
          if (c) c.affixes.forEach(a => { if (eff[a.type] != null) eff[a.type] += a.value; });
        });
        return { ok: D_DATA.AFFIX_TYPES.every(t => eff[t] === wantEff[t]), eff: eff };
      }, v => v && v.ok, 15000);
      const meRaw = await get('/api/me?token=' + encodeURIComponent(tokS));
      const compIds = (bd) => { const o = {}; if (bd) AB_PART_KEYS.forEach(k => { o[k] = bd[k] && bd[k].compId; }); return o; };
      check('一键装配后服务器真实加成 = 面板给出的方案值',
        !!(meFinal && meFinal.ok),
        JSON.stringify(meFinal && meFinal.eff) + ' vs ' + JSON.stringify(wantEff) +
        ' · 对比 ' + JSON.stringify(abV4.diffs) +
        ' · 请求 ' + JSON.stringify(await p1.evaluate(() => window.__bdCalls || [])) +
        ' · 推荐 ' + JSON.stringify(abV4.plan) +
        ' · 服务器bd ' + JSON.stringify(compIds(meRaw.data && meRaw.data.bd)) +
        ' · 客户端bd ' + JSON.stringify(compIds(await p1.evaluate(() => window.Engine.state.bd))));
      const abV5 = await untilGet(async () => await readAb(), v => v && v.disabled, 8000);
      check('装配完成后按钮变为「无需改动」（方案已落到服务器）',
        abV5.disabled === true && /无需改动/.test(abV5.btn), JSON.stringify({ b: abV5.btn, d: abV5.disabled }));
    }

    // 管理后台各页场景（组件生成 / 渔场钓点 / 公式 / 鱼类体型 / 横幅 / 闪烁 / 反馈）
    // 已拆到独立套件 tests/admin-ui.test.js：只依赖后台页 + 一个玩家页，可与之并行跑，
    // 不再是全量测试的墙钟瓶颈。此处只保留游戏侧场景。

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

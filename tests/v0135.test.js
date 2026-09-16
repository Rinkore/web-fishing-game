/*
 * v0.13.5 刷新纪律回归（纯真实 Chrome + HTTP，可独立运行）：
 *   ① 渔场动态玩家列表：上鱼播报（feed 广播）不再整页重建——面板 / 列表 / 卡片 / 分页 /
 *      搜索框的 DOM 节点身份全部保留，列表滚动位置原地不动
 *   ② 自己上鱼（feed + catch + assets 三连）同样只就地更新
 *   ③ 输入中上鱼：焦点、已输入文字、光标位置都还在（不需要重建后「还回焦点」那套补救）
 *   ④ 动态流只从头部插新行：旧行动都不动（原首行退到第 2 行）、条数只 +1、不重复
 *   ⑤ 地图概览的人数卡片节点身份不变，数字与服务器口径一致
 *   ⑥ 翻到第 2 页后上鱼不会把页码打回第 1 页（就地更新里的页码必须现读）
 *   ⑦ 结构变化（点钓场卡片切到单地图）仍然重建骨架——签名闸只挡数据广播，不挡结构
 * 运行： node tests/v0135.test.js
 */
'use strict';
const { chromium } = require('playwright-core');
const { spawn, spawnSync } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { waitHttp } = require('./_util.js');

const ROOT = path.join(__dirname, '..');
const D = require(path.join(ROOT, 'frontend', 'js', 'data.js'));   // 组件词条口径（纯函数段）
const PORT = 8197;
const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'fishing-v0135-test-'));

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
async function untilGet(fn, ok, timeout) {
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
const GET = (p) => req('GET', p);
const POST = (p, b) => req('POST', p, b);

async function login(page, token) {
  await page.goto('http://localhost:' + PORT + '/', { waitUntil: 'load' });
  await page.evaluate(t => localStorage.setItem('fishing_token', t), token);
  await page.reload({ waitUntil: 'load' });
  await sleep(800);
}
async function clickNav(page, name) {
  // 并行跑多个套件时页面首次渲染更慢：先等导航项出现再点，点完等它变成 active
  await untilGet(() => page.evaluate(n => {
    return Array.from(document.querySelectorAll('.nav-item')).some(x => x.textContent.includes(n));
  }, name), v => v === true, 30000);
  await page.evaluate(n => {
    const b = Array.from(document.querySelectorAll('.nav-item')).find(x => x.textContent.includes(n));
    if (b) b.click();
  }, name);
  await untilGet(() => page.evaluate(n => {
    const a = document.querySelector('.nav-item.active');
    return a ? a.textContent.includes(n) : false;
  }, name), v => v === true, 15000);
  await untilGet(() => page.evaluate(() => !!document.querySelector('.ground-panel')), v => v === true, 20000);
}

// 把关键节点挂到 window 上，跨 evaluate 比较「还是不是同一个 DOM 节点」
const STAMP = () => ({
  panel: ".ground-panel",
  list: '.ground-panel [data-region="peeps"]',
  card: '.ground-panel [data-region="peeps"] .peep',
  feed: '.ground-panel [data-region="gfeed"]',
  feedFirst: '.ground-panel [data-region="gfeed"] .feed-line',
  box: '.ground-panel .gc-box[data-gid="stillwater"]',
  total: '.ground-panel .gc-box[data-gid="__total__"] .gcb-n',
  pager: '.ground-panel [data-region="peep-pager"]',
  input: '.peep-search-input',
});

let srv = null, browser = null;
const sseReqs = [];
// 保持一条 SSE 连接：服务器认为该账号在线（玩家列表靠 presence 推送）
function openSse(token) {
  return new Promise(res => {
    const r = http.request({ hostname: 'localhost', port: PORT, path: '/events?token=' + encodeURIComponent(token), method: 'GET' }, rs => {
      rs.on('data', () => {});
      res(rs);
    });
    r.on('error', () => res(null));
    r.end();
    sseReqs.push(r);
  });
}

(async () => {
  try {
  try { killTree({ pid: 0 }); } catch (e) {}
  try {
    spawnSync('powershell', ['-NoProfile', '-Command',
      "(Get-NetTCPConnection -State Listen -LocalPort " + PORT + " -ErrorAction SilentlyContinue).OwningProcess | ForEach-Object { Stop-Process -Id $_ -Force }"], { stdio: 'ignore' });
  } catch (e) {}
  srv = spawn(process.execPath, ['backend/server.js'], { cwd: ROOT,
    env: Object.assign({}, process.env, { PORT: String(PORT), FISHING_DEV: '1', FISHING_DATA_DIR: TMP_DATA }) });
  await waitHttp('http://localhost:' + PORT + '/shop', { timeout: 20000 });

  const rA = await POST('/api/register', { username: 'v135_a', password: 'abcd1234', name: '回归甲', qq: '30001' });
  const rB = await POST('/api/register', { username: 'v135_b', password: 'abcd1234', name: '回归乙', qq: '30002' });
  const tokA = rA.data.token, tokB = rB.data.token;

  // 路人甲～路人廿四：只有 SSE 连接（在线、未出发），用来把玩家列表撑到超过一页
  const fillerToks = [];
  for (let i = 1; i <= 24; i++) {
    const n = (i < 10 ? '0' : '') + i;
    const r = await POST('/api/register', { username: 'v135_p' + n, password: 'abcd1234', name: '路人' + n, qq: '31' + n + '00' });
    if (r.data && r.data.token) { fillerToks.push(r.data.token); await openSse(r.data.token); }
  }
  await sleep(1200);   // 等 presence 汇总（服务器每秒刷一次）

  // 上鱼工具：别人的鱼走 B 的 token（A 只收到 feed 广播），自己的鱼走 A 的 token。
  // 先垫一条 300cm 的纪录，之后每一条测试鱼都「不是纪录」——一次上鱼正好一条 feed
  // （破了纪录会额外多播一条纪录行，且会弹纪录横幅干扰焦点断言）。
  const fishBy = (tok, size) => POST('/api/dev/catch', {
    token: tok, size: size || 42, item: { kind: 'fish', rarity: 'rare', id: 'koi', name: '黄金锦鲤', size: size || 42 },
    ground: '静水湖', spot: '深水区' });
  await fishBy(tokB, 300);
  await sleep(600);

  browser = await chromium.launch({ executablePath: CHROME });
  const pA = await browser.newPage();
  await login(pA, tokA);

  const stamp = () => pA.evaluate(sel => {
    window.__n = {};
    Object.keys(sel).forEach(k => { window.__n[k] = document.querySelector(sel[k]); });
    return Object.keys(window.__n).filter(k => !!window.__n[k]).length;
  }, STAMP());
  const sameNodes = () => pA.evaluate(sel => {
    const out = {};
    Object.keys(sel).forEach(k => { out[k] = !!window.__n && window.__n[k] === document.querySelector(sel[k]); });
    return out;
  }, STAMP());
  const okAll = (o, keys) => !!o && keys.every(k => o[k] === true);
  // 广播走服务器 1 秒批量窗口（feed 社交窗口），所以「等到它真的到了」比固定 sleep 可靠
  const feedCount = () => pA.evaluate(() => document.querySelectorAll('.ground-panel [data-region="gfeed"] .feed-line').length);
  const peepCount = () => pA.evaluate(() => document.querySelectorAll('.ground-panel [data-region="peeps"] .peep').length);
  const waitFeed = (n) => untilGet(feedCount, c => c >= n, 8000);

  // ---------------------------------------------------------------- ①
  section('① 玩家列表铺满一页（基线）');
  await clickNav(pA, '渔场动态');
  const box = await untilGet(() => pA.evaluate(() => {
    const l = document.querySelector('.ground-panel [data-region="peeps"]');
    if (!l) return null;
    const cs = getComputedStyle(l);
    return { n: l.querySelectorAll('.peep').length, sh: l.scrollHeight, ch: l.clientHeight, ov: cs.overflowY };
  }), v => v && v.n >= 20, 30000);
  check('第一页铺满 20 人（共 ' + fillerToks.length + ' 个路人在线）', !!box && box.n === 20, JSON.stringify(box));
  check('列表限高可滚动（否则本用例没有意义）', !!box && box.sh > box.ch && box.ov === 'auto', JSON.stringify(box));
  if (!box) throw new Error('渔场动态面板没渲染出来（前两项已判失败），后续用例无意义');

  // ---------------------------------------------------------------- ②
  section('② 别人上鱼：只就地更新，绝不重建');
  await pA.evaluate(() => {
    const l = document.querySelector('.ground-panel [data-region="peeps"]');
    l.scrollTop = 150;
  });
  await stamp();
  const before2 = await pA.evaluate(() => ({
    scrollTop: document.querySelector('.ground-panel [data-region="peeps"]').scrollTop,
    feed: document.querySelectorAll('.ground-panel [data-region="gfeed"] .feed-line').length,
  }));
  await fishBy(tokB, 42);
  await waitFeed(before2.feed + 1);
  await sleep(400);
  const after2 = await pA.evaluate(() => {
    const l = document.querySelector('.ground-panel [data-region="peeps"]');
    const feed = document.querySelector('.ground-panel [data-region="gfeed"]');
    return { scrollTop: l.scrollTop, feed: feed.querySelectorAll('.feed-line').length, top: (feed.querySelector('.feed-line') || {}).textContent || '' };
  });
  const same2 = await sameNodes();
  check('面板 / 列表 / 卡片 / 动态流 / 分页 / 搜索框节点身份全保留（没有被重建）',
    okAll(same2, ['panel', 'list', 'card', 'feed', 'pager', 'input']), JSON.stringify(same2));
  check('列表滚动位置原地不动（上鱼不再把列表刷回顶部）',
    after2.scrollTop === before2.scrollTop && after2.scrollTop > 0, JSON.stringify({ before: before2.scrollTop, after: after2.scrollTop }));
  check('动态流收到这条渔获（条数 +1）', after2.feed === before2.feed + 1, JSON.stringify({ before: before2.feed, after: after2.feed }));
  check('新渔获来自回归乙且在最上面', /回归乙/.test(after2.top) && /黄金锦鲤/.test(after2.top), after2.top.slice(0, 120));

  // ---------------------------------------------------------------- ③
  section('③ 自己上鱼：feed + catch + assets 三连同样不重建');
  await stamp();
  const before3 = await pA.evaluate(() => ({
    scrollTop: document.querySelector('.ground-panel [data-region="peeps"]').scrollTop,
    feed: document.querySelectorAll('.ground-panel [data-region="gfeed"] .feed-line').length,
  }));
  await fishBy(tokA, 33);
  await waitFeed(before3.feed + 1);
  await sleep(400);
  const same3 = await sameNodes();
  const after3 = await pA.evaluate(() => {
    const l = document.querySelector('.ground-panel [data-region="peeps"]');
    const feed = document.querySelector('.ground-panel [data-region="gfeed"]');
    return { scrollTop: l.scrollTop, top: (feed.querySelector('.feed-line') || {}).textContent || '' };
  });
  check('自己上鱼也不重建（资产 / 图鉴 / 渔获广播都不该动渔场动态页的骨架）',
    okAll(same3, ['panel', 'list', 'card', 'feed', 'pager', 'input']), JSON.stringify(same3));
  check('滚动位置依旧不动', after3.scrollTop === before3.scrollTop, JSON.stringify({ before: before3.scrollTop, after: after3.scrollTop }));
  check('自己的渔获也在流里', /回归甲/.test(after3.top), after3.top.slice(0, 120));

  // ---------------------------------------------------------------- ④
  section('④ 动态流只从头部插新行');
  const feedBefore = await pA.evaluate(() => {
    const lines = Array.from(document.querySelectorAll('.ground-panel [data-region="gfeed"] .feed-line'));
    return { n: lines.length, texts: lines.map(l => l.textContent), firstIsHead: true };
  });
  await pA.evaluate(() => { window.__feedFirst = document.querySelector('.ground-panel [data-region="gfeed"] .feed-line'); });
  await fishBy(tokB, 55);
  await waitFeed(feedBefore.n + 1);
  await sleep(400);
  const feedAfter = await pA.evaluate(() => {
    const feed = document.querySelector('.ground-panel [data-region="gfeed"]');
    const lines = Array.from(feed.querySelectorAll('.feed-line'));
    return {
      n: lines.length,
      texts: lines.map(l => l.textContent),
      oldFirstMovedTo2: feed.children[1] === window.__feedFirst,
      dup: lines.length !== new Set(lines.map(l => l.textContent)).size,
      textsDup: lines.map(l => l.textContent).filter((t, i, a) => a.indexOf(t) !== i).slice(0, 2),
    };
  });
  check('条数只 +1', feedAfter.n === feedBefore.n + 1, JSON.stringify({ before: feedBefore.n, after: feedAfter.n }));
  check('原来第一条行原地保留（节点身份不变，只是退到第 2 行）', feedAfter.oldFirstMovedTo2 === true);
  check('旧的行内容一字不改', feedAfter.texts.slice(1).join('\u0001') === feedBefore.texts.join('\u0001'));
  check('没有重复行（增量插入没插重）', feedAfter.dup === false, JSON.stringify(feedAfter.textsDup).slice(0, 240));

  // ---------------------------------------------------------------- ⑤
  section('⑤ 地图概览人数就地更新');
  await stamp();
  const api = await GET('/api/players/page?token=' + encodeURIComponent(tokA) + '&page=1&size=20');
  await sleep(1200);   // 等一次 presence 推送（grounds 广播）
  const counts = await pA.evaluate(() => {
    const t = document.querySelector('.ground-panel .gc-box[data-gid="__total__"] .gcb-n');
    return { total: t ? t.textContent : null, head: (document.querySelector('.ground-panel [data-region="peep-head"]') || {}).textContent || '' };
  });
  const same5 = await sameNodes();
  check('人数卡片节点身份不变', okAll(same5, ['box', 'total']), JSON.stringify(same5));
  check('全服在线人数 = 服务器口径（' + (api.data && api.data.totalOnline) + '）',
    !!api.data && counts.total === String(api.data.totalOnline), JSON.stringify({ dom: counts.total, api: api.data && api.data.totalOnline }));
  check('标题里的「在线玩家（N / 全服 M）」也当场更新到同一口径',
    !!api.data && counts.head.indexOf('全服 ' + api.data.totalOnline) >= 0 && counts.head.indexOf('（' + api.data.total + ' /') >= 0, counts.head);

  // ---------------------------------------------------------------- ⑥
  section('⑥ 翻页后上鱼不会把页码打回第 1 页');
  await pA.click('.ground-panel [data-pg="next"]');
  const page2 = await untilGet(() => pA.evaluate(() => {
    const l = document.querySelector('.ground-panel [data-region="peep-pager"] .muted');
    return { txt: l ? l.textContent : '', n: document.querySelectorAll('.ground-panel [data-region="peeps"] .peep').length };
  }), v => v && /第 2 \/ 2 页/.test(v.txt), 8000);
  check('点「下一页」真的到了第 2 页', !!page2 && /第 2 \/ 2 页/.test(page2.txt) && page2.n > 0, JSON.stringify(page2));
  const rows2 = await pA.evaluate(() => Array.from(document.querySelectorAll('.ground-panel [data-region="peeps"] .peep-name')).map(n => n.textContent.trim()));
  await stamp();
  const feedBefore6 = await feedCount();
  await fishBy(tokB, 61);
  await waitFeed(feedBefore6 + 1);
  await sleep(400);
  const after6 = await pA.evaluate(() => ({
    txt: (document.querySelector('.ground-panel [data-region="peep-pager"] .muted') || {}).textContent || '',
    rows: Array.from(document.querySelectorAll('.ground-panel [data-region="peeps"] .peep-name')).map(n => n.textContent.trim()),
  }));
  const same6 = await sameNodes();
  check('上鱼后仍停在第 2 页（就地更新里的页码是现读的，不是闭包快照）', /第 2 \/ 2 页/.test(after6.txt), after6.txt);
  check('第 2 页的行一个字没动（没有被刷回第 1 页的内容）',
    JSON.stringify(after6.rows) === JSON.stringify(rows2), JSON.stringify({ before: rows2, after: after6.rows }).slice(0, 200));
  check('分页按钮节点身份不变', okAll(same6, ['pager', 'list', 'panel']), JSON.stringify(same6));

  // ---------------------------------------------------------------- ⑦
  section('⑦ 输入中上鱼：焦点 / 文字 / 光标都不动');
  await pA.click('.peep-search-input');
  // 搜自己（一定在线）：只留 1 个人，便于验证「筛选结果不被打乱」
  await pA.type('.peep-search-input', '回归甲', { delay: 60 });
  await untilGet(peepCount, n => n === 1, 8000);
  await pA.evaluate(() => {
    const i = document.querySelector('.peep-search-input');
    i.focus();
    i.setSelectionRange(3, 3);
    window.__inp = i;
  });
  const feedBefore7 = await feedCount();
  await fishBy(tokB, 77);
  await waitFeed(feedBefore7 + 1);
  await sleep(300);
  const typed = await pA.evaluate(() => {
    const i = document.querySelector('.peep-search-input');
    return {
      same: i === window.__inp,
      v: i.value,
      caret: i.selectionStart,
      focused: (document.activeElement || {}).className === i.className,
      n: document.querySelectorAll('.ground-panel [data-region="peeps"] .peep').length,
    };
  });
  check('输入框还是同一个节点（没有重建后「还回焦点」那套补救）', typed.same === true, JSON.stringify(typed));
  check('已输入的关键词没被冲掉', typed.v === '回归甲', JSON.stringify(typed));
  check('焦点与光标位置保留', typed.focused === true && typed.caret === 3, JSON.stringify(typed));
  check('筛选结果没被上鱼打乱（仍只剩 1 人）', typed.n === 1, JSON.stringify(typed));
  await pA.fill('.peep-search-input', '');
  await untilGet(() => pA.evaluate(() => document.querySelectorAll('.ground-panel [data-region="peeps"] .peep').length), n => n >= 20, 8000);

  // ---------------------------------------------------------------- ⑧
  section('⑧ 结构变化仍然重建骨架（签名闸只挡数据广播）');
  await pA.evaluate(() => { window.__panelOld = document.querySelector('.ground-panel'); });
  await pA.click('.ground-panel .gc-box[data-gid="stillwater"]');
  const filtered = await untilGet(() => pA.evaluate(() => {
    const h = document.querySelector('.ground-panel h2');
    return { h: h ? h.textContent : '', rebuilt: document.querySelector('.ground-panel') !== window.__panelOld };
  }), v => v && /静水湖/.test(v.h), 8000);
  check('点钓场卡片 → 切到单地图动态（结构真的变了）', !!filtered && /静水湖/.test(filtered.h), JSON.stringify(filtered));
  check('结构变化会重建骨架（没有被签名闸误挡）', !!filtered && filtered.rebuilt === true, JSON.stringify(filtered));
  const backBtn = await pA.evaluate(() => !!document.querySelector('.ground-panel .ground-back'));
  check('单地图页有「返回全服」入口', backBtn === true);

  // ---------------------------------------------------------------- ⑨
  section('⑨ 组件词条口径：满词条 = 池内全满，界面分母 = 池长（与配件状态实时一致）');
  const mk = (base, quality, affixes) => D.instanceMeta(D.instanceId(base, quality, affixes));
  const A = (t, v) => ({ type: t, value: v });
  // 电动卷线器：池长 2（钓速 / 技巧）—— 玩家反馈的正是这一档（史诗下抽满池曾被显示成 2/3 却挂「饱满的」）
  const e2 = mk('reel_electric', 'epic', [A('speed', 25), A('skill', 1)]);
  const e1 = mk('reel_electric', 'epic', [A('speed', 25)]);
  const e3 = mk('reel_electric', 'epic', [A('speed', 25), A('skill', 1), A('rare', 4)]);
  check('池长 2 的底材史诗抽满池 → 分母显示 2（不再是品质上限 3）', e2.maxAffixes === 2 && e2.affixes.length === 2, JSON.stringify({ n: e2.affixes.length, max: e2.maxAffixes }));
  check('抽满池 = 满词条 → 前缀给出「饱满的 / 完美的」', e2.isFull === true && /饱满的|完美的/.test(e2.adjective), e2.name);
  check('没抽满池 → 不是满词条、也不给饱满/完美的', e1.isFull === false && !/饱满的|完美的/.test(e1.adjective), e1.name);
  check('池外补出的第 3 条显示成「3/2」（越过池长 = 突破语义），仍是满词条',
    e3.affixes.length === 3 && e3.maxAffixes === 2 && e3.isFull === true, e3.name);
  // 池长 3 的底材：分母 3，2 条不满、3 条满
  const s2 = mk('acc_sonar', 'epic', [A('skill', 7), A('rare', 4)]);
  const s3 = mk('acc_sonar', 'epic', [A('skill', 7), A('rare', 4), A('speed', -5)]);
  check('池长 3 的底材 2/3 不是满词条', s2.maxAffixes === 3 && s2.isFull === false && !/饱满的|完美的/.test(s2.adjective), s2.name);
  check('池长 3 的底材 3/3 是满词条', s3.isFull === true && /饱满的|完美的/.test(s3.adjective), s3.name);
  // 突破件（竹竿池长 2 → 神话 4 条）：4/2 且满词条 + 突破标记
  const bt = mk('rod_bamboo', 'mythic', [A('speed', 10), A('double', 9), A('rare', 4), A('skill', 3)]);
  check('突破件显示 n/池长（4/2），满词条与突破标记同时成立',
    bt.maxAffixes === 2 && bt.isFull === true && bt.breakthrough === true, bt.name);
  check('词条上限口径可查（池长 / 品质上限 / 自然上限）', (function () {
    const c = D.affixCeilingOf('reel_electric', 'epic');
    return c.poolLen === 2 && c.cap === 3 && c.naturalMax === 2;
  })(), JSON.stringify(D.affixCeilingOf('reel_electric', 'epic')));
  check('随机 300 件：满词条标记与「分子≥分母」永远一致（前缀不再和计数打架）', (function () {
    let bad = 0;
    for (let i = 0; i < 300; i++) {
      const c = D.rollComponent();
      if (c.isFull !== (c.affixes.length >= c.maxAffixes)) bad++;
      if (c.isFull && !/饱满的|完美的/.test(c.adjective) && !c.breakthrough) bad++;
    }
    return bad === 0;
  })());

  console.log('\nv0.13.5 回归测试小结：通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  if (failed.length) console.log('失败项：\n  - ' + failed.join('\n  - '));
} catch (e) {
  fail++;
  console.log('\n  TEST ERROR  ' + (e && e.stack || e));
} finally {
  try { if (browser) await browser.close(); } catch (e) {}
  sseReqs.forEach(r => { try { r.destroy(); } catch (e) {} });
  try { if (srv) killTree(srv); } catch (e) {}
  try { fs.rmSync(TMP_DATA, { recursive: true, force: true }); } catch (e) {}
  process.exit(fail === 0 ? 0 : 1);
}
})();

/*
 * 管理后台页面场景测试（真实浏览器，独立套件）
 * 覆盖：组件生成 roll 模型 / 渔场钓点管理（新建·限时窗口·删除恢复·钓点独立上鱼率）/
 *       公式管理 / 鱼类体型 / 横幅滚播与图标闪烁 / 反馈奖励
 * 运行： node tests/admin-ui.test.js
 *
 * 从 ui-layout 拆出：后台场景只需要「一个玩家页 + 一个后台页」，与游戏侧场景没有状态耦合，
 * 独立成套件后可与 ui-layout 并行跑，全量墙钟不再被 ui-layout 一个套件卡住。
 * 自带端口与临时数据目录，与其它套件互不干扰。
 */
'use strict';
const { chromium } = require('playwright-core');
const { waitFor, waitHttp } = require('./_util.js');
const os = require('os');
const { spawn, spawnSync } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const PORT = 8172;
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
function section(t) { console.log(''); console.log('=== ' + t + ' ===  [' + ((Date.now() - T0) / 1000).toFixed(1) + 's]'); }
const sleep = ms => new Promise(r => setTimeout(r, ms));
// 轮询取数：ok(v) 成立即刻返回，超时返回最后一次取值供断言报出真实原因
async function untilGet(fn, ok, timeout) {
  const deadline = Date.now() + (timeout || 10000);
  for (;;) {
    const v = await fn().catch(() => null);
    if (ok(v)) return v;
    if (Date.now() >= deadline) return v;
    await sleep(25);
  }
}
function untilSel(page, sel, timeout) {
  return waitFor(async () => (await page.$$(sel)).length > 0, { timeout: timeout || 8000, interval: 25 });
}
// 启动前清理端口占用（Windows 下强杀测试进程可能留下孤儿服务器占住端口）
function killPortOccupant(port) {
  try {
    spawnSync('powershell', ['-NoProfile', '-Command',
      "(Get-NetTCPConnection -State Listen -LocalPort " + port + " -ErrorAction SilentlyContinue).OwningProcess | ForEach-Object { Stop-Process -Id $_ -Force }"],
      { stdio: 'ignore' });
  } catch (e) {}
}
function req(method, p, body) {
  return new Promise(res => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({ hostname: 'localhost', port: PORT, path: p, method: method, headers: { 'Content-Type': 'application/json', 'Content-Length': data ? Buffer.byteLength(data) : 0 } }, rs => {
      let d = ''; rs.on('data', c => d += c);
      rs.on('end', () => { let j = null; try { j = JSON.parse(d); } catch (e) {} res({ status: rs.statusCode, data: j }); });
    });
    r.on('error', () => res({ status: 0 }));
    if (data) r.write(data);
    r.end();
  });
}
const post = (p, b) => req('POST', p, b);
const get = p => req('GET', p);

async function login(page, token) {
  await page.goto('http://localhost:' + PORT + '/', { waitUntil: 'load' });
  await page.evaluate(t => localStorage.setItem('fishing_token', t), token);
  await page.reload({ waitUntil: 'load' });
  await untilSel(page, '.nav-item', 10000);   // 等主界面渲染，替代固定 sleep
}
const clickNav = async (page, name) => {
  // v0.11.3 起侧栏取消「更多」折叠组：全部入口平铺常驻，直接找即可
  await page.evaluate(n => {
    const b = Array.from(document.querySelectorAll('.nav-item')).find(x => x.textContent.includes(n));
    if (b) b.click();
  }, name);
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

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'fishing-admin-ui-'));

(async () => {
  killPortOccupant(PORT);
  const srv = spawn(process.execPath, ['backend/server.js'], { cwd: ROOT, env: Object.assign({}, process.env, { PORT: String(PORT), FISHING_DEV: '1', FISHING_DATA_DIR: TMP_DATA }) });
  await waitHttp('http://localhost:' + PORT + '/shop', { timeout: 20000 });
  let browser;
  try {
    // 账号：首个登录后台的账号自动成为管理员；另建两个玩家（收公告 / 提交反馈）
    await post('/api/register', { username: 'aui_admin', password: 'abcd1234', name: '后台管理员', qq: '10021' });
    const rp = await post('/api/register', { username: 'aui_player', password: 'abcd1234', name: '后台玩家', qq: '10022' });
    const rb = await post('/api/register', { username: 'aui_buyer', password: 'abcd1234', name: '后台买家', qq: '10023' });
    const tokB = rb.data.token;
    const tokP = rp.data.token;

    browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const errs = [];
    // 带上出错位置（堆栈第二行）：只记 message 时定位不到具体行
    const pErr = e => e.message + ' @ ' + (String(e.stack || '').split('\n')[1] || '').trim();
    const p1 = await ctx.newPage(); p1.on('pageerror', e => errs.push(pErr(e)));
    const p2 = await ctx.newPage(); p2.on('pageerror', e => errs.push(pErr(e)));
    await login(p1, rp.data.token);
    await login(p2, tokB);

    // —— 管理后台「组件生成」：roll 模型保存（回归：单选框缺 value 被服务器判为未知模型） ——
    section('管理后台组件生成 · roll 模型');
    const pa = await ctx.newPage();
    const adminErrs = []; pa.on('pageerror', e => adminErrs.push(pErr(e)));
    const adminLogin = await post('/api/admin/login', { username: 'aui_admin', password: 'abcd1234' });
    if (adminLogin.data && adminLogin.data.token) {
      await pa.goto('http://localhost:' + PORT + '/admin.html', { waitUntil: 'load' });
      await pa.evaluate(t => localStorage.setItem('fishing_admin_token', t), adminLogin.data.token);
      await pa.reload({ waitUntil: 'load' });
      // 等主界面渲染 + 等目标页关键控件就绪（替代固定 sleep：并行负载下 sleep 会不够，
      // 直接 document.getElementById('cmp-save').click() 会抛 null click 把整个套件打断）
      await untilSel(pa, '.nav-item', 10000);
      await pa.evaluate(() => { const b = Array.from(document.querySelectorAll('.nav-item')).find(x => x.textContent.includes('组件生成')); if (b) b.click(); });
      await untilSel(pa, '#cmp-save', 10000);
      const radios = await pa.$$eval('input[name=rm]', els => els.map(e => e.value));
      check('roll 模型单选框都有非空 value', radios.length === 3 && radios.every(v => v && v !== 'on'), JSON.stringify(radios));
      await pa.evaluate(() => { const c = document.querySelector('.radio-card[data-rm=normal]'); if (c) c.click(); });
      await sleep(150);
      await pa.evaluate(() => { const b = document.getElementById('cmp-save'); if (b) b.click(); });
      // 保存结果文案由 POST 返回后写入：轮询到出现「已保存」再断言（固定 sleep 在并行负载下会不够）
      await waitFor(async () => /已保存/.test(await pa.textContent('#cmp-state')), { timeout: 8000, interval: 40 }).catch(() => {});
      const state = await pa.textContent('#cmp-state');
      check('保存 roll 模型成功（非「未知的 roll 模型」）', /已保存/.test(state) && !/未知/.test(state), state);
      const saved = await get('/api/admin/world?token=' + adminLogin.data.token);
      check('服务器已应用所选 roll 模型（normal）', saved.data.componentCfg && saved.data.componentCfg.rollModel === 'normal', JSON.stringify(saved.data.componentCfg && saved.data.componentCfg.rollModel));
      check('管理后台无页面错误', adminErrs.length === 0, adminErrs.join(' | '));

      // —— 概览·服务器热力图：区间 / 曲线开关 / 热力格 / 5 秒轮询不重建面板 ——
      section('管理后台概览 · 服务器热力图');
      // 直接点导航（本段在 clickAdminNav 声明之前，用它会被 TDZ 拦下）
      await pa.evaluate(() => { const b = Array.from(document.querySelectorAll('.nav-item')).find(x => x.textContent.includes('概览')); if (b) b.click(); });
      await untilSel(pa, '#ov-chart', 10000);
      await waitFor(async () => Number((await pa.evaluate(() => (document.getElementById('ov-chart') || {}).dataset
        ? document.getElementById('ov-chart').dataset.draw : 0))) >= 1, { timeout: 10000, interval: 100 }).catch(() => {});
      const heatPanel = await pa.evaluate(() => {
        const cv = document.getElementById('ov-chart');
        return {
          bar: !!document.querySelector('.hm-bar'),
          ranges: document.querySelectorAll('#ov-range .hm-rng').length,
          modes: document.querySelectorAll('#ov-mode .hm-md').length,
          legend: document.querySelectorAll('#ov-legend .hm-item').length,
          on: Array.from(document.querySelectorAll('#ov-legend .hm-item')).filter(l => l.querySelector('input').checked).map(l => l.getAttribute('data-series')),
          canvas: !!cv,
          draws: cv ? Number(cv.dataset.draw || 0) : 0,
          w: cv ? cv.width : 0,
          hint: (document.getElementById('ov-chart-hint') || {}).textContent || '',
        };
      });
      check('概览有热力图面板（5 个区间 / 2 种视图 / 画布）',
        heatPanel.bar && heatPanel.ranges === 5 && heatPanel.modes === 2 && heatPanel.canvas && heatPanel.w > 0, JSON.stringify(heatPanel));
      check('曲线开关列出 6 条（默认开 5 条，「注册账号」默认关）',
        heatPanel.legend === 6 && heatPanel.on.length === 5 && heatPanel.on.indexOf('users') < 0, JSON.stringify(heatPanel.on));
      check('曲线已绘制（画布有绘制计数，非空白）', heatPanel.draws >= 1, String(heatPanel.draws));
      check('曲线提示含采样与峰值说明', /采样/.test(heatPanel.hint) && /历史峰值/.test(heatPanel.hint), heatPanel.hint.slice(0, 120));
      // 关掉「在线玩家」：只重绘画布，开关状态就地保留，且该曲线真的从画布上消失
      const hmToggle = await pa.evaluate(() => {
        const lab = document.querySelector('#ov-legend .hm-item[data-series="online"]');
        const cv = document.getElementById('ov-chart');
        const ctx = cv.getContext('2d');
        // 数一数「在线玩家」那条曲线的颜色像素（#4da3ff）
        const countSeries = () => {
          const d = ctx.getImageData(0, 0, cv.width, cv.height).data;
          let n = 0;
          for (let i = 0; i < d.length; i += 4) {
            if (Math.abs(d[i] - 77) < 20 && Math.abs(d[i + 1] - 163) < 20 && Math.abs(d[i + 2] - 255) < 20) n++;
          }
          return n;
        };
        const before = Number(cv.dataset.draw || 0);
        const pxOn = countSeries();
        const cb = lab.querySelector('input');
        cb.checked = false;
        cb.dispatchEvent(new Event('change', { bubbles: true }));
        return { off: lab.classList.contains('off'), before: before, draws: Number(cv.dataset.draw || 0), pxOn: pxOn, pxOff: countSeries() };
      });
      check('关掉一条曲线后开关变灰并就地重绘', hmToggle.off === true && hmToggle.draws > hmToggle.before, JSON.stringify(hmToggle));
      check('关掉的曲线真从画布上消失（该色像素归零）', hmToggle.pxOn > 0 && hmToggle.pxOff === 0, JSON.stringify(hmToggle));
      // 切到热力格视图
      const hmGrid = await pa.evaluate(() => {
        const cv = document.getElementById('ov-chart');
        const before = Number(cv.dataset.draw || 0);
        document.querySelector('#ov-mode .hm-md[data-mode="heat"]').click();
        return {
          on: document.querySelector('#ov-mode .hm-md[data-mode="heat"]').classList.contains('on'),
          before: before, draws: Number(cv.dataset.draw || 0),
          hint: (document.getElementById('ov-chart-hint') || {}).textContent || '',
        };
      });
      check('切到「星期 × 小时热力格」并重绘', hmGrid.on === true && hmGrid.draws > hmGrid.before, JSON.stringify(hmGrid));
      check('热力格提示说明色深与覆盖天数', /色深/.test(hmGrid.hint) && /28 天/.test(hmGrid.hint), hmGrid.hint.slice(0, 110));
      await pa.evaluate(() => { document.querySelector('#ov-mode .hm-md[data-mode="line"]').click(); });
      // 切区间：7 天用小时样本，提示随之更新
      await pa.evaluate(() => { document.querySelector('#ov-range .hm-rng[data-range="7d"]').click(); });
      await waitFor(async () => /7 天区间/.test((await pa.textContent('#ov-chart-hint')) || ''), { timeout: 8000, interval: 60 }).catch(() => {});
      const hmRange = await pa.evaluate(() => ({
        on: document.querySelector('#ov-range .hm-rng[data-range="7d"]').classList.contains('on'),
        hint: (document.getElementById('ov-chart-hint') || {}).textContent || '',
      }));
      check('切到 7 天区间后提示更新（按小时桶）', hmRange.on === true && /7 天区间/.test(hmRange.hint) && /1 小时/.test(hmRange.hint), hmRange.hint.slice(0, 130));
      // 5 秒轮询：面板不重建（同一画布节点），曲线开关不被重置
      await pa.evaluate(() => { window.__ovCv = document.getElementById('ov-chart'); });
      await sleep(6200);
      const hmTick = await pa.evaluate(() => {
        const lab = document.querySelector('#ov-legend .hm-item[data-series="online"]');
        return {
          same: document.getElementById('ov-chart') === window.__ovCv,
          panel: !!document.querySelector('.hm-bar'),
          off: lab.classList.contains('off'),
          cb: lab.querySelector('input').checked,
          rangeOn: document.querySelector('#ov-range .hm-rng[data-range="7d"]').classList.contains('on'),
        };
      });
      check('概览 5 秒轮询不重建热力图（同一画布节点）', hmTick.same === true && hmTick.panel === true, JSON.stringify(hmTick));
      check('轮询不重置曲线开关（关掉的那条仍关着）', hmTick.off === true && hmTick.cb === false, JSON.stringify(hmTick));
      check('轮询不重置区间选择（仍是 7 天）', hmTick.rangeOn === true, JSON.stringify(hmTick));
      check('概览热力图无页面错误', adminErrs.length === 0, adminErrs.join(' | '));

      // —— 市集管理 · 后台批量上架（活跃市场）——
      section('管理后台市集 · 批量上架');
      await pa.evaluate(() => { const b = Array.from(document.querySelectorAll('.nav-item')).find(x => x.textContent.includes('市集管理')); if (b) b.click(); });
      await untilSel(pa, '#bl-go', 10000);
      await waitFor(async () => (await pa.$$('#bl-seller option')).length > 0, { timeout: 8000, interval: 80 }).catch(() => {});
      const bp = await pa.evaluate(() => ({
        sellers: Array.from(document.querySelectorAll('#bl-seller option')).map(o => o.value),
        selSeller: (document.getElementById('bl-seller') || {}).value || '',
        cards: document.querySelectorAll('.bl-card').length,
        kinds: ['fish', 'material', 'chest', 'component'].every(k => !!document.getElementById('bl-c-' + k)),
        fishOpts: document.querySelectorAll('#bl-p-fish input[type=checkbox]').length,
        compOpts: document.querySelectorAll('#bl-p-component input[type=checkbox]').length,
        parts: document.querySelectorAll('#bl-part option').length,
        qs: ['common', 'rare', 'epic', 'mythic'].every(k => !!document.getElementById('bl-q-' + k)),
        compCount: Number((document.getElementById('bl-c-component') || {}).value),
      }));
      check('市集管理页有批量上架面板（卖家下拉 + 四类卡片 + 部位/品质/词条参数）',
        bp.sellers.length >= 2 && bp.cards === 4 && bp.kinds && bp.parts >= 6 && bp.qs, JSON.stringify(bp));
      check('卖家名头下拉默认选中当前管理员', bp.selSeller === 'aui_admin', JSON.stringify({ sel: bp.selSeller, s: bp.sellers }));
      check('限定物品下拉按类型列举（鱼 40+ / 组件底材 20+）', bp.fishOpts >= 40 && bp.compOpts >= 20, JSON.stringify({ fish: bp.fishOpts, comp: bp.compOpts }));
      // v0.11.10：限定物品改成可勾可取消的列表（原生 multiple 单击=选择、取消要按 Ctrl，选错了清不掉）
      const pickFlow = await pa.evaluate(() => {
        const box = document.getElementById('bl-p-fish');
        const cbs = Array.from(box.querySelectorAll('input[type=checkbox]'));
        const badge = () => (document.getElementById('bl-pn-fish') || {}).textContent.trim();
        cbs[0].click(); cbs[1].click();
        const afterPick = badge();
        cbs[0].click();   // 再点一次 = 取消勾选
        const afterUnpick = badge();
        document.querySelector('.bl-clr[data-clr="fish"]').click();
        let saved = null;
        try { saved = JSON.parse(localStorage.getItem('fishing_admin_bulk') || '{}').picks; } catch (e) {}
        return { afterPick, afterUnpick, afterClear: badge(), checked: cbs.filter(c => c.checked).length, savedFish: saved && saved.fish };
      });
      check('限定物品可点选也可取消（点一下勾上、再点一下取消）',
        /已选 2 项/.test(pickFlow.afterPick) && /已选 1 项/.test(pickFlow.afterUnpick), JSON.stringify(pickFlow));
      check('「清空选择」一次取消该类全部勾选并写回 localStorage',
        pickFlow.checked === 0 && pickFlow.afterClear === '' && Array.isArray(pickFlow.savedFish) && pickFlow.savedFish.length === 0, JSON.stringify(pickFlow));
      check('组件条数默认预填 200（可直接改）', bp.compCount === 200, String(bp.compCount));

      const mkN0 = (await get('/api/market')).data.listings.length;
      await pa.evaluate(() => { document.getElementById('bl-c-component').value = '6'; });
      await pa.evaluate(() => document.getElementById('bl-preview').click());
      await waitFor(async () => /预览（未写入）/.test((await pa.textContent('#bl-state')) || ''), { timeout: 8000, interval: 80 }).catch(() => {});
      const prevState = await pa.textContent('#bl-state');
      check('预览给出条数/类别/样例', /共 6 条/.test(prevState || '') && /组件 6 条/.test(prevState || ''), String(prevState).slice(0, 160));
      check('预览不写入（市集挂单数未变）', (await get('/api/market')).data.listings.length === mkN0, String(mkN0));

      await pa.evaluate(() => document.getElementById('bl-go').click());
      await waitFor(async () => (await pa.$$('.modal-overlay .cf-text')).length === 1, { timeout: 8000, interval: 80 }).catch(() => {});
      const cfText = await pa.textContent('.cf-text');
      check('上架前弹确认（写明卖家名头与条数）', /批量上架 6 条/.test(cfText || '') && /后台管理员|aui_admin/.test(cfText || ''), String(cfText).slice(0, 140));
      check('确认文案不含转义标签（confirmModal 会 esc）', !/&lt;|<br/.test(cfText || ''), String(cfText).slice(0, 80));
      await pa.evaluate(() => { const b = document.querySelector('.modal-overlay .cf-yes'); if (b) b.click(); });
      await waitFor(async () => (await get('/api/market')).data.listings.length >= mkN0 + 6, { timeout: 12000, interval: 150 }).catch(() => {});
      const mkAfterBulk = (await get('/api/market')).data.listings;
      check('批量上架落到服务器（+6 条）', mkAfterBulk.length >= mkN0 + 6, mkN0 + ' -> ' + mkAfterBulk.length);
      check('挂单挂在所选账号名头下', mkAfterBulk.filter(l => l.seller === 'aui_admin').length >= 6,
        JSON.stringify(mkAfterBulk.filter(l => l.seller === 'aui_admin').slice(0, 2)));
      // 就地刷新是异步的（列表随广播/回包重画）：并行跑测试时单次读数会偶发抢在重画之前，
      // 这里先轮询到行数到位再断言（原先单次读取曾误报过一条）。
      await waitFor(async () => (await pa.$$('#mk-body tbody tr')).length >= 6, { timeout: 8000, interval: 100 }).catch(() => {});
      check('上架后列表就地刷新出这些挂单', (await pa.$$('#mk-body tbody tr')).length >= 6, String((await pa.$$('#mk-body tbody tr')).length));
      check('面板参数写进 localStorage（下次进来不用重填）', await pa.evaluate(() => {
        try { return JSON.parse(localStorage.getItem('fishing_admin_bulk') || '{}').counts.component === 6; } catch (e) { return false; }
      }));
      check('市集批量上架无页面错误', adminErrs.length === 0, adminErrs.join(' | '));

      // —— 渔场管理：新建（一键填充）/ 限时窗口 / 删除恢复 / 已有钓点一键填充 ——
      section('管理后台渔场管理 · 横幅滚播 · 反馈奖励');
      const gidNew = 'qa_cove_' + Math.random().toString(36).slice(2, 6);
      // 切后台页：等导航项变为选中（同页重复点击时立即满足），再等关键控件就绪。
      // 不要用「标题变化」判断——重复点同一页时标题不变，会白等满超时。
      const clickAdminNav = async (name, sel) => {
        await pa.evaluate(n => { const b = Array.from(document.querySelectorAll('.nav-item')).find(x => x.textContent.includes(n)); if (b) b.click(); }, name);
        await waitFor(async () => (await pa.$$eval('.nav-item.active', els => els.map(e => e.textContent))).some(t => t.includes(name)),
          { timeout: 8000, interval: 25 }).catch(() => {});
        if (sel) await untilSel(pa, sel);
      };
      await clickAdminNav('渔场钓点', '#ng-id');
      await pa.evaluate((gid) => {
        document.getElementById('ng-id').value = gid;
        document.getElementById('ng-name').value = 'QA 测试湾';
        document.getElementById('ng-spot').value = '主钓点';
        document.getElementById('ng-preset').value = 'rare';
        document.getElementById('ng-create').click();
      }, gidNew);
      const newG = await untilGet(async () => {
        const r = await get('/api/grounds');
        return (r.data.grounds || []).find(g => g.id === gidNew) || null;
      }, g => !!(g && g.spots && g.spots.length === 1));
      check('新建渔场实时进入全服目录（含 1 个钓点）', !!newG && newG.spots.length === 1, JSON.stringify((newG ? [newG.id] : [])));
      check('新钓点按「稀有秘境」预设一键填充（13 条）', !!newG && newG.spots[0].pool.length === 13, newG ? String(newG.spots[0].pool.length) : 'none');
      check('新渔场默认开放可钓', !!newG && newG.locked === false);
      // 限时窗口：设成已过期 → 自动锁定。
      // 先等资料表单真正渲染成「刚建好的这个渔场」再操作（表单值是当前选中渔场的名称）——
      // 新建渔场后页面会有一次异步重绘，过早点击会把改动写到上一个渔场上（曾导致本段随机失败）。
      await untilSel(pa, '#gi-from', 6000);
      await untilGet(async () => (await pa.inputValue('#gi-name')), v => v === 'QA 测试湾', 6000);
      await pa.evaluate(() => {
        const f = d => d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2) + 'T' + ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
        document.getElementById('gi-from').value = f(new Date(Date.now() - 3600 * 1000));
        document.getElementById('gi-to').value = f(new Date(Date.now() - 1800 * 1000));
        document.getElementById('gi-window').click();
      });
      const lockedG = await untilGet(async () => {
        const r = await get('/api/grounds');
        return (r.data.grounds || []).find(g => g.id === gidNew) || null;
      }, g => !!(g && g.locked === true));
      check('限时窗口已过期 → 渔场自动锁定', !!lockedG && lockedG.locked === true, JSON.stringify(lockedG && { locked: lockedG.locked, openTo: lockedG.openTo }));
      check('限时开窗时间随目录下发（前端可展示）', !!lockedG && !!lockedG.openFrom && !!lockedG.openTo);
      await pa.evaluate(() => { document.getElementById('gi-clearwin').click(); });
      const reopened = await untilGet(async () => {
        const r = await get('/api/grounds');
        return (r.data.grounds || []).find(g => g.id === gidNew) || null;
      }, g => !!(g && g.locked === false));
      check('清除限时后恢复常驻开放', !!reopened && reopened.locked === false, JSON.stringify(reopened && { locked: reopened.locked }));
      // 已有钓点一键填充：经济浅水预设 → 保存生效
      await pa.evaluate(() => { document.getElementById('pool-preset').value = 'economy'; document.getElementById('pool-fill').click(); });
      const fillRows = await untilGet(() => pa.$$eval('#pool-rows .pool-row', els => els.length), n => n === 13, 5000);
      check('一键填充替换草稿（经济浅水 13 条）', fillRows === 13, String(fillRows));
      await pa.evaluate(() => { document.getElementById('pool-save').click(); });
      const filledG = await untilGet(async () => {
        const r = await get('/api/grounds');
        const g = (r.data.grounds || []).find(g => g.id === gidNew);
        return (g && g.spots[0] && g.spots[0].pool.length === 13) ? g : null;
      }, g => !!g);
      check('保存后掉落池按预设生效', !!filledG && filledG.spots[0].pool.length === 13, filledG ? String(filledG.spots[0].pool.length) : 'none');
      // 删除自定义渔场 → 目录移除（不可恢复）
      await pa.evaluate((gid) => { const c = document.querySelector('.gcard[data-g="' + gid + '"]'); if (c) c.querySelector('[data-rmg]').click(); }, gidNew);
      await untilSel(pa, '.cf-yes', 5000);
      await pa.evaluate(() => { const y = document.querySelector('.cf-yes'); if (y) y.click(); });
      const removed = await untilGet(async () => {
        const r = await get('/api/grounds');
        return !(r.data.grounds || []).some(g => g.id === gidNew);
      }, v => v === true, 8000);
      check('自定义渔场删除后从目录移除', removed === true);
      const rstChips = await pa.$$eval('[data-rstg]', els => els.map(e => e.getAttribute('data-rstg')));
      check('自定义渔场删除后不在恢复名单', rstChips.indexOf(gidNew) < 0, rstChips.join(','));
      // —— 钓点独立上鱼率 / 速率（留空 = 全服默认）——
      // 先切回「静水湖」渔场，再选老旧码头钓点（前面的用例切换过选中渔场）
      await pa.evaluate(() => { const c = document.querySelector('.gcard[data-g="stillwater"]'); if (c) c.click(); });
      await waitFor(async () => (await pa.$$('.spot-tab[data-s="dock"]')).length === 1, { timeout: 6000 }).catch(() => {});
      await pa.evaluate(() => {
        const t = document.querySelector('.spot-tab[data-s="dock"]');
        if (t) t.click();
      });
      await waitFor(async () => (await pa.$$('#sr-bite')).length === 1, { timeout: 6000 }).catch(() => {});
      await waitFor(async () => (await pa.$$('#sr-bite')).length === 1, { timeout: 5000 }).catch(() => {});
      const srPanel = await pa.evaluate(() => ({
        hasPanel: !!document.getElementById('sr-bite') && !!document.getElementById('sr-ms') && !!document.getElementById('sr-save'),
        hint: (document.querySelector('#ed-body') || {}).textContent || '',
      }));
      check('钓点管理处有独立的「上鱼率 / 速率」控件', srPanel.hasPanel === true, JSON.stringify({ hasPanel: srPanel.hasPanel }));
      check('控件说明写明留空=全服默认', /留空 = 使用全服默认/.test(srPanel.hint), srPanel.hint.slice(0, 120));
      // 设置该钓点 上鱼率 100% / 间隔 1500ms → 保存后服务器生效
      await pa.evaluate(() => {
        document.getElementById('sr-bite').value = '100';
        document.getElementById('sr-ms').value = '1500';
        document.getElementById('sr-save').click();
      });
      const srSaved = await waitFor(async () => {
        const g = await get('/api/grounds');
        const st = (g.data.grounds || []).find(x => x.id === 'stillwater');
        const sp = st && st.spots.find(s => s.id === 'dock');
        return !!(sp && sp.biteRate === 100 && sp.intervalMs === 1500);
      }, { timeout: 6000, interval: 200 }).catch(() => false);
      check('钓点独立上鱼率/间隔保存并下发到全服目录', srSaved === true, String(srSaved));
      // 恢复默认，避免影响其他用例
      await pa.evaluate(() => { document.getElementById('sr-clear').click(); });
      await untilSel(pa, '.cf-yes', 5000);
      await pa.evaluate(() => { const y = document.querySelector('.cf-yes'); if (y) y.click(); });
      const srCleared = await waitFor(async () => {
        const g = await get('/api/grounds');
        const st = (g.data.grounds || []).find(x => x.id === 'stillwater');
        const sp = st && st.spots.find(s => s.id === 'dock');
        return !!(sp && sp.biteRate == null && sp.intervalMs == null);
      }, { timeout: 6000, interval: 200 }).catch(() => false);
      check('点「恢复默认」清除钓点独立配置', srCleared === true, String(srCleared));

      // 内置钓点删除 → 可恢复
      section('管理后台 · 内置钓点删除与恢复');
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
      await untilSel(pa, '#ns-del', 6000);
      await pa.evaluate(() => { const b = document.getElementById('ns-del'); if (b) b.click(); });
      await untilSel(pa, '.cf-yes', 5000);
      await pa.evaluate(() => { const y = document.querySelector('.cf-yes'); if (y) y.click(); });
      const still = await untilGet(async () => {
        const r = await get('/api/grounds');
        return (r.data.grounds || []).find(g => g.id === 'stillwater') || null;
      }, g => !!(g && !g.spots.some(s => s.id === builtSpot.sid)));
      check('内置钓点删除后从目录移除', !!still && !still.spots.some(s => s.id === builtSpot.sid), still ? String(still.spots.length) : 'none');
      // 等 API 生效 + 页面重绘出「可恢复」按钮再断言
      const chips2 = await untilGet(() => pa.$$eval('[data-rsts]', els => els.map(e => e.getAttribute('data-rsts'))),
        arr => !!(arr && arr.indexOf('stillwater:' + builtSpot.sid) >= 0), 6000);
      check('内置钓点进入可恢复名单', chips2.indexOf('stillwater:' + builtSpot.sid) >= 0, chips2.join(','));
      await pa.evaluate((key) => { const b = document.querySelector('[data-rsts="' + key + '"]'); if (b) b.click(); }, 'stillwater:' + builtSpot.sid);
      const still2 = await untilGet(async () => {
        const r = await get('/api/grounds');
        return (r.data.grounds || []).find(g => g.id === 'stillwater') || null;
      }, g => !!(g && g.spots.some(s => s.id === builtSpot.sid)));
      check('一键恢复内置钓点', !!still2 && still2.spots.some(s => s.id === builtSpot.sid));

      // —— 公式管理：抛竿间隔与全服钓速表单 ——
      section('管理后台 · 公式管理');
      await clickAdminNav('公式管理', '#cast-bonus');
      await pa.evaluate(() => {
        document.getElementById('cast-bonus').value = '50';
        document.getElementById('cast-cap').value = '80';
        document.getElementById('cast-save').click();
      });
      const castSaved = await untilGet(() => get('/api/admin/world?token=' + adminLogin.data.token),
        r => !!(r && r.data && r.data.castSpeedBonus === 50 && r.data.castSpeedCap === 80));
      check('后台保存全服钓速加成与上限生效（50 / 80）', castSaved.data.castSpeedBonus === 50 && castSaved.data.castSpeedCap === 80,
        JSON.stringify({ b: castSaved.data.castSpeedBonus, c: castSaved.data.castSpeedCap }));
      const castPreviewTxt = await pa.evaluate(() => { const n = document.getElementById('cast-preview'); return n ? n.textContent : ''; });
      check('间隔预览随参数实时更新（含有效钓速换算）', /有效 80%/.test(castPreviewTxt), castPreviewTxt.slice(0, 160));
      await pa.evaluate(() => { document.getElementById('cast-reset').click(); });
      const castReset = await untilGet(() => get('/api/admin/world?token=' + adminLogin.data.token),
        r => !!(r && r.data && r.data.castSpeedBonus === 0 && r.data.castSpeedCap === 80));
      check('恢复默认钓速设置（0 / 80）', castReset.data.castSpeedBonus === 0 && castReset.data.castSpeedCap === 80,
        JSON.stringify({ b: castReset.data.castSpeedBonus, c: castReset.data.castSpeedCap }));
      const castErrs = adminErrs.length;

      // —— 鱼类体型：模型切换 → 预览直方图 → 保存 → 恢复默认 ——
      section('管理后台 · 鱼类体型');
      await clickAdminNav('鱼类体型', '#fish-save');
      const fishPage = await pa.evaluate(() => {
        const cards = Array.from(document.querySelectorAll('.radio-card[data-fm]')).map(c => c.getAttribute('data-fm'));
        const sel = document.querySelector('.radio-card[data-fm].sel');
        const opts = Array.from(document.querySelectorAll('#fish-pick option')).length;
        return { cards: cards, sel: sel ? sel.getAttribute('data-fm') : null, opts: opts, hasSave: !!document.getElementById('fish-save') };
      });
      check('鱼类体型页三模型可选（linear/normal/skew）', fishPage.cards.join(',') === 'linear,normal,skew' && fishPage.hasSave, JSON.stringify(fishPage));
      check('鱼类体型页默认选中正态', fishPage.sel === 'normal', String(fishPage.sel));
      check('目标鱼下拉含全部鱼种（40 + 全部鱼种项）', fishPage.opts === 41, String(fishPage.opts));
      await pa.evaluate(() => { const c = document.querySelector('.radio-card[data-fm="skew"]'); if (c) c.click(); });
      const barsOk = await waitFor(async () => (await pa.evaluate(() => document.querySelectorAll('#fish-chart div[title]').length)) === 20, { timeout: 10000 }).catch(() => false);
      check('切换模型后渲染 20 桶分布直方图', barsOk === true, String(barsOk));
      // 选具体鱼种 → 预览切换为该鱼的 cm 分位统计
      await pa.evaluate(() => {
        const s = document.getElementById('fish-pick');
        s.value = 'crucian';
        s.dispatchEvent(new Event('change'));
      });
      const statsOk = await waitFor(async () => /中位数/.test(await pa.evaluate(() => document.getElementById('fish-chart').textContent)),
        { timeout: 10000 }).catch(() => false);
      check('选定鱼种后预览显示 cm 分位统计', statsOk === true);
      const fishPreviewTxt = await pa.evaluate(() => document.getElementById('fish-chart').textContent);
      check('预览含鱼名与基准区间（鲫鱼 10~35 cm）', /鲫鱼/.test(fishPreviewTxt) && /10~35 cm/.test(fishPreviewTxt), fishPreviewTxt.slice(0, 140));
      await pa.evaluate(() => { document.getElementById('fish-save').click(); });
      await waitFor(async () => (await get('/api/admin/world?token=' + adminLogin.data.token)).data.fishCfg.sizeModel === 'skew',
        { timeout: 5000 }).catch(() => false);
      const fsSaved = await get('/api/admin/world?token=' + adminLogin.data.token);
      check('后台保存体型模型生效（skew）', fsSaved.data.fishCfg.sizeModel === 'skew', JSON.stringify(fsSaved.data.fishCfg));
      await pa.evaluate(() => { document.getElementById('fish-reset').click(); });
      await waitFor(async () => (await get('/api/admin/world?token=' + adminLogin.data.token)).data.fishCfg.sizeModel === 'normal',
        { timeout: 5000 }).catch(() => false);
      const fsReset = await get('/api/admin/world?token=' + adminLogin.data.token);
      check('后台恢复默认体型模型（normal）', fsReset.data.fishCfg.sizeModel === 'normal', JSON.stringify(fsReset.data.fishCfg));

      // —— 经济参数：参数面板 / 预设填充 / 保存生效 / 单品干预 / 恢复默认 ——
      section('管理后台 · 经济参数');
      await clickAdminNav('经济参数', '#pc-save');
      const ecoPage = await pa.evaluate(() => ({
        hasSave: !!document.getElementById('pc-save'),
        hasReset: !!document.getElementById('pc-reset'),
        floor: (document.getElementById('pc-floor') || {}).value,
        tau: (document.getElementById('pc-tau') || {}).value,
        cap: (document.getElementById('eco-cap') || {}).textContent,
        presets: Array.from(document.querySelectorAll('[data-preset]')).length,
        tiers: Array.from(document.querySelectorAll('[id^="pc-t-"][id$="-follow"]')).length,
        listRows: document.querySelectorAll('#eco-list .eco-ov-set').length,
      }));
      check('经济参数页渲染（保存/恢复/7 项价格字段/预设/品质层/单品列表）',
        ecoPage.hasSave && ecoPage.hasReset && ecoPage.presets >= 4 && ecoPage.tiers === 3 && ecoPage.listRows === 47, JSON.stringify(ecoPage));
      check('默认值回填（地板 40 / 回升 60 分钟）', ecoPage.floor === '40' && ecoPage.tau === '60', JSON.stringify(ecoPage));
      check('容量试算行显示件/小时与毕业等效', /件\/h/.test(ecoPage.cap || '') && /毕业玩家/.test(ecoPage.cap || ''), (ecoPage.cap || '').slice(0, 120));
      // 预设「推荐（15 分钟）」填入表单（不自动保存）
      await pa.evaluate(() => { document.querySelector('[data-preset="fast"]').click(); });
      check('预设填充回升 15 分钟（未保存提示）',
        (await pa.evaluate(() => document.getElementById('pc-tau').value)) === '15'
        && /保存价格参数/.test(await pa.evaluate(() => document.getElementById('pc-state').textContent)));
      await pa.evaluate(() => { document.getElementById('pc-save').click(); });
      await waitFor(async () => (await get('/api/admin/world?token=' + adminLogin.data.token)).data.priceCfg.riseTauMin === 15,
        { timeout: 5000 }).catch(() => false);
      check('保存后服务端生效（回升 15 分钟）',
        (await get('/api/admin/world?token=' + adminLogin.data.token)).data.priceCfg.riseTauMin === 15);
      // 单品干预：给鲫鱼设锁价 ×3 → 目录出现覆盖 → 清除
      await pa.evaluate(() => {
        const m = document.querySelector('.eco-ov-m[data-id="crucian"]');
        m.value = '3';
        document.querySelector('.eco-ov-set[data-id="crucian"]').click();
      });
      await waitFor(async () => {
        const w = await get('/api/admin/world?token=' + adminLogin.data.token);
        return !!(w.data.economyCatalog || []).find(i => i.id === 'crucian' && i.ov && i.ov.m === 3);
      }, { timeout: 5000 }).catch(() => false);
      check('单品锁价干预生效（鲫鱼 ×3）',
        !!(await get('/api/admin/world?token=' + adminLogin.data.token)).data.economyCatalog.find(i => i.id === 'crucian' && i.ov && i.ov.m === 3));

      // 页面上该行必须真的把「锁 ×3」标签渲染出来。这一条是回归守卫：
      // 原实现 `const ov = it.ov ? (… ov.until …) : ''` 在自己的初始化式里引用自己，
      // 一旦该物品确实有覆盖就抛 TDZ「Cannot access 'ov' before initialization」，
      // 整段经济列表崩掉；只查接口是查不出来的（接口正常，是渲染层炸）。
      const ovTagShown = await untilGet(
        async () => pa.evaluate(() => {
          const inp = document.querySelector('.eco-ov-m[data-id="crucian"]');
          return inp && inp.parentElement ? inp.parentElement.textContent : '';
        }),
        t => /锁 ×3/.test(t || ''), 8000);
      check('单品覆盖率在页面上渲染出标签（锁 ×3）', /锁 ×3/.test(ovTagShown || ''), String(ovTagShown).slice(0, 160));
      const shopLocked = await get('/shop');
      check('锁价影响商店现价（8×3=24）', shopLocked.data.crucian.price === 24, JSON.stringify(shopLocked.data.crucian));
      await pa.evaluate(() => { document.querySelector('.eco-ov-clear[data-id="crucian"]').click(); });
      await waitFor(async () => !(await get('/api/admin/world?token=' + adminLogin.data.token)).data.economyCatalog.find(i => i.id === 'crucian').ov,
        { timeout: 5000 }).catch(() => false);
      check('清除干预后目录无覆盖', !(await get('/api/admin/world?token=' + adminLogin.data.token)).data.economyCatalog.find(i => i.id === 'crucian').ov);
      // 恢复默认（价格参数）
      await pa.evaluate(() => { document.getElementById('pc-reset').click(); });
      await waitFor(async () => (await get('/api/admin/world?token=' + adminLogin.data.token)).data.priceCfg.riseTauMin === 60,
        { timeout: 5000 }).catch(() => false);
      check('恢复默认价格参数（回升 60 分钟）',
        (await get('/api/admin/world?token=' + adminLogin.data.token)).data.priceCfg.riseTauMin === 60);

      // —— 账号管理：搜索联想 / 表头排序 / 快照弹窗（名称选择 + 定制配件）——
      section('管理后台 · 账号管理');
      await clickAdminNav('账号管理', '#mgr-q');
      check('账号管理有搜索框', await pa.evaluate(() => !!document.getElementById('mgr-q')));
      const rowsAll = await pa.$$eval('#mgr-list tbody tr', els => els.length);
      check('账号列表渲染出全部账号（3 个）', rowsAll === 3, String(rowsAll));
      // v0.11.6：「账号授权」页并入账号管理，管理员开关就长在列表里
      const navTexts = await pa.$$eval('.nav-item', els => els.map(e => e.textContent));
      check('侧栏不再有「账号授权」独立页（已并入账号管理）', !navTexts.some(t => /账号授权/.test(t)), JSON.stringify(navTexts));
      const switchN = await pa.$$eval('#mgr-list input[type=checkbox][data-admin]', els => els.length);
      check('账号管理页含管理员授权开关（每个账号一个）', switchN === 3, String(switchN));
      check('自己那一行的管理员开关禁用（不能撤销自己的权限）',
        await pa.evaluate(() => !!document.querySelector('#mgr-list input[type=checkbox][data-admin][disabled]')));
      // 勾选 → 授予管理员权限（随后取消，恢复初始状态不干扰后续用例）
      await pa.evaluate(() => {
        const cb = document.querySelector('#mgr-list input[type=checkbox][data-admin="aui_player"]');
        cb.checked = true; cb.dispatchEvent(new Event('change', { bubbles: true }));
      });
      const granted = await waitFor(async () => {
        const us = (await get('/api/admin/users?token=' + adminLogin.data.token)).data.users;
        return !!(us.find(u => u.key === 'aui_player') || {}).admin;
      }, { timeout: 6000 }).catch(() => false);
      check('在账号管理页勾选开关即授予管理员权限', granted === true, String(granted));
      await pa.evaluate(() => {
        const cb = document.querySelector('#mgr-list input[type=checkbox][data-admin="aui_player"]');
        cb.checked = false; cb.dispatchEvent(new Event('change', { bubbles: true }));
      });
      const revoked = await waitFor(async () => {
        const us = (await get('/api/admin/users?token=' + adminLogin.data.token)).data.users;
        return !(us.find(u => u.key === 'aui_player') || {}).admin;
      }, { timeout: 6000 }).catch(() => false);
      check('再次取消勾选即收回管理员权限', revoked === true, String(revoked));
      // v0.11.10：每个账号可调「市集挂单上限」（0 = 不限；留空 = 默认 40）
      const capCells = await pa.evaluate(() => Array.from(document.querySelectorAll('#mgr-list input[data-cap]')).map(i => i.getAttribute('data-cap')));
      check('账号列表每个账号一个挂单上限输入框', capCells.length === 3 && capCells.includes('aui_player'), JSON.stringify(capCells));
      await pa.evaluate(() => {
        const inp = document.querySelector('#mgr-list input[data-cap="aui_player"]');
        inp.value = '7'; inp.dispatchEvent(new Event('change', { bubbles: true }));
      });
      const capSaved = await waitFor(async () => {
        const us = (await get('/api/admin/users?token=' + adminLogin.data.token)).data.users;
        return (us.find(u => u.key === 'aui_player') || {}).listingCap === 7;
      }, { timeout: 6000 }).catch(() => false);
      check('在账号管理改挂单上限即存到服务器（7）', capSaved === true, String(capSaved));
      // 还原成默认（留空 → 40），不影响后续用例
      await pa.evaluate(() => {
        const inp = document.querySelector('#mgr-list input[data-cap="aui_player"]');
        inp.value = ''; inp.dispatchEvent(new Event('change', { bubbles: true }));
      });
      const capReset = await waitFor(async () => {
        const us = (await get('/api/admin/users?token=' + adminLogin.data.token)).data.users;
        const u = us.find(x => x.key === 'aui_player') || {};
        return u.listingCap === 40 && u.capSet === false;
      }, { timeout: 6000 }).catch(() => false);
      check('留空即恢复默认 40', capReset === true, String(capReset));
      // 搜索：输入 QQ 片段即过滤
      await pa.evaluate(() => { const q = document.getElementById('mgr-q'); q.value = '10023'; q.dispatchEvent(new Event('input', { bubbles: true })); });
      const rowsQQ = await pa.$$eval('#mgr-list tbody tr', els => els.length);
      check('按 QQ 片段过滤（10023 → 1 个买家）', rowsQQ === 1, String(rowsQQ));
      // 联想下拉：清空后输入，应出现候选并可点击定位
      await pa.evaluate(() => { const q = document.getElementById('mgr-q'); q.value = ''; q.dispatchEvent(new Event('input', { bubbles: true })); });
      await pa.evaluate(() => { const q = document.getElementById('mgr-q'); q.value = '后台买家'; q.dispatchEvent(new Event('input', { bubbles: true })); });
      const sugN = await waitFor(async () => (await pa.$$('#mgr-sug .mgr-sug-item')).length, { timeout: 4000 }).catch(() => 0);
      check('联想下拉出现候选（按显示名匹配）', sugN >= 1, String(sugN));
      await pa.evaluate(() => { const d = document.querySelector('#mgr-sug .mgr-sug-item'); if (d) d.click(); });
      const pickedRows = await pa.$$eval('#mgr-list tbody tr', els => els.length);
      check('点击联想项定位到该账号', pickedRows === 1, String(pickedRows));
      await pa.evaluate(() => { const q = document.getElementById('mgr-q'); q.value = ''; q.dispatchEvent(new Event('input', { bubbles: true })); });
      // 排序：点「金币」表头 → 金币升序；再点 → 降序
      await pa.evaluate(() => { document.querySelector('#mgr-list th[data-sort="coins"]').click(); });
      const coinsAsc = await pa.$$eval('#mgr-list tbody tr', els => els.map(tr => Number(tr.querySelector('td.num').textContent)));
      check('点表头按金币升序', coinsAsc.length === 3 && coinsAsc[0] <= coinsAsc[1] && coinsAsc[1] <= coinsAsc[2], JSON.stringify(coinsAsc));
      await pa.evaluate(() => { document.querySelector('#mgr-list th[data-sort="coins"]').click(); });
      const coinsDesc = await pa.$$eval('#mgr-list tbody tr', els => els.map(tr => Number(tr.querySelector('td.num').textContent)));
      check('再点按金币降序', coinsDesc.length === 3 && coinsDesc[0] >= coinsDesc[1] && coinsDesc[1] >= coinsDesc[2], JSON.stringify(coinsDesc));
      // 快照弹窗：新增物品是按名称的下拉（带分组），背包行显示物品名而非裸 ID
      // 先用接口给该账号一个背包（新号背包为空，弹窗里只有「背包为空」提示）
      await post('/api/admin/users/snapshot', { token: adminLogin.data.token, target: 'aui_player', coins: 500, inventory: { crucian: 3, line_nylon: 2 } });
      await pa.evaluate(k => { const b = document.querySelector('[data-snap="' + k + '"]'); if (b) b.click(); }, 'aui_player');
      await untilSel(pa, '#snap-add-id', 6000);
      const snapUi = await pa.evaluate(() => {
        const sel = document.getElementById('snap-add-id');
        const groups = Array.from(sel.querySelectorAll('optgroup')).map(g => g.label);
        const firstRow = document.querySelector('#snap-inv .snap-line label');
        return {
          groups: groups, opts: sel.querySelectorAll('option').length,
          rowText: firstRow ? firstRow.textContent.trim().slice(0, 40) : '',
          hasCus: !!document.getElementById('cus-base') && !!document.getElementById('cus-preview'),
        };
      });
      check('新增物品为名称下拉（鱼/材料/组件分组）', snapUi.groups.join(',') === '鱼,材料,组件（底材）' && snapUi.opts >= 75, JSON.stringify(snapUi.groups));
      check('背包行显示物品名而非裸 ID', /鲫鱼|黄金锦鲤|耐磨绳/.test(snapUi.rowText), snapUi.rowText);
      check('定制配件区已渲染', snapUi.hasCus === true, JSON.stringify(snapUi.hasCus));
      // 定制配件：选底材 → 加词条 → 预览生成名字 → 加入草稿
      const cusPreview = await pa.evaluate(() => {
        const base = document.getElementById('cus-base');
        base.value = 'rod_bamboo';
        base.dispatchEvent(new Event('change', { bubbles: true }));
        document.getElementById('cus-aff-add').click();
        const val = document.querySelector('#cus-affixes [data-cus-v="0"]');
        val.value = '50';
        val.dispatchEvent(new Event('input', { bubbles: true }));
        document.getElementById('cus-aff-add').click();
        return document.getElementById('cus-preview').textContent;
      });
      check('定制配件预览生成名称与词条', /竹制短竿/.test(cusPreview) && /钓速\+50/.test(cusPreview), cusPreview.slice(0, 120));
      await pa.evaluate(() => { document.getElementById('cus-add').click(); });
      const cusRow = await waitFor(async () => (await pa.evaluate(() =>
        Array.from(document.querySelectorAll('#snap-inv .snap-line label')).some(l => /竹制短竿/.test(l.textContent)))), { timeout: 4000 }).catch(() => false);
      check('定制配件已加入背包草稿', cusRow === true, String(cusRow));
      // —— v0.11.8：定制件不受底材词缀池与自然区间限制（6 类词条都能加、数值可越界，只标不拦） ——
      const cusFree = await pa.evaluate(() => {
        const rows = () => Array.from(document.querySelectorAll('#cus-affixes .cus-aff'));
        const opts = rows()[0].querySelector('select').options.length;
        for (let i = 0; i < 5; i++) document.getElementById('cus-aff-add').click();   // 2 条 → 再点 5 次（上限 6，第 7 次会被拦）
        const list = rows();
        const last = list[list.length - 1];
        const sel = last.querySelector('select');
        const v0 = rows()[0].querySelector('[data-cus-v]');
        v0.value = '999';
        v0.dispatchEvent(new Event('input', { bubbles: true }));
        const base = (window.GameData.COMPONENT_BASES || []).find(b => b.id === 'rod_bamboo');
        return {
          n: list.length, opts: opts, pool: ((base && base.pool) || []).map(p => p.type),
          types: list.map(r => r.querySelector('select').value),
          lastLabel: sel.options[sel.selectedIndex].textContent,
          lastHint: last.querySelector('.hint').textContent,
          extraHints: list.filter(r => /池外/.test(r.querySelector('.hint').textContent)).length,
          over: { txt: rows()[0].querySelector('.hint').textContent, cls: rows()[0].querySelector('.hint').className },
          preview: document.getElementById('cus-preview').textContent.replace(/\s+/g, ' ').trim(),
        };
      });
      check('定制件词条类型不再限底材池（下拉 6 类、最多可加到 6 条）',
        cusFree.opts === 6 && cusFree.pool.length === 2 && cusFree.n === 6 && new Set(cusFree.types).size === 6,
        JSON.stringify({ opts: cusFree.opts, pool: cusFree.pool, n: cusFree.n, types: cusFree.types }));
      check('池外词条标 ★池外、自然范围按池外（突破）区间给出',
        /★池外/.test(cusFree.lastLabel) && /^池外 /.test(cusFree.lastHint) && cusFree.extraHints >= 4,
        JSON.stringify({ last: cusFree.lastLabel, hint: cusFree.lastHint, extras: cusFree.extraHints }));
      check('数值可超出自然区间（标 ⚠越界，不拦）',
        /⚠越界/.test(cusFree.over.txt) && /cus-over/.test(cusFree.over.cls) && /钓速\+999/.test(cusFree.preview),
        JSON.stringify(cusFree.over) + ' | ' + cusFree.preview.slice(0, 130));
      await pa.evaluate(() => { const b = document.querySelector('.modal-overlay .cf-no'); if (b) b.click(); });

      // —— 横幅：发布 → 玩家端滚播并上报 → 后台「当前滚播」→ 停止滚播 ——
      section('管理后台 · 横幅滚播');
      await clickAdminNav('横幅管理', '#bn-content');
      await pa.evaluate(() => {
        document.getElementById('bn-content').value = 'QA 横幅滚播测试 ' + Date.now();
        document.getElementById('bn-dur').value = '20';
        document.getElementById('bn-add').click();
      });
      await sleep(1500);
      const marqueeShown = await waitFor(async () => (await p1.$$('#notice-banner.show')).length === 1, { timeout: 10000 }).catch(() => false);
      check('玩家端收到新公告并在公告轨开始滚播', marqueeShown === true, String(marqueeShown));
      await clickAdminNav('横幅管理', '#bn-live');
      const liveTxt = await pa.evaluate(() => { const n = document.getElementById('bn-live'); return n ? n.textContent.replace(/\s+/g, ' ') : ''; });
      check('后台「当前滚播」显示滚播中 1 条', /滚播中 1 条/.test(liveTxt), liveTxt.slice(0, 140));
      check('后台「当前滚播」列出观看人数与在线数', /观看人数/.test(liveTxt) && /在线/.test(liveTxt), liveTxt.slice(0, 140));
      await pa.evaluate(() => { const b = document.querySelector('[data-stop]'); if (b) b.click(); });
      await sleep(1300);
      const marqueeAfter = await waitFor(async () => (await p1.$$('#notice-banner.show')).length === 0, { timeout: 6000, interval: 200 }).catch(() => false);
      check('「停止滚播」后玩家端公告立即收起', marqueeAfter === true, String(marqueeAfter));
      await pa.evaluate(() => { document.getElementById('bn-clear').click(); });
      await sleep(400);
      await pa.evaluate(() => { const y = document.querySelector('.cf-yes'); if (y) y.click(); });
      await sleep(900);
      const cleared = await get('/api/banner');
      check('清空队列后无待播横幅', (cleared.data.banners || []).length === 0, String((cleared.data.banners || []).length));

      // —— 闪烁设置：独立开关（与横幅无关）+ 输入不被自动刷新冲掉 ——
      section('管理后台 · 闪烁设置');
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
      section('管理后台 · 反馈奖励');
      await post('/api/feedback/submit', { token: tokB, text: 'QA 奖励测试反馈', kind: 'idea' });
      await clickAdminNav('反馈意见', '.fb-card');
      const coinsBeforeRw = (await get('/api/me?token=' + tokB)).data.coins;
      await pa.evaluate(() => {
        const row = Array.from(document.querySelectorAll('.fb-card')).find(r => r.textContent.includes('QA 奖励测试反馈'));
        if (row) row.querySelector('[data-reward]').click();
      });
      await untilSel(pa, '.cf-val', 5000);
      await pa.evaluate(() => { document.querySelector('.cf-val').value = '1500'; document.querySelector('.cf-yes').click(); });
      await pa.evaluate(() => { const o = document.querySelector('.modal-overlay'); if (o) { const y = o.querySelector('.cf-yes'); if (y) y.click(); } });
      const coinsAfterRw = await untilGet(async () => (await get('/api/me?token=' + tokB)).data.coins,
        c => c === coinsBeforeRw + 1500, 8000);
      check('反馈奖励金币实时到账（+1500）', coinsAfterRw === coinsBeforeRw + 1500, coinsBeforeRw + ' -> ' + coinsAfterRw);
      const fbList2 = await get('/api/admin/feedback?token=' + adminLogin.data.token);
      const rwItem = (fbList2.data.feedback || []).find(f => f.text === 'QA 奖励测试反馈');
      check('反馈记录带奖励信息（金币 + 操作人）', !!(rwItem && rwItem.reward && rwItem.reward.coins === 1500 && rwItem.reward.by), JSON.stringify(rwItem && rwItem.reward));
      // 类型筛选（v0.14.1 起改 chips）：按「建议」筛——列表里当前就有这条 idea，
      // 断言「筛完非空且只剩建议」（旧写法筛 bug 时列表为空，[].every() 恒真 → 白过）
      const kindTexts = await untilGet(async () => {
        await pa.evaluate(() => {
          const b = Array.from(document.querySelectorAll('#fb-body .fb-chip')).find(x => x.getAttribute('data-fbf') === 'kind:idea');
          if (b && !b.classList.contains('on')) b.click();
        });
        return pa.$$eval('#fb-body .fb-card .fb-kind', els => els.map(e => e.textContent.trim()));
      }, arr => !!(arr && arr.length && arr.every(t => t.indexOf('建议') >= 0)), 8000);
      check('后台反馈按类型筛选生效（仅剩建议）', kindTexts.length > 0 && kindTexts.every(t => t.indexOf('建议') >= 0), kindTexts.join(','));
      const kindAll = await untilGet(async () => {
        await pa.evaluate(() => {
          const b = Array.from(document.querySelectorAll('#fb-body .fb-chip')).find(x => x.getAttribute('data-fbf') === 'kind:all');
          if (b && !b.classList.contains('on')) b.click();
        });
        return pa.$$eval('#fb-body .fb-card', els => els.length);
      }, n => n >= 1, 8000);
      check('点回「全部类型」恢复列表', kindAll >= 1, String(kindAll));
      // 玩家端：我的反馈按状态筛选 + 奖励标记
      // p1 名下的账号要先有反馈记录，筛选控件与历史列表才渲染得出来
      await post('/api/feedback/submit', { token: tokP, text: 'QA 玩家侧筛选反馈', kind: 'bug' });
      await clickNav(p1, '反馈意见');
      await untilSel(p1, '.fb-history .fb-item', 8000);
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
      // 奖励对象是买家（tokB → p2），在买家页面验证奖励标记
      await clickNav(p2, '反馈意见');
      await untilSel(p2, '.fb-history .fb-item', 8000);
      const rwShown = await p2.evaluate(() => {
        const row = Array.from(document.querySelectorAll('.fb-history .fb-item')).find(r => r.textContent.includes('奖励'));
        return row ? row.textContent : '';
      });
      check('玩家端能看到「已获奖励」标记（买家）', /已获奖励 \+1500/.test(rwShown), rwShown.slice(0, 140));

      // —— 宝匣配置页（突破保底 + 池外词缀区间）——
      // 放在最后：本段只动 chestCfg / extraAffixRanges，不碰其它用例依赖的装配与榜单状态。
      section('管理后台 · 宝匣配置');
      await clickAdminNav('宝匣配置', '#ch-pity-save');
      const chStruct = await pa.evaluate(() => ({
        rows: document.querySelectorAll('#ch-body table tbody tr').length,
        headers: Array.from(document.querySelectorAll('#ch-body table thead th')).map(e => e.textContent.trim()),
        rangeInputs: document.querySelectorAll('#ch-body input[id^="ch-ar-"]').length,
        // .mgr-row .ipt 默认 flex:1；宝匣页的输入框必须包在 .ch-fix 里才不会被拉宽
        pityFlex: getComputedStyle(document.getElementById('ch-pity').parentElement).flexGrow,
        pityWidth: document.getElementById('ch-pity').getBoundingClientRect().width,
      }));
      check('宝匣配置页渲染四档一览', chStruct.rows === 4 && chStruct.headers.length === 5, JSON.stringify(chStruct));
      check('池外词缀区间有 6 类 × 2 输入', chStruct.rangeInputs === 12, String(chStruct.rangeInputs));
      check('保底输入框未被 flex 拉宽（<200px）', Number(chStruct.pityWidth) < 200, JSON.stringify(chStruct));

      // 保存保底 3 → 服务端生效
      await pa.fill('#ch-pity', '3');
      await pa.evaluate(() => document.getElementById('ch-pity-save').click());
      await waitFor(async () => (await get('/api/admin/world?token=' + adminLogin.data.token)).data.chestCfg.pityN === 3,
        { timeout: 8000 }).catch(() => {});
      const pitySaved = await get('/api/admin/world?token=' + adminLogin.data.token);
      check('保存宝匣保底次数生效（3）', pitySaved.data.chestCfg.pityN === 3, JSON.stringify(pitySaved.data.chestCfg));
      check('保底次数在玩家端可见（/api/version）', (await get('/api/version')).data.chestCfg.pityN === 3);

      // 越界值必须被服务器拒绝且不改动现值
      await pa.fill('#ch-pity', '999');
      await pa.evaluate(() => document.getElementById('ch-pity-save').click());
      await sleep(600);
      check('保底次数越界 999 被拒（仍为 3）',
        (await get('/api/admin/world?token=' + adminLogin.data.token)).data.chestCfg.pityN === 3);

      // 关闭保底
      await pa.evaluate(() => document.getElementById('ch-pity-reset').click());
      await waitFor(async () => (await get('/api/admin/world?token=' + adminLogin.data.token)).data.chestCfg.pityN === 0,
        { timeout: 8000 }).catch(() => {});
      check('「关闭保底」归零', (await get('/api/admin/world?token=' + adminLogin.data.token)).data.chestCfg.pityN === 0);

      // 池外词缀区间：保存 → 恢复默认
      await pa.fill('#ch-ar-speed-min', '2');
      await pa.fill('#ch-ar-speed-max', '5');
      await pa.evaluate(() => document.getElementById('ch-ar-save').click());
      await waitFor(async () => {
        const r = (await get('/api/admin/world?token=' + adminLogin.data.token)).data.extraAffixRanges || {};
        return !!(r.speed && r.speed[0] === 2 && r.speed[1] === 5);
      }, { timeout: 8000 }).catch(() => {});
      const arSaved = ((await get('/api/admin/world?token=' + adminLogin.data.token)).data.extraAffixRanges || {}).speed;
      check('池外词缀区间保存生效（钓速 2~5）', !!(arSaved && arSaved[0] === 2 && arSaved[1] === 5), JSON.stringify(arSaved));
      await pa.evaluate(() => document.getElementById('ch-ar-reset').click());
      await waitFor(async () => Object.keys((await get('/api/admin/world?token=' + adminLogin.data.token)).data.extraAffixRanges || {}).length === 0,
        { timeout: 8000 }).catch(() => {});
      check('「恢复默认」清空覆盖',
        Object.keys((await get('/api/admin/world?token=' + adminLogin.data.token)).data.extraAffixRanges || {}).length === 0);

      // 神话品质是宝匣专属：组件生成的品质权重里不能出现 mythic，否则钓鱼掉落会出神话件
      await clickAdminNav('组件生成', '#cmp-save');
      const qwIds = await pa.$$eval('#comp-body input[id^="qw-"]', els => els.map(e => e.id));
      check('组件生成页品质权重无 mythic（神话不可由钓鱼掉落）',
        qwIds.length === 3 && !qwIds.some(id => /mythic/.test(id)), qwIds.join(','));

      // v0.13.5：修饰词规则面板要「一眼看懂」——逐字段标签 / 上下移序 / 自然语言摘要 / 试算命中分布
      const adjUi = await pa.evaluate(() => {
        const rows = Array.prototype.slice.call(document.querySelectorAll('#adj-rows .adj-row'));
        return {
          rows: rows.length,
          idx: rows.map(r => (r.querySelector('.adj-idx') || {}).textContent),
          labels: rows.map(r => r.querySelector('.adj-cond').textContent.replace(/\s+/g, ' ').trim()),
          previews: rows.map(r => (r.querySelector('.adj-preview') || {}).textContent),
          hasUpDown: rows.every(r => !!r.querySelector('.adj-up') && !!r.querySelector('.adj-down')),
          firstUpDisabled: !!(rows[0] && rows[0].querySelector('.adj-up').disabled),
          fieldLabels: Array.prototype.slice.call(document.querySelectorAll('#adj-rows .adj-num')).map(n => n.textContent.replace(/\s+/g, ' ').trim()),
          headHint: document.querySelector('#comp-body').textContent.indexOf('词缀池全中') >= 0,
        };
      });
      check('规则行按顺序编号（1..N）', adjUi.rows === 5 && adjUi.idx.join(',') === '1,2,3,4,5', JSON.stringify(adjUi.idx));
      check('每个数值框都有独立字段标签（净收益 / 词条数 各带区间）',
        adjUi.fieldLabels.filter(t => /词条净收益/.test(t)).length === 5 &&
        adjUi.fieldLabels.filter(t => /词条数/.test(t)).length === 5, JSON.stringify(adjUi.fieldLabels.slice(0, 4)));
      check('勾选项带条件说明（满词条 / 无负词条）',
        adjUi.labels.every(t => /满词条/.test(t) && /无负词条/.test(t)), JSON.stringify(adjUi.labels.slice(0, 2)));
      check('每行有自然语言摘要（当…→ 显示「…」）',
        adjUi.previews.length === 5 && adjUi.previews.every(t => /→ 显示「/.test(t)), JSON.stringify(adjUi.previews.slice(0, 3)));
      check('每行有上移 / 下移（第一条的上移禁用）', adjUi.hasUpDown === true && adjUi.firstUpDisabled === true);
      check('面板顶部说明「满词条 = 词缀池全中」口径', adjUi.headHint === true);
      // 下移第 1 条 → 顺序真的换了（行号重排 + 第一条的上移重新启用）
      await pa.evaluate(() => document.querySelector('#adj-rows .adj-row .adj-down').click());
      const reordered = await pa.evaluate(() => {
        const rows = Array.prototype.slice.call(document.querySelectorAll('#adj-rows .adj-row'));
        return {
          names: rows.map(r => r.querySelector('.adj-name').value),
          idx: rows.map(r => r.querySelector('.adj-idx').textContent),
          firstUpDisabled: rows[0].querySelector('.adj-up').disabled,
        };
      });
      check('下移第 1 条 → 顺序调整且行号重排',
        reordered.names[0] === '饱满的' && reordered.names[1] === '完美的' && reordered.idx[0] === '1' && reordered.firstUpDisabled === true,
        JSON.stringify(reordered));
      await pa.evaluate(() => document.querySelector('#adj-rows .adj-row .adj-up').click());  // 还原顺序
      // 试算：命中分布（含示例件）直接可读
      await pa.evaluate(() => { document.getElementById('cmp-sim').click(); });
      await waitFor(async () => /修饰词命中分布/.test(await pa.textContent('#cmp-sim-out')),
        { timeout: 20000, interval: 100 }).catch(() => {});
      const simOut = await pa.textContent('#cmp-sim-out');
      check('试算输出修饰词命中分布（占比 + 示例组件）',
        /修饰词命中分布/.test(simOut) && /%/.test(simOut) && /词条/.test(simOut), String(simOut).slice(0, 200));
      check('试算输出满词条（池内全满）占比', /满词条（池内全满）/.test(simOut), String(simOut).slice(0, 200));

      // ===================== v0.11：宝匣成本 / 钓点拖动定位 / 工坊 / 商城 / 版本更新 =====================
      section('v0.11 后台新页面');
      // 本段包含「等待页面自身定时器刷新」的检查（版本更新倒计时）：
      // Chrome 会节流后台标签页的定时器，先把后台页拿到前台再测，避免误判。
      await pa.bringToFront();

      // —— 宝匣配置：四档成本可直接编辑 ——
      await clickAdminNav('宝匣配置', '#ch-pity');
      const chCost = await pa.evaluate(() => ({
        inputs: document.querySelectorAll('.ch-cost').length,
        save: !!document.getElementById('ch-cost-save'),
      }));
      check('宝匣配置页渲染成本输入框（4 档 × 残片/金币 = 8 个）', chCost.inputs === 8 && chCost.save, JSON.stringify(chCost));
      await pa.evaluate(() => {
        document.querySelector('.ch-cost[data-cid="chest_wreck"][data-k="costRelic"]').value = '4';
        document.querySelector('.ch-cost[data-cid="chest_wreck"][data-k="costCoins"]').value = '1200';
        document.getElementById('ch-cost-save').click();
      });
      const costApplied = await untilGet(async () => (await get('/api/admin/world?token=' + adminLogin.data.token)).data, d => {
        const c = d && (d.chests || []).find(x => x.id === 'chest_wreck');
        return !!c && c.costRelic === 4 && c.costCoins === 1200;
      }, 8000);
      check('保存后成本立即生效（沉船宝匣 4 残片 / 1200 金币）',
        (function () { const c = (costApplied.chests || []).find(x => x.id === 'chest_wreck'); return !!c && c.costRelic === 4 && c.costCoins === 1200; })(),
        JSON.stringify((costApplied.chests || []).find(x => x.id === 'chest_wreck')));
      await untilSel(pa, '#ch-cost-reset', 6000);   // 保存后页面会重绘一次，等按钮回到 DOM
      await pa.evaluate(() => document.getElementById('ch-cost-reset').click());
      await untilSel(pa, '.cf-yes', 5000);          // 后台用的是 .cf-yes / .cf-no 子窗口按钮
      await pa.click('.cf-yes');
      const costReset = await untilGet(async () => (await get('/api/admin/world?token=' + adminLogin.data.token)).data, d => {
        const c = d && (d.chests || []).find(x => x.id === 'chest_wreck');
        return !!c && c.costRelic === 8;
      }, 8000);
      check('恢复出厂成本生效（沉船宝匣回到 8 残片）',
        (function () { const c = (costReset.chests || []).find(x => x.id === 'chest_wreck'); return !!c && c.costRelic === 8; })(),
        JSON.stringify((costReset.chests || []).find(x => x.id === 'chest_wreck')));

      // —— 渔场钓点：地图定位支持拖动 ——
      await clickAdminNav('渔场钓点', '#gd-map-canvas');
      // 明确选中「静水湖」：地图面板只画**当前选中渔场**的钓点，前面用例可能把选中项留在没有钓点的渔场上。
      // 后台页的 /api/admin/world 偶发慢（本就有 8 秒超时 + GET 重试），这里再兜一层：
      // 若 3 秒后地图节点还没出来，就重进一次本页（不重复点同一页时是空操作，代价很小）。
      const mapReady0 = await waitFor(async () => {
        const ok = (await pa.$$('.gd-node')).length >= 3;
        if (!ok) {
          await pa.evaluate(() => {
            const b = Array.from(document.querySelectorAll('.nav-item')).find(x => x.textContent.includes('渔场钓点'));
            if (b) b.click();
          });
          await waitFor(async () => (await pa.$$('.gcard[data-g="stillwater"]')).length > 0, { timeout: 9000, interval: 200 }).catch(() => false);
          await pa.evaluate(() => { const c = document.querySelector('.gcard[data-g="stillwater"]'); if (c) c.click(); });
        }
        return ok;
      }, { timeout: 30000, interval: 3000 }).catch(() => false);
      void mapReady0;
      const mapReady = await waitFor(async () => (await pa.$$('.gd-node')).length >= 3, { timeout: 15000, interval: 400 }).catch(() => false);
      check('地图定位面板渲染全部钓点节点', mapReady === true, String((await pa.$$('.gd-node')).length));
      const beforePos = await pa.evaluate(() => {
        const n = document.querySelector('.gd-node');
        return n ? { sid: n.getAttribute('data-s'), left: n.style.left, top: n.style.top } : null;
      });
      const mapBox = await pa.evaluate(() => {
        const r = document.getElementById('gd-map-canvas').getBoundingClientRect();
        return { x: r.x, y: r.y, w: r.width, h: r.height };
      });
      const nb = await pa.evaluate(() => {
        const r = document.querySelector('.gd-node').getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      });
      await pa.mouse.move(nb.x, nb.y);
      await pa.mouse.down();
      await pa.mouse.move(mapBox.x + mapBox.w * 0.3, mapBox.y + mapBox.h * 0.25, { steps: 8 });
      await pa.mouse.up();
      const draggedPos = await pa.evaluate(() => {
        const n = document.querySelector('.gd-node');
        return { sid: n.getAttribute('data-s'), left: n.style.left, top: n.style.top };
      });
      check('拖动节点改变了地图坐标',
        draggedPos.left !== beforePos.left || draggedPos.top !== beforePos.top,
        JSON.stringify({ before: beforePos, after: draggedPos }));
      await pa.evaluate(() => document.getElementById('gd-map-save').click());
      const posSaved = await untilGet(async () => (await get('/api/grounds')).data, d => {
        const g = d && (d.grounds || []).find(x => x.id === 'stillwater');
        const sp = g && g.spots.find(s => s.id === 'dock');
        return !!sp && Array.isArray(sp.pos) && Math.abs(sp.pos[0] - 30) < 0.8;
      }, 8000);
      const dockNow = ((posSaved.grounds || []).find(g => g.id === 'stillwater') || { spots: [] }).spots.find(s => s.id === 'dock');
      check('拖动后的坐标已保存并同步到玩家端目录（x≈30）',
        !!dockNow && Array.isArray(dockNow.pos) && Math.abs(dockNow.pos[0] - 30) < 0.8, JSON.stringify(dockNow && dockNow.pos));

      // —— 工坊配置：熔炼参数可改（含 v0.11.3 的残片保留参数） ——
      await clickAdminNav('工坊配置', '#ws-cfg-baseRate');
      const wsCfgView = await pa.evaluate(() => ({
        base: (document.getElementById('ws-cfg-baseRate') || {}).value,
        mats: document.querySelectorAll('#ws-body .ch-ar-wrap .ch-fix').length,
        save: !!document.getElementById('ws-cfg-save'),
        retainFormula: (document.getElementById('ws-cfg-retainFormula') || {}).value,
        retainMax: (document.getElementById('ws-cfg-retainMaxRelic') || {}).value,
        hasPreset: !!document.getElementById('cat-preset'),
      }));
      check('工坊配置页渲染熔炼参数与材料对照', wsCfgView.base === '50' && wsCfgView.mats >= 7 && wsCfgView.save, JSON.stringify(wsCfgView));
      check('工坊配置页含残片保留公式（默认 10 - breakthrough * 0.5）与片数上限 10',
        /10\s*-\s*breakthrough\s*\*\s*0\.5/.test(wsCfgView.retainFormula || '') && wsCfgView.retainMax === '10',
        JSON.stringify(wsCfgView));
      check('催化词缀范围带「一键预设」按钮', wsCfgView.hasPreset === true, JSON.stringify(wsCfgView));
      // —— v0.11.5：词缀搬移与补缀三项开关（副件区间 / 任意补缀 + 词条数上限 / 补缀按池外区间） ——
      const wsNewCfg = await pa.evaluate(() => ({
        subRange: !!(document.getElementById('ws-cfg-subRangeFromSub') || {}).checked,
        anyAffix: !!(document.getElementById('ws-cfg-addAnyAffix') || {}).checked,
        cap: (document.getElementById('ws-cfg-addAffixCap') || {}).value,
        addExtra: !!(document.getElementById('ws-cfg-addAffixExtraRange') || {}).checked,
      }));
      check('工坊配置页含 v0.11.5 补缀开关（副件区间 / 任意补缀 / 上限 3 / 补缀池外区间）',
        wsNewCfg.subRange === true && wsNewCfg.anyAffix === true && wsNewCfg.cap === '3' && wsNewCfg.addExtra === true,
        JSON.stringify(wsNewCfg));
      // 改「补缀后词条数上限」为 4 并保存 → 生效
      await pa.evaluate(() => {
        document.getElementById('ws-cfg-addAffixCap').value = '4';
        document.getElementById('ws-cfg-save').click();
      });
      const capApplied = await untilGet(async () => (await get('/api/admin/world?token=' + adminLogin.data.token)).data,
        d => !!d && !!d.smeltCfg && d.smeltCfg.addAffixCap === 4, 8000);
      check('补缀词条数上限可后台修改并生效（3 → 4）',
        !!(capApplied.smeltCfg && capApplied.smeltCfg.addAffixCap === 4), JSON.stringify(capApplied.smeltCfg));
      await post('/api/admin/smelt/config', { token: adminLogin.data.token, addAffixCap: 3 });   // 还原
      await pa.evaluate(() => {
        document.getElementById('ws-cfg-baseRate').value = '66';
        document.getElementById('ws-cfg-retainMaxRelic').value = '6';
        document.getElementById('ws-cfg-save').click();
      });
      const smeltApplied = await untilGet(async () => (await get('/api/admin/world?token=' + adminLogin.data.token)).data,
        d => !!d && !!d.smeltCfg && d.smeltCfg.baseRate === 66, 8000);
      check('保存熔炼参数立即生效（基础成功率 66%）', !!(smeltApplied.smeltCfg && smeltApplied.smeltCfg.baseRate === 66),
        JSON.stringify(smeltApplied.smeltCfg));
      check('残片保留上限一并保存（10 → 6 片）', smeltApplied.smeltCfg.retainMaxRelic === 6, JSON.stringify(smeltApplied.smeltCfg));
      await post('/api/admin/smelt/config', { token: adminLogin.data.token, retainMaxRelic: 10 });   // 还原，避免影响后续用例

      // —— 商城配置：刷新时间 + 商品编辑 ——
      await clickAdminNav('商城配置', '#ml-rt');
      const mlView = await pa.evaluate(() => ({
        rt: (document.getElementById('ml-rt') || {}).value,
        rows: document.querySelectorAll('#ml-body tbody tr').length,
        add: !!document.getElementById('ml-add'),
        save: !!document.getElementById('ml-save'),
      }));
      check('商城配置页渲染刷新时间与商品列表',
        /^\d{2}:\d{2}$/.test(mlView.rt || '') && mlView.rows >= 5 && mlView.add && mlView.save, JSON.stringify(mlView));
      // 用不在出厂列表里的物品（黄金锦鲤）新增一行：出厂列表已含潮汐砂，重复添加会被前端拦下
      await pa.evaluate(() => {
        document.getElementById('ml-add-id').value = 'koi';
        document.getElementById('ml-add-price').value = '888';
        document.getElementById('ml-add-limit').value = '2';
        document.getElementById('ml-add').click();
      });
      await untilGet(async () => (await pa.$$eval('#ml-body .ml-price', els => els.length)), n => n >= 7, 5000);
      await pa.evaluate(() => {
        document.getElementById('ml-rt').value = '06:30';
        document.getElementById('ml-save').click();
      });
      const mallSaved = await untilGet(async () => (await get('/api/admin/world?token=' + adminLogin.data.token)).data,
        d => !!d && !!d.mallCfg && d.mallCfg.refreshTime === '06:30', 8000);
      check('保存商城配置（刷新时间 06:30 + 新增商品 黄金锦鲤×888 限购 2）',
        !!(mallSaved.mallCfg) && mallSaved.mallCfg.refreshTime === '06:30' &&
        mallSaved.mallCfg.items.some(x => x.id === 'koi' && x.price === 888 && x.limit === 2),
        JSON.stringify(mallSaved.mallCfg && mallSaved.mallCfg.items.slice(-2)));

      // —— 纪录贴图：缩放（≤500%）与 xy 偏移 ——
      await clickAdminNav('纪录贴图', '#rc-scale');
      const rcView = await pa.evaluate(() => {
        const sc = document.getElementById('rc-scale');
        const num = document.getElementById('rc-scale-num');
        const prev = document.getElementById('rc-preview');
        return {
          range: !!sc, num: (num || {}).value, max: (sc || {}).max, min: (sc || {}).min,
          preview: !!prev, previewStyle: prev ? (prev.getAttribute('style') || '') : '',
        };
      });
      check('纪录贴图页渲染（滑块 + 数字框，上限 500%）',
        rcView.range && rcView.preview && rcView.max === '500' && rcView.num === '175', JSON.stringify(rcView));
      check('预览贴图套用了缩放变量（默认 1.75）', /--rh-scale:1\.75/.test(rcView.previewStyle), rcView.previewStyle);
      await pa.evaluate(() => {
        document.getElementById('rc-scale-num').value = '250';
        document.getElementById('rc-scale-num').dispatchEvent(new Event('input'));
        document.getElementById('rc-x').value = '20';
        document.getElementById('rc-x').dispatchEvent(new Event('input'));
        document.getElementById('rc-y').value = '-15';
        document.getElementById('rc-y').dispatchEvent(new Event('input'));
      });
      const rcPreview = await pa.evaluate(() => (document.getElementById('rc-preview') || {}).getAttribute('style') || '');
      check('调整后预览实时跟随（2.5 倍 / 20,-15）',
        /--rh-scale:2\.5/.test(rcPreview) && /--rh-dx:20px/.test(rcPreview) && /--rh-dy:-15px/.test(rcPreview), rcPreview);
      await pa.evaluate(() => document.getElementById('rc-save').click());
      const rcSaved = await untilGet(async () => (await get('/api/admin/world?token=' + adminLogin.data.token)).data,
        d => !!d && !!d.recordsCfg && d.recordsCfg.scale === 250, 8000);
      check('保存后玩家端贴图设置生效（250% / 20,-15）',
        !!rcSaved.recordsCfg && rcSaved.recordsCfg.scale === 250 && rcSaved.recordsCfg.x === 20 && rcSaved.recordsCfg.y === -15,
        JSON.stringify(rcSaved.recordsCfg));
      await pa.evaluate(() => document.getElementById('rc-reset').click());
      const rcReset = await untilGet(async () => (await get('/api/admin/world?token=' + adminLogin.data.token)).data,
        d => !!d && !!d.recordsCfg && d.recordsCfg.scale === 175, 8000);
      check('恢复默认贴图设置（175%）', rcReset.recordsCfg.scale === 175, JSON.stringify(rcReset.recordsCfg));

      // —— 公式管理：可用变量里要有「技巧」 ——
      await clickAdminNav('公式管理', '#fx-src');
      const fxView = await pa.evaluate(() => {
        const panel = Array.from(document.querySelectorAll('.panel')).find(p => /可用变量/.test(p.textContent));
        const fxv = document.getElementById('fxv-skill');
        return {
          text: panel ? panel.textContent.replace(/\s+/g, ' ').slice(0, 200) : '',
          hasSkillCode: panel ? !!panel.querySelector('code') && /skill/.test(panel.textContent) : false,
          evalField: !!fxv,
          defaultFormula: (document.getElementById('fx-src') || {}).value || '',
        };
      });
      check('可用变量区列出 skill（技巧）并说明它的作用',
        fxView.hasSkillCode && /技巧/.test(fxView.text) && /90 \+ skill/.test(fxView.text), JSON.stringify(fxView).slice(0, 220));
      check('试算表单含技巧变量输入框，默认公式使用 skill',
        fxView.evalField === true && /skill/.test(fxView.defaultFormula), fxView.defaultFormula);

      // —— v0.13：后台「版本更新」功能已整体移除（入口、横幅与接口） ——
      const noUpd = await pa.evaluate(() => ({
        navText: Array.from(document.querySelectorAll('.nav-item')).map(b => b.textContent || '').join('|'),
        hasBat: !!document.getElementById('up-bat'),
        hasLive: !!document.getElementById('up-live'),
      }));
      check('后台侧栏不再有「版本更新」入口',
        !/版本更新/.test(noUpd.navText) && !noUpd.hasBat && !noUpd.hasLive, JSON.stringify(noUpd).slice(0, 160));

      await pa.evaluate(() => { const b = document.querySelector('.nav-item'); if (b) b.click(); });

      check('后台全程无页面错误', adminErrs.length === castErrs, adminErrs.slice(castErrs).join(' | '));
    } else {
      check('管理后台登录可用（前置条件）', false, JSON.stringify(adminLogin.data));
    }
    check('全程无页面错误', errs.length === 0, errs.join(' | '));

  } catch (e) {
    console.log('TEST ERROR: ' + e.message);
    console.log(e.stack);
    fail++;
  } finally {
    if (browser) await browser.close();
    srv.kill();
    try { fs.rmSync(TMP_DATA, { recursive: true, force: true }); } catch (e) {}
    console.log('');
    console.log('============================');
    console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
    if (fail) { console.log('失败项：'); failed.forEach(function (f) { console.log('  - ' + f); }); }
    console.log(fail === 0 ? 'ADMIN UI TESTS PASS' : 'ADMIN UI TESTS FAILED');
    console.log('============================');
    setTimeout(() => process.exit(fail === 0 ? 0 : 1), 150);
  }
})();

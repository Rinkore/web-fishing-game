'use strict';
/*
 * Wiki 浏览器回归（Chrome DevTools Protocol，不依赖 playwright）
 * 覆盖：页面渲染、规则状态、搜索、钓点详情、配装交互与分享、熔炼交互与产物带入。
 * 运行：node tests/wiki/browser.test.js
 */
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { waitHttp } = require('../_util.js');
const { provisionAdmin } = require('../_admin.js');
const registrationProof = require('../_registration.js');

const ROOT = path.join(__dirname, '..', '..');
const GAME_VERSION = require(path.join(ROOT, 'frontend/js/data.js')).VERSION;
const PORT = Number(process.env.WIKI_BROWSER_TEST_PORT) || 8272;
const CDP_PORT = Number(process.env.WIKI_CDP_TEST_PORT) || 9272;
const BASE = 'http://127.0.0.1:' + PORT;
const SOURCE_COMMIT = '0123456789abcdef0123456789abcdef01234567';
const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'fishing-wiki-browser-'));
const TMP_PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'fishing-wiki-chrome-'));

let pass = 0, fail = 0;
const failed = [];
function check(name, value, extra) {
  if (value) { pass++; console.log('  PASS  ' + name); }
  else { fail++; failed.push(name); console.log('  FAIL  ' + name + (extra ? '  -> ' + extra : '')); }
}
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function killTree(p) { try { spawnSync('taskkill', ['/F', '/T', '/PID', String(p.pid)], { stdio: 'ignore' }); } catch (e) {} }
function chromePath() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const paths = [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  ];
  return paths.find(p => fs.existsSync(p)) || '';
}
async function newTab(url) {
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch('http://127.0.0.1:' + CDP_PORT + '/json/new?' + encodeURIComponent(url), { method: 'PUT' });
      if (res.ok) return await res.json();
    } catch (e) {}
    await sleep(100);
  }
  throw new Error('Chrome DevTools 未就绪');
}
function connect(url) {
  const ws = new WebSocket(url);
  let seq = 0;
  const pending = new Map();
  const events = [];
  ws.onmessage = e => {
    const msg = JSON.parse(e.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    else if (msg.method) events.push(msg);
  };
  const opened = new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  return {
    events: events,
    close: () => ws.close(),
    send: async function (method, params) {
      await opened;
      const id = ++seq;
      ws.send(JSON.stringify({ id, method, params: params || {} }));
      return await new Promise(resolve => pending.set(id, resolve));
    },
  };
}
async function evaluate(cdp, expression) {
  const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.result && r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails));
  return r.result ? r.result.result.value : undefined;
}
async function openPage(url) {
  const info = await newTab(BASE + url);
  const cdp = connect(info.webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');
  await cdp.send('Log.enable');
  let ready = false;
  for (let i = 0; i < 100; i++) {
    ready = await evaluate(cdp, "document.readyState === 'complete' && !!document.getElementById('main')");
    if (ready) break;
    await sleep(100);
  }
  if (!ready) throw new Error('Wiki 页面未完成加载: ' + url);
  await sleep(800);
  return cdp;
}
function errors(cdp) {
  return cdp.events.filter(e => e.method === 'Runtime.exceptionThrown' ||
    (e.method === 'Log.entryAdded' && e.params.entry && e.params.entry.level === 'error'));
}

async function main() {
  const fixture = require('./simulator-fixture')(TMP_DATA);
  const server = spawn(process.execPath, ['backend/server.js'], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      PORT: String(PORT), FISHING_DATA_DIR: TMP_DATA, SOURCE_COMMIT: SOURCE_COMMIT,
    }),
    stdio: ['pipe', 'ignore', 'pipe'],
  });
  const chromeFile = chromePath();
  check('找到 Chrome/Edge 可执行文件', !!chromeFile, chromeFile);
  if (!chromeFile) throw new Error('未找到 Chrome 或 Edge');
  const chrome = spawn(chromeFile, [
    '--headless', '--disable-gpu', '--no-sandbox',
    '--remote-debugging-port=' + CDP_PORT, '--user-data-dir=' + TMP_PROFILE, 'about:blank',
  ], { stdio: 'ignore' });
  try {
    check('临时服务就绪', await waitHttp(BASE + '/api/version', { timeout: 20000 }));

    const home = await openPage('/wiki/');
    const homeText = await evaluate(home, 'document.body.innerText');
    check('首页使用游戏化资料站外壳且不显示规则技术信息', homeText.includes('WIKI 资料中心') && homeText.includes('配装模拟器') && !homeText.includes('规则可用') && !homeText.includes('配置哈希'), homeText.slice(0, 300));
    const homeLayout = await evaluate(home, `(() => {
      const main = document.getElementById('main');
      const grid = document.querySelector('.home-grid');
      const latest = document.querySelector('.latest-update');
      return { display: getComputedStyle(main).display, mainWidth: main.clientWidth, cardWidth: grid ? grid.getBoundingClientRect().width : 0, latest: latest ? latest.innerText : '' };
    })()`);
    check('首页内容铺满且只显示最近一次更新', homeLayout.display === 'block' && homeLayout.cardWidth > homeLayout.mainWidth * 0.8 && homeLayout.latest.includes(GAME_VERSION + ' 版本更新'), JSON.stringify(homeLayout).slice(0, 400));
    check('首页无脚本异常', errors(home).length === 0, JSON.stringify(errors(home).slice(0, 2)));
    home.close();

    const updates = await openPage('/wiki/updates/index.html');
    const updatesText = await evaluate(updates, 'document.body.innerText');
    check('更新记录默认只突出最近一次更新', updatesText.includes('最近一次更新') && updatesText.includes(GAME_VERSION + ' 版本更新') && !updatesText.includes('v0.19.0') && !updatesText.includes('v0.18.0'), updatesText.slice(0, 300));
    const updatesHistory = await evaluate(updates, `(() => { const d = document.querySelector('details.history-details'); return { has: !!d, open: !!(d && d.open), text: d ? d.textContent : '' }; })()`);
    check('更新记录保留可展开的历史入口', updatesHistory.has && !updatesHistory.open && updatesHistory.text.includes('v0.18.0'), JSON.stringify({ has: updatesHistory.has, open: updatesHistory.open }).slice(0, 200));
    check('更新记录不展示规则快照与纠错模板', !updatesText.includes('配置哈希') && !updatesText.includes('纠错入口') && !updatesText.includes('复制纠错模板'), updatesText.slice(0, 300));
    check('更新记录无脚本异常', errors(updates).length === 0, JSON.stringify(errors(updates).slice(0, 2)));
    const expandedHistory = await evaluate(updates, `(() => { const d = document.querySelector('details.history-details'); d.open = true; return { latestCount: document.querySelectorAll('.updates-latest .update-item').length, historyHasGame: d.innerText.includes('v0.19.0'), repeatsLatest: d.innerText.includes('${GAME_VERSION} 版本更新') }; })()`);
    check('合并后的最新记录只有一条，历史含游戏版本且不重复最新', expandedHistory.latestCount === 1 && expandedHistory.historyHasGame && !expandedHistory.repeatsLatest, JSON.stringify(expandedHistory));
    updates.close();

    const guides = await openPage('/wiki/guides/index.html');
    const guidesText = await evaluate(guides, 'document.body.innerText');
    check('攻略页渲染热更新内容目录', guidesText.includes('七部位五词条参考配装') && guidesText.includes('工坊止损') && guidesText.includes('六词条装备怎么做'), guidesText.slice(0, 300));
    check('攻略页无脚本异常', errors(guides).length === 0, JSON.stringify(errors(guides).slice(0, 2)));
    guides.close();

    const guideDetail = await openPage('/wiki/guides/index.html?slug=six-affix-workshop-route');
    let guideDetailState = null;
    for (let i = 0; i < 20; i++) {
      await sleep(200);
      guideDetailState = await evaluate(guideDetail, `({ text: document.body.innerText, hasArticle: !!document.querySelector('.guide-layout .article') })`);
      if (guideDetailState.text.includes('第一步：补双钓，做出五词条')) break;
    }
    check('攻略详情按需加载正文并渲染', !!guideDetailState && guideDetailState.hasArticle && guideDetailState.text.includes('第一步：补双钓，做出五词条') && guideDetailState.text.includes('自己的词条不一样，怎么换配方'), JSON.stringify(guideDetailState).slice(0, 300));
    check('攻略详情无脚本异常', errors(guideDetail).length === 0, JSON.stringify(errors(guideDetail).slice(0, 2)));
    guideDetail.close();

    // 用户投稿：先在浏览器上下文登录，再走真实提交表单。
    const userRegister = await postJson('/api/register', { username: 'wikiuser', password: 'wiki-test-1234', name: 'Wiki User', qq: '827201' });
    check('浏览器测试投稿用户注册成功', userRegister.status === 200, JSON.stringify(userRegister.data || {}));
    const loginPage = await openPage('/wiki/');
    const browserLogin = await evaluate(loginPage, `(async () => {
      const res = await fetch('/api/login', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'FishGame', 'X-Session-Mode': 'cookie' },
        body: JSON.stringify({ username: 'wikiuser', password: 'wiki-test-1234' })
      });
      return { status: res.status, data: await res.json().catch(() => ({})) };
    })()`);
    check('浏览器上下文登录投稿用户成功', browserLogin.status === 200, JSON.stringify(browserLogin));
    loginPage.close();

    const loggedInGuides = await openPage('/wiki/guides/index.html');
    const loggedInGuidesText = await evaluate(loggedInGuides, 'document.body.innerText');
    check('已登录攻略页显示投稿入口', loggedInGuidesText.includes('贡献攻略') && loggedInGuidesText.includes('我的攻略'), loggedInGuidesText.slice(0, 400));
    check('已登录攻略页无脚本异常', errors(loggedInGuides).length === 0, JSON.stringify(errors(loggedInGuides).slice(0, 2)));
    loggedInGuides.close();

    const submit = await openPage('/wiki/guides/submit.html');
    await evaluate(submit, `(async () => {
      const form = document.querySelector('.guide-form');
      const title = form.querySelector('input');
      const category = form.querySelector('select');
      const summary = form.querySelector('textarea');
      const tags = Array.from(form.querySelectorAll('input'))[1];
      const sectionTitle = form.querySelector('.guide-section-head input');
      const sectionText = form.querySelector('.guide-section textarea');
      title.value = '浏览器投稿验证';
      category.value = '心得分享';
      summary.value = '一篇通过真实表单提交的验证攻略。';
      tags.value = '浏览器, 验证';
      sectionTitle.value = '思路';
      sectionText.value = '先用模拟器确认收益，再投入材料。';
      [title, summary, tags, sectionTitle, sectionText].forEach(x => x.dispatchEvent(new Event('input', { bubbles: true })));
      category.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise(r => setTimeout(r, 100));
      form.requestSubmit();
      return true;
    })()`);
    let submitState = null;
    for (let i = 0; i < 20; i++) {
      await sleep(200);
      submitState = await evaluate(submit, `({ url: location.href, text: document.body.innerText, status: document.querySelector('.status-line') && document.querySelector('.status-line').innerText })`);
      if (submitState.text.includes('已通过')) break;
    }
    check('投稿表单提交后自动通过并进入我的攻略', submitState.url.includes('/wiki/guides/index.html?my=1') && submitState.text.includes('已通过（自动）') && submitState.text.includes('浏览器投稿验证'), JSON.stringify(submitState).slice(0, 400));
    check('投稿页面无脚本异常', errors(submit).filter(e => e.method === 'Runtime.exceptionThrown').length === 0, JSON.stringify(errors(submit).filter(e => e.method === 'Runtime.exceptionThrown').slice(0, 2)));
    const submittedGuide = await evaluate(submit, `(async () => {
      const res = await fetch('/api/wiki/guides/my', { credentials: 'same-origin' });
      const data = await res.json();
      return data.guides && data.guides[0];
    })()`);
    check('我的攻略接口返回自动通过的浏览器投稿', !!(submittedGuide && submittedGuide.title === '浏览器投稿验证' && submittedGuide.status === 'approved' && submittedGuide.autoApproved === true), JSON.stringify(submittedGuide || null));
    submit.close();


    const search = await openPage('/wiki/search/index.html?q=' + encodeURIComponent('世界地图'));
    const searchText = await evaluate(search, 'document.body.innerText');
    check('搜索“世界地图”返回钓场结果', searchText.includes('世界地图'), searchText.slice(0, 300));
    const searchMs = await evaluate(search, `(() => { const t = performance.now(); for (let i = 0; i < 100; i++) window.Wiki.search('龙宫宝珠', 'all'); return performance.now() - t; })()`);
    check('全站搜索 100 次平均耗时低于 100ms', searchMs / 100 < 100, (searchMs / 100).toFixed(2) + 'ms');
    check('搜索无脚本异常', errors(search).length === 0, JSON.stringify(errors(search).slice(0, 3)));
    search.close();

    const itemSearch = await openPage('/wiki/search/index.html?q=' + encodeURIComponent('血燕钩'));
    const itemSearchState = await evaluate(itemSearch, `(() => {
      const img = document.querySelector('.search-result img');
      return { text: document.body.innerText, hasImg: !!img, src: img ? img.src : '', loaded: !!(img && img.complete && img.naturalWidth > 0) };
    })()`);
    check('搜索组件结果显示贴图', itemSearchState.text.includes('血燕钩') && itemSearchState.hasImg && itemSearchState.src.includes('/assets/item/hook_swallow.png') && itemSearchState.loaded, JSON.stringify(itemSearchState).slice(0, 400));
    check('组件搜索无脚本异常', errors(itemSearch).length === 0, JSON.stringify(errors(itemSearch).slice(0, 2)));
    itemSearch.close();

    const itemDetail = await openPage('/wiki/search/index.html?item=hook_swallow');
    const itemDetailState = await evaluate(itemDetail, `(() => ({ text: document.body.innerText, hero: !!document.querySelector('.item-hero img'), tool: !!document.querySelector('.item-hero') }))()`);
    check('条目详情显示贴图、词缀池与工具入口', itemDetailState.hero && itemDetailState.text.includes('词缀池') && itemDetailState.text.includes('熔炼模拟器'), JSON.stringify(itemDetailState).slice(0, 300));
    check('条目详情无脚本异常', errors(itemDetail).length === 0, JSON.stringify(errors(itemDetail).slice(0, 2)));
    itemDetail.close();

    const grounds = await openPage('/wiki/grounds/index.html?ground=map');
    const groundsText = await evaluate(grounds, 'document.body.innerText');
    check('钓点详情展示世界地图钓点', groundsText.includes('湖畔老码头') && groundsText.includes('芦苇荡') && groundsText.includes('湖心深水'), groundsText.slice(0, 300));
    check('钓点详情无脚本异常', errors(grounds).length === 0);
    grounds.close();

    const build = await openPage('/wiki/tools/build.html?ground=map&spot=dock&base=rod_bamboo');
    await build.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await sleep(200);
    const buildPreset = await evaluate(build, 'document.getElementById("current-result").innerText');
    check('配装链接预设底材与钓点', buildPreset.includes('钓速') && buildPreset.includes('8') && buildPreset.includes('9259 ms'), buildPreset);
    const buildLayout = await evaluate(build, `(() => {
      const workbench = document.querySelector('.smelt-workbench');
      const preview = document.querySelector('.sm-preview-panel');
      const style = getComputedStyle(workbench);
      return { columns: style.gridTemplateColumns.split(' ').length, previewPosition: getComputedStyle(preview).position, hasSlots: !!document.getElementById('slots'), hasCompare: !!document.getElementById('compare-result') };
    })()`);
    check('配装模拟器使用工坊式双栏布局', buildLayout.columns === 2 && buildLayout.previewPosition === 'sticky' && buildLayout.hasSlots && buildLayout.hasCompare, JSON.stringify(buildLayout));
    const share = await evaluate(build, `(async () => {
      document.getElementById('research-mode').click();
      const root = document.querySelector('.slot-editor');
      root.querySelector('[data-add-affix]').click();
      await new Promise(r => setTimeout(r, 100));
      const row = document.querySelector('.slot-editor .affix-row');
      row.querySelector('[data-field="type"]').value = 'speed';
      row.querySelector('[data-field="value"]').value = '50';
      row.querySelector('[data-field="type"]').dispatchEvent(new Event('change', { bubbles: true }));
      row.querySelector('[data-field="value"]').dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise(r => setTimeout(r, 200));
      document.getElementById('export-code').click();
      const code = document.getElementById('share-code').value;
      document.getElementById('plan-b').click();
      await new Promise(r => setTimeout(r, 100));
      document.getElementById('share-code').value = code;
      document.getElementById('import-code').click();
      await new Promise(r => setTimeout(r, 300));
      return { length: code.length, text: document.getElementById('current-result').innerText };
    })()`);
    check('配装方案码导出导入往返', share.length > 100 && share.text.includes('50') && share.text.includes('6667 ms'), JSON.stringify(share));
    const offline = await evaluate(build, `(async () => {
      window.fetch = function () { return Promise.reject(new Error('offline')); };
      await window.Wiki.refresh();
      return { status: document.getElementById('status-card').innerText, result: document.getElementById('current-result').innerText };
    })()`);
    check('规则失联后配装模拟器禁用', offline.status.includes('规则不可用') && offline.result.includes('数值与模拟器已禁用'), JSON.stringify(offline));
    check('配装模拟器无脚本异常', errors(build).length === 0);
    build.close();

    const smelt = await openPage('/wiki/tools/smelt.html');
    await smelt.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await sleep(200);
    const smeltLayout = await evaluate(smelt, `(() => {
      const workbench = document.querySelector('.smelt-workbench');
      const preview = document.querySelector('.sm-preview-panel');
      const style = getComputedStyle(workbench);
      return { columns: style.gridTemplateColumns.split(' ').length, previewPosition: getComputedStyle(preview).position, hasMain: !!document.getElementById('main-editor'), hasSub: !!document.getElementById('sub-editor'), hasPreview: !!document.getElementById('preview') };
    })()`);
    check('熔炼模拟器使用工坊式双栏布局', smeltLayout.columns === 2 && smeltLayout.previewPosition === 'sticky' && smeltLayout.hasMain && smeltLayout.hasSub && smeltLayout.hasPreview, JSON.stringify(smeltLayout));
    const catalyst = await evaluate(smelt, `(async () => {
      const get = id => document.getElementById(id);
      const input = id => document.querySelector('[data-material="' + id + '"]');
      const plus = id => input(id).closest('.ws-mat').querySelector('[data-delta="1"]');
      const original = GameData.getSmeltCfg();
      const initiallyHidden = !get('material-dialog').open;
      GameData.setSmeltCfg(Object.assign({}, original, { maxMaterials: 3, maxTypes: 1 }));
      get('material-open').click();
      const limits = get('material-limit').textContent;
      const blocked = input('tide_sand').disabled;
      plus('bait_pack').click();
      const typeLimited = plus('lure').disabled;
      input('bait_pack').value = '99';
      input('bait_pack').dispatchEvent(new Event('change', { bubbles: true }));
      const capped = input('bait_pack').value === '3' && plus('bait_pack').disabled;
      input('bait_pack').closest('.ws-mat').querySelector('[data-delta="-1"]').click();
      const decreased = input('bait_pack').value === '2';
      get('material-done').click();
      await new Promise(r => setTimeout(r, 50));
      const focusReturned = document.activeElement === get('material-open');
      get('material-open').click();
      const persisted = input('bait_pack').value === '2';
      get('material-close').click();
      const sub = document.querySelector('#sub-editor [data-field="type"]');
      const previousType = sub.value;
      sub.value = 'rare'; sub.dispatchEvent(new Event('change', { bubbles: true }));
      const invalidRemoved = input('bait_pack').value === '0' && get('material-note').textContent.includes('已移除');
      const restoredSub = document.querySelector('#sub-editor [data-field="type"]');
      restoredSub.value = previousType; restoredSub.dispatchEvent(new Event('change', { bubbles: true }));
      GameData.setSmeltCfg(original);
      return { initiallyHidden, limits, blocked, typeLimited, capped, decreased, focusReturned, persisted, invalidRemoved };
    })()`);
    check('催化剂弹窗按规则展示上限并禁用不适用材料', catalyst.initiallyHidden && catalyst.limits.includes('3 份 / 1 种') && catalyst.blocked, JSON.stringify(catalyst));
    check('催化剂限制份数和种类，支持减少数量', catalyst.typeLimited && catalyst.capped && catalyst.decreased, JSON.stringify(catalyst));
    check('关闭催化剂弹窗保留选择并归还焦点', catalyst.focusReturned && catalyst.persisted, JSON.stringify(catalyst));
    check('更换词条后移除不适用的催化剂并提示', catalyst.invalidRemoved, JSON.stringify(catalyst));
    const smeltResult = await evaluate(smelt, `(async () => {
      document.getElementById('material-open').click();
      const input = document.querySelector('[data-material="bait_pack"]');
      input.closest('.ws-mat').querySelector('[data-delta="1"]').click();
      document.getElementById('material-done').click();
      await new Promise(r => setTimeout(r, 200));
      const preview = document.getElementById('preview').innerText;
      for (let i = 0; i < 20; i++) {
        document.getElementById('simulate-once').click();
        await new Promise(r => setTimeout(r, 80));
        if (document.getElementById('single-result').innerText.includes('熔炼成功')) break;
      }
      document.getElementById('send-to-build').click();
      await new Promise(r => setTimeout(r, 200));
      document.getElementById('batch-count').value = '100';
      document.getElementById('batch-start').click();
      await new Promise(r => setTimeout(r, 1200));
      return { preview: preview, single: document.getElementById('single-result').innerText, batch: document.getElementById('batch-result').innerText };
    })()`);
    check('熔炼投料概率与费用按共享规则计算', smeltResult.preview.includes('48%') && smeltResult.preview.includes('8%') && smeltResult.preview.includes('3.8%') && smeltResult.preview.includes('5900'), smeltResult.preview);
    check('熔炼单次结果可写入本地', smeltResult.single.includes('已写入本地') && smeltResult.single.includes('熔炼成功'), smeltResult.single);
    check('熔炼批量完成并输出分布', smeltResult.batch.includes('100 次独立试验') && smeltResult.batch.includes('词缀数分布'), smeltResult.batch);
    await smelt.send('Emulation.setDeviceMetricsOverride', { width: 360, height: 740, deviceScaleFactor: 1, mobile: true });
    const catalystMobile = await evaluate(smelt, `(() => {
      document.getElementById('material-open').click();
      const dialog = document.getElementById('material-dialog'), rect = dialog.getBoundingClientRect();
      const body = dialog.querySelector('.sm-material-body');
      return { fits: rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight && dialog.scrollWidth <= dialog.clientWidth, scrollable: body.scrollHeight > body.clientHeight && getComputedStyle(body).overflowY === 'auto' };
    })()`);
    check('360px 催化剂弹窗完整显示且列表可滚动', catalystMobile.fits && catalystMobile.scrollable, JSON.stringify(catalystMobile));
    await smelt.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await smelt.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await sleep(100);
    check('催化剂弹窗支持 Escape 关闭', await evaluate(smelt, `!document.getElementById('material-dialog').open && document.activeElement.id === 'material-open'`));
    check('熔炼模拟器无脚本异常', errors(smelt).length === 0);
    smelt.close();

    async function postJson(pathname, body, headers) {
      const res = await fetch(BASE + pathname, { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, headers || {}), body: JSON.stringify(body) });
      return { status: res.status, data: await res.json().catch(() => ({})) };
    }
    async function registerAdmin() {
      const payload = { username: 'wikiadmin', password: 'wiki-test-1234', name: 'Wiki Admin', qq: '827200' };
      let r = await postJson('/api/register', payload);
      if (r.status === 200 && r.data && r.data.code === 'REGISTRATION_CHALLENGE') {
        const challenge = await fetch(BASE + '/api/register/challenge').then(x => x.json());
        r = await postJson('/api/register', Object.assign({}, payload, { proof: registrationProof.solve(challenge) }));
      }
      return r;
    }
    check('浏览器测试管理员注册成功', (await registerAdmin()).status === 200);
    const otp = await provisionAdmin(server, TMP_DATA, 'wikiadmin');
    const admin = await openPage('/admin.html');
    const adminLogin = await evaluate(admin, `(async () => {
      document.getElementById('login-user').value = 'wikiadmin';
      document.getElementById('login-pass').value = 'wiki-test-1234';
      document.getElementById('login-otp').value = '${otp}';
      document.getElementById('login-btn').click();
      await new Promise(r => setTimeout(r, 900));
      return {
        loginHidden: document.getElementById('login').style.display === 'none',
        nav: Array.from(document.querySelectorAll('.nav-item')).map(x => x.textContent)
      };
    })()`);
    check('管理后台登录并显示 Wiki 攻略入口', adminLogin.loginHidden && adminLogin.nav.some(x => x.includes('Wiki攻略')), JSON.stringify(adminLogin));
    const castEditor = await evaluate(admin, `(async () => {
      document.querySelector('[data-view="formula"]')?.click();
      if (!document.getElementById('cast-formula')) {
        Array.from(document.querySelectorAll('.nav-item')).find(x => x.textContent.includes('公式管理')).click();
      }
      const wait = async f => { for (let n=0;n<100;n++) { if(f()) return true; await new Promise(r=>setTimeout(r,50)); } return false; };
      await wait(() => document.getElementById('cast-formula')?.value);
      const input=document.getElementById('cast-formula');
      const defaults=input.value==='interval / (1 + speed / 100)' && document.getElementById('cast-base').value==='10000';
      input.value='interval / 2'; input.dispatchEvent(new Event('input',{bubbles:true}));
      const preview=document.getElementById('cast-preview').innerText.includes('5.00s');
      document.getElementById('cast-save').click();
      const saved=await wait(()=>document.getElementById('cast-state').innerText.includes('已保存'));
      const cfg=await fetch('/api/admin/world',{credentials:'same-origin'}).then(r=>r.json());
      document.getElementById('cast-reset').click();
      const reset=await wait(()=>input.value==='interval / (1 + speed / 100)' && document.getElementById('cast-state').innerText.includes('已恢复默认'));
      return {defaults,preview,saved:saved&&cfg.castFormula==='interval / 2',reset};
    })()`);
    check('公式管理默认 10s 与可编辑抛竿公式回显', castEditor.defaults, JSON.stringify(castEditor));
    check('抛竿公式编辑后本地预览与保存生效', castEditor.preview && castEditor.saved, JSON.stringify(castEditor));
    check('抛竿公式可恢复默认', castEditor.reset, JSON.stringify(castEditor));
    const adminWiki = await evaluate(admin, `(async () => {
      const button = Array.from(document.querySelectorAll('.nav-item')).find(x => x.textContent.includes('Wiki攻略'));
      if (button) button.click();
      await new Promise(r => setTimeout(r, 900));
      return {
        title: document.querySelector('main h2') && document.querySelector('main h2').innerText,
        meta: document.getElementById('wiki-meta') && document.getElementById('wiki-meta').innerText,
        cards: document.querySelectorAll('.wiki-card').length,
        json: document.getElementById('wiki-json') && document.getElementById('wiki-json').value.slice(0, 200)
      };
    })()`);
    check('管理后台 Wiki 官方编辑器可用', adminWiki.title && adminWiki.title.includes('Wiki 攻略管理') && adminWiki.cards > 0 && adminWiki.json.includes('guides'), JSON.stringify(adminWiki));
    check('管理后台 Wiki 页无脚本异常', errors(admin).filter(e => e.method === 'Runtime.exceptionThrown').length === 0, JSON.stringify(errors(admin).filter(e => e.method === 'Runtime.exceptionThrown').slice(0, 2)));
    const adminReview = await evaluate(admin, `(async () => {
      const res = await fetch('/api/admin/wiki/guides?status=approved', { credentials: 'same-origin' });
      const data = await res.json().catch(() => ({}));
      return {
        mainText: document.getElementById('main').innerText.slice(0, 800),
        listText: document.getElementById('wiki-review-list').innerText,
        autoApprove: data.autoApprove,
        hasGuide: !!(data.guides || []).some(g => g.title === '浏览器投稿验证' && g.autoApproved)
      };
    })()`);
    check('管理后台显示自动审核模式与已通过投稿', adminReview.autoApprove === true && adminReview.hasGuide && adminReview.mainText.includes('自动通过'), JSON.stringify(adminReview).slice(0, 600));
    const publicAfterReview = await openPage('/wiki/guides/index.html');
    const publicAfterReviewText = await evaluate(publicAfterReview, 'document.body.innerText');
    check('自动通过后玩家投稿公开可见', publicAfterReviewText.includes('浏览器投稿验证') && publicAfterReviewText.includes('Wiki User'), publicAfterReviewText.slice(0, 500));
    check('公开攻略页审核后无脚本异常', errors(publicAfterReview).length === 0, JSON.stringify(errors(publicAfterReview).slice(0, 2)));
    publicAfterReview.close();
    const userSearch = await openPage('/wiki/search/index.html?q=' + encodeURIComponent('浏览器投稿验证'));
    const userSearchText = await evaluate(userSearch, 'document.body.innerText');
    check('全站搜索包含已通过玩家投稿', userSearchText.includes('浏览器投稿验证'), userSearchText.slice(0, 300));
    check('玩家投稿搜索无脚本异常', errors(userSearch).length === 0, JSON.stringify(errors(userSearch).slice(0, 2)));
    userSearch.close();
    admin.close();

    for (const [name, url] of [
      ['首页 360px 无横向溢出', '/wiki/'],
      ['配装模拟器 360px 无横向溢出', '/wiki/tools/build.html?ground=map&spot=dock&base=rod_bamboo'],
      ['熔炼模拟器 360px 无横向溢出', '/wiki/tools/smelt.html'],
      ['投稿页 360px 无横向溢出', '/wiki/guides/submit.html'],
      ['攻略详情 360px 无横向溢出', '/wiki/guides/?slug=six-affix-workshop-route'],
      ['搜索贴图 360px 无横向溢出', '/wiki/search/?q=' + encodeURIComponent('尼龙')],
      ['更新记录 360px 无横向溢出', '/wiki/updates/'],
    ]) {
      const mobile = await openPage(url);
      await mobile.send('Emulation.setDeviceMetricsOverride', { width: 360, height: 740, deviceScaleFactor: 2, mobile: true });
      await sleep(300);
      const overflow = await evaluate(mobile, 'document.documentElement.scrollWidth - window.innerWidth');
      check(name, overflow <= 1, 'overflow=' + overflow);
      if (url.includes('slug=six-affix')) {
        const folded = await evaluate(mobile, `(() => { const d = document.querySelector('details.guide-side'); return !!d && !d.open; })()`);
        check('手机攻略目录默认折叠，正文可直接阅读', folded);
      }
      mobile.close();
    }

    const buildFromSmelt = await openPage('/wiki/tools/build.html?ground=map&spot=dock');
    const handoff = await evaluate(buildFromSmelt, `(async () => {
      document.getElementById('plan-b').click();
      await new Promise(r => setTimeout(r, 100));
      document.getElementById('load-smelt').click();
      await new Promise(r => setTimeout(r, 300));
      return document.getElementById('current-result').innerText;
    })()`);
    check('熔炼产物可带入配装计算', handoff.includes('钓速') && handoff.includes('体型'), handoff);
    check('产物带入配装无脚本异常', errors(buildFromSmelt).length === 0);
    buildFromSmelt.close();

    // Real HTTP reads from an isolated fixture account; every subsequent edit stays local.
    const stockBefore = await (await fetch(BASE + '/api/wiki/simulator/inventory', { headers: { Authorization: 'Bearer ' + fixture.token } })).json();
    const accountBefore = fs.readFileSync(fixture.file, 'utf8');
    const stockBuild = await openPage('/wiki/tools/build.html');
    await stockBuild.send('Network.enable');
    await stockBuild.send('Network.setCookie', { name: 'fish_game', value: fixture.token, url: BASE, httpOnly: true, sameSite: 'Strict' });
    const stockBuildResult = await evaluate(stockBuild, `(async () => {
      const get = id => document.getElementById(id);
      get('inventory-refresh').click();
      for (let i = 0; i < 50 && get('inventory-refresh').disabled; i++) await new Promise(r => setTimeout(r, 50));
      const loaded = get('inventory-status').textContent.includes('模拟器测试装备');
      const before = JSON.stringify(WikiInventory.snapshot);
      get('inventory-rod').value = '0'; get('inventory-load-rod').click();
      get('export-code').click();
      const imported = Wiki.decodeShare(get('share-code').value).plan.slots.line;
      const calculated = !get('current-result').textContent.includes('超出当前规则区间');
      document.querySelector('[data-part="line"] [data-add-affix]').click();
      get('research-mode').click();
      const custom = document.querySelector('[data-part="line"] .affix-row:last-child [data-field="value"]');
      custom.value = '77'; custom.dispatchEvent(new Event('change', { bubbles: true }));
      get('save-plan').click(); get('copy-plan').click(); get('export-code').click();
      const modified = Wiki.decodeShare(get('share-code').value).plan.slots.line;
      const snapshotIntact = JSON.stringify(WikiInventory.snapshot) === before;
      get('inventory-rod').value = 'current'; get('inventory-load-rod').click();
      get('export-code').click();
      const equipped = Wiki.decodeShare(get('share-code').value).plan.slots.rod;
      const picker = document.querySelector('[data-part="line"] .inventory-picker select');
      picker.value = ${JSON.stringify(fixture.mainId)}; picker.dispatchEvent(new Event('change', { bubbles: true }));
      const rowCount = document.querySelectorAll('[data-part="line"] .affix-row').length;
      get('inventory-refresh').click();
      for (let i = 0; i < 50 && get('inventory-refresh').disabled; i++) await new Promise(r => setTimeout(r, 50));
      return { loaded, imported, calculated, modified, snapshotIntact, equipped, rowCount };
    })()`);
    check('从已存钓竿复制实际词条并保留副件来源', stockBuildResult.loaded && stockBuildResult.imported.affixes.length === 4 && stockBuildResult.imported.affixes.some(a => a.src === 'line_titan' && a.srcExplicit) && stockBuildResult.calculated, JSON.stringify(stockBuildResult));
    check('库存配装可自定义词条、保存和复制且不改变背包副本', stockBuildResult.modified.affixes.some(a => a.value === 77) && stockBuildResult.snapshotIntact);
    check('可读取当前穿戴与单件库存组件', stockBuildResult.equipped.baseId === 'rod_bamboo' && stockBuildResult.rowCount === 4);
    await stockBuild.send('Emulation.setDeviceMetricsOverride', { width: 360, height: 740, deviceScaleFactor: 1, mobile: true });
    check('已加载长词条库存的配装页 360px 无溢出', await evaluate(stockBuild, `document.documentElement.scrollWidth <= innerWidth`));

    const stockSmelt = await openPage('/wiki/tools/smelt.html');
    await stockSmelt.send('Network.enable');
    const stockSmeltResult = await evaluate(stockSmelt, `(async () => {
      const get = id => document.getElementById(id);
      get('inventory-refresh').click();
      for (let i = 0; i < 50 && get('inventory-refresh').disabled; i++) await new Promise(r => setTimeout(r, 50));
      const before = JSON.stringify(WikiInventory.snapshot);
      for (const role of ['main','sub']) {
        const part = document.querySelector('#' + role + '-editor [data-field="part"]');
        part.value = 'line'; part.dispatchEvent(new Event('change', { bubbles: true }));
        const select = document.querySelector('#' + role + '-editor .inventory-picker select');
        select.value = role === 'main' ? ${JSON.stringify(fixture.mainId)} : ${JSON.stringify(fixture.subId)};
        select.dispatchEvent(new Event('change', { bubbles: true }));
      }
      get('relics').value = '10'; get('relics').dispatchEvent(new Event('change', { bubbles: true }));
      get('material-open').click();
      const material = document.querySelector('[data-material="dragon_scale"]'); material.value = '12'; material.dispatchEvent(new Event('change', { bubbles: true }));
      const stockText = material.closest('.ws-mat').innerText;
      get('material-done').click();
      let called = 0;
      const originalSimulate = GameData.simulateSmeltPlan;
      GameData.simulateSmeltPlan = function (p) { called++; return originalSimulate(p, () => 0); };
      get('simulate-once').click();
      const single = get('single-result').innerText;
      get('send-to-build').click();
      get('use-result').click();
      const nextAffixes = document.querySelectorAll('#main-editor .affix-row').length;
      get('batch-count').value = '100'; get('batch-start').click();
      for (let i = 0; i < 60 && get('batch-start').disabled; i++) await new Promise(r => setTimeout(r, 50));
      GameData.simulateSmeltPlan = originalSimulate;
      const snapshotIntact = JSON.stringify(WikiInventory.snapshot) === before;
      return { stockText, single, nextAffixes, snapshotIntact, called, batch: get('batch-result').innerText };
    })()`);
    check('熔炼读取真实材料参考库存且调用游戏共享计算', stockSmeltResult.stockText.includes('背包 27') && stockSmeltResult.called === 101 && stockSmeltResult.single.includes('熔炼成功'), JSON.stringify(stockSmeltResult));
    check('熔炼产物可继续模拟和批量试算，库存副本不被扣减', stockSmeltResult.nextAffixes === 5 && stockSmeltResult.snapshotIntact && stockSmeltResult.batch.includes('100 次独立试验'));
    const stockAfter = await (await fetch(BASE + '/api/wiki/simulator/inventory', { headers: { Authorization: 'Bearer ' + fixture.token } })).json();
    delete stockBefore.fetchedAt; delete stockAfter.fetchedAt;
    await sleep(1300);
    check('配装、修改词条、单次和批量熔炼后真实资产与存档完全不变', JSON.stringify(stockBefore) === JSON.stringify(stockAfter) && fs.readFileSync(fixture.file, 'utf8') === accountBefore);
    const requests = [stockBuild, stockSmelt].flatMap(c => c.events.filter(e => e.method === 'Network.requestWillBeSent').map(e => e.params.request)).filter(r => new URL(r.url).pathname.startsWith('/api/'));
    check('模拟器所有网络操作仅使用允许的只读接口', requests.length > 0 && requests.every(r => r.method === 'GET' && ['/api/wiki/simulator/inventory', '/api/version', '/api/wiki/content'].includes(new URL(r.url).pathname)), JSON.stringify(requests.map(r => r.method + ' ' + new URL(r.url).pathname)));
    await stockBuild.send('Network.deleteCookies', { name: 'fish_game', url: BASE });
    const expired = await evaluate(stockBuild, `(async () => {
      document.getElementById('inventory-refresh').click();
      for (let i = 0; i < 50 && document.getElementById('inventory-refresh').disabled; i++) await new Promise(r => setTimeout(r, 50));
      return { status: document.getElementById('inventory-status').textContent, cleared: WikiInventory.snapshot === null, disabled: document.querySelector('.inventory-picker select').disabled };
    })()`);
    check('会话失效时提示登录并清理旧背包选择', expired.cleared && expired.disabled && expired.status.includes('请先在游戏中登录'));
    check('库存模拟页面无脚本异常', errors(stockBuild).filter(e => e.method === 'Runtime.exceptionThrown').length === 0 && errors(stockSmelt).length === 0);
    stockBuild.close(); stockSmelt.close();

  } finally {
    killTree(chrome);
    killTree(server);
    try { fs.rmSync(TMP_PROFILE, { recursive: true, force: true }); } catch (e) {}
    try { fs.rmSync(TMP_DATA, { recursive: true, force: true }); } catch (e) {}
  }

  console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  if (fail) { console.log('失败项：' + failed.join('、')); process.exitCode = 1; }
}
main().catch(e => { console.error(e.stack || e); process.exitCode = 1; });

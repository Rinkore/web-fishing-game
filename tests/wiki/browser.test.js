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
const PORT = 8272;
const CDP_PORT = 9272;
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
  if (r.result && r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.text);
  return r.result ? r.result.result.value : undefined;
}
async function openPage(url) {
  const info = await newTab(BASE + url);
  const cdp = connect(info.webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');
  await cdp.send('Log.enable');
  await sleep(800);
  return cdp;
}
function errors(cdp) {
  return cdp.events.filter(e => e.method === 'Runtime.exceptionThrown' ||
    (e.method === 'Log.entryAdded' && e.params.entry && e.params.entry.level === 'error'));
}

async function main() {
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
    check('首页显示规则可用与版本', homeText.includes('规则可用') && homeText.includes('v0.18.0'), homeText.slice(0, 200));
    check('首页无脚本异常', errors(home).length === 0, JSON.stringify(errors(home).slice(0, 2)));
    home.close();

    const guides = await openPage('/wiki/guides/index.html');
    const guidesText = await evaluate(guides, 'document.body.innerText');
    check('攻略页渲染热更新内容目录', guidesText.includes('七部位五词条参考配装') && guidesText.includes('工坊止损'), guidesText.slice(0, 300));
    check('攻略页无脚本异常', errors(guides).length === 0, JSON.stringify(errors(guides).slice(0, 2)));
    guides.close();

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
      if (submitState.text.includes('待审核')) break;
    }
    check('投稿表单提交成功并进入我的攻略', submitState.url.includes('/wiki/guides/index.html?my=1') && submitState.text.includes('待审核'), JSON.stringify(submitState));
    check('投稿页面无脚本异常', errors(submit).filter(e => e.method === 'Runtime.exceptionThrown').length === 0, JSON.stringify(errors(submit).filter(e => e.method === 'Runtime.exceptionThrown').slice(0, 2)));
    const submittedGuide = await evaluate(submit, `(async () => {
      const res = await fetch('/api/wiki/guides/my', { credentials: 'same-origin' });
      const data = await res.json();
      return data.guides && data.guides[0];
    })()`);
    check('我的攻略接口返回浏览器投稿', !!(submittedGuide && submittedGuide.title === '浏览器投稿验证' && submittedGuide.status === 'pending'), JSON.stringify(submittedGuide || null));
    submit.close();

    const items = await openPage('/wiki/items/index.html');
    const itemCount = await evaluate(items, 'document.querySelectorAll(".tile").length');
    check('图鉴运行时渲染目录卡片', itemCount >= 80, String(itemCount));
    check('图鉴无脚本异常', errors(items).length === 0);
    items.close();

    const search = await openPage('/wiki/search/index.html?q=' + encodeURIComponent('龙宫宝珠'));
    const searchText = await evaluate(search, 'document.body.innerText');
    check('搜索“龙宫宝珠”返回结果', searchText.includes('龙宫宝珠'), searchText.slice(0, 300));
    const searchMs = await evaluate(search, `(() => { const t = performance.now(); for (let i = 0; i < 100; i++) window.Wiki.search('龙宫宝珠', 'all'); return performance.now() - t; })()`);
    check('全站搜索 100 次平均耗时低于 100ms', searchMs / 100 < 100, (searchMs / 100).toFixed(2) + 'ms');
    check('搜索无脚本异常', errors(search).length === 0);
    search.close();

    const grounds = await openPage('/wiki/grounds/index.html?ground=stillwater');
    const groundsText = await evaluate(grounds, 'document.body.innerText');
    check('钓点详情展示静水湖钓点', groundsText.includes('老旧码头') && groundsText.includes('芦苇浅滩') && groundsText.includes('深水区'), groundsText.slice(0, 300));
    check('钓点详情无脚本异常', errors(grounds).length === 0);
    grounds.close();

    const build = await openPage('/wiki/tools/build.html?ground=stillwater&spot=dock&base=rod_bamboo');
    const buildPreset = await evaluate(build, 'document.getElementById("current-result").innerText');
    check('配装链接预设底材与钓点', buildPreset.includes('钓速') && buildPreset.includes('8') && buildPreset.includes('2760 ms'), buildPreset);
    const share = await evaluate(build, `(async () => {
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
    check('配装方案码导出导入往返', share.length > 100 && share.text.includes('50') && share.text.includes('1500 ms'), JSON.stringify(share));
    const offline = await evaluate(build, `(async () => {
      window.fetch = function () { return Promise.reject(new Error('offline')); };
      await window.Wiki.refresh();
      return { status: document.getElementById('status-card').innerText, result: document.getElementById('current-result').innerText };
    })()`);
    check('规则失联后配装模拟器禁用', offline.status.includes('规则不可用') && offline.result.includes('数值与模拟器已禁用'), JSON.stringify(offline));
    check('配装模拟器无脚本异常', errors(build).length === 0);
    build.close();

    const smelt = await openPage('/wiki/tools/smelt.html');
    const smeltResult = await evaluate(smelt, `(async () => {
      const input = document.querySelector('[data-material="bait_pack"]');
      input.value = '1';
      input.dispatchEvent(new Event('change', { bubbles: true }));
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
    const adminWiki = await evaluate(admin, `(async () => {
      const button = Array.from(document.querySelectorAll('.nav-item')).find(x => x.textContent.includes('Wiki攻略'));
      if (button) button.click();
      await new Promise(r => setTimeout(r, 500));
      return {
        title: document.querySelector('main h2') && document.querySelector('main h2').innerText,
        meta: document.getElementById('wiki-meta') && document.getElementById('wiki-meta').innerText,
        cards: document.querySelectorAll('.wiki-card').length,
        json: document.getElementById('wiki-json') && document.getElementById('wiki-json').value.slice(0, 200)
      };
    })()`);
    check('管理后台 Wiki 官方编辑器可用', adminWiki.title && adminWiki.title.includes('Wiki 攻略管理') && adminWiki.cards > 0 && adminWiki.json.includes('guides'), JSON.stringify(adminWiki));
    check('管理后台 Wiki 页无脚本异常', errors(admin).filter(e => e.method === 'Runtime.exceptionThrown').length === 0, JSON.stringify(errors(admin).filter(e => e.method === 'Runtime.exceptionThrown').slice(0, 2)));
    const adminReviewVisible = await evaluate(admin, `document.getElementById('wiki-review-list').innerText`);
    check('管理后台显示待审核投稿', adminReviewVisible.includes('浏览器投稿验证') && adminReviewVisible.includes('待审核'), adminReviewVisible.slice(0, 300));

    const review = await evaluate(admin, `(async () => {
      const res = await fetch('/api/admin/wiki/guides/review', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'FishGame', 'X-Session-Mode': 'cookie' },
        body: JSON.stringify({ id: '${submittedGuide.id}', action: 'approve', expectedStatus: 'pending', note: '' })
      });
      return { status: res.status, data: await res.json().catch(() => ({})) };
    })()`);
    check('管理员通过浏览器投稿成功', review.status === 200 && review.data.guide && review.data.guide.status === 'approved', JSON.stringify(review || {}));
    const publicAfterReview = await openPage('/wiki/guides/index.html');
    const publicAfterReviewText = await evaluate(publicAfterReview, 'document.body.innerText');
    check('审核通过后玩家投稿公开可见', publicAfterReviewText.includes('浏览器投稿验证') && publicAfterReviewText.includes('Wiki User'), publicAfterReviewText.slice(0, 500));
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
      ['配装模拟器 360px 无横向溢出', '/wiki/tools/build.html?ground=stillwater&spot=dock&base=rod_bamboo'],
      ['熔炼模拟器 360px 无横向溢出', '/wiki/tools/smelt.html'],
      ['投稿页 360px 无横向溢出', '/wiki/guides/submit.html'],
    ]) {
      const mobile = await openPage(url);
      await mobile.send('Emulation.setDeviceMetricsOverride', { width: 360, height: 740, deviceScaleFactor: 2, mobile: true });
      await sleep(300);
      const overflow = await evaluate(mobile, 'document.documentElement.scrollWidth - window.innerWidth');
      check(name, overflow <= 1, 'overflow=' + overflow);
      mobile.close();
    }

    const buildFromSmelt = await openPage('/wiki/tools/build.html?ground=stillwater&spot=dock');
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

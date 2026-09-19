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
    stdio: ['ignore', 'ignore', 'pipe'],
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

    for (const [name, url] of [
      ['首页 360px 无横向溢出', '/wiki/'],
      ['配装模拟器 360px 无横向溢出', '/wiki/tools/build.html?ground=stillwater&spot=dock&base=rod_bamboo'],
      ['熔炼模拟器 360px 无横向溢出', '/wiki/tools/smelt.html'],
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

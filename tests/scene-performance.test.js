'use strict';
// Real Canvas/ResizeObserver regression checks; no server or player data required.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright-core');
const chrome = process.env.CHROME_PATH || [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find(p => fs.existsSync(p));

(async function () {
  const browser = await chromium.launch({ executablePath: chrome, headless: true });
  let pass = 0;
  try {
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.setContent('<div id="scene" style="width:1200px;height:180px;position:relative"></div>');
    await page.addStyleTag({ content: 'canvas {position:absolute;width:100%;height:100%}' });
    await page.evaluate(() => {
      window.nativeFrame = requestAnimationFrame.bind(window);
      window.pendingFrames = [];
      window.requestAnimationFrame = cb => pendingFrames.push(cb);
      window.clock = performance.now();
      window.step = count => {
        for (let i = 0; i < count; i++) {
          clock += 1000 / 60;
          const callbacks = pendingFrames.splice(0);
          callbacks.forEach(cb => cb(clock));
        }
      };
      window.settle = () => new Promise(resolve => nativeFrame(() => nativeFrame(resolve)));
      window.metrics = { reads: 0, resets: 0, gradients: 0, draws: 0 };
      const scene = document.getElementById('scene');
      const rect = scene.getBoundingClientRect.bind(scene);
      scene.getBoundingClientRect = () => { metrics.reads++; return rect(); };
      for (const key of ['width', 'height']) {
        const descriptor = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, key);
        Object.defineProperty(HTMLCanvasElement.prototype, key, {
          ...descriptor, set(value) { metrics.resets++; descriptor.set.call(this, value); },
        });
      }
      for (const [name, metric] of [['createLinearGradient', 'gradients'], ['drawImage', 'draws']]) {
        const original = CanvasRenderingContext2D.prototype[name];
        CanvasRenderingContext2D.prototype[name] = function (...args) {
          metrics[metric]++; return original.apply(this, args);
        };
      }
    });
    await page.addScriptTag({ path: path.join(__dirname, '../frontend/js/scene.js') });
    async function check(name, fn) {
      assert.equal(await page.evaluate(fn), true, name);
      pass++; console.log('  PASS  ' + name);
    }
    await page.evaluate(async () => {
      PxScene.mount(document.getElementById('scene'), 'rapids');
      await settle(); step(1);
      window.initialScene = document.getElementById('scene').__pxscene.sc;
      for (const key in metrics) metrics[key] = 0;
      step(120);
    });
    console.log('120 wide-screen frames:', await page.evaluate(() => metrics));
    await check('steady frames do not read layout, reset canvases or recreate gradients', () =>
      metrics.reads === 0 && metrics.resets === 0 && metrics.gradients === 0 && metrics.draws > 0);
    await check('clamped wide scene keeps particle and terrain identity', () =>
      document.getElementById('scene').__pxscene.sc === initialScene);
    await page.evaluate(async () => {
      document.getElementById('scene').style.width = '100px'; await settle(); step(1);
      window.narrowScene = document.getElementById('scene').__pxscene.sc;
      step(120);
    });
    await check('narrow scene clamps once and retains particles', () => {
      const inst = document.getElementById('scene').__pxscene;
      return inst.cv.width === 180 && inst.sc === narrowScene;
    });
    await page.evaluate(async () => {
      document.getElementById('scene').style.width = '500px'; await settle(); step(1);
    });
    await check('ResizeObserver updates buffer after container resize', () =>
      document.getElementById('scene').__pxscene.cv.width === 400);
    await page.evaluate(() => PxScene.update(document.getElementById('scene'), 'frostmoon'));
    await check('ground changes rebuild palette at the same size', () => {
      const inst = document.getElementById('scene').__pxscene;
      return inst.scenePid === 'frostmoon' && inst.sc.P.particle === 'snow';
    });
    await page.evaluate(async () => {
      document.getElementById('scene').style.display = 'none'; await settle();
      metrics.draws = 0; step(120);
    });
    await check('hidden scene performs no canvas draws', () => metrics.draws === 0);
    await page.evaluate(async () => {
      document.getElementById('scene').style.display = ''; await settle(); step(1);
    });
    await check('visible scene resumes rendering', () => metrics.draws > 0);
    await page.evaluate(() => {
      window.detached = document.getElementById('scene'); detached.remove(); step(1);
    });
    await check('removed scene stops scheduling and releases observers', () =>
      pendingFrames.length === 0 && !detached.__pxscene.observing);
    await page.evaluate(async () => {
      document.body.appendChild(detached); PxScene.mount(detached, 'rapids'); await settle(); step(1);
    });
    await check('remount restarts scene observers and rendering', () =>
      detached.__pxscene.observing && pendingFrames.length === 1);
    assert.deepEqual(errors, []);
    console.log(`通过 ${pass} 项，失败 0 项`);
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });

'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright-core');

test('gear filters, batch conversion limits and lost-response retry', async t => {
  const executablePath = process.env.CHROME_PATH || [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  ].find(fs.existsSync);
  const browser = await chromium.launch({ executablePath, headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  page.setDefaultTimeout(6000);
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.route('http://gear.test/', route => route.fulfill({ contentType: 'text/html', body: '<main id="gear"></main>' }));
  await page.goto('http://gear.test/');
  await page.evaluate(() => {
    const part = { main: 'speed', subs: ['skill'], mainValues: [1, 2], subValues: [0, 1] };
    const free = { coins: 0, items: {}, receipts: 0, heat: 0 };
    window.fixture = {
      config: { parts: { line: part, hook: part }, maxLevel: 1, subUnlock: 1, boundLevel: 1, engraveLevel: 1, mainEngrave: .1, subEngrave: .1, costs: { convert: free, upgrade: [free], tune: free, engrave: free, heatEngrave: free, transfer: free }, legacyConvertReceipts: { rare: 2 }, sets: { forge: { stages: [{ heatDiscount: 0 }] } } },
      state: { receipts: 20, tiers: {} },
      equipment: Array.from({ length: 102 }, (_, i) => ({ id: String(i + 1), name: '旧鱼线 ' + i, signature: 'gear_line_2#rare#spd+4', part: 'line', affixes: [{ type: 'speed', value: 4 }], locked: i === 101, bound: false })),
    };
    fixture.equipment.push({ id: '200', name: '已绑定鱼钩', signature: 'gear_hook_2#epic#skl+4', part: 'hook', affixes: [{ type: 'skill', value: 4 }], locked: false, bound: true });
    fixture.equipment.push({ id: '300', name: '新鱼线', signature: 'gear_line_1#common#spd+1@g0_none_0', part: 'line', affixes: [{ type: 'speed', value: 1 }], growth: { level: 0, engrave: 'none' }, locked: false, bound: false });
    window.GameData = { setGearSystem() {}, itemName: id => id };
    window.Engine = { state: {} };
    window.UI = { confirmModal: async () => true };
    window.calls = [];
    window.failNext = true;
    window.Net = { gearApi: async (method, url, body) => {
      if (method === 'GET') return { ok: true, data: fixture };
      calls.push(body);
      if (failNext) { failNext = false; throw new Error('lost response'); }
      fixture.equipment = fixture.equipment.filter(e => !body.ids.includes(e.id));
      return { ok: true, data: { result: { details: { count: body.ids.length } } } };
    } };
  });
  await page.addScriptTag({ path: path.resolve(__dirname, '../frontend/js/gear.js') });
  await page.evaluate(() => GearUI.mount(document.querySelector('#gear')));
  await page.locator('[data-gear-tab="legacy"]').click();
  await page.locator('[data-equipment-select="part"]').selectOption('hook');
  assert.equal(await page.locator('[data-batch-item]').count(), 1);
  await page.locator('[data-equipment-select="attribute"]').selectOption('speed');
  assert.equal(await page.locator('[data-batch-item]').count(), 0);
  await page.locator('[data-equipment-reset]').click();
  await page.locator('[data-equipment-select="part"]').selectOption('line');
  await page.locator('[data-batch-select]').click();
  assert.equal(await page.locator('[data-batch-item]:checked').count(), 100);
  assert.equal(await page.locator('[data-batch-item]:disabled').count(), 1);
  await page.locator('[data-batch-item="101"]').click();
  assert.match(await page.locator('.gear-notice').innerText(), /最多选择 100/);
  assert.equal(await page.locator('[data-batch-item]:checked').count(), 100);
  await page.locator('[data-gear-tab="growth"]').click();
  await page.locator('[data-gear-tab="legacy"]').click();
  assert.equal(await page.locator('[data-batch-item]:checked').count(), 100);
  await page.locator('[data-batch-convert]').click();
  await page.waitForFunction(() => document.querySelector('.gear-notice').textContent.includes('请重试'));
  await page.locator('[data-batch-convert]').click();
  await page.waitForFunction(() => document.querySelector('.gear-notice').textContent.includes('已批量转换 100'));
  const calls = await page.evaluate(() => window.calls);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].requestKey, calls[1].requestKey);
  assert.deepEqual(calls[0].ids, calls[1].ids);
  assert.equal(calls[0].ids.length, 100);
  assert.ok(!calls[0].ids.includes('102'));
  assert.deepEqual(errors, []);
});

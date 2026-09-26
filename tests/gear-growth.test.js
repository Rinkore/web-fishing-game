'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright-core');

test('workshop grows equipped components, lists them first and retries the same request', async t => {
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
    const free = { coins: 0, items: {}, receipts: 0, heat: 0, cores: 0 };
    window.fixture = {
      config: {
        parts: { line: part, hook: part }, maxLevel: 1, subUnlock: 1, boundLevel: 1, engraveLevel: 1,
        mainEngrave: .1, subEngrave: .1, receiptHours: 8,
        costs: { upgrade: [free], tune: free, engrave: free, heatEngrave: free, transfer: free, preset: free, unlock: free, stage: [free] },
        sets: { forge: { stages: [{ heatDiscount: 0 }] } },
      },
      state: { receipts: 20, heat: 0, tiers: {} },
      equipment: [
        { id: '1', name: '普通鱼线', signature: 'gear_line_1#common#spd+1@g0_none_0', part: 'line', affixes: [{ type: 'speed', value: 1 }], growth: { level: 0, engrave: 'none', presets: 0 }, locked: false, bound: false },
        { id: '2', name: '已装备鱼钩', signature: 'gear_hook_1#common#skl+1@g0_none_0', part: 'hook', affixes: [{ type: 'skill', value: 1 }], growth: { level: 0, engrave: 'none', presets: 0 }, locked: true, bound: false },
      ],
      rewardBindings: {},
    };
    window.GameData = { setGearSystem() {}, itemName: id => id };
    window.Engine = { state: {} };
    window.UI = { confirmModal: async () => true, setView() {}, renderNav() {}, renderView() {} };
    window.calls = [];
    window.failNext = true;
    window.Net = { gearApi: async (method, url, body) => {
      if (method === 'GET') return { ok: true, data: fixture };
      calls.push(body);
      if (failNext) { failNext = false; throw new Error('lost response'); }
      return { ok: true, data: { result: { details: { id: '77' } } } };
    }, fetchChest() {} };
  });
  await page.addScriptTag({ path: path.resolve(__dirname, '../frontend/js/gear.js') });
  await page.evaluate(() => GearUI.mount(document.querySelector('#gear')));
  // 旧制转换页签已删除：工坊只剩装备成长 / 钓鱼套装。
  assert.equal(await page.locator('[data-gear-tab="legacy"]').count(), 0);
  assert.equal(await page.locator('[data-gear-tab]').count(), 2);
  await page.locator('[data-pick-card="open"]').first().click();
  const picker = page.locator('.gear-pick-modal');
  await picker.waitFor();
  assert.equal(await picker.locator('[data-pick-item]').first().getAttribute('data-pick-item'), '2');
  assert.match(await picker.locator('[data-pick-item="2"]').innerText(), /已装备/);
  await picker.locator('[data-pick-item="2"]').click();
  assert.match(await page.locator('.gear-pick-card.is-picked').innerText(), /已装备鱼钩/);
  assert.equal(await page.locator('.gear-caption', { hasText: '已装配在钓竿上' }).count(), 1);
  const upgrade = page.locator('[data-action="upgrade"]');
  assert.equal(await upgrade.isDisabled(), false);
  await upgrade.click();
  await page.waitForFunction(() => document.querySelector('.gear-notice').textContent.includes('请重试'));
  await upgrade.click();
  await page.waitForFunction(() => document.querySelector('.gear-notice').textContent.includes('操作完成'));
  const calls = await page.evaluate(() => window.calls);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].action, 'upgrade');
  assert.equal(calls[0].id, '2');
  assert.equal(calls[0].requestKey, calls[1].requestKey);
  assert.deepEqual(calls[0], calls[1]);
  assert.deepEqual(errors, []);
});

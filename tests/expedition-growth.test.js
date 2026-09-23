'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright-core');

const root = path.resolve(__dirname, '../frontend');

test('independent voyage specializations and fishing equipment', async t => {
  const executablePath = process.env.CHROME_PATH || [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  ].find(fs.existsSync);
  const browser = await chromium.launch({ executablePath, headless: true });
  t.after(() => browser.close());

  async function fixture() {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    page.setDefaultTimeout(6000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('http://voyage.test/**', route => {
      const name = new URL(route.request().url()).pathname;
      const file = path.join(root, name === '/' ? 'index.html' : name);
      if (!fs.existsSync(file)) return route.fulfill({ status: 404, body: '' });
      if (file.endsWith('index.html')) return route.fulfill({
        contentType: 'text/html',
        body: fs.readFileSync(file, 'utf8').replace('window.Engine.init();', '').replace('window.UI.init();', ''),
      });
      return route.fulfill({ path: file });
    });
    await page.goto('http://voyage.test/');
    await page.evaluate(() => {
      document.querySelector('#auth').remove();
      document.body.innerHTML = '<main id="main"><div class="expedition-panel"></div></main>';
      const D = GameData;
      const config = JSON.parse(JSON.stringify(D.GEAR_SYSTEM));
      config.enabled = true;
      // Published legacy costs may still contain cores; independent specializations must ignore them.
      config.costs.unlock = { coins: 1234, receipts: 2, items: {}, cores: 2 };
      config.costs.stage[0] = { coins: 2345, receipts: 3, items: {}, cores: 2 };
      D.setGearSystem(config);
      window.growthFixture = { config, state: {
        selected: 'tide', focus: '', voyageMode: 'normal', unlocked: { tide: true },
        tiers: { tide: 0 }, receipts: 20, receiptRemainder: 1,
      }, equipment: [] };
      window.seaFixture = { ship: { lv: 5 }, deepscale: 50, expedition: {
        captain: { marks: 200, starter: 1 }, config: D.EXPEDITION, sets: D.GEAR_SETS,
        freeTrades: 3, active: null, last: null,
      } };
      window.calls = [];
      window.confirmations = [];
      window.allowConfirm = true;
      window.failNext = false;
      Engine.state.unboundInputs = false;
      UI.confirmModal = async options => { confirmations.push(options); return allowConfirm; };
      Net.gearApi = async (method, url, body) => {
        calls.push({ method, url, body });
        if (method === 'GET') return { ok: true, data: growthFixture };
        if (failNext) { failNext = false; throw new Error('simulated lost response'); }
        if (body.action === 'unlock') growthFixture.state.unlocked[body.set] = true;
        if (body.action === 'stage') growthFixture.state.tiers[body.set] = (growthFixture.state.tiers[body.set] || 0) + 1;
        return { ok: true, data: growthFixture };
      };
      Net.seaExpedition = async (type, body) => {
        calls.push({ type, body });
        if (type === 'start') seaFixture.expedition.active = {
          id: 'test-voyage', route: body.route, hours: body.hours, endsAt: Date.now() + 60000,
          ready: false, snapshot: { set: body.set, stage: 0, success: 100 },
        };
        if (type === 'claim') { seaFixture.expedition.last = seaFixture.expedition.active; seaFixture.expedition.active = null; }
        return { ok: true, data: { sea: seaFixture } };
      };
      window.renderVoyage = () => ExpeditionUI.update(document.querySelector('.expedition-panel'), seaFixture, next => { seaFixture = next; renderVoyage(); });
      renderVoyage();
    });
    await page.locator('[data-voyage-tab="specializations"]').waitFor();
    return { page, errors };
  }

  await t.test('four specializations are separate from four fishing sets and show material costs', async () => {
    const { page, errors } = await fixture();
    try {
      await page.locator('[data-voyage-tab="specializations"]').click();
      assert.equal(await page.locator('.voyage-specializations > article').count(), 4);
      assert.equal(await page.locator('[data-redeem]').count(), 0);
      assert.match(await page.locator('[data-unlock="storm"]').locator('..').innerText(), /1234 金币.*航程凭证 × 2/);
      assert.doesNotMatch(await page.locator('.voyage-card-action').allInnerTexts().then(x => x.join('\n')), /重复核心/);
      await page.locator('[data-voyage-tab="sets"]').click();
      assert.equal(await page.locator('.voyage-specializations > article').count(), 4);
      const ids = await page.locator('[data-redeem]').evaluateAll(nodes => [...new Set(nodes.map(n => n.dataset.redeem))].sort());
      assert.deepEqual(ids, ['apex', 'forge', 'harvest', 'research']);
      assert.equal(await page.locator('[data-redeem]').count(), 8, 'two equipment parts for each of four sets');
      assert.equal(await page.locator('[data-unlock]').count(), 0);
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });

  await t.test('unlock and advance use the gear endpoint, preserve source, and retry with one request key', async () => {
    const { page, errors } = await fixture();
    try {
      await page.locator('[data-voyage-tab="specializations"]').click();
      await page.locator('[data-reward-source]').selectOption('free');
      await page.evaluate(() => { failNext = true; });
      await page.locator('[data-unlock="storm"]').click();
      await page.waitForFunction(() => document.querySelector('.gear-notice').textContent.includes('连接未完成'));
      assert.equal(await page.locator('[data-unlock="storm"]').isEnabled(), true);
      await page.locator('[data-unlock="storm"]').click();
      await page.locator('[data-stage="storm"]').waitFor();
      const attempts = await page.evaluate(() => calls.filter(x => x.method === 'POST'));
      assert.equal(attempts.length, 2);
      assert.equal(attempts[0].url, '/api/gear/action');
      assert.equal(attempts[0].body.action, 'unlock');
      assert.equal(attempts[0].body.set, 'storm');
      assert.equal(attempts[0].body.unboundInputs, true);
      assert.equal(attempts[0].body.requestKey, attempts[1].body.requestKey);
      assert.ok(attempts[0].body.requestKey);
      assert.equal('cores' in attempts[0].body, false);
      await page.locator('[data-stage="storm"]').click();
      await page.waitForFunction(() => growthFixture.state.tiers.storm === 1);
      const advance = await page.evaluate(() => calls.filter(x => x.method === 'POST').at(-1));
      assert.equal(advance.body.action, 'stage');
      assert.notEqual(advance.body.requestKey, attempts[1].body.requestKey);
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });

  await t.test('dispatch drafts survive menu changes, refreshes and host replacement', async () => {
    const { page, errors } = await fixture();
    try {
      await page.locator('[data-hours]').selectOption('12');
      await page.locator('[data-voyage-tab="configuration"]').click();
      await page.locator('[data-focus]').selectOption('storm_relic');
      await page.locator('[data-config-save]').click();
      await page.waitForFunction(() => !document.querySelector('[data-config-save]').disabled);
      await page.locator('[data-voyage-tab="history"]').click();
      await page.locator('[data-spec-refresh]').click();
      await page.waitForFunction(() => !document.querySelector('[data-spec-refresh]').disabled);
      await page.evaluate(() => {
        document.querySelector('.expedition-panel').replaceWith(Object.assign(document.createElement('div'), { className: 'expedition-panel' }));
        renderVoyage();
      });
      assert.equal(await page.locator('[data-voyage-tab="history"]').getAttribute('aria-pressed'), 'true');
      await page.locator('[data-voyage-tab="dispatch"]').click();
      assert.equal(await page.locator('[data-hours]').inputValue(), '12');
      assert.match(await page.locator('.voyage-saved-config').first().textContent(), /潮汐采集/);
      assert.match(await page.locator('.voyage-saved-config').first().textContent(), /风暴遗物/);
      await page.evaluate(() => { allowConfirm = false; });
      await page.locator('[data-start="trade"]').click();
      assert.equal(await page.evaluate(() => calls.filter(x => x.type === 'start').length), 0);
      await page.evaluate(() => { allowConfirm = true; });
      await page.locator('[data-start="trade"]').click();
      await page.locator('.voyage-current').waitFor();
      const departure = await page.evaluate(() => calls.find(x => x.type === 'start').body);
      assert.equal(departure.hours, 12);
      assert.equal(departure.useSaved, true);
      assert.equal(departure.set, undefined);
      assert.equal(departure.focus, undefined);
      assert.equal(await page.locator('[data-start]:enabled').count(), 0);
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });

  await t.test('returned rewards remain accessible from every submenu and cards fit mobile', async () => {
    const { page, errors } = await fixture();
    try {
      await page.evaluate(() => {
        seaFixture.expedition.active = { id: 'ready-voyage', route: 'trade', hours: 8, endsAt: Date.now(), ready: true,
          snapshot: { set: 'tide', stage: 0, success: 100 }, reward: { event: '平安返航', coins: 100, xp: 5, marks: 5, items: {} } };
        renderVoyage();
      });
      await page.setViewportSize({ width: 390, height: 844 });
      for (const tab of ['dispatch', 'specializations', 'sets', 'history']) {
        await page.locator('[data-voyage-tab="' + tab + '"]').click();
        assert.equal(await page.locator('[data-claim]').isVisible(), true, tab + ' retains claim action');
        assert.equal(await page.locator('.expedition-panel').evaluate(el => el.scrollWidth <= el.clientWidth + 1), true, tab + ' fits mobile');
      }
      await page.locator('[data-claim]').click();
      await page.waitForFunction(() => !seaFixture.expedition.active);
      assert.equal(await page.evaluate(() => calls.filter(x => x.type === 'claim').length), 1);
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });
});

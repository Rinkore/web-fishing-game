'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright-core');
const root = path.resolve(__dirname, '../frontend');
let count = 0;
function check(name, value) { assert.ok(value, name); count++; console.log('PASS ' + name); }

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1366, height: 900 } });
    await context.route('http://auto-build.test/**', route => {
      const pathname = new URL(route.request().url()).pathname;
      const file = path.join(root, pathname === '/' ? 'index.html' : pathname);
      if (!fs.existsSync(file)) return route.fulfill({ status: 404, body: '' });
      if (file.endsWith('index.html')) return route.fulfill({ contentType: 'text/html', body: fs.readFileSync(file, 'utf8').replace('window.Engine.init();', '').replace('window.UI.init();', '') });
      return route.fulfill({ path: file });
    });
    const page = await context.newPage();
    page.setDefaultTimeout(6000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto('http://auto-build.test/');
    await page.evaluate(() => {
      document.querySelector('#auth').remove();
      const D = GameData;
      const item = (base, type, value) => D.instanceId(base, 'common', [{ type, value }]);
      const ids = {
        oldRod: item('set_forge_rod', 'speed', 3), oldCharm: item('set_forge_charm', 'skill', 2),
        rod: item('set_harvest_rod', 'double', 3), charm: item('set_harvest_charm', 'skill', 2),
        oldLine: item('line_nylon', 'resonance', 3), oldBait: item('gear_bait_3', 'resonance', 3),
        line: D.gearSignature('gear_line_1', 8, 'speed', 'main', 0),
        accessory: item('gear_accessory_2', 'resonance', 5),
      };
      const bd = {};
      D.ROD_PARTS.forEach(p => { bd[p.key] = { compId: null }; });
      bd.rod.compId = ids.oldRod; bd.charm.compId = ids.oldCharm;
      bd.line.compId = ids.oldLine; bd.bait.compId = ids.oldBait;
      window.fixture = {
        ids, calls: [], rejected: [], syncs: 0, failSync: false,
        profile: { bd, inventory: { [ids.rod]: 1, [ids.charm]: 1, [ids.line]: 1, [ids.accessory]: 1 }, invRev: 1 },
      };
      const clone = x => JSON.parse(JSON.stringify(x));
      Net.getMe = () => ({ token: 'fixture-token' });
      Net.fetchMe = async () => {
        fixture.syncs++;
        if (fixture.failSync) { fixture.failSync = false; throw new Error('offline'); }
        return { ok: true, data: clone(fixture.profile) };
      };
      Net.bdSet = async (part, id) => {
        fixture.calls.push({ part, id: id || null });
        const profile = fixture.profile, next = clone(profile.bd);
        next[part] = { compId: id || null };
        const comps = Object.values(next).map(x => D.componentOf(x.compId)).filter(Boolean);
        const sets = new Set(comps.filter(x => x.setId).map(x => x.setId));
        const resonance = comps.filter(x => !x.setId && x.affixes.some(a => a.type === 'resonance')).length;
        if (sets.size > 1 || resonance > 2 || (id && !(profile.inventory[id] > 0))) {
          fixture.rejected.push({ part, id });
          return { ok: false, data: { error: 'illegal transitional loadout' } };
        }
        const old = profile.bd[part].compId;
        if (old) profile.inventory[old] = (profile.inventory[old] || 0) + 1;
        if (id && --profile.inventory[id] === 0) delete profile.inventory[id];
        profile.bd = next; profile.invRev++;
        return { ok: true, data: clone(profile) };
      };
      Engine.applyProfile(clone(fixture.profile));
      UI.setView('bd'); UI.renderView();
    });
    await page.locator('.ab-open-btn').click();
    await page.waitForFunction(() => fixture.syncs >= 1);
    const modal = page.locator('.ab-modal');
    check('Owned complete set is selectable', await modal.locator('.ab-set-choice option[value="harvest"]').count() === 1);
    await modal.locator('.ab-set-choice').selectOption('harvest');
    const ids = await page.evaluate(() => fixture.ids);
    await modal.getByLabel('固定' + await page.evaluate(() => GameData.ROD_PARTS.find(p => p.key === 'line').name), { exact: true }).selectOption(ids.line);
    await modal.getByLabel('固定' + await page.evaluate(() => GameData.ROD_PARTS.find(p => p.key === 'bait').name), { exact: true }).selectOption('');
    await modal.getByLabel('固定' + await page.evaluate(() => GameData.ROD_PARTS.find(p => p.key === 'accessory').name), { exact: true }).selectOption(ids.accessory);
    check('Fixed choices produce an applicable plan', await modal.locator('.ab-apply').isEnabled());

    await page.evaluate(() => { fixture.failSync = true; });
    await modal.locator('.ab-apply').click();
    await page.waitForFunction(() => fixture.syncs >= 2 && document.querySelector('.ab-apply').disabled === false);
    check('Failed profile synchronization sends no equipment mutation and allows retry', await page.evaluate(() => fixture.calls.length === 0));
    await modal.locator('.ab-apply').click();
    await page.waitForFunction(() => fixture.profile.bd.rod.compId === fixture.ids.rod && fixture.profile.bd.charm.compId === fixture.ids.charm && fixture.profile.bd.accessory.compId === fixture.ids.accessory && fixture.profile.bd.line.compId === fixture.ids.line);
    check('Core switch and resonance replacement never produce an illegal intermediate loadout', await page.evaluate(() => fixture.rejected.length === 0));
    check('All releases precede installations and fixed empty bait is unequipped', await page.evaluate(() => {
      const firstEquip = fixture.calls.findIndex(x => x.id);
      const releases = fixture.calls.slice(0, firstEquip);
      return ['rod', 'charm', 'line', 'bait'].every(part => releases.some(x => x.part === part && x.id === null)) && fixture.profile.bd.bait.compId === null;
    }));
    check('Selected grown accessory and complete set are applied exactly', await page.evaluate(() => ['rod', 'charm', 'line', 'accessory'].every(part => fixture.profile.bd[part].compId === fixture.ids[part])));

    await modal.locator('.modal-close').click();
    await page.evaluate(() => {
      const id = GameData.instanceId('rod_bamboo', 'common', [{ type: 'speed', value: 10 }]);
      fixture.profile.bd.rod.compId = id;
      fixture.profile.bd.charm.compId = null;
      fixture.profile.invRev++;
      fixture.calls = [];
      Engine.applyProfile(JSON.parse(JSON.stringify(fixture.profile)));
      UI.renderView();
    });
    await page.locator('.ab-open-btn').click();
    check('Default mode preserves an ordinary legacy rod', await page.evaluate(() => {
      const st = Engine.state;
      const options = GameData.autoBuildOptions(st, { set: 'current' });
      return !options.error && options.candidates.rod[0] === st.bd.rod.compId;
    }));
    check('No browser script errors', errors.length === 0);
  } finally { await browser.close(); }
  console.log('通过 ' + count + ' 项，失败 0 项');
})().catch(error => { console.error(error); process.exitCode = 1; });

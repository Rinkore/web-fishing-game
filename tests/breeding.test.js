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
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await context.route('http://breeding.test/**', route => {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname.startsWith('/api')) return route.fulfill({ status: 503, contentType: 'application/json', body: '{}' });
      const file = path.join(root, pathname === '/' ? 'index.html' : pathname);
      if (!fs.existsSync(file)) return route.fulfill({ status: 404, body: '' });
      if (file.endsWith('index.html')) return route.fulfill({ contentType: 'text/html', body: fs.readFileSync(file, 'utf8').replace('window.Engine.init();', '').replace('window.UI.init();', '') });
      return route.fulfill({ path: file });
    });
    const page = await context.newPage();
    page.setDefaultTimeout(8000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto('http://breeding.test/');
    await page.evaluate(() => {
      document.querySelector('#auth').remove();
      Engine.state.me = { name: 'tester', admin: false };
      Engine.state.features = {};
      Net.fetchHouse = async () => ({ ok: true, data: { house: null } });
      const traits = (id, size) => {
        const out = {};
        ['body', 'head', 'dorsal', 'ventral', 'tail', 'skin'].forEach(locus => {
          out[locus] = { alleles: [id, id], winner: id, source: id, dominant: id, mode: 'complete_dominance', zygosity: 'homozygous', carrier: false, hidden: false };
        });
        out.size = { alleles: [size, size], winner: size, source: size, dominant: size, mode: 'complete_dominance', zygosity: 'homozygous', carrier: false, hidden: false };
        out.albino = { alleles: ['A', 'A'], winner: 'A', source: 'A', dominant: 'A', mode: 'recessive', zygosity: 'homozygous', carrier: false, hidden: false };
        out.star = { alleles: ['S', 'S'], winner: 'S', source: 'S', dominant: 'S', mode: 'recessive', zygosity: 'homozygous', carrier: false, hidden: false };
        out.veil = { alleles: ['v', 'v'], winner: 'v', source: 'v', dominant: 'v', mode: 'dominant', zygosity: 'homozygous', carrier: false, hidden: false };
        out.glow = { alleles: ['g', 'g'], winner: 'g', source: 'g', dominant: 'g', mode: 'dominant', zygosity: 'homozygous', carrier: false, hidden: false };
        [['crimson','R'],['golden','Y'],['azure','B'],['melanic','D'],['opal','O']].forEach(([locus,wild]) => {
          out[locus] = { alleles: [wild,wild], winner: wild, source: wild, dominant: wild, mode: 'recessive', zygosity: 'homozygous', carrier: false, hidden: false };
        });
        return out;
      };
      const fish = (id, species, generation) => ({ id, species, generation, parents: generation ? ['1', '2'] : ['', ''], genes: {}, mutations: [], active: true, bornAt: 1, referenceSha256: 'abcdef0123456789', phenotype: { body: species, size: 'normal', traits: traits(species, 'normal'), mutations: {}, colors: {}, referenceExact: true, referenceSha256: 'abcdef0123456789' } });
      window.makeBreedFish = fish;
      window.breedView = { fish: [fish('1', 'koi', 0), fish('2', 'koi', 0), fish('3', 'bass', 0), fish('4', 'koi', 3)], stock: [{ species: 'koi', tier: 'normal', quantity: 2 }], reagents: { gene_star: 1, gene_prism: 1 }, reagentPrices: {gene_albino:1500,gene_star:1500,gene_veil:1800,gene_glow:1800,gene_prism:2200}, capacity: 60, breedCost: 100, mutationRate: .01 };
      window.breedCalls = [];
      window.failBreed = false;
      Net.breedingGet = async () => ({ ok: true, status: 200, data: { ok: true, breeding: window.breedView } });
      Net.breedingAction = async body => {
        breedCalls.push(body);
        if (window.failBreed) return { ok: false, status: 0, data: {} };
        if (body.action === 'breed' && !breedView.fish.some(x => x.id === '5')) breedView.fish.push(fish('5', 'koi', 1));
        if (body.action === 'breed' && body.id === '4' && !breedView.fish.some(x => x.id === '7')) breedView.fish.push(fish('7', 'koi', 4));
        if (body.itemId && body.action === 'breed') breedView.reagents[body.itemId]--;
        if (body.action === 'buy_reagent') breedView.reagents[body.itemId] = (breedView.reagents[body.itemId] || 0) + 1;
        return { ok: true, status: 200, data: { ok: true, breeding: breedView, result: { status: body.action === 'breed' ? 'offspring_born' : 'founder_added' } } };
      };
      UI.setView('character');
      UI.renderView();
    });

    const host = page.locator('.char-view');
    await host.locator('[data-sectiontab="breeding"]').click();
    await host.locator('.breed-system .breed-reference-seal').first().waitFor();
    check('Breeding is a first-class fish-house tab', await host.locator('[data-sectiontab="breeding"].on').count() === 1);
    check('Generation-zero parent is rebuilt from exact reference layers', await host.locator('.breed-layer-skin[src="assets/genetics/koi-skin.png"]').count() >= 1 && await host.locator('.breed-reference-seal').first().innerText() === '参考图一致');
    await host.locator('[data-pick="A"][data-id="1"]').click();
    check('Inspector distinguishes structural, size, five hidden colour and mutation loci', await host.locator('.breed-genes tbody tr').count() === 16 && await host.locator('.breed-genes').innerText().then(text => text.includes('纯合') && text.includes('体型骨架') && text.includes('绯红色素') && text.includes('白化红眼')));

    await host.locator('[data-pick="B"][data-id="2"]').click();
    check('Same-species parents are accepted', await host.locator('[data-breed]').isEnabled() && await host.locator('.breed-pair-status').innerText().then(text => text.includes('锦鲤')));

    await page.evaluate(() => { window.failBreed = true; });
    await host.locator('[data-breed]').click();
    await page.waitForFunction(() => breedCalls.length === 1);
    await page.evaluate(() => { window.failBreed = false; });
    await host.locator('[data-breed]').click();
    await page.waitForFunction(() => breedCalls.length === 2 && breedView.fish.length === 5);
    check('Transport retry reuses the same idempotency key', await page.evaluate(() => breedCalls[0].requestKey === breedCalls[1].requestKey));
    check('Successful breeding adds a generation-one offspring', await host.locator('.breed-pool').innerText().then(text => text.includes('第 1 代')));

    await host.locator('[data-pick="B"][data-id="3"]').click();
    check('Unlisted cross-species pairing is blocked', await host.locator('[data-breed]').isDisabled() && await host.locator('.breed-pair-status').innerText().then(text => text.includes('白名单')));
    await host.locator('[data-pick="A"][data-id="4"]').click();
    await host.locator('[data-pick="B"][data-id="2"]').click();
    check('Third generation can produce a fourth', await host.locator('[data-breed]').isEnabled() && await host.locator('[data-breed]').innerText().then(text => text.includes('第 4 代')));
    await host.locator('[data-reagent="gene_star"]').click();
    await host.locator('[data-breed]').click();
    await page.waitForFunction(() => breedCalls.length === 3 && breedView.fish.some(x => x.id === '7'));
    check('Directed reagent is sent once and fourth generation enters the pool', await page.evaluate(() => breedCalls[2].itemId === 'gene_star' && breedCalls[2].id === '4') && await host.locator('.breed-pool').innerText().then(text => text.includes('第 4 代')));
    await host.locator('[data-reagent="gene_prism"]').click();
    await host.locator('[data-color-target]').selectOption('azure');
    check('Prism reagent offers five selectable hidden colour loci', await host.locator('[data-color-target] option').count() === 5 && await host.locator('[data-color-target]').inputValue() === 'azure');
    await host.locator('[data-buy-reagent="gene_albino"]').click();
    await page.waitForFunction(() => breedCalls.length === 4);
    check('A directed reagent can be bought within the breeding room', await page.evaluate(() => breedCalls[3].action === 'buy_reagent' && breedCalls[3].itemId === 'gene_albino') && await host.locator('[data-reagent="gene_albino"]').isEnabled());

    await page.evaluate(() => {
      const hybrid = makeBreedFish('6', 'koi', 1);
      hybrid.phenotype.referenceExact = false;
      ['skin', 'dorsal', 'tail'].forEach(locus => {
        hybrid.phenotype.traits[locus] = { alleles: ['koi', 'carp'], winner: 'carp', source: 'carp', dominant: 'carp', recessive: 'koi', mode: 'complete_dominance', zygosity: 'heterozygous', carrier: true, hidden: false };
      });
      breedView.fish.push(hybrid);
      BreedUI.mount(document.querySelector('.char-view'));
    });
    await host.locator('.breed-pool [data-fish-id="6"] .breed-hybrid-ready').waitFor();
    const pixels = await page.evaluate(async () => {
      const art = document.querySelector('.breed-pool [data-fish-id="6"] canvas');
      const actual = art.getContext('2d').getImageData(0, 0, art.width, art.height).data;
      const reference = new Image();
      reference.src = 'assets/fish/koi.png';
      await reference.decode();
      const canvas = document.createElement('canvas');
      canvas.width = art.width; canvas.height = art.height;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(reference, 0, 0);
      const base = ctx.getImageData(0, 0, art.width, art.height).data;
      let changed = 0, gentle = 0, silhouette = true;
      for (let i = 0; i < actual.length; i += 4) {
        if (actual[i + 3] !== base[i + 3]) silhouette = false;
        if (!base[i + 3]) continue;
        const difference = Math.abs(actual[i] - base[i]) + Math.abs(actual[i + 1] - base[i + 1]) + Math.abs(actual[i + 2] - base[i + 2]);
        if (difference > 2) changed++;
        if (difference > 2 && difference < 60) gentle++;
      }
      return { changed, gentle, silhouette, width: art.width, height: art.height };
    });
    check('Hybrid traits blend inside the body silhouette with intermediate seam colours', pixels.silhouette && pixels.width === 220 && pixels.height === 130 && pixels.changed > 20 && pixels.gentle > 10);
    await page.evaluate(() => {
      const coloured = makeBreedFish('8', 'koi', 5);
      coloured.phenotype.referenceExact = false;
      coloured.phenotype.colors.crimson = true;
      coloured.phenotype.traits.crimson = { alleles: ['r', 'r'], winner: 'r', source: 'r', dominant: 'r', mode: 'recessive', zygosity: 'homozygous', carrier: false, hidden: false };
      breedView.fish.push(coloured);
      BreedUI.mount(document.querySelector('.char-view'));
    });
    await host.locator('.breed-pool [data-fish-id="8"] .breed-hybrid-ready').waitFor();
    check('Expressed colour gene has a real texture and preserves the fish silhouette', await page.evaluate(async () => {
      const canvas = document.querySelector('.breed-pool [data-fish-id="8"] canvas');
      const actual = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
      const base = new Image(); base.src = 'assets/fish/koi.png'; await base.decode();
      const source = document.createElement('canvas'); source.width = canvas.width; source.height = canvas.height;
      const ctx = source.getContext('2d'); ctx.drawImage(base, 0, 0);
      const original = ctx.getImageData(0, 0, source.width, source.height).data;
      let changed = 0;
      for (let i = 0; i < actual.length; i += 4) {
        if (actual[i + 3] !== original[i + 3]) return false;
        if (original[i + 3] && Math.abs(actual[i] - original[i]) > 12) changed++;
      }
      return changed > 50;
    }));
    if (process.env.FISHING_BREEDING_SCREENSHOT) {
      fs.mkdirSync(path.dirname(process.env.FISHING_BREEDING_SCREENSHOT), { recursive: true });
      await host.locator('.breed-pool [data-fish-id="6"]').screenshot({ path: process.env.FISHING_BREEDING_SCREENSHOT });
      await host.locator('.breed-pool [data-fish-id="8"]').screenshot({ path: path.join(path.dirname(process.env.FISHING_BREEDING_SCREENSHOT), 'colour-'+path.basename(process.env.FISHING_BREEDING_SCREENSHOT)) });
    }
    check('No browser script errors', errors.length === 0);
    console.log('通过 ' + count + ' 项，失败 0 项');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); console.log('通过 ' + count + ' 项，失败 1 项'); process.exitCode = 1; });

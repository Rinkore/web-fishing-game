'use strict';
/*
 * 后台「装备与套装」面板的编辑体验回归。
 *
 * 覆盖的是 v0.22.0 之后新增的编辑能力（此前只有整页表单，没有任何自动化覆盖）：
 *   1. 变更摘要：改动后计数 / 保存按钮文案 / 改动字段高亮 / 撤销回到零变更
 *   2. 本地预检：越界值不发请求、标红到具体字段
 *   3. 等级联动：改「最高强化等级」后自动把成长数组与逐级消耗补到正确长度再提交
 *   4. 专精配置：认证勾选驱动点数可编辑、合计超 3 点被拦
 * 用真实 catalog 的 GEAR_SYSTEM 当夹具，避免自造夹具与线上配置漂移。
 */
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const { chromium } = require('playwright-core');
const root = path.resolve(__dirname, '../frontend');

(async () => {
  const catalog = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../server-go/internal/rules/catalog.json'), 'utf8'));
  const cfg = catalog.constants.GEAR_SYSTEM;
  const materialIds = new Set();
  Object.values(cfg.costs).forEach(c => (Array.isArray(c) ? c : [c]).forEach(x => Object.keys((x && x.items) || {}).forEach(id => materialIds.add(id))));
  Object.values(cfg.baseDrops || {}).forEach(items => Object.keys(items).forEach(id => materialIds.add(id)));
  const items = Array.from(materialIds).map(id => ({ id, name: id, kind: 'material' }))
    .concat([{ id: 'crucian', name: '鲫鱼', kind: 'fish' }]);
  const state = {
    tiers: Object.fromEntries(Object.keys({ ...cfg.sets, ...cfg.specializations }).map(id => [id, 0])),
    unlocked: Object.fromEntries(Object.keys(cfg.specializations).map(id => [id, false])),
    receipts: 5, receiptRemainder: 3, heat: 0, heatMs: 0, harvest: 0, tracking: 0, archaeologyHours: 0,
    allocations: {}, selected: '', focus: '', voyageMode: '', recent: [],
  };

  const html = `<!doctype html><html><head><meta charset="utf-8"><title>gear panel</title></head><body><div id="main"></div>
<script>
window.GearUI = {
  esc: s => String(s==null?'':s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])),
  labels: {speed:'钓速',skill:'技巧',double:'双钓',size:'体型',rod:'竿身',charm:'饰品',material:'材料',settle:'结算',stability:'稳定',resonance:'共鸣',copies:'件数',best:'保底',queue:'队列'},
  option: (v,t,sel) => '<option value="'+v+'"'+(sel?' selected':'')+'>'+t+'</option>'
};
window.GameData = { setGearSystem(){}, AFFIX_LABEL: {} };
</script>
<script src="/js/admin-edit.js"></script>
<script src="/js/admin-gear.js"></script>
<script src="/js/admin-operations.js"></script>
<script>
window.__calls = [];
window.__confirm = true;
window.__api = async (method, url, body) => {
  window.__calls.push({ method, url, body });
  if (url === '/api/admin/gear') return { ok: true, data: { config: window.__cfg, revision: 7, items: window.__items } };
  if (url.indexOf('/api/admin/gear?target=') === 0) return { ok: true, data: { player: { state: window.__state } } };
  if (url === '/api/admin/gear/config') return { ok: true, data: { ok: true } };
  if (url === '/api/admin/gear/player') return { ok: true, data: { ok: true } };
  return { ok: false, data: { error: '测试未启用' } };
};
window.__boot = () => window.AdminGear.render(document.querySelector('#main'), window.__api, async () => window.__confirm);
window.__nav = [];
window.__bootExpedition = () => window.AdminOperations.expedition(document.querySelector('#main'), async () => ({
  ok: true, data: { config: window.__expedition, sets: window.__sets, revision: 7 }
}), async () => window.__confirm, target => window.__nav.push(target));
</script></body></html>`;

  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
  let pass = 0, fail = 0;
  const ok = (cond, msg) => { if (cond) pass++; else { fail++; console.log('  ✗ ' + msg); } };
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    const errors = []; page.on('pageerror', e => errors.push(e.message)); page.setDefaultTimeout(8000);
    await page.addInitScript(({ cfg, items, state, expedition, sets }) => { window.__cfg = cfg; window.__items = items; window.__state = state; window.__expedition = expedition; window.__sets = sets; }, { cfg, items, state, expedition: catalog.constants.EXPEDITION, sets: catalog.constants.GEAR_SETS });
    await context.route('http://growth.test/**', route => {
      const url = new URL(route.request().url());
      if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: html });
      const file = path.join(root, url.pathname);
      if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return route.fulfill({ status: 404, body: '' });
      return route.fulfill({ path: file });
    });
    await page.goto('http://growth.test/');
    await page.evaluate(() => window.__boot());
    await page.locator('[data-config]').waitFor();

    // 1) 初始状态：面板唯一、零变更、摘要表提示未修改
    ok(await page.locator('.gear-system').count() === 1, '面板容器应唯一（.gear-system 恰好 1 个）');
    ok(await page.locator('[data-diff-count]').textContent() === '0', '初始变更数应为 0');
    ok(/尚未修改/.test(await page.locator('[data-diff-list]').textContent()), '初始摘要应提示未修改');

    // 2) 改一个数：变更计数、按钮文案、字段高亮
    await page.locator('[data-path="receiptHours"]').fill('12');
    await page.waitForFunction(() => document.querySelector('[data-diff-count]').textContent === '1');
    ok(await page.locator('[data-diff-count]').textContent() === '1', '改一个字段后变更数应为 1');
    ok(/1 项变更/.test(await page.locator('[data-save]').first().textContent()), '保存按钮应带变更数');
    ok(await page.locator('[data-path="receiptHours"].admin-changed').count() === 1, '被改动的字段应高亮');
    ok(/每张航程凭证所需小时/.test(await page.locator('[data-diff-list]').textContent()), '摘要应把字段翻成人话');

    // 3) 异步确认等待期间与取消后都保留草稿，确认撤销后回到零变更
    await page.evaluate(() => { window.__confirm = new Promise(resolve => { window.__resolveConfirm = resolve; }); });
    await page.locator('[data-revert]').click();
    ok(await page.locator('[data-path="receiptHours"]').inputValue() === '12', '装备撤销确认未完成时应保留草稿');
    await page.evaluate(() => window.__resolveConfirm(false));
    ok(await page.locator('[data-path="receiptHours"]').inputValue() === '12', '取消装备撤销应保留草稿');
    ok(await page.locator('[data-diff-count]').textContent() === '1', '取消装备撤销应保留变更摘要');
    await page.evaluate(() => { window.__confirm = true; });
    await page.locator('[data-revert]').click();
    await page.waitForFunction(() => document.querySelector('[data-diff-count]').textContent === '0');
    ok(await page.locator('[data-path="receiptHours"]').inputValue() === String(cfg.receiptHours), '撤销后应恢复已保存值');
    ok(await page.locator('.admin-changed').count() === 0, '撤销后不应残留改动高亮');

    // 4) 本地预检：越界值不发请求、标红字段
    await page.locator('[data-path="receiptHours"]').fill('999');
    await page.locator('[data-save]').first().click();
    await page.waitForFunction(() => document.querySelectorAll('.admin-invalid').length > 0);
    ok(!await page.evaluate(() => window.__calls.some(c => c.url === '/api/admin/gear/config')), '越界值不应发出保存请求');
    ok(await page.locator('[data-path="receiptHours"].admin-invalid').count() === 1, '越界字段应被标红');
    ok(/需在 1~168 小时/.test(await page.locator('[data-status]').first().textContent()), '状态栏应给出具体原因');

    // 5) 等级联动：改最高等级后，成长数组与逐级消耗自动补长再提交
    await page.locator('[data-path="receiptHours"]').fill(String(cfg.receiptHours));
    await page.locator('[data-path="maxLevel"]').fill('20');
    await page.waitForFunction(() => document.querySelectorAll('[data-invalid]').length === 0 && document.querySelector('[data-diff-count]').textContent !== '0');
    await page.locator('[data-save]').first().click();
    await page.waitForFunction(() => window.__calls.some(c => c.url === '/api/admin/gear/config'));
    const sent = await page.evaluate(() => window.__calls.find(c => c.url === '/api/admin/gear/config').body.config);
    ok(sent.maxLevel === 20, '提交的 maxLevel 应为 20');
    ok(sent.costs.upgrade.length === 20, '逐级强化消耗应自动同步为 20 级，实际 ' + sent.costs.upgrade.length);
    ok(Object.values(sent.parts).every(p => p.mainValues.length === 21 && p.subValues.length === 21), '五个部位的成长数组都应同步为 21 项');
    ok(Object.values(sent.parts).every(p => p.mainValues.every((v, i, a) => i === 0 || v >= a[i - 1])), '同步后主属性必须保持单调不减');

    // 6) 专精配置：认证驱动可编辑、合计超 3 点被拦、取消认证清零
    await page.locator('[data-player-name]').fill('tester');
    await page.locator('[data-player-load]').click();
    await page.locator('[data-alloc]').first().waitFor();
    const specCount = Object.keys(cfg.specializations).length;
    ok(await page.locator('[data-alloc]').count() === specCount, '每个专精都应有分配输入框');
    ok(await page.locator('[data-alloc]:disabled').count() === specCount, '未认证时分配框应全部禁用');
    await page.locator('[data-unlocked]').first().check();
    ok(await page.locator('[data-alloc]').first().isEnabled(), '认证后该专精分配框应可编辑');
    await page.locator('[data-alloc]').first().fill('3');
    await page.locator('[data-unlocked]').nth(1).check();
    await page.locator('[data-alloc]').nth(1).fill('1');
    ok(/已分配 4 \/ 3 点/.test(await page.locator('[data-alloc-hint]').textContent()), '合计提示应实时反映已分配点数');
    await page.locator('[data-progress] [type=submit]').click();
    ok(/合计不能超过 3 点/.test(await page.locator('[data-progress-status]').textContent()), '合计超 3 点应被拦下');
    ok(!await page.evaluate(() => window.__calls.some(c => c.url === '/api/admin/gear/player')), '专精配置非法时不应发保存请求');
    await page.locator('[data-alloc]').nth(1).fill('0');
    await page.locator('[data-progress] [type=submit]').click();
    await page.waitForFunction(() => window.__calls.some(c => c.url === '/api/admin/gear/player'));
    const playerBody = await page.evaluate(() => window.__calls.find(c => c.url === '/api/admin/gear/player').body);
    const firstSpec = Object.keys(cfg.specializations)[0];
    ok(playerBody.after.allocations[firstSpec] === 3, '合法配置应把 3 点写进提交体');
    ok(Object.keys(playerBody.after.allocations).length === 1, '0 点专精不应出现在分配表里');
    await page.locator('[data-unlocked]').first().uncheck();
    ok(await page.locator('[data-alloc]').first().inputValue() === '0', '取消认证应把该专精点数清零');

    // 7) 远航撤销与跨页跳转共用异步确认：等待 / 取消不能丢草稿
    await page.evaluate(() => window.__bootExpedition());
    const ticket = catalog.constants.EXPEDITION.ticket;
    await page.locator('[data-ticket]').fill(String(ticket + 1));
    await page.waitForFunction(() => document.querySelector('[data-diff-count]').textContent === '1');
    await page.evaluate(() => { window.__confirm = new Promise(resolve => { window.__resolveConfirm = resolve; }); });
    await page.locator('[data-revert]').click();
    ok(await page.locator('[data-ticket]').inputValue() === String(ticket + 1), '远航撤销确认未完成时应保留草稿');
    await page.evaluate(() => window.__resolveConfirm(false));
    ok(await page.locator('[data-ticket]').inputValue() === String(ticket + 1), '取消远航撤销应保留草稿');
    ok(await page.locator('[data-diff-count]').textContent() === '1', '取消远航撤销应保留变更摘要');
    await page.evaluate(() => { window.__confirm = true; });
    await page.locator('[data-revert]').click();
    await page.waitForFunction(() => document.querySelector('[data-diff-count]').textContent === '0');
    ok(await page.locator('[data-ticket]').inputValue() === String(ticket), '确认远航撤销应恢复已保存值');

    await page.locator('[data-ticket]').fill(String(ticket + 1));
    await page.waitForFunction(() => document.querySelector('[data-diff-count]').textContent === '1');
    await page.evaluate(() => { window.__confirm = new Promise(resolve => { window.__resolveConfirm = resolve; }); });
    await page.locator('[data-goto-gear]').click();
    ok(await page.evaluate(() => window.__nav.length) === 0, '跨页确认未完成时不应跳转');
    await page.evaluate(() => window.__resolveConfirm(false));
    ok(await page.evaluate(() => window.__nav.length) === 0, '取消跨页确认不应跳转');
    ok(await page.locator('[data-ticket]').inputValue() === String(ticket + 1), '取消跨页确认应保留远航草稿');
    await page.evaluate(() => { window.__confirm = true; });
    await page.locator('[data-goto-gear]').click();
    ok(await page.evaluate(() => window.__nav.join(',')) === 'gear', '确认跨页操作应跳转到装备页面');

    ok(errors.length === 0, '不应有未捕获的前端异常：' + errors.join(' | '));
  } finally {
    await browser.close();
  }
  console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  if (fail) process.exitCode = 1;
})();

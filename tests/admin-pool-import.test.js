'use strict';
/*
 * 钓点/鱼池「一键导入文档」回归。
 *
 * 覆盖：规则说明是否真的渲染出来、预检能否拦住坏文档、导入是否按 建图→建点→写鱼池 的顺序发请求、
 * 「已存在」是否按跳过处理（可重跑）、失败是否立即停止、以及导出→再预检的往返可用性。
 * 全部走接口桩，不连真实服务端。
 */
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const { chromium } = require('playwright-core');
const root = path.resolve(__dirname, '../frontend');

// 目录用真实 catalog：示例文档里的鱼/材料 id 必须真的存在，避免自造夹具掩盖问题
const constants = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../server-go/internal/rules/catalog.json'), 'utf8')).constants;
const CFG = {
  grounds: [{
    id: 'map', name: '世界地图', spots: [
      { id: 'dock', name: '湖畔老码头', pool: [{ pick: 'fish:crucian', weight: 30 }, { pick: 'material:bait_pack', weight: 12 }, { pick: 'component:', weight: 6 }] },
      { id: 'reef', name: '深海鱼礁', map: 'voyage', minShip: 3, buffs: [{ type: 'skill', value: -5 }], pool: [{ pick: 'fish:grouper', weight: 10 }] },
    ],
  }],
  catalog: {
    fish: ['common', 'big', 'rare'].flatMap(g => constants.FISH[g] || []).map(f => ({ id: f.id, name: f.name })),
    materials: (constants.MATERIALS || []).map(m => ({ id: m.id, name: m.name })),
    components: [],
  },
  poolPresets: { economy: { name: '经济浅水' }, big: { name: '大物塘' }, rare: { name: '稀有秘境' }, material: { name: '材料工坊' } },
};

const html = `<!doctype html><html><head><meta charset="utf-8"></head><body><div id="import"></div>
<script src="/js/admin-pool-import.js"></script>
<script>
window.__calls = []; window.__confirm = true; window.__failPath = null; window.__existing = {};
window.__api = async (method, url, body) => {
  window.__calls.push({ method, url, body });
  if (url === '/api/admin/ground/add' && body.id === 'map') return { ok: false, status: 400, data: { error: 'invalid_input' } };
  if (window.__failPath === url) return { ok: false, status: 400, data: { error: 'invalid_input' } };
  if (window.__existing[url]) return { ok: false, status: 409, data: { error: window.__existing[url] } };
  return { ok: true, data: { ok: true } };
};
window.__boot = (cfg, fresh) => window.AdminPoolImport.render(document.querySelector('#import'), cfg, window.__api, async () => window.__waitConfirm ? new Promise(resolve => { window.__resolveConfirm = resolve; }) : window.__confirm, fresh, fresh);
</script></body></html>`;

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
  let pass = 0, fail = 0;
  const ok = (cond, msg) => { if (cond) pass++; else { fail++; console.log('  ✗ ' + msg); } };
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    const errors = []; page.on('pageerror', e => errors.push(e.message)); page.setDefaultTimeout(8000);
    await page.addInitScript(cfg => { window.__cfg = cfg; window.__freshCalls = 0; }, CFG);
    await context.route('http://pools.test/**', route => {
      const url = new URL(route.request().url());
      if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: html });
      const file = path.join(root, url.pathname);
      if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return route.fulfill({ status: 404, body: '' });
      return route.fulfill({ path: file });
    });
    await page.goto('http://pools.test/');
    await page.evaluate(() => window.__boot(window.__cfg, async () => { window.__freshCalls++; return window.__cfg; }));

    // 1) 规则说明就在旁边：id 规则、pick 语法、示例、预设名
    const ruleText = await page.locator('details summary').first().textContent();
    ok(/文档编写规则/.test(ruleText), '应展示「文档编写规则」折叠块');
    const rules = await page.locator('details').first().textContent();
    ok(/\[a-z\]\[a-z0-9_\]/.test(rules), '规则里应写明 id 正则');
    ok(/fish:crucian/.test(rules) && /component:/.test(rules), '规则里应写明 pick 语法与随机组件写法');
    ok(/economy/.test(rules) && /大物塘|big/.test(rules), '规则里应列出可用预设池');
    ok(/权重是相对值/.test(rules), '规则里应说明权重是相对值');

    // 2) 填入示例 → 预检通过并列出步骤
    await page.locator('[data-fill-example]').click();
    await page.waitForFunction(() => !document.querySelector('[data-run]').disabled);
    const planText = await page.locator('[data-plan]').textContent();
    ok(/预检通过：将执行 5 步/.test(planText), '示例应预检通过并列出 5 步，实际：' + planText.slice(0, 60));
    ok(/新建地图 coral_sea/.test(planText) && /新建钓点 coral_flat/.test(planText) && /覆盖鱼池 coral_deep|覆盖鱼池 coral_flat/.test(planText), '步骤清单应包含建图/建点/写池');
    ok(/tier\/gate 是预留字段/.test(planText), '预留字段应给出提示而不是静默忽略');

    // 3) 坏文档被拦：非法地图 id / 未知鱼 / 权重为 0
    const bad = { version: 1, grounds: [{ id: 'Coral', name: '珊瑚海', spots: [{ id: 'flat', name: '浅滩', pool: [{ pick: 'fish:nope', weight: 1 }, { pick: 'fish:crucian', weight: 0 }] }] }] };
    await page.locator('[data-doc]').fill(JSON.stringify(bad));
    await page.locator('[data-check]').click();
    const badText = await page.locator('[data-plan]').textContent();
    ok(/预检未通过/.test(badText), '非法文档应预检失败');
    ok(/不符合 \^\[a-z\]/.test(badText), '应指出地图 id 不合法');
    ok(/不在鱼种目录/.test(badText), '应指出未知鱼 id');
    ok(/weight 必须是大于 0/.test(badText), '应指出权重必须大于 0');
    ok(await page.locator('[data-run]').isDisabled(), '预检未通过时导入按钮应禁用');

    // 4) 正常导入：按顺序发请求，「已存在」按跳过处理
    await page.evaluate(() => { window.__existing = { '/api/admin/ground/add': 'ground_exists' }; window.__calls = []; });
    await page.locator('[data-fill-example]').click();
    await page.waitForFunction(() => !document.querySelector('[data-run]').disabled);
    await page.locator('[data-run]').click();
    await page.waitForFunction(() => /导入完成/.test(document.querySelector('[data-doc-status]').textContent));
    const calls = await page.evaluate(() => window.__calls.map(c => c.url));
    assert.deepEqual(calls, ['/api/admin/ground/add', '/api/admin/spot/add', '/api/admin/spot/pool', '/api/admin/spot/add', '/api/admin/spot/buffs'], '请求顺序应为建图→建点→写池→建点→写增益');
    const body = await page.evaluate(() => window.__calls[1].body);
    ok(body.groundId === 'coral_sea' && body.id === 'coral_flat' && body.preset === 'big', '建点请求应带 groundId/id/preset');
    const poolBody = await page.evaluate(() => window.__calls[2].body);
    ok(poolBody.pool.length === 5 && poolBody.pool[4].pick === 'component:' && poolBody.pool[0].weight === 10, '写池请求应带完整权重与随机组件项');
    const addDeep = await page.evaluate(() => window.__calls[3].body);
    ok(addDeep.map === 'voyage' && addDeep.minShip === 3, '远洋钓点应带 map/minShip');
    const result = await page.locator('[data-plan]').textContent();
    ok(/已存在，跳过/.test(result), '「已存在」应记为跳过而不是失败');
    ok(await page.evaluate(() => window.__freshCalls > 0), '导入成功后应刷新钓点列表');

    // 5) 中途失败：停止执行、指出失败步骤、后续步骤不再发请求
    await page.evaluate(() => { window.__existing = {}; window.__failPath = '/api/admin/spot/pool'; window.__calls = []; });
    await page.locator('[data-check]').click();
    await page.locator('[data-run]').click();
    await page.waitForFunction(() => /已停止/.test(document.querySelector('[data-doc-status]').textContent));
    const after = await page.evaluate(() => window.__calls.map(c => c.url));
    assert.deepEqual(after, ['/api/admin/ground/add', '/api/admin/spot/add', '/api/admin/spot/pool'], '失败后不应继续执行后续步骤');
    ok(/失败：/.test(await page.locator('[data-plan]').textContent()), '结果应标出失败的那一步');

    // 6) 导出 → 再预检往返可用
    await page.evaluate(() => { window.__failPath = null; });
    await page.locator('[data-export-current]').click();
    await page.waitForFunction(() => /预检通过/.test(document.querySelector('[data-plan]').textContent));
    const exported = JSON.parse(await page.locator('[data-doc]').inputValue());
    ok(exported.grounds.length === 1 && exported.grounds[0].spots.length === 2, '导出应包含现有 1 张地图 / 2 个钓点');
    ok(exported.grounds[0].spots[1].map === 'voyage' && exported.grounds[0].spots[1].minShip === 3, '导出应保留 map/minShip');
    ok(exported.grounds[0].spots[1].buffs[0].type === 'skill', '导出应保留增益');
    ok(await page.evaluate(() => window.__freshCalls > 1), '导出前应重新拉一次最新配置');

    // 内置 map 的创建接口返回 invalid_input，导出再导入必须直接进入钓点/鱼池步骤。
    await page.evaluate(() => { window.__calls = []; window.__existing = { '/api/admin/spot/add': 'spot_exists' }; });
    await page.locator('[data-run]').click();
    await page.waitForFunction(() => /导入完成/.test(document.querySelector('[data-doc-status]').textContent));
    const roundTrip = await page.evaluate(() => window.__calls);
    ok(!roundTrip.some(c => c.url === '/api/admin/ground/add'), '已有内置地图不应调用新建地图接口');
    ok(roundTrip.filter(c => c.url === '/api/admin/spot/pool').length === 2 && roundTrip.some(c => c.url === '/api/admin/spot/buffs'), '导出再导入应完成默认地图的鱼池与增益覆盖');

    // 预检后编辑必须作废旧计划，重新预检后只提交新权重。
    exported.grounds[0].spots[0].pool[0].weight = 47;
    await page.locator('[data-doc]').fill(JSON.stringify(exported));
    ok(await page.locator('[data-run]').isDisabled(), '编辑文档后应禁用导入，要求重新预检');
    ok((await page.locator('[data-plan]').textContent()) === '', '编辑文档后应清除旧计划');
    await page.evaluate(() => { window.__calls = []; document.querySelector('[data-run]').onclick(); });
    ok(await page.evaluate(() => window.__calls.length === 0), '旧计划失效后不应发出任何写请求');
    await page.locator('[data-check]').click();
    await page.locator('[data-run]').click();
    await page.waitForFunction(() => /导入完成/.test(document.querySelector('[data-doc-status]').textContent));
    ok(await page.evaluate(() => window.__calls.find(c => c.url === '/api/admin/spot/pool').body.pool[0].weight === 47), '重新预检后应提交修改后的权重');

    // 确认弹窗等待期间修改文档，不能在确认后继续执行旧计划。
    await page.evaluate(() => { window.__calls = []; window.__waitConfirm = true; });
    await page.locator('[data-run]').click();
    await page.waitForFunction(() => typeof window.__resolveConfirm === 'function');
    ok(await page.evaluate(() => window.__calls.length === 0), '确认未结束时不应写入配置');
    exported.grounds[0].spots[0].pool[0].weight = 58;
    await page.locator('[data-doc]').fill(JSON.stringify(exported));
    await page.evaluate(() => { window.__resolveConfirm(true); });
    await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 0)));
    ok(await page.evaluate(() => window.__calls.length === 0), '确认期间文档变化后应中止旧计划');
    ok(await page.locator('[data-run]').isDisabled(), '确认期间文档变化后仍需重新预检');

    ok(errors.length === 0, '不应有未捕获的前端异常：' + errors.join(' | '));
  } finally {
    await browser.close();
  }
  console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  if (fail) process.exitCode = 1;
})();

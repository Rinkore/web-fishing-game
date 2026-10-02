/*
 * 钓点 / 鱼池「一键导入文档」。
 *
 * 目的：换地图时不要手点几十次，直接给一份文档，预检通过后按顺序建图 → 建点 → 写鱼池。
 * 只做「新建 / 覆盖」，不删东西；删除仍然走钓点列表里的删除按钮，避免一份写错的文档把线上一把清掉。
 *
 * 执行方式复用后台已有的逐项接口（ground/add、spot/add、spot/pool、spot/buffs），
 * 每个接口都会发布一版 catalog，所以只能串行执行、逐条报告结果。
 */
(function () {
  'use strict';
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const GROUND_ID = /^[a-z][a-z0-9_]{1,23}$/;
  const SPOT_ID = /^[a-z][a-z0-9_]{0,23}$/;
  const KINDS = ['fish', 'material', 'component'];
  const ERROR_TEXT = {
    ground_exists: '地图已存在（跳过新建）', spot_exists: '钓点已存在（跳过新建）', spot_not_found: '钓点不存在',
    ground_not_found: '地图不存在', catalog_revision_changed: '配置版本已变化，请重新导出后再导入',
    invalid_input: '服务端拒绝了这组数值（检查 id 规则、权重与掉落项）', retry_same_request: '连接未完成，可重试同一条',
  };
  const errText = r => (r && r.data && r.data.error) && (ERROR_TEXT[r.data.error] || r.data.error) || '请求未完成';

  const EXAMPLE = {
    version: 1,
    grounds: [{
      id: 'map',
      name: '世界地图',
      spots: [
        {
          id: 'coral_flat', name: '珊瑚浅滩', minShip: 2, preset: 'big', tier: 4, gate: 8000,
          pool: [
            { pick: 'fish:grouper', weight: 10 },
            { pick: 'fish:rubysnapper', weight: 8 },
            { pick: 'fish:pearl', weight: 4 },
            { pick: 'material:relic', weight: 2 },
            { pick: 'component:', weight: 6 },
          ],
        },
        { id: 'coral_deep', name: '珊瑚深沟', minShip: 3, preset: 'rare', buffs: [{ type: 'skill', value: -5 }, { type: 'rare', value: 20 }] },
      ],
    }],
  };

  function render(host, cfg, api, confirm, onDone, fresh) {
    if (!host) return;
    const catalog = (cfg && cfg.catalog) || {};
    const presets = Object.keys((cfg && cfg.poolPresets) || {}) ;
    const fishNames = Object.fromEntries(((catalog.fish) || []).map(f => [f.id, f.name]));
    const matNames = Object.fromEntries(((catalog.materials) || []).map(m => [m.id, m.name]));
    const compIds = new Set(((catalog.components) || []).map(c => c.id));
    let groundIds = new Set(((cfg && cfg.grounds) || []).map(g => g.id));
    host.innerHTML = '<h2>📥 一键导入鱼池文档</h2>'
      + '<p class="hint">用于配置世界地图：把钓点与掉落池写成一份文档，预检通过后按 建图 → 建点 → 写鱼池 的顺序自动执行。当前地图不再按钓区分栏。<strong>只新建与覆盖，不删除任何东西</strong>；要下线钓点请用左侧列表的删除按钮。</p>'
      + '<details class="ops-card" open><summary>文档编写规则</summary>'
      + '<div class="scroll"><table class="tbl"><thead><tr><th>字段</th><th>必填</th><th>说明</th></tr></thead><tbody>'
      + '<tr><td>version</td><td>否</td><td>固定 1，用于将来换格式</td></tr>'
      + '<tr><td>grounds[]</td><td><b>是</b></td><td>世界地图一项（通常使用现有的 <code>map</code>）。<code>id</code> 必填，规则 <code>^[a-z][a-z0-9_]{1,23}$</code>（2~24 位，字母开头，小写）；<code>name</code> 必填，≤20 字</td></tr>'
      + '<tr><td>grounds[].spots[]</td><td><b>是</b></td><td>地图下的钓点。<code>id</code> 规则 <code>^[a-z][a-z0-9_]{0,23}$</code>；<code>name</code> ≤20 字</td></tr>'
      + '<tr><td>spots[].map</td><td>否</td><td>历史兼容字段。新配置请留空；后台现在统一显示在世界地图。旧文档中的 <code>voyage</code> 会原样提交以保持兼容。</td></tr>'
      + '<tr><td>spots[].minShip</td><td>否</td><td>需要的船级 0~5；留空或 0＝无门槛</td></tr>'
      + '<tr><td>spots[].preset</td><td>否</td><td>新建时先套用的预设池：' + esc(presets.join(' / ') || 'economy') + '（默认 economy）</td></tr>'
      + '<tr><td>spots[].pool[]</td><td>否</td><td>写这份池就<strong>覆盖</strong>整池（不是追加）。每项 <code>{pick, weight}</code>，weight 必须 &gt; 0</td></tr>'
      + '<tr><td>spots[].buffs[]</td><td>否</td><td>增益列表，每项 <code>{type, value}</code>，type 如 <code>skill</code> / <code>rare</code></td></tr>'
      + '<tr><td>spots[].tier / gate</td><td>否</td><td><b>预留字段</b>：给「层级掉落表 + 累计渔获门槛」用。当前版本会原样保留在导出文档里但不生效</td></tr>'
      + '</tbody></table></div>'
      + '<p class="hint"><b>pick 语法</b>：三种前缀 + 冒号 + 目录 id —— <code>fish:crucian</code>（鱼）、<code>material:relic</code>（材料）、<code>component:xxx</code>（指定组件底材）。<code>component:</code> 冒号后留空 = 随机组件。<br>'
      + '<b>权重是相对值</b>：某项实际概率 ≈ 自身权重 ÷ 同池总权重，之后还会被词缀与全局倍率调整；把整池权重放大 10 倍不会改变概率。</p>'
      + '<p class="hint">示例（点「填入示例」可直接试跑）：</p><pre class="scroll" style="max-height:220px">' + esc(JSON.stringify(EXAMPLE, null, 2)) + '</pre></details>'
      + '<div class="ops-row"><button class="btn" data-fill-example>填入示例</button><button class="btn" data-export-current>导出当前地图为文档</button><button class="btn primary" data-check>① 预检</button><button class="btn primary" data-run disabled>② 一键导入</button></div>'
      + '<textarea class="ipt" data-doc rows="14" spellcheck="false" placeholder="把鱼池文档粘贴到这里，或点上面的「导出当前地图为文档」拿到现有格式"></textarea>'
      + '<p role="status" data-doc-status></p><div data-plan></div>';
    const doc = host.querySelector('[data-doc]');
    const status = host.querySelector('[data-doc-status]');
    const planBox = host.querySelector('[data-plan]');
    const runBtn = host.querySelector('[data-run]');
    let plan = null;
    let planDoc = '';
    let running = false;
    doc.addEventListener('input', () => {
      plan = null;
      runBtn.disabled = true;
      planBox.innerHTML = '';
      status.textContent = '文档已修改，请重新预检。';
    });

    function collectPool(raw, where, problems) {
      const out = [];
      const seen = new Set();
      raw.forEach((entry, i) => {
        const at = where + '.pool[' + i + ']';
        if (!entry || typeof entry !== 'object') { problems.push(at + ' 必须是 {pick, weight} 对象'); return; }
        const pick = String(entry.pick == null ? '' : entry.pick);
        const [kind, ...rest] = pick.split(':');
        const id = rest.join(':');
        if (!KINDS.includes(kind)) { problems.push(at + '.pick 前缀只能是 fish / material / component，收到「' + pick + '」'); return; }
        if (kind === 'fish' && !fishNames[id]) { problems.push(at + '.pick 的鱼「' + id + '」不在鱼种目录里'); return; }
        if (kind === 'material' && !matNames[id]) { problems.push(at + '.pick 的材料「' + id + '」不在材料目录里'); return; }
        if (kind === 'component' && id && compIds.size && !compIds.has(id)) { problems.push(at + '.pick 的组件「' + id + '」不在组件目录里'); return; }
        if (kind === 'component' && id && !compIds.size) { problems.push(at + '.pick 指定了组件但后台未提供组件目录，无法校验（可留空表示随机组件）'); }
        const weight = Number(entry.weight);
        if (!(weight > 0) || !isFinite(weight)) { problems.push(at + '.weight 必须是大于 0 的数字'); return; }
        if (seen.has(pick)) { problems.push(at + ' 与同池其它项重复：' + pick); return; }
        seen.add(pick);
        out.push({ pick, weight });
      });
      return out;
    }
    // 一次把所有问题都报出来，别让运营改一条跑一次预检
    function buildPlan(input) {
      const problems = [], steps = [], warnings = [];
      if (!input || typeof input !== 'object') { problems.push('文档必须是一个 JSON 对象'); return { problems, steps, warnings }; }
      if (input.version != null && Number(input.version) !== 1) warnings.push('version 不是 1，按当前格式解析');
      if (!Array.isArray(input.grounds) || !input.grounds.length) { problems.push('grounds 必须是非空数组'); return { problems, steps, warnings }; }
      const gids = new Set();
      input.grounds.forEach((g, gi) => {
        const gAt = 'grounds[' + gi + ']';
        const gid = String((g && g.id) || '').trim();   // 不做小写化：静默改写会让人以为导入成功了
        const gidOk = GROUND_ID.test(gid);
        if (!gidOk) problems.push(gAt + '.id「' + gid + '」不符合 ^[a-z][a-z0-9_]{1,23}$（2~24 位，小写字母开头）');
        else if (gids.has(gid)) { problems.push(gAt + '.id 与前面的地图重复：' + gid); return; }
        gids.add(gid);
        const gname = String((g && g.name) || '').trim();
        const gnameOk = !!gname && Array.from(gname).length <= 20;
        if (!gnameOk) problems.push(gAt + '.name 必填且不超过 20 字');
        if (!Array.isArray(g.spots) || !g.spots.length) { problems.push(gAt + '.spots 必须是非空数组'); return; }
        const groundOk = gidOk && gnameOk;
        if (groundOk && !groundIds.has(gid)) steps.push({ groundId: gid, label: '新建地图 ' + gid + '（' + gname + '）', method: '/api/admin/ground/add', body: { id: gid, name: gname }, skipOnExists: true });
        const sids = new Set();
        g.spots.forEach((s, si) => {
          const sAt = gAt + '.spots[' + si + ']';
          const sid = String((s && s.id) || '').trim();
          const sidOk = SPOT_ID.test(sid);
          if (!sidOk) problems.push(sAt + '.id「' + sid + '」不符合 ^[a-z][a-z0-9_]{0,23}$（1~24 位，小写字母开头）');
          else if (sids.has(sid)) { problems.push(sAt + '.id 与同图的钓点重复：' + sid); return; }
          sids.add(sid);
          const sname = String((s && s.name) || '').trim();
          const snameOk = !!sname && Array.from(sname).length <= 20;
          if (!snameOk) problems.push(sAt + '.name 必填且不超过 20 字');
          let mapOk = true;
          if (s.map != null && s.map !== '' && s.map !== 'voyage') { problems.push(sAt + '.map 只能是 voyage 或留空'); mapOk = false; }
          if (s.map === 'voyage') warnings.push(sAt + '.map=voyage 是历史字段，当前后台统一显示在世界地图');
          let shipOk = true;
          if (s.minShip != null && !(Number(s.minShip) >= 0 && Number(s.minShip) <= 5)) { problems.push(sAt + '.minShip 需在 0~5'); shipOk = false; }
          let preset = String(s.preset || 'economy');
          if (presets.length && !presets.includes(preset)) { warnings.push(sAt + '.preset「' + preset + '」不是已知预设，服务端会退回 economy'); preset = 'economy'; }
          if (s.tier != null || s.gate != null) warnings.push(sAt + ' 的 tier/gate 是预留字段，当前版本不生效（已原样保留在导出文档里）');
          const pool = Array.isArray(s.pool) && s.pool.length ? collectPool(s.pool, sAt, problems) : [];
          const buffs = Array.isArray(s.buffs) ? s.buffs.filter(b => b && b.type).map(b => ({ type: String(b.type), value: Number(b.value) || 0 })) : [];
          if (!(groundOk && sidOk && snameOk && mapOk && shipOk)) return;   // 校验照做，但不为非法条目生成步骤
          const add = { groundId: gid, id: sid, name: sname, preset, fill: true };
          if (s.map === 'voyage') add.map = 'voyage';
          if (Number(s.minShip) > 0) add.minShip = Number(s.minShip);
          steps.push({ groundId: gid, label: '新建钓点 ' + sid + '（' + sname + '，预设 ' + preset + '）', method: '/api/admin/spot/add', body: add, skipOnExists: true });
          if (pool.length) steps.push({ groundId: gid, label: '覆盖鱼池 ' + sid + '（' + pool.length + ' 项）', method: '/api/admin/spot/pool', body: { groundId: gid, spotId: sid, pool } });
          if (buffs.length) steps.push({ groundId: gid, label: '覆盖增益 ' + sid + '（' + buffs.length + ' 项）', method: '/api/admin/spot/buffs', body: { groundId: gid, spotId: sid, buffs } });
        });
      });
      return { problems, steps, warnings };
    }
    function showPlan(result) {
      plan = result;
      planDoc = doc.value;
      if (result.problems.length) {
        planBox.innerHTML = '<div class="gear-card"><h3>预检未通过（' + result.problems.length + ' 项）</h3><ul>' + result.problems.slice(0, 30).map(p => '<li class="err">' + esc(p) + '</li>').join('') + '</ul></div>';
        runBtn.disabled = true;
        status.textContent = '先修正上面的问题再导入。';
        return false;
      }
      planBox.innerHTML = '<div class="gear-card"><h3>预检通过：将执行 ' + result.steps.length + ' 步</h3><ol>' + result.steps.map(s => '<li>' + esc(s.label) + '</li>').join('') + '</ol>'
        + (result.warnings.length ? '<p class="hint">提示：' + esc(result.warnings.slice(0, 10).join('；')) + '</p>' : '')
        + '<p class="hint">执行顺序即上面的顺序，每步单独发布一版配置；中途失败会停下来并指出是哪一步。</p></div>';
      runBtn.disabled = running;
      status.textContent = '预检通过，可以导入。';
      return true;
    }
    host.querySelector('[data-check]').onclick = () => {
      let input;
      try { input = JSON.parse(doc.value); } catch (e) { plan = null; status.textContent = 'JSON 解析失败：' + e.message; planBox.innerHTML = ''; runBtn.disabled = true; return; }
      showPlan(buildPlan(input));
    };
    host.querySelector('[data-fill-example]').onclick = () => { doc.value = JSON.stringify(EXAMPLE, null, 2); host.querySelector('[data-check]').click(); };
    host.querySelector('[data-export-current]').onclick = async () => {
      const use = fresh ? await fresh() : cfg;   // 导出前重新拉一次，避免拿到进页面时的旧快照
      if (running) return;
      groundIds = new Set((use.grounds || []).map(g => g.id));
      const out = { version: 1, grounds: (use.grounds || []).map(g => ({
        id: g.id, name: g.name,
        spots: (g.spots || []).map(s => {
          const spot = { id: s.id, name: s.name };
          if (s.map) spot.map = s.map;
          if (s.minShip) spot.minShip = s.minShip;
          if (s.tier != null) spot.tier = s.tier;
          if (s.gate != null) spot.gate = s.gate;
          if (Array.isArray(s.pool) && s.pool.length) spot.pool = s.pool.map(e => ({ pick: e.pick, weight: e.weight }));
          if (Array.isArray(s.buffs) && s.buffs.length) spot.buffs = s.buffs.map(b => ({ type: b.type, value: b.value }));
          return spot;
        }),
      })) };
      doc.value = JSON.stringify(out, null, 2);
      status.textContent = '已导出当前 ' + out.grounds.length + ' 张地图 / ' + out.grounds.reduce((a, g) => a + g.spots.length, 0) + ' 个钓点，可改完再导入。';
      host.querySelector('[data-check]').click();
    };
    runBtn.onclick = async () => {
      if (running || !plan || plan.problems.length || doc.value !== planDoc) return;
      const activePlan = plan, activeDoc = planDoc;
      running = true; runBtn.disabled = true;
      const controls = Array.from(host.querySelectorAll('.ops-row button')).filter(button => button !== runBtn);
      const lines = [];
      let done = 0;
      const draw = () => { planBox.innerHTML = '<div class="gear-card"><h3>执行结果（' + done + '/' + activePlan.steps.length + '）</h3><ol>' + lines.map(l => '<li class="' + (l.ok ? '' : 'err') + '">' + esc(l.text) + '</li>').join('') + '</ol></div>'; };
      try {
        const runText = '将按预检清单执行 ' + activePlan.steps.length + ' 步（只新建与覆盖，不删除）？';
        const runOk = window.confirmDangerous
          ? await window.confirmDangerous({ title: '执行导入', text: runText + '\n请手动输入「导入」以确认。', confirmWord: '导入', okText: '执行导入' })
          : await confirm(runText);
        if (!runOk) return;
        if (plan !== activePlan || doc.value !== activeDoc) return;
        controls.forEach(button => { button.disabled = true; }); doc.disabled = true;
        for (const step of activePlan.steps) {
          const r = await api('POST', step.method, step.body);
          const exists = r && r.data && (r.data.error === 'ground_exists' || r.data.error === 'spot_exists');
          if (r && r.ok) { lines.push({ ok: true, text: step.label + ' — 完成' }); }
          else if (step.skipOnExists && exists) { lines.push({ ok: true, text: step.label + ' — 已存在，跳过' }); }
          else { lines.push({ ok: false, text: step.label + ' — 失败：' + errText(r) }); done++; draw(); status.textContent = '第 ' + (done) + ' 步失败，已停止。修正后可重跑（已完成的步骤会按「已存在」跳过）。'; return; }
          done++; draw();
        }
        status.textContent = '导入完成：' + activePlan.steps.length + ' 步全部成功。钓点列表已刷新。';
        if (onDone) await onDone();
      } finally {
        running = false;
        runBtn.disabled = !plan || plan.problems.length > 0 || doc.value !== planDoc;
        controls.forEach(button => { button.disabled = false; }); doc.disabled = false;
      }
    };
  }
  window.AdminPoolImport = { render, EXAMPLE };
})();

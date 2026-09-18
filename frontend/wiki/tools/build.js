'use strict';
(function () {
  const STORE_KEY = 'fishing-wiki:builds:v1';
  const SMELT_RESULT_KEY = 'fishing-wiki:smelt-result:v1';
  const $ = id => document.getElementById(id);
  const state = { snapshot:null, plans:{ A:emptyPlan('方案 A'), B:emptyPlan('方案 B') }, active:'A', research:false, importedMismatch:false };
  function emptyPlan(name) {
    const slots = {};
    GameData.ROD_PARTS.forEach(function (p) { slots[p.key] = null; });
    return { name:name || '未命名方案', spotId:'', slots:slots };
  }
  function escapeHTML(v) { return String(v == null ? '' : v).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
  function partName(key) { const p = GameData.ROD_PARTS.find(x => x.key === key); return p ? p.name : key; }
  function basesFor(part) { return GameData.COMPONENT_BASES.filter(b => b.part === part); }
  function affixRange(baseId, type, src) {
    const base = GameData.componentBase(baseId);
    if (base && base.pool.some(a => a.type === type) && (!src || src === baseId)) return GameData.affixRangeOf(baseId, type);
    if (src === 'ct') return GameData.catalystRangeOf(base && base.part, type) || GameData.extraAffixRangeOf(type);
    return GameData.extraAffixRangeOf(type);
  }
  function slotFromImported(part, value) {
    if (!value || !value.baseId) return null;
    return { baseId:value.baseId, quality:value.quality || 'common', affixes:(value.affixes || []).map(a => ({ type:a.type, value:Number(a.value), src:a.src || null, srcExplicit:!!a.srcExplicit })) };
  }
  function normalizePlan(plan) {
    const out = emptyPlan(plan && plan.name || '未命名方案');
    out.spotId = plan && plan.spotId || '';
    GameData.ROD_PARTS.forEach(function (p) { out.slots[p.key] = slotFromImported(p.key, plan && plan.slots && plan.slots[p.key]); });
    return out;
  }
  function validatePlan(plan) {
    const errors = [];
    GameData.ROD_PARTS.forEach(function (p) {
      const s = plan.slots[p.key];
      if (!s) return;
      const base = GameData.componentBase(s.baseId);
      if (!base) { errors.push(partName(p.key) + '：未知底材'); return; }
      if (base.part !== p.key) errors.push(partName(p.key) + '：底材部位不匹配');
      if (!GameData.QUALITY[s.quality]) errors.push(partName(p.key) + '：未知品质');
      const seen = {};
      (s.affixes || []).forEach(function (a) {
        if (!GameData.AFFIX_LABEL[a.type]) { errors.push(partName(p.key) + '：未知词缀'); return; }
        if (seen[a.type]) errors.push(partName(p.key) + '：词缀类型重复');
        seen[a.type] = 1;
        if (!isFinite(a.value)) errors.push(partName(p.key) + '：词缀数值无效');
        if (!state.research) {
          const r = affixRange(s.baseId, a.type, a.src);
          if (r && (a.value < r.min || a.value > r.max)) errors.push(partName(p.key) + '：' + GameData.AFFIX_LABEL[a.type] + ' 超出当前规则区间');
        }
      });
    });
    return errors;
  }
  function buildBd(plan) {
    const bd = {};
    GameData.ROD_PARTS.forEach(function (p) {
      const s = plan.slots[p.key];
      if (!s || !s.baseId || !s.affixes || !s.affixes.length) return;
      bd[p.key] = { compId:GameData.instanceId(s.baseId, s.quality, s.affixes) };
    });
    return bd;
  }
  function spotOf(id) {
    for (const g of state.snapshot.grounds) for (const s of g.spots || []) if (g.id + ':' + s.id === id) return s;
    return null;
  }
  function simulate(plan) {
    if (!state.snapshot || Wiki.unavailable) return null;
    const errors = validatePlan(plan);
    if (errors.length) return { errors:errors };
    if (state.importedMismatch) return { errors:['导入方案与当前规则快照不一致，不能按官方规则复现。可点击“另存为当前规则”后重新计算。'] };
    const rules = { cast:state.snapshot.rulesConfig.castCfg, biteFormula:state.snapshot.rulesConfig.biteFormula, doubleBase:state.snapshot.rulesConfig.doubleBase };
    return GameData.simulateRodPlan(buildBd(plan), spotOf(plan.spotId), rules);
  }
  function resultHTML(sim) {
    if (!sim) return '<p class="warning">当前规则快照不可用，数值与模拟器已禁用。</p>';
    if (sim.errors) return '<ul class="warning">' + sim.errors.map(e => '<li>' + escapeHTML(e) + '</li>').join('') + '</ul>';
    const e = sim.eff, i = sim.info;
    return '<div class="result-grid">' +
      metric('钓速', e.speed) + metric('技巧', e.skill) + metric('稀有度', e.rare) +
      metric('材料概率', e.material) + metric('体型', e.size) + metric('双钓', e.double) +
      metric('抛竿间隔', i.interval + ' ms') + metric('上鱼率', sim.bite + '%') +
      metric('双钓概率', sim.doubleP.toFixed(2) + '%') + metric('期望件数', sim.perCast.toFixed(3)) +
      metric('每小时抛竿', Math.round(sim.castsPerHour)) + metric('理论掉落/小时', Math.round(sim.fishPerHour)) +
      '</div>' + (i.biteOverride ? '<p class="muted">上鱼率来自钓点独立配置。</p>' : '<p class="muted">上鱼率来自当前服务端公式。</p>');
  }
  function metric(label, value) { return '<div class="result-item"><div class="muted">' + label + '</div><strong>' + escapeHTML(value) + '</strong></div>'; }
  function compareHTML(a, b) {
    if (!a || !b || a.errors || b.errors) return '<p class="muted">两个方案都有效后显示对比。</p>';
    const rows = [
      ['钓速', a.eff.speed, b.eff.speed], ['技巧', a.eff.skill, b.eff.skill],
      ['稀有度', a.eff.rare, b.eff.rare], ['材料概率', a.eff.material, b.eff.material],
      ['体型', a.eff.size, b.eff.size], ['双钓', a.eff.double, b.eff.double],
      ['间隔 ms', a.interval, b.interval], ['上鱼率 %', a.bite, b.bite],
      ['理论掉落/小时', Math.round(a.fishPerHour), Math.round(b.fishPerHour)],
    ];
    return '<table><thead><tr><th>指标</th><th>A</th><th>B</th><th>差值</th></tr></thead><tbody>' + rows.map(function (r) {
      const d = r[2] - r[1], cls = d > 0 ? 'positive' : (d < 0 ? 'negative' : '');
      return '<tr><td>' + r[0] + '</td><td>' + r[1] + '</td><td>' + r[2] + '</td><td class="' + cls + '">' + (d > 0 ? '+' : '') + d + '</td></tr>';
    }).join('') + '</tbody></table>';
  }
  function option(v, label, selected) { return '<option value="' + escapeHTML(v) + '"' + (selected ? ' selected' : '') + '>' + escapeHTML(label || v) + '</option>'; }
  function renderSlots() {
    const plan = state.plans[state.active];
    $('slot-title').textContent = '组件编辑 · ' + plan.name;
    $('slots').innerHTML = GameData.ROD_PARTS.map(function (p) {
      const s = plan.slots[p.key] || { baseId:'', quality:'common', affixes:[] };
      const bases = basesFor(p.key);
      const baseOpts = option('', '空 / 标准件', !s.baseId) + bases.map(b => option(b.id, b.name, b.id === s.baseId)).join('');
      const qOpts = Object.keys(GameData.QUALITY).map(q => option(q, GameData.QUALITY[q].name, q === s.quality)).join('');
      const affixRows = (s.affixes || []).map(function (a, idx) {
        const typeOpts = GameData.AFFIX_TYPES.map(t => option(t, GameData.AFFIX_LABEL[t], t === a.type)).join('');
        const srcOpts = option('', '底材 / 自然', !a.src) + option('bt', '突破', a.src === 'bt') + option('ct', '催化', a.src === 'ct');
        return '<div class="affix-row" data-affix="' + idx + '"><select data-field="type">' + typeOpts + '</select><input type="number" data-field="value" value="' + Number(a.value) + '"><select data-field="src">' + srcOpts + '</select><button data-remove="' + idx + '">删</button></div>';
      }).join('');
      return '<section class="slot-editor" data-part="' + p.key + '"><div class="slot-head"><strong>' + escapeHTML(p.name) + '</strong><button data-add-affix>加词缀</button></div><div class="slot-fields"><select data-field="base">' + baseOpts + '</select><select data-field="quality">' + qOpts + '</select></div>' + affixRows + '</section>';
    }).join('');
    bindSlots();
  }
  function ensureSlot(part) {
    const plan = state.plans[state.active];
    if (!plan.slots[part]) plan.slots[part] = { baseId:'', quality:'common', affixes:[] };
    if (!plan.slots[part].affixes) plan.slots[part].affixes = [];
    return plan.slots[part];
  }
  function bindSlots() {
    document.querySelectorAll('.slot-editor').forEach(function (root) {
      const part = root.getAttribute('data-part');
      root.querySelectorAll('[data-field]').forEach(function (input) {
        input.addEventListener('change', function () {
          const s = ensureSlot(part), field = input.getAttribute('data-field');
          if (field === 'base') { s.baseId = input.value; if (!s.affixes) s.affixes = []; }
          else if (field === 'quality') s.quality = input.value;
          renderAll();
        });
      });
      root.querySelectorAll('.affix-row').forEach(function (row) {
        const idx = Number(row.getAttribute('data-affix'));
        row.querySelectorAll('[data-field]').forEach(function (input) {
          input.addEventListener('change', function () {
            const s = ensureSlot(part), field = input.getAttribute('data-field'), a = s.affixes[idx];
            if (!a) return;
            if (field === 'type') a.type = input.value;
            if (field === 'value') a.value = Number(input.value);
            if (field === 'src') a.src = input.value || null;
            renderAll();
          });
        });
      });
      root.querySelector('[data-add-affix]').addEventListener('click', function () {
        const s = ensureSlot(part); s.affixes.push({ type:GameData.AFFIX_TYPES.find(t => !s.affixes.some(a => a.type === t)) || 'speed', value:0, src:null }); renderAll();
      });
      root.querySelectorAll('[data-remove]').forEach(function (b) {
        b.addEventListener('click', function () { const s = ensureSlot(part); s.affixes.splice(Number(b.getAttribute('data-remove')), 1); renderAll(); });
      });
    });
  }
  function savedPlans() { return Wiki.storage.readJSON(STORE_KEY, []); }
  function savePlans(list) { return Wiki.storage.writeJSON(STORE_KEY, list); }
  function renderSaved() {
    const list = savedPlans();
    $('saved-plans').innerHTML = option('', '选择已保存方案') + list.map((p, i) => option(String(i), p.name)).join('');
  }
  function shareObject() {
    return { schemaVersion:1, rulesVersion:state.snapshot.rulesVersion, gameVersion:state.snapshot.gameVersion, snapshotId:state.snapshot.snapshotId, configHash:state.snapshot.configHash, plan:state.plans[state.active] };
  }
  function applyImport(value, showMessage) {
    if (!value || value.schemaVersion !== 1 || !value.plan) throw new Error('方案结构无效');
    state.plans[state.active] = normalizePlan(value.plan);
    state.importedMismatch = !state.snapshot || value.rulesVersion !== state.snapshot.rulesVersion || value.gameVersion !== state.snapshot.gameVersion || value.configHash !== state.snapshot.configHash;
    renderAll();
    if (showMessage) $('share-code').value = '导入完成' + (state.importedMismatch ? '：规则版本不一致，官方计算已阻断。' : '。');
  }
  function renderAll() {
    const plan = state.plans[state.active];
    $('plan-name').value = plan.name;
    $('spot-select').value = plan.spotId || '';
    $('research-mode').checked = state.research;
    renderSlots();
    const a = simulate(state.plans.A), b = simulate(state.plans.B);
    $('current-result').innerHTML = (state.research ? '<p class="warning">自由试算：结果不代表官方可获取配置。</p>' : '') + resultHTML(state.active === 'A' ? a : b);
    $('compare-result').innerHTML = compareHTML(a, b);
    renderSaved();
  }
  function renderSpotSelect() {
    const opts = ['<option value="">不选择钓点</option>'];
    state.snapshot.grounds.forEach(function (g) { (g.spots || []).forEach(function (s) { opts.push(option(g.id + ':' + s.id, g.name + ' · ' + s.name, state.plans[state.active].spotId === g.id + ':' + s.id)); }); });
    $('spot-select').innerHTML = opts.join('');
  }
  function applyQueryPreset() {
    if (state.queryApplied || !state.snapshot) return;
    state.queryApplied = true;
    const params = new URLSearchParams(location.search);
    const plan = state.plans[state.active];
    const groundId = params.get('ground'), spotId = params.get('spot'), baseId = params.get('base');
    if (groundId) {
      const g = (state.snapshot ? state.snapshot.grounds : []).find(function (x) { return x.id === groundId; });
      if (g) {
        const sp = (g.spots || []).find(function (x) { return x.id === spotId; }) || (g.spots || [])[0];
        if (sp) plan.spotId = g.id + ':' + sp.id;
      }
    }
    if (baseId) {
      const base = GameData.componentBase(baseId);
      if (base) {
        const a = base.pool[0];
        plan.slots[base.part] = { baseId:base.id, quality:'common', affixes:a ? [{ type:a.type, value:a.min, src:null, srcExplicit:false }] : [] };
      }
    }
  }

  function init() {
    $('plan-a').addEventListener('click', function () { state.active='A'; state.importedMismatch=false; renderAll(); });
    $('plan-b').addEventListener('click', function () { state.active='B'; state.importedMismatch=false; renderAll(); });
    $('plan-name').addEventListener('change', function () { state.plans[state.active].name=this.value; renderAll(); });
    $('spot-select').addEventListener('change', function () { state.plans[state.active].spotId=this.value; renderAll(); });
    $('research-mode').addEventListener('change', function () { state.research=this.checked; renderAll(); });
    $('copy-plan').addEventListener('click', function () { state.plans[state.active === 'A' ? 'B' : 'A'] = JSON.parse(JSON.stringify(state.plans[state.active])); state.active = state.active === 'A' ? 'B' : 'A'; state.importedMismatch=false; renderAll(); });
    $('clear-plan').addEventListener('click', function () { state.plans[state.active] = emptyPlan('未命名方案'); state.importedMismatch=false; renderAll(); });
    $('save-plan').addEventListener('click', function () { if (!state.snapshot || Wiki.unavailable) { $('share-code').value = '当前规则快照不可用，暂不能保存官方方案。'; return; } const list=savedPlans(); list.push(shareObject()); if (!savePlans(list)) $('share-code').value = '浏览器存储不可用'; renderAll(); });
    $('load-plan').addEventListener('click', function () { const i=Number($('saved-plans').value); const list=savedPlans(); if (!(i >= 0) || !list[i]) return; applyImport(list[i], true); });
    $('delete-plan').addEventListener('click', function () { const i=Number($('saved-plans').value); const list=savedPlans(); if (i >= 0 && list[i]) { list.splice(i,1); savePlans(list); renderAll(); } });
    $('share-link').addEventListener('click', function () { if (!state.snapshot || Wiki.unavailable) { $('share-code').value = '当前规则快照不可用，暂不能生成官方分享。'; return; } const code=Wiki.encodeShare(shareObject()); const url=location.origin + location.pathname + '#plan=' + code; $('share-code').value=url; const a=$('share-link-output'); a.href=url; a.hidden=false; a.textContent='打开分享链接'; });
    $('export-code').addEventListener('click', function () { if (!state.snapshot || Wiki.unavailable) { $('share-code').value = '当前规则快照不可用，暂不能导出官方方案。'; return; } $('share-code').value=Wiki.encodeShare(shareObject()); });
    $('import-code').addEventListener('click', function () { try { applyImport(Wiki.decodeShare($('share-code').value.trim()), true); } catch(e) { $('share-code').value = '导入失败：' + e.message; } });
    $('adopt-import').addEventListener('click', function () { if (!state.importedMismatch) return; state.importedMismatch=false; $('share-code').value='已按当前规则另存，官方计算恢复。'; renderAll(); });
    $('load-smelt').addEventListener('click', function () {
      const item=Wiki.storage.readJSON(SMELT_RESULT_KEY, null); if (!item) { $('share-code').value = '没有可读取的熔炼产物'; return; }
      const part=(GameData.componentBase(item.baseId) || {}).part; if (!part) { $('share-code').value = '熔炼产物底材无效'; return; }
      state.plans[state.active].slots[part] = slotFromImported(part, item); renderAll();
    });
    Wiki.onChange(function (s, unavailable) {
      const r=$('status-card'); r.className='status-card ' + (unavailable ? 'status-bad' : 'status-ok'); r.innerHTML='<div class="status-line"><span class="status-dot"></span>' + (unavailable ? '规则不可用' : '规则可用') + '</div><p class="status-message">' + (unavailable ? '无法确认最新规则，数值与模拟器已禁用。' : '已连接当前服务端规则快照。') + '</p>';
      const key = s ? s.snapshotId : '';
      const changed = key !== state.lastWikiKey || unavailable !== state.lastUnavailable;
      state.lastWikiKey = key; state.lastUnavailable = unavailable;
      if (s && !unavailable) {
        state.snapshot=s; GameData.setComponentCfg(s.rulesConfig.componentCfg); GameData.setSmeltCfg(s.rulesConfig.smeltCfg); applyQueryPreset();
        if (!state.plans[state.active].spotId && s.grounds[0] && s.grounds[0].spots[0]) state.plans[state.active].spotId=s.grounds[0].id + ':' + s.grounds[0].spots[0].id;
        if (changed) renderSpotSelect();
      }
      if (changed) renderAll();
    });
    Wiki.init().catch(function (e) { console.error(e); });
    const m=/#plan=([^&]+)/.exec(location.hash); if (m) { try { applyImport(Wiki.decodeShare(decodeURIComponent(m[1])), true); } catch(e) { console.error(e); } }
  }
  document.addEventListener('DOMContentLoaded', function () { applyQueryPreset(); init(); });
})();

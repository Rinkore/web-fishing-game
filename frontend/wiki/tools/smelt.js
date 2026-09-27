'use strict';
(function () {
  const SMELT_RESULT_KEY = 'fishing-wiki:smelt-result:v1';
  const $ = id => document.getElementById(id);
  const state = { snapshot:null, main:null, sub:null, materials:{}, pearl:false, relics:0, lastOutcome:null, batch:{ running:false, cancel:false } };
  function escapeHTML(v) { return String(v == null ? '' : v).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c])); }
  function partName(key) { const p = GameData.ROD_PARTS.find(x => x.key === key); return p ? p.name : key; }
  function basesFor(part) { return GameData.COMPONENT_BASES.filter(b => b.part === part); }
  function defaultComponent(role) {
    const part = GameData.ROD_PARTS[0].key, base = basesFor(part)[0];
    const affix = role === 'sub' && base.pool[1] ? base.pool[1] : base.pool[0];
    return { part:part, baseId:base.id, quality:'common', affixes:[{ type:affix.type, value:affix.min, src:null, srcExplicit:false }], selected:0, role:role };
  }
  function option(v, label, selected) { return '<option value="' + escapeHTML(v) + '"' + (selected ? ' selected' : '') + '>' + escapeHTML(label || v) + '</option>'; }
  function editorHTML(c) {
    const bases = basesFor(c.part), base = GameData.componentBase(c.baseId) || bases[0];
    const partOpts = GameData.ROD_PARTS.map(p => option(p.key, p.name, p.key === c.part)).join('');
    const baseOpts = bases.map(b => option(b.id, b.name, b.id === base.id)).join('');
    const qualityOpts = Object.keys(GameData.QUALITY).map(q => option(q, GameData.QUALITY[q].name, q === c.quality)).join('');
    const rows = (c.affixes || []).map(function (a, i) {
      const types = GameData.AFFIX_TYPES.map(t => option(t, GameData.AFFIX_LABEL[t], t === a.type)).join('');
      return '<div class="affix-row">' +
        '<label class="field"><span>词缀</span><select data-field="type" data-index="' + i + '">' + types + '</select></label>' +
        '<label class="field"><span>数值</span><input type="number" data-field="value" data-index="' + i + '" value="' + Number(a.value) + '"></label>' +
        '<label class="field affix-select"><span>选定</span><input type="radio" name="' + c.role + '-selected" data-field="selected" data-index="' + i + '" value="' + i + '"' + (c.selected === i ? ' checked' : '') + '></label>' +
        '<button type="button" class="tool-remove" data-remove="' + i + '" aria-label="删除词缀">×</button></div>';
    }).join('');
    return '<div class="toolbar slot-fields">' +
      '<label class="field"><span>部位</span><select data-field="part">' + partOpts + '</select></label>' +
      '<label class="field"><span>底材</span><select data-field="base">' + baseOpts + '</select></label>' +
      '<label class="field"><span>品质</span><select data-field="quality">' + qualityOpts + '</select></label>' +
      '</div><div class="affix-list">' + rows + '</div><div class="toolbar"><button type="button" data-add-affix>＋ 添加词条</button></div>';
  }  function renderEditors() {
    ['main','sub'].forEach(function (role) {
      const c = state[role], root = $(role + '-editor');
      root.innerHTML = editorHTML(c);
      root.prepend(WikiInventory.picker(c.part, function (item) {
        state[role] = { part:item.part, baseId:item.baseId, quality:item.quality, affixes:item.affixes.map(a => Object.assign({}, a)), selected:0, role:role };
        renderAll();
      }));
      root.querySelectorAll('[data-field]').forEach(function (input) {
        input.addEventListener('change', function () {
          const field = input.getAttribute('data-field');
          if (field === 'part') {
            c.part = input.value; const b = basesFor(c.part)[0]; c.baseId = b.id; c.affixes = [{ type:b.pool[0].type, value:b.pool[0].min, src:null, srcExplicit:false }]; c.selected = 0;
          } else if (field === 'base') c.baseId = input.value;
          else if (field === 'quality') c.quality = input.value;
          else if (field === 'selected') c.selected = input.value === '' ? null : Number(input.value);
          else if (field === 'type') c.affixes[Number(input.getAttribute('data-index'))].type = input.value;
          else if (field === 'value') c.affixes[Number(input.getAttribute('data-index'))].value = Number(input.value);
          renderAll();
        });
      });
      root.querySelector('[data-add-affix]').addEventListener('click', function () {
        const t = GameData.AFFIX_TYPES.find(x => !c.affixes.some(a => a.type === x)); if (!t) return;
        c.affixes.push({ type:t, value:0, src:null, srcExplicit:false }); c.selected = 0; renderAll();
      });
      root.querySelectorAll('[data-remove]').forEach(function (b) {
        b.addEventListener('click', function () { const i=Number(b.getAttribute('data-remove')); c.affixes.splice(i,1); c.selected=Math.min(c.selected||0,Math.max(0,c.affixes.length-1)); renderAll(); });
      });
    });
  }
  function materialList() {
    return Object.keys(state.materials).filter(id => state.materials[id] > 0).map(id => ({ id:id, qty:state.materials[id] }));
  }
  function plan() {
    if (!state.snapshot || Wiki.unavailable) return { errors:['当前规则快照不可用，禁止使用默认值计算。'] };
    const mainAffix = state.main.affixes[state.main.selected || 0];
    const subAffix = state.sub.affixes[state.sub.selected || 0];
    for (const item of [state.main, state.sub]) {
      if (item.affixes.some(a => !Number.isFinite(a.value) || !Number.isInteger(a.value))) return { errors:['词条数值需要是有效整数'] };
      if (new Set(item.affixes.map(a => a.type)).size !== item.affixes.length) return { errors:['同一组件的词条类型不能重复'] };
    }
    const shared = GameData.smeltPlanOf({
      mainId: GameData.instanceId(state.main.baseId, state.main.quality, state.main.affixes),
      subId: GameData.instanceId(state.sub.baseId, state.sub.quality, state.sub.affixes),
      mainAffix: mainAffix && mainAffix.type, subAffix: subAffix && subAffix.type,
      materials: materialList(), pearl: $('pearl').checked, relics: Number($('relics').value)
    });
    if (shared.error) return { errors:[shared.error] };
    return Object.assign({}, shared, {
      shared: shared, errors: [], probs: GameData.smeltSuccessProbs(shared.rates, !!shared.extraType),
      ranges: { main: { range: shared.ranges.main }, sub: { range: shared.ranges.sub }, add: shared.ranges.add ? { range: shared.ranges.add } : null }
    });
  }
  function inventoryCosts(p) {
    const snapshot = WikiInventory.snapshot;
    if (!snapshot || p.errors.length) return '';
    const needs = {};
    p.shared.consume.forEach(m => { needs[m.id] = (needs[m.id] || 0) + m.qty; });
    let html = '<details class="sm-details"><summary>背包资源参考（不扣除）</summary><p>金币：需要 ' + p.gold + ' / 持有 ' + Wiki.fmt(snapshot.coins, 0) + '</p>';
    Object.entries(needs).forEach(([id, need]) => {
      const name = (GameData.MATERIALS.find(m => m.id === id) || {}).name || id;
      html += '<p>' + escapeHTML(name) + '：需要 ' + need + ' / 背包 ' + (Number(snapshot.inventory[id]) || 0) + '</p>';
    });
    return html + '<p>每次独立试验，不累计扣减；已装备组件也可复制试算。</p></details>';
  }
  function previewHTML(p) {
    if (p.errors.length) return '<ul class="warning">' + p.errors.map(e => '<li>' + escapeHTML(e) + '</li>').join('') + '</ul>';
    const cfg = p.cfg;
    return '<table><tbody>' +
      row('熔炼成功率', p.rates.rate + '%') + row('条件补缀率', p.rates.extraRate + '%') +
      row('补缀落成率', p.probs.add + '%') + row('完全成功', p.probs.full + '%') +
      row('池外保留率', p.retainChance + '%') + row('金币', p.gold) +
      row('投料', p.load.total + ' 份 / ' + p.load.types + ' 种') +
      row('主件词缀区间', rangeText(p.ranges.main)) + row('副件词缀区间', rangeText(p.ranges.sub)) +
      (p.ranges.add ? row('补缀区间', rangeText(p.ranges.add)) : '') +
      '</tbody></table><p class="muted">完全成功不包含池外保留；失败时若投入保护残片，主件全部词缀保留（不投入则移除主选词条）。</p>';
  }
  function row(k, v) { return '<tr><th>' + k + '</th><td>' + escapeHTML(v) + '</td></tr>'; }
  function rangeText(r) { return r && r.range ? r.range[0] + ' ~ ' + r.range[1] : '-'; }
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function simulateOnce(p, rng) {
    const out = GameData.simulateSmeltPlan(p.shared, rng);
    const item = out.result || out.mainAfter;
    return {
      success: out.success, extraOk: out.extraOk, retainOk: out.retainOk,
      protected: out.protectAffix, gold: p.gold, removedType: out.removedAffix,
      retained: out.retained.map(a => a.type),
      item: { baseId: item.baseId, quality: item.quality, affixes: item.affixes.map(a => Object.assign({}, a)) },
      costs: { materials: p.load.total, pearl: p.pearl, relics: p.relics }
    };
  }
  function outcomeHTML(o, p) {
    return '<p>' + (o.success ? '<strong class="positive">熔炼成功</strong>' : '<strong class="negative">熔炼失败' + (o.protected ? '（残片保护）</strong>' : '</strong>')) +
      (o.extraOk ? ' · 补缀命中' : '') + (o.retainOk ? ' · 池外保留命中' : '') + '</p>' +
      '<p>模拟消耗（不扣库存）：金币 ' + o.gold + '，副件 1' + (o.costs.materials ? '，投料 ' + o.costs.materials + ' 份' : '') + (o.costs.pearl ? '，龙宫宝珠 1' : '') + (o.costs.relics ? '，残片 ' + o.costs.relics + ' 片' : '') + '</p>' +
      '<p>结果词缀：' + (o.item.affixes.map(a => GameData.AFFIX_LABEL[a.type] + ' ' + a.value).join(' · ') || '无') + '</p>' +
      (o.removedType ? '<p class="warning">失败时移除主件词缀：' + GameData.AFFIX_LABEL[o.removedType] + '</p>' : '');
  }
  function materialReason(m) {
    if (!state.snapshot || Wiki.unavailable) return '规则暂不可用';
    const main = state.main.affixes[state.main.selected || 0];
    const sub = state.sub.affixes[state.sub.selected || 0];
    if (!main || !sub) return '先选两条词条';
    if (main.type === sub.type) return '主副词条不能相同';
    if (state.main.part !== state.sub.part) return '主副组件需同部位';
    if (GameData.smeltAddAffixCap() < 3) return '词条数已达上限';
    const addable = GameData.smeltAddableAffixes(state.main.baseId, [main.type, sub.type]);
    if (!addable.includes(GameData.smeltMaterialAffix(m.id))) return '该词条无法新增';
    return '';
  }
  function fitMaterials() {
    if (!state.snapshot || Wiki.unavailable) return;
    const cfg = GameData.getSmeltCfg(), next = {};
    let total = 0, types = 0;
    (state.snapshot.catalog.smeltMaterials || []).forEach(function (m) {
      const qty = !materialReason(m) && types < cfg.maxTypes
        ? Math.max(0, Math.min(Math.floor(Number(state.materials[m.id]) || 0), cfg.maxMaterials - total)) : 0;
      if (qty) { next[m.id] = qty; total += qty; types++; }
    });
    const changed = Object.keys(state.materials).some(id => state.materials[id] !== (next[id] || 0));
    state.materials = next;
    $('material-note').textContent = changed ? '已移除不适用或超出当前上限的投料。' : '';
  }
  function materialCapacity(m) {
    const cfg = GameData.getSmeltCfg(), load = GameData.smeltLoadOf(materialList());
    const qty = state.materials[m.id] || 0;
    if (materialReason(m) || (!qty && load.types >= cfg.maxTypes)) return 0;
    return Math.max(0, cfg.maxMaterials - load.total + qty);
  }
  function refreshMaterialControls() {
    const cfg = GameData.getSmeltCfg(), mats = state.snapshot ? state.snapshot.catalog.smeltMaterials || [] : [];
    const load = GameData.smeltLoadOf(materialList());
    $('material-open').disabled = !state.snapshot || Wiki.unavailable;
    $('material-limit').textContent = '最多 ' + cfg.maxMaterials + ' 份 / ' + cfg.maxTypes + ' 种 · 投入最多的材料决定新增词条';
    $('material-summary').textContent = load.total ? load.total + ' 份 · 新增' + GameData.AFFIX_LABEL[load.dominant] + ' ↗' : '添加材料 ↗';
    $('material-images').innerHTML = mats.filter(m => state.materials[m.id]).map(m => '<img src="/assets/item/' + escapeHTML(m.id) + '.png" alt="' + escapeHTML(m.name) + '">').join('');
    $('material-feedback').textContent = load.total ? '已选 ' + load.total + ' 份 / ' + load.types + ' 种 · 补' + GameData.AFFIX_LABEL[load.dominant] : '尚未选择材料';
    mats.forEach(function (m) {
      const input = document.querySelector('[data-material="' + m.id + '"]');
      if (!input) return;
      const row = input.closest('.ws-mat'), qty = state.materials[m.id] || 0;
      const capacity = materialCapacity(m), reason = materialReason(m);
      input.value = qty; input.max = capacity; input.disabled = !!reason || capacity === 0;
      row.classList.toggle('selected', qty > 0); row.classList.toggle('unavailable', !!reason || capacity === 0);
      row.querySelector('[data-delta="-1"]').disabled = qty === 0 || Wiki.unavailable;
      row.querySelector('[data-delta="1"]').disabled = qty >= capacity;
      row.querySelector('.wm-have').textContent = (WikiInventory.quantity(m.id) === null ? '' : '背包 ' + WikiInventory.quantity(m.id) + ' · ') + (reason || (!qty && load.types >= cfg.maxTypes ? '已达种类上限' : qty >= capacity ? '已达份数上限' : '可补入'));
    });
  }
  function setMaterial(m, value) {
    const requested = Number(value);
    const qty = Math.max(0, Math.min(materialCapacity(m), Number.isFinite(requested) ? Math.floor(requested) : 0));
    if (qty) state.materials[m.id] = qty; else delete state.materials[m.id];
    $('material-note').textContent = '';
    refreshMaterialControls(); refreshPreview();
  }
  function renderMaterials() {
    const mats = state.snapshot.catalog.smeltMaterials || [];
    $('materials').innerHTML = mats.map(function (m) {
      return '<div class="ws-mat"><img class="sm-material-icon" src="/assets/item/' + escapeHTML(m.id) + '.png" alt="">' +
        '<div class="sm-mat-info"><strong>' + escapeHTML(m.name) + '</strong><span>' + escapeHTML(m.affixName) + '</span><small class="wm-have"></small></div>' +
        '<div class="sm-counter"><button type="button" data-delta="-1" aria-label="减少' + escapeHTML(m.name) + '">−</button>' +
        '<input class="ipt ws-mat-qty" type="number" min="0" step="1" value="0" data-material="' + escapeHTML(m.id) + '" aria-label="' + escapeHTML(m.name) + '份数">' +
        '<button type="button" data-delta="1" aria-label="增加' + escapeHTML(m.name) + '">＋</button></div></div>';
    }).join('');
    mats.forEach(function (m) {
      const input = document.querySelector('[data-material="' + m.id + '"]');
      input.addEventListener('input', function () { setMaterial(m, input.value); });
      input.addEventListener('change', function () { setMaterial(m, input.value); });
      input.closest('.ws-mat').querySelectorAll('[data-delta]').forEach(function (b) {
        b.addEventListener('click', function () { setMaterial(m, (state.materials[m.id] || 0) + Number(b.dataset.delta)); });
      });
    });
  }
  function refreshPreview() {
    const p = plan();
    $('preview').innerHTML = previewHTML(p) + inventoryCosts(p);
    if (state.lastOutcome && !p.errors.length) $('single-result').innerHTML = outcomeHTML(state.lastOutcome, p);
  }
  function renderAll() {
    fitMaterials(); renderEditors(); refreshMaterialControls(); refreshPreview();
  }
  function runBatch(count, seed) {
    const p = plan(); if (p.errors.length) { $('batch-result').innerHTML = previewHTML(p); return; }
    const rng = mulberry32(seed), stats = { n:count, success:0, extra:0, retain:0, actualRetain:0, protectedFail:0, removed:0, counts:{}, byType:{} };
    let i = 0; state.batch = { running:true, cancel:false };
    $('batch-start').disabled = true; $('batch-cancel').disabled = false; $('batch-progress').max = count; $('batch-progress').value = 0;
    function chunk() {
      if (state.batch.cancel) { finish('已取消'); return; }
      const end = Math.min(count, i + 200);
      for (; i < end; i++) {
        const o = simulateOnce(p, rng);
        if (o.success) stats.success++; else if (o.protected) stats.protectedFail++; else stats.removed++;
        if (o.extraOk) stats.extra++;
        if (o.retainOk) stats.retain++;
        if (o.retained.length) stats.actualRetain++;
        const n = o.item.affixes.length; stats.counts[n] = (stats.counts[n] || 0) + 1;
        // 词缀数值按类型分别统计：不同词缀的数值量纲不同（钓速 +%、技巧 +点…），混在一起求均值没有意义
        o.item.affixes.forEach(a => { (stats.byType[a.type] = stats.byType[a.type] || []).push(a.value); });
      }
      $('batch-progress').value = i;
      if (i < count) { setTimeout(chunk, 0); return; }
      finish('完成');
    }
    function finish(label) {
      state.batch.running = false; $('batch-start').disabled = false; $('batch-cancel').disabled = true;
      const typeMeans = Object.keys(stats.byType).sort().map(function (t) {
        const arr = stats.byType[t], mean = arr.reduce((a, b) => a + b, 0) / arr.length;
        return (GameData.AFFIX_LABEL[t] || t) + ' ' + mean.toFixed(2) + '（n=' + arr.length + '）';
      }).join(' · ') || '-';
      $('batch-result').innerHTML = '<p>' + label + '：' + stats.n + ' 次独立试验 · 种子 ' + seed + '</p><table><tbody>' +
        row('熔炼成功', stats.success + ' / ' + pct(stats.success, stats.n)) + row('补缀命中', stats.extra + ' / ' + pct(stats.extra, stats.n)) +
        row('保留判定命中', stats.retain + ' / ' + pct(stats.retain, stats.n)) + row('实际追加池外', stats.actualRetain + ' / ' + pct(stats.actualRetain, stats.n)) +
        row('失败且保护', stats.protectedFail) + row('失败且移除词缀', stats.removed) +
        row('词缀数分布', Object.keys(stats.counts).sort().map(k => k + ':' + stats.counts[k]).join(' · ')) +
        row('词缀数值均值（按类型）', typeMeans) + row('总金币', stats.n * p.gold) + '</tbody></table>' +
        '<p class="muted">批量是同一输入的独立重复试验，不代表连续强化同一件主件，也不估算真实库存。</p>';
    }
    setTimeout(chunk, 0);
  }
  function pct(a, b) { return b ? (a / b * 100).toFixed(2) + '%' : '-'; }
  // 单次模拟也要可复现：同样的输入 + 同样的种子必然得到同样的结果。
  // 种子为空 / 非法时随机生成一个并写回输入框，玩家可抄下复现。
  function singleSeed() {
    const el = $('single-seed'); if (!el) return Math.floor(Math.random() * 0xFFFFFFFF);
    let v = Number(el.value);
    if (!isFinite(v) || v < 0) { v = Math.floor(Math.random() * 0xFFFFFFFF); el.value = String(v); }
    return Math.floor(v) >>> 0;
  }
  function init() {
    state.main = defaultComponent('main'); state.sub = defaultComponent('sub');
    WikiInventory.mount($('inventory-panel'), renderAll);
    $('use-result').addEventListener('click', function () {
      if (!state.lastOutcome) return;
      const item = state.lastOutcome.item;
      state.main = { part:GameData.componentBase(item.baseId).part, baseId:item.baseId, quality:item.quality, affixes:item.affixes.map(a => Object.assign({}, a)), selected:0, role:'main' };
      renderAll();
    });
    const dialog = $('material-dialog');
    $('material-open').addEventListener('click', function () {
      fitMaterials(); refreshMaterialControls(); refreshPreview(); dialog.showModal(); $('material-close').focus();
    });
    $('material-close').addEventListener('click', function () { dialog.close(); });
    $('material-done').addEventListener('click', function () { dialog.close(); });
    dialog.addEventListener('close', function () { $('material-open').focus(); });
    dialog.addEventListener('click', function (e) {
      const r = dialog.getBoundingClientRect();
      if (e.target === dialog && (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom)) dialog.close();
    });
    $('simulate-once').addEventListener('click', function () {
      const p = plan(); if (p.errors.length) { $('single-result').innerHTML = previewHTML(p); return; }
      const seed = singleSeed();
      state.lastOutcome = simulateOnce(p, mulberry32(seed)); $('single-result').innerHTML = '<p class="muted">种子 ' + seed + '</p>' + outcomeHTML(state.lastOutcome, p); $('use-result').disabled = false;
    });
    $('send-to-build').addEventListener('click', function () {
      if (!state.lastOutcome) { $('single-result').innerHTML = '<p class="warning">请先模拟一次。</p>'; return; }
      const ok = Wiki.storage.writeJSON(SMELT_RESULT_KEY, state.lastOutcome.item);
      $('single-result').innerHTML = (ok ? '<p class="positive">已写入本地，可到配装模拟器点击“读取熔炼产物”。</p>' : '<p class="warning">浏览器存储不可用。</p>') + outcomeHTML(state.lastOutcome, plan());
    });
    $('batch-start').addEventListener('click', function () { runBatch(Math.max(1, Math.min(10000, Number($('batch-count').value) || 1000)), Math.floor(Math.random() * 0xFFFFFFFF)); });
    $('batch-cancel').addEventListener('click', function () { state.batch.cancel = true; });
    $('relics').addEventListener('change', renderAll);
    $('pearl').addEventListener('change', renderAll);
    Wiki.onChange(function (s, unavailable) {
      const r=$('status-card'); r.className='status-card ' + (unavailable ? 'status-bad' : 'status-ok'); r.innerHTML='<div class="status-line"><span class="status-dot"></span>' + (unavailable ? '规则不可用' : '规则可用') + '</div><p class="status-message">' + (unavailable ? '无法确认最新规则，数值与模拟器已禁用。' : '已连接当前服务端规则快照。') + '</p>';
      const key = s ? s.snapshotId : '';
      const changed = key !== state.lastWikiKey || unavailable !== state.lastUnavailable;
      state.lastWikiKey = key; state.lastUnavailable = unavailable;
      if (s && !unavailable) {
        state.snapshot=s; GameData.setComponentCfg(s.rulesConfig.componentCfg); GameData.setSmeltCfg(s.rulesConfig.smeltCfg);
        if (changed) renderMaterials();
      }
      if (changed) renderAll();
    });
    Wiki.init().catch(function (e) { console.error(e); });
  }
  document.addEventListener('DOMContentLoaded', init);
})();

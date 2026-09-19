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
      return '<div class="affix-row"><select data-field="type" data-index="' + i + '">' + types + '</select><input type="number" data-field="value" data-index="' + i + '" value="' + Number(a.value) + '"><span class="muted">#' + (i + 1) + '</span><button data-remove="' + i + '">删</button></div>';
    }).join('');
    const selectedOpts = (c.affixes || []).map(function (a, i) { return option(String(i), GameData.AFFIX_LABEL[a.type] + ' ' + a.value, i === c.selected); }).join('');
    return '<div class="toolbar"><select data-field="part">' + partOpts + '</select><select data-field="base">' + baseOpts + '</select><select data-field="quality">' + qualityOpts + '</select><select data-field="selected"><option value="">选择保留词缀</option>' + selectedOpts + '</select></div>' + rows + '<div class="toolbar"><button data-add-affix>加词缀</button></div>';
  }
  function renderEditors() {
    ['main','sub'].forEach(function (role) {
      const c = state[role], root = $(role + '-editor');
      root.innerHTML = editorHTML(c);
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
    const out = [];
    document.querySelectorAll('[data-material]').forEach(function (input) {
      const n = Math.max(0, Math.floor(Number(input.value) || 0));
      if (n) out.push({ id:input.getAttribute('data-material'), qty:n });
    });
    return out;
  }
  function plan() {
    if (!state.snapshot || Wiki.unavailable) return { errors:['当前规则快照不可用，禁止使用默认值计算。'] };
    const cfg = GameData.getSmeltCfg();
    const materials = materialList();
    const mainAffix = state.main.affixes[state.main.selected == null ? 0 : state.main.selected];
    const subAffix = state.sub.affixes[state.sub.selected == null ? 0 : state.sub.selected];
    const errors = [];
    if (!mainAffix) errors.push('主件需要选择一条词缀');
    if (!subAffix) errors.push('副件需要选择一条词缀');
    if (mainAffix && subAffix && mainAffix.type === subAffix.type) errors.push('主副件选择的词缀类型不能相同');
    const load = GameData.smeltLoadOf(materials);
    if (load.total > cfg.maxMaterials) errors.push('投料超过上限 ' + cfg.maxMaterials);
    if (load.types > cfg.maxTypes) errors.push('投料种类超过上限 ' + cfg.maxTypes);
    let extraType = null;
    if (load.total > 0 && mainAffix && subAffix) {
      extraType = load.dominant;
      const addable = GameData.smeltAddableAffixes(state.main.baseId, [mainAffix.type, subAffix.type]);
      if (!extraType || addable.indexOf(extraType) < 0) errors.push('投料对应的补缀词缀不可用');
      else if (2 + 1 > GameData.smeltAddAffixCap()) errors.push('补缀后超过词条数上限');
    }
    const extraAffixes = GameData.smeltExtraAffixesOf(state.main.baseId, state.main.affixes);
    const relics = Math.max(0, Math.floor(Number($('relics').value) || 0));
    if (relics > cfg.retainMaxRelic) errors.push('保护残片超过上限 ' + cfg.retainMaxRelic);
    if (relics > 0 && (!GameData.canRecast({ kind:'component', quality:state.main.quality }) || !extraAffixes.length)) errors.push('当前主件不能使用保护残片');
    const pearl = $('pearl').checked;
    const rates = GameData.smeltRatesOf(load, pearl);
    const gold = GameData.smeltGoldOf(load, pearl);
    const probs = GameData.smeltSuccessProbs(rates, !!extraType);
    const retainChance = GameData.smeltRetainChance(relics, GameData.breakthroughCountOf(state.main.affixes));
    let ranges = null;
    if (mainAffix && subAffix) {
      const mainRange = GameData.smeltRangeEx(state.main.baseId, state.sub.baseId, 'main', mainAffix.type, { part:state.main.part, src:mainAffix.src, srcExplicit:mainAffix.srcExplicit });
      const subRange = GameData.smeltRangeEx(state.main.baseId, state.sub.baseId, 'sub', subAffix.type, { part:state.sub.part, src:subAffix.src, srcExplicit:subAffix.srcExplicit });
      const addRange = extraType ? GameData.smeltRangeEx(state.main.baseId, state.sub.baseId, 'add', extraType, { part:state.main.part }) : null;
      ranges = { main:mainRange, sub:subRange, add:addRange };
    }
    return { errors:errors, cfg:cfg, materials:materials, load:load, mainAffix:mainAffix, subAffix:subAffix, extraType:extraType, extraAffixes:extraAffixes, relics:relics, pearl:pearl, rates:rates, gold:gold, probs:probs, retainChance:retainChance, ranges:ranges };
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
      '</tbody></table><p class="muted">完全成功不包含池外保留；失败时若投入保护残片，主件选中词缀也会保留。</p>';
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
  function rollValue(range, pearl, cfg, rng) {
    if (!range || !range.range) return 0;
    if (pearl && cfg.pearlRollTwice) return GameData.rollAffixValueBoundaryWithRng(range.range[0], range.range[1], GameData.getComponentCfg().rollModel, rng);
    return GameData.rollAffixValueWithRng(range.range[0], range.range[1], GameData.getComponentCfg().rollModel, rng);
  }
  function simulateOnce(p, rng) {
    const success = rng() * 100 < p.rates.rate;
    const result = { success:success, extraOk:false, retainOk:false, protected:!success && p.relics > 0, gold:p.gold, item:null, removedType:null, retained:[] };
    if (success) {
      const affixes = [
        { type:p.mainAffix.type, value:rollValue(p.ranges.main, p.pearl, p.cfg, rng), src:p.ranges.main.src, srcExplicit:p.ranges.main.explicit },
        { type:p.subAffix.type, value:rollValue(p.ranges.sub, p.pearl, p.cfg, rng), src:p.ranges.sub.src, srcExplicit:p.ranges.sub.explicit },
      ];
      if (p.extraType) {
        result.extraOk = rng() * 100 < p.rates.extraRate;
        if (result.extraOk) affixes.push({ type:p.extraType, value:rollValue(p.ranges.add, p.pearl, p.cfg, rng), src:p.ranges.add.src, srcExplicit:p.ranges.add.explicit });
      }
      if (p.relics > 0) {
        result.retainOk = rng() * 100 < p.retainChance;
        if (result.retainOk) {
          const have = {}; affixes.forEach(a => have[a.type] = 1);
          p.extraAffixes.forEach(function (a) { if (have[a.type]) return; have[a.type] = 1; affixes.push({ type:a.type, value:a.value, src:a.src || null, srcExplicit:a.srcExplicit }); result.retained.push(a.type); });
        }
      }
      result.item = { baseId:state.main.baseId, quality:state.main.quality, affixes:affixes };
    } else {
      const left = state.main.affixes.filter(a => p.relics > 0 || a.type !== p.mainAffix.type).map(a => ({ type:a.type, value:a.value, src:a.src || null, srcExplicit:a.srcExplicit }));
      if (p.relics <= 0) result.removedType = p.mainAffix.type;
      result.item = { baseId:state.main.baseId, quality:state.main.quality, affixes:left };
    }
    return result;
  }
  function outcomeHTML(o, p) {
    return '<p>' + (o.success ? '<strong class="positive">熔炼成功</strong>' : '<strong class="negative">熔炼失败' + (o.protected ? '（残片保护）</strong>' : '</strong>')) +
      (o.extraOk ? ' · 补缀命中' : '') + (o.retainOk ? ' · 池外保留命中' : '') + '</p>' +
      '<p>消耗：金币 ' + o.gold + '，副件 1' + (p.load.total ? '，投料 ' + p.load.total + ' 份' : '') + (p.pearl ? '，龙宫宝珠 1' : '') + (p.relics ? '，残片 ' + p.relics + ' 片' : '') + '</p>' +
      '<p>结果词缀：' + (o.item.affixes.map(a => GameData.AFFIX_LABEL[a.type] + ' ' + a.value).join(' · ') || '无') + '</p>' +
      (o.removedType ? '<p class="warning">失败时移除主件词缀：' + GameData.AFFIX_LABEL[o.removedType] + '</p>' : '');
  }
  function renderMaterials() {
    const mats = state.snapshot.catalog.smeltMaterials || [];
    $('materials').innerHTML = mats.map(function (m) {
      return '<label class="badge">' + escapeHTML(m.name) + ' → ' + escapeHTML(m.affixName) + ' <input type="number" min="0" max="99" value="0" data-material="' + escapeHTML(m.id) + '" style="width:72px"></label>';
    }).join('') + '<p class="muted">残片既可作为普通投料定向“材料概率”，也可在上方单独作为保护残片；两处消耗独立计算。</p>';
    $('materials').querySelectorAll('[data-material]').forEach(function (input) { input.addEventListener('change', renderAll); });
  }
  function renderAll() {
    renderEditors();
    const p = plan();
    $('preview').innerHTML = previewHTML(p);
    if (state.lastOutcome) $('single-result').innerHTML = outcomeHTML(state.lastOutcome, p);
  }
  function runBatch(count, seed) {
    const p = plan(); if (p.errors.length) { $('batch-result').innerHTML = previewHTML(p); return; }
    const rng = mulberry32(seed), stats = { n:count, success:0, extra:0, retain:0, actualRetain:0, protectedFail:0, removed:0, counts:{}, values:[] };
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
        o.item.affixes.forEach(a => stats.values.push(a.value));
      }
      $('batch-progress').value = i;
      if (i < count) { setTimeout(chunk, 0); return; }
      finish('完成');
    }
    function finish(label) {
      state.batch.running = false; $('batch-start').disabled = false; $('batch-cancel').disabled = true;
      const mean = stats.values.length ? (stats.values.reduce((a,b) => a+b, 0) / stats.values.length).toFixed(2) : '-';
      $('batch-result').innerHTML = '<p>' + label + '：' + stats.n + ' 次独立试验 · 种子 ' + seed + '</p><table><tbody>' +
        row('熔炼成功', stats.success + ' / ' + pct(stats.success, stats.n)) + row('补缀命中', stats.extra + ' / ' + pct(stats.extra, stats.n)) +
        row('保留判定命中', stats.retain + ' / ' + pct(stats.retain, stats.n)) + row('实际追加池外', stats.actualRetain + ' / ' + pct(stats.actualRetain, stats.n)) +
        row('失败且保护', stats.protectedFail) + row('失败且移除词缀', stats.removed) +
        row('词缀数分布', Object.keys(stats.counts).sort().map(k => k + ':' + stats.counts[k]).join(' · ')) +
        row('词缀数值均值', mean) + row('总金币', stats.n * p.gold) + '</tbody></table>' +
        '<p class="muted">批量是同一输入的独立重复试验，不代表连续强化同一件主件，也不估算真实库存。</p>';
    }
    setTimeout(chunk, 0);
  }
  function pct(a, b) { return b ? (a / b * 100).toFixed(2) + '%' : '-'; }
  function init() {
    state.main = defaultComponent('main'); state.sub = defaultComponent('sub');
    $('simulate-once').addEventListener('click', function () {
      const p = plan(); if (p.errors.length) { $('single-result').innerHTML = previewHTML(p); return; }
      state.lastOutcome = simulateOnce(p, Math.random); $('single-result').innerHTML = outcomeHTML(state.lastOutcome, p);
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

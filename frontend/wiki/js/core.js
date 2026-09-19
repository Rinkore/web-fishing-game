'use strict';
(function () {
  const state = {
    snapshot: null, etag: null, lastOk: 0, readyPromise: null,
    readyResolve: null, readyReject: null, unavailable: false, listeners: [],
    content: null, contentEtag: null, contentLastOk: 0, contentReadyPromise: null,
    contentReadyResolve: null, contentReadyReject: null
  };
  const D = window.GameData;

  function el(tag, className, text) {
    const n = document.createElement(tag);
    if (className) n.className = className;
    if (text != null) n.textContent = text;
    return n;
  }
  function fmt(n, digits) {
    const v = Number(n);
    if (!isFinite(v)) return '-';
    return v.toLocaleString('zh-CN', { maximumFractionDigits: digits == null ? 1 : digits });
  }
  function pct(n, digits) { return fmt(n, digits == null ? 2 : digits) + '%'; }
  function signed(n) { const v = Number(n) || 0; return (v > 0 ? '+' : '') + fmt(v, 2); }
  function validSnapshot(s) {
    return !!(s && s.schemaVersion === 1 && s.gameVersion && s.rulesVersion === 1 && s.sourceKind === 'server' &&
      /^[0-9a-f]{40}$/.test(s.sourceCommit || '') && s.serverInstanceId &&
      Number(s.configRevision) >= 1 && /^[0-9a-f]{64}$/.test(s.configHash || '') &&
      s.snapshotId && s.generatedAt && !isNaN(Date.parse(s.generatedAt)) &&
      s.catalog && Array.isArray(s.catalog.fish) && Array.isArray(s.catalog.materials) &&
      Array.isArray(s.catalog.components) && Array.isArray(s.catalog.chests) &&
      Array.isArray(s.catalog.rodParts) && Array.isArray(s.grounds) && s.rulesConfig &&
      s.rulesConfig.castCfg && typeof s.rulesConfig.biteFormula === 'string');
  }
  function applyRules(s) {
    if (!D) throw new Error('共享规则模块未加载');
    if (D.setComponentCfg) D.setComponentCfg(s.rulesConfig.componentCfg);
    if (D.setSmeltCfg) D.setSmeltCfg(s.rulesConfig.smeltCfg);
    if (D.setFishCfg) D.setFishCfg(s.rulesConfig.fishCfg);
  }
  function renderStatus() {
    const node = document.querySelector('[data-rule-status]');
    if (!node) return;
    const s = state.snapshot;
    node.classList.toggle('ok', !!s && !state.unavailable);
    node.classList.toggle('bad', !s || state.unavailable);
    const dot = node.querySelector('.rule-dot');
    if (dot) dot.setAttribute('aria-hidden', 'true');
    const text = node.querySelector('.rule-text');
    if (!text) return;
    if (state.unavailable || !s) text.textContent = '规则不可用：数值与模拟器已禁用，等待服务端确认。';
    else text.textContent = '规则可用 · ' + s.gameVersion + ' · 配置 ' + s.configRevision + ' · ' + s.configHash.slice(0, 12) + ' · ' + new Date(s.generatedAt).toLocaleString('zh-CN');
  }
  function emit() {
    renderStatus();
    state.listeners.slice().forEach(function (fn) {
      try { fn(state.snapshot, state.unavailable); } catch (e) { console.error(e); }
    });
  }
  async function refresh() {
    const headers = {};
    if (state.etag) headers['If-None-Match'] = state.etag;
    try {
      const res = await fetch('/api/version?profile=wiki', { headers: headers, cache: 'no-cache' });
      if (res.status === 304) {
        state.lastOk = Date.now(); state.unavailable = false; emit(); return;
      }
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      if (!data || data.profile !== 'wiki' || !validSnapshot(data.snapshot)) throw new Error('规则快照结构无效');
      state.etag = res.headers.get('ETag');
      state.snapshot = data.snapshot;
      applyRules(data.snapshot);
      state.lastOk = Date.now(); state.unavailable = false;
      if (state.readyResolve) { state.readyResolve(state.snapshot); state.readyResolve = null; state.readyReject = null; }
      state.readyPromise = null;
      emit();
    } catch (e) {
      state.unavailable = true; emit();
      if (state.readyReject) { state.readyReject(e); state.readyReject = null; state.readyResolve = null; }
      state.readyPromise = null;
    }
  }
  function checkStale() {
    if (state.snapshot && !state.unavailable && state.lastOk && Date.now() - state.lastOk > 10000) {
      state.unavailable = true; emit();
    }
  }
  // 公开内容接口只下发攻略元数据；正文段落由 /api/wiki/guides/<id> 按需加载，
  // 所以 sections 允许缺省，但出现时必须是合法结构。
  function validContent(data) {
    return !!(data && Array.isArray(data.guides) && data.guides.length &&
      Array.isArray(data.updates) && data.guides.every(function (g) {
        return g && typeof g.id === 'string' && typeof g.title === 'string' &&
          (g.sections === undefined || (Array.isArray(g.sections) && g.sections.every(function (x) { return x && typeof x.h === 'string'; })));
      }));
  }
  function applyContent(data) {
    if (!validContent(data)) throw new Error('Wiki 内容结构无效');
    state.content = {
      revision: Math.max(0, Math.floor(Number(data.revision) || 0)),
      updatedAt: data.updatedAt || '',
      guides: data.guides,
      updates: data.updates
    };
    window.WikiContent = state.content;
    state.contentLastOk = Date.now();
    if (state.contentReadyResolve) {
      state.contentReadyResolve(state.content);
      state.contentReadyResolve = null; state.contentReadyReject = null;
    }
    state.contentReadyPromise = null;
    emit();
  }
  async function loadFallbackContent() {
    const res = await fetch('/wiki/content/content.json', { cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    applyContent(await res.json());
  }
  async function refreshContent() {
    const headers = {};
    if (state.contentEtag) headers['If-None-Match'] = state.contentEtag;
    try {
      const res = await fetch('/api/wiki/content', { headers: headers, cache: 'no-cache' });
      if (res.status === 304) {
        state.contentLastOk = Date.now(); return;
      }
      if (!res.ok) throw new Error('HTTP ' + res.status);
      state.contentEtag = res.headers.get('ETag');
      applyContent(await res.json());
    } catch (e) {
      if (!state.content) {
        try { await loadFallbackContent(); return; } catch (e2) {}
      }
      if (state.contentReadyReject) {
        state.contentReadyReject(e);
        state.contentReadyReject = null; state.contentReadyResolve = null;
      }
      state.contentReadyPromise = null;
    }
  }
  function contentReady() {
    if (state.content) return Promise.resolve(state.content);
    if (!state.contentReadyPromise) {
      state.contentReadyPromise = new Promise(function (resolve, reject) {
        state.contentReadyResolve = resolve; state.contentReadyReject = reject;
      });
      refreshContent();
    }
    return state.contentReadyPromise;
  }
  function qualityNameOf(q) {
    const list = (D && D.QUALITY) || {};
    return (list[q] && list[q].name) || String(q || '');
  }
  function partNameOf(p) {
    const x = D && D.ROD_PARTS && D.ROD_PARTS.find(function (it) { return it.key === p; });
    return x ? x.name : String(p || '');
  }
  function affixLabelOf(t) { return (D && D.AFFIX_LABEL && D.AFFIX_LABEL[t]) || String(t || ''); }
  function stripHtml(v) { return String(v || '').replace(/<[^>]*>/g, ''); }
  function rangeTextOf(pool) {
    const a = Number(pool && pool.min), b = Number(pool && pool.max);
    if (!isFinite(a) || !isFinite(b)) return '-';
    const sign = function (v) { return (v > 0 ? '+' : '') + v; };
    return sign(a) + '～' + sign(b);
  }
  // 目录条目：渔获 / 材料 / 组件底材 / 宝匣 / 词缀类型。desc 用于搜索结果一行摘要。
  // 攻略详情缓存：按内容 revision 失效，避免列表轮询反复拉正文。
  const guideDetails = { revision: null, items: {} };
  function ensureGuideCacheRevision() {
    const rev = state.content ? String(state.content.revision || '') : '';
    if (guideDetails.revision !== rev) { guideDetails.revision = rev; guideDetails.items = {}; }
  }
  async function loadGuide(id) {
    const gid = String(id || '');
    if (!gid) throw new Error('攻略 ID 为空');
    ensureGuideCacheRevision();
    if (guideDetails.items[gid]) return guideDetails.items[gid];
    const res = await fetch('/api/wiki/guides/' + encodeURIComponent(gid), { cache: 'no-store' });
    if (res.status === 404) throw new Error('攻略不存在或未公开');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    if (!data || !data.guide || data.guide.id !== gid || !Array.isArray(data.guide.sections) || !data.guide.sections.length) throw new Error('攻略详情结构无效');
    guideDetails.items[gid] = data.guide;
    return data.guide;
  }
  function itemEntries(s) {
    const out = [];
    (s.catalog.fish || []).forEach(function (x) {
      const size = Array.isArray(x.size) ? x.size : null;
      out.push(Object.assign({}, x, { kind: 'fish', type: 'fish',
        desc: '渔获 · ' + qualityNameOf(x.rarity) + (size ? ' · 体型 ' + size[0] + '～' + size[1] + ' cm' : '') + (x.price != null ? ' · 基准价 ' + x.price : '') }));
    });
    (s.catalog.materials || []).forEach(function (x) {
      out.push(Object.assign({}, x, { kind: 'material', type: 'material',
        desc: '材料 · ' + qualityNameOf(x.rarity) + (x.price != null ? ' · 基准价 ' + x.price : '') }));
    });
    (s.catalog.components || []).forEach(function (x) {
      const pool = (x.pool || []).map(function (p) { return affixLabelOf(p.type) + ' ' + rangeTextOf(p); }).join('、');
      out.push(Object.assign({}, x, { kind: 'component', type: 'component',
        desc: '组件底材 · ' + partNameOf(x.part) + (pool ? ' · 词缀池：' + pool : '') }));
    });
    (s.catalog.chests || []).forEach(function (x) {
      out.push(Object.assign({}, x, { kind: 'chest', type: 'chest', desc: '宝匣 · ' + stripHtml(x.desc) }));
    });
    Object.keys(s.catalog.affixes || {}).forEach(function (id) {
      out.push({ id: 'affix:' + id, affixType: id, name: s.catalog.affixes[id], kind: 'affix', type: 'affix', rarity: null,
        desc: '词缀类型 · 可出现在组件上；具体数值区间以配装/熔炼模拟器为准。' });
    });
    return out;
  }
  function imageFor(entry) {
    if (!entry || !entry.id) return '';
    if (entry.kind === 'fish') return '../../assets/fish/' + encodeURIComponent(entry.id) + '.png';
    if (entry.kind === 'component' || entry.kind === 'material' || entry.kind === 'chest') return '../../assets/item/' + encodeURIComponent(entry.id) + '.png';
    if (entry.kind === 'ground' && entry.id === 'map') return '../../assets/worldmap.png';
    if (entry.kind === 'ground') return '../../assets/ground/' + encodeURIComponent(entry.id) + '.png';
    if (entry.kind === 'spot') {
      const id = entry.spotId || entry.id;
      if (['dock','reed','deep','beach','reef','shoal','pier','fall','eddy'].includes(id)) return '../../assets/spot/' + encodeURIComponent(id) + '.png';
      if (id === 'falls') return '../../assets/spot/fall.png';
      return ['shore','trench'].includes(id) ? '../../assets/voyagemap.png' : '../../assets/worldmap.png';
    }
    return '';
  }

  function itemUrl(id) { return '/wiki/search/index.html?item=' + encodeURIComponent(id); }
  function spotUrl(groundId, spotId) {
    return '/wiki/grounds/index.html?ground=' + encodeURIComponent(groundId) + (spotId ? '&spot=' + encodeURIComponent(spotId) : '');
  }
  function groundEntries(s) {
    const out = [];
    (s.grounds || []).forEach(function (g) {
      out.push({ id: g.id, name: g.name, kind: 'ground', type: 'ground', desc: g.desc, rarity: null, ground: g });
      (g.spots || []).forEach(function (sp) { out.push({ id: g.id + ':' + sp.id, name: g.name + ' · ' + sp.name, kind: 'spot', type: 'spot', desc: sp.desc || g.desc, rarity: null, groundId: g.id, spotId: sp.id }); });
    });
    return out;
  }
  function guideEntries() {
    return (window.WikiContent ? window.WikiContent.guides : []).map(function (g) {
      return { id: g.id, name: g.title, kind: 'guide', type: 'guide', desc: g.summary + (g.authorName ? ' · 作者 ' + g.authorName : ''), category: g.category || '', aliases: g.aliases || [], tags: g.tags || [], rarity: null };
    });
  }
  function toolEntries() {
    return [
      { id: 'build', name: '配装模拟器', kind: 'tool', type: 'tool', desc: '七部位编辑、钓点条件、双方案对比、保存与分享。', rarity: null },
      { id: 'smelt', name: '熔炼模拟器', kind: 'tool', type: 'tool', desc: '主副件词缀、投料、宝珠、残片、概率和批量模拟。', rarity: null }
    ];
  }
  function searchIndex(s) {
    const out = [];
    groundEntries(s).forEach(function (x) {
      out.push(Object.assign({}, x, { url: x.kind === 'ground' ? spotUrl(x.id) : spotUrl(x.groundId, x.spotId), image: imageFor(x) }));
    });
    itemEntries(s).forEach(function (x) {
      out.push(Object.assign({}, x, { url: itemUrl(x.id), image: imageFor(x) }));
    });
    guideEntries().forEach(function (x) { out.push(Object.assign({}, x, { url: '/wiki/guides/index.html?slug=' + encodeURIComponent(x.id), image: '', icon: '📖' })); });
    toolEntries().forEach(function (x) { out.push(Object.assign({}, x, { url: '/wiki/tools/' + x.id + '.html', image: '', icon: x.id === 'build' ? '🧠' : '🔥' })); });
    return out.map(function (x) {
      const hay = [x.name, x.id, x.baseName, x.kind, x.desc, partNameOf(x.part), (x.pool || []).map(function (p) { return affixLabelOf(p.type); }).join(' '), (x.aliases || []).join(' '), (x.tags || []).join(' ')].join(' ').toLowerCase();
      return Object.assign({}, x, { hay: hay });
    });
  }
  function scoreEntry(x, q) {
    const name = String(x.name || '').toLowerCase();
    let score = 0;
    if (name === q) score += 100;
    else if (name.startsWith(q)) score += 60;
    else if (name.indexOf(q) >= 0) score += 40;
    if ((x.aliases || []).some(function (a) { return String(a).toLowerCase().indexOf(q) >= 0; })) score += 30;
    if ((x.tags || []).join(' ').toLowerCase().indexOf(q) >= 0) score += 15;
    if (String(x.id || '').toLowerCase().indexOf(q) >= 0) score += 8;
    if (String(x.desc || '').toLowerCase().indexOf(q) >= 0) score += 5;
    return score;
  }
  function search(query, type, limit) {
    const s = state.snapshot;
    if (!s) return [];
    const qs = String(query || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (!qs.length) return [];
    const idx = searchIndex(s);
    const rows = [];
    idx.forEach(function (x) {
      if (type && type !== 'all' && x.kind !== type) return;
      let score = 0, ok = true;
      qs.forEach(function (q) {
        const sc = scoreEntry(x, q);
        if (!sc || x.hay.indexOf(q) < 0) { ok = false; return; }
        score += sc;
      });
      if (ok) rows.push({ entry: x, score: score });
    });
    rows.sort(function (a, b) { return b.score - a.score || String(a.entry.name).localeCompare(String(b.entry.name), 'zh-CN'); });
    return rows.slice(0, limit || 80).map(function (r) { return r.entry; });
  }
  function occurrences(id, kind) {
    const s = state.snapshot;
    if (!s) return [];
    const pick = kind === 'component' ? 'component:' : kind + ':' + id;
    const out = [];
    (s.grounds || []).forEach(function (g) {
      (g.spots || []).forEach(function (sp) {
        const total = (sp.pool || []).reduce(function (n, e) { return n + Math.max(0, Number(e.weight) || 0); }, 0);
        (sp.pool || []).forEach(function (e) {
          if (e.pick !== pick) return;
          const w = Math.max(0, Number(e.weight) || 0);
          out.push({ groundId: g.id, groundName: g.name, spotId: sp.id, spotName: sp.name, weight: w, percent: total > 0 ? w / total * 100 : 0 });
        });
      });
    });
    return out;
  }
  async function shopPrice(id) {
    const res = await fetch('/shop', { cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    return data && data[id] ? Object.assign({ fetchedAt: new Date().toISOString() }, data[id]) : null;
  }

  function localStorageAvailable() {
    try { window.localStorage.setItem('__wiki_test__', '1'); window.localStorage.removeItem('__wiki_test__'); return true; }
    catch (e) { return false; }
  }
  function readJSON(key, fallback) {
    if (!localStorageAvailable()) return fallback;
    try {
      const raw = window.localStorage.getItem(key);
      return raw == null ? fallback : JSON.parse(raw);
    } catch (e) { return fallback; }
  }
  function writeJSON(key, value) {
    if (!localStorageAvailable()) return false;
    try { window.localStorage.setItem(key, JSON.stringify(value)); return true; } catch (e) { return false; }
  }
  function removeStorage(key) {
    if (!localStorageAvailable()) return false;
    try { window.localStorage.removeItem(key); return true; } catch (e) { return false; }
  }
  function encodeShare(value) {
    const bytes = new TextEncoder().encode(JSON.stringify(value));
    let binary = '';
    bytes.forEach(function (b) { binary += String.fromCharCode(b); });
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function decodeShare(text) {
    if (typeof text !== 'string' || !text || text.length > 96 * 1024) throw new Error('方案码为空或过长');
    const normalized = text.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized + '='.repeat((4 - normalized.length % 4) % 4);
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, function (c) { return c.charCodeAt(0); });
    const json = new TextDecoder().decode(bytes);
    if (json.length > 96 * 1024) throw new Error('解码后的方案过大');
    return JSON.parse(json);
  }
  function rules() {
    if (!state.snapshot || state.unavailable) throw new Error('当前规则快照不可用，禁止使用默认值计算。');
    return state.snapshot;
  }
  function ready() {
    if (state.snapshot && !state.unavailable) return Promise.resolve(state.snapshot);
    if (!state.readyPromise) {
      state.readyPromise = new Promise(function (resolve, reject) {
        state.readyResolve = resolve; state.readyReject = reject;
      });
      refresh();
    }
    return state.readyPromise;
  }
  function init() {
    renderStatus();
    setInterval(refresh, 5000);
    setInterval(refreshContent, 5000);
    setInterval(checkStale, 1000);
    window.addEventListener('focus', function () { refresh(); refreshContent(); });
    return Promise.allSettled([ready(), contentReady()]).then(function (results) {
      if (results[0].status === 'rejected') throw results[0].reason;
      return state.snapshot;
    });
  }

  window.Wiki = {
    get snapshot() { return state.snapshot; },
    get unavailable() { return state.unavailable; },
    get rulesConfig() { return state.snapshot ? state.snapshot.rulesConfig : null; },
    get content() { return state.content; },
    get items() { return state.snapshot ? itemEntries(state.snapshot) : []; },
    get grounds() { return state.snapshot ? state.snapshot.grounds : []; },
    el: el, fmt: fmt, pct: pct, signed: signed,
    validSnapshot: validSnapshot, validContent: validContent, applyRules: applyRules,
    refresh: refresh, refreshContent: refreshContent, ready: ready, contentReady: contentReady, rules: rules,
    search: search, searchIndex: searchIndex, itemEntries: itemEntries, groundEntries: groundEntries, loadGuide: loadGuide,
    spotUrl: spotUrl, itemUrl: itemUrl, imageFor: imageFor, occurrences: occurrences, shopPrice: shopPrice,
    qualityNameOf: qualityNameOf, partNameOf: partNameOf, affixLabelOf: affixLabelOf,
    storage: { available: localStorageAvailable, readJSON: readJSON, writeJSON: writeJSON, remove: removeStorage },
    encodeShare: encodeShare, decodeShare: decodeShare,
    onChange: function (fn) { if (typeof fn === 'function') state.listeners.push(fn); },
    init: init
  };
})();

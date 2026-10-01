'use strict';
window.WikiPage = (function () {
  const W = () => window.Wiki;
  const C = () => window.WikiContent;
  function qs(name) { return new URLSearchParams(location.search).get(name) || ''; }
  // 每页各自的标题与描述：以前所有页面共用一个 <meta description>、详情页从不改 document.title，
  // 搜索引擎只会看到一堆同质页面。detail 渲染（钓场 / 渔获 / 攻略）会在下面覆盖成具体条目。
  const META_BY_PAGE = {
    home: ['首页', 'DeepFish 配套资料站：钓场、渔获、材料、组件、攻略与更新记录，以及配装 / 熔炼模拟器。'],
    search: ['全站搜索', '在 DeepFish 资料站搜索钓场、渔获、材料、组件、宝匣、词缀、攻略与工具。'],
    grounds: ['钓场与钓点', '查找 DeepFish 各钓场的开放状态、增益、钓点与有效掉落权重。'],
    guides: ['玩法与攻略', 'DeepFish 玩法说明、机制解析、工坊与经济指南、配装攻略与玩家心得。'],
    'guides-submit': ['贡献攻略', '向 DeepFish 资料站投稿你的钓鱼心得与攻略。'],
    updates: ['更新记录', 'DeepFish 游戏版本与 Wiki 内容的合并更新记录。'],
  };
  function setMeta(title, description) {
    if (title) document.title = title + ' · WIKI';
    if (description) {
      const m = document.querySelector('meta[name="description"]');
      if (m) m.setAttribute('content', String(description).slice(0, 200));
    }
  }
  const WIKI_GUIDE_CATEGORIES = ['新手入门', '机制说明', '进阶策略', '工坊指南', '经济交易', '配装攻略', '心得分享'];
  let guideFilter = 'all';
  // 公开内容接口只给攻略元数据；正文按需拉取并在本页缓存，内容 revision 变化时自动失效。
  let guideDetails = Object.create(null);
  let guideDetailLoading = Object.create(null);
  let guideDetailRevision = null;
  let myWiki = { loading: true, authenticated: false, guides: [], limits: null, error: '' };
  async function wikiApi(method, path, body) {
    const opts = { method: method, credentials: 'same-origin', headers: { 'X-Requested-With': 'FishGame', 'X-Session-Mode': 'cookie' } };
    if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    const res = await fetch(path, opts);
    let data = null;
    try { data = await res.json(); } catch (e) {}
    return { ok: res.ok, status: res.status, data: data || {} };
  }
  async function refreshMyWikiGuides() {
    if (myWiki.loading && myWiki.inFlight) return myWiki.inFlight;
    myWiki.loading = true; myWiki.error = '';
    myWiki.inFlight = wikiApi('GET', '/api/wiki/guides/session').then(async function (session) {
      if (!session.ok) throw new Error((session.data && session.data.error) || ('HTTP ' + session.status));
      if (!session.data.authenticated) {
        myWiki.authenticated = false; myWiki.guides = []; myWiki.limits = null;
        return;
      }
      const r = await wikiApi('GET', '/api/wiki/guides/my');
      if (!r.ok) throw new Error((r.data && r.data.error) || ('HTTP ' + r.status));
      myWiki.authenticated = true;
      myWiki.guides = r.data.guides || [];
      myWiki.limits = r.data.limits || null;
    }).then(function () {
      myWiki.inFlight = null;
      myWiki.loading = false;
      const page = document.body.dataset.page;
      if (page === 'guides' || page === 'guides-submit') render();
    }).catch(function (e) {
      myWiki.inFlight = null; myWiki.loading = false; myWiki.error = '网络错误，请稍后重试。';
      const page = document.body.dataset.page;
      if (page === 'guides' || page === 'guides-submit') render();
    });
    return myWiki.inFlight;
  }
  function setNavCurrent() {
    const page = document.body.dataset.page || '';
    const active = page === 'guides-submit' ? 'guides' : page;
    document.querySelectorAll('[data-nav]').forEach(function (a) {
      a.classList.toggle('active', a.getAttribute('data-nav') === active);
    });
  }
  function pageHead(title, sub) {
    const head = W().el('div', 'page-head');
    const box = W().el('div');
    box.append(W().el('h1', 'page-title', title));
    if (sub) box.append(W().el('p', 'page-sub', sub));
    head.append(box);
    return head;
  }
  function layout(sideLinks, content) {
    const root = W().el('div', 'layout');
    const side = W().el('nav', 'side-nav');
    side.setAttribute('aria-label', '页面目录');
    sideLinks.forEach(function (x) {
      const a = W().el('a', null, x.name); a.href = x.href || '#';
      if (x.action) { a.href = '#'; a.addEventListener('click', function (e) { e.preventDefault(); x.action(); }); }
      if (x.active) a.className = 'active';
      side.append(a);
    });
    root.append(side, W().el('div', 'content', ''));
    root.lastChild.append(content);
    return root;
  }
  function card(title) {
    const c = W().el('section', 'panel card');
    if (title) c.append(W().el('h2', 'card-title', title));
    return c;
  }
  function table(headers, rows) {
    const wrap = W().el('div', 'table-wrap');
    const t = W().el('table');
    const thead = W().el('thead'); const tr = W().el('tr');
    headers.forEach(function (h) { tr.append(W().el('th', null, h)); });
    thead.append(tr); t.append(thead);
    const tbody = W().el('tbody');
    rows.forEach(function (row) {
      const r = W().el('tr');
      row.forEach(function (x) { r.append(W().el('td', null, '')); if (x != null) r.lastChild.append(x); });
      tbody.append(r);
    });
    t.append(tbody); wrap.append(t); return wrap;
  }
  function empty(text) { return W().el('div', 'empty', text || '暂无数据'); }

  function latestUpdateNode() {
    if (!versionTimeline && !versionTimelineError) {
      ensureVersionTimeline();
      return empty('正在读取更新…');
    }
    const list = window.WikiContentTools.mergeUpdates(C().updates, versionTimeline);
    const box = W().el('div', 'latest-update');
    if (versionTimelineError) box.append(versionRetryNode());
    if (list.length) box.append(updateArticle(list[0]));
    else box.append(empty('暂无更新记录。'));
    const link = W().el('a', 'button small', '查看更新记录'); link.href = '/wiki/updates/';
    box.append(link);
    return box;
  }
  function renderHome() {
    const main = document.getElementById('main');
    main.textContent = '';
    const links = W().el('div', 'toolbar home-shortcuts');
    [
      { name: '钓场与钓点', icon: '🌊', desc: '开放状态、增益、独立覆盖与当前有效产出权重。', href: 'grounds/index.html' },
      { name: '玩法攻略', icon: '📚', desc: '新手路线、机制说明、工坊路线与经济循环。', href: 'guides/index.html' },
      { name: '全站搜索', icon: '🔎', desc: '钓场、渔获、材料、组件、宝匣、词缀与攻略。', href: 'search/index.html' },
      { name: '更新记录', icon: '📜', desc: '只突出最近一次更新，历史版本默认收起。', href: 'updates/index.html' }
    ].forEach(function (x) {
      const a = W().el('a', 'button', x.icon + ' ' + x.name); a.href = x.href;
      links.append(a);
    });
    const row = W().el('div', 'home-grid');
    const side = W().el('div', 'home-side');
    const tools = card('常用工具');
    const toolGrid = W().el('div', 'home-tool-list');
    [
      { name: '配装模拟器', icon: '🧠', desc: '七部位编辑、当前钓点试算、A/B 对比、保存与分享。', href: 'tools/build.html' },
    ].forEach(function (x) {
      const a = W().el('a', 'home-tool'); a.href = x.href;
      a.append(W().el('h3', 'tile-title', x.icon + ' ' + x.name), W().el('p', 'tile-desc', x.desc));
      toolGrid.append(a);
    });
    tools.append(toolGrid);
    const updates = card('最近一次更新');
    updates.append(latestUpdateNode());
    side.append(updates, tools);
    const latestGuides = card('推荐攻略');
    const gg = W().el('div', 'home-guide-list');
    (C().guides || []).slice(0, 3).forEach(function (g) {
      const a = W().el('a', 'home-guide'); a.href = '/wiki/guides/index.html?slug=' + encodeURIComponent(g.id);
      if (g.id === 'six-affix-workshop-route') a.append(thumbNode({ image: '/assets/item/line_nylon.png', name: '尼龙线组' }));
      const body = W().el('div');
      body.append(W().el('span', 'result-meta', (g.kind === 'user' ? '玩家投稿' : '官方攻略') + ' · ' + g.category), W().el('h3', 'tile-title', g.title), W().el('p', 'tile-desc', g.summary));
      a.append(body);
      gg.append(a);
    });
    const more = W().el('a', 'button', '全部攻略'); more.href = '/wiki/guides/';
    latestGuides.append(gg, more);
    row.append(latestGuides, side);
    main.append(pageHead('今天想钓点什么？', 'WIKI 资料中心 · 查资料、做装备、看攻略'), links, row);
  }

  const KIND_LABEL = {
    ground: '钓场', spot: '钓点', fish: '渔获', material: '材料', component: '组件',
    chest: '宝匣', affix: '词缀', guide: '攻略', tool: '工具'
  };
  function kindLabel(kind) { return KIND_LABEL[kind] || kind || '条目'; }
  function thumbNode(entry, className) {
    const box = W().el('div', className || 'result-thumb');
    if (entry.image) {
      const img = W().el('img');
      img.src = entry.image; img.alt = entry.name || ''; img.loading = 'lazy';
      img.addEventListener('error', function () {
        img.remove(); box.classList.add('thumb-fallback'); box.textContent = entry.icon || '🎣';
      });
      box.append(img);
    } else {
      box.classList.add('thumb-fallback'); box.textContent = entry.icon || '📄';
    }
    return box;
  }
  function occurrenceList(id, kind, noteText) {
    const rows = W().occurrences(id, kind);
    if (!rows.length) return null;
    const wrap = W().el('div', 'occurrence-list');
    if (noteText) wrap.append(W().el('p', 'card-note', noteText));
    rows.slice(0, 12).forEach(function (r) {
      const a = W().el('a', 'occurrence-item');
      a.href = W().spotUrl(r.groundId, r.spotId);
      a.append(W().el('span', null, r.groundName + ' · ' + r.spotName), W().el('b', null, W().pct(r.percent, 1)));
      wrap.append(a);
    });
    return wrap;
  }
  const AFFIX_DESC = {
    speed: '降低抛竿间隔；达到当前最短间隔后不再增加产量。',
    skill: '上鱼率公式的变量，具体收益取决于服务端当前公式。',
    rare: '压低普通品质条目的出现权重，提高稀有内容的占比。',
    material: '提高材料条目在掉落中的占比，适合刷残片与工坊材料。',
    size: '放大渔获体型，用于大鱼/小鱼纪录与档位；不影响总产量。',
    double: '提高一次抛竿钓到多条的概率，边际收益递减。'
  };
  function materialUseText(id) {
    const D = window.GameData;
    // 与游戏内物品详情共用同一份现算结果（见 data.js 的 gearMaterialUses）。
    const gear = (D && D.gearMaterialUses && D.gearMaterialUses(id)) || [];
    const lead = gear.length ? '装备成长材料 → ' + gear.join(' · ') + '。' : '';
    if (id === 'relic') return lead + '开箱合成宝匣的主材料，也是熔炼的保留残片：失败时保护主件、成功时按概率保留池外词缀，还可作为材料概率催化剂投料，并用于重铸。';
    if (id === 'dragonpearl') return lead + '重铸神话件的材料（基础 1 颗，指定第 n 条词条额外 n 颗）；熔炼投料时投入 1 颗可让数值掷两次取更靠近边界的值。';
    if (id === 'chartfrag') return '远洋海图碎片：' + ((D && D.SEA && D.SEA.chartCost) || 3) + ' 片合成 1 张未知海图，出航后随机发现一片临时海域。';
    if (id === 'deepscale') return '远洋船坞材料：船升级按等级需要（见船坞当前需求），也是远航每日悬赏的上交物。';
    if (id === 'storm_relic') return '远洋风暴特产：风暴深入模式（需风暴专精）产出，可在远航里作为定向货物指定收取。';
    return lead || '以当前工坊与商城配方为准。';
  }
  function renderItemDetail(entry) {
    setMeta(entry.name, entry.desc || ('DeepFish 资料站 · ' + entry.name));
    const c = card('条目详情');
    const hero = W().el('div', 'item-hero');
    hero.append(thumbNode(entry, 'item-icon'));
    const info = W().el('div', 'item-hero-body');
    const name = W().el('h2', 'item-name', entry.name);
    if (entry.rarity) name.className = 'item-name q-' + entry.rarity;
    info.append(name);
    const bits = [kindLabel(entry.kind)];
    if (entry.part) bits.push(W().partNameOf(entry.part));
    if (entry.rarity) bits.push(W().qualityNameOf(entry.rarity));
    if (entry.price != null) bits.push('基准价 ' + W().fmt(entry.price, 0));
    if (Array.isArray(entry.size)) bits.push('体型 ' + entry.size[0] + '～' + entry.size[1] + ' cm');
    info.append(W().el('p', 'item-sub', bits.join(' · ')));
    const dl = W().el('dl', 'meta-grid');
    function addMeta(k, v) { dl.append(W().el('dt', null, k), W().el('dd', null, v)); }
    if (entry.kind === 'component') {
      addMeta('部位', W().partNameOf(entry.part));
      addMeta('词缀池', (entry.pool || []).map(function (p) { return W().affixLabelOf(p.type) + ' ' + (p.min > 0 ? '+' : '') + p.min + '～' + (p.max > 0 ? '+' : '') + p.max; }).join('；') || '-');
      addMeta('价格', entry.price != null ? W().fmt(entry.price, 0) + ' 金币（基准）' : '-');
    } else if (entry.kind === 'chest') {
      addMeta('残片成本', entry.costRelic != null ? entry.costRelic + ' 片' : '-');
      addMeta('金币成本', entry.costCoins != null ? W().fmt(entry.costCoins, 0) : '-');
      addMeta('词条', entry.extra ? '神话突破件：池内全取，再补池外词条' : (entry.forceMax ? '填满底材词缀池' : '至少 ' + (entry.minAffixes || 2) + ' 条'));
      addMeta('说明', String(entry.desc || '').replace(/<[^>]*>/g, '') || '-');
    } else if (entry.kind === 'affix') {
      const t = entry.affixType || String(entry.id || '').replace('affix:', '');
      addMeta('类型', W().affixLabelOf(t));
      addMeta('作用', AFFIX_DESC[t] || entry.desc || '-');
    } else if (entry.kind === 'material') {
      addMeta('用途', materialUseText(entry.id));
      addMeta('基准价', entry.price != null ? W().fmt(entry.price, 0) : '-');
    } else if (entry.kind === 'fish') {
      addMeta('档位', entry.tier === 'big' ? '大型渔获' : entry.tier === 'rare' ? '稀有渔获' : '普通渔获');
      addMeta('品质', entry.rarity ? W().qualityNameOf(entry.rarity) : '-');
      addMeta('体型', Array.isArray(entry.size) ? entry.size[0] + '～' + entry.size[1] + ' cm' : '-');
      addMeta('基准价', entry.price != null ? W().fmt(entry.price, 0) : '-');
    }
    if (dl.childNodes.length) info.append(dl);
    hero.append(info);
    c.append(hero);
    const occ = entry.kind === 'component'
      ? occurrenceList(entry.id, 'component', '组件在钓点掉落池里按通用条目计算，下列钓点都会产出组件：')
      : occurrenceList(entry.id, entry.kind, null);
    if (occ) c.append(W().el('h3', 'detail-subtitle', entry.kind === 'material' ? '产出钓点' : '出现钓点'), occ);
    const tools = W().el('div', 'toolbar');
    if (entry.kind === 'component') {
      const a = W().el('a', 'button primary', '在配装模拟器里试用'); a.href = '/wiki/tools/build.html?base=' + encodeURIComponent(entry.id); tools.append(a);
    }
    const clear = W().el('a', 'button', '清除条目详情');
    clear.href = '/wiki/search/index.html?q=' + encodeURIComponent(qs('q')) + (qs('type') ? '&type=' + encodeURIComponent(qs('type')) : '');
    tools.append(clear);
    c.append(tools);
    return c;
  }
  function resultNode(entry) {
    const row = W().el('article', 'search-result');
    row.append(thumbNode(entry));
    const body = W().el('div');
    const a = W().el('a', 'result-title', entry.name); a.href = entry.url || '#';
    const bits = [kindLabel(entry.kind)];
    if (entry.rarity) bits.push(W().qualityNameOf(entry.rarity));
    if (entry.kind === 'component' && entry.part) bits.push(W().partNameOf(entry.part));
    if (entry.kind === 'guide' && entry.category) bits.push(entry.category);
    const desc = entry.kind === 'material' ? materialUseText(entry.id) : entry.desc;
    body.append(a, W().el('p', 'result-meta', bits.join(' · ')), W().el('p', 'result-desc', desc || ''));
    row.append(body);
    return row;
  }
  function renderSearch() {
    const main = document.getElementById('main');
    main.textContent = '';
    const toolbar = W().el('div', 'toolbar');
    const input = W().el('input'); input.type = 'search'; input.id = 'page-search';
    input.placeholder = '搜索钓场、渔获、材料、组件、攻略或工具'; input.value = qs('q');
    input.setAttribute('aria-label', '搜索关键词');
    const type = W().el('select'); type.id = 'search-type'; type.setAttribute('aria-label', '结果类型');
    [['all','全部类型'],['ground','钓场'],['spot','钓点'],['fish','渔获'],['material','材料'],['component','组件'],['chest','宝匣'],['affix','词缀'],['guide','攻略'],['tool','工具']].forEach(function (x) {
      const o = W().el('option', null, x[1]); o.value = x[0]; type.append(o);
    });
    type.value = qs('type') || 'all';
    const button = W().el('button', 'primary', '搜索'); button.type = 'button';
    const resultBox = W().el('div', 'grid search-results');
    resultBox.setAttribute('aria-live', 'polite');
    function update(push) {
      const q = input.value.trim();
      resultBox.textContent = '';
      const rows = W().search(q, type.value);
      if (!q) resultBox.append(empty('输入关键词开始搜索。'));
      else if (!rows.length) resultBox.append(empty('没有找到“' + q + '”。可以尝试简称、词缀名或钓点名。'));
      else {
        rows.forEach(function (x) { resultBox.append(resultNode(x)); });
        resultBox.append(W().el('p', 'card-note', '共显示 ' + rows.length + ' 条结果；钓场与目录数据来自当前服务端规则。'));
      }
      // 输入时就把 q / type 同步进地址栏：否则下一次重渲染用 qs('q') 回填输入框，
      // 玩家正在敲的关键字会被冲掉、焦点也会丢。replaceState 不产生历史记录。
      const url = new URL(location.href);
      if (url.searchParams.get('q') !== q) url.searchParams.set('q', q);
      if (url.searchParams.get('type') !== type.value) url.searchParams.set('type', type.value);
      history.replaceState(null, '', url);
    }
    button.addEventListener('click', function () { update(true); });
    input.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); update(true); } });
    // 输入防抖：逐键重排并在 aria-live 区域播报结果对读屏用户是噪声
    let searchTimer = null;
    input.addEventListener('input', function () { clearTimeout(searchTimer); searchTimer = setTimeout(function () { update(false); }, 250); });
    type.addEventListener('change', function () { update(true); });
    toolbar.append(input, type, button);
    const content = W().el('div');
    content.append(pageHead('全站搜索', '钓场、渔获、材料、组件、宝匣、词缀、攻略与工具都能搜；条目结果带贴图。'), toolbar);
    const itemId = qs('item');
    if (itemId && W().snapshot) {
      const entry = W().searchIndex(W().snapshot).find(function (x) { return x.id === itemId; });
      if (entry) {
        if (!input.value) input.value = entry.name;
        content.append(renderItemDetail(entry));
      }
    }
    content.append(resultBox);
    main.append(content); update(false);
  }
  function renderGrounds() {
    const main = document.getElementById('main'); main.textContent = '';
    const gid = qs('ground'), sid = qs('spot');
    const ground = W().grounds.find(function (g) { return g.id === gid; });
    if (!ground) {
      const c = card('钓场与钓点');
      const grid = W().el('div', 'grid cols-2');
      W().grounds.forEach(function (g) {
        const a = W().el('a', 'tile'); a.href = W().spotUrl(g.id);
        const img = W().el('img', 'item-icon'); img.src = W().imageFor({ id: g.id, kind: 'ground' }); img.alt = '';
        a.append(img, W().el('h3', 'tile-title', g.name), W().el('p', 'tile-desc', (g.type === 'event' ? '活动钓场 · ' : '常驻钓场 · ') + (g.locked ? '当前锁定' : (g.spots || []).length + ' 个钓点') + ' — ' + (g.desc || '')));
        grid.append(a);
      });
      c.append(grid);
      main.append(pageHead('钓场与钓点', '开放状态、增益、独立覆盖和有效掉落权重来自当前规则快照。'), c); return;
    }
    const c = card(ground.name);
    const hero = W().el('div', 'item-hero');
    const img = W().el('img', 'item-icon'); img.src = W().imageFor({ id: ground.id, kind: 'ground' }); img.alt = '';
    hero.append(img);
    const info = W().el('div');
    // 详情页顶部已有 pageHead 的 <h1>，这里用 <h2>，避免同页两个 <h1>（不利于读屏与 SEO）
    setMeta(ground.name + ' · 钓场', ground.desc || ('DeepFish 钓场 ' + ground.name + ' 的钓点与掉落权重。'));
    info.append(W().el('h2', 'item-name', ground.name), W().el('p', 'item-sub', ground.desc || ''));
    const dl = W().el('dl', 'meta-grid');
    [['类型', ground.type === 'event' ? '活动钓场' : '常驻钓场'], ['状态', ground.locked ? '锁定' : '开放'], ['钓点数', String((ground.spots || []).length)]].forEach(function (x) { dl.append(W().el('dt', null, x[0]), W().el('dd', null, x[1])); });
    info.append(dl); hero.append(info); c.append(hero);
    const spotRows = [];
    (ground.spots || []).forEach(function (sp) {
      const total = (sp.pool || []).reduce(function (n, e) { return n + Math.max(0, Number(e.weight) || 0); }, 0);
      const poolText = (sp.pool || []).slice(0, 8).map(function (e) {
        const parts = String(e.pick).split(':'); const kind = parts[0]; const id = parts.slice(1).join(':');
        const item = W().items.find(function (x) { return (kind === 'component' ? x.kind === 'component' : x.id === id); });
        return (item ? item.name : kind === 'component' ? '组件' : id) + ' ' + W().pct(total ? e.weight / total * 100 : 0, 1);
      }).join('、');
      spotRows.push([
        (function () { const a = W().el('a', null, sp.name); a.href = W().spotUrl(ground.id, sp.id); return a; })(),
        (sp.buffs || []).map(function (b) { return (window.GameData.AFFIX_LABEL[b.type] || b.type) + ' ' + W().signed(b.value); }).join('、') || '-',
        sp.intervalMs != null && sp.intervalMs !== '' ? W().fmt(sp.intervalMs, 0) + ' ms' : '-',
        sp.biteRate != null && sp.biteRate !== '' ? W().pct(sp.biteRate, 1) : '-',
        poolText || '-'
      ]);
    });
    const spots = card('钓点');
    spots.append(spotRows.length ? table(['钓点', '增益', '钓点基础间隔', '独立上鱼率', '当前有效产出（前 8 项）'], spotRows) : empty('该钓场当前没有开放钓点。'));
    const tool = card('相关工具');
    const a = W().el('a', 'button primary', '在配装模拟器中选择该钓场'); a.href = '/wiki/tools/build.html?ground=' + encodeURIComponent(ground.id) + (sid ? '&spot=' + encodeURIComponent(sid) : '');
    tool.append(a);
    main.append(pageHead('钓场详情', '有效权重已按服务器当前掉落配置换算。'), c, spots, tool);
  }

  function guideCard(g) {
    const a = W().el('a', 'tile'); a.href = '/wiki/guides/index.html?slug=' + encodeURIComponent(g.id);
    const meta = g.kind === 'user' ? '玩家投稿 · ' + (g.authorName || '玩家') : '官方攻略';
    a.append(W().el('h3', 'tile-title', g.title), W().el('p', 'tile-desc', meta + ' · ' + g.category + ' · ' + g.summary));
    return a;
  }
  function guideStatusLabel(status, autoApproved) {
    if (status === 'pending') return '待审核';
    if (status === 'approved') return autoApproved ? '已通过（自动）' : '已通过';
    if (status === 'rejected') return '已拒绝';
    return status || '-';
  }
  function renderGuideActions() {
    const box = W().el('div', 'toolbar guide-actions');
    const link = W().el('a', 'button primary', '📝 贡献攻略'); link.href = '/wiki/guides/submit.html';
    const mine = W().el('a', 'button', '我的攻略'); mine.href = '/wiki/guides/index.html?my=1';
    if (myWiki.loading) box.append(W().el('span', 'status-line', '登录状态检查中…'));
    else if (myWiki.authenticated) box.append(link, mine);
    else {
      const login = W().el('span', 'status-line', '登录游戏后可提交玩家攻略。');
      box.append(login);
    }
    return box;
  }
  function renderGuideFilter() {
    const box = W().el('div', 'toolbar guide-filter');
    [['all','全部'],['official','官方'],['user','玩家']].forEach(function (x) {
      const b = W().el('button', guideFilter === x[0] ? 'primary' : null, x[1]);
      b.type = 'button';
      b.setAttribute('aria-pressed', String(guideFilter === x[0]));
      b.addEventListener('click', function () { guideFilter = x[0]; render(); });
      box.append(b);
    });
    return box;
  }
  function renderMyGuides() {
    const c = card('我的攻略');
    if (myWiki.loading) { c.append(W().el('p', 'status-line', '加载中…')); return c; }
    if (myWiki.error) { c.append(W().el('div', 'callout warn', myWiki.error)); return c; }
    if (!myWiki.authenticated) { c.append(W().el('div', 'callout warn', '请先登录游戏后再查看我的攻略。')); return c; }
    if (!myWiki.guides.length) { c.append(empty('你还没有提交过攻略。')); return c; }
    const list = W().el('div', 'guide-my-list');
    myWiki.guides.forEach(function (g) {
      const row = W().el('article', 'guide-my-item');
      const head = W().el('div', 'guide-my-head');
      head.append(W().el('b', null, g.title), W().el('span', 'guide-status ' + g.status, guideStatusLabel(g.status, g.autoApproved)));
      row.append(head, W().el('p', 'item-sub', g.category + ' · 提交于 ' + new Date(g.submittedAt).toLocaleString('zh-CN')));
      if (g.reviewedAt) row.append(W().el('p', 'item-sub', '审核于 ' + new Date(g.reviewedAt).toLocaleString('zh-CN')));
      if (g.status === 'rejected' && g.reviewNote) row.append(W().el('div', 'callout warn', '拒绝原因：' + g.reviewNote));
      row.append(W().el('p', null, g.summary));
      if (g.status === 'pending' || (g.autoApproved && g.status === 'approved')) {
        const del = W().el('button', 'danger', g.status === 'pending' ? '删除待审核攻略' : '删除这篇攻略');
        del.type = 'button';
        del.addEventListener('click', async function () {
          // 删除不可恢复：先确认（此前点一下就删，容易误触）
          if (!window.confirm('确定删除「' + g.title + '」（' + guideStatusLabel(g.status, g.autoApproved) + '）？删除后无法恢复。')) return;
          del.disabled = true; del.textContent = '删除中…';
          const r = await wikiApi('POST', '/api/wiki/guides/delete', { id: g.id });
          if (!r.ok) { del.disabled = false; del.textContent = '删除失败，请重试'; return; }
          await refreshMyWikiGuides(); render();
        });
        row.append(del);
      }
      list.append(row);
    });
    c.append(list);
    if (myWiki.limits) {
      c.append(W().el('p', 'card-note', '最近 24 小时已提交 ' + (myWiki.limits.submittedIn24h || 0) + ' / 3 篇 · ' +
        (myWiki.limits.autoApprove ? '当前为自动审核，提交后立即公开' : '待审核 ' + (myWiki.limits.pending || 0) + ' / 3 篇') +
        (myWiki.limits.nextAllowedAt ? ' · 下次可提交：' + new Date(myWiki.limits.nextAllowedAt).toLocaleString('zh-CN') : '')));
    }
    return c;
  }
  function renderGuides() {
    const main = document.getElementById('main'); main.textContent = '';
    const slug = qs('slug');
    const g = C().guides.find(function (x) { return x.id === slug; });
    if (!g) {
      if (qs('my') === '1') {
        main.append(pageHead('我的攻略', '查看投稿状态和审核结果。'), renderGuideActions(), renderMyGuides());
        return;
      }
      const c = card('攻略目录');
      const grid = W().el('div', 'grid guides-grid');
      let rows = C().guides || [];
      if (guideFilter === 'official') rows = rows.filter(function (x) { return x.kind !== 'user'; });
      if (guideFilter === 'user') rows = rows.filter(function (x) { return x.kind === 'user'; });
      rows.forEach(function (x) { grid.append(guideCard(x)); });
      c.append(renderGuideFilter(), grid, W().el('p', 'card-note', '官方攻略支持后台热更新；玩家攻略当前为自动通过、提交后立即展示（后续将加入人工审核）。涉及当前数值时以快照和模拟器结果为准。'));
      if (!rows.length) c.append(empty('当前筛选下暂无攻略。'));
      if (!C().guides.length) c.append(W().el('div', 'callout warn', '攻略内容正在同步，或当前服务端未返回可用攻略。'));
      main.append(pageHead('玩法与攻略', '新手、机制、工坊、经济、配装与玩家心得。'), renderGuideActions(), c);
      return;
    }
    const revision = C().revision || '';
    if (guideDetailRevision !== revision) {
      guideDetailRevision = revision;
      guideDetails = Object.create(null);
      guideDetailLoading = Object.create(null);
    }
    setMeta(g.title, g.summary);
    main.append(pageHead(g.title, g.summary));
    const full = guideDetails[g.id] || (Array.isArray(g.sections) && g.sections.length ? g : null);
    if (!full) {
      const holder = W().el('div', 'guide-detail-holder');
      const loading = card('攻略正文');
      loading.append(empty('正在读取攻略正文…'));
      holder.append(loading);
      main.append(holder);
      if (!guideDetailLoading[g.id]) {
        guideDetailLoading[g.id] = true;
        W().loadGuide(g.id).then(function (guide) {
          guideDetails[g.id] = guide;
          guideDetailLoading[g.id] = false;
          if (document.body.dataset.page === 'guides' && qs('slug') === g.id) render();
        }).catch(function (e) {
          guideDetailLoading[g.id] = false;
          if (document.body.dataset.page !== 'guides' || qs('slug') !== g.id) return;
          holder.textContent = '';
          const errCard = card('攻略正文');
          errCard.append(W().el('div', 'callout warn', '攻略正文读取失败：' + ((e && e.message) || e)));
          const retry = W().el('button', 'primary', '重试'); retry.type = 'button';
          retry.addEventListener('click', function () { render(); });
          errCard.append(retry);
          holder.append(errCard);
        });
      }
      return;
    }
    main.append(guideArticleLayout(full));
  }
  function guideArticleLayout(g) {
    const wrap = W().el('div', 'guide-layout');
    const c = card();
    const source = g.kind === 'user' ? '玩家投稿 · ' + (g.authorName || '玩家') : '官方攻略';
    c.append(W().el('p', 'item-sub', source + ' · ' + g.category + ' · 更新于 ' + new Date(g.updatedAt || '').toLocaleDateString('zh-CN')));
    const article = W().el('div', 'article');
    const toc = W().el('nav', 'guide-toc'); toc.setAttribute('aria-label', '本文目录');
    (g.sections || []).forEach(function (s, i) {
      const section = W().el('section', 'guide-article-section'); section.id = 'section-' + (i + 1);
      section.append(W().el('h2', null, s.h));
      const anchor = W().el('a', null, s.h); anchor.href = '#' + section.id; toc.append(anchor);
      if (s.type === 'p') section.append(W().el('p', null, s.text));
      else if (s.type === 'note') section.append(W().el('div', 'callout', s.text));
      else {
        const list = W().el(s.type === 'ol' ? 'ol' : 'ul');
        (s.items || []).forEach(function (x) { list.append(W().el('li', null, x)); });
        section.append(list);
      }
      article.append(section);
    });
    c.append(article);
    const side = W().el('details', 'panel card guide-side');
    side.open = window.matchMedia('(min-width: 1001px)').matches;
    side.append(W().el('summary', 'guide-side-title', '本文目录与相关工具'));
    const rg = W().el('div', 'grid');
    [['配装模拟器', '🧠', '/wiki/tools/build.html']].forEach(function (x) {
      const a = W().el('a', 'tile compact'); a.href = x[2];
      a.append(W().el('span', 'tile-emoji', x[1]), W().el('h3', 'tile-title', x[0]));
      rg.append(a);
    });
    const back = W().el('a', 'button', '返回攻略目录'); back.href = '/wiki/guides/index.html';
    side.append(toc);
    const paired = g.id === 'six-affix-workshop-route' ? ['词条来源与残片机制', 'affix-source-and-retention'] : g.id === 'affix-source-and-retention' ? ['六词条装备打造攻略', 'six-affix-workshop-route'] : null;
    if (paired) {
      const link = W().el('a', 'guide-related', paired[0]); link.href = '/wiki/guides/?slug=' + paired[1];
      side.append(W().el('h3', null, '配套阅读'), link);
    }
    side.append(W().el('h3', null, '相关工具'), rg, back);
    wrap.append(side, c);
    return wrap;
  }
  function guideDraftValue() {
    let value = W().storage.readJSON('wiki_guide_draft', null);
    if (!value || typeof value !== 'object') {
      value = { title: '', category: '心得分享', summary: '', tags: '', sections: [{ h: '', type: 'p', text: '', items: '' }] };
    }
    if (!Array.isArray(value.sections) || !value.sections.length) value.sections = [{ h: '', type: 'p', text: '', items: '' }];
    return value;
  }
  function normalizeGuideDraft(draft) {
    const sections = (draft.sections || []).map(function (s) {
      return {
        h: String(s.h || ''),
        type: ['p', 'note', 'ol', 'ul'].includes(s.type) ? s.type : 'p',
        text: String(s.text || ''),
        items: String(s.items || '')
      };
    });
    return {
      title: String(draft.title || ''), category: WIKI_GUIDE_CATEGORIES.includes(draft.category) ? draft.category : '心得分享',
      summary: String(draft.summary || ''), tags: String(draft.tags || ''), sections: sections
    };
  }
  function guideDraftPayload(draft) {
    return {
      title: draft.title.trim(),
      category: draft.category,
      summary: draft.summary.trim(),
      tags: draft.tags.split(/[,，\s]+/).map(x => x.trim()).filter(Boolean),
      sections: draft.sections.map(function (s) {
        if (s.type === 'ol' || s.type === 'ul') return { h: s.h.trim(), type: s.type, items: s.items.split(/\n+/).map(x => x.trim()).filter(Boolean) };
        return { h: s.h.trim(), type: s.type, text: s.text.trim() };
      })
    };
  }
  function renderGuideSubmit() {
    const main = document.getElementById('main'); main.textContent = '';
    if (myWiki.loading) {
      main.append(pageHead('贡献攻略', '检查登录状态中…'), W().el('p', 'status-line', '请稍候…'));
      return;
    }
    if (!myWiki.authenticated) {
      main.append(pageHead('贡献攻略', '登录后提交你的钓鱼心得。'), W().el('div', 'callout warn', '请先登录游戏，再打开本页提交攻略。'));
      return;
    }
    if (myWiki.error) {
      main.append(pageHead('贡献攻略', '登录状态读取失败。'), W().el('div', 'callout warn', myWiki.error));
      return;
    }
    const draft = normalizeGuideDraft(guideDraftValue());
    const c = card('攻略内容');
    const form = W().el('form', 'guide-form');
    function field(labelText, input) {
      const wrap = W().el('label', 'field');
      wrap.append(W().el('span', 'field-label', labelText), input);
      return wrap;
    }
    const title = W().el('input'); title.className = 'ipt'; title.value = draft.title; title.maxLength = 120;
    const category = W().el('select'); category.className = 'ipt';
    WIKI_GUIDE_CATEGORIES.forEach(function (x) { const o = W().el('option', null, x); o.value = x; category.append(o); });
    category.value = draft.category;
    const summary = W().el('textarea'); summary.className = 'ipt'; summary.rows = 3; summary.maxLength = 300; summary.value = draft.summary;
    const tags = W().el('input'); tags.className = 'ipt'; tags.value = draft.tags; tags.placeholder = '用逗号分隔，例如：新手, 材料';
    form.append(field('标题', title), field('分类', category), field('摘要', summary), field('标签', tags));
    const sectionBox = W().el('div', 'guide-sections');
    function drawSections() {
      sectionBox.textContent = '';
      draft.sections.forEach(function (s, i) {
        const box = W().el('article', 'guide-section');
        const head = W().el('div', 'guide-section-head');
        const h = W().el('input'); h.className = 'ipt'; h.value = s.h; h.placeholder = '段落标题'; h.maxLength = 100;
        const type = W().el('select'); type.className = 'ipt';
        [['p','普通段落'],['note','提示'],['ol','有序列表'],['ul','无序列表']].forEach(function (x) { const o = W().el('option', null, x[1]); o.value = x[0]; type.append(o); });
        type.value = s.type;
        h.addEventListener('input', function () { s.h = h.value; save(); });
        type.addEventListener('change', function () { s.type = type.value; save(); drawSections(); });
        const remove = W().el('button', 'danger mini', '删除段落'); remove.type = 'button';
        remove.addEventListener('click', function () { draft.sections.splice(i, 1); save(); drawSections(); });
        head.append(h, type, remove);
        box.append(head);
        if (s.type === 'ol' || s.type === 'ul') {
          const items = W().el('textarea'); items.className = 'ipt'; items.rows = 5; items.value = s.items; items.placeholder = '每行一个列表项';
          items.addEventListener('input', function () { s.items = items.value; save(); });
          box.append(items);
        } else {
          const text = W().el('textarea'); text.className = 'ipt'; text.rows = 5; text.value = s.text;
          text.addEventListener('input', function () { s.text = text.value; save(); });
          box.append(text);
        }
        sectionBox.append(box);
      });
    }
    function save() { W().storage.writeJSON('wiki_guide_draft', draft); }
    title.addEventListener('input', function () { draft.title = title.value; save(); });
    category.addEventListener('change', function () { draft.category = category.value; save(); });
    summary.addEventListener('input', function () { draft.summary = summary.value; save(); });
    tags.addEventListener('input', function () { draft.tags = tags.value; save(); });
    const addSection = W().el('button', null, '添加段落'); addSection.type = 'button';
    addSection.addEventListener('click', function () { draft.sections.push({ h: '', type: 'p', text: '', items: '' }); save(); drawSections(); });
    form.append(sectionBox, addSection);
    const status = W().el('p', 'status-line');
    const submit = W().el('button', 'primary', '提交攻略'); submit.type = 'submit';
    const clear = W().el('button', 'danger', '清空草稿'); clear.type = 'button';
    clear.addEventListener('click', function () {
      draft.title = ''; draft.category = '心得分享'; draft.summary = ''; draft.tags = ''; draft.sections = [{ h: '', type: 'p', text: '', items: '' }];
      save(); render();
    });
    form.append(submit, clear, status);
    form.addEventListener('submit', async function (e) {
      e.preventDefault();
      const payload = guideDraftPayload(draft);
      if (!payload.title || !payload.summary || !payload.sections.length || payload.sections.some(s => !s.h || ((s.type === 'p' || s.type === 'note') ? !s.text : !(s.items || []).length))) {
        status.textContent = '请完整填写标题、摘要和每段内容。';
        return;
      }
      submit.disabled = true; submit.textContent = '提交中…'; status.textContent = '';
      const r = await wikiApi('POST', '/api/wiki/guides/submit', payload);
      submit.disabled = false; submit.textContent = '提交攻略';
      if (!r.ok) { status.textContent = (r.data && r.data.error) || ('提交失败：HTTP ' + r.status); return; }
      W().storage.remove('wiki_guide_draft');
      location.href = '/wiki/guides/index.html?my=1';
    });
    drawSections();
    const auto = !!(myWiki.limits && myWiki.limits.autoApprove);
    const policy = auto ? '攻略提交后自动通过并公开；作者或管理员可删除内容。' : '攻略提交后进入待审核队列，管理员通过后公开。';
    c.append(W().el('div', 'callout', policy), form);
    main.append(pageHead('贡献攻略', policy), c);
  }
  let versionTimeline = null, versionTimelineLoading = false, versionTimelineError = '';
  async function ensureVersionTimeline() {
    if (versionTimeline || versionTimelineLoading || versionTimelineError) return;
    versionTimelineLoading = true;
    try {
      const res = await fetch('/wiki/content/versions.json', { cache: 'no-cache' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      if (!Array.isArray(data.versions)) throw new Error('版本记录结构无效');
      versionTimeline = data.versions;
    } catch (e) {
      versionTimelineError = '版本记录读取失败：' + (e && e.message || e);
    } finally {
      versionTimelineLoading = false;
      if (['home', 'updates'].includes(document.body.dataset.page)) render();
    }
  }
  function updateArticle(x) {
    const item = W().el('article', 'update-item');
    const head = W().el('div', 'update-head');
    head.append(W().el('span', 'update-date', x.date + ' · ' + x.source), W().el('h3', 'update-title', x.title));
    item.append(head, W().el('p', 'update-summary', x.summary));
    return item;
  }
  function versionRetryNode() {
    const box = W().el('div', 'callout warn');
    box.append(W().el('p', null, '游戏版本记录暂不可用，目前仅显示 Wiki 内容更新。'));
    const retry = W().el('button', 'small', '重新读取'); retry.type = 'button';
    retry.addEventListener('click', function () { versionTimelineError = ''; ensureVersionTimeline(); render(); });
    box.append(retry); return box;
  }
  function renderUpdates() {
    const main = document.getElementById('main'); main.textContent = '';
    main.append(pageHead('更新记录', '游戏版本与 Wiki 内容合并展示，默认只显示最近一次更新。'));
    const latest = card('最近一次更新'); latest.classList.add('updates-latest');
    latest.append(latestUpdateNode());
    // 详情页不重复提供指向自身的入口。
    const selfLink = latest.querySelector('.latest-update > a');
    if (selfLink) selfLink.remove();
    main.append(latest);
    const list = window.WikiContentTools.mergeUpdates(C().updates, versionTimeline);
    if (list.length > 1 && (versionTimeline || versionTimelineError)) {
      const history = W().el('details', 'history-details');
      const summary = W().el('summary', 'history-summary', '查看历史更新（' + (list.length - 1) + ' 条）');
      const body = W().el('div', 'history-body');
      list.slice(1).forEach(function (x) { body.append(updateArticle(x)); });
      history.append(summary, body); main.append(history);
    }
  }
  function render() {
    setNavCurrent();
    const page = document.body.dataset.page;
    const meta = META_BY_PAGE[page]; if (meta) setMeta(meta[0], meta[1]);
    if (page === 'home') renderHome();
    else if (page === 'search') renderSearch();
    else if (page === 'grounds') renderGrounds();
    else if (page === 'guides') renderGuides();
    else if (page === 'guides-submit') renderGuideSubmit();
    else if (page === 'updates') renderUpdates();
  }
  function init() {
    let lastKey = '', lastUnavailable = null;
    const guideWidth = window.matchMedia('(min-width: 1001px)');
    guideWidth.addEventListener('change', function (e) {
      const toc = document.querySelector('details.guide-side');
      if (toc) toc.open = e.matches;
    });
    if (['guides', 'guides-submit'].includes(document.body.dataset.page || '')) refreshMyWikiGuides();
    W().onChange(function (snapshot, unavailable) {
      const content = W().content;
      const key = (snapshot ? snapshot.snapshotId : '') + '|content:' +
        (content ? (content.revision || 0) + ':' + (content.updatedAt || '') : '');
      if (key === lastKey && unavailable === lastUnavailable) return;
      lastKey = key; lastUnavailable = unavailable; render();
    });
    return W().init().then(render).catch(function (e) {
      render();
      console.error('Wiki rules unavailable:', e);
    });
  }
  return { init: init, render: render };
})();
document.addEventListener('DOMContentLoaded', function () { window.WikiPage.init(); });

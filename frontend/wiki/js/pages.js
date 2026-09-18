'use strict';
window.WikiPage = (function () {
  const W = () => window.Wiki;
  const C = () => window.WikiContent;
  function qs(name) { return new URLSearchParams(location.search).get(name) || ''; }
  function setNavCurrent() {
    const page = document.body.dataset.page || '';
    document.querySelectorAll('.main-nav a').forEach(function (a) {
      const target = (a.getAttribute('href') || '').replace('index.html', '').replace('.html', '');
      if (target === page || (page === 'home' && target === '/wiki/')) a.setAttribute('aria-current', 'page');
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
    const c = W().el('section', 'card');
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

  function renderHome() {
    const main = document.getElementById('main');
    main.textContent = '';
    const intro = card('wiki');
    intro.append(W().el('p', null, '这是钓鱼网站配套资料站。目录、公式、概率和费用来自当前服务端规则快照；攻略与工具不会消耗游戏资产。'));
    const links = W().el('div', 'grid cols-4');
    [
      { name: '图鉴', desc: '鱼类、材料、组件底材、宝匣与词缀。', href: 'items/index.html' },
      { name: '钓场与钓点', desc: '开放状态、增益、独立覆盖和有效掉落权重。', href: 'grounds/index.html' },
      { name: '攻略', desc: '新手、机制、工坊、经济与常见问题。', href: 'guides/index.html' },
      { name: '更新记录', desc: 'Wiki 功能与规则同步说明。', href: 'updates/index.html' }
    ].forEach(function (x) {
      const a = W().el('a', 'tile'); a.href = x.href;
      a.append(W().el('h3', 'tile-title', x.name), W().el('p', 'tile-desc', x.desc));
      links.append(a);
    });
    intro.append(links);
    const tools = card('实用工具');
    const toolGrid = W().el('div', 'grid cols-2');
    [
      { name: '配装模拟器', desc: '七部位编辑、当前钓点试算、A/B 对比、保存与分享。', href: 'tools/build.html' },
      { name: '熔炼模拟器', desc: '投料与保护预览、成功失败分支、单次和批量模拟。', href: 'tools/smelt.html' }
    ].forEach(function (x) {
      const a = W().el('a', 'tile'); a.href = x.href;
      a.append(W().el('h3', 'tile-title', x.name), W().el('p', 'tile-desc', x.desc));
      toolGrid.append(a);
    });
    tools.append(toolGrid, W().el('p', 'card-note', '两个模拟器均使用服务端下发的共享规则；无法确认最新配置时自动禁用。'));
    const updates = card('最近更新');
    C().updates.slice(0, 5).forEach(function (x) {
      updates.append(W().el('p', null, x.date + ' · ' + x.title + ' — ' + x.summary));
    });
    const content = W().el('div');
    content.append(pageHead('wiki', '玩家资料与攻略中心'), intro, tools, updates);
    main.append(content);
  }

  function resultNode(entry) {
    const row = W().el('article', 'search-result');
    if (entry.image) { const img = W().el('img'); img.src = entry.image; img.alt = ''; img.loading = 'lazy'; row.append(img); }
    else { const icon = W().el('div', 'item-icon', entry.kind === 'guide' ? '文' : '·'); row.append(icon); }
    const body = W().el('div');
    const a = W().el('a', 'result-title', entry.name); a.href = entry.url || '#';
    body.append(a, W().el('p', 'result-meta', (entry.kind || '-') + (entry.id ? ' · ' + entry.id : '')), W().el('p', 'result-desc', entry.desc || ''));
    row.append(body);
    return row;
  }
  function renderSearch() {
    const main = document.getElementById('main');
    main.textContent = '';
    const toolbar = W().el('div', 'toolbar');
    const input = W().el('input'); input.type = 'search'; input.id = 'page-search'; input.placeholder = '搜索物品、钓点、词缀或攻略'; input.value = qs('q');
    const type = W().el('select'); type.id = 'search-type'; type.setAttribute('aria-label', '结果类型');
    [['all','全部类型'],['fish','鱼类'],['material','材料'],['component','组件'],['chest','宝匣'],['affix','词缀'],['ground','钓场'],['spot','钓点'],['guide','攻略'],['tool','工具']].forEach(function (x) {
      const o = W().el('option', null, x[1]); o.value = x[0]; type.append(o);
    });
    type.value = qs('type') || 'all';
    const button = W().el('button', 'primary', '搜索'); button.type = 'button';
    const resultBox = W().el('div', 'grid');
    function update(push) {
      const q = input.value.trim();
      resultBox.textContent = '';
      const rows = W().search(q, type.value);
      if (!q) resultBox.append(empty('输入关键词开始搜索。'));
      else if (!rows.length) resultBox.append(empty('没有找到“' + q + '”。可以尝试简称、词缀名或钓点名。'));
      else {
        rows.forEach(function (x) { resultBox.append(resultNode(x)); });
        resultBox.append(W().el('p', 'card-note', '共显示 ' + rows.length + ' 条结果；目录部分来自当前服务端快照。'));
      }
      if (push) {
        const url = new URL(location.href); url.searchParams.set('q', q); url.searchParams.set('type', type.value);
        history.replaceState(null, '', url);
      }
    }
    button.addEventListener('click', function () { update(true); });
    input.addEventListener('input', function () { update(false); });
    type.addEventListener('change', function () { update(true); });
    toolbar.append(input, type, button);
    const content = W().el('div');
    content.append(pageHead('全站搜索', '搜索结果会实时合并当前规则快照中的目录。'), toolbar, resultBox);
    main.append(content); update(false);
  }

  function itemCard(entry) {
    const a = W().el('a', 'tile'); a.href = W().itemUrl(entry);
    if (entry.image) { const img = W().el('img', 'item-icon'); img.src = entry.image; img.alt = ''; img.loading = 'lazy'; a.append(img); }
    const title = W().el('h3', 'tile-title ' + (entry.rarity ? 'q-' + entry.rarity : ''), entry.name);
    a.append(title, W().el('p', 'tile-desc', entry.kind === 'fish' ? '鱼类 · 基准价 ' + W().fmt(entry.price, 0) :
      entry.kind === 'material' ? '材料 · 基准价 ' + W().fmt(entry.price, 0) :
      entry.kind === 'component' ? '组件底材 · ' + (window.GameData.ROD_PARTS.find(function (p) { return p.key === entry.part; }) || {}).name :
      entry.kind === 'chest' ? '宝匣 · ' + (entry.desc || '') : '词缀机制'));
    return a;
  }
  function renderItemDetail(id) {
    const main = document.getElementById('main'); main.textContent = '';
    const entry = W().items.find(function (x) { return x.id === id; });
    if (!entry) { main.append(pageHead('未找到条目'), empty('当前快照中没有这个条目。')); return; }
    const c = card();
    const hero = W().el('div', 'item-hero');
    if (entry.image) { const img = W().el('img', 'item-icon'); img.src = entry.image; img.alt = entry.name; hero.append(img); }
    const info = W().el('div');
    info.append(W().el('h1', 'item-name ' + (entry.rarity ? 'q-' + entry.rarity : ''), entry.name));
    info.append(W().el('p', 'item-sub', (entry.kind === 'fish' ? '鱼类 · ' + ({common:'普通',big:'大型',rare:'稀有'})[entry.tier] :
      entry.kind === 'material' ? '材料' : entry.kind === 'component' ? '组件底材 · ' + ((window.GameData.ROD_PARTS.find(function (p) { return p.key === entry.part; }) || {}).name || '-') :
      entry.kind === 'chest' ? '宝匣' : '词缀机制')));
    const dl = W().el('dl', 'meta-grid');
    function meta(k, v) { dl.append(W().el('dt', null, k), W().el('dd', null, v)); }
    meta('条目 ID', entry.id);
    if (entry.rarity) meta('品质', ({common:'普通',rare:'稀有',epic:'史诗',mythic:'神话'})[entry.rarity] || entry.rarity);
    if (entry.price != null) meta('基准价', W().fmt(entry.price, 0) + ' 金币');
    if (entry.size) meta('基准体型', entry.size[0] + ' ~ ' + entry.size[1] + ' cm');
    if (entry.part) meta('部位', ((window.GameData.ROD_PARTS.find(function (p) { return p.key === entry.part; }) || {}).name || entry.part));
    if (entry.desc) meta('说明', entry.desc);
    const snap = W().snapshot;
    meta('数据来源', snap ? '服务端规则快照 ' + snap.gameVersion + ' / 配置 ' + snap.configRevision : '规则不可用');
    info.append(dl);
    const live = W().el('p', null, '实时收购价：读取中…'); live.id = 'live-price';
    if (entry.kind === 'fish' || entry.kind === 'material') {
      info.append(live);
      W().shopPrice(entry.id).then(function (x) {
        live.textContent = x ? '实时收购价：' + W().fmt(x.price, 0) + ' 金币（基准 ' + W().fmt(x.base, 0) + '，今日售出 ' + W().fmt(x.soldToday, 0) + '） · ' + new Date(x.fetchedAt).toLocaleTimeString('zh-CN') : '实时收购价：该物品当前不在系统收购经济物品中。';
      }).catch(function () { live.textContent = '实时收购价：读取失败，本次不显示旧价。'; });
    }
    hero.append(info); c.append(hero);

    if (entry.kind === 'component') {
      const affix = card('词缀池');
      const rows = (entry.pool || []).map(function (p) {
        const r = window.GameData.affixRangeOf(entry.id, p);
        return [window.GameData.AFFIX_LABEL[p.type] || p.type, W().signed(r[0]) + ' ~ ' + W().signed(r[1])];
      });
      affix.append(rows.length ? table(['词缀', '当前区间'], rows) : empty('该底材没有自然词缀池。'));
      const link = W().el('a', null, '在配装模拟器中使用'); link.href = '/wiki/tools/build.html?base=' + encodeURIComponent(entry.id);
      affix.append(W().el('p', null, ''), link);
      c.after(affix);
    }
    if (entry.kind === 'material') {
      const smelt = (snap.catalog.smeltMaterials || []).find(function (x) { return x.id === entry.id; });
      const pearl = snap.catalog.smeltPearl || {};
      const usage = card('工坊用途');
      if (smelt) usage.append(W().el('p', null, '熔炼投料：定向补缀「' + smelt.affixName + '」。具体成功率、补缀率和费用以当前快照计算。'));
      else if (pearl.id === entry.id) usage.append(W().el('p', null, '龙宫宝珠：熔炼催化剂，改变取值规则与费用；不是定向投料。'));
      else usage.append(W().el('p', null, '该材料当前没有公开的工坊定向用途。'));
      const link = W().el('a', null, '打开熔炼模拟器'); link.href = '/wiki/tools/smelt.html';
      usage.append(W().el('p', null, ''), link);
      c.after(usage);
    }
    const occurs = W().occurrences(entry.id, entry.kind);
    const where = card('获取地点');
    if (occurs.length) {
      where.append(table(['钓场', '钓点', '当前有效权重'], occurs.map(function (x) {
        const a = W().el('a', null, x.groundName + ' · ' + x.spotName); a.href = W().spotUrl(x.groundId, x.spotId);
        return [a, W().pct(x.percent, 3)];
      })));
    } else where.append(empty('当前快照的公开钓点池中没有直接产出记录。'));
    const related = card('相关内容');
    const rg = W().el('div', 'grid cols-3');
    if (entry.kind === 'component') {
      const a = W().el('a', 'tile', '组件品质与词缀'); a.href = '/wiki/guides/index.html?slug=component-quality'; rg.append(a);
    }
    if (entry.kind === 'material' || entry.kind === 'chest') {
      const a = W().el('a', 'tile', '工坊规则'); a.href = '/wiki/guides/index.html?slug=workshop-rules'; rg.append(a);
    }
    const b = W().el('a', 'tile', '返回图鉴'); b.href = '/wiki/items/index.html'; rg.append(b);
    related.append(rg);
    const content = W().el('div');
    content.append(pageHead('图鉴详情', '以下目录与权重来自当前服务端快照。'), c, where, related);
    main.append(content);
  }
  function renderItems() {
    const id = qs('id');
    if (id) { renderItemDetail(id); return; }
    const main = document.getElementById('main'); main.textContent = '';
    const toolbar = W().el('div', 'toolbar');
    const input = W().el('input'); input.type = 'search'; input.placeholder = '筛选名称或 ID';
    const type = W().el('select'); type.setAttribute('aria-label', '条目类型');
    [['all','全部'],['fish','鱼类'],['material','材料'],['component','组件底材'],['chest','宝匣'],['affix','词缀']].forEach(function (x) { type.append(Object.assign(W().el('option', null, x[1]), { value: x[0] })); });
    const box = W().el('div', 'grid cols-4');
    function update() {
      box.textContent = '';
      const q = input.value.trim().toLowerCase();
      const rows = W().items.filter(function (x) { return (!type.value || type.value === 'all' || x.kind === type.value) && (!q || x.name.toLowerCase().indexOf(q) >= 0 || x.id.toLowerCase().indexOf(q) >= 0); });
      if (!rows.length) box.append(empty('没有匹配条目。'));
      else rows.forEach(function (x) { box.append(itemCard(x)); });
    }
    input.addEventListener('input', update); type.addEventListener('change', update);
    toolbar.append(input, type);
    const c = card('图鉴目录'); c.append(toolbar, W().el('p', 'card-note', '目录条目来自 /api/version?profile=wiki，服务器配置变化后无需发布新页面。'), box);
    main.append(pageHead('图鉴', '鱼类、材料、组件底材、宝匣与词缀。'), c); update();
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
    info.append(W().el('h1', 'item-name', ground.name), W().el('p', 'item-sub', ground.desc || ''));
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
    spots.append(spotRows.length ? table(['钓点', '增益', '独立间隔', '独立上鱼率', '当前有效产出（前 8 项）'], spotRows) : empty('该钓场当前没有开放钓点。'));
    const tool = card('相关工具');
    const a = W().el('a', 'button primary', '在配装模拟器中选择该钓场'); a.href = '/wiki/tools/build.html?ground=' + encodeURIComponent(ground.id) + (sid ? '&spot=' + encodeURIComponent(sid) : '');
    tool.append(a);
    main.append(pageHead('钓场详情', '有效权重已按服务器当前掉落配置换算。'), c, spots, tool);
  }

  function guideCard(g) {
    const a = W().el('a', 'tile'); a.href = '/wiki/guides/index.html?slug=' + encodeURIComponent(g.id);
    a.append(W().el('h3', 'tile-title', g.title), W().el('p', 'tile-desc', g.category + ' · ' + g.summary));
    return a;
  }
  function renderGuides() {
    const main = document.getElementById('main'); main.textContent = '';
    const slug = qs('slug');
    const g = C().guides.find(function (x) { return x.id === slug; });
    if (!g) {
      const c = card('攻略目录');
      const grid = W().el('div', 'grid cols-2');
      C().guides.forEach(function (x) { grid.append(guideCard(x)); });
      c.append(grid, W().el('p', 'card-note', '攻略描述玩法结构；涉及当前数值时请以快照和模拟器结果为准。'));
      main.append(pageHead('玩法与攻略', '新手、机制、工坊、经济与常见问题。'), c); return;
    }
    const c = card(g.title);
    c.append(W().el('p', 'item-sub', g.category + ' · 更新于 ' + g.updatedAt + ' · ' + g.status));
    const article = W().el('div', 'article');
    (g.sections || []).forEach(function (s) {
      article.append(W().el('h2', null, s.h));
      if (s.type === 'p') article.append(W().el('p', null, s.text));
      else if (s.type === 'note') article.append(W().el('div', 'callout', s.text));
      else {
        const list = W().el(s.type === 'ol' ? 'ol' : 'ul');
        (s.items || []).forEach(function (x) { list.append(W().el('li', null, x)); });
        article.append(list);
      }
    });
    c.append(article);
    const related = card('相关工具');
    const rg = W().el('div', 'grid cols-3');
    [['配装模拟器','/wiki/tools/build.html'],['熔炼模拟器','/wiki/tools/smelt.html'],['返回攻略','/wiki/guides/index.html']].forEach(function (x) {
      const a = W().el('a', 'tile', x[0]); a.href = x[1]; rg.append(a);
    });
    related.append(rg);
    main.append(pageHead(g.title, g.summary), c, related);
  }
  function renderUpdates() {
    const main = document.getElementById('main'); main.textContent = '';
    const c = card('Wiki 更新记录');
    C().updates.forEach(function (x) {
      const item = W().el('article', 'branch');
      item.append(W().el('h3', null, x.date + ' · ' + x.title), W().el('p', null, x.summary));
      c.append(item);
    });
    const status = card('当前规则');
    const dl = W().el('dl', 'meta-grid'); dl.id = 'update-snapshot';
    c.append(dl);
    const snap = W().snapshot;
    if (snap) [['游戏版本',snap.gameVersion],['规则版本',String(snap.rulesVersion)],['配置代数',String(snap.configRevision)],['配置哈希',snap.configHash],['快照时间',new Date(snap.generatedAt).toLocaleString('zh-CN')]].forEach(function (x) { dl.append(W().el('dt',null,x[0]),W().el('dd',null,x[1])); });
    const feedback = card('纠错入口');
    const textarea = W().el('textarea'); textarea.value = '页面地址：' + location.href + '\n游戏版本：' + (snap ? snap.gameVersion : '-') + '\n配置哈希：' + (snap ? snap.configHash : '-') + '\n问题描述：';
    const button = W().el('button', 'primary', '复制纠错模板');
    const statusLine = W().el('p', 'status-line', '复制后粘贴到既有反馈渠道。');
    button.addEventListener('click', async function () {
      try { await navigator.clipboard.writeText(textarea.value); statusLine.textContent = '已复制。'; }
      catch (e) { statusLine.textContent = '复制失败，请手动选中文本复制。'; }
    });
    feedback.append(textarea, button, statusLine);
    main.append(pageHead('更新记录', 'Wiki 功能更新与规则同步说明。'), c, status, feedback);
  }

  function render() {
    setNavCurrent();
    const page = document.body.dataset.page;
    if (page === 'home') renderHome();
    else if (page === 'search') renderSearch();
    else if (page === 'items') renderItems();
    else if (page === 'grounds') renderGrounds();
    else if (page === 'guides') renderGuides();
    else if (page === 'updates') renderUpdates();
  }
  function init() {
    let lastKey = '', lastUnavailable = null;
    W().onChange(function (snapshot, unavailable) {
      const key = snapshot ? snapshot.snapshotId : '';
      if (key === lastKey && unavailable === lastUnavailable) return;
      lastKey = key; lastUnavailable = unavailable; render();
    });
    return W().init().then(render).catch(function (e) {
      render();
      const main = document.getElementById('main');
      const box = W().el('div', 'callout warn', '规则快照不可用：' + (e && e.message || e) + '。正文可浏览，数值和模拟器已禁用。');
      main.prepend(box);
    });
  }
  return { init: init, render: render };
})();
document.addEventListener('DOMContentLoaded', function () { window.WikiPage.init(); });

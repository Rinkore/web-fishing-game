'use strict';
window.WikiPage = (function () {
  const W = () => window.Wiki;
  const C = () => window.WikiContent;
  function qs(name) { return new URLSearchParams(location.search).get(name) || ''; }
  const WIKI_GUIDE_CATEGORIES = ['新手入门', '机制说明', '进阶策略', '工坊指南', '经济交易', '配装攻略', '心得分享'];
  let guideFilter = 'all';
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
    const active = page === 'guides-submit' ? 'guides' : page === 'search' ? 'home' : page;
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

  function renderHome() {
    const main = document.getElementById('main');
    main.textContent = '';
    const intro = card('WIKI 资料中心');
    intro.append(W().el('p', 'card-note', '钓场、攻略与工具跟随服务端规则更新；所有模拟只在本机计算，不会消耗游戏资产。'));
    const links = W().el('div', 'grid cols-3');
    [
      { name: '钓场与钓点', icon: '🌊', desc: '开放状态、增益、独立覆盖与当前有效产出权重。', href: 'grounds/index.html' },
      { name: '玩法攻略', icon: '📚', desc: '新手路线、产量优先级、工坊止损与资源循环。', href: 'guides/index.html' },
      { name: '更新记录', icon: '📜', desc: '同步主线版本演进与 Wiki 内容更新。', href: 'updates/index.html' }
    ].forEach(function (x) {
      const a = W().el('a', 'tile'); a.href = x.href;
      a.append(W().el('span', 'tile-emoji', x.icon), W().el('h3', 'tile-title', x.name), W().el('p', 'tile-desc', x.desc));
      links.append(a);
    });
    intro.append(links);
    const tools = card('实用工具');
    const toolGrid = W().el('div', 'grid cols-2');
    [
      { name: '配装模拟器', icon: '🧠', desc: '七部位编辑、当前钓点试算、A/B 对比、保存与分享。', href: 'tools/build.html' },
      { name: '熔炼模拟器', icon: '🔥', desc: '主副件、投料、概率、失败分支与批量模拟。', href: 'tools/smelt.html' }
    ].forEach(function (x) {
      const a = W().el('a', 'tile'); a.href = x.href;
      a.append(W().el('span', 'tile-emoji', x.icon), W().el('h3', 'tile-title', x.name), W().el('p', 'tile-desc', x.desc));
      toolGrid.append(a);
    });
    tools.append(toolGrid, W().el('p', 'card-note', '工具使用游戏工坊同款工作台布局与服务端共享规则；无法确认规则时自动禁用计算。'));
    const updates = card('最近内容更新');
    C().updates.slice(0, 4).forEach(function (x) {
      updates.append(W().el('p', 'card-note', x.date + ' · ' + x.title + ' — ' + x.summary));
    });
    main.append(pageHead('WIKI', '玩家资料与攻略中心'), intro, tools, updates);
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
    const input = W().el('input'); input.type = 'search'; input.id = 'page-search'; input.placeholder = '搜索钓场、攻略或工具'; input.value = qs('q');
    const type = W().el('select'); type.id = 'search-type'; type.setAttribute('aria-label', '结果类型');
    [['all','全部类型'],['ground','钓场'],['spot','钓点'],['guide','攻略'],['tool','工具']].forEach(function (x) {
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
        resultBox.append(W().el('p', 'card-note', '共显示 ' + rows.length + ' 条结果；钓场数据来自当前服务端规则。'));
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
    content.append(pageHead('全站搜索', '搜索钓场、攻略与实用工具。'), toolbar, resultBox);
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
    const meta = g.kind === 'user' ? '玩家投稿 · ' + (g.authorName || '玩家') : '官方攻略';
    a.append(W().el('h3', 'tile-title', g.title), W().el('p', 'tile-desc', meta + ' · ' + g.category + ' · ' + g.summary));
    return a;
  }
  function guideStatusLabel(status) {
    return status === 'pending' ? '待审核' : status === 'approved' ? '已通过' : status === 'rejected' ? '已拒绝' : status || '-';
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
      head.append(W().el('b', null, g.title), W().el('span', 'guide-status ' + g.status, guideStatusLabel(g.status)));
      row.append(head, W().el('p', 'item-sub', g.category + ' · 提交于 ' + new Date(g.submittedAt).toLocaleString('zh-CN')));
      if (g.reviewedAt) row.append(W().el('p', 'item-sub', '审核于 ' + new Date(g.reviewedAt).toLocaleString('zh-CN')));
      if (g.status === 'rejected' && g.reviewNote) row.append(W().el('div', 'callout warn', '拒绝原因：' + g.reviewNote));
      row.append(W().el('p', null, g.summary));
      if (g.status === 'pending') {
        const del = W().el('button', 'danger', '删除待审核攻略');
        del.type = 'button';
        del.addEventListener('click', async function () {
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
      c.append(W().el('p', 'card-note', '最近 24 小时已提交 ' + (myWiki.limits.submittedIn24h || 0) + ' / 3 篇 · 待审核 ' + (myWiki.limits.pending || 0) + ' / 3 篇' +
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
      const grid = W().el('div', 'grid cols-2');
      let rows = C().guides || [];
      if (guideFilter === 'official') rows = rows.filter(function (x) { return x.kind !== 'user'; });
      if (guideFilter === 'user') rows = rows.filter(function (x) { return x.kind === 'user'; });
      rows.forEach(function (x) { grid.append(guideCard(x)); });
      c.append(renderGuideFilter(), grid, W().el('p', 'card-note', '官方攻略支持后台热更新；玩家攻略需审核通过后展示。涉及当前数值时以快照和模拟器结果为准。'));
      if (!rows.length) c.append(empty('当前筛选下暂无攻略。'));
      if (!C().guides.length) c.append(W().el('div', 'callout warn', '攻略内容正在同步，或当前服务端未返回可用攻略。'));
      main.append(pageHead('玩法与攻略', '新手、机制、工坊、经济、配装与玩家心得。'), renderGuideActions(), c);
      return;
    }
    const c = card(g.title);
    const source = g.kind === 'user' ? '玩家投稿 · ' + (g.authorName || '玩家') : '官方攻略';
    c.append(W().el('p', 'item-sub', source + ' · ' + g.category + ' · 更新于 ' + new Date(g.updatedAt || '').toLocaleDateString('zh-CN')));
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
    const submit = W().el('button', 'primary', '提交审核'); submit.type = 'submit';
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
      submit.disabled = false; submit.textContent = '提交审核';
      if (!r.ok) { status.textContent = (r.data && r.data.error) || ('提交失败：HTTP ' + r.status); return; }
      W().storage.remove('wiki_guide_draft');
      location.href = '/wiki/guides/index.html?my=1';
    });
    drawSections();
    c.append(form);
    main.append(pageHead('贡献攻略', '提交后由管理员审核，通过后所有玩家可见。'), c);
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
      if (document.body.dataset.page === 'updates') render();
    }
  }
  function renderUpdates() {
    const main = document.getElementById('main'); main.textContent = '';
    const timeline = card('游戏版本演进');
    if (versionTimelineError) timeline.append(W().el('div', 'callout warn', versionTimelineError));
    else if (versionTimelineLoading || !Array.isArray(versionTimeline)) {
      timeline.append(empty('正在读取主线版本记录…'));
      ensureVersionTimeline();
    } else {
      const rows = versionTimeline.slice().reverse().map(function (v) {
        return [W().el('strong', null, v.version), v.date, v.summary];
      });
      const versionTable = table(['版本', '日期', '主要更新'], rows);
      versionTable.classList.add('version-table-wrap');
      timeline.append(versionTable);
      timeline.append(W().el('p', 'card-note', '数据同步自仓库 VERSIONS.md，覆盖主线 v0.2 至当前版本；最新版本在前。'));
    }
    const c = card('Wiki 内容更新');
    C().updates.forEach(function (x) {
      const item = W().el('article', 'branch');
      item.append(W().el('h3', null, x.date + ' · ' + x.title), W().el('p', null, x.summary));
      c.append(item);
    });
    main.append(pageHead('更新记录', '主线版本演进与 Wiki 内容更新。'), timeline, c);
  }
  function render() {
    setNavCurrent();
    const page = document.body.dataset.page;
    if (page === 'home') renderHome();
    else if (page === 'search') renderSearch();
    else if (page === 'grounds') renderGrounds();
    else if (page === 'guides') renderGuides();
    else if (page === 'guides-submit') renderGuideSubmit();
    else if (page === 'updates') renderUpdates();
  }
  function init() {
    let lastKey = '', lastUnavailable = null;
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

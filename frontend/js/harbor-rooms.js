/* DeepFish harbor — place interiors (prototype content; real pages keep their own logic). */
(function () {
  'use strict';
  const D = window.GameData || { allItems: () => [], itemIcon: () => '' };
  const ALL = D.allItems ? D.allItems() : [];
  const RANK = { common: 0, rare: 1, epic: 2, mythic: 3 }, RN = { common: '普通', rare: '稀有', epic: '史诗', mythic: '神话' };
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  let api;
  const icon = it => api.ASSET + (it.kind === 'fish' ? 'assets/fish/' + it.id + '.png' : D.itemIcon(it.id));
  const byId = id => ALL.find(i => i.id === id) || { id, name: id, rarity: 'common', kind: 'material', price: 0 };
  const img = (src, cls) => '<img' + (cls ? ' class="' + cls + '"' : '') + ' src="' + src + '" alt="" loading="lazy">';
  const itemIcon = id => icon(byId(id));
  const chip = (id, n, have) => '<span class="chip' + (have != null && have < n ? ' short' : '') + '">' + img(itemIcon(id)) + (have != null ? have + '/' : '×') + n + '</span>';

  // ---------- inventory ----------
  const FISH = ALL.filter(i => i.kind === 'fish');
  const pickFish = ['crucian', 'carp', 'grasscarp', 'silver', 'bream', 'catfish', 'bass', 'mackerel', 'grouper', 'cobia', 'tuna', 'sturgeon', 'halibut', 'rubysnapper'];
  const INV = [];
  FISH.filter(f => pickFish.includes(f.id) || INV.length < 0).concat(FISH.filter(f => !pickFish.includes(f.id)).slice(0, Math.max(0, 14 - FISH.filter(f => pickFish.includes(f.id)).length)))
    .slice(0, 14).forEach((f, i) => INV.push({ it: f, n: 1 + (i * 7) % 23, cm: Math.round(f.size ? f.size[0] + (f.size[1] - f.size[0]) * ((i * 37) % 100) / 100 : 0) }));
  ['bait_pack', 'rope', 'lure', 'tide_sand', 'chartfrag', 'dragon_scale', 'dragonpearl', 'ballast'].forEach((id, i) => { const it = byId(id); if (ALL.includes(it)) INV.push({ it, n: 3 + i * 4 }); });
  ['chest_wreck', 'chest_deep', 'chest_abyss'].forEach((id, i) => { const it = byId(id); if (ALL.includes(it)) INV.push({ it, n: 3 - i }); });
  const inv = { sel: null, q: '', sort: 'rarity' };
  function inventory(tab) {
    const kinds = [null, 'fish', 'material', 'chest', 'component'];
    const view = () => {
      let list = INV.filter(e => (!kinds[tab] || e.it.kind === kinds[tab]) && (!inv.q || e.it.name.includes(inv.q)));
      list = list.slice().sort(inv.sort === 'count' ? (a, b) => b.n - a.n : inv.sort === 'price' ? (a, b) => b.it.price - a.it.price : (a, b) => RANK[b.it.rarity] - RANK[a.it.rarity]);
      return list;
    };
    const grid = list => {
      if (tab === 4) return '<div class="box" style="text-align:center;padding:28px"><div class="px" style="font-size:24px;color:var(--gold)">组件</div><p>组件是带词缀的实例：同一底材按品质描边，悬停显示词缀。<br>这一格在正式版里沿用同一个格子组件。</p></div>';
      let s = '<div class="slots">'; list.forEach(e => { s += '<button class="slot ' + e.it.rarity + (inv.sel === e.it.id ? ' sel' : '') + '" data-id="' + e.it.id + '" aria-label="' + esc(e.it.name) + ' ' + RN[e.it.rarity] + ' ×' + e.n + '">' + img(icon(e.it)) + '<span class="q">' + e.n + '</span></button>'; });
      for (let i = list.length; i < Math.max(24, Math.ceil(list.length / 8) * 8); i++) s += '<div class="slot empty"></div>';
      return s + '</div>';
    };
    const detail = () => {
      const e = INV.find(x => x.it.id === inv.sel) || view()[0]; if (!e) return '<div class="box">空</div>'; inv.sel = e.it.id;
      const it = e.it, sellable = it.kind !== 'chest';
      return '<div class="box detail">' + img(icon(it), 'big') + '<div class="dn rc-' + it.rarity + '">' + esc(it.name) + '</div>' +
        '<dl class="kv"><dt>品质</dt><dd class="rc-' + it.rarity + '">' + RN[it.rarity] + '</dd><dt>持有</dt><dd>×' + e.n + '</dd>' +
        (e.cm ? '<dt>最大体型</dt><dd>' + e.cm + ' cm</dd>' : '') + '<dt>现价</dt><dd>' + it.price + ' 💰</dd><dt>小计</dt><dd>' + (it.price * e.n).toLocaleString() + ' 💰</dd></dl>' +
        '<div class="row" style="justify-content:center">' + (sellable ? '<button class="mini go" data-sell="1">出售 1</button><button class="mini" data-sell="all">全部出售</button><button class="mini">上架</button>' : '<button class="mini gold" data-go="chest">去开箱</button>') + '</div></div>';
    };
    const used = INV.length + 18;
    return {
      html: '<div class="toolbar"><input type="search" placeholder="搜索名称" value="' + esc(inv.q) + '" aria-label="搜索仓库"><select aria-label="排序"><option value="rarity">按品质</option><option value="count">按数量</option><option value="price">按价格</option></select>' +
        '<button class="mini">格子</button><button class="mini" style="opacity:.7">列表</button></div>' +
        '<div class="room2"><div id="inv-grid">' + grid(view()) + '</div><div id="inv-detail">' + detail() + '</div></div>' +
        '<div class="capbar"><span class="meta">已用 ' + used + ' / 120 格</span><div class="meter"><i style="width:' + used / 1.2 + '%"></i></div><button class="mini gold">⚡ 一键出售（预览）</button></div>' +
        '<details class="note"><summary>ⓘ 出售与上架规则</summary>出售走系统商店动态收购价（售出越多价越低）；上架收定价总额 1% 上架费，成交另收 10% 税。</details>',
      bind(root) {
        const sel = root.querySelector('select'); sel.value = inv.sort;
        const refresh = () => { root.querySelector('#inv-grid').innerHTML = grid(view()); root.querySelector('#inv-detail').innerHTML = detail(); };
        root.querySelector('input[type=search]').addEventListener('input', e => { inv.q = e.target.value.trim(); refresh(); });
        sel.addEventListener('change', () => { inv.sort = sel.value; refresh(); });
        root.addEventListener('click', e => {
          const s = e.target.closest('.slot[data-id]'); if (s) { inv.sel = s.dataset.id; refresh(); return; }
          const b = e.target.closest('[data-sell]'); if (b) { const en = INV.find(x => x.it.id === inv.sel), n = b.dataset.sell === 'all' ? en.n : 1; api.addCoins(en.it.price * n); en.n -= n; if (en.n <= 0) { INV.splice(INV.indexOf(en), 1); inv.sel = null; } api.toast('💰 卖出 ' + en.it.name + ' ×' + n); refresh(); return; }
          const g = e.target.closest('[data-go]'); if (g) api.openPlace(g.dataset.go);
        });
      },
    };
  }

  // ---------- workshop ----------
  const PARTS = [['竿身', 'rod_carbon', 6, 'epic'], ['卷线器', 'reel_smooth', 4, 'rare'], ['线组', 'line_nylon', 5, 'rare'], ['钩', 'hook_steel', 3, 'common'], ['饵', 'bait_corn', 2, 'common'], ['配件', 'acc_float', 4, 'rare'], ['护符', 'charm_jade', 1, 'epic']];
  let part = 0;
  function workshop(tab) {
    const st = api.st;
    if (tab === 0) return { html: '<div class="bench">' + [
      ['rod_carbon', '装备成长', '用航程凭证与精工热量强化 7 个部位', '3 个部位可强化', 1],
      ['charm_trident', '钓鱼套装', '集齐两件套装核心，激活套装效果', '2 套激活中', 2],
      ['resonance_crystal', '熔炼', '主副组件熔炼：主件留底材，副件搬词条', st.forgeReady ? '⚒ 熔炼完成，点这里取件' : '熔炼台空闲', 3]].map(b =>
      '<div class="pcard" data-tab-go="' + b[4] + '" tabindex="0" role="button">' + img(itemIcon(b[0]), 'ic') + '<b style="color:var(--gold)">' + b[1] + '</b><div class="sub">' + b[2] + '</div><div class="note" style="color:' + (b[3].startsWith('⚒') ? 'var(--gold)' : 'var(--accent)') + '">' + b[3] + '</div></div>').join('') + '</div>',
      bind(r) { r.addEventListener('click', e => { const c = e.target.closest('[data-tab-go]'); if (c) api.openPlace('workshop', +c.dataset.tabGo); }); } };
    if (tab === 1) {
      const pos = PARTS.map((q, i) => { const a = -Math.PI / 2 + i * 2 * Math.PI / PARTS.length; return [50 + Math.cos(a) * 36, 46 + Math.sin(a) * 34]; });
      const p = PARTS[part], need = [['航程凭证', 2, st.tickets], ['精工热量', 12, st.heat], ['金币', 800 + p[2] * 200, st.coins]];
      return {
        html: '<div class="room2"><div class="partmap">' + img(itemIcon('rod_carbon'), 'rod') + PARTS.map((q, i) => '<button class="slot ' + q[3] + (i === part ? ' sel' : '') + '" data-part="' + i + '" style="left:calc(' + pos[i][0] + '% - 32px);top:calc(' + pos[i][1] + '% - 22px)" aria-label="' + q[0] + ' +' + q[2] + '">' + img(itemIcon(q[1])) + '<span class="lvl">+' + q[2] + '</span><span class="pn">' + q[0] + '</span></button>').join('') + '</div>' +
          '<div class="box"><h5>' + p[0] + ' · +' + p[2] + ' → +' + (p[2] + 1) + '</h5><dl class="kv"><dt>钓速</dt><dd>+' + p[2] * 2 + '% → <span class="up">+' + (p[2] + 1) * 2 + '%</span></dd><dt>上钩率</dt><dd>+' + p[2] + '% → <span class="up">+' + (p[2] + 1) + '%</span></dd></dl>' +
          '<div>' + need.map(n => '<span class="chip' + (n[2] < n[1] ? ' short' : '') + '">' + n[0] + ' ' + n[1].toLocaleString() + '<small style="opacity:.7">（有 ' + n[2].toLocaleString() + '）</small></span>').join('') + '</div>' +
          '<div class="row"><button class="mini go" data-up' + (need.some(n => n[2] < n[1]) ? ' disabled' : '') + '>强化</button><button class="mini">强化到 +10</button></div><div class="note">材料不足时按钮置灰，缺的那一项标红。</div></div></div>',
        bind(r) { r.addEventListener('click', e => { const s = e.target.closest('[data-part]'); if (s) { part = +s.dataset.part; api.rerender(); return; } if (e.target.closest('[data-up]')) { const q = PARTS[part]; st.tickets -= 2; st.heat -= 12; api.addCoins(-(800 + q[2] * 200)); q[2]++; api.changed(); api.toast('✨ ' + q[0] + ' 强化到 +' + q[2]); api.rerender(); } }); },
      };
    }
    if (tab === 2) {
      const sets = (D.GEAR_SETS && Object.values(D.GEAR_SETS).slice(0, 6)) || [];
      const names = sets.length ? sets.map(s => s.name || '套装') : ['潮汐', '深渊', '龙宫', '风暴', '灯塔', '渔王'];
      return { html: '<div class="cards">' + names.map((n, i) => '<div class="pcard"><div class="row" style="justify-content:center">' + img(itemIcon(['charm_coin', 'charm_gold', 'charm_jade', 'charm_trident', 'dragonpearl', 'resonance_crystal'][i % 6]), 'ic') + '</div><b class="' + (i < 2 ? 'rc-epic' : '') + '">' + esc(n) + '</b><div class="sub">' + (i < 2 ? '2 / 2 · 已激活' : i < 4 ? '1 / 2' : '0 / 2') + '</div><div class="meter' + (i < 2 ? ' gold' : '') + '" style="margin-top:6px"><i style="width:' + (i < 2 ? 100 : i < 4 ? 50 : 0) + '%"></i></div></div>').join('') + '</div>' };
    }
    return {
      html: '<div class="forge"><button class="slot epic"><span class="cap">主组件</span>' + img(itemIcon('reel_turbo')) + '</button><span class="arrow">+</span><button class="slot rare"><span class="cap">副组件</span>' + img(itemIcon('reel_magnetic')) + '</button><span class="arrow">+</span><button class="slot rare"><span class="cap">催化</span>' + img(itemIcon('resonance_crystal')) + '<span class="q">2</span></button><span class="arrow">→</span><button class="slot ' + (st.forgeReady ? 'epic' : 'empty') + '"><span class="cap">产物</span>' + (st.forgeReady ? img(itemIcon('reel_turbo')) : '?') + '</button></div>' +
        '<div class="row" style="justify-content:center">' + (st.forgeReady ? '<button class="mini gold" data-take>取出产物</button>' : '<button class="mini go" data-forge>开始熔炼（演示 3 秒）</button>') + '</div>' +
        '<div class="note" style="text-align:center">熔炼完成后，港湾里的工坊会亮起「!」，烟囱冒火星。</div>',
      bind(r) {
        r.addEventListener('click', e => {
          if (e.target.closest('[data-forge]')) { api.toast('⚒ 熔炼中…关掉窗口看看工坊'); setTimeout(() => { st.forgeReady = true; api.changed(); api.toast('⚒ 熔炼完成'); api.rerender(); }, 3000); }
          if (e.target.closest('[data-take]')) { st.forgeReady = false; api.changed(); api.reward(itemIcon('reel_turbo'), '涡轮卷线器', 'epic', '熔炼产物已放入仓库'); api.rerender(); }
        });
      },
    };
  }

  // ---------- chest ----------
  const CHESTS = [['chest_wreck', '沉船宝匣', 'rare'], ['chest_deep', '深潜宝匣', 'rare'], ['chest_abyss', '深渊宝匣', 'epic'], ['chest_king', '海王遗匣', 'mythic']];
  const LOOT = { rare: [['tide_sand', '潮汐砂', 'rare'], ['chartfrag', '海图碎片', 'rare']], epic: [['dragon_scale', '龙鳞碎屑', 'epic'], ['charm_jade', '玉坠护符', 'epic']], mythic: [['charm_trident', '海王三叉护符', 'mythic']] };
  function chest(tab) {
    const st = api.st;
    if (tab === 1) return { html: '<div class="room2"><div class="box"><h5>合成 · 沉船宝匣</h5><div class="forge">' + '<button class="slot rare">' + img(itemIcon('relic')) + '<span class="q">7</span></button><span class="arrow">×10 →</span><button class="slot rare">' + img(itemIcon('chest_wreck')) + '</button></div><div class="meter"><i style="width:70%"></i></div><div class="note">沉船宝匣残片 7 / 10</div></div><div class="box"><h5>配方</h5><div>' + chip('relic', 10, 7) + chip('ballast', 2, 5) + '</div><div class="row"><button class="mini" disabled>合成</button></div></div></div>' };
    return {
      html: '<div class="cards">' + CHESTS.map((c, i) => '<div class="pcard" data-i="' + i + '" style="border-color:var(--r-' + c[2] + ')">' + img(itemIcon(c[0]), 'ic') + '<b class="rc-' + c[2] + '">' + c[1] + '</b><div class="sub">持有 ×' + st.chests[i] + '</div><div class="row" style="justify-content:center"><button class="mini ' + (st.chests[i] ? 'gold' : '') + '" data-open="' + i + '"' + (st.chests[i] ? '' : ' disabled') + '>开箱</button></div></div>').join('') + '</div><div class="note">开箱先摇三下，再按掉落品质播放光效；普通掉落只弹提示。</div>',
      bind(r) {
        r.addEventListener('click', e => {
          const b = e.target.closest('[data-open]'); if (!b) return; const i = +b.dataset.open, c = CHESTS[i], card = r.querySelector('.pcard[data-i="' + i + '"]');
          b.disabled = true; card.classList.add('shake');
          setTimeout(() => { st.chests[i]--; const pool = LOOT[c[2]] || LOOT.rare, l = pool[(Date.now() >> 4) % pool.length]; api.reward(itemIcon(l[0]), l[1], l[2], '从' + c[1] + '开出'); api.changed(); api.rerender(); }, 650);
        });
      },
    };
  }

  // ---------- market ----------
  function mall(tab) {
    const st = api.st;
    if (tab === 0) {
      const offers = [['bait_secret', 480, 2, 5], ['charm_gold', 2600, 1, 1], ['chartfrag', 320, 4, 10], ['ballast', 900, 0, 3]];
      return { html: '<div class="row"><span class="chip">🕒 限购 02:14:33 后刷新</span></div><div class="cards">' + offers.map(([id, p, left, max], i) => { const it = byId(id); return '<div class="pcard">' + img(icon(it), 'ic') + '<b class="rc-' + it.rarity + '">' + esc(it.name) + '</b><div class="sub">剩余 ' + left + ' / ' + max + '</div><div class="meter" style="margin:4px 0"><i style="width:' + left / max * 100 + '%"></i></div><button class="mini ' + (left ? 'go' : '') + '" data-buy="' + p + '"' + (left ? '' : ' disabled') + '>' + (left ? p.toLocaleString() + ' 💰' : '已售罄') + '</button></div>'; }).join('') + '</div>',
        bind(r) { r.addEventListener('click', e => { const b = e.target.closest('[data-buy]'); if (!b) return; if (st.coins < +b.dataset.buy) { api.toast('金币不够'); return; } api.addCoins(-b.dataset.buy); api.toast('🛒 购买成功，已放入仓库'); }); } };
    }
    if (tab === 1) {
      const rows = FISH.slice(0, 10).map((f, i) => ({ f, now: Math.max(1, Math.round(f.price * (.82 + ((i * 29) % 40) / 100))) }));
      return { html: '<div class="list-rows">' + rows.map(r => '<div class="lrow">' + img(icon(r.f)) + '<span class="nm">' + esc(r.f.name) + '<small>基准 ' + r.f.price + ' 💰</small></span><span class="num ' + (r.now >= r.f.price ? 'up' : 'down') + '">' + (r.now >= r.f.price ? '▲' : '▼') + ' ' + r.now + ' 💰</span><button class="mini">出售</button></div>').join('') + '</div><div class="note">收购价随全服出售量浮动：卖得越多价越低，每小时回升。</div>' };
    }
    const sellers = ['老王', '小张', '阿鱼', '海风', '渔夫K'], av = ['angler_cream_green_dark', 'angler_cream_red_light', 'angler_cream_blue_tan', 'angler_cream_green_light', 'angler_cream_red_tan'];
    const items = ['dragon_scale', 'tide_sand', 'charm_jade', 'deepscale', 'dragonpearl', 'lure'].map(byId);
    return { html: (st.sold ? '<div class="callout" style="margin-top:0">💰 你的挂单「潮汐砂 ×5」已售出，收入 1,215 金币（已扣 10% 税）。<button class="mini gold" data-claim>收下</button></div>' : '') +
      '<div class="list-rows">' + items.map((it, i) => '<div class="lrow">' + img(icon(it)) + '<span class="nm"><span class="rc-' + it.rarity + '">' + esc(it.name) + '</span><small><img src="' + api.ASSET + 'assets/ui/char/' + av[i % 5] + '.png" alt="" style="width:16px;height:16px;vertical-align:-3px;image-rendering:pixelated"> ' + sellers[i % 5] + ' · ×' + (1 + i * 2) + '</small></span><span class="num">' + Math.round(it.price * 1.3 + 20).toLocaleString() + ' 💰</span><button class="mini go">购买</button></div>').join('') + '</div>',
      bind(r) { const c = r.querySelector('[data-claim]'); if (c) c.onclick = () => { st.sold = 0; api.addCoins(1215); api.changed(); api.rerender(); }; } };
  }

  // ---------- tavern ----------
  const PLAYERS = [['老王', 'angler_cream_green_dark', 31, '🎣 钓鱼中 · 湖心深水'], ['小张', 'angler_cream_red_light', 18, '🎣 钓鱼中 · 灯塔礁'], ['阿鱼', 'angler_cream_blue_tan', 12, '💤 空闲 · 酒馆'], ['海风', 'angler_cream_green_light', 27, '⛵ 远航中'], ['渔夫K', 'angler_cream_red_tan', 40, '🎣 钓鱼中 · 海沟裂谷']];
  function ground(tab) {
    const st = api.st, card = p => '<div class="pcard">' + img(api.ASSET + 'assets/ui/char/' + p[1] + '.png', 'ic') + '<b>' + p[0] + ' <span style="color:var(--accent)">Lv.' + p[2] + '</span></b><div class="sub">' + p[3] + '</div><div class="row" style="justify-content:center"><button class="mini">加好友</button><button class="mini">组队</button></div></div>';
    if (tab === 0) return { html: '<div class="room2"><div class="cards">' + PLAYERS.slice(0, Math.max(1, st.online)).map(card).join('') + '</div><div class="box"><h5>📢 最新动态</h5><ul class="feed"><li>小张 在 灯塔礁 钓到 <span class="rc-epic">黄金枪鱼</span></li><li>老王 开出 <span class="rc-mythic">海王三叉护符</span></li><li>海风 的远航船归港</li><li>阿鱼 创下 鲫鱼 35cm 纪录</li></ul></div></div><div class="note">酒馆窗户里的人影数 = 在线玩家（最多显示 6 个）。</div>' };
    if (tab === 1) return { html: (st.friendReq ? '<div class="box" style="margin-bottom:10px"><h5>好友申请（' + st.friendReq + '）</h5>' + PLAYERS.slice(3, 3 + st.friendReq).map(p => '<div class="lrow">' + img(api.ASSET + 'assets/ui/char/' + p[1] + '.png') + '<span class="nm">' + p[0] + '<small>Lv.' + p[2] + '</small></span><span></span><span><button class="mini go" data-acc>同意</button> <button class="mini" data-acc>拒绝</button></span></div>').join('') + '</div>' : '') + '<div class="cards">' + PLAYERS.slice(0, 3).map(card).join('') + '</div>',
      bind(r) { r.addEventListener('click', e => { if (e.target.closest('[data-acc]')) { st.friendReq--; api.changed(); api.rerender(); } }); } };
    return { html: '<div class="cards">' + [PLAYERS[0], PLAYERS[1], null, null].map((p, i) => p ? card(p) : '<div class="pcard" style="border-style:dashed;display:grid;place-items:center;min-height:150px"><button class="mini">+ 邀请队友</button></div>').join('') + '</div><div class="note">编队最多 4 人，同钓场有上钩加成。</div>' };
  }

  // ---------- voyage ----------
  function sea(tab) {
    const st = api.st;
    if (tab === 1) return { html: '<div class="room2"><div class="box" style="text-align:center"><div class="px" style="font-size:24px;color:var(--gold)">⛵ 小帆船 Lv.3</div><dl class="kv"><dt>航速</dt><dd>1.2×</dd><dt>货舱</dt><dd>18 格</dd><dt>可达海域</dt><dd>近海渔场 · 深海鱼礁</dd></dl></div><div class="box"><h5>升级到 Lv.4</h5>' + chip('ballast', 6, 5) + chip('rope', 20, 22) + '<div class="row"><button class="mini" disabled>升级</button></div><div class="note">Lv.4 解锁「海沟裂谷」。</div></div></div>' };
    const k = st.voyageAway ? 1 - st.voyageLeft / 7200 : 0, x = 18 + k * 60, y = 70 - k * 38;
    return {
      html: '<div class="room2"><div class="voy"><svg viewBox="0 0 100 100" preserveAspectRatio="none"><path d="M18 70 Q 40 60 50 50 T 78 32" stroke="#ffd23e" stroke-width=".7" stroke-dasharray="2 2" fill="none"/></svg><span class="ship" style="left:' + x + '%;top:' + y + '%">⛵</span></div>' +
        '<div class="box"><h5>' + (st.voyageDone ? '船已归港' : st.voyageAway ? '远航中 · 近海渔场' : '船在港内') + '</h5>' +
        (st.voyageAway ? '<div class="px" style="font-size:24px;color:var(--gold)" data-voyleft>' + api.hms(st.voyageLeft) + '</div><div class="meter gold"><i style="width:' + k * 100 + '%"></i></div><div class="note">预计收获</div>' + chip('deepscale', 3) + chip('chartfrag', 1) + '<div class="row"><button class="mini" data-return>立即返航（演示）</button></div>'
          : st.voyageDone ? chip('deepscale', 3) + chip('chartfrag', 1) + '<div class="row"><button class="mini gold" data-claim>领取收获</button></div>'
            : '<p>选择海域后派船出海，灯塔会在远航期间整夜亮着。</p><div class="row"><button class="mini go" data-send>派船：近海渔场（2 小时）</button></div>') + '</div></div>',
      bind(r) {
        r.addEventListener('click', e => {
          if (e.target.closest('[data-send]')) { st.voyageAway = true; st.voyageLeft = 7200; api.changed(); api.toast('⛵ 船出港了'); api.rerender(); }
          if (e.target.closest('[data-return]')) { st.voyageAway = false; st.voyageDone = true; api.changed(); api.rerender(); }
          if (e.target.closest('[data-claim]')) { st.voyageDone = false; api.changed(); api.reward(itemIcon('deepscale'), '深海鳞片 ×3', 'rare', '远航收获已放入仓库'); api.rerender(); }
        });
      },
    };
  }

  // ---------- notice board ----------
  function board(tab) {
    const st = api.st;
    const dex = FISH.slice(0, 24).map((f, i) => '<img src="' + icon(f) + '" alt="' + (i % 3 === 2 ? '未解锁' : esc(f.name)) + '"' + (i % 3 === 2 ? ' class="no"' : '') + ' title="' + (i % 3 === 2 ? '？？？' : esc(f.name)) + '">').join('');
    const papers = [
      '<div class="paper"><h6>📖 图鉴 · 34 / 51</h6><div class="meter" style="margin-bottom:6px"><i style="width:67%"></i></div><div class="dex">' + dex + '</div></div>',
      '<div class="paper"><h6>🏆 纪录</h6><ol style="margin:0;padding-left:18px"><li>湖王鲈鱼 180cm · 老王</li><li>黄金枪鱼 296cm · 小张</li><li>巨骨舌鱼 312cm · 你</li></ol></div>',
      '<div class="paper"><h6>📜 日志</h6><div>21:02 出售 鲫鱼 ×12 +96💰</div><div>20:48 钓到 马鲛鱼 92cm</div><div>20:31 熔炼 失败，保留底材</div></div>',
      '<div class="paper"><h6>📮 反馈' + (st.feedbackReply ? ' · <span style="color:#b8302e">1 条新回复</span>' : '') + '</h6><textarea placeholder="说说你的建议或遇到的问题"></textarea><div class="row"><button class="mini go">提交</button>' + (st.feedbackReply ? '<button class="mini" data-read>查看回复</button>' : '') + '</div></div>',
    ];
    const pick = [[0], [1], [2], [3]][Math.min(tab, 3)];
    return { html: '<div class="cork">' + (tab === 0 ? papers.join('') : pick.map(i => papers[i]).join('')) + '</div><div class="note">告示板上钉的纸张数 = 有新内容的栏目（新纪录、反馈回复）。</div>',
      bind(r) { const b = r.querySelector('[data-read]'); if (b) b.onclick = () => { st.feedbackReply = 0; api.changed(); api.toast('管理员：已修复，谢谢反馈！'); api.rerender(); }; } };
  }

  // ---------- mailbox ----------
  const LETTERS = [
    { t: 'v0.25.3 维护补偿', from: '系统', at: '今天 09:00', body: '感谢耐心等待，附上维护补偿。', att: [['coins', 500], ['ballast', 2]], read: false },
    { t: '远航活动开启', from: '管理员', at: '昨天 20:14', body: '本周远航收益 +20%，别忘了派船出海。', att: [['chartfrag', 1]], read: false },
    { t: '市集成交通知', from: '市集', at: '昨天 11:32', body: '你的挂单「龙鳞碎屑 ×1」已成交。', att: [], read: true },
  ];
  let letter = null;
  function mail() {
    const st = api.st;
    const attHtml = a => a.map(([id, n]) => id === 'coins' ? '<span class="chip">💰 ' + n + '</span>' : chip(id, n)).join('');
    if (letter != null) {
      const L = LETTERS[letter];
      return { html: '<button class="mini" data-back>← 收件箱</button><div class="letter" style="margin-top:10px"><h6>' + esc(L.t) + '</h6><div class="meta" style="color:#6b5a48">' + L.from + ' · ' + L.at + '</div><p>' + esc(L.body) + '</p>' + (L.att.length ? '<div>' + attHtml(L.att) + '</div><div class="row"><button class="mini gold" data-take>领取附件</button></div>' : '') + '</div>',
        bind(r) { r.querySelector('[data-back]').onclick = () => { letter = null; api.rerender(); }; const t = r.querySelector('[data-take]'); if (t) t.onclick = () => { const c = L.att.find(a => a[0] === 'coins'); if (c) api.addCoins(c[1]); L.att = []; api.toast('📦 附件已领取'); api.rerender(); }; } };
    }
    return { html: '<div class="toolbar"><span class="meta">未读 ' + LETTERS.filter(l => !l.read).length + ' · 共 ' + LETTERS.length + ' 封</span><span style="flex:1"></span><button class="mini gold" data-all>一键领取</button></div><div class="envs">' +
      LETTERS.map((L, i) => '<button class="env ' + (L.read ? 'read' : 'unread') + '" data-l="' + i + '"><span class="ev"></span><span><b>' + (L.read ? '' : '<span class="dot"></span>') + esc(L.t) + '</b><small>' + L.from + ' · ' + L.at + '</small></span><span>' + attHtml(L.att) + '</span></button>').join('') + '</div><div class="note">邮筒的小旗 = 有未读或未领附件；全部读完、领完后放下。</div>',
      bind(r) {
        r.addEventListener('click', e => {
          const l = e.target.closest('[data-l]'); if (l) { letter = +l.dataset.l; LETTERS[letter].read = true; st.mail = LETTERS.filter(x => !x.read).length; api.changed(); api.rerender(); return; }
          if (e.target.closest('[data-all]')) { LETTERS.forEach(L => { const c = L.att.find(a => a[0] === 'coins'); if (c) api.addCoins(c[1]); L.att = []; L.read = true; }); st.mail = 0; api.changed(); api.toast('📦 全部附件已领取'); api.rerender(); }
        });
      } };
  }

  // ---------- fish house ----------
  const SKINS = ['cream'], CLOTH = [['blue', '#3b6fd4'], ['green', '#2f9c6a'], ['red', '#c83a3a']], TONE = [['light', '#f4d2b0'], ['tan', '#d6a070'], ['dark', '#8a5a3a']];
  function character(tab) {
    const st = api.st;
    if (tab === 0) {
      const k = st.houseFull ? 100 : 81;
      return { html: '<div class="scene-head"><span class="tag2">🏠 渔屋 Lv.5 · 静水湖</span></div><div class="room2" style="margin-top:10px"><div class="box"><h5>晒场收益</h5><div class="px" style="font-size:24px;color:var(--gold)">' + st.houseIncome + ' 💰</div><div class="meter gold"><i style="width:' + k + '%"></i></div><div class="note">' + (st.houseFull ? '8 / 8 小时 · 晒场满了，不再累积' : '6.5 / 8 小时 · 70.4 金币/小时') + '</div><div class="row"><button class="mini gold" data-collect>收取</button></div></div><div class="box"><h5>下一级</h5>' + chip('lure', 20, 26) + chip('relic', 1, 0) + '<div class="row"><button class="mini" disabled>升级</button></div></div></div>',
        bind(r) { r.querySelector('[data-collect]').onclick = () => { api.addCoins(st.houseIncome); st.houseIncome = 0; st.houseFull = false; api.changed(); api.rerender(); }; } };
    }
    if (tab === 1) return { html: '<div class="cards">' + [['金毛', 6, '晒场'], ['柯基', 3, '厨房'], ['阿拉斯加', 1, '—'], ['缅因猫', 0, '—']].map(p => '<div class="pcard"><div style="font-size:40px">' + (p[0] === '缅因猫' ? '🐈' : '🐕') + '</div><b>' + p[0] + ' ×' + p[1] + '</b><div class="sub">驻守：' + p[2] + '</div><button class="mini"' + (p[1] ? '' : ' disabled') + '>' + (p[2] === '—' ? '派驻' : '更换') + '</button></div>').join('') + '</div>' };
    if (tab === 2) {
      const [, cloth, tone] = st.avatar.match(/angler_cream_(\w+)_(\w+)/) || [0, 'blue', 'light'];
      return { html: '<div class="avatar-pick"><img class="av" src="' + api.ASSET + 'assets/ui/char/' + st.avatar + '.png" alt="角色预览"><div><div class="meta">衣服</div><div class="sw-row">' + CLOTH.map(c => '<button style="background:' + c[1] + '" aria-label="' + c[0] + '" aria-pressed="' + (c[0] === cloth) + '" data-cloth="' + c[0] + '"></button>').join('') + '</div><div class="meta">肤色</div><div class="sw-row">' + TONE.map(c => '<button style="background:' + c[1] + '" aria-label="' + c[0] + '" aria-pressed="' + (c[0] === tone) + '" data-tone="' + c[0] + '"></button>').join('') + '</div><div class="note">换装同步到 HUD 头像、栈桥上的钓手与酒馆名片。</div></div></div>',
        bind(r) { r.addEventListener('click', e => { const c = e.target.closest('[data-cloth],[data-tone]'); if (!c) return; st.avatar = 'angler_cream_' + (c.dataset.cloth || cloth) + '_' + (c.dataset.tone || tone); api.changed(); api.rerender(); }); } };
    }
    return { html: '<div class="room2"><div class="box" style="text-align:center">' + img(itemIcon('rod_carbon'), 'big') + '<div class="px rc-epic" style="font-size:24px">碳素竿 +6</div><dl class="kv"><dt>抛竿间隔</dt><dd>8.00s</dd><dt>上钩率</dt><dd>+18%</dd><dt>大鱼概率</dt><dd>+6%</dd></dl></div><div class="box"><h5>去强化</h5><p>部件强化、套装与熔炼都在工坊。</p><button class="mini go" data-go>⚒ 去工坊</button></div></div>',
      bind(r) { r.querySelector('[data-go]').onclick = () => api.openPlace('workshop', 1); } };
  }

  // ---------- pier → map ----------
  const PINS = [['湖畔老码头', 38, 52], ['芦苇荡', 43, 60], ['湖心深水', 46, 46, 'last'], ['落瀑潭', 50, 30], ['霜月冰窟', 42, 20, 'lk'], ['月牙沙滩', 34, 66], ['河口浅滩', 36, 50], ['灯塔礁', 30, 30], ['沉船残骸', 22, 64], ['村港码头', 47, 76], ['近海渔场', 64, 64, 'lk'], ['深海鱼礁', 74, 48, 'lk'], ['海沟裂谷', 84, 38, 'lk']];
  function fishing() {
    const st = api.st;
    return { html: '<div class="row"><button class="mini go" data-cont>🎣 继续：' + st.lastSpot + '</button>' + (st.fishing ? '<button class="mini" data-stop>收竿</button>' : '') + '<span class="meta">这是现有的钓鱼页（海图 + 实时钓鱼），港湾版只把侧栏换成「⚓ 回港湾」。</span></div><div class="map">' +
      PINS.map(p => '<button class="pin ' + (p[3] || '') + '" style="left:' + p[1] + '%;top:' + p[2] + '%" data-spot="' + p[0] + '">' + (p[3] === 'lk' ? '🔒 ' : p[3] === 'last' ? '📍 ' : '') + p[0] + '</button>').join('') + '</div>',
      bind(r) {
        r.addEventListener('click', e => {
          const p = e.target.closest('[data-spot]'); if (p) { if (p.classList.contains('lk')) { api.toast('🔒 ' + p.dataset.spot + ' 需要更高等级的船'); return; } st.lastSpot = p.dataset.spot; st.fishing = true; api.changed(); api.toast('🎣 在 ' + st.lastSpot + ' 抛竿'); api.rerender(); }
          if (e.target.closest('[data-cont]')) { st.fishing = true; api.changed(); api.closePanel(); api.toast('🎣 继续在 ' + st.lastSpot + ' 钓鱼'); }
          if (e.target.closest('[data-stop]')) { st.fishing = false; api.changed(); api.rerender(); }
        });
      } };
  }

  const ROOMS = { inventory, workshop, chest, mall, ground, sea, board, mail, character, fishing };
  window.HarborRooms = { render(id, tab, a) { api = a; if (id !== 'mail') letter = null; return ROOMS[id](tab); } };
})();

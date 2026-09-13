/*
 * 网页钓鱼小游戏 - UI 渲染与交互
 * 视图：钓鱼 / 钓竿BD / 渔场动态 / 系统商店 / 开放市集 / 在线交易 / 鱼类图鉴 / 大鱼记录
 */
window.UI = (function () {
  'use strict';
  const D = window.GameData;
  // 惰性获取：避免加载顺序问题
  function E() { return window.Engine; }
  function S() { return window.Engine.state; }

  let currentView = 'fishing';

  function $(id) { return document.getElementById(id); }
  function el(tag, cls, html) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    return e;
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }
  function colorFor(name) {
    let h = 0; for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360;
    return 'hsl(' + h + ',55%,55%)';
  }
  function rarityClass(r) { return 'r-' + r; }
  function timeStr(t) {
    const d = new Date(t);
    return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2) + ':' + ('0' + d.getSeconds()).slice(-2);
  }
  function itemMeta(id) { return D.itemOf ? D.itemOf(id) : { name: id, rarity: 'common', price: 10, kind: 'unknown' }; }

  // ---- Toast ----
  let toastTimer = null;
  function toast(msg) {
    const t = $('toast');
    if (!t) return;
    t.textContent = msg;
    t.classList.add('show');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove('show'); }, 2400);
  }

  // ---- 通用：调用网络接口并提示结果 ----
  function call(promise, okMsg) {
    return Promise.resolve(promise).then(function (r) {
      if (!r || !r.ok) { toast((r && r.data && r.data.error) || '操作失败'); return r; }
      if (okMsg) toast(typeof okMsg === 'function' ? okMsg(r) : okMsg);
      refreshAll();
      return r;
    }).catch(function () { toast('网络错误'); });
  }

  // ---- 侧边导航 ----
  function renderNav() {
    const nav = $('nav');
    nav.innerHTML = '';
    D.NAV.forEach(function (item) {
      const b = el('button', 'nav-item' + (item.id === currentView ? ' active' : '') + (item.implemented ? '' : ' locked'));
      let badge = '';
      if (item.id === 'fishing' && S().fishing.active) badge = '<span class="nav-badge on">钓</span>';
      if (item.id === 'trade' && S().trade) badge = '<span class="nav-badge alert">!</span>';
      b.innerHTML = '<span class="nav-icon">' + item.icon + '</span><span>' + esc(item.name) + '</span>' + badge +
        (item.implemented ? '' : '<span class="lock">🔒</span>');
      b.addEventListener('click', function () {
        if (!item.implemented) {
          toast('「' + item.name + '」功能尚未开放（框架占位）');
          return; // 未完成功能：不可跳转
        }
        currentView = item.id;
        renderNav();
        renderView();
      });
      nav.appendChild(b);
    });
  }

  // ---- 顶栏状态 ----
  function renderTopbar() {
    const p = S().player;
    const st = S();
    const statusText = p.status === 'fishing' ? '正在钓鱼' : (p.groundId ? '空闲' : '未出发');
    const loc = p.groundId
      ? (function () {
          const g = D.GROUNDS.find(function (x) { return x.id === p.groundId; });
          const sp = g && g.spots.find(function (x) { return x.id === p.spotId; });
          return g ? (g.name + (sp ? '·' + sp.name : '')) : '';
        })()
      : '—';
    $('player-status').innerHTML =
      '<span class="dot ' + (p.status === 'fishing' ? 'on' : 'idle') + '"></span>' +
      '<span class="pname">' + esc(p.name) + '</span>' +
      '<span class="meta">状态：' + statusText + '</span>' +
      '<span class="meta">位置：' + esc(loc) + '</span>' +
      '<span class="meta">在线：' + est.players + ' 人</span>' +
      '<span class="meta coins">💰 ' + p.coins + '</span>';
  }
  // 顶栏在线数用小工具（避免每次手写）
  const est = { get players() { return S().players.length; } };

  // ---- 钓鱼视图 ----
  function renderFishing() {
    const main = $('main');
    const st = S();
    main.innerHTML = '';

    // 左：选择钓场 / 钓点（带实时人数）
    const left = el('div', 'panel');
    left.innerHTML = '<h2>🎣 选择钓场与垂钓点</h2>';
    const groundWrap = el('div', 'ground-list');
    D.GROUNDS.forEach(function (g) {
      const cnt = (st.groundCounts && st.groundCounts[g.id]) || 0;
      const card = el('div', 'ground-card' + (g.locked ? ' locked' : '') + (st.selected.groundId === g.id ? ' sel' : ''));
      let spotsHtml = '';
      if (g.locked) {
        spotsHtml = '<div class="locked-note">活动钓场 · 即将开放</div>';
      } else {
        spotsHtml = '<div class="spot-row">';
        g.spots.forEach(function (sp) {
          const on = st.selected.groundId === g.id && st.selected.spotId === sp.id;
          spotsHtml += '<button class="spot-btn' + (on ? ' on' : '') + '" data-g="' + g.id + '" data-s="' + sp.id + '">' + esc(sp.name) + '</button>';
        });
        spotsHtml += '</div>';
      }
      card.innerHTML = '<div class="gc-head"><b>' + esc(g.name) + '</b>' +
        '<span class="gc-head-right">' +
        (g.locked ? '' : '<span class="gc-cnt' + (cnt > 0 ? ' live' : '') + '">👥 ' + cnt + ' 人</span>') +
        '<span class="tag ' + g.type + '">' + (g.type === 'normal' ? '普通钓场' : '活动钓场') + '</span></span></div>' +
        '<div class="gc-desc">' + esc(g.desc) + '</div>' + spotsHtml;
      groundWrap.appendChild(card);
    });
    groundWrap.addEventListener('click', function (ev) {
      const t = ev.target;
      if (!t || !t.classList.contains('spot-btn')) return;
      const gid = t.getAttribute('data-g');
      const sid = t.getAttribute('data-s');
      const atSame = st.fishing.active && st.player.groundId === gid && st.player.spotId === sid;
      if (atSame) {
        E().stopFishing();
        st.selected = { groundId: null, spotId: null };
        toast('已取消钓鱼，离开钓点');
      } else {
        const wasFishing = st.fishing.active;
        const r = E().startFishing(gid, sid);
        if (!r.ok) { toast(r.msg); return; }
        st.selected = { groundId: gid, spotId: sid };
        toast(wasFishing ? '已切换到新钓点，继续自动钓鱼' : '已开始自动钓鱼，系统将自动抛竿收杆');
      }
      renderTopbar(); renderNav(); renderFishing();
    });
    left.appendChild(groundWrap);

    const ctrl = el('div', 'fish-ctrl');
    const stateBar = el('div', 'fish-state' + (st.fishing.active ? ' on' : ''));
    if (st.fishing.active) {
      const g = D.GROUNDS.find(function (x) { return x.id === st.player.groundId; });
      const sp = g && g.spots.find(function (x) { return x.id === st.player.spotId; });
      stateBar.innerHTML = '<span class="dot on"></span> 自动钓鱼中 · ' + esc(g ? g.name : '') + (sp ? '·' + esc(sp.name) : '') +
        '<span class="state-hint">再次点击当前钓点可取消并离开</span>';
    } else {
      stateBar.innerHTML = '<span class="dot idle"></span> 未在钓鱼<span class="state-hint">点击任意垂钓点即可开始自动钓鱼</span>';
    }
    ctrl.appendChild(stateBar);
    left.appendChild(ctrl);
    main.appendChild(left);

    // 右：渔场实况
    const right = el('div', 'panel');
    right.innerHTML = '<h2>🌊 渔场实况</h2>';
    const atGroundId = st.player.groundId;
    const gNow = atGroundId ? D.GROUNDS.find(function (x) { return x.id === atGroundId; }) : null;
    const spNow = gNow && gNow.spots.find(function (x) { return x.id === st.player.spotId; });
    if (!atGroundId) {
      right.appendChild(el('div', 'here-count', '当前不在任何钓点'));
      right.appendChild(el('div', 'hint', '点击左侧任意垂钓点即可开始自动钓鱼。'));
    } else {
      const here = E().playersAtGround(atGroundId);
      right.appendChild(el('div', 'here-count', '所在：' + esc(gNow ? gNow.name : '') + (spNow ? '·' + esc(spNow.name) : '') + ' · 在线 ' + here.length + ' 人'));
      const peeps = el('div', 'peeps');
      if (here.length === 0) peeps.appendChild(el('div', 'hint', '暂无同一钓点的玩家。'));
      here.forEach(function (b) { peeps.appendChild(peepCard(b)); });
      right.appendChild(peeps);
    }

    right.appendChild(el('h3', null, '📜 我的渔获日志'));
    const log = el('div', 'catch-log');
    if (st.log.length === 0) log.appendChild(el('div', 'hint', '还没有渔获，去抛竿吧。'));
    st.log.slice(0, 25).forEach(function (e) {
      const meta = e.item || {};
      log.appendChild(el('div', 'log-line', timeStr(e.t) + ' · 钓到 <span class="' + rarityClass(meta.rarity) + '">' + esc(meta.name) +
        '</span>' + (meta.size ? ' <span class="muted">' + meta.size + 'cm</span>' : '') +
        (meta.rarity === 'big' ? ' 🐟大鱼' : meta.rarity === 'rare' ? ' ✨稀有' : '')));
    });
    right.appendChild(log);

    right.appendChild(el('h3', null, '🎒 背包'));
    right.appendChild(inventoryBlock({
      onSell: function (id) { call(window.Net.sell(id, 1), function (r) { return '售出 1 ×' + itemMeta(id).name + '，获得 💰' + r.data.gain; }).then(function (r) { if (r && r.ok) { S().player.coins = r.data.coins; S().inventory = r.data.inventory; S().shop = r.data.shop; renderTopbar(); renderView(); } }); },
      onList: function (id, qty, price) { call(window.Net.marketList(id, qty, price)).then(function (r) { if (r && r.ok) { S().inventory = r.data.inventory; renderTopbar(); renderView(); } }); },
    }));

    main.appendChild(right);
  }

  // 背包区块（钓鱼页与商店页共用）
  function inventoryBlock(opts) {
    opts = opts || {};
    const st = S();
    const wrap = el('div', 'inventory');
    const keys = Object.keys(st.inventory);
    if (keys.length === 0) { wrap.appendChild(el('div', 'hint', '背包空空如也。')); return wrap; }
    keys.sort(function (a, b) { return (itemMeta(b).price || 0) * st.inventory[b] - (itemMeta(a).price || 0) * st.inventory[a]; });
    keys.forEach(function (k) {
      const meta = itemMeta(k);
      const shopP = st.shop && st.shop[k];
      const row = el('div', 'inv-row');
      row.innerHTML = '<span class="' + rarityClass(meta.rarity) + '">' + esc(meta.name) + '</span>' +
        '<span class="cnt">×' + st.inventory[k] + '</span>';
      const acts = el('span', 'inv-acts');
      if (opts.onSell) {
        const sellUnit = shopP ? shopP.price : meta.price;
        const sb = el('button', 'mini primary-mini', '出售 ' + sellUnit + '💰');
        sb.title = '按当前系统收购价出售 1 个';
        sb.addEventListener('click', function () { opts.onSell(k); });
        acts.appendChild(sb);
      }
      if (opts.onList) {
        const lb = el('button', 'mini', '上架');
        lb.title = '挂到开放市集，由其他玩家购买';
        lb.addEventListener('click', function () {
          const qty = parseInt(prompt('上架数量（持有 ' + st.inventory[k] + '）', '1'), 10);
          if (!qty || qty <= 0) return;
          const base = shopP ? shopP.price : meta.price;
          const price = parseInt(prompt('单价（金币，建议参考系统价 ' + base + '）', String(base * 2)), 10);
          if (!price || price <= 0) return;
          opts.onList(k, Math.min(qty, st.inventory[k]), price);
        });
        acts.appendChild(lb);
      }
      row.appendChild(acts);
      wrap.appendChild(row);
    });
    return wrap;
  }

  function peepCard(b) {
    const st = S();
    const isSelf = st.me && b.id === st.me.id;
    const color = b.color || colorFor(b.name || '?');
    const g = D.GROUNDS.find(function (x) { return x.id === b.groundId; });
    const sp = g && g.spots.find(function (x) { return x.id === b.spotId; });
    const recent = (isSelf && st.player.recent) ? st.player.recent : b.recent;
    const card = el('div', 'peep' + (isSelf ? ' self' : ''));
    card.innerHTML =
      '<span class="avatar" style="background:' + color + '">' + esc((b.name || '?').slice(0, 1)) + '</span>' +
      '<div class="peep-info"><div class="peep-name">' + esc(b.name || '玩家') + (isSelf ? '（你）' : '') +
      ' <span class="dot ' + (b.status === 'fishing' ? 'on' : 'idle') + '"></span></div>' +
      '<div class="peep-loc">' + (g ? esc(g.name) : '未出发') + (sp ? '·' + esc(sp.name) : '') + '</div>' +
      (recent ? '<div class="peep-recent">近期：' + esc(recent) + '</div>' : '') + '</div>';
    return card;
  }

  // ---- 钓竿 BD 视图 ----
  function renderBD() {
    const main = $('main');
    main.innerHTML = '';
    const panel = el('div', 'panel wide');
    panel.innerHTML = '<h2>🎯 钓竿 BD（默认配置）</h2>' +
      '<p class="hint">当前为框架版：所有部位默认安装「标准」组件，<b>无效果</b>；词缀与饰品联动为占位框架，后续设计。</p>';
    const grid = el('div', 'bd-grid');
    D.ROD_PARTS.forEach(function (part) {
      const comp = S().bd[part.key] || { name: part.default.name };
      const cell = el('div', 'bd-cell' + (part.isCharm ? ' charm' : ''));
      cell.innerHTML =
        '<div class="bd-part">' + esc(part.name) + (part.isCharm ? ' <span class="charm-tag">饰品</span>' : '') + '</div>' +
        '<div class="bd-comp">' + esc(comp.name) + '</div>' +
        '<div class="affix-frame"><div class="af-title">词缀框架</div>' +
        '<div class="af-line">普通词缀：<span class="muted">—（默认无词缀）</span></div>' +
        '<div class="af-line">稀有词缀：<span class="muted">—（默认无稀有词缀）</span></div></div>';
      grid.appendChild(cell);
    });
    panel.appendChild(grid);
    panel.appendChild(el('div', 'note-block',
      '<b>词缀框架说明</b><br>' + esc(D.AFFIX_FRAMEWORK.normalNote) + '<br>' + esc(D.AFFIX_FRAMEWORK.rareNote) +
      '<br><br>饰品栏位可用于特殊效果与部位/词缀联动（占位，未实现）。'));
    const bdCtrl = el('div', 'bd-ctrl');
    const saveBtn = el('button', 'primary locked', '保存 / 切换 BD');
    saveBtn.addEventListener('click', function () { toast('BD 管理功能尚未开放（框架占位）'); });
    bdCtrl.appendChild(saveBtn);
    panel.appendChild(bdCtrl);
    main.appendChild(panel);
  }

  // ---- 渔场动态视图（放大框体 + 各渔场人数） ----
  function renderGround() {
    const main = $('main');
    const st = S();
    main.innerHTML = '';
    const panel = el('div', 'panel wide ground-panel');
    panel.innerHTML = '<h2>🌊 渔场动态（全服实时）</h2>';

    // 各渔场人数概览
    const counts = el('div', 'ground-counts');
    D.GROUNDS.forEach(function (g) {
      const c = (st.groundCounts && st.groundCounts[g.id]) || 0;
      const box = el('div', 'gc-box' + (g.locked ? ' locked' : '') + (c > 0 ? ' live' : ''));
      box.innerHTML = '<div class="gcb-name">' + esc(g.name) + '</div>' +
        '<div class="gcb-num">' + c + '<span class="u">人</span></div>';
      counts.appendChild(box);
    });
    counts.appendChild(el('div', 'gc-box total',
      '<div class="gcb-name">全服在线</div><div class="gcb-num">' + st.players.length + '<span class="u">人</span></div>'));
    panel.appendChild(counts);

    const cols = el('div', 'ground-cols');
    // 在线玩家
    const left = el('div', 'sub');
    left.appendChild(el('h3', null, '👥 在线玩家（' + st.players.length + '）'));
    const list = el('div', 'peeps');
    if (st.players.length === 0) list.appendChild(el('div', 'hint', '暂无在线玩家。'));
    // 在线优先、钓鱼中排前
    st.players.slice().sort(function (a, b) {
      const ra = a.status === 'fishing' ? 0 : 1, rb = b.status === 'fishing' ? 0 : 1;
      return ra - rb || String(a.name).localeCompare(String(b.name));
    }).forEach(function (b) { list.appendChild(peepCard(b)); });
    left.appendChild(list);
    cols.appendChild(left);

    // 动态 feed（放大）
    const right = el('div', 'sub');
    right.appendChild(el('h3', null, '📡 最新动态'));
    const feed = el('div', 'feed feed-big');
    if (st.feed.length === 0) feed.appendChild(el('div', 'hint', '暂无动态，等待大家上鱼……'));
    st.feed.slice(0, 60).forEach(function (e) {
      const meta = e.item || {};
      const line = el('div', 'feed-line' + (e.record ? ' record' : ''));
      line.innerHTML = '<span class="ftime">' + timeStr(e.t) + '</span> <b>' + esc(e.who) + '</b> 在 ' +
        esc(e.ground) + '·' + esc(e.spot) + ' 钓到 <span class="' + rarityClass(meta.rarity) + '">' + esc(meta.name) + '</span>' +
        (e.size ? ' <span class="muted">' + e.size + 'cm</span>' : '') +
        (e.record ? ' 🏆刷新纪录' : meta.rarity === 'big' ? ' 🐟大鱼' : meta.rarity === 'rare' ? ' ✨稀有' : meta.kind === 'component' ? ' 🔧组件' : '');
      feed.appendChild(line);
    });
    right.appendChild(feed);
    cols.appendChild(right);
    panel.appendChild(cols);
    main.appendChild(panel);
  }

  // ---- 系统商店视图 ----
  function renderShop() {
    const main = $('main');
    const st = S();
    main.innerHTML = '';
    const panel = el('div', 'panel two-col');
    panel.innerHTML = '<h2>🏪 系统商店 <span class="subtitle">动态收购价 · 售出越多价格越低，随时间回升</span></h2>';

    const colMain = el('div', 'col-main');
    const grid = el('div', 'shop-grid');
    Object.keys(st.shop || {}).forEach(function (id) {
      const s = st.shop[id];
      const meta = itemMeta(id);
      const ratio = s.base ? s.price / s.base : 1;
      const pct = Math.round(ratio * 100);
      const cls = ratio < 0.75 ? 'low' : ratio < 0.95 ? 'mid' : 'high';
      const card = el('div', 'shop-card');
      const have = st.inventory[id] || 0;
      card.innerHTML =
        '<div class="sc-name ' + rarityClass(meta.rarity) + '">' + esc(meta.name) + '</div>' +
        '<div class="sc-price ' + cls + '">💰 ' + s.price + '<span class="base">基准 ' + s.base + '</span></div>' +
        '<div class="sc-bar"><i style="width:' + Math.max(6, Math.min(100, pct)) + '%"></i></div>' +
        '<div class="sc-pct">当前 ' + pct + '% · 持有 ' + have + '</div>';
      const btn = el('button', 'mini' + (have > 0 ? ' primary-mini' : ' locked'), have > 0 ? '出售 1 个' : '无库存');
      if (have > 0) {
        btn.addEventListener('click', function () {
          call(window.Net.sell(id, 1), function (r) { return '售出 ' + meta.name + '，获得 💰' + r.data.gain + '（单价 ' + r.data.unit + '）'; })
            .then(function (r) { if (r && r.ok) { st.player.coins = r.data.coins; st.inventory = r.data.inventory; st.shop = r.data.shop; renderTopbar(); renderView(); } });
        });
      }
      card.appendChild(btn);
      grid.appendChild(card);
    });
    colMain.appendChild(grid);
    panel.appendChild(colMain);

    const side = el('div', 'col-side');
    side.appendChild(el('h3', null, '🎒 我的背包'));
    side.appendChild(el('div', 'hint', '点击「出售」按当前收购价卖给系统；「上架」挂到开放市集等玩家购买（市集抽 10% 税）。'));
    side.appendChild(inventoryBlock({
      onSell: function (id) {
        call(window.Net.sell(id, 1), function (r) { return '售出 1 ×' + itemMeta(id).name + '，获得 💰' + r.data.gain; })
          .then(function (r) { if (r && r.ok) { st.player.coins = r.data.coins; st.inventory = r.data.inventory; st.shop = r.data.shop; renderTopbar(); renderView(); } });
      },
      onList: function (id, qty, price) {
        call(window.Net.marketList(id, qty, price), '已上架到市集').then(function (r) { if (r && r.ok) { st.inventory = r.data.inventory; renderTopbar(); renderView(); } });
      },
    }));
    panel.appendChild(side);
    main.appendChild(panel);
  }

  // ---- 开放市集视图 ----
  function renderMarket() {
    const main = $('main');
    const st = S();
    const me = st.me;
    main.innerHTML = '';
    const panel = el('div', 'panel wide two-col');
    panel.innerHTML = '<h2>💱 开放市集 <span class="subtitle">玩家自由定价 · 成交收取 10% 交易税</span></h2>';

    const colMain = el('div', 'col-main');
    colMain.appendChild(el('h3', null, '📦 全部挂单（' + (st.market ? st.market.length : 0) + '）'));
    const list = el('div', 'market-list');
    if (!st.market || st.market.length === 0) {
      list.appendChild(el('div', 'hint', '市集暂无挂单。你可以在右侧「我的背包」里上架物品。'));
    } else {
      st.market.slice().sort(function (a, b) { return b.t - a.t; }).forEach(function (l) {
        const meta = itemMeta(l.id);
        const mine = me && l.seller === me.id;
        const total = l.price * l.qty;
        const row = el('div', 'mk-row' + (mine ? ' mine' : ''));
        row.innerHTML =
          '<div class="mk-main"><div class="mk-name ' + rarityClass(meta.rarity) + '">' + esc(l.name) + ' <span class="qty">×' + l.qty + '</span></div>' +
          '<div class="mk-sub">卖家：' + esc(l.sellerName) + (mine ? '（你）' : '') + ' · 上架 ' + timeStr(l.t) + '</div></div>' +
          '<div class="mk-price"><b>💰 ' + l.price + '</b><span class="unit">/个</span><div class="total">合计 ' + total + '</div></div>';
        const acts = el('div', 'mk-acts');
        if (mine) {
          const cb = el('button', 'mini', '下架');
          cb.addEventListener('click', function () {
            call(window.Net.marketCancel(l.lid), '已下架').then(function (r) { if (r && r.ok) { st.inventory = r.data.inventory; renderTopbar(); renderView(); } });
          });
          acts.appendChild(cb);
        } else {
          const bb = el('button', 'mini primary-mini', '购买');
          bb.addEventListener('click', function () {
            // 支持自定义数量：默认 1，最多本挂单剩余数量
            const input = prompt('购买数量（本挂单剩余 ' + l.qty + ' 个，单价 💰' + l.price + '）', '1');
            if (input == null) return;
            let n = parseInt(input, 10);
            if (!n || n <= 0) { toast('请输入有效的购买数量'); return; }
            n = Math.min(n, l.qty);
            const total = l.price * n;
            if (!confirm('花费 💰' + total + ' 购买 ' + l.name + ' ×' + n + ' ？')) return;
            call(window.Net.marketBuy(l.lid, n), '购买成功：' + l.name + ' ×' + n).then(function (r) {
              if (r && r.ok) { st.player.coins = r.data.coins; st.inventory = r.data.inventory; renderTopbar(); renderView(); }
            });
          });
          acts.appendChild(bb);
        }
        row.appendChild(acts);
        list.appendChild(row);
      });
    }
    colMain.appendChild(list);
    colMain.appendChild(el('div', 'hint', '提示：买到的物品可拿去系统商店出售赚差价，但市集成交要付 10% 税（由卖家承担）。'));
    panel.appendChild(colMain);

    const side = el('div', 'col-side');
    side.appendChild(el('h3', null, '🎒 我的背包'));
    side.appendChild(el('div', 'hint', '「上架」把你的物品挂到市集，由其他玩家购买；可自定义数量与单价。'));
    side.appendChild(inventoryBlock({
      onList: function (id, qty, price) {
        call(window.Net.marketList(id, qty, price), '已上架到市集').then(function (r) { if (r && r.ok) { st.inventory = r.data.inventory; renderTopbar(); renderView(); } });
      },
    }));
    panel.appendChild(side);

    main.appendChild(panel);
  }

  // ---- 在线交易（以物易物） ----
  // 交易草稿状态：必须放在模块级并在重绘间保留，否则任何一次重绘
  // （SSE 广播非常频繁）都会把用户刚勾选的物品清空。
  let tradeDraft = { tid: null, sel: {} };

  function draftFor(t) {
    if (tradeDraft.tid !== t.id) {
      // 新交易会话：以服务器当前提供项为初始草稿
      const meIsA = S().me && t.a.key === S().me.id;
      const myItems = meIsA ? (t.aItems || []) : (t.bItems || []);
      const sel = {};
      myItems.forEach(function (it) { sel[it.id] = it.qty; });
      tradeDraft = { tid: t.id, sel: sel };
    }
    if (!tradeDraft.sel) tradeDraft.sel = {};
    return tradeDraft.sel;
  }

  function renderTrade() {
    const main = $('main');
    const st = S();
    main.innerHTML = '';
    const panel = el('div', 'panel wide');
    panel.innerHTML = '<h2>🤝 在线交易 <span class="subtitle">以物易物 · 双方确认后成交 · 双方免税</span></h2>';

    if (st.tradeFlash) { panel.appendChild(el('div', 'trade-flash', '✅ ' + esc(st.tradeFlash))); st.tradeFlash = null; }

    const t = st.trade;
    if (!t) {
      tradeDraft = { tid: null, sel: {} };
      // 无交易：发起邀请 / 接收邀请
      const onlines = st.players.filter(function (p) { return !st.me || p.id !== st.me.id; });
      const box = el('div', 'trade-invite');
      box.appendChild(el('h3', null, '发起交易邀请'));
      if (onlines.length === 0) {
        box.appendChild(el('div', 'hint', '当前没有其他在线玩家。多开一个浏览器标签即可测试。'));
      } else {
        const row = el('div', 'invite-row');
        onlines.forEach(function (p) {
          const b = el('button', 'mini primary-mini', '邀请 ' + esc(p.name));
          b.addEventListener('click', function () {
            call(window.Net.tradeInvite(p.id), '邀请已发出，等待对方接受').then(function (r) { if (r && r.ok) setTimeout(refreshAll, 300); });
          });
          row.appendChild(b);
        });
        box.appendChild(row);
      }
      panel.appendChild(box);
      main.appendChild(panel);
      return;
    }

    // 有交易：先确定双方身份，再按阶段渲染
    const meIsA = !!(st.me && t.a.key === st.me.id);
    const myItems = meIsA ? t.aItems : t.bItems;
    const otherItems = meIsA ? t.bItems : t.aItems;
    const myOk = meIsA ? t.aOk : t.bOk;
    const otherOk = meIsA ? t.bOk : t.aOk;
    const otherName = meIsA ? t.b.name : t.a.name;
    const otherKey = meIsA ? t.b.key : t.a.key;
    const cd = Math.max(0, (t.cooldownUntil || 0) - Date.now());
    const sel = draftFor(t);

    const head = el('div', 'trade-head');
    head.innerHTML = '<div class="th-with">交易对象：<b>' + esc(otherName) + '</b> <span class="live-check">' +
      (st.players.some(function (p) { return p.id === otherKey; }) ? '在线' : '已离线') + '</span></div>' +
      '<div class="th-stage">' + (!t.accepted ? '等待对方接受邀请…' : (cd > 0 ? '确认已重置，冷却 ' + Math.ceil(cd / 1000) + 's' : '请双方放入物品并确认')) + '</div>';
    panel.appendChild(head);

    if (!t.accepted) {
      const acts = el('div', 'trade-actions');
      if (meIsA) {
        // 我是发起方：只能等待或撤回，不应看到「接受邀请」
        const wd = el('button', 'mini', '撤回邀请');
        wd.addEventListener('click', function () { call(window.Net.tradeCancel(t.id), '已撤回邀请'); });
        acts.appendChild(wd);
      } else {
        const ok = el('button', 'primary', '接受邀请');
        ok.addEventListener('click', function () { call(window.Net.tradeRespond(t.id, true), null).then(function (r) { if (r && r.ok) setTimeout(refreshAll, 200); }); });
        const no = el('button', 'mini', '拒绝');
        no.addEventListener('click', function () { call(window.Net.tradeRespond(t.id, false), '已拒绝交易'); });
        acts.appendChild(ok); acts.appendChild(no);
      }
      panel.appendChild(acts);
    } else {
      const sides = el('div', 'trade-sides');
      sides.appendChild(tradeSide('我的提供', myItems, myOk, true));
      sides.appendChild(tradeSide(otherName + ' 的提供', otherItems, otherOk, false));
      sides.appendChild(tradePicker(t, sel));
      panel.appendChild(sides);

      const acts = el('div', 'trade-actions');
      const confirmBtn = el('button', 'primary' + (myOk ? ' done' : '') + (cd > 0 ? ' locked' : ''), myOk ? '✔ 已确认' : (cd > 0 ? '冷却中 ' + Math.ceil(cd / 1000) + 's' : '确认交易'));
      if (!myOk && cd <= 0) {
        confirmBtn.addEventListener('click', function () {
          call(window.Net.tradeConfirm(t.id), null).then(function (r) { if (r && r.ok) setTimeout(refreshAll, 200); });
        });
      }
      const cancelBtn = el('button', 'mini', '取消交易');
      cancelBtn.addEventListener('click', function () { call(window.Net.tradeCancel(t.id), '交易已取消'); });
      acts.appendChild(confirmBtn); acts.appendChild(cancelBtn);
      panel.appendChild(acts);
    }

    main.appendChild(panel);
  }

  function tradeSide(title, items, ok, isMine) {
    const box = el('div', 'trade-side' + (isMine ? ' mine' : ''));
    box.innerHTML = '<div class="ts-head">' + esc(title) + (ok ? ' <span class="ok-tag">✔ 已确认</span>' : ' <span class="wait-tag">待确认</span>') + '</div>';
    const list = el('div', 'ts-list');
    if (!items || items.length === 0) list.appendChild(el('div', 'hint', '（空）'));
    (items || []).forEach(function (it) {
      const meta = itemMeta(it.id);
      list.appendChild(el('div', 'ts-item', '<span class="' + rarityClass(meta.rarity) + '">' + esc(meta.name) + '</span><span class="cnt">×' + it.qty + '</span>'));
    });
    box.appendChild(list);
    return box;
  }

  // 我方物品选择器：勾选 + 数量。选择写入模块级草稿，重绘不丢失。
  // 点击「更新」提交后，服务器会让双方确认作废并进入 3s 冷却。
  function tradePicker(t, sel) {
    const st = S();
    // 清理已不在背包中的草稿项（例如中途把物品卖掉了）
    Object.keys(sel).forEach(function (id) { if (!(st.inventory[id] > 0)) delete sel[id]; });
    const box = el('div', 'trade-picker');
    box.innerHTML = '<div class="tp-head">选择我要提供的物品（改动会重置双方确认）</div>';
    const keys = Object.keys(st.inventory);
    if (keys.length === 0) { box.appendChild(el('div', 'hint', '背包为空，无法提供物品。')); return box; }
    const rows = el('div', 'tp-rows');
    keys.forEach(function (id) {
      const meta = itemMeta(id);
      const have = st.inventory[id];
      const checked = sel[id] != null && sel[id] > 0;
      const qty = checked ? Math.min(sel[id], have) : 1;
      const row = el('div', 'tp-row');
      row.innerHTML = '<label class="tp-name"><input type="checkbox" data-id="' + id + '"' + (checked ? ' checked' : '') + ' /> <span class="' +
        rarityClass(meta.rarity) + '">' + esc(meta.name) + '</span></label>' +
        '<span class="tp-have">持有 ' + have + '</span>' +
        '<input class="tp-qty" type="number" min="1" max="' + have + '" value="' + qty + '"' + (checked ? '' : ' disabled') + ' />';
      rows.appendChild(row);

      const cb = row.querySelector('input[type=checkbox]');
      const qi = row.querySelector('input.tp-qty');
      cb.addEventListener('change', function () {
        if (cb.checked) { sel[id] = Math.max(1, Math.min(have, parseInt(qi.value, 10) || 1)); qi.disabled = false; }
        else { delete sel[id]; qi.disabled = true; }
      });
      qi.addEventListener('input', function () {
        if (!cb.checked) return;
        sel[id] = Math.max(1, Math.min(have, parseInt(qi.value, 10) || 1));
      });
    });
    box.appendChild(rows);

    const apply = el('button', 'mini primary-mini', '更新我的提供');
    apply.addEventListener('click', function () {
      const items = Object.keys(sel)
        .filter(function (id) { return (st.inventory[id] || 0) > 0; })
        .map(function (id) {
          return { id: id, qty: Math.max(1, Math.min(st.inventory[id], sel[id])) };
        });
      if (items.length === 0 && !confirm('你还没有选择任何物品，确定要清空「我的提供」吗？')) return;
      call(window.Net.tradeSet(t.id, items), '已更新我的提供（双方确认已重置）').then(function (r) { if (r && r.ok) setTimeout(refreshAll, 200); });
    });
    box.appendChild(apply);
    return box;
  }

  // ---- 鱼类图鉴视图 ----
  function renderCodex() {
    const main = $('main');
    const st = S();
    main.innerHTML = '';
    const panel = el('div', 'panel wide');
    const caught = st.codex || {};
    const total = Object.keys(caught).length;
    panel.innerHTML = '<h2>📖 鱼类图鉴 <span class="subtitle">个人收集进度</span></h2>';

    // 汇总
    const items = D.allItems();
    const fishItems = items.filter(function (i) { return i.kind === 'fish'; });
    const gotFish = fishItems.filter(function (i) { return caught[i.id]; }).length;
    const summary = el('div', 'codex-summary');
    summary.innerHTML = '<div class="cs-box"><b>' + gotFish + ' / ' + fishItems.length + '</b><span>鱼类收集</span></div>' +
      '<div class="cs-box"><b>' + total + '</b><span>图鉴条目</span></div>' +
      '<div class="cs-box"><b>' + (st.catchCount || 0) + '</b><span>累计渔获</span></div>';
    panel.appendChild(summary);

    const grid = el('div', 'codex-grid');
    items.forEach(function (it) {
      const rec = caught[it.id];
      const cell = el('div', 'codex-cell' + (rec ? ' got' : '') + ' k-' + it.kind);
      if (rec) {
        cell.innerHTML = '<div class="cx-name ' + rarityClass(it.rarity) + '">' + esc(it.name) + '</div>' +
          '<div class="cx-meta">已钓 ' + rec.count + ' 次</div>' +
          '<div class="cx-meta muted">首获 ' + timeStr(rec.first) + '</div>' +
          (it.size ? '<div class="cx-meta muted">体型 ' + it.size[0] + '-' + it.size[1] + 'cm</div>' : '<div class="cx-meta muted">材料 / 组件</div>');
      } else {
        cell.innerHTML = '<div class="cx-name locked-name">' + esc(it.name) + '</div><div class="cx-meta">未解锁</div>';
      }
      grid.appendChild(cell);
    });
    panel.appendChild(grid);
    main.appendChild(panel);
  }

  // ---- 大鱼记录视图 ----
  function renderRecords() {
    const main = $('main');
    const st = S();
    main.innerHTML = '';
    const panel = el('div', 'panel wide');
    panel.innerHTML = '<h2>🏆 大鱼记录 <span class="subtitle">全服最大体型榜</span></h2>';

    const recs = Object.keys(st.records || {}).map(function (id) { return st.records[id]; })
      .sort(function (a, b) { return b.size - a.size; });
    if (recs.length === 0) {
      panel.appendChild(el('div', 'hint', '还没有大鱼记录。第一条纪录等着你来刷新！'));
    } else {
      const list = el('div', 'record-list');
      recs.forEach(function (r, i) {
        const meta = itemMeta(r.id);
        const rank = i + 1;
        const row = el('div', 'rec-row' + (rank <= 3 ? ' top top-' + rank : ''));
        row.innerHTML =
          '<div class="rec-rank">' + (rank === 1 ? '🥇' : rank === 2 ? '🥈' : rank === 3 ? '🥉' : '#' + rank) + '</div>' +
          '<div class="rec-main"><div class="rec-name ' + rarityClass(meta.rarity) + '">' + esc(r.name) + '</div>' +
          '<div class="rec-who">纪录保持者：' + esc(r.who) + ' · ' + timeStr(r.t) + '</div></div>' +
          '<div class="rec-size">' + r.size + '<span class="u">cm</span></div>';
        list.appendChild(row);
      });
      panel.appendChild(list);
    }

    // 我钓过的最大体型（从本地日志近似）
    const mine = {};
    st.log.forEach(function (e) {
      const it = e.item || {};
      if (!it.size) return;
      if (!mine[it.id] || it.size > mine[it.id].size) mine[it.id] = { name: it.name, size: it.size, rarity: it.rarity };
    });
    const mkeys = Object.keys(mine);
    if (mkeys.length) {
      panel.appendChild(el('h3', null, '🎣 我的最佳（本次会话）'));
      const ml = el('div', 'record-list small');
      mkeys.sort(function (a, b) { return mine[b].size - mine[a].size; }).forEach(function (id) {
        const m = mine[id];
        ml.appendChild(el('div', 'rec-row', '<div class="rec-main"><div class="rec-name ' + rarityClass(m.rarity) + '">' + esc(m.name) +
          '</div></div><div class="rec-size">' + m.size + '<span class="u">cm</span></div>'));
      });
      panel.appendChild(ml);
    }

    main.appendChild(panel);
  }

  function renderPlaceholder(name) {
    const main = $('main');
    main.innerHTML = '';
    main.appendChild(el('div', 'panel wide center',
      '<div class="big-lock">🔒</div><h2>' + esc(name) + '</h2><p class="hint">该功能尚未开放，为框架占位。完成基础功能前不可跳转。</p>'));
  }

  function renderView() {
    if (currentView === 'fishing') renderFishing();
    else if (currentView === 'bd') renderBD();
    else if (currentView === 'ground') renderGround();
    else if (currentView === 'shop') renderShop();
    else if (currentView === 'market') renderMarket();
    else if (currentView === 'trade') renderTrade();
    else if (currentView === 'codex') renderCodex();
    else if (currentView === 'records') renderRecords();
    else {
      const navItem = D.NAV.find(function (x) { return x.id === currentView; });
      renderPlaceholder(navItem ? navItem.name : '未开放');
    }
  }

  // ---- 认证流程 ----
  let authTab = 'login';
  function wireAuth() {
    $('tab-login').onclick = function () { setAuthTab('login'); };
    $('tab-register').onclick = function () { setAuthTab('register'); };
    $('auth-submit').onclick = onAuthSubmit;
    $('auth-pass').addEventListener('keydown', function (e) { if (e.key === 'Enter') onAuthSubmit(); });
    $('auth-user').addEventListener('keydown', function (e) { if (e.key === 'Enter') onAuthSubmit(); });
  }
  function setAuthTab(t) {
    authTab = t;
    $('tab-login').classList.toggle('active', t === 'login');
    $('tab-register').classList.toggle('active', t === 'register');
    $('auth-name').style.display = t === 'register' ? 'block' : 'none';
    $('auth-submit').textContent = t === 'login' ? '登录' : '注册';
    $('auth-msg').textContent = '';
  }
  function showAuth() { $('auth').style.display = 'flex'; }
  function authMsg(text) { $('auth-msg').textContent = text || ''; }
  function onAuthSubmit() {
    const user = $('auth-user').value.trim();
    const pass = $('auth-pass').value;
    const name = $('auth-name').value.trim();
    if (!user || !pass) { authMsg('请填写用户名和密码'); return; }
    const btn = $('auth-submit');
    if (btn.disabled) return;
    btn.disabled = true;
    const oldLabel = btn.textContent;
    btn.textContent = authTab === 'register' ? '注册中…' : '登录中…';
    authMsg('');
    let p;
    try {
      p = authTab === 'register' ? window.Net.register(user, pass, name) : window.Net.login(user, pass);
    } catch (e) {
      btn.disabled = false; btn.textContent = oldLabel;
      authMsg('请求失败：' + e.message);
      return;
    }
    Promise.resolve(p).then(function (r) {
      btn.disabled = false; btn.textContent = oldLabel;
      if (!r || !r.ok) {
        if (r && r.status === 0) { authMsg('无法连接服务器，请确认已运行 node server.js'); return; }
        authMsg((r && r.data && r.data.error) || '操作失败，请重试');
        return;
      }
      if (!r.data || !r.data.token) { authMsg('服务器返回异常，请重试'); return; }
      try { localStorage.setItem('fishing_token', r.data.token); } catch (e) {}
      startGame(r.data.token, r.data.profile);
    }).catch(function (e) {
      btn.disabled = false; btn.textContent = oldLabel;
      authMsg('出错了：' + (e && e.message ? e.message : '未知错误'));
    });
  }
  function startGame(token, profile) {
    window.Engine.applyProfile(profile);
    const st = S();
    st.codex = (profile && profile.codex) || {};
    st.catchCount = (profile && profile.catchCount) || 0;
    window.Net.setAuth(token, profile);
    $('auth').style.display = 'none';
    renderNav();
    renderTopbar();
    renderView();
  }

  function onFishingTick() { if (currentView === 'fishing') { renderTopbar(); renderFishing(); } }

  // 刷新主视图。scope 用于避免「无关广播」把正在编辑的页面重绘掉：
  // 例如钓鱼玩家每 3s 触发 players/grounds/feed，若重绘交易页会丢失勾选状态。
  function refreshAll(scope) {
    if (scope === 'all') scope = null;
    // 交易页有输入状态，只有交易类事件才重绘主区（顶栏/导航仍更新）
    if (currentView === 'trade' && scope && scope !== 'trade' && scope !== 'assets' && scope !== 'codex') {
      renderTopbar(); renderNav();
      return;
    }
    renderTopbar(); renderNav(); renderView();
  }

  function init() {
    wireAuth();
    // 交易页冷却倒计时：仅在冷却期间重绘，冷却结束后补一次
    let cdLast = 0;
    setInterval(function () {
      if (currentView !== 'trade') { cdLast = 0; return; }
      const t = S().trade;
      if (!t) { cdLast = 0; return; }
      const cd = Math.max(0, (t.cooldownUntil || 0) - Date.now());
      if (cd > 0 || cdLast > 0) { renderTopbar(); renderView(); }
      cdLast = cd;
    }, 500);
    let token = null;
    try { token = localStorage.getItem('fishing_token'); } catch (e) {}
    if (token) {
      Promise.resolve()
        .then(function () { return window.Net.fetchMe(token); })
        .then(function (r) {
          if (r && r.ok) { startGame(token, r.data); }
          else { try { localStorage.removeItem('fishing_token'); } catch (e) {} showAuth(); }
        })
        .catch(function () {
          try { localStorage.removeItem('fishing_token'); } catch (e) {}
          showAuth();
        });
    } else {
      showAuth();
    }
  }

  return {
    init: init, onFishingTick: onFishingTick, refreshAll: refreshAll,
    toast: toast, renderNav: renderNav, renderTopbar: renderTopbar, renderView: renderView,
    getView: function () { return currentView; },
    setView: function (v) { currentView = v; },
  };
})();

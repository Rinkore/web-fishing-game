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
  // 内容签名： fishing 徽标 / 交易徽标 / 当前视图 任一变化才重建。
  // 否则每次广播都会 innerHTML 重建导航，悬停高亮与过渡动画被打断（左侧闪烁）。
  let navSig = null;
  function renderNav() {
    const st = S();
    const sig = [currentView, st.fishing.active ? 1 : 0, st.trade ? (st.trade.id || 1) : 0].join('|');
    if (sig === navSig) return;
    navSig = sig;
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
        loadViewData(item.id);
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
        renderTopbar(); renderNav(); renderFishing();
        return;
      }
      const wasFishing = st.fishing.active;
      st.selected = { groundId: gid, spotId: sid };
      renderTopbar(); renderNav(); renderFishing(); // 乐观渲染，服务器拒绝时回滚
      E().startFishing(gid, sid).then(function (r) {
        if (!r.ok) { toast(r.msg); st.selected = { groundId: null, spotId: null }; }
        else { toast(wasFishing ? '已切换钓点，服务器每 ' + (st.fishingInterval / 1000).toFixed(2) + ' 秒抛一竿' : '已开始自动钓鱼，服务器每 ' + (st.fishingInterval / 1000).toFixed(2) + ' 秒抛一竿'); }
        renderTopbar(); renderNav(); renderFishing();
      });
    });
    left.appendChild(groundWrap);

    const ctrl = el('div', 'fish-ctrl');
    const stateBar = el('div', 'fish-state' + (st.fishing.active ? ' on' : ''));
    if (st.fishing.active) {
      const g = D.GROUNDS.find(function (x) { return x.id === st.player.groundId; });
      const sp = g && g.spots.find(function (x) { return x.id === st.player.spotId; });
      stateBar.innerHTML = '<span class="dot on"></span> 自动钓鱼中 · ' + esc(g ? g.name : '') + (sp ? '·' + esc(sp.name) : '') +
        '<span class="state-hint">服务器每 ' + (st.fishingInterval / 1000).toFixed(2) + 's 抛一竿 · 再点当前钓点可取消</span>';
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
      onList: function (id, qty, price) { call(window.Net.marketList(id, qty, price), function (r) { return '已上架到市集（支付上架费 ' + r.data.fee + '💰，下架不退）'; }).then(function (r) { if (r && r.ok) { S().inventory = r.data.inventory; S().player.coins = r.data.coins; renderTopbar(); renderView(); } }); },
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
    // 按单价排序（数量变化不会导致行位置跳动，修"出售后物品换位"）
    keys.sort(function (a, b) {
      const pa = (st.shop && st.shop[a] ? st.shop[a].price : itemMeta(a).price) || 0;
      const pb = (st.shop && st.shop[b] ? st.shop[b].price : itemMeta(b).price) || 0;
      return pb - pa || (a < b ? -1 : 1);
    });
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
        lb.title = '挂到开放市集（收定价总额 1% 上架费，下架不退）';
        lb.addEventListener('click', function () {
          const qty = parseInt(prompt('上架数量（持有 ' + st.inventory[k] + '）', '1'), 10);
          if (!qty || qty <= 0) return;
          const base = shopP ? shopP.price : meta.price;
          const price = parseInt(prompt('单价（金币；上架费 = 定价总额的 1%，下架不退；系统价 ' + base + '）', String(base * 2)), 10);
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
    const recent = b.recent; // 近期渔获由服务器 presence 维护，前端只展示
    const card = el('div', 'peep' + (isSelf ? ' self' : ''));
    card.innerHTML =
      '<span class="avatar" style="background:' + color + '">' + esc((b.name || '?').slice(0, 1)) + '</span>' +
      '<div class="peep-info"><div class="peep-name">' + esc(b.name || '玩家') + (isSelf ? '（你）' : '') +
      ' <span class="dot ' + (b.status === 'fishing' ? 'on' : 'idle') + '"></span></div>' +
      '<div class="peep-loc">' + (g ? esc(g.name) : '未出发') + (sp ? '·' + esc(sp.name) : '') + '</div>' +
      (recent ? '<div class="peep-recent">近期：' + esc(recent) + '</div>' : '') + '</div>';
    return card;
  }

  // ---- 钓竿配置视图（组件装备 + 词缀加成） ----
  // 装备/卸下走服务器（/api/bd/set 校验目录并即时调整钓速）。
  // 安装 = 使用组件道具：消耗背包中 1 件（卸下不返还）。
  function setPart(partKey, compId) {
    call(window.Net.bdSet(partKey, compId || null), null).then(function (r) {
      if (r && r.ok) {
        S().bd = r.data.bd;
        if (r.data.inventory) S().inventory = r.data.inventory;
        E().refreshEffects();
        toast((compId ? '已装备 ' + itemMeta(compId).name + '（消耗 1 件组件）' : '已卸下组件') + '，加成已在服务器生效');
        renderView();
      }
    });
  }

  // 装备面板状态：当前展开的部位 + 面板内筛选/排序（模块级：重绘间保留）
  let bdEquipPart = null;
  let bdEquipFilter = 'all';
  let bdEquipSort = 'rarity';
  let bdEquipDir = 'desc';
  const BD_AFFIXES = [['speed', '⚡ 钓速'], ['big', '🐟 大鱼'], ['rare', '✨ 稀有'], ['material', '🧵 材料'], ['size', '📏 体型'], ['double', '🎣 双钓']];

  // 装备面板：展示在卡片区域下方的空白区，可按属性筛选、按稀有度/价格/属性值排序
  function renderBdEquipPanel(grid, st) {
    const old = document.querySelector('.bd-equip-panel');
    if (old) old.remove();
    const part = D.ROD_PARTS.find(function (p) { return p.key === bdEquipPart; });
    if (!part) return;
    const equipped = D.componentOf(st.bd[part.key] && st.bd[part.key].compId);
    const owned = Object.keys(st.inventory)
      .map(function (id) { return { c: D.componentOf(id), n: st.inventory[id] }; })
      .filter(function (o) { return o.c && o.c.part === part.key && o.n > 0; });
    if (!owned.length) { bdEquipPart = null; return; }

    const panelBox = el('div', 'bd-equip-panel');
    const head = el('div', 'bde-head');
    head.innerHTML = '<span class="bde-title">可装备的「' + esc(part.name) + '」组件（装备即消耗 1 件，卸下不返还）</span>';
    const close = el('button', 'mini', '收起');
    close.addEventListener('click', function () { bdEquipPart = null; renderView(); });
    head.appendChild(close);
    panelBox.appendChild(head);

    // 属性筛选 + 排序控件
    const ctr = el('div', 'bde-controls');
    [['all', '全部属性']].concat(BD_AFFIXES).forEach(function (kv) {
      const b = el('button', 'bf-cat' + (bdEquipFilter === kv[0] ? ' on' : ''), kv[1]);
      b.addEventListener('click', function () { if (bdEquipFilter !== kv[0]) { bdEquipFilter = kv[0]; renderView(); } });
      ctr.appendChild(b);
    });
    ctr.appendChild(el('span', 'bf-sort-label', '排序'));
    [['rarity', '稀有度'], ['price', '价格'], ['affix', '属性值']].forEach(function (kv) {
      const active = bdEquipSort === kv[0];
      const arrow = active ? (bdEquipDir === 'desc' ? ' ↓' : ' ↑') : '';
      const b = el('button', 'bf-cat bf-sort-btn' + (active ? ' on' : ''), kv[1] + arrow);
      b.addEventListener('click', function () {
        if (bdEquipSort === kv[0]) bdEquipDir = bdEquipDir === 'desc' ? 'asc' : 'desc';
        else { bdEquipSort = kv[0]; bdEquipDir = 'desc'; }
        renderView();
      });
      ctr.appendChild(b);
    });
    panelBox.appendChild(ctr);

    // 组件卡片
    let list = owned.filter(function (o) { return bdEquipFilter === 'all' || o.c.affixes.some(function (a) { return a.type === bdEquipFilter; }); });
    const rank = { epic: 3, rare: 2, common: 1 };
    const affVal = function (o) {
      if (bdEquipFilter === 'all') return o.c.affixes.reduce(function (s, a) { return s + a.value; }, 0);
      const a = o.c.affixes.find(function (x) { return x.type === bdEquipFilter; });
      return a ? a.value : 0;
    };
    list.sort(function (x, y) {
      if (bdEquipSort === 'price') return bdEquipDir === 'desc' ? y.c.price - x.c.price : x.c.price - y.c.price;
      if (bdEquipSort === 'affix') return bdEquipDir === 'desc' ? affVal(y) - affVal(x) : affVal(x) - affVal(y);
      const d = (rank[y.c.rarity] || 0) - (rank[x.c.rarity] || 0);
      return (bdEquipDir === 'desc' ? d : -d) || y.c.price - x.c.price;
    });
    const grid2 = el('div', 'bde-grid');
    if (!list.length) {
      grid2.appendChild(el('div', 'hint', '没有符合筛选条件的组件。'));
    } else {
      list.forEach(function (o) {
        const c = o.c;
        const card = el('div', 'bec-card');
        card.innerHTML =
          '<div class="bec-name"><span class="' + rarityClass(c.rarity) + '">' + esc(c.name) + '</span><span class="bec-price">' + c.price + '💰</span></div>' +
          c.affixes.map(function (a) { return '<div class="bec-aff">+' + a.value + '% ' + esc(D.AFFIX_LABEL[a.type] || a.type) + '</div>'; }).join('') +
          '<div class="bec-meta">持有 ×' + o.n + '</div>';
        const use = el('button', 'mini primary-mini', (equipped && equipped.id === c.id) ? '已装备' : '装备');
        if (equipped && equipped.id === c.id) { use.disabled = true; use.classList.add('locked'); }
        use.addEventListener('click', function () { setPart(part.key, c.id); });
        card.appendChild(use);
        grid2.appendChild(card);
      });
    }
    panelBox.appendChild(grid2);
    grid.parentNode.insertBefore(panelBox, grid.nextSibling);
  }
  function renderBD() {
    const main = $('main');
    const st = S();
    main.innerHTML = '';
    const panel = el('div', 'panel wide');
    panel.innerHTML = '<h2>🎯 钓竿配置 <span class="subtitle">装备组件获得词缀加成 · 配置随账号自动保存</span></h2>';

    // 加成总览（与 Engine 的钓鱼逻辑同源）
    const eff = E().bdEffects();
    const effDefs = [['speed', '⚡ 钓速'], ['big', '🐟 大鱼'], ['rare', '✨ 稀有'], ['material', '🧵 材料'], ['size', '📏 体型'], ['double', '🎣 双钓']];
    const strip = el('div', 'eff-strip');
    let any = false;
    effDefs.forEach(function (kv) {
      if (!eff[kv[0]]) return;
      any = true;
      strip.appendChild(el('span', 'eff-chip', kv[1] + ' +' + eff[kv[0]] + '%'));
    });
    if (!any) strip.appendChild(el('span', 'eff-chip none', '暂无加成 · 装备组件后生效'));
    panel.appendChild(strip);

    const grid = el('div', 'bd-grid');
    D.ROD_PARTS.forEach(function (part) {
      const cur = st.bd[part.key] || {};
      const comp = D.componentOf(cur.compId);
      const cell = el('div', 'bd-cell' + (part.isCharm ? ' charm' : '') + (comp ? ' equipped' : ''));
      const affHtml = comp
        ? comp.affixes.map(function (a) { return '<div class="af-line on">+' + a.value + '% ' + esc(D.AFFIX_LABEL[a.type] || a.type) + '</div>'; }).join('')
        : '<div class="af-line"><span class="muted">标准 · 无加成</span></div>';
      cell.innerHTML =
        '<div class="bd-part">' + esc(part.name) + (part.isCharm ? ' <span class="charm-tag">饰品</span>' : '') + '</div>' +
        '<div class="bd-comp ' + (comp ? rarityClass(comp.rarity) : '') + '">' + esc(comp ? comp.name : part.default.name) + '</div>' +
        '<div class="affix-frame">' + affHtml + '</div>';
      const acts = el('div', 'bd-acts');
      if (comp) {
        const off = el('button', 'mini', '卸下');
        off.addEventListener('click', function () {
          if (!confirm('卸下后不返还组件（安装时已作为道具消耗），确定恢复标准' + part.name + '？')) return;
          setPart(part.key, null);
        });
        acts.appendChild(off);
      }
      // 背包中该部位的可用组件
      const owns = Object.keys(st.inventory).filter(function (id) {
        const c = D.componentOf(id);
        return c && c.part === part.key && st.inventory[id] > 0;
      });
      if (owns.length) {
        const btn = el('button', 'mini primary-mini', '装备组件');
        btn.addEventListener('click', function () {
          // 点开/切换：装备面板展示在卡片区域下方的大块空白区
          bdEquipPart = (bdEquipPart === part.key) ? null : part.key;
          renderView();
        });
        acts.appendChild(btn);
      } else {
        acts.appendChild(el('span', 'muted tiny', '背包暂无该部位组件'));
      }
      cell.appendChild(acts);
      grid.appendChild(cell);
    });
    panel.appendChild(grid);
    // 装备面板：展示在卡片区域下方的空白区（重绘后自动恢复）
    if (bdEquipPart) renderBdEquipPanel(grid, st);
    panel.appendChild(el('div', 'note-block',
      '<b>组件怎么获得？</b>钓鱼时有概率钓到各部位组件（稀有/史诗更少见）。' +
      '<b>装备即消耗</b>：安装会使用掉背包中的 1 件该组件（卸下不返还），加成持续生效并在服务器实时结算（正在钓鱼时钓速也会立即调整）。'));
    main.appendChild(panel);
  }

  // ---- 渔场动态视图（全服概览 + 单地图点击查看） ----
  // 当前筛选的地图（null = 全服；模块级：重绘间保留）
  let groundFilterId = null;

  function renderGround() {
    const main = $('main');
    const st = S();
    main.innerHTML = '';
    const panel = el('div', 'panel wide ground-panel');
    const filterGround = groundFilterId ? D.GROUNDS.find(function (g) { return g.id === groundFilterId; }) : null;
    panel.innerHTML = '<h2>🌊 渔场动态 ' + (filterGround ? '· ' + esc(filterGround.name) : '（全服实时）') + '</h2>';
    if (groundFilterId) {
      const back = el('button', 'mini ground-back', '🌐 返回全服');
      back.addEventListener('click', function () { groundFilterId = null; renderView(); });
      panel.appendChild(back);
    }

    // 地图概览：点击进入单地图动态
    const counts = el('div', 'ground-counts');
    D.GROUNDS.forEach(function (g) {
      const c = (st.groundCounts && st.groundCounts[g.id]) || 0;
      const box = el('div', 'gc-box' + (g.locked ? ' locked' : '') + (c > 0 ? ' live' : '') + (groundFilterId === g.id ? ' sel' : ''));
      box.innerHTML = '<div class="gcb-name">' + esc(g.name) + '</div>' +
        '<div class="gcb-num">' + c + '<span class="u">人</span></div>' +
        (g.locked ? '' : '<div class="gcb-hint">点击查看</div>');
      if (!g.locked) {
        box.title = '点击查看「' + g.name + '」的动态';
        box.addEventListener('click', function () { groundFilterId = (groundFilterId === g.id) ? null : g.id; renderView(); });
      }
      counts.appendChild(box);
    });
    const totalBox = el('div', 'gc-box total' + (groundFilterId ? '' : ' sel'));
    totalBox.innerHTML = '<div class="gcb-name">🌐 全服在线</div><div class="gcb-num">' + st.players.length + '<span class="u">人</span></div>';
    totalBox.title = '点击返回全服动态';
    totalBox.addEventListener('click', function () { if (groundFilterId) { groundFilterId = null; renderView(); } });
    counts.appendChild(totalBox);
    panel.appendChild(counts);

    // 数据按所选地图过滤
    const playersShown = groundFilterId ? st.players.filter(function (p) { return p.groundId === groundFilterId; }) : st.players;
    const feedShown = groundFilterId ? st.feed.filter(function (e) { return e.ground === filterGround.name; }) : st.feed;

    const cols = el('div', 'ground-cols');
    const left = el('div', 'sub');
    left.appendChild(el('h3', null, '👥 ' + (groundFilterId ? '本地图在线玩家（' + playersShown.length + '）' : '在线玩家（' + st.players.length + '）')));
    const list = el('div', 'peeps');
    if (playersShown.length === 0) list.appendChild(el('div', 'hint', groundFilterId ? '该地图暂无玩家。' : '暂无在线玩家。'));
    playersShown.slice().sort(function (a, b) {
      const ra = a.status === 'fishing' ? 0 : 1, rb = b.status === 'fishing' ? 0 : 1;
      return ra - rb || String(a.name).localeCompare(String(b.name));
    }).forEach(function (b) { list.appendChild(peepCard(b)); });
    left.appendChild(list);
    cols.appendChild(left);

    const right = el('div', 'sub');
    right.appendChild(el('h3', null, '📡 最新动态' + (groundFilterId ? ' · ' + esc(filterGround.name) : '')));
    const feed = el('div', 'feed feed-big');
    if (feedShown.length === 0) feed.appendChild(el('div', 'hint', groundFilterId ? '该地图暂无动态，等待大家上鱼……' : '暂无动态，等待大家上鱼……'));
    feedShown.slice(0, 60).forEach(function (e) {
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
  // 商品详情弹窗：固定居中子窗口，独立于页面重绘流程（广播只更新数据不重建窗口）
  let shopModalId = null;

  // 交易记录合并：同一账号 60 秒内的多笔合为一笔（数量累加、价格取最新）
  function mergeTrades(trades) {
    const out = [];
    (trades || []).forEach(function (t) {
      const last = out[out.length - 1];
      if (last && last.who === t.who && t.t - last.tStart <= 60000) {
        last.qty += t.qty;
        last.unit = t.unit;
        last.t = t.t;
        last.count += 1;
      } else {
        out.push({ who: t.who, qty: t.qty, unit: t.unit, t: t.t, tStart: t.t, count: 1 });
      }
    });
    return out;
  }

  // 打开商品详情弹窗并拉取数据
  function openShopModal(id) {
    shopModalId = id;
    document.querySelectorAll('.modal-overlay').forEach(function (m) { m.remove(); });
    const overlay = el('div', 'modal-overlay');
    overlay.addEventListener('click', function (ev) { if (ev.target === overlay) closeShopModal(); });
    const box = el('div', 'modal-box shop-modal');
    box.innerHTML = '<div class="modal-head"><span class="modal-title">📈 加载中…</span><button class="mini modal-close">✕ 关闭</button></div><div class="modal-body" id="shop-modal-body">加载中…</div>';
    box.querySelector('.modal-close').addEventListener('click', function () { closeShopModal(); });
    overlay.appendChild(box);
    document.body.appendChild(overlay);
    fillShopModal(id);
  }

  function closeShopModal() {
    shopModalId = null;
    document.querySelectorAll('.modal-overlay').forEach(function (m) { m.remove(); });
  }

  // 拉取并填充弹窗内容（广播触发时静默刷新，窗口本体不动）
  function fillShopModal(id) {
    const body = document.getElementById('shop-modal-body');
    const overlay = document.querySelector('.modal-overlay');
    if (overlay) overlay.querySelector('.modal-title').textContent = '📈 ' + (itemMeta(id).name) + ' · 价格走势与交易量';
    if (!body || shopModalId !== id) return;
    window.Net.shopHistory(id).then(function (r) {
      if (!body || shopModalId !== id) return;
      if (!r || !r.ok) { body.textContent = (r && r.data && r.data.error) || '加载失败'; return; }
      const d = r.data;
      body.innerHTML = '';
      body.appendChild(el('div', 'sd-vol', '今日售出 <b>' + (d.soldToday || 0) + '</b> 件 · 累计 <b>' + (d.soldTotal || 0) + '</b> 件 · 现价 <b>' + d.price + '</b>💰（基准 ' + d.base + '）'));

      // 价格走势：全部采样（>160 点按桶平均降采样）
      let pts = (d.points || []).slice();
      if (pts.length > 160) {
        const step = pts.length / 160;
        const down = [];
        for (let i = 0; i < 160; i++) {
          const a = pts[Math.floor(i * step)];
          const b = pts[Math.min(pts.length - 1, Math.max(Math.floor((i + 1) * step) - 1, Math.floor(i * step)))];
          down.push({ t: b.t, p: Math.round((a.p + b.p) / 2) });
        }
        pts = down;
      }
      if (pts.length >= 2) {
        const prices = pts.map(function (x) { return x.p; }).concat([d.base]);
        const maxP = Math.max.apply(null, prices), minP = Math.min.apply(null, prices);
        const spark = el('div', 'sd-spark');
        pts.forEach(function (pt) {
          const h = maxP === minP ? 50 : Math.round(10 + 90 * (pt.p - minP) / (maxP - minP));
          const bar = el('i', pt.p >= d.base ? 'up' : 'down');
          bar.style.height = h + '%';
          spark.appendChild(bar);
        });
        body.appendChild(spark);
        const spanMin = Math.max(1, Math.round((pts[pts.length - 1].t - pts[0].t) / 60000));
        body.appendChild(el('div', 'sd-legend', '近 ' + spanMin + ' 分钟（每分钟一采样） · 红=不低于基准 · 蓝=低于基准'));
      } else {
        body.appendChild(el('div', 'sd-legend', '价格采样积累中（服务器每分钟记录一次）。'));
      }

      // 交易记录
      body.appendChild(el('div', 'sd-sub', '🧾 交易记录 <span class="muted">（同账号 1 分钟内合并）</span>'));
      const tl = el('div', 'sd-trades');
      const merged = mergeTrades(d.trades || []);
      if (!merged.length) {
        tl.appendChild(el('div', 'hint', '暂无交易记录，卖出该物品后会出现在这里。'));
      } else {
        merged.slice(-20).reverse().forEach(function (t) {
          const mergedTag = t.count > 1 ? ' <span class="muted">（' + t.count + ' 笔合并）</span>' : '';
          tl.appendChild(el('div', 'sd-line', timeStr(t.t) + ' · <b>' + esc(t.who) + '</b> 卖出 ×' + t.qty +
            ' @ ' + t.unit + '💰' + mergedTag));
        });
      }
      body.appendChild(tl);

      // 最新价格变化
      body.appendChild(el('div', 'sd-sub', '💹 最新价格变化'));
      const arr = d.points || [];
      const list = el('div', 'sd-list');
      if (!arr.length) {
        list.appendChild(el('div', 'hint', '暂无采样。'));
      } else {
        for (let i = arr.length - 1; i >= 0 && i >= arr.length - 8; i--) {
          const diff = i > 0 ? arr[i].p - arr[i - 1].p : 0;
          const trend = diff > 0 ? '<span class="sd-up">▲+' + diff + '</span>' : (diff < 0 ? '<span class="sd-down">▼' + diff + '</span>' : '<span class="muted">—</span>');
          list.appendChild(el('div', 'sd-line', timeStr(arr[i].t) + ' · ' + arr[i].p + '💰 ' + trend));
        }
      }
      body.appendChild(list);
    });
  }

  function renderShop() {
    const main = $('main');
    const st = S();
    main.innerHTML = '';
    const panel = el('div', 'panel wide two-col');
    panel.innerHTML = '<h2>🏪 系统商店 <span class="subtitle">供需定价 · 单乘数模型：每卖一件约 -0.7% · 闲置时向 2 倍缓慢回升 · 点击商品查看走势与交易流水</span></h2>';

    const colMain = el('div', 'col-main');
    const grid = el('div', 'shop-grid');
    const cardById = {};
    Object.keys(st.shop || {}).forEach(function (id) {
      const s = st.shop[id];
      const meta = itemMeta(id);
      const ratio = s.base ? s.price / s.base : 1;
      const pct = Math.round(ratio * 100);
      const cls = ratio < 0.75 ? 'low' : ratio < 0.95 ? 'mid' : 'high';
      const card = el('div', 'shop-card');
      const have = st.inventory[id] || 0;
      // 红色进度条覆盖在原进度条上，表示高于基准的涨价部分
      const fillPct = Math.max(6, Math.min(100, pct));
      const upPct = pct > 100 ? Math.min(100, pct - 100) : 0;
      card.innerHTML =
        '<div class="sc-name ' + rarityClass(meta.rarity) + '">' + esc(meta.name) + '</div>' +
        '<div class="sc-price ' + cls + '">💰 ' + s.price + '<span class="base">基准 ' + s.base + '</span></div>' +
        '<div class="sc-bar"><i class="up" style="width:' + upPct + '%"></i><i style="width:' + fillPct + '%"></i></div>' +
        '<div class="sc-pct">当前 ' + pct + '% · 持有 ' + have + ' · 今日售出 ' + (s.soldToday || 0) + '</div>';
      card.title = '点击查看价格走势与交易量';
      const btn = el('button', 'mini' + (have > 0 ? ' primary-mini' : ' locked'), have > 0 ? '出售 1 个' : '无库存');
      btn.addEventListener('click', function (ev) {
        ev.stopPropagation(); // 出售不触发展开详情
        if (!(st.inventory[id] > 0)) return;
        call(window.Net.sell(id, 1), function (r) { return '售出 ' + meta.name + '，获得 💰' + r.data.gain + '（单价 ' + r.data.unit + '）'; })
          .then(function (r) { if (r && r.ok) { st.player.coins = r.data.coins; st.inventory = r.data.inventory; st.shop = r.data.shop; renderTopbar(); renderView(); } });
      });
      card.appendChild(btn);
      card.addEventListener('click', function () { openShopModal(id); });
      cardById[id] = card;
      grid.appendChild(card);
    });
    colMain.appendChild(grid);
    panel.appendChild(colMain);

    const side = el('div', 'col-side');
    side.appendChild(el('h3', null, '🎒 我的背包'));
    side.appendChild(el('div', 'hint', '点击「出售」按当前收购价卖给系统；「上架」挂到开放市集（收定价总额 1% 上架费，下架不退；成交另抽 10% 税）。'));
    side.appendChild(inventoryBlock({
      onSell: function (id) {
        call(window.Net.sell(id, 1), function (r) { return '售出 1 ×' + itemMeta(id).name + '，获得 💰' + r.data.gain; })
          .then(function (r) { if (r && r.ok) { st.player.coins = r.data.coins; st.inventory = r.data.inventory; st.shop = r.data.shop; renderTopbar(); renderView(); } });
      },
      onList: function (id, qty, price) {
        call(window.Net.marketList(id, qty, price), function (r) { return '已上架到市集（支付上架费 ' + r.data.fee + '💰，下架不退）'; }).then(function (r) { if (r && r.ok) { st.player.coins = r.data.coins; st.inventory = r.data.inventory; renderTopbar(); renderView(); } });
      },
    }));
    panel.appendChild(side);
    main.appendChild(panel);
  }

  // ---- 开放市集视图 ----
  // 当前页签与购买市场筛选状态（模块级：重绘间保留）
  let marketTab = 'buy';
  let buyCategory = 'all';
  let buySearch = '';
  let buySearchFocus = false;
  let buySort = { key: 'time', dir: 'desc' };

  // 挂单行：自己的显示「下架」，他人的显示「购买」（seller 为小写 key，比对做大小写免疫）
  function marketRow(l, st, me) {
    const meta = itemMeta(l.id);
    const mine = !!(me && me.id != null && String(l.seller).toLowerCase() === String(me.id).toLowerCase());
    const total = l.price * l.qty;
    const row = el('div', 'mk-row' + (mine ? ' mine' : ''));
    row.innerHTML =
      '<div class="mk-main"><div class="mk-name ' + rarityClass(meta.rarity) + '">' + esc(l.name) + ' <span class="qty">×' + l.qty + '</span></div>' +
      '<div class="mk-sub">卖家：' + esc(l.sellerName) + (mine ? '（你）' : '') + ' · 上架 ' + timeStr(l.t) + '</div></div>' +
      '<div class="mk-price"><b>💰 ' + l.price + '</b><span class="unit">/个</span><div class="total">合计 ' + total + '</div></div>';
    const acts = el('div', 'mk-acts');
    if (mine) {
      const cb = el('button', 'mini', '下架');
      cb.title = '下架取回物品（上架费不退）';
      cb.addEventListener('click', function () {
        call(window.Net.marketCancel(l.lid), '已下架，物品退回背包（上架费不退）').then(function (r) { if (r && r.ok) { st.inventory = r.data.inventory; renderTopbar(); renderView(); } });
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
    return row;
  }

  function renderMarket() {
    const main = $('main');
    const st = S();
    const me = st.me;
    main.innerHTML = '';
    const panel = el('div', 'panel wide two-col');
    panel.innerHTML = '<h2>💱 开放市集 <span class="subtitle">购买 / 我的挂单 / 历史订单 分页管理 · 成交收 10% 税（卖家承担）</span></h2>';

    const colMain = el('div', 'col-main');
    const market = st.market || [];
    const mineCount = market.filter(function (l) { return me && me.id != null && String(l.seller).toLowerCase() === String(me.id).toLowerCase(); }).length;
    const tabs = el('div', 'inv-cats');
    [['buy', '🛒 购买市场', market.length - mineCount], ['mine', '🏷️ 我的挂单', mineCount], ['history', '📜 历史订单', null]].forEach(function (kv) {
      const b = el('button', 'inv-cat' + (marketTab === kv[0] ? ' on' : ''), kv[1] + (kv[2] != null ? ' ' + kv[2] : ''));
      b.addEventListener('click', function () { if (marketTab !== kv[0]) { marketTab = kv[0]; renderView(); } });
      tabs.appendChild(b);
    });
    colMain.appendChild(tabs);

    if (marketTab === 'mine') {
      // 我的挂单：管理（下架）
      const mineArr = market.filter(function (l) { return me && l.seller === me.id; })
        .sort(function (a, b) { return b.t - a.t; });
      const list = el('div', 'market-list');
      if (!mineArr.length) {
        list.appendChild(el('div', 'hint', '你没有在售的挂单。从右侧「我的背包」点「上架」（收定价总额 1% 上架费，下架不退）。'));
      } else {
        mineArr.forEach(function (l) { list.appendChild(marketRow(l, st, me)); });
      }
      colMain.appendChild(list);
      colMain.appendChild(el('div', 'hint', '提示：下架取回物品，但上架费不退。'));
    } else if (marketTab === 'history') {
      // 历史订单：我的市集成交（买入 + 卖出）
      const hist = el('div', 'market-history', '加载中…');
      colMain.appendChild(hist);
      window.Net.marketHistory().then(function (r) {
        if (marketTab !== 'history') return; // 已切走
        if (!r || !r.ok) { hist.textContent = (r && r.data && r.data.error) || '加载失败'; return; }
        hist.innerHTML = '';
        const trades = r.data.trades || [];
        if (!trades.length) {
          hist.appendChild(el('div', 'hint', '暂无历史订单。在「购买市场」成交后会在这里记录（买入与卖出都算）。'));
          return;
        }
        trades.forEach(function (t) {
          const isBuy = me && String(t.buyer || '').toLowerCase() === String(me.id || '').toLowerCase();
          const row = el('div', 'inv-row hist-line');
          row.innerHTML =
            '<span class="hist-tag ' + (isBuy ? 'hist-buy' : 'hist-sell') + '">' + (isBuy ? '买入' : '卖出') + '</span>' +
            '<span class="' + rarityClass(itemMeta(t.id).rarity) + '">' + esc(t.name) + '</span>' +
            '<span class="cnt">×' + t.qty + ' @ ' + t.price + '💰</span>' +
            '<span class="hist-who">' + (isBuy ? '向 ' + esc(t.sellerName) : '卖给 ' + esc(t.buyerName)) + '</span>' +
            '<span class="subtotal">' + (isBuy ? '支出 ' + t.total : '到账 ' + (t.total - t.tax)) + '💰</span>' +
            '<span class="unit-price">' + timeStr(t.t) + '</span>';
          hist.appendChild(row);
        });
      });
    } else {
      // 购买市场：其他玩家的挂单 + 分类筛选 + 搜索
      const othersAll = market.filter(function (l) { return !(me && l.seller === me.id); });
      const filters = el('div', 'buy-filters');
      [['all', '全部'], ['fish', '鱼'], ['material', '材料'], ['component', '组件']].forEach(function (kv) {
        const n = kv[0] === 'all' ? othersAll.length : othersAll.filter(function (l) { return itemMeta(l.id).kind === kv[0]; }).length;
        const b = el('button', 'bf-cat' + (buyCategory === kv[0] ? ' on' : ''), kv[1] + ' ' + n);
        b.addEventListener('click', function () { if (buyCategory !== kv[0]) { buyCategory = kv[0]; renderView(); } });
        filters.appendChild(b);
      });
      const inp = el('input', 'bf-search');
      inp.placeholder = '🔍 搜索物品或卖家…';
      inp.value = buySearch;
      const list = el('div', 'market-list');
      function refreshList() {
        const q = buySearch.trim().toLowerCase();
        let others = othersAll.filter(function (l) { return buyCategory === 'all' || itemMeta(l.id).kind === buyCategory; });
        if (q) others = others.filter(function (l) {
          return l.name.toLowerCase().indexOf(q) >= 0 || (l.sellerName || '').toLowerCase().indexOf(q) >= 0;
        });
        others.sort(function (a, b) {
          if (buySort.key === 'price') {
            const d = buySort.dir === 'asc' ? a.price - b.price : b.price - a.price;
            return d || b.t - a.t;
          }
          if (buySort.key === 'qty') {
            const d = buySort.dir === 'asc' ? a.qty - b.qty : b.qty - a.qty;
            return d || b.t - a.t;
          }
          return b.t - a.t; // 默认：最新上架在前
        });
        list.innerHTML = '';
        if (!others.length) {
          list.appendChild(el('div', 'hint', othersAll.length ? '没有符合条件的挂单。' : '市场暂无其他玩家的挂单。你可以在右侧「我的背包」里上架物品。'));
          return;
        }
        others.forEach(function (l) { list.appendChild(marketRow(l, st, me)); });
        if (q || buyCategory !== 'all' || buySort.key !== 'time') list.appendChild(el('div', 'hint', '匹配 ' + others.length + ' 条挂单。'));
      }
      inp.addEventListener('input', function () { buySearch = inp.value; refreshList(); });
      inp.addEventListener('focus', function () { buySearchFocus = true; });
      inp.addEventListener('blur', function () { buySearchFocus = false; });
      filters.appendChild(inp);

      // 排序：时间（默认）/ 价格 / 数量；价格与数量可切换升降序
      const sortWrap = el('span', 'bf-sort');
      sortWrap.appendChild(el('span', 'bf-sort-label', '排序'));
      [['time', '时间'], ['price', '价格'], ['qty', '数量']].forEach(function (kv) {
        const activeSort = buySort.key === kv[0];
        const arrow = activeSort && kv[0] !== 'time' ? (buySort.dir === 'asc' ? ' ↑' : ' ↓') : '';
        const b = el('button', 'bf-cat bf-sort-btn' + (activeSort ? ' on' : ''), kv[1] + arrow);
        b.addEventListener('click', function () {
          if (buySort.key === kv[0] && kv[0] !== 'time') buySort.dir = buySort.dir === 'asc' ? 'desc' : 'asc';
          else buySort = { key: kv[0], dir: kv[0] === 'price' ? 'asc' : 'desc' };
          renderView();
        });
        sortWrap.appendChild(b);
      });
      filters.appendChild(sortWrap);

      colMain.appendChild(filters);
      colMain.appendChild(list);
      refreshList();
      // 广播重绘后恢复搜索框焦点与光标位置
      if (buySearchFocus) { inp.focus(); const v = inp.value; inp.setSelectionRange(v.length, v.length); }
      colMain.appendChild(el('div', 'hint', '提示：买到的物品可拿去系统商店出售赚差价；市集成交收 10% 税（由卖家承担）。'));
    }
    panel.appendChild(colMain);

    const side = el('div', 'col-side');
    side.appendChild(el('h3', null, '🎒 我的背包'));
    side.appendChild(el('div', 'hint', '「上架」把你的物品挂到市集（收定价总额 1% 上架费，下架不退）；成交另收 10% 税（卖家承担）。'));
    side.appendChild(inventoryBlock({
      onList: function (id, qty, price) {
        call(window.Net.marketList(id, qty, price), function (r) { return '已上架到市集（支付上架费 ' + r.data.fee + '💰，下架不退）'; }).then(function (r) { if (r && r.ok) { st.player.coins = r.data.coins; st.inventory = r.data.inventory; renderTopbar(); renderView(); } });
      },
    }));
    panel.appendChild(side);

    main.appendChild(panel);
  }

  // ---- 背包视图（独立分页：分类明细 + 出售/上架 + 汇总 + 我的挂单） ----
  // 当前分类（模块级：重绘间保留）
  let invCategory = 'all';
  let bulkSellOpen = false;
  let bulkCat = 'all';
  let bulkRar = 'all';

  // 只更新一键出售的预估数字（不重绘页面，保住展开中的下拉框）
  function updateBulkEst() {
    const st = S();
    const est = document.querySelector('.bulk-est');
    if (!est) return;
    const mIds = Object.keys(st.inventory).filter(function (id) {
      const m = itemMeta(id);
      return (bulkCat === 'all' || m.kind === bulkCat) && (bulkRar === 'all' || m.rarity === bulkRar);
    });
    const mCnt = mIds.reduce(function (s, id) { return s + st.inventory[id]; }, 0);
    const unit = function (id) { const sp = st.shop && st.shop[id]; return sp ? sp.price : itemMeta(id).price; };
    const mEst = mIds.reduce(function (s, id) { return s + unit(id) * st.inventory[id]; }, 0);
    est.innerHTML = '将出售 <b>' + mIds.length + '</b> 种 / <b>' + mCnt + '</b> 件 · 预估收入 <b>' + Math.round(mEst) + '</b>💰<span class="muted">（按当前实时收购价）</span>';
    const go = Array.from(document.querySelectorAll('.bulk-sub button')).find(function (b) { return b.textContent === '确认出售'; });
    if (go) go.classList.toggle('locked', mCnt === 0);
  }

  // 一键出售：按种类/品质筛选后逐个卖给系统商店（顺序执行，避免并发覆盖资产）
  function bulkSellMatching() {
    const st = S();
    const unit = function (id) { const sp = st.shop && st.shop[id]; return sp ? sp.price : itemMeta(id).price; };
    const ids = Object.keys(st.inventory).filter(function (id) {
      const m = itemMeta(id);
      return (bulkCat === 'all' || m.kind === bulkCat) && (bulkRar === 'all' || m.rarity === bulkRar);
    });
    if (!ids.length) { toast('没有符合条件可出售的物品'); return; }
    const totalCnt = ids.reduce(function (s, id) { return s + st.inventory[id]; }, 0);
    const totalEst = ids.reduce(function (s, id) { return s + unit(id) * st.inventory[id]; }, 0);
    if (!confirm('将出售 ' + ids.length + ' 种共 ' + totalCnt + ' 件物品，按当前收购价预计收入 ' + Math.round(totalEst) + '💰，确定？')) return;
    let gain = 0, sold = 0;
    let chain = Promise.resolve();
    ids.forEach(function (id) {
      chain = chain.then(function () {
        const qty = st.inventory[id] || 0;
        if (qty <= 0) return null;
        return window.Net.sell(id, qty).then(function (r) {
          if (r && r.ok) {
            gain += r.data.gain; sold += qty;
            st.player.coins = r.data.coins; st.inventory = r.data.inventory; st.shop = r.data.shop;
          }
        });
      });
    });
    chain.then(function () {
      renderTopbar(); renderView();
      toast('一键出售完成：' + sold + ' 件，共收入 💰' + gain);
    });
  }

  function renderInventory() {
    const main = $('main');
    const st = S();
    main.innerHTML = '';
    const panel = el('div', 'panel wide two-col');
    panel.innerHTML = '<h2>🎒 背包 <span class="subtitle">分类明细 · 出售 / 上架 / 下架 · 预估总价按基准价计算（不随市场浮动）</span></h2>';

    // 现价优先（服务器动态价），无行情时退回基准价
    function unitPrice(id) { const s = st.shop && st.shop[id]; return s ? s.price : itemMeta(id).price; }
    function itemValue(id) { return unitPrice(id) * st.inventory[id]; }
    function doSell(id, qty) {
      call(window.Net.sell(id, qty), function (r) { return '售出 ' + itemMeta(id).name + ' ×' + qty + '，获得 💰' + r.data.gain; })
        .then(function (r) {
          if (r && r.ok) { st.player.coins = r.data.coins; st.inventory = r.data.inventory; st.shop = r.data.shop; renderTopbar(); renderView(); }
        });
    }
    function listFee(price, qty) { return Math.ceil(price * qty * 0.01); }

    // 分类页签（重绘间保留当前选择）
    const kindCount = { fish: 0, material: 0, component: 0 };
    Object.keys(st.inventory).forEach(function (id) {
      const k = itemMeta(id).kind;
      if (kindCount[k] != null) kindCount[k] += 1;
    });
    const tabs = el('div', 'inv-cats');
    [['all', '📦 全部', Object.keys(st.inventory).length], ['fish', '🐟 鱼类', kindCount.fish], ['material', '🧵 材料', kindCount.material], ['component', '🔧 组件', kindCount.component]].forEach(function (kv) {
      const b = el('button', 'inv-cat' + (invCategory === kv[0] ? ' on' : ''), kv[1] + ' ' + kv[2]);
      b.addEventListener('click', function () { if (invCategory !== kv[0]) { invCategory = kv[0]; renderView(); } });
      tabs.appendChild(b);
    });

    const colMain = el('div', 'col-main');
    colMain.appendChild(el('h3', null, '📦 物品明细'));
    colMain.appendChild(tabs);
    const list = el('div', 'inv-page');
    let keys = Object.keys(st.inventory);
    if (invCategory !== 'all') keys = keys.filter(function (id) { return itemMeta(id).kind === invCategory; });
    if (keys.length === 0) {
      list.appendChild(el('div', 'hint', invCategory === 'all' ? '背包空空如也。去「钓鱼」页选个钓点抛竿，渔获会自动入包。' : '该分类下暂时没有物品。'));
    } else {
      // 按单价排序：出售/获得不改变行位置（排序与数量无关）
      keys.sort(function (a, b) { return unitPrice(b) - unitPrice(a) || (a < b ? -1 : 1); });
      keys.forEach(function (id) {
        const meta = itemMeta(id);
        const cnt = st.inventory[id];
        const kindName = meta.kind === 'fish' ? '鱼' : meta.kind === 'material' ? '材料' : meta.kind === 'component' ? '组件' : '物品';
        const row = el('div', 'inv-row inv-page-row');
        row.innerHTML =
          '<span class="' + rarityClass(meta.rarity) + '">' + esc(meta.name) + '</span>' +
          '<span class="kind-tag">' + kindName + '</span>' +
          '<span class="cnt">×' + cnt + '</span>' +
          '<span class="unit-price">现价 ' + unitPrice(id) + '💰</span>' +
          '<span class="subtotal">小计 ' + itemValue(id) + '💰</span>';
        const acts = el('span', 'inv-acts');
        const sellBtn = el('button', 'mini primary-mini', '出售 1');
        sellBtn.title = '按当前系统收购价出售 1 个';
        sellBtn.addEventListener('click', function () { doSell(id, 1); });
        acts.appendChild(sellBtn);
        const sellAll = el('button', 'mini', '全卖');
        sellAll.title = '按当前系统收购价出售全部 ' + cnt + ' 个';
        sellAll.addEventListener('click', function () {
          if (!confirm('以现价 ' + unitPrice(id) + '💰 出售 ' + meta.name + ' ×' + cnt + '（合计 ' + itemValue(id) + '💰）？')) return;
          doSell(id, cnt);
        });
        acts.appendChild(sellAll);
        const lb = el('button', 'mini', '上架');
        lb.title = '挂到开放市集，由其他玩家购买（收定价总额 1% 上架费，下架不退）';
        lb.addEventListener('click', function () {
          const qty = parseInt(prompt('上架数量（持有 ' + cnt + '）', '1'), 10);
          if (!qty || qty <= 0) return;
          const price = parseInt(prompt('单价（金币；上架费 = 定价总额的 1%，下架不退；系统价 ' + unitPrice(id) + '）', String(unitPrice(id) * 2)), 10);
          if (!price || price <= 0) return;
          const realQty = Math.min(qty, cnt);
          if (st.player.coins < listFee(price, realQty)) { toast('金币不足（需上架费 ' + listFee(price, realQty) + '💰）'); return; }
          call(window.Net.marketList(id, realQty, price), function (r) { return '已上架到市集（支付上架费 ' + r.data.fee + '💰，下架不退）'; }).then(function (r) {
            if (r && r.ok) { st.inventory = r.data.inventory; st.player.coins = r.data.coins; renderTopbar(); renderView(); }
          });
        });
        acts.appendChild(lb);
        row.appendChild(acts);
        list.appendChild(row);
      });
    }
    colMain.appendChild(list);
    colMain.appendChild(el('div', 'hint', '提示：出售走系统商店动态收购价（售出越多价越低）；「上架」挂到开放市集等玩家购买，需支付定价总额 1% 上架费（下架不退），成交另收 10% 税（卖家承担）。'));
    panel.appendChild(colMain);

    const side = el('div', 'col-side');
    side.appendChild(el('h3', null, '📊 背包概览'));
    const kinds = {}; let totalCnt = 0, totalValue = 0;
    Object.keys(st.inventory).forEach(function (id) {
      kinds[itemMeta(id).kind] = (kinds[itemMeta(id).kind] || 0) + 1;
      totalCnt += st.inventory[id];
      totalValue += itemMeta(id).price * st.inventory[id]; // 预估总价：按基准价，不随市场浮动
    });
    const summary = el('div', 'codex-summary');
    summary.innerHTML =
      '<div class="cs-box"><b>' + Object.keys(st.inventory).length + '</b><span>物品种类</span></div>' +
      '<div class="cs-box"><b>' + totalCnt + '</b><span>总件数</span></div>' +
      '<div class="cs-box"><b>' + totalValue + '</b><span>预估总价（基准）</span></div>';
    side.appendChild(summary);

    // 一键出售子菜单（种类/品质筛选 + 实时预估收入）
    const bulk = el('div', 'bulk-sell');
    const bbtn = el('button', 'primary big', '⚡ 一键出售');
    bbtn.addEventListener('click', function () { bulkSellOpen = !bulkSellOpen; renderView(); });
    bulk.appendChild(bbtn);
    if (bulkSellOpen) {
      const sub = el('div', 'bulk-sub');
      const row1 = el('div', 'bulk-row');
      row1.appendChild(el('label', null, '种类'));
      const catSel = el('select', 'bulk-select');
      [['all', '全部种类'], ['fish', '🐟 鱼类'], ['material', '🧵 材料'], ['component', '🔧 组件']].forEach(function (kv) {
        const o = el('option', null, kv[1]); o.value = kv[0]; catSel.appendChild(o);
      });
      catSel.value = bulkCat;
      catSel.addEventListener('change', function () { bulkCat = catSel.value; updateBulkEst(); });
      row1.appendChild(catSel);
      row1.appendChild(el('label', null, '品质'));
      const rarSel = el('select', 'bulk-select');
      [['all', '全部品质'], ['common', '普通'], ['big', '大鱼'], ['rare', '稀有'], ['epic', '史诗']].forEach(function (kv) {
        const o = el('option', null, kv[1]); o.value = kv[0]; rarSel.appendChild(o);
      });
      rarSel.value = bulkRar;
      rarSel.addEventListener('change', function () { bulkRar = rarSel.value; updateBulkEst(); });
      row1.appendChild(rarSel);
      sub.appendChild(row1);

      const mIds = Object.keys(st.inventory).filter(function (id) {
        const m = itemMeta(id);
        return (bulkCat === 'all' || m.kind === bulkCat) && (bulkRar === 'all' || m.rarity === bulkRar);
      });
      const mCnt = mIds.reduce(function (s, id) { return s + st.inventory[id]; }, 0);
      const unit = function (id) { const sp = st.shop && st.shop[id]; return sp ? sp.price : itemMeta(id).price; };
      const mEst = mIds.reduce(function (s, id) { return s + unit(id) * st.inventory[id]; }, 0);
      const est = el('div', 'bulk-est');
      est.innerHTML = '将出售 <b>' + mIds.length + '</b> 种 / <b>' + mCnt + '</b> 件 · 预估收入 <b>' + Math.round(mEst) + '</b>💰<span class="muted">（按当前实时收购价）</span>';
      sub.appendChild(est);
      const go = el('button', 'primary' + (mCnt > 0 ? '' : ' locked'), '确认出售');
      go.addEventListener('click', function () { if (mCnt > 0) bulkSellMatching(); });
      sub.appendChild(go);
      bulk.appendChild(sub);
    }
    side.appendChild(bulk);

    const breakdown = el('div', 'inv-breakdown');
    [['fish', '🐟 鱼类'], ['material', '🧵 材料'], ['component', '🔧 组件']].forEach(function (kv) {
      if (!kinds[kv[0]]) return;
      breakdown.appendChild(el('div', 'inv-kind-line', kv[1] + '　' + kinds[kv[0]] + ' 种'));
    });
    side.appendChild(breakdown);

    // 我的挂单（可下架；上架费不退）
    const mine = (st.market || []).filter(function (l) { return st.me && st.me.id != null && String(l.seller).toLowerCase() === String(st.me.id).toLowerCase(); })
      .sort(function (a, b) { return b.t - a.t; });
    side.appendChild(el('h3', null, '🏷️ 我的挂单（' + mine.length + '）'));
    const ml = el('div', 'my-listings');
    if (!mine.length) {
      ml.appendChild(el('div', 'hint', '暂无在售挂单。在左侧物品行点「上架」挂到开放市集。'));
    } else {
      mine.forEach(function (l) {
        const row = el('div', 'inv-row my-listing-row');
        row.innerHTML = '<span class="' + rarityClass(itemMeta(l.id).rarity) + '">' + esc(l.name) + '</span>' +
          '<span class="cnt">×' + l.qty + ' @ ' + l.price + '💰</span>';
        const acts = el('span', 'inv-acts');
        const cb = el('button', 'mini', '下架');
        cb.title = '下架取回物品（上架费不退）';
        cb.addEventListener('click', function () {
          call(window.Net.marketCancel(l.lid), '已下架，物品退回背包（上架费不退）').then(function (r) {
            if (r && r.ok) { st.inventory = r.data.inventory; renderTopbar(); renderView(); }
          });
        });
        acts.appendChild(cb);
        row.appendChild(acts);
        ml.appendChild(row);
      });
    }
    side.appendChild(ml);
    side.appendChild(el('div', 'hint', '现价随全服售出量浮动，可在「系统商店」看趋势；大鱼与稀有物品建议挂市集卖高价。'));
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
      const meIsA = S().me && S().me.id != null && t.a.key === String(S().me.id).toLowerCase();
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

    // 有交易：先确定双方身份（key 均为小写，比对时做大小写免疫），再按阶段渲染
    const meKey = st.me && st.me.id != null ? String(st.me.id).toLowerCase() : null;
    const meIsA = !!(meKey && t.a.key === meKey);
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
  // 当前展开详情的图鉴条目 + 当前分类（模块级：重绘间保留）
  let codexDetailId = null;
  let codexCategory = 'all';

  // 图鉴详情浮层：完整信息 + 全部产地（点击卡片开合；未解锁也可查看获取信息）
  function openCodexDetail(cell, it, rec) {
    document.querySelectorAll('.codex-detail').forEach(function (d) { d.remove(); });
    const spots = D.spotsOf(it.id);
    const rarityName = it.rarity === 'big' ? '大鱼' : it.rarity === 'rare' ? '稀有' : it.rarity === 'epic' ? '史诗' : '普通';
    const box = el('div', 'codex-detail');
    box.addEventListener('click', function (ev) { ev.stopPropagation(); }); // 浮层内点击不触发卡片开合
    box.innerHTML =
      '<div class="cd-title ' + rarityClass(it.rarity) + '">' + esc(it.name) + '</div>' +
      (rec
        ? '<div class="cd-line">已钓 <b>' + rec.count + '</b> 次 · 首获 ' + timeStr(rec.first) + '</div>'
        : '<div class="cd-line muted">未解锁 · 去产地垂钓即可解锁</div>') +
      '<div class="cd-line">稀有度：' + rarityName + ' · 基准价 ' + (it.price || 0) + '💰</div>' +
      (it.size ? '<div class="cd-line">体型 ' + it.size[0] + '-' + it.size[1] + ' cm</div>' : '<div class="cd-line">材料 / 组件</div>') +
      (rec && rec.max != null ? '<div class="cd-line">我钓到过：最大 <b>' + rec.max + '</b> cm · 最小 <b>' + rec.min + '</b> cm</div>' : '') +
      (rec && rec.max == null && it.size ? '<div class="cd-line muted">个人体型极值将在下次钓到后开始记录</div>' : '');
    if (spots.length) {
      box.appendChild(el('div', 'cd-sub', '📍 产出地点（全部 ' + spots.length + ' 处）'));
      const sl = el('div', 'cd-spots');
      spots.forEach(function (s) { sl.appendChild(el('div', 'cd-spot', '🎣 ' + esc(s))); });
      box.appendChild(sl);
    } else {
      box.appendChild(el('div', 'cd-line muted', '暂无产地信息。'));
    }
    cell.appendChild(box);
  }

  function toggleCodexDetail(cell, it, rec) {
    if (codexDetailId === it.id) { // 再点一次收起
      codexDetailId = null;
      const d = cell.querySelector('.codex-detail');
      if (d) d.remove();
      return;
    }
    codexDetailId = it.id;
    openCodexDetail(cell, it, rec);
  }

  function renderCodex() {
    const main = $('main');
    const st = S();
    main.innerHTML = '';
    const panel = el('div', 'panel wide');
    const caught = st.codex || {};
    const total = Object.keys(caught).length;
    panel.innerHTML = '<h2>📖 鱼类图鉴 <span class="subtitle">个人收集进度 · 点击卡片查看完整信息（产地/个人体型极值）</span></h2>';

    // 汇总
    const items = D.allItems();
    const fishItems = items.filter(function (i) { return i.kind === 'fish'; });
    const gotFish = fishItems.filter(function (i) { return caught[i.id]; }).length;
    const summary = el('div', 'codex-summary');
    summary.innerHTML = '<div class="cs-box"><b>' + gotFish + ' / ' + fishItems.length + '</b><span>鱼类收集</span></div>' +
      '<div class="cs-box"><b>' + total + '</b><span>图鉴条目</span></div>' +
      '<div class="cs-box"><b>' + (st.catchCount || 0) + '</b><span>累计渔获</span></div>';
    panel.appendChild(summary);

    // 分类页签（与背包一致；数量为各类条目数）
    const tabs = el('div', 'inv-cats');
    [['all', '📦 全部', items.length], ['fish', '🐟 鱼类', fishItems.length],
     ['material', '🧵 材料', items.filter(function (i) { return i.kind === 'material'; }).length],
     ['component', '🔧 组件', items.filter(function (i) { return i.kind === 'component'; }).length]].forEach(function (kv) {
      const b = el('button', 'inv-cat' + (codexCategory === kv[0] ? ' on' : ''), kv[1] + ' ' + kv[2]);
      b.addEventListener('click', function () { if (codexCategory !== kv[0]) { codexCategory = kv[0]; renderView(); } });
      tabs.appendChild(b);
    });
    panel.appendChild(tabs);

    const grid = el('div', 'codex-grid');
    const cellById = {};
    const shown = codexCategory === 'all' ? items : items.filter(function (i) { return i.kind === codexCategory; });
    shown.forEach(function (it) {
      const rec = caught[it.id];
      const cell = el('div', 'codex-cell' + (rec ? ' got' : '') + ' k-' + it.kind);
      const spots = D.spotsOf(it.id);
      const rarityName = it.rarity === 'big' ? '大鱼' : it.rarity === 'rare' ? '稀有' : it.rarity === 'epic' ? '史诗' : '普通';
      // 统一五行骨架：全部卡片结构一致、高度对齐
      cell.innerHTML =
        '<div class="cx-name ' + (rec ? rarityClass(it.rarity) : 'locked-name') + '">' + esc(it.name) + '</div>' +
        '<div class="cx-meta">' + (rec ? '已钓 ' + rec.count + ' 次' : '未解锁') + '</div>' +
        '<div class="cx-meta muted">' + (rec ? '首获 ' + timeStr(rec.first) : rarityName + ' · ' + (it.price || 0) + '💰') + '</div>' +
        (it.size ? '<div class="cx-meta muted">体型 ' + it.size[0] + '-' + it.size[1] + 'cm</div>' : '<div class="cx-meta muted">材料 / 组件</div>') +
        (spots.length ? '<div class="cx-meta cx-spots">📍 产地 ' + spots.length + ' 处</div>' : '<div class="cx-meta muted">📍 —</div>');
      cell.title = '点击查看完整信息';
      cell.addEventListener('click', function () { toggleCodexDetail(cell, it, rec); });
      cellById[it.id] = cell;
      grid.appendChild(cell);
    });
    // 重绘后恢复展开中的详情
    if (codexDetailId && cellById[codexDetailId]) {
      openCodexDetail(cellById[codexDetailId], D.itemOf(codexDetailId), caught[codexDetailId] || null);
    }
    panel.appendChild(grid);
    main.appendChild(panel);
  }

  // ---- 大鱼记录视图 ----
  // 某种鱼的前十大捕获记录弹窗
  function openRecordsModal(fishId) {
    document.querySelectorAll('.modal-overlay').forEach(function (m) { m.remove(); });
    const meta = itemMeta(fishId);
    const overlay = el('div', 'modal-overlay');
    overlay.addEventListener('click', function (ev) { if (ev.target === overlay) closeRecordsModal(); });
    const box = el('div', 'modal-box shop-modal');
    box.innerHTML = '<div class="modal-head"><span class="modal-title">🏆 ' + esc(meta.name) + ' · 全服前十大捕获</span><button class="mini modal-close">✕ 关闭</button></div><div class="modal-body" id="records-modal-body">加载中…</div>';
    box.querySelector('.modal-close').addEventListener('click', function () { closeRecordsModal(); });
    overlay.appendChild(box);
    document.body.appendChild(overlay);
    window.Net.recordsTop(fishId).then(function (r) {
      const body = document.getElementById('records-modal-body');
      if (!body) return;
      if (!r || !r.ok) { body.textContent = (r && r.data && r.data.error) || '加载失败'; return; }
      const top = r.data.top || [];
      body.innerHTML = '';
      if (!top.length) { body.appendChild(el('div', 'hint', '该鱼还没有捕获记录。')); return; }
      top.forEach(function (t, i) {
        const rank = i + 1;
        const medal = rank === 1 ? '🥇' : rank === 2 ? '🥈' : rank === 3 ? '🥉' : '#' + rank;
        body.appendChild(el('div', 'top10-row',
          '<span class="top10-rank">' + medal + '</span>' +
          '<span class="top10-size">' + t.size + '<span class="u">cm</span></span>' +
          '<span class="top10-who">' + esc(t.who) + '</span>' +
          '<span class="top10-time">' + timeStr(t.t) + '</span>'));
      });
      body.appendChild(el('div', 'sd-legend', '共收录 ' + top.length + ' 条 · 每次捕获自动更新'));
    });
  }
  function closeRecordsModal() {
    document.querySelectorAll('.modal-overlay').forEach(function (m) { m.remove(); });
  }

  function renderRecords() {
    const main = $('main');
    const st = S();
    main.innerHTML = '';
    const panel = el('div', 'panel wide');
    panel.innerHTML = '<h2>🏆 大鱼记录 <span class="subtitle">全服纪录 · 按鱼类分项查看</span></h2>';

    const recs = Object.keys(st.records || {}).map(function (id) { return st.records[id]; })
      .sort(function (a, b) { return b.size - a.size; });

    // 全场最大纪录：单独置顶展示
    if (recs.length) {
      const top = recs[0];
      const topMeta = itemMeta(top.id);
      const hero = el('div', 'record-hero');
      hero.innerHTML =
        '<div class="rh-crown">👑 全场最大</div>' +
        '<div class="rh-name ' + rarityClass(topMeta.rarity) + '">' + esc(top.name) + '</div>' +
        '<div class="rh-size">' + top.size + '<span class="u">cm</span></div>' +
        '<div class="rh-who">纪录保持者：' + esc(top.who) + ' · ' + timeStr(top.t) + '</div>';
      panel.appendChild(hero);
    } else {
      panel.appendChild(el('div', 'hint', '还没有大鱼记录。第一条纪录等着你来刷新！'));
    }

    // 分鱼类查看：每种鱼一个卡片（有纪录按体型排序，无纪录灰显在后）
    panel.appendChild(el('h3', null, '🐟 分鱼类纪录'));
    const withRec = [], without = [];
    D.allItems().filter(function (i) { return i.kind === 'fish'; }).forEach(function (f) {
      const rec = st.records && st.records[f.id];
      (rec ? withRec : without).push({ f: f, rec: rec });
    });
    withRec.sort(function (a, b) { return b.rec.size - a.rec.size; });
    const grid = el('div', 'record-grid');
    withRec.concat(without).forEach(function (e) {
      const cell = el('div', 'record-cell' + (e.rec ? ' with-rec' : ' none'));
      if (e.rec) {
        cell.innerHTML =
          '<div class="rc-name ' + rarityClass(e.f.rarity) + '">' + esc(e.f.name) + '</div>' +
          '<div class="rc-size">' + e.rec.size + '<span class="u">cm</span></div>' +
          '<div class="rc-who">' + esc(e.rec.who) + ' · ' + timeStr(e.rec.t) + '</div>' +
          '<div class="rc-hint">点击查看前十大</div>';
        cell.title = '点击查看该鱼全服前十大捕获';
        cell.addEventListener('click', function () { openRecordsModal(e.f.id); });
      } else {
        cell.innerHTML =
          '<div class="rc-name locked-name">' + esc(e.f.name) + '</div>' +
          '<div class="rc-size muted">—</div>' +
          '<div class="rc-who">暂无纪录</div>';
      }
      grid.appendChild(cell);
    });
    panel.appendChild(grid);

    // 小鱼纪录（全服最小体型，升序）
    const smalls = Object.keys(st.smallRecords || {}).map(function (id) { return st.smallRecords[id]; })
      .sort(function (a, b) { return a.size - b.size; });
    panel.appendChild(el('h3', null, '🐠 小鱼纪录（全服最小）'));
    if (!smalls.length) {
      panel.appendChild(el('div', 'hint', '还没有小鱼纪录。钓到一条鱼就会生成它的最小纪录。'));
    } else {
      const sgrid = el('div', 'record-grid');
      smalls.forEach(function (r) {
        const meta = itemMeta(r.id);
        const cell = el('div', 'record-cell small-fish');
        cell.innerHTML =
          '<div class="rc-name ' + rarityClass(meta.rarity) + '">' + esc(r.name) + '</div>' +
          '<div class="rc-size sf-size">' + r.size + '<span class="u">cm</span></div>' +
          '<div class="rc-who">' + esc(r.who) + ' · ' + timeStr(r.t) + '</div>';
        sgrid.appendChild(cell);
      });
      panel.appendChild(sgrid);
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

  // 进入页面时按需拉取该页数据（其余页面不产生任何请求）
  function loadViewData(view) {
    if (!window.Net) return;
    if (view === 'shop' || view === 'inventory') window.Net.fetchShop();
    else if (view === 'market') window.Net.fetchMarket();
    else if (view === 'codex') window.Net.fetchCodex();
    else if (view === 'records') window.Net.fetchRecords();
  }

  function renderView() {
    if (currentView === 'fishing') renderFishing();
    else if (currentView === 'bd') renderBD();
    else if (currentView === 'ground') renderGround();
    else if (currentView === 'inventory') renderInventory();
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
        if (r && r.status === 0) { authMsg('无法连接服务器，请确认已运行 run.bat'); return; }
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

  // 刷新主视图。每个视图只关心与自己相关的广播类型（scope）：
  // 无关广播（如他人的渔获 feed/players）只更新顶栏/导航，不重绘主区——
  // 否则只要有人上鱼，钓竿配置/背包等页面的组件卡片都会跟着整页闪烁重绘。
  const VIEW_SCOPES = {
    fishing: ['players', 'grounds', 'catch', 'assets'], // 实况/日志/背包随广播更新
    bd: [],                                             // 钓竿配置：只随操作重绘（展示数据不受广播影响）
    ground: ['players', 'grounds', 'feed'],
    inventory: ['assets', 'shop'],
    shop: ['assets', 'shop'],
    market: ['assets', 'market'],
    trade: ['trade', 'assets', 'codex'],
    codex: ['codex'],
    records: ['records'],
    mall: [], collect: [],
  };
  function refreshAll(scope) {
    if (scope === 'all') scope = null; // init 全量刷新
    if (shopModalId && scope === 'shop') fillShopModal(shopModalId); // 弹窗数据静默刷新
    // 一键出售子菜单展开时：只更新预估数字，不重绘页面（下拉框不会被广播冲掉）
    if (currentView === 'inventory' && bulkSellOpen && scope && scope !== 'shop') {
      updateBulkEst();
      return;
    }
    renderTopbar(); renderNav();
    const scopes = VIEW_SCOPES[currentView];
    if (!scope || !scopes || scopes.indexOf(scope) >= 0) renderView();
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

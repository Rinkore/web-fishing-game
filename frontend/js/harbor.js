/*
 * DeepFish 港湾外壳（设计稿 v2 · 阶段 A–E）
 * 阶段 A：HUD、内景面板（承载既有 #main，render* 不改）、目录列表模式、路由与设置。
 * 阶段 B：港湾场景（画面见 js/harbor-art.js）、建筑热区与状态、罗盘、告示板、C / 数字快捷键。
 * 阶段 C：时段设置（跟随时钟 / 固定模式 / 时段编辑器 / 混合过渡）。
 * 阶段 D：手机布局选项（横向全景 / 罗盘首页 / 自动）、bug 修复。
 * 阶段 E：港湾成为默认界面风格；经典侧栏作为设置保留，不再是默认。
 * 设计稿见 output/design-review/redesign/v2/index.html §13；本文件只做「外壳」，
 * 页面内容一律仍由 ui.js 的 render* 渲染，二者通过 ui.js 的 harborHook / UI.openView 通信。
 */
window.HarborShell = (function () {
  'use strict';
  const D = window.GameData;
  // v2 评审（2026-09-27）定稿的默认值 —— 阶段 B/C/D 一律从这里取，不要再各处写字面量。
  const DEFAULTS = {
    theme: 'harbor',           // 阶段 E：港湾成为默认；经典侧栏作为设置保留
    timeMode: 'clock',         // 跟随本地时间（固定模式由玩家显式切换）
    periods: { dawn: '05:00', day: '07:30', dusk: '17:30', night: '19:30' },
    blend: 45,               // 过渡时长（分钟），以每个时段开始时间为中心
    fixed: 'night',          // 切到固定模式时的默认时段
    signs: 'always',         // 建筑招牌默认始终显示
    mobile: 'auto',          // 手机布局默认自动
  };
  const ORDER = ['dawn', 'day', 'dusk', 'night'];
  const META = {
    dawn: { name: '清晨', icon: '🌅' },
    day: { name: '白天', icon: '☀️' },
    dusk: { name: '黄昏', icon: '🌇' },
    night: { name: '夜晚', icon: '🌙' },
  };

  function $(id) { return document.getElementById(id); }
  function toMin(hhmm) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || ''));
    if (!m) return 0;
    return (Math.min(23, +m[1]) * 60 + Math.min(59, +m[2]));
  }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  // ---- 时段表（评审默认值；阶段 C 起改由玩家设置覆盖）----
  // 时段与过渡一律取自 artSettings()：HUD 时间牌和画面必须读同一份设置，
  // 否则玩家在设置里改完时段，画面换了、时间牌还停在默认值。
  function starts() { const c = artSettings(); return ORDER.map(function (id) { return toMin(c.periods[id]); }); }
  // 给定当天分钟数，返回所处时段；过渡窗口以每个时段开始时间为中心（blend / 2 分钟）。
  // 返回 { id, name, icon, minute, startMin, blend: [fromId, toId] | null }。
  function periodAt(minute) {
    const m = ((Math.round(minute) % 1440) + 1440) % 1440;
    const st = starts();
    const half = artSettings().blend / 2;
    let idx = ORDER.length - 1;                       // 凌晨落在「夜晚」（19:30 → 次日 05:00）
    for (let i = 0; i < ORDER.length; i++) if (m >= st[i]) idx = i;
    let blend = null;
    for (let i = 0; i < ORDER.length; i++) {
      let d = m - st[i];
      if (d < -720) d += 1440;
      if (d > 720) d -= 1440;
      if (Math.abs(d) < half) { blend = [ORDER[(i + ORDER.length - 1) % ORDER.length], ORDER[i]]; break; }
    }
    const id = ORDER[idx];
    return { id: id, name: META[id].name, icon: META[id].icon, minute: m, startMin: st[idx], blend: blend };
  }
  function nowInfo() { const d = new Date(); return periodAt(d.getHours() * 60 + d.getMinutes()); }
  function label(info) {
    return info.name + ' ' + pad2(Math.floor(info.minute / 60)) + ':' + pad2(info.minute % 60) +
      (info.blend ? ' · 过渡到' + META[info.blend[1]].name : '');
  }

  // ---- 外壳状态 ----
  let els = null, originMain = null, originStatus = null, originStatusNext = null;
  let on = false, statePlace = null, dirOpen = false, suppressHash = false, returnFocus = null, dirReturnFocus = null;

  function theme() {
    const ps = window.PlayerSettings;
    return (ps && ps.get && ps.get().theme) || DEFAULTS.theme;
  }
  // 登录后 ui.js 会把 #auth 的 display 设为 none；未登录（含启动瞬间）不接管外壳。
  function authed() { const a = $('auth'); return !!a && a.style.display === 'none'; }
  // v4 F5：classic 从 choices.theme 移除，harbor 是唯一主题，enabled() 简化为 authed()
  function placeIds() { return (D && D.NAV ? D.NAV : []).map(function (n) { return n.id; }); }
  function isPlace(id) { return !!id && placeIds().indexOf(id) >= 0; }
  function placeName(id) {
    const n = D && D.NAV && D.NAV.find(function (x) { return x.id === id; });
    return n ? n.name : id;
  }

  function setHash(h) {
    if ((location.hash || '') === h) return;
    suppressHash = true;
    try { location.hash = h; } catch (e) { suppressHash = false; }
  }
  // v3 F1：解析 #/place 和 #/place/tabIndex 两种格式
  function hashPlace() {
    const m = /^#\/([a-z]+)(?:\/(\d+))?$/.exec(location.hash || '');
    if (!m) return { id: '', tab: 0, explicit: false };
    return { id: m[1], tab: m[2] != null ? +m[2] : 0, explicit: m[2] != null };
  }

  // ---- HUD ----
  function paintTime() {
    if (!els || !els.ticon) return;
    const ps = window.PlayerSettings && PlayerSettings.get ? PlayerSettings.get() : {};
    const fixed = ps.timeMode && ps.timeMode !== 'clock' ? ps.timeMode : null;
    let icon, text, ariaLabel;
    if (fixed) {
      icon = META[fixed].icon;
      text = '固定' + META[fixed].name;
      ariaLabel = '港湾时间：固定' + META[fixed].name + '，打开设置';
    } else {
      const info = nowInfo();
      icon = info.icon;
      text = label(info);
      ariaLabel = '港湾时间：' + label(info) + '，打开设置';
    }
    els.ticon.textContent = icon;
    els.tlabel.textContent = text;
    els.tchip.setAttribute('aria-label', ariaLabel);
    els.tchip.setAttribute('title', ariaLabel);
  }
  function syncHud() {
    if (!els || !on) return;
    paintTime();
    const st = window.Engine && window.Engine.state;
    const sub = els.castSub;
    if (!sub) return;
    const p = (st && st.player) || {};
    let text = '未出发';
    if (p.status === 'fishing') text = '钓鱼中';
    else if (p.groundId) {
      const g = ((D && D.GROUNDS) || []).find(function (x) { return x.id === p.groundId; });
      text = g ? g.name : '空闲';
    }
    if (sub.textContent !== text) sub.textContent = text;
    // v3 F1：播报字幕 — feed 新的在前（net.js 用 unshift），所以取 feed[0]；feed 条目没有 text
    // 字段，这一行按动态流的字段现拼，和「港湾现场 / 社交动态」显示同一份数据。
    if (els.ticker) {
      const feed = (st && st.feed) || [];
      const latest = feed.length ? feed[0] : null;
      const it = latest && latest.item;
      const line = it ? ('📢 ' + (latest.who || '') + ' 在 ' + (latest.ground || '') +
        (latest.spot ? '·' + latest.spot : '') + ' 钓到 ' + (it.name || '') +
        (latest.size ? ' ' + latest.size + 'cm' : '') +
        (it.tier === 'G' ? ' 🥇' : it.tier === 'L' ? ' 🥈' : '')) : '';
      if (els.ticker.textContent !== line) els.ticker.textContent = line;
      // v2 阶段 F：内景面板打开时字幕保留（设计稿 §1：字幕在木梁上方的横条里一直播）；
      // 目录 / 罗盘是盖住场景的浮层，这两种情况才收起，避免文字压在浮层上。
      els.ticker.hidden = dirOpen || overlayOpen();
    }
  }

  // ---- 目录 / 内景面板 ----
  function showDir(flag) {
    if (flag && !dirOpen) dirReturnFocus = document.activeElement;
    dirOpen = flag;
    if (els.dirbox) els.dirbox.hidden = !(on && flag);
    if (els.root) els.root.classList.toggle('dir-open', !!flag);
    if (flag) {
      requestAnimationFrame(function () { if (els.dirClose) els.dirClose.focus(); });
    } else {
      const back = dirReturnFocus && dirReturnFocus.isConnected && dirReturnFocus.offsetParent ? dirReturnFocus : els.dir;
      if (back) back.focus();
      dirReturnFocus = null;
    }
  }
  function dirFocusable() {
    return Array.prototype.slice.call(document.querySelectorAll('#h-dirbox button, #h-dirbox [href], #h-dirbox [tabindex]:not([tabindex="-1"])'))
      .filter(function (el) { return !el.disabled && !el.hidden && el.offsetParent !== null; });
  }
  function showHome() {
    const wasPlace = statePlace;
    statePlace = null;
    house.drawer = false;
    if (els.panel) els.panel.classList.remove('h-house-mode', 'h-drawer-open');
    if (els.panel) {
      els.panel.hidden = true;
      // 清除 data-place 属性
      delete els.panel.dataset.place;
    }
    if (els.root) els.root.classList.add('home');
    // 阶段 B：港湾首页是场景本身，目录（列表模式）改为 ☰ / L 按需打开
    showDir(false);
    requestAnimationFrame(layoutScene);
    // 焦点还回进来之前的入口（建筑热区 / HUD 按钮）。必须在场景重新显示之后判断：
    // 内景打开时场景是 display:none，热区的 offsetParent 为空，会被误判成「入口已隐藏」。
    // 入口确实不在了（比如目录里的项已收起）就落到「出海钓鱼」。
    if (wasPlace) {
      const back = returnFocus && returnFocus.isConnected && returnFocus.offsetParent ? returnFocus : els.cast;
      if (back) back.focus();
    }
    returnFocus = null;
  }
  function showPlace(id, tab) {
    if (!on) return;
    if (!statePlace) returnFocus = document.activeElement;
    statePlace = id;
    if (els.root) els.root.classList.remove('home');
    if (els.panel) {
      els.panel.hidden = false;
      // v3 F3: 设置 data-place 属性以便 CSS 针对不同地点应用特定样式（如告示板的 cork 背景）
      els.panel.dataset.place = id;
    }
    // v2 阶段 F：标题用设计稿的「地点名 · 页面名」（§1 .plank），面包屑到大类 + 当前页签
    const full = (PLACES[id] && PLACES[id].full) || placeName(id);
    const place = (PLACES[id] && PLACES[id].name) || placeName(id);
    const meta = window.UI && UI.panelTabs ? UI.panelTabs() : null;
    const activeItem = meta && meta.items ? meta.items.filter(function (t) { return t.key === meta.active; })[0] : null;
    if (els.title) els.title.textContent = full;
    if (els.crumb) els.crumb.textContent = '港湾 › ' + place + (activeItem ? ' › ' + activeItem.label.replace(/ ↗$/, '') : '');
    // 渔屋：场景化内景 —— 先显示屋内画面，点物件才打开右侧抽屉（即 #main）
    const houseMode = id === 'character' && !!window.HouseArt;
    if (els.panel) {
      els.panel.classList.toggle('h-house-mode', houseMode);
      els.panel.classList.toggle('h-drawer-open', houseMode && house.drawer);
    }
    if (houseMode) {
      buildHouse(); refreshHouse();
      if (els.title) els.title.textContent = house.drawer && activeItem ? '渔屋 · ' + activeItem.label : '渔屋';
      if (els.back) els.back.textContent = house.drawer ? '↩ 回屋里' : '↩ 回港湾';
      requestAnimationFrame(layoutHouse);
    } else if (els.back) els.back.textContent = '↩ 回港湾';
    // v2 阶段 F：木梁下方的挂签由 ui.js 的页签定义渲染（渔屋场景模式不显示挂签，改由物件切换）
    buildPanelTabs();
    showDir(false);
    // v3 F1：页签路由 — 把当前一级页签写进 URL（与 ui.js 的页签顺序一致），关闭时恢复到 #/
    const tabIdx = meta && meta.items ? Math.max(0, meta.items.map(function (t) { return t.key; }).indexOf(meta.active)) : 0;
    if (houseMode) setHash('#/character' + (house.drawer ? '/' + tabIdx : ''));
    else setHash('#/' + id + (tabIdx ? '/' + tabIdx : ''));
    if (houseMode && !house.drawer) { const hb = house.hots[house.lastKey]; (hb && !hb.hidden ? hb : els.back).focus(); }
    else if (els.back) els.back.focus();
  }
  // v2 阶段 F：内景一级页签（挂签）——页签清单由 ui.js 按当前页面提供（UI.panelTabs），
  // 外壳只负责渲染成木梁下方的吊牌并转发点击；没有一级页签的页面（邮筒 / 栈桥）整条收起。
  function buildPanelTabs() {
    if (!els.tabs) return;
    if (statePlace === 'character' && window.HouseArt) { els.tabs.innerHTML = ''; return; }
    const meta = window.UI && UI.panelTabs ? UI.panelTabs() : null;
    if (!meta || !meta.items || meta.items.length < 2) { els.tabs.innerHTML = ''; return; }
    els.tabs.innerHTML = meta.items.map(function (t) {
      const badge = t.badge ? '<i class="h-badge">' + t.badge + '</i>' : '';
      return '<button role="tab" aria-selected="' + (t.key === meta.active ? 'true' : 'false') +
        '" data-tabkey="' + t.key + '">' + t.label + badge + '</button>';
    }).join('');
  }
  // 深链 #/place/序号：从页签 key 反查序号（与 UI.panelTabs 的顺序一致）
  function tabIndexOf(key) {
    const meta = window.UI && UI.panelTabs ? UI.panelTabs() : null;
    if (!meta || !meta.items) return 0;
    for (let i = 0; i < meta.items.length; i++) { if (meta.items[i].key === key) return i; }
    return 0;
  }
  function openPlace(id, tab) {
    // v3 F3：告示板（board）不在 D.NAV 里，单独处理：用统一的 board 视图打开 UI，传入页签索引
    if (id === 'board') {
      if (!window.UI || !window.UI.openView) return false;
      let ok = false;
      try { ok = window.UI.openView('board', tab || 0) !== false; } catch (e) { ok = false; }
      if (!ok) return false;
      showPlace('board');
      return true;
    }
    if (!isPlace(id)) return false;
    if (!window.UI || !window.UI.openView) return false;
    let ok = false;
    // v3 F1：#/place/tab 深链：把 0 基页签序号透传给 ui.js，越界由它收敛
    try { ok = window.UI.openView(id, tab || 0) !== false; } catch (e) { ok = false; }
    if (!ok) return false;
    if (id === 'wiki') return true;
    showPlace(id);
    return true;
  }

  // ---- 路由 ----
  function route() {
    if (!on) return;
    const hp = hashPlace();
    // 告示板的四个内容子视图（codex / records / logs / feedback）在 D.NAV 里也有同名条目，
    // 所以 isPlace 会把它们判成「独立地点」，打开成一页没有外壳标题、也不在场景里的内容。
    // 设计稿 v2 把告示板收成一个地点 + 挂签，这里必须先按子视图拦截，转成 #/board/序号。
    const boardSub = hp.id && hp.id !== 'wiki' && BOARD_SUB_IDS.indexOf(hp.id) >= 0 ? hp.id : null;
    if (boardSub) { openBoardView(boardSub); return; }
    // 设计稿 v2 阶段 F：告示板不在 D.NAV / placeIds 里（它由 openPlace 单独分支处理），
    // 但它是可深链的地点（#/board/2 = 打开「日志」），所以这里和普通地点一起判定。
    if (hp.id && (hp.id === 'board' || isPlace(hp.id))) {
      // 渔屋场景：#/character 只进屋（抽屉收起），#/character/序号 直接打开对应物件的抽屉
      if (hp.id === 'character') house.drawer = hp.explicit;
      if (statePlace !== hp.id) openPlace(hp.id, hp.tab);
      else if (hp.id === 'character') { if (hp.explicit) houseOpen(houseKeyAt(hp.tab), true); else houseCloseDrawer(true); }
      // 同一地点内的页签深链（如待在仓库里把地址改成 #/inventory/3）：外壳不必重建，
      // 只把序号翻成页签 key 转发给 UI.panelTab。目标已经是当前项就什么都不做——
      // 点击挂签时外壳自己已经 setHash，这里再切一次会白重绘一遍整页。
      else if (window.UI && UI.panelTabs && UI.panelTab) {
        const meta = UI.panelTabs();
        const items = meta && meta.items;
        if (items && items.length) {
          const kv = items[Math.min(hp.tab, items.length - 1)];
          if (kv && kv.key !== meta.active) UI.panelTab(kv.key);
        }
      }
      // WIKI 是外链：按旧口径交给 openBoardView 走 window.open
    } else if (hp.id && BOARD_SUB_IDS.indexOf(hp.id) >= 0) {
      openBoardView(hp.id);
    } else if (statePlace) showHome();
    else { showHome(); setHash('#/'); }
  }
  function onHashChange() {
    if (suppressHash) { suppressHash = false; return; }
    route();
  }

  // ---- 场景（阶段 B）：港湾画面、建筑热区、状态、罗盘 ----
  // 画面由 js/harbor-art.js 负责；这里把游戏状态整理成它要的 sceneState，并管热区 / 缩放 / 帧循环。
  // 10 个地点对应既有页面；告示板一处收纳 图鉴 / 日志 / 反馈 / WIKI（v1 评审定稿），点它先弹小选择面板。
  const PLACES = {
    // full 是设计稿 v2 的木梁标题（§1 .plank：地点名 · 页面名），name 仍用于目录与建筑招牌
    fishing: { name: '栈桥', full: '栈桥 · 钓鱼', view: 'fishing', icon: '🎣', desc: '打开海图，选钓点抛竿' },
    character: { name: '渔屋', full: '渔屋', view: 'character', icon: '🏠', desc: '晒场、宠物、角色、钓竿' },
    mail: { name: '邮筒', full: '邮筒 · 邮件', view: 'mail', icon: '📮', desc: '系统通知与附件领取' },
    inventory: { name: '仓库', full: '仓库 · 背包', view: 'inventory', icon: '📦', desc: '渔获、材料、宝匣、组件' },
    workshop: { name: '工坊', full: '工坊', view: 'workshop', icon: '⚒', desc: '装备成长、钓鱼套装、熔炼' },
    chest: { name: '宝匣', full: '宝匣 · 开箱', view: 'chest', icon: '🎁', desc: '合成宝匣与开箱' },
    mall: { name: '集市', full: '集市 · 商城', view: 'mall', icon: '🛒', desc: '限购、收购、玩家市集' },
    ground: { name: '酒馆', full: '渔人酒馆 · 社交', view: 'ground', icon: '🍺', desc: '在线玩家、好友、编队' },
    board: { name: '告示板', full: '告示板', view: null, icon: '📜', desc: '图鉴、日志、反馈、WIKI' },
    sea: { name: '远洋码头', full: '远洋码头', view: 'sea', icon: '⛵', desc: '远洋海域与船只' },
  };
  const BOARD_VIEWS = ['codex', 'records', 'logs', 'feedback', 'wiki'];
  const SCENE_ORDER = ['character', 'mail', 'inventory', 'workshop', 'chest', 'mall', 'ground', 'board', 'sea', 'fishing'];
  const scene = { built: false, wrap: null, pan: null, world: null, cv: null, ctx: null, hots: {}, layers: null, layerKey: '',
    state: null, stateSig: '', hover: null, scale: 0, lastFrame: 0, lastStill: 0, phone: false };

  function art() { return window.HarborArt; }
  function artSettings() {
    const ps = window.PlayerSettings && PlayerSettings.get ? PlayerSettings.get() : {};
    const A = art();
    const periods = (ps.periods && A && !A.validPeriods({ periods: ps.periods, blend: ps.blend != null ? ps.blend : DEFAULTS.blend }))
      ? ps.periods : DEFAULTS.periods;
    const blend = (ps.blend != null && [0, 30, 45, 60].indexOf(+ps.blend) >= 0) ? +ps.blend : DEFAULTS.blend;
    return { periods: periods, blend: blend };
  }
  function motionOff() { const ps = window.PlayerSettings; const m = ps && ps.motion ? ps.motion() : 'full'; return m === 'reduced' || m === 'off'; }
  // Phase G：不再依赖 #nav DOM 查询徽标；ui.js renderNav() 在重建 #nav 之前先写入 window._navMeta
  function navMeta(view) { return (window._navMeta && window._navMeta[view]) || null; }
  function navBadge(view) { const m = navMeta(view); return m ? m.badge || '' : ''; }
  function navLocked(view) { const m = navMeta(view); return m ? !!m.locked : false; }
  function placeBadge(id) {
    if (id === 'board') {
      let n = 0, any = '';
      BOARD_VIEWS.forEach(function (v) { const b = navBadge(v); if (b) { any = any || b; n += +b || 0; } });
      return n ? String(n) : any;
    }
    return navBadge(PLACES[id].view);
  }
  function placeLocked(id) {
    if (id === 'board') return BOARD_VIEWS.every(navLocked);
    return navLocked(PLACES[id].view);
  }
  // 只放游戏里真有数据来源的状态；设计稿里的「熔炼完成 / 船在远航」在当前玩法里没有对应（熔炼即时出结果、
  // 远洋是临时海域而不是计时航行），所以这两项恒为 false，画面上不会假装有事发生。
  function sceneState() {
    const st = (window.Engine && window.Engine.state) || {};
    const inv = st.inventory || {};
    const ids = Object.keys(inv).filter(function (k) { return inv[k] > 0; });
    const chests = ids.some(function (k) { return D && D.isChest && D.isChest(k); });
    const h = st.house || {}, cap = +h.capacityHours || 0;
    const locked = {};
    SCENE_ORDER.forEach(function (id) { if (placeLocked(id)) locked[id] = true; });
    let papers = 1;
    BOARD_VIEWS.forEach(function (v) { if (navBadge(v)) papers++; });
    return {
      fishing: !!(st.fishing && st.fishing.active),
      mail: (st.mailUnread || 0) + (st.mailPending || 0),
      crates: Math.min(6, Math.ceil(ids.length / 6)),
      chestReady: chests,
      online: Math.max(0, Math.min(6, (st.onlineTotal || (st.players || []).length || 0) - 1)),
      papers: Math.min(5, papers),
      houseFull: cap > 0 && (+h.hours || 0) >= cap,
      forgeReady: false, voyageAway: false,
      locked: locked,
    };
  }
  function placeStatus(id, s) {
    if (s.locked[id]) return '暂未开放';
    switch (id) {
      case 'fishing': return s.fishing ? '钓鱼中' : '空闲';
      case 'mail': return s.mail ? s.mail + ' 封未读或待领取' : '没有新邮件';
      case 'chest': return s.chestReady ? '有宝匣待开' : '没有宝匣';
      case 'character': return s.houseFull ? '晒场满了，快去收取' : '';
      case 'ground': { const n = (window.Engine && Engine.state.onlineTotal) || 0; return n ? n + ' 人在线' : ''; }
    }
    return '';
  }
  // v3 F3：告示板改为内景面板（四个子视图作为页签），不再弹选择浮层
  // 子视图 id（用于路由解析和 openBoardView）
  const BOARD_SUB_IDS = BOARD_VIEWS;
  // 告示板保留 view:null — openPlace 对 'board' 单独处理，不走 PLACES[id].view 路径

  // 进入告示板：直接用 openPlace，可选指定子视图索引
  function openBoardView(viewId) {
    const idx = BOARD_VIEWS.indexOf(viewId);
    openPlace('board', idx >= 0 ? idx : 0);
  }

  // ---- 渔屋场景化内景（设计稿 output/design-review/fishhouse）：画面见 js/house-art.js ----
  // 进渔屋先看屋内画面；点物件 = 切到对应一级页签并打开右侧抽屉（抽屉就是 #h-pbody / #main）。
  const house = { built: false, wrap: null, world: null, cv: null, ctx: null, hots: {}, layers: null, layerKey: '',
    state: {}, hover: null, drawer: false, lastKey: 'yard', lastFrame: 0, lastStill: 0 };
  function houseMode() { return statePlace === 'character' && !!window.HouseArt && house.built; }
  function houseItems() { const m = window.UI && UI.panelTabs ? UI.panelTabs() : null; return (m && m.items) || []; }
  function houseKeyAt(i) { const it = houseItems(); return it.length ? it[Math.min(Math.max(0, i), it.length - 1)].key : 'yard'; }
  function buildHouse() {
    if (house.built || !els.panel || !window.HouseArt) return;
    const A = window.HouseArt;
    house.built = true;
    house.wrap = document.createElement('div'); house.wrap.className = 'h-house'; house.wrap.id = 'h-house';
    house.wrap.setAttribute('role', 'group'); house.wrap.setAttribute('aria-label', '渔屋内景，点击物件打开功能');
    house.world = document.createElement('div'); house.world.className = 'h-house-world';
    house.cv = document.createElement('canvas'); house.cv.width = A.W; house.cv.height = A.H; house.cv.setAttribute('aria-hidden', 'true');
    house.ctx = house.cv.getContext('2d'); house.ctx.imageSmoothingEnabled = false;
    house.world.appendChild(house.cv);
    A.DRAW_ORDER.forEach(function (key, i) {
      const p = A.PLACES[key], b = document.createElement('button');
      b.type = 'button'; b.className = 'h-hot'; b.dataset.house = key;
      b.style.left = (p.hot[0] / A.W * 100) + '%'; b.style.top = (p.hot[1] / A.H * 100) + '%';
      b.style.width = (p.hot[2] / A.W * 100) + '%'; b.style.height = (p.hot[3] / A.H * 100) + '%';
      b.setAttribute('aria-keyshortcuts', String(i + 1));
      b.innerHTML = '<span class="h-sign"></span>';
      b.addEventListener('mouseenter', function () { house.hover = key; });
      b.addEventListener('mouseleave', function () { if (house.hover === key) house.hover = null; });
      b.addEventListener('focus', function () { house.hover = key; });
      b.addEventListener('blur', function () { if (house.hover === key) house.hover = null; });
      b.addEventListener('click', function () { houseOpen(key); });
      house.hots[key] = b; house.world.appendChild(b);
    });
    house.wrap.appendChild(house.world);
    els.panel.insertBefore(house.wrap, els.tabs || els.pbody);
    if (window.ResizeObserver) new ResizeObserver(layoutHouse).observe(house.wrap);
    window.addEventListener('resize', layoutHouse);
  }
  function refreshHouse() {
    if (!house.built) return;
    const A = window.HouseArt, items = houseItems();
    const meta = window.UI && UI.panelTabs ? UI.panelTabs() : null;
    house.state = A.houseState((window.Engine && Engine.state) || {});
    A.DRAW_ORDER.forEach(function (key) {
      const b = house.hots[key], p = A.PLACES[key];
      const it = items.filter(function (x) { return x.key === key; })[0];
      const lk = !it;   // 后台关掉的子项不会出现在页签清单里
      b.classList.toggle('locked', lk);
      b.classList.toggle('active', !!(house.drawer && meta && meta.active === key));
      b.querySelector('.h-sign').textContent = (lk ? '🔒 ' : p.icon + ' ') + p.name;
      let bd = b.querySelector('.h-badge');
      const badge = (it && it.badge) || (key === 'yard' && house.state.houseFull ? '!' : '');
      if (badge && !lk) { if (!bd) { bd = document.createElement('span'); bd.className = 'h-badge'; b.appendChild(bd); } bd.textContent = badge; }
      else if (bd) bd.remove();
      b.setAttribute('aria-label', '渔屋 · ' + p.name + (lk ? '，暂未开放' : '') + (badge && !lk ? '，有提醒' : ''));
    });
    house.layerKey = '';
  }
  function layoutHouse() {
    if (!house.built || !house.wrap.offsetParent) return;
    const A = window.HouseArt, r = house.wrap.getBoundingClientRect();
    if (!r.width || !r.height) return;
    // 整幅放进可用区域（像素画按 pixelated 放大），抽屉叠在右侧，不挤压画面
    const s = Math.max(.5, Math.min(r.width / A.W, r.height / A.H));
    house.world.style.width = Math.floor(A.W * s) + 'px'; house.world.style.height = Math.floor(A.H * s) + 'px';
    if (els.panel) els.panel.style.setProperty('--h-house-top', house.wrap.offsetTop + 'px');
  }
  function housePeriod() {
    const ps = window.PlayerSettings && PlayerSettings.get ? PlayerSettings.get() : {};
    return ps.timeMode && ps.timeMode !== 'clock' && META[ps.timeMode] ? ps.timeMode : nowInfo().id;
  }
  function drawHouse(ts) {
    const A = window.HouseArt; if (!A || !house.built) return;
    const period = housePeriod(), P = A.PAL[period] || A.PAL.night;
    if (house.layerKey !== period) { house.layers = A.makeLayers(P, house.state); house.layerKey = period; }
    const still = motionOff();
    if (still && ts - house.lastStill < 20000 && house.layerKey === period && house.drawnOnce && !house.hover) return;
    if (still) house.lastStill = ts;
    house.drawnOnce = true;
    A.drawFrame(house.ctx, house.layers, P, house.state, still ? 0 : ts / 1000, house.hover);
  }
  function houseOpen(key) {
    if (!house.built) return;
    if (house.hots[key] && house.hots[key].classList.contains('locked')) {
      toastMsg('🔒 「' + window.HouseArt.PLACES[key].name + '」暂未开放'); return;
    }
    house.drawer = true; house.lastKey = key;
    const meta = window.UI && UI.panelTabs ? UI.panelTabs() : null;
    if (!meta || meta.active !== key) { if (window.UI && UI.panelTab) UI.panelTab(key); }
    showPlace('character');
  }
  function houseCloseDrawer() {
    house.drawer = false;
    if (statePlace === 'character') showPlace('character');
  }

  function buildScene() {
    if (scene.built || !els.scene || !art()) return;
    const A = art();
    scene.built = true;
    els.scene.innerHTML = '';
    scene.pan = document.createElement('div'); scene.pan.className = 'h-pan';
    scene.pan.tabIndex = 0;
    scene.pan.setAttribute('aria-label', '港湾全景，可左右滚动查看两岸');
    scene.pan.addEventListener('wheel', function (event) {
      if (!els.scene.classList.contains('h-cover') || Math.abs(event.deltaX) >= Math.abs(event.deltaY)) return;
      scene.pan.scrollLeft += event.deltaY;
      event.preventDefault();
    }, { passive: false });
    scene.world = document.createElement('div'); scene.world.className = 'h-world';
    scene.cv = document.createElement('canvas'); scene.cv.width = A.W; scene.cv.height = A.H;
    scene.cv.setAttribute('aria-hidden', 'true');
    scene.ctx = scene.cv.getContext('2d'); scene.ctx.imageSmoothingEnabled = false;
    scene.world.appendChild(scene.cv);
    // 建筑热区是真按钮，叠在画布上；画布本身对读屏隐藏。Tab 顺序按画面从左到右，最后是栈桥。
    SCENE_ORDER.forEach(function (id) {
      const p = A.PLACES[id], b = document.createElement('button');
      b.type = 'button'; b.className = 'h-hot' + (id === 'fishing' ? ' h-primary' : ''); b.dataset.place = id;
      b.style.left = (p.hot[0] / A.W * 100) + '%'; b.style.top = (p.hot[1] / A.H * 100) + '%';
      b.style.width = (p.hot[2] / A.W * 100) + '%'; b.style.height = (p.hot[3] / A.H * 100) + '%';
      b.innerHTML = '<span class="h-sign"></span>';
      b.addEventListener('mouseenter', function () { scene.hover = id; });
      b.addEventListener('mouseleave', function () { if (scene.hover === id) scene.hover = null; });
      b.addEventListener('focus', function () { scene.hover = id; });
      b.addEventListener('blur', function () { if (scene.hover === id) scene.hover = null; });
      b.addEventListener('click', function () { enterPlace(id, b); });
      scene.hots[id] = b; scene.world.appendChild(b);
    });
    scene.pan.appendChild(scene.world); els.scene.appendChild(scene.pan);
    window.addEventListener('resize', layoutScene);
    if (window.ResizeObserver) new ResizeObserver(layoutScene).observe(els.stage || els.scene);
    requestAnimationFrame(sceneLoop);
  }
  function enterPlace(id, from) {
    if (placeLocked(id)) { toastMsg('🔒 「' + PLACES[id].name + '」暂未开放'); return; }
    // v3 F3：告示板（board）的 view 为 null，openPlace 对它单独处理；其余地点传 view id
    var placeId = (id === 'board') ? 'board' : PLACES[id].view;
    openPlace(placeId);
  }
  function toastMsg(t) { if (window.UI && UI.toast) UI.toast(t); }
  function layoutScene() {
    if (!scene.built || !on) return;
    const A = art();
    // 量宿主 #h-stage 而不是 #h-scene：罗盘首页与内景面板都会把 #h-scene 设成 display:none，
    // 那时量它只会拿到 0×0 而在开头就 return，手机 ↔ 桌面切换再也不会重新布局。
    const r = (els.stage || els.scene).getBoundingClientRect();
    if (!r.width || !r.height) return;
    scene.phone = r.width <= 640;
    const ps = window.PlayerSettings && PlayerSettings.get ? PlayerSettings.get() : {};
    const motion = window.PlayerSettings && PlayerSettings.motion ? PlayerSettings.motion() : 'full';
    // 罗盘首页：手机布局设为「compass」，或「auto」且动效关闭/减少（省电）
    const wantCompass = scene.phone && (ps.mobile === 'compass' || (ps.mobile !== 'panorama' && (motion === 'reduced' || motion === 'off')));
    els.root.classList.toggle('h-compass-home', wantCompass);
    // 桌面铺满可用空间；比例不同时通过左右滚动看岸边，避免整幅缩小后上下留白。
    // 手机仍用整数倍横向浏览，保留触摸拖动。
    const cover = Math.max(r.width / A.W, r.height / A.H);
    const s = scene.phone ? Math.max(1, Math.floor(r.height / A.H)) : Math.max(1, Math.ceil(cover * 4) / 4);
    const first = !scene.scale;
    const scaleChanged = s !== scene.scale;
    const oldRange = Math.max(0, scene.pan.scrollWidth - scene.pan.clientWidth);
    const oldPosition = oldRange ? scene.pan.scrollLeft / oldRange : .52;
    if (scaleChanged) {
      scene.scale = s;
      scene.world.style.width = A.W * s + 'px'; scene.world.style.height = A.H * s + 'px';
      scene.world.style.setProperty('--h-scene-scale', String(s));
    }
    els.scene.classList.toggle('h-phone', scene.phone);
    const cropped = A.W * s > r.width + 1;
    els.scene.classList.toggle('h-cover', !scene.phone && cropped);
    const panHint = els.stage && els.stage.querySelector('.h-pan-hint');
    if (panHint) panHint.textContent = scene.phone ? '← 左右滑动浏览港湾 →' : '← 鼠标滚轮浏览港岸两侧 →';
    if (cropped && !wantCompass && (first || scaleChanged || oldRange === 0)) {
      scene.pan.scrollLeft = Math.max(0, A.W * s - r.width) * oldPosition;
    }
    // 罗盘首页：把场景条带画进 #h-strip（如果存在）
    if (wantCompass && els.strip && scene.cv) {
      const sc = els.strip.getContext('2d');
      sc.imageSmoothingEnabled = false;
      sc.clearRect(0, 0, els.strip.width, els.strip.height);
      // 截取场景中段 (y=60..180) 作为条带
      sc.drawImage(scene.cv, 0, 60, A.W, 120, 0, 0, els.strip.width, els.strip.height);
    }
  }
  function refreshScene() {
    if (!scene.built) return;
    // v3 F1：建筑招牌悬停模式（设置 › 建筑招牌）。放在指纹提前返回之前，设置一改就生效。
    const prefs = window.PlayerSettings && PlayerSettings.get ? PlayerSettings.get() : {};
    if (els.scene) els.scene.classList.toggle('signs-hover', prefs.signs === 'hover');
    // 签名同时包含徽标：状态（如未读邮件数）可能先于 #nav 重建变化，徽标晚一拍才出现
    const s = sceneState(), badges = SCENE_ORDER.map(placeBadge).join('|'), sig = JSON.stringify(s) + badges;
    if (sig === scene.stateSig) return;
    const artChanged = JSON.stringify(s) !== JSON.stringify(scene.state);
    scene.state = s; scene.stateSig = sig; if (artChanged) scene.layerKey = '';
    SCENE_ORDER.forEach(function (id) {
      const b = scene.hots[id], badge = placeBadge(id), lk = !!s.locked[id], st = placeStatus(id, s);
      b.classList.toggle('locked', lk);
      b.querySelector('.h-sign').textContent = (lk ? '🔒 ' : PLACES[id].icon + ' ') + PLACES[id].name;
      let bd = b.querySelector('.h-badge');
      if (badge && !lk) { if (!bd) { bd = document.createElement('span'); bd.className = 'h-badge'; b.appendChild(bd); } bd.textContent = badge; }
      else if (bd) bd.remove();
      b.setAttribute('aria-label', PLACES[id].name + '：' + PLACES[id].desc + (st ? '。' + st : '') + (badge && !lk ? '（有 ' + badge + ' 条提醒）' : ''));
    });
    buildHomeTiles();
    drawScene(performance.now(), true);
  }
  function drawScene(ts, force) {
    const A = art(); if (!A || !scene.state) return;
    const as = artSettings();
    const ps = window.PlayerSettings && PlayerSettings.get ? PlayerSettings.get() : {};
    const fixed = ps.timeMode && ps.timeMode !== 'clock' ? ps.timeMode : null;
    let m, pal;
    if (fixed) {
      m = A.sampleMinute(fixed, as);
      pal = { P: A.PAL[fixed], period: fixed, key: fixed };
    } else {
      const d = new Date(); m = d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60;
      pal = A.paletteAt(m, as);
    }
    let avatarKey = '';
    try {
      const look = JSON.parse(localStorage.getItem('fishing_char_v2') || '{}');
      avatarKey = [look.model || 'lilac', look.hat || 'orange', look.outfit || 'green', look.skin || 'light'].join('/');
    } catch (_) { /* 保留默认形象 */ }
    const key = pal.key + '|' + scene.stateSig + '|' + avatarKey;
    if (key !== scene.layerKey) { scene.layers = A.makeLayers(pal.P, scene.state); scene.layerKey = key; force = true;
      // 画布外的留白用同一时段的天空 / 海面色补齐，桌面整数倍缩放放不满时不会露出一圈黑边
      scene.pan.style.background = 'linear-gradient(' + pal.P.sky[0] + ' 0%,' + pal.P.sky[3] + ' 49%,' + pal.P.sea[0] + ' 49%,' + pal.P.sea[3] + ' 100%)';
    }
    const still = motionOff();
    // 减少 / 关闭动效：只在状态或时段变了、或每 20 秒（日月位置）重画一帧
    if (still && !force && ts - scene.lastStill < 20000) return;
    if (still) scene.lastStill = ts;
    A.drawFrame(scene.ctx, scene.layers, pal.P, scene.state, still ? 0 : ts / 1000, m, as, scene.hover);
  }
  function sceneLoop(ts) {
    requestAnimationFrame(sceneLoop);
    // 渔屋内景：港湾画面收起，改画屋内（同样 12 帧 / 秒）
    if (on && !document.hidden && houseMode() && ts - house.lastFrame >= 83) { house.lastFrame = ts; drawHouse(ts); return; }
    // 12 帧 / 秒就够像素画用；页面隐藏、没接管港湾、或正在看内景（场景被收起）时整个跳过
    if (!on || document.hidden || statePlace || ts - scene.lastFrame < 83) return;
    scene.lastFrame = ts;
    drawScene(ts, !!scene.hover);
    // 罗盘首页：每帧把场景条带刷进 #h-strip
    if (els.root && els.root.classList.contains('h-compass-home') && els.strip && scene.cv) {
      const A = art(), sc = els.strip.getContext('2d');
      sc.imageSmoothingEnabled = false;
      sc.clearRect(0, 0, els.strip.width, els.strip.height);
      sc.drawImage(scene.cv, 0, 60, A.W, 120, 0, 0, els.strip.width, els.strip.height);
    }
  }

  // ---- 罗盘首页磁贴（阶段 D：手机罗盘首页布局） ----
  function buildHomeTiles() {
    const tiles = els.homeTiles; if (!tiles) return;
    tiles.innerHTML = '';
    menuIds().forEach(function (id) {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'h-home-tile' + (navLocked(id) ? ' locked' : '');
      const badge = navBadge(id), status = placeStatus(id, scene.state || {});
      b.innerHTML = navIcon(id) + '<span class="h-home-name">' + placeName(id) + '</span>' +
        (status ? '<span class="h-home-status">' + status + '</span>' : '') +
        (badge && !navLocked(id) ? '<i class="h-badge">' + badge + '</i>' : '');
      b.setAttribute('aria-label', placeName(id) + (status ? '，' + status : '') + (badge && !navLocked(id) ? '，有 ' + badge + ' 条提醒' : '') + (navLocked(id) ? '，暂未开放' : ''));
      b.addEventListener('click', function () { enterPlace(id, b); });
      tiles.appendChild(b);
    });
  }
  // 条目与数字键顺序都按后台 featureOrder.menu（与目录一致），WIKI 仍新开标签。
  function menuIds() {
    const st = (window.Engine && window.Engine.state) || {};
    const ids = window.GameFeatures && GameFeatures.orderedMenu ? GameFeatures.orderedMenu((st.featureOrder || {}).menu) : placeIds();
    return ids.filter(isPlace);
  }
  function navIcon(id) {
    const n = D && D.NAV && D.NAV.find(function (x) { return x.id === id; });
    return '<img src="assets/nav/' + id + '.png" alt="" draggable="false" onerror="this.replaceWith(document.createTextNode(\'' + (n ? n.icon : '•') + '\'))">';
  }
  function buildCompass() {
    const ring = els.ring; if (!ring) return;
    ring.querySelectorAll('button').forEach(function (b) { b.remove(); });
    const ids = menuIds();
    ids.forEach(function (id, i) {
      const a = -Math.PI / 2 + i * 2 * Math.PI / ids.length, b = document.createElement('button');
      b.type = 'button'; b.className = 'h-cmp-item' + (navLocked(id) ? ' locked' : '');
      b.style.left = (50 + Math.cos(a) * 39) + '%'; b.style.top = (50 + Math.sin(a) * 39) + '%';
      const key = i < 10 ? String((i + 1) % 10) : '';
      const badge = navBadge(id);
      b.innerHTML = (key ? '<kbd>' + key + '</kbd>' : '') + navIcon(id) + '<span>' + placeName(id) + '</span>' + (badge ? '<i class="h-badge">' + badge + '</i>' : '');
      b.setAttribute('aria-label', placeName(id) + (key ? '，快捷键 ' + key : '') + (badge ? '，有 ' + badge + ' 条提醒' : '') + (navLocked(id) ? '，暂未开放' : ''));
      b.addEventListener('click', function () { closeOverlays(); openPlace(id); });
      ring.appendChild(b);
    });
  }
  function openCompass() {
    closeOverlays(); buildCompass();
    returnFocusOverlay = document.activeElement;
    els.compass.hidden = false;
    const first = els.ring.querySelector('button'); if (first) first.focus();
  }
  // v3 F3：告示板改用内景面板；overlayOpen 只检查罗盘
  let returnFocusOverlay = null;
  function overlayOpen() { return !!(els.compass && !els.compass.hidden); }
  function closeOverlays() {
    const was = overlayOpen();
    if (els.compass) els.compass.hidden = true;
    if (was && returnFocusOverlay && returnFocusOverlay.isConnected && returnFocusOverlay.offsetParent) returnFocusOverlay.focus();
    returnFocusOverlay = null;
    return was;
  }

  // v3 F2：稀有度庆祝动画
  const RC = { rare: 'var(--r-rare,#38bdf8)', epic: 'var(--r-epic,#ffd24a)', mythic: 'var(--r-mythic,#c084fc)' };
  function reward(imgSrc, name, rarity, text) {
    if (!RC[rarity]) return; // 普通钓获不弹动画
    const fl = els.flash; if (!fl) return;
    fl.style.setProperty('--fc', RC[rarity]);
    const img = document.getElementById('h-flash-img');
    const nameEl = document.getElementById('h-flash-name');
    const tierEl = document.getElementById('h-flash-tier');
    if (img) { img.src = imgSrc; img.alt = name; }
    if (nameEl) { nameEl.textContent = name; nameEl.className = 'h-flash-name rc-' + rarity; }
    if (tierEl) tierEl.textContent = { rare: '稀有', epic: '史诗', mythic: '神话' }[rarity] + ' · ' + text;
    fl.style.display = '';
    fl.classList.remove('h-flash-go'); void fl.offsetWidth; fl.classList.add('h-flash-go');
    fl.addEventListener('animationend', function handler() { fl.style.display = 'none'; fl.classList.remove('h-flash-go'); fl.removeEventListener('animationend', handler); });
    fl.onclick = function () { fl.style.display = 'none'; fl.classList.remove('h-flash-go'); };
  }

  // ---- 外壳搬移 ----
  function moveTo(node, host) { if (node && host && node.parentNode !== host) host.appendChild(node); }
  // 顶栏状态块的还原位置：当初它在 .topbar 里排在 .topbar-actions 之前，
  // 用 appendChild 直接放回去会跑到最右边，所以记住它后面的那个兄弟节点。
  function moveBefore(node, host, next) {
    if (!node || !host) return;
    if (node.parentNode === host && node.nextSibling === (next || null)) return;
    host.insertBefore(node, next && next.parentNode === host ? next : null);
  }
  function apply() {
    if (!els || !els.root) return;
    // v4 F5：enabled() 已移除，直接用 authed()（harbor 是唯一主题）
    const want = authed();
    const changed = want !== on;
    on = want;
    document.body.classList.toggle('harbor-on', on);
    els.root.hidden = !on;
    if (!on) {
      if (originMain) moveTo(els.main, originMain);
      if (originStatus) moveBefore(els.status, originStatus, originStatusNext);
      if (els.panel) els.panel.hidden = true;
      if (els.dirbox) els.dirbox.hidden = true;
      closeOverlays();
      statePlace = null;
      return;
    }
    // Phase G：#nav 已从 index.html 移除，目录列表改为直接渲染到 #h-dir-body；
    // #main 仍然在 #h-pbody 里，render* 不用改。
    moveTo(els.main, els.pbody);
    moveTo(els.status, els.statusSlot);
    buildScene();
    // 设置变化（手机布局 / 动效 / 界面风格）也要立刻重排，不能等到下一次 resize
    requestAnimationFrame(layoutScene);
    refreshScene();
    paintTime();
    syncHud();
    // v2 阶段 F：页面重绘（renderView → syncView）后同步挂签的清单与选中态
    if (statePlace) buildPanelTabs();
    if (changed) route();
    else if (statePlace === null && els.dirbox) els.dirbox.hidden = !dirOpen;
  }

  function init() {
    if (els) return;
    els = {
      root: $('harbor'), scene: $('h-scene'), main: $('main'), status: $('player-status'),
      stage: $('h-stage'),
      statusSlot: $('h-status'), tchip: $('h-tchip'), ticon: document.querySelector('#h-tchip .h-ticon'),
      tlabel: document.querySelector('#h-tchip .h-tlabel'), cast: $('h-cast'), castSub: $('h-cast-sub'),
      dir: $('h-dir'), set: $('h-set'), bag: $('h-bag'), panel: $('h-panel'), back: $('h-back'),
      close: $('h-close'), title: $('h-p-title'), crumb: $('h-p-crumb'), pbody: $('h-pbody'),
      tabs: $('h-tabs'),
      dirbox: $('h-dirbox'), dirClose: $('h-dir-close'), dirBody: $('h-dir-body'),
      compassBtn: $('h-compass-btn'), compass: $('h-compass'), ring: $('h-ring'),
      // Phase G：#nav 从 index.html 移除，目录改为 renderNav 直接写到 #h-dir-body
      home: $('h-home'), strip: $('h-strip'), homeTiles: $('h-home-tiles'),
      ticker: $('h-ticker'), flash: $('h-flash'),
    };
    if (!els.root) return;
    originMain = els.main ? els.main.parentNode : null;
    originStatus = els.status ? els.status.parentNode : null;
    originStatusNext = els.status ? els.status.nextSibling : null;

    if (els.tchip) els.tchip.addEventListener('click', function () { if (window.PlayerSettings) PlayerSettings.open(); });
    if (els.set) els.set.addEventListener('click', function () { if (window.PlayerSettings) PlayerSettings.open(); });
    if (els.dir) els.dir.addEventListener('click', function () { closeOverlays(); showDir(true); });
    if (els.dirClose) els.dirClose.addEventListener('click', function () { showDir(false); });
    if (els.dirbox) els.dirbox.addEventListener('keydown', function (ev) {
      if (ev.key !== 'Tab') return;
      const focusable = dirFocusable();
      if (!focusable.length) return;
      if (ev.shiftKey && document.activeElement === focusable[0]) {
        ev.preventDefault(); focusable[focusable.length - 1].focus();
      } else if (!ev.shiftKey && document.activeElement === focusable[focusable.length - 1]) {
        ev.preventDefault(); focusable[0].focus();
      }
    });
    if (els.compassBtn) els.compassBtn.addEventListener('click', openCompass);
    // v3 F3：board 浮层已移除，只保留罗盘的 overlay click-outside
    if (els.compass) els.compass.addEventListener('click', function (ev) { if (ev.target === els.compass) closeOverlays(); });
    if (els.bag) els.bag.addEventListener('click', function () { openPlace('inventory'); });
    if (els.cast) els.cast.addEventListener('click', function () { openPlace('fishing'); });
    // 渔屋抽屉打开时「回屋里」只收抽屉；其余情况回港湾
    if (els.back) els.back.addEventListener('click', function () { if (houseMode() && house.drawer) { houseCloseDrawer(); return; } showHome(); setHash('#/'); });
    if (els.close) els.close.addEventListener('click', function () { showHome(); setHash('#/'); });
    // v2 阶段 F：内景一级页签（挂签）点击 —— 页签清单由 ui.js 的 UI.panelTab 提供，
    // 外壳不关心具体是哪个页面，只把 key 转回去并同步选中态。
    if (els.tabs) els.tabs.addEventListener('click', function (ev) {
      const b = ev.target.closest('[data-tabkey]');
      if (!b || !window.UI || !UI.panelTab) return;
      const key = b.dataset.tabkey;
      const place = statePlace;
      UI.panelTab(key);
      if (key === 'wiki') { closeOverlays(); return; }
      if (place) setHash('#/' + place + '/' + tabIndexOf(key));
      buildPanelTabs(place);
    });
    // 设计稿 §11 / §7：内景面板里 Tab 焦点循环（焦点陷阱）
    if (els.panel) els.panel.addEventListener('keydown', function (ev) {
      if (ev.key !== 'Tab') return;
      const focusable = Array.prototype.slice.call(
        els.panel.querySelectorAll('button, input, select, textarea, [tabindex]')
      ).filter(function (x) { return !x.disabled && x.offsetParent !== null; });
      if (!focusable.length) return;
      if (ev.shiftKey && document.activeElement === focusable[0]) {
        focusable[focusable.length - 1].focus(); ev.preventDefault();
      } else if (!ev.shiftKey && document.activeElement === focusable[focusable.length - 1]) {
        focusable[0].focus(); ev.preventDefault();
      }
    });

    // HUD 顶部的状态块（位置 / 在线 / 金币…）来自 ui.js 的 renderTopbar，点击原本只切后台页面；
    // 港湾里页面藏在面板后面，不接管的话点一下看着毫无反应。这里在捕获阶段把它改成「打开对应内景」，
    // 并用 stopPropagation 阻止 ui.js 自己的那套跳转（否则会白渲染一次、多拉一次数据）。
    const VIEW_PLACE = { bd: 'character', records: 'codex', shop: 'mall', market: 'mall', trade: 'ground' };
    if (els.status) els.status.addEventListener('click', function (ev) {
      if (!on) return;
      const chip = ev.target.closest && ev.target.closest('[data-view]');
      const view = chip && chip.getAttribute('data-view');
      if (!view) return;
      const id = VIEW_PLACE[view] || view;
      if (!isPlace(id)) return;
      ev.preventDefault(); ev.stopPropagation();
      openPlace(id);
    }, true);

    // Phase G：目录列表直接渲染到 #h-dir-body，不再搬移 #nav；
    // 监听 #h-dir-body 里的导航项点击，把页面切到内景面板。
    if (els.dirBody) els.dirBody.addEventListener('click', function (ev) {
      const item = ev.target.closest && ev.target.closest('.nav-item');
      if (!item || item.classList.contains('nav-more')) return;
      const id = item.getAttribute('data-feature') || '';
      if (!isPlace(id)) return;
      setTimeout(function () { if (window.UI && UI.getView() === id) showPlace(id); }, 0);
    });

    document.addEventListener('keydown', function (ev) {
      if (!on) return;
      const t = ev.target;
      if (t && (t.closest && t.closest('input, textarea, select, [contenteditable]'))) return;
      if (ev.key === 'Escape') {
        // 交易窗口 / 确认框 / 设置对话框叠在内景上时，Esc 归它们处理，不能顺手把底下的内景也关掉
        if (document.querySelector('dialog[open], .modal-overlay')) return;
        if (closeOverlays()) return;
        if (dirOpen) { showDir(false); return; }
        if (houseMode() && house.drawer) { houseCloseDrawer(); return; }
        if (statePlace) { showHome(); setHash('#/'); }
        return;
      }
      // L = 目录（列表模式）。设计稿 §7 的罗盘与数字快捷键属于阶段 B，这里先只给列表。
      if (document.querySelector('dialog[open], .modal-overlay') || ev.ctrlKey || ev.metaKey || ev.altKey) return;
      // C = 罗盘，数字键 1–9、0 = 按后台菜单顺序直达前 10 个入口（设计稿 §7）
      if (ev.key === 'c' || ev.key === 'C') { if (overlayOpen()) closeOverlays(); else openCompass(); ev.preventDefault(); return; }
      // 渔屋内景：1–5 直达屋内物件（晒场 / 繁育 / 宠物 / 角色 / 钓竿）
      if (houseMode() && /^[1-5]$/.test(ev.key)) { houseOpen(window.HouseArt.DRAW_ORDER[+ev.key - 1]); ev.preventDefault(); return; }
      if (/^[0-9]$/.test(ev.key)) {
        const ids = menuIds(), i = ev.key === '0' ? 9 : +ev.key - 1;
        if (ids[i]) { closeOverlays(); showDir(false); openPlace(ids[i]); ev.preventDefault(); }
        return;
      }
      if (ev.key === 'l' || ev.key === 'L') {
        closeOverlays(); showDir(true); ev.preventDefault(); return;
      }
      // F = 出海钓鱼（设计稿 §7）
      if (ev.key === 'f' || ev.key === 'F') {
        closeOverlays(); showDir(false); openPlace('fishing'); ev.preventDefault();
      }
    });
    window.addEventListener('hashchange', onHashChange);
    window.addEventListener('playersettingschange', function () { apply(); });
    document.addEventListener('visibilitychange', function () { if (!document.hidden) paintTime(); });
    setInterval(paintTime, 30000);   // 时间牌跨时段时自更新；30 秒一次，代价可以忽略

    apply();
  }

  return {
    init: init,
    syncShell: apply, syncHud: syncHud, syncView: apply, syncNav: apply, syncScene: function () { if (on) refreshScene(); },
    openPlace: openPlace, goHome: function () { showHome(); setHash('#/'); },
    // v3 F2：稀有 / 史诗 / 神话钓获的全屏庆祝动画（net.js 的 catchReward 钩子调用）。
    // 「钓获特效」开关只在这里判断一次：ui.js / net.js 的调用方不再各自把关，避免漏判。
    catchReward: function (payload) {
      if (!payload) return;
      const ps = window.PlayerSettings;
      if (ps && ps.get && ps.get().catchFlash === 'off') return;
      reward(payload.img, payload.name, payload.rarity, payload.text);
    },
    periodAt: periodAt, current: nowInfo, label: label,
    isOn: function () { return on; },
    sceneState: sceneState, openCompass: openCompass, closeOverlays: closeOverlays,
    defaults: DEFAULTS,
  };
})();

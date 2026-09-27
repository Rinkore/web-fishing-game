/*
 * DeepFish 港湾外壳（设计稿 v2 · 阶段 A）
 * 阶段 A 交付：HUD、内景面板（承载既有 #main，render* 不改）、目录列表模式、路由与设置。
 * 场景美术 / 建筑热区 / 罗盘属于阶段 B：stage A 的港湾首页是纯色占位场景 + 目录列表。
 * 设计稿见 output/design-review/redesign/v2/index.html §13；本文件只做「外壳」，
 * 页面内容一律仍由 ui.js 的 render* 渲染，二者通过 ui.js 的 harborHook / UI.openView 通信。
 */
window.HarborShell = (function () {
  'use strict';
  const D = window.GameData;
  // v2 评审（2026-09-27）定稿的默认值 —— 阶段 B/C/D 一律从这里取，不要再各处写字面量。
  const DEFAULTS = {
    theme: 'classic',        // 阶段 A–D 默认经典；阶段 E 才默认港湾
    timeMode: 'clock',       // 跟随本地时间（固定模式由玩家显式切换）
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
  function starts() { return ORDER.map(function (id) { return toMin(DEFAULTS.periods[id]); }); }
  // 给定当天分钟数，返回所处时段；过渡窗口以每个时段开始时间为中心（blend / 2 分钟）。
  // 返回 { id, name, icon, minute, startMin, blend: [fromId, toId] | null }。
  function periodAt(minute) {
    const m = ((Math.round(minute) % 1440) + 1440) % 1440;
    const st = starts();
    const half = DEFAULTS.blend / 2;
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
  let els = null, originMain = null, originNav = null, originStatus = null, originStatusNext = null;
  let on = false, statePlace = null, dirOpen = true, suppressHash = false, returnFocus = null;

  function theme() {
    const ps = window.PlayerSettings;
    return (ps && ps.get && ps.get().theme) || DEFAULTS.theme;
  }
  // 登录后 ui.js 会把 #auth 的 display 设为 none；未登录（含启动瞬间）不接管外壳。
  function authed() { const a = $('auth'); return !!a && a.style.display === 'none'; }
  function enabled() { return theme() === 'harbor' && authed(); }
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
  function hashPlace() {
    const m = /^#\/([a-z]+)$/.exec(location.hash || '');
    return m ? m[1] : '';
  }

  // ---- HUD ----
  function paintTime() {
    if (!els || !els.ticon) return;
    const info = nowInfo();
    els.ticon.textContent = info.icon;
    els.tlabel.textContent = label(info);
    els.tchip.setAttribute('aria-label', '港湾时间：' + label(info) + '，打开设置');
    els.tchip.setAttribute('title', '港湾时间：' + info.icon + ' ' + info.name + '（阶段 C 起可自定义时段与过渡）');
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
  }

  // ---- 目录 / 内景面板 ----
  function showDir(flag) {
    dirOpen = flag;
    if (els.dirbox) els.dirbox.hidden = !(on && flag);
    if (els.root) els.root.classList.toggle('dir-open', !!flag);
  }
  function showHome() {
    // 焦点还回进来之前的入口；目录/入口此刻可能已经隐藏（offsetParent 为空），那就落到「出海钓鱼」。
    if (statePlace) {
      const back = returnFocus && returnFocus.isConnected && returnFocus.offsetParent ? returnFocus : els.cast;
      if (back) back.focus();
    }
    returnFocus = null;
    statePlace = null;
    if (els.panel) els.panel.hidden = true;
    if (els.root) els.root.classList.add('home');
    showDir(true);
  }
  function showPlace(id) {
    if (!on) return;
    // 记住进来之前焦点在哪（目录里的入口 / HUD 按钮），回港湾时还回去（设计稿 §11）。
    if (!statePlace) returnFocus = document.activeElement;
    statePlace = id;
    if (els.root) els.root.classList.remove('home');
    if (els.panel) els.panel.hidden = false;
    if (els.title) els.title.textContent = placeName(id);
    if (els.crumb) els.crumb.textContent = '港湾 › ' + placeName(id);
    showDir(false);
    setHash('#/' + id);
    if (els.back) els.back.focus();   // 设计稿 §7：打开内景后焦点落在「← 回港湾」
  }
  function openPlace(id) {
    if (!isPlace(id)) return false;
    if (!window.UI || !window.UI.openView) return false;
    let ok = false;
    try { ok = window.UI.openView(id) !== false; } catch (e) { ok = false; }
    if (!ok) return false;
    if (id === 'wiki') return true;        // 同域资料站：新标签打开，不切外壳
    showPlace(id);
    return true;
  }

  // ---- 路由 ----
  function route() {
    if (!on) return;
    const id = hashPlace();
    if (id && isPlace(id)) { if (statePlace !== id) openPlace(id); }
    else if (statePlace) showHome();
    else { showHome(); setHash('#/'); }
  }
  function onHashChange() {
    if (suppressHash) { suppressHash = false; return; }
    route();
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
    const want = enabled();
    const changed = want !== on;
    on = want;
    document.body.classList.toggle('harbor-on', on);
    els.root.hidden = !on;
    if (!on) {
      if (originMain) moveTo(els.main, originMain);
      if (originNav) moveTo(els.nav, originNav);
      if (originStatus) moveBefore(els.status, originStatus, originStatusNext);
      if (els.panel) els.panel.hidden = true;
      if (els.dirbox) els.dirbox.hidden = true;
      statePlace = null;
      return;
    }
    // 阶段 A：目录列表直接复用真正的 #nav（renderNav 仍是唯一的导航渲染器），
    // 内景面板直接复用 #main，所以既有 render* 一行都不用改。
    moveTo(els.nav, els.dirBody);
    moveTo(els.main, els.pbody);
    moveTo(els.status, els.statusSlot);
    paintTime();
    syncHud();
    if (changed) route();
    else if (statePlace === null && els.dirbox) els.dirbox.hidden = !dirOpen;
  }

  function init() {
    if (els) return;
    els = {
      root: $('harbor'), scene: $('h-scene'), nav: $('nav'), main: $('main'), status: $('player-status'),
      statusSlot: $('h-status'), tchip: $('h-tchip'), ticon: document.querySelector('#h-tchip .h-ticon'),
      tlabel: document.querySelector('#h-tchip .h-tlabel'), cast: $('h-cast'), castSub: $('h-cast-sub'),
      dir: $('h-dir'), set: $('h-set'), bag: $('h-bag'), panel: $('h-panel'), back: $('h-back'),
      close: $('h-close'), title: $('h-p-title'), crumb: $('h-p-crumb'), pbody: $('h-pbody'),
      dirbox: $('h-dirbox'), dirClose: $('h-dir-close'), dirBody: $('h-dir-body'),
    };
    if (!els.root) return;
    originMain = els.main ? els.main.parentNode : null;
    originNav = els.nav ? els.nav.parentNode : null;
    originStatus = els.status ? els.status.parentNode : null;
    originStatusNext = els.status ? els.status.nextSibling : null;

    if (els.tchip) els.tchip.addEventListener('click', function () { if (window.PlayerSettings) PlayerSettings.open(); });
    if (els.set) els.set.addEventListener('click', function () { if (window.PlayerSettings) PlayerSettings.open(); });
    if (els.dir) els.dir.addEventListener('click', function () { showDir(true); });
    if (els.dirClose) els.dirClose.addEventListener('click', function () { if (statePlace) showDir(false); });
    if (els.bag) els.bag.addEventListener('click', function () { openPlace('inventory'); });
    if (els.cast) els.cast.addEventListener('click', function () { openPlace('fishing'); });
    if (els.back) els.back.addEventListener('click', function () { showHome(); setHash('#/'); });
    if (els.close) els.close.addEventListener('click', function () { showHome(); setHash('#/'); });

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

    // 目录里的导航项就是真正的 #nav 节点（renderNav 渲染），沿用它的既有点击行为，
    // 这里只在外壳层面把页面切到内景面板。
    if (els.nav) els.nav.addEventListener('click', function (ev) {
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
        if (dirOpen && statePlace) { showDir(false); return; }
        if (statePlace) { showHome(); setHash('#/'); }
        return;
      }
      // L = 目录（列表模式）。设计稿 §7 的罗盘与数字快捷键属于阶段 B，这里先只给列表。
      if (ev.key === 'l' || ev.key === 'L') {
        if (document.querySelector('dialog[open], .modal-overlay')) return;   // 设置对话框 / 弹窗打开时不抢键
        showDir(true); ev.preventDefault();
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
    syncShell: apply, syncHud: syncHud, syncView: apply, syncNav: apply,
    openPlace: openPlace, goHome: function () { showHome(); setHash('#/'); },
    periodAt: periodAt, current: nowInfo, label: label,
    isOn: function () { return on; },
    defaults: DEFAULTS,
  };
})();

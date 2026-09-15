/*
 * 网页钓鱼小游戏 - UI 渲染与交互
 * 视图：钓鱼 / 钓竿配置 / 渔场动态 / 背包 / 系统商店 / 开放市集 / 在线交易 / 鱼类图鉴 / 渔获记录
 */
window.UI = (function () {
  'use strict';
  const D = window.GameData;
  // 版本号唯一来源是 data.js：把 index.html 的 <title> 与 [data-ver] 占位符填上。
  // 必须在下面 baseTitle 捕获标题之前执行，否则图标闪烁恢复时会用回不带版本号的旧标题。
  (function applyVersion() {
    const v = (D && D.VERSION) || '';
    if (!v) return;
    document.title = '钓鱼网站 ' + v;
    const nodes = document.querySelectorAll('[data-ver]');
    for (let i = 0; i < nodes.length; i++) nodes[i].textContent = v;
  })();
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
  // 词缀/增益名称：组件词缀走 AFFIX_LABEL，钓点增益多一类「大鱼概率」走 BUFF_LABEL
  function affixName(type) { return (D.AFFIX_LABEL[type]) || (D.BUFF_LABEL && D.BUFF_LABEL[type]) || type; }
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
  // 现价：优先系统商店行情，无行情时退回基准价（模块级，供各视图与子窗口共用）
  function unitPriceOf(id) { const s = S().shop && S().shop[id]; return s ? s.price : itemMeta(id).price; }
  // ---- 组件展示辅助 ----
  // 品质配色类（配色规范：普通=灰蓝 / 稀有=黄 / 史诗=紫 / 神话=彩虹，见 style.css 的 .q-*/.r-* 与 data.js QUALITY 注释）：
  // 组件满词条在背包/市集/装备弹窗升为金色；渔获用的是同一套品质（稀有/史诗），不再有「大鱼」档位配色与皇冠前缀。
  function qualityClass(meta) {
    if (!meta) return 'r-common';
    if (meta.kind === 'component' && meta.quality) {
      // 神话（宝匣专属）优先于「满词条」金色：否则突破件会和普通满词条史诗长得一样，玩家分不出来
      if (meta.quality === 'mythic') return 'q-mythic';
      return meta.isFull ? 'q-full' : ('q-' + meta.quality);
    }
    return rarityClass(meta.rarity);
  }
  // 组件词缀 span 的起始标签：池外词缀（宝匣突破件补足的、本部位本来没有的词缀）额外加 extra 标记
  function affSpanOpen(a) {
    return '<span class="inst-aff ' + (a.value < 0 ? 'neg' : 'pos') + (a.extra ? ' extra' : '') + '">';
  }
  // 词缀数值区间 [min,max]；池内走底材区间、池外走「池外词缀区间」表，都没有则返回 null（不显示区间）
  function affixRangeIn(meta, a) {
    const pool = ((meta && meta.pool) || []).find(function (p) { return p.type === a.type; });
    if (pool) return D.affixRangeOf ? D.affixRangeOf(meta.baseId, pool) : [pool.min, pool.max];
    return (a.extra && D.extraAffixRangeOf) ? D.extraAffixRangeOf(a.type) : null;
  }
  // 组件实例的状态标签：突破 > 满词条（突破件必然也满词条，但语义是「越过了词缀池边界」）
  function itemTag(meta) {
    if (!meta || meta.kind !== 'component') return '';
    if (meta.breakthrough) return '<span class="full-tag bt-tag">突破</span>';
    if (meta.isFull) return '<span class="full-tag">满词条</span>';
    return '';
  }
  // 品质名：渔获与组件共用同一套（普通 / 稀有 / 史诗 / 神话）；旧存档里可能残留的 'big' 兜底成「稀有」
  function qualityName(meta) {
    if (!meta) return '';
    if (meta.kind === 'component' && meta.qualityName) return meta.qualityName;
    const q = D.QUALITY && D.QUALITY[meta.rarity];
    if (q) return q.name;
    return meta.rarity === 'big' ? '稀有' : '普通';
  }
  // 单条词缀文案：+12% 钓速 / -5% 体型
  function affixText(a) { return (a.value > 0 ? '+' : '') + a.value + '% ' + (D.AFFIX_LABEL[a.type] || a.type); }
  // 底材词缀区间文案：+8 ~ +14
  function rangeText(p) { return (p.min > 0 ? '+' : '') + p.min + ' ~ ' + (p.max > 0 ? '+' : '') + p.max; }

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

  // ---- 顶部横幅：破纪录播报 + 管理后台公告队列共用同一滚动条 ----
  // 规则：等整段文字完整离开屏幕（一遍动画走完）后才收起；多条内容排队依次播放。
  // ---- 顶部横幅：两条独立轨道，互不打断 ----
  //  · 纪录轨（#record-banner）：纪录 / 最大鱼播报，**按到达顺序排队播放**，新的一条不会挤掉正在播的
  //  · 公告轨（#notice-banner）：管理后台公告，独立排队；支持每条自定义颜色（醒目度）
  //  两条轨道都会把页面整体下移（--banner-h），因此不会遮挡顶部状态栏。
  const BANNER_LANE_H = 34;
  function laneEl(lane) { return $(lane === 'notice' ? 'notice-banner' : 'record-banner'); }
  const lanes = {
    record: { queue: [], playing: false, timer: null, finish: null, runId: 0, current: null },
    notice: { queue: [], playing: false, timer: null, finish: null, runId: 0, current: null },
  };
  // 按底色自动选深/浅文字，保证任何自定义颜色都看得清
  function textColorFor(bg) {
    const m = /^#([0-9a-f]{6})$/i.exec(String(bg || ''));
    if (!m) return '';
    const n = parseInt(m[1], 16);
    const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    return (0.299 * r + 0.587 * g + 0.114 * b) > 150 ? '#06202e' : '#f8fafc';
  }
  // 各轨道的可见高度累计 → 页面下移量（避免遮挡顶部状态栏）
  // 轨道顺序（自上而下）：版本更新（update，最高优先级）→ 纪录 → 公告
  const UPDATE_LANE_H = 44;
  function syncBannerOffset() {
    const upd = $('update-banner'), rec = laneEl('record'), not = laneEl('notice');
    const updOn = !!(upd && upd.classList.contains('show'));
    const recOn = !!(rec && rec.classList.contains('show'));
    const notOn = !!(not && not.classList.contains('show'));
    let top = 0;
    if (upd) upd.style.top = '0px';
    if (updOn) top += UPDATE_LANE_H;
    if (rec) rec.style.top = top + 'px';
    if (recOn) top += BANNER_LANE_H;
    if (not) not.style.top = top + 'px';
    const h = (updOn ? UPDATE_LANE_H : 0) + (recOn ? BANNER_LANE_H : 0) + (notOn ? BANNER_LANE_H : 0);
    document.body.style.setProperty('--banner-h', h + 'px');
    document.body.classList.toggle('banner-open', h > 0);
  }

  // ---- 版本更新横幅（服务端升级通知，60 秒倒计时后自动切换） ----
  // 与公告轨无关：更新通知是时间敏感的运维事件，必须立刻显示、不能被排队等待。
  let updateTimer = null;
  let updateSig = '';   // 同一个更新任务只提示一次（/api/version 会周期性把状态带回来）
  function renderUpdateBanner() {
    const b = $('update-banner');
    if (!b) return;
    const u = S().update;
    if (!u || !u.active) {
      updateSig = '';
      b.classList.remove('show');
      b.innerHTML = '';
      if (updateTimer) { clearInterval(updateTimer); updateTimer = null; }
      syncBannerOffset();
      return;
    }
    const bat = u.bat || 'run.bat';
    function tick() {
      const now = Date.now();
      const left = Math.max(0, Math.round((u.endAt - now) / 1000));
      const phaseTxt = u.phase === 'restarting' ? '正在切换到新版本…'
        : (u.phase === 'grace' ? '更新通知已结束，5 秒后自动切换…' : '');
      b.innerHTML = '<span class="ub-icon">🔄</span>' +
        '<span class="ub-text">服务器即将更新到新版本（' + esc(bat) + '）' + (u.note ? '：' + esc(u.note) : '') + '</span>' +
        (phaseTxt ? '<span class="ub-count">' + esc(phaseTxt) + '</span>'
          : '<span class="ub-count">' + left + ' 秒后重启</span>') +
        '<span class="ub-hint">届时请稍候，页面会自动重连</span>';
    }
    b.classList.add('show');
    tick();
    if (updateTimer) clearInterval(updateTimer);
    updateTimer = setInterval(tick, 500);
    syncBannerOffset();
    const sig = bat + '@' + (u.startedAt || 0);
    if (sig !== updateSig) {
      updateSig = sig;
      toast('🔔 服务器即将更新：' + bat + '（自动重启，请稍候）');
      addLog('system', '🔄 服务器更新通知：' + bat + '，' + Math.round((u.endAt - Date.now()) / 1000) + ' 秒后自动重启切换版本');
    }
  }
  function onUpdate() { renderUpdateBanner(); }
  // 播放单条（lane: 'record' | 'notice'；opts: { duration, id, color, onDone }）
  function playMarquee(lane, text, opts) {
    opts = opts || {};
    const st = lanes[lane] || lanes.record;
    const b = laneEl(lane);
    if (!b) { if (opts.onDone) opts.onDone(); return; }
    if (st.timer) { clearTimeout(st.timer); st.timer = null; }
    const runId = ++st.runId;
    st.current = opts.id || null;
    if (opts.id && window.Net && window.Net.bannerPlaying) { try { window.Net.bannerPlaying(opts.id); } catch (e) {} }
    // 公告颜色（每条可自定义；未设置时用后台默认色；都没有则用样式默认渐变）
    if (lane === 'notice') {
      const cfg = S().bannerCfg || {};
      const col = opts.color || cfg.noticeColor || '';
      b.style.background = col || '';
      b.style.color = col ? textColorFor(col) : '';
    }
    const rep = esc(text) + '　　✦　　';
    b.innerHTML = '';
    // 重复 2 遍即可铺满并完整滚出（原先 5 遍会让单条播放时间过长，排队时积压明显）
    const track = el('span', 'rb-track', rep + rep);
    b.appendChild(track);
    b.classList.add('show');
    syncBannerOffset();
    let finished = false;
    function finish() {
      if (runId !== st.runId || finished) return;
      finished = true;
      if (st.timer) { clearTimeout(st.timer); st.timer = null; }
      if (st.current === opts.id) st.current = null;
      st.finish = null;
      b.classList.remove('show');
      syncBannerOffset();
      setTimeout(function () { if (runId === st.runId) b.innerHTML = ''; if (opts.onDone) opts.onDone(); }, 400);
    }
    st.finish = finish;
    // 动画时长 = 按内容宽度推算（约 120px/s），保证字全部滚出屏幕；管理页可指定 duration 作为最短时长
    const w = Math.max(600, track.offsetWidth || 1200);
    const scrollMs = Math.max(6000, Math.min(60000, Math.round(w / 120) * 1000));
    const ms = Math.max(scrollMs, Math.round((opts.duration || 0) * 1000));
    track.style.animationDuration = (ms / 1000) + 's';
    track.addEventListener('animationend', finish);
    track.addEventListener('animationcancel', finish);
    st.timer = setTimeout(finish, ms + 800); // 兜底
  }
  // 轨道排队：当前这条播完再播下一条（不打断）
  function pumpLane(lane) {
    const st = lanes[lane];
    if (!st || st.playing) return;
    const next = st.queue.shift();
    if (!next) return;
    st.playing = true;
    playMarquee(lane, next.text, Object.assign({}, next, { onDone: function () { st.playing = false; pumpLane(lane); } }));
  }
  // 纪录 / 最大鱼播报：入纪录轨队列，按顺序播放（不再插播打断）
  const RECORD_QUEUE_MAX = 4; // 待播上限：超过则丢最旧的（新消息优先，避免积压成长队）
  function showRecordBanner(rec) {
    if (!rec) return;
    const text = rec.text || ('🎉 全场最大纪录被破！' + rec.who + ' 钓到 ' + rec.name + ' ' + rec.size + 'cm');
    const q = lanes.record.queue;
    if (q.some(function (x) { return x.text === text; })) return; // 同文案不重复排队
    q.push({ text: text });
    while (q.length > RECORD_QUEUE_MAX) q.shift();
    pumpLane('record');
  }
  // 调试/测试用：清空两条轨道的队列并中止当前播放
  function resetBanners() {
    ['record', 'notice'].forEach(function (ln) {
      const st = lanes[ln];
      st.queue = [];
      if (st.finish) { const f = st.finish; st.finish = null; f(); }
      st.playing = false;
      const b = laneEl(ln);
      if (b) { b.classList.remove('show'); b.innerHTML = ''; }
    });
    syncBannerOffset();
  }

  // 管理后台公告队列（公告轨）：入队并顺序播放，支持每条自定义颜色
  function playBannerQueue(list) {
    (list || []).forEach(function (bn) {
      lanes.notice.queue.push({ id: bn.id, text: bn.content, duration: bn.duration, color: bn.color || '' });
    });
    pumpLane('notice');
  }
  // 后台「停止滚播」：立即中止正在播的那条公告，并把未播的同类从队列中移除
  function onBannerStop(id) {
    if (!id) return;
    lanes.notice.queue = lanes.notice.queue.filter(function (bn) { return bn.id !== id; });
    seenBannerIds[id] = true; // 标记已见，避免随后的 banner 广播把它重新入队
    if (lanes.notice.current === id && lanes.notice.finish) {
      const f = lanes.notice.finish;
      lanes.notice.finish = null;
      f();
      toast('管理员停止了该公告横幅');
    }
  }
  // 收到横幅更新：把服务器队列中尚未播放（本会话未见）的条目入队
  let seenBannerIds = {};
  function onBanners() {
    const st = S();
    const cfg = st.bannerCfg || {};
    const list = st.banners || [];
    const fresh = [];
    list.forEach(function (bn) {
      if (!bn || seenBannerIds[bn.id]) return;
      seenBannerIds[bn.id] = true;
      fresh.push(bn);
    });
    if (fresh.length) playBannerQueue(fresh);
    // 管理员删除 / 清空队列 / 停止后：客户端也要丢掉已入队但还没播的旧公告，并在需要时中止当前这条
    const alive = {};
    list.forEach(function (bn) { if (bn && bn.id) alive[bn.id] = true; });
    const before = lanes.notice.queue.length;
    lanes.notice.queue = lanes.notice.queue.filter(function (bn) { return !bn.id || alive[bn.id]; });
    if (before !== lanes.notice.queue.length) {
      // 有被移除的待播公告
    }
    if (lanes.notice.current && !alive[lanes.notice.current] && lanes.notice.finish) {
      const f = lanes.notice.finish;
      lanes.notice.finish = null;
      f();
    }
    // 闪烁是独立开关：与队列里有没有横幅无关（后台「图标闪烁」单独设置）
    updateFaviconBlink(!!cfg.blink, cfg.blinkTitle);
  }
  // ---- 浏览器图标闪烁：公告横幅（黄）与组件订阅提醒（红）两路来源共用一套闪烁 ----
  const baseTitle = document.title;
  let blinkTimer = null, blinkOn = false;
  let bannerBlink = { on: false, title: '' }; // 公告横幅闪烁状态（onBanners 维护）
  let subUnseen = 0;                          // 组件订阅提醒未读数（背包红标 / 图标闪烁）
  function makeFaviconDot(color) {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32">' +
      '<circle cx="16" cy="16" r="13" fill="' + color + '"/></svg>';
    return 'data:image/svg+xml,' + encodeURIComponent(svg);
  }
  function ensureFaviconLink() {
    let l = document.querySelector('link[rel="icon"]');
    if (!l) { l = document.createElement('link'); l.rel = 'icon'; document.head.appendChild(l); }
    return l;
  }
  // 订阅提醒是否要求闪烁（未配置订阅 / 关闭闪烁时视为不闪）
  function subBlinkOn() {
    const cfg = S().subCfg;
    return subUnseen > 0 && !!cfg && !!cfg.on && cfg.blink !== false;
  }
  function updateBlink() {
    if (blinkTimer) { clearInterval(blinkTimer); blinkTimer = null; }
    const link = ensureFaviconLink();
    const subOn = subBlinkOn();
    if (!subOn && !bannerBlink.on) { document.title = baseTitle; blinkOn = false; link.href = makeFaviconDot('%232dd4bf'); return; }
    const tip = subOn ? ('🎒 订阅组件到货 ×' + subUnseen) : (bannerBlink.title || '📢 有新公告');
    const color = subOn ? '%23ef4444' : '%23fbbf24';
    blinkTimer = setInterval(function () {
      blinkOn = !blinkOn;
      document.title = blinkOn ? tip : baseTitle;
      link.href = makeFaviconDot(blinkOn ? color : '%232dd4bf');
    }, 800);
  }
  // 公告横幅入口（onBanners 与登出清理共用；保持原签名）
  function updateFaviconBlink(on, titleText) {
    bannerBlink = { on: !!on, title: titleText || '' };
    updateBlink();
  }

  // ---- 日志：记录玩家收到的服务器消息（弹窗 / 公告 / 交易 / 纪录 / 订阅提醒）----
  // 前端本地持久化（localStorage 按账号分开）上限 300 条，不占服务器存储。
  const LOG_KEEP = 300;
  const LOG_KINDS = { system: ['🖥', '系统'], trade: ['✅', '交易'], record: ['🏆', '纪录'], subscribe: ['🔔', '订阅'], catch: ['🐟', '渔获'] };
  let msgLog = [];
  let msgLogOwner = null;
  function logKeyOf() { const me = S().me; return me && me.id ? 'fishing_log_' + me.id : null; }
  function loadLog() {
    const k = logKeyOf();
    if (!k) { msgLog = []; msgLogOwner = null; return; }
    if (msgLogOwner === k) return;
    msgLogOwner = k;
    msgLog = [];
    try { const raw = localStorage.getItem(k); if (raw) msgLog = JSON.parse(raw) || []; } catch (e) { msgLog = []; }
  }
  function saveLog() {
    const k = logKeyOf();
    if (!k) return;
    try { localStorage.setItem(k, JSON.stringify(msgLog)); } catch (e) {}
  }
  // 记一条服务器消息（同一账号跨页面/刷新保留；不重复登录时不会串号）
  function addLog(kind, msg) {
    loadLog();
    msgLog.unshift({ t: Date.now(), kind: LOG_KINDS[kind] ? kind : 'system', msg: String(msg == null ? '' : msg) });
    if (msgLog.length > LOG_KEEP) msgLog.length = LOG_KEEP;
    saveLog();
    if (currentView === 'logs') renderView();
  }
  function clearLog() { loadLog(); msgLog = []; saveLog(); }


  // ---- 通用：调用网络接口并提示结果 ----
  function call(promise, okMsg) {
    return Promise.resolve(promise).then(function (r) {
      if (!r || !r.ok) { toast((r && r.data && r.data.error) || '操作失败'); return r; }
      if (okMsg) toast(typeof okMsg === 'function' ? okMsg(r) : okMsg);
      refreshAll();
      return r;
    }).catch(function () { toast('网络错误'); });
  }

  // ---- 子窗口式确认 / 输入（替代浏览器原生 confirm / prompt）----
  // 关闭已有弹窗：用统一的 overlay 结构，样式与全局子窗口一致。
  function closeOverlays() {
    spotDetailRedraw = null; // 钓点详情弹窗的重绘钩子随弹窗一起移除
    document.querySelectorAll('.modal-overlay').forEach(function (m) { m.remove(); });
  }
  function buildOverlay(onCancel) {
    const overlay = el('div', 'modal-overlay');
    overlay.addEventListener('click', function (ev) { if (ev.target === overlay && onCancel) onCancel(); });
    return overlay;
  }
  // 确认框：okText 默认「确定」，danger 时按钮标红
  function confirmModal(opts) {
    opts = opts || {};
    return new Promise(function (resolve) {
      closeOverlays();
      const overlay = buildOverlay(function () { resolve(false); });
      const box = el('div', 'modal-box confirm-modal');
      box.innerHTML = '<div class="modal-head"><span class="modal-title">' + esc(opts.title || '请确认') + '</span></div>' +
        '<div class="modal-body"><div class="cf-text">' + (opts.html || esc(opts.text || '')) + '</div>' +
        '<div class="cf-actions"><button class="mini cf-cancel">取消</button>' +
        '<button class="mini primary-mini cf-ok">' + esc(opts.okText || '确定') + '</button></div></div>';
      overlay.appendChild(box);
      document.body.appendChild(overlay);
      const ok = box.querySelector('.cf-ok'), cancel = box.querySelector('.cf-cancel');
      if (opts.danger) { ok.classList.remove('primary-mini'); ok.classList.add('danger-mini'); }
      ok.addEventListener('click', function () { overlay.remove(); resolve(true); });
      cancel.addEventListener('click', function () { overlay.remove(); resolve(false); });
      ok.focus();
    });
  }
  // 输入框：可返回数字；min/max 限制
  function promptModal(opts) {
    opts = opts || {};
    return new Promise(function (resolve) {
      closeOverlays();
      const overlay = buildOverlay(function () { resolve(null); });
      const box = el('div', 'modal-box confirm-modal');
      const numeric = !!opts.numeric;
      box.innerHTML = '<div class="modal-head"><span class="modal-title">' + esc(opts.title || '请输入') + '</span>' +
        '<button class="mini modal-close">✕</button></div>' +
        '<div class="modal-body">' + (opts.html || '') +
        '<div class="cf-row"><input class="ipt cf-input" type="' + (numeric ? 'number' : 'text') + '"' +
        (opts.min != null ? ' min="' + opts.min + '"' : '') + (opts.max != null ? ' max="' + opts.max + '"' : '') +
        ' value="' + esc(opts.value != null ? opts.value : '') + '" /></div>' +
        '<div class="cf-actions"><button class="mini cf-cancel">取消</button>' +
        '<button class="mini primary-mini cf-ok">' + esc(opts.okText || '确定') + '</button></div></div>';
      overlay.appendChild(box);
      document.body.appendChild(overlay);
      const inp = box.querySelector('.cf-input');
      function submit() {
        let v = inp.value;
        if (numeric) { v = Number(v); if (!isFinite(v)) { inp.focus(); return; } if (opts.min != null && v < opts.min) v = opts.min; if (opts.max != null && v > opts.max) v = opts.max; }
        overlay.remove(); resolve(v);
      }
      box.querySelector('.cf-ok').addEventListener('click', submit);
      box.querySelector('.cf-cancel').addEventListener('click', function () { overlay.remove(); resolve(null); });
      box.querySelector('.modal-close').addEventListener('click', function () { overlay.remove(); resolve(null); });
      inp.addEventListener('keydown', function (e) { if (e.key === 'Enter') submit(); });
      inp.focus(); inp.select();
    });
  }

  // ---- 侧边导航 ----
  // 内容签名： fishing 徽标 / 交易徽标 / 当前视图 任一变化才重建。
  // 否则每次广播都会 innerHTML 重建导航，悬停高亮与过渡动画被打断（左侧闪烁）。
  let navSig = null;
  function renderNav() {
    const st = S();
    const sig = [currentView, st.fishing.active ? 1 : 0, st.trade ? (st.trade.id || 1) : 0, st.me && st.me.admin ? 1 : 0, subUnseen].join('|');
    if (sig === navSig) return;
    navSig = sig;
    const nav = $('nav');
    nav.innerHTML = '';
    D.NAV.forEach(function (item) {
      const b = el('button', 'nav-item' + (item.id === currentView ? ' active' : '') + (item.implemented ? '' : ' locked'));
      let badge = '';
      if (item.id === 'fishing' && S().fishing.active) badge = '<span class="nav-badge on">钓</span>';
      if (item.id === 'trade' && S().trade) badge = '<span class="nav-badge alert">!</span>';
      // 组件订阅提醒：背包入口显示未读红标（进入背包即清零）
      if (item.id === 'inventory' && subUnseen > 0) badge = '<span class="nav-badge unread">' + (subUnseen > 99 ? '99+' : subUnseen) + '</span>';
      // 像素导航图标（assets/nav/<id>.png，由 tools/gen_nav.py 生成）；emoji 作为降级兜底
      const navIcon = '<span class="nav-icon"><img class="nav-ico" src="assets/nav/' + esc(item.id) +
        '.png" alt="" draggable="false" onerror="this.outerHTML=\'' + item.icon + '\'"></span>';
      b.innerHTML = navIcon + '<span>' + esc(item.name) + '</span>' + badge +
        (item.implemented ? '' : '<span class="lock">🔒</span>');
      b.addEventListener('click', function () {
        if (!item.implemented) {
          toast('「' + item.name + '」功能尚未开放（框架占位）');
          return; // 未完成功能：不可跳转
        }
        currentView = item.id;
        if (item.id === 'inventory') clearSubAlerts();
        renderNav();
        renderView();
        loadViewData(item.id);
      });
      nav.appendChild(b);
    });
    // 管理员：侧边栏底部加后台入口（新标签打开，admin.html 与游戏同源托管）
    if (st.me && st.me.admin) {
      const a = el('a', 'nav-item admin-link');
      a.href = 'admin.html';
      a.target = '_blank';
      a.rel = 'noopener';
      a.innerHTML = '<span class="nav-icon">🛡</span><span>管理后台</span>';
      nav.appendChild(a);
    }
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
      (castSpeedShort() ? '<span class="meta cast" title="后台基础间隔与全部加成（钓竿词缀 / 钓点增益乘算 / 全服钓速），实时跟随后台设置">🎣 ' + esc(castSpeedShort()) + '</span>' : '') +
      (biteRateShort() ? '<span class="meta bite" title="当前钓点实时上鱼率：钓点独立配置优先，否则由后台「公式管理」的上钩公式决定">🐟 ' + esc(biteRateShort()) + '</span>' : '') +
      '<span class="meta">位置：' + esc(loc) + '</span>' +
      '<span class="meta">在线：' + est.players + ' 人</span>' +
      // 与服务器的实时连接断了：EventSource 会自动重连，这里只提示，不刷新页面
      (connOk() ? '' : '<span class="meta conn-off" title="与服务器的实时连接已断开，正在自动重连；期间显示的数据可能不是最新。服务器若已更新，重连后会自动刷新到新版本。">⚠ 连接断开 · 重连中</span>') +
      '<span class="meta coins">💰 ' + p.coins + '</span>';
  }
  // 顶栏在线数用小工具（避免每次手写）
  const est = { get players() { return S().players.length; } };
  // 连接状态（由 net.js 的探测/SSE 维护）：断线时顶栏给提示，恢复后自动消失
  function connOk() { return !window.Net || !window.Net.connState || window.Net.connState(); }
  function onConnChange(ok) {
    renderTopbar();
    if (ok) toast('已重新连接服务器');
  }

  // ---- 钓鱼视图 ----
  // ---- 钓速 / 上鱼率信息（顶部状态栏与钓鱼页共用） ----
  // 优先用服务器下发的 castInfo（精确）；未拿到时用本地已知的后台配置（st.castCfg）
  // + 钓竿词缀 + 当前钓点增益推算，保证后台一改数字界面立刻更新。
  // 速率规则：间隔 = 基础 × (1 - 有效钓速/100) × (1 - 钓点钓速/100)，钓点钓速为最终乘算；
  //           钓点若配置了「独立间隔」则直接使用；上鱼率优先取钓点独立值，否则由全服公式决定。
  function currentSpotOf() {
    const st = S();
    const gid = st.player.groundId || (st.selected && st.selected.groundId);
    const sid = st.player.spotId || (st.selected && st.selected.spotId);
    if (!gid || !sid) return null;
    const g = D.GROUNDS.find(function (x) { return x.id === gid; });
    const sp = g && g.spots.find(function (x) { return x.id === sid; });
    return sp || null;
  }
  function spotSpeedPct(spot) {
    let v = 0;
    ((spot && spot.buffs) || []).forEach(function (b) { if (b && b.type === 'speed') v += Number(b.value) || 0; });
    return v;
  }
  function castSpeedInfo() {
    const st = S();
    if (st.castInfo) return st.castInfo;
    const cfg = st.castCfg;
    if (!cfg || !cfg.baseMs) return null;
    const effBd = E().bdEffects ? E().bdEffects() : { speed: 0 };
    const spot = currentSpotOf();
    const spotPct = spotSpeedPct(spot);
    const clampedSpot = Math.max(-100, Math.min(95, spotPct));
    const globalBonus = Number(cfg.speedBonus) || 0;
    const cap = cfg.speedCap != null ? Number(cfg.speedCap) : 80;
    const minMs = cfg.minMs != null ? Number(cfg.minMs) : 800;
    const rodEff = Math.max(0, Math.min(cap, (effBd.speed || 0) + globalBonus));
    const fixed = spot && spot.intervalMs;
    const hasFixed = fixed != null && fixed !== '' && isFinite(Number(fixed));
    const interval = hasFixed
      ? Math.round(Math.max(100, Number(fixed)))
      : Math.max(minMs, Math.round(cfg.baseMs * (1 - rodEff / 100) * (1 - clampedSpot / 100)));
    const spotBite = spot && spot.biteRate != null && spot.biteRate !== '' ? Number(spot.biteRate) : null;
    return {
      baseMs: cfg.baseMs, minMs: minMs, globalBonus: globalBonus, cap: cap,
      affixSpeed: effBd.speed || 0, buffSpeed: spotPct,
      rawSpeed: Math.round(rodEff * 10) / 10, effSpeed: Math.round(rodEff * 10) / 10,
      spotMult: Math.round((1 - clampedSpot / 100) * 1000) / 1000,
      intervalMs: hasFixed ? Math.round(Number(fixed)) : null,
      interval: interval,
      biteRate: spotBite, biteOverride: spotBite != null,
    };
  }
  // 简短文案：每 2.75s 一竿（基础 3.00s · 竿+25% · 点速×0.80）
  function castSpeedShort() {
    const ci = castSpeedInfo();
    if (!ci) return '';
    const parts = [];
    if (ci.intervalMs != null) parts.push('钓点固定间隔');
    if (ci.affixSpeed) parts.push('竿' + (ci.affixSpeed > 0 ? '+' : '') + ci.affixSpeed + '%');
    if (ci.buffSpeed) parts.push('点速×' + (ci.spotMult != null ? ci.spotMult.toFixed(2) : '1.00'));
    if (ci.globalBonus) parts.push('服' + (ci.globalBonus > 0 ? '+' : '') + ci.globalBonus + '%');
    const capTag = ci.rawSpeed > ci.effSpeed ? '，封顶 ' + ci.cap + '%' : '';
    return '每 ' + (ci.interval / 1000).toFixed(2) + 's 一竿（基础 ' + (ci.baseMs / 1000).toFixed(2) + 's'
      + (parts.length ? ' · ' + parts.join(' · ') + capTag : ' · 无加成') + '）';
  }
  // 上鱼率文案（钓点独立值优先，否则由全服公式决定）：数值未知时返回空串
  function biteRateShort() {
    const ci = castSpeedInfo();
    if (!ci || ci.biteRate == null) return '';
    return '上鱼率 ' + (Math.round(ci.biteRate * 10) / 10) + '%' + (ci.biteOverride ? '（钓点独立）' : '');
  }
  // 完整文案（钓鱼页状态条）
  function castText() {
    const ci = castSpeedInfo();
    if (!ci) return '服务器每 ' + (S().fishingInterval / 1000).toFixed(2) + 's 抛一竿';
    const speedTag = '后台基础 ' + (ci.baseMs / 1000).toFixed(2) + 's/竿 · 实际 ' + (ci.interval / 1000).toFixed(2) + 's/竿';
    const biteTag = biteRateShort() ? ' · ' + biteRateShort() : '';
    const parts = [];
    if (ci.affixSpeed) parts.push('钓竿 ' + (ci.affixSpeed > 0 ? '+' : '') + ci.affixSpeed + '%');
    if (ci.buffSpeed) parts.push('钓点 ×' + (ci.spotMult != null ? ci.spotMult.toFixed(2) : '1.00'));
    if (ci.globalBonus) parts.push('全服 +' + ci.globalBonus + '%');
    return speedTag + (parts.length ? '（' + parts.join(' · ') + '）' : '（无加成）') + biteTag;
  }

  function renderFishing() {
    const main = $('main');
    const st = S();
    main.innerHTML = '';

    // 左：像素世界地图（钓场为区域、钓点为可点节点；点击节点=选择钓点，逻辑不变）
    // 多地图页签：近岸（现有地图，冰湖活动场也在此图上）/ 出海（未来航线新地图预告）
    const left = el('div', 'panel fish-select');
    left.innerHTML = '<h2>🎣 世界地图 · 点击钓点开始垂钓</h2>';
    const tabBar = el('div', 'px-map-tabs');
    [['nearshore', '🏞 近岸'], ['voyage', '⛵ 出海 · 未来']].forEach(function (kv) {
      const tb = el('button', 'px-map-tab' + (mapTab === kv[0] ? ' on' : ''), kv[1]);
      tb.addEventListener('click', function () { if (mapTab !== kv[0]) { mapTab = kv[0]; renderView(); } });
      tabBar.appendChild(tb);
    });
    left.appendChild(tabBar);
    // 地图节点坐标（地图宽高的百分比）：与 assets/worldmap.png 中场景对应。
    // 权威坐标来自钓点数据的 sp.pos（data.js 出厂值 + 管理后台拖动覆盖，见后台「渔场钓点 · 地图定位」）；
    // 这里的表只作为**兜底**：自定义钓点（后台新建、没有坐标）时仍能落在合理位置。
    const MAP_LAYOUT = {
      stillwater: { dock: [69, 30], reed: [68, 60], deep: [74, 48], label: [74, 72] },
      rapids: { shoal: [77, 34], eddy: [58, 42], fall: [83, 20], label: [50, 48] },
      sunset: { beach: [42, 71], pier: [35, 30], reef: [18, 78], label: [20, 28] },
      frostmoon: { label: [67, 11] },
    };
    // 出海预告图的锁定节点
    const VOYAGE_NODES = [
      { pos: [26, 73], name: '母港 · 起程', tip: '出海航线的起点' },
      { pos: [62, 44], name: '雾中群岛 · 未知钓场', tip: '敬请期待' },
      { pos: [85, 26], name: '远海群岛 · 未知钓场', tip: '敬请期待' },
    ];
    const map = el('div', 'px-map');
    const mapImg = mapTab === 'voyage' ? 'assets/voyagemap.png' : 'assets/worldmap.png';
    map.innerHTML = '<img class="px-map-img" src="' + mapImg + '" alt="" draggable="false">';
    // 钓点选择（定义提前到分支外，增益一览等地图外控件也要用）：
    // 主路径用 pointerdown（上鱼广播会整页重绘，若在 mouseup 前重绘则 click 会丢失，
    // 表现为「切换钓点被上鱼卡住」；pointerdown 一定发生在存活 DOM 上）。
    let lastSpotPointerTs = 0;
    function chooseSpot(t) {
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
        else { toast((wasFishing ? '已切换钓点 · ' : '已开始自动钓鱼 · ') + castText()); }
        renderTopbar(); renderNav(); renderFishing();
      });
    }
    if (mapTab === 'voyage') {
      // 出海预告：全部锁定，点按只提示
      const vl = el('div', 'px-region locked', '航线规划中 · 未来版本开放');
      vl.style.left = '55%'; vl.style.top = '90%';
      map.appendChild(vl);
      VOYAGE_NODES.forEach(function (n) {
        const node = el('button', 'px-node locked');
        node.style.left = n.pos[0] + '%';
        node.style.top = n.pos[1] + '%';
        node.innerHTML = '<span class="pn-bob"></span><span class="pn-name">🔒 ' + esc(n.name) + '</span>';
        node.title = n.tip;
        node.addEventListener('pointerdown', function () { toast('「出海」航线仍在规划中，未来版本开放'); });
        map.appendChild(node);
      });
      left.appendChild(map);
    } else {
    // 近岸地图：两只飞鸟掠过（纯装饰）
    map.innerHTML += '<img class="px-bird b1" src="assets/ui/bird.png" alt="">' +
      '<img class="px-bird b2" src="assets/ui/bird.png" alt="">';
    D.GROUNDS.forEach(function (g) {
      const lay = MAP_LAYOUT[g.id] || {};
      // 未预置坐标的钓点（例如冰湖活动场开启后后台新配的钓点）：围绕区域锚点环状排列
      (g.spots || []).forEach(function (sp, spIdx) {
        let pos = (Array.isArray(sp.pos) && sp.pos.length === 2) ? sp.pos : lay[sp.id];
        if (!pos) {
          const base = lay.label || [50, 50];
          const ang = -90 + spIdx * 60;
          pos = [base[0] + 9 * Math.cos(ang * Math.PI / 180), base[1] + 9 * Math.sin(ang * Math.PI / 180)];
        }
        const on = st.selected.groundId === g.id && st.selected.spotId === sp.id;
        const here = st.player.groundId === g.id && st.player.spotId === sp.id;
        const buffed = sp.buffs && sp.buffs.length > 0;
        const node = el('button', 'px-node' + (on ? ' on' : '') + (here ? ' here' : '') + (buffed ? ' buffed' : ''));
        node.setAttribute('data-g', g.id);
        node.setAttribute('data-s', sp.id);
        node.style.left = pos[0] + '%';
        node.style.top = pos[1] + '%';
        node.innerHTML = '<span class="pn-bob"></span><span class="pn-name">' + esc(sp.name) +
          (buffed ? '<span class="pn-buff">⚡</span>' : '') + '</span>' +
          // 增益常驻可见（不依赖悬浮提示）：增益钓点名牌下直接列出效果
          (buffed ? '<span class="pn-bufftip">⚡ ' + sp.buffs.map(function (b) {
            return esc(affixName(b.type) + (b.value > 0 ? '+' : '') + b.value + '%');
          }).join(' ') + '</span>' : '') +
          (here ? '<img class="pn-fisher" src="assets/ui/fisherman.png" alt="">' : '');
        map.appendChild(node);
      });
    });
    // 同时保留 click 以支持键盘激活，并用时间戳避免同一次操作被处理两次。
    map.addEventListener('pointerdown', function (ev) {
      const t = ev.target && ev.target.closest ? ev.target.closest('.px-node') : null;
      if (!t || !t.getAttribute('data-g')) return;
      lastSpotPointerTs = Date.now();
      chooseSpot(t);
    });
    map.addEventListener('click', function (ev) {
      // pointerdown 已处理（鼠标/触摸）；这里只兜底键盘激活
      if (Date.now() - lastSpotPointerTs < 700) return;
      const t = ev.target && ev.target.closest ? ev.target.closest('.px-node') : null;
      if (!t || !t.getAttribute('data-g')) return;
      chooseSpot(t);
    });
    left.appendChild(map);
    }
    // 钓场状态卡（地图外）：图标 + 名称 + 类型 + 实时人数/锁定状态
    const groundsBar = el('div', 'px-grounds');
    D.GROUNDS.forEach(function (g) {
      const cnt = (st.groundCounts && st.groundCounts[g.id]) || 0;
      const card = el('div', 'px-region g-card' + (g.locked ? ' locked' : ''));
      card.innerHTML = '<img class="pg-icon" src="assets/ground/' + esc(g.id) + '.png" alt="" draggable="false"' +
        ' onerror="this.style.display=\'none\'">' +
        '<div class="pg-info"><b>' + esc(g.name) + '</b>' +
        '<span>' + (g.locked ? '🔒 活动钓场 · 即将开放' : (g.type === 'normal' ? '普通钓场' : '活动钓场') + ' · 👥 ' + cnt + ' 人') + '</span></div>';
      groundsBar.appendChild(card);
    });
    left.appendChild(groundsBar);
    // 增益钓点一览：列出当前所有带增益的钓点（与地图节点 ⚡ 同源），点击直达该钓点
    const buffed = [];
    D.GROUNDS.forEach(function (g) {
      (g.spots || []).forEach(function (sp) {
        if (sp.buffs && sp.buffs.length) buffed.push({ g: g, sp: sp });
      });
    });
    if (buffed.length) {
      const buffBar = el('div', 'px-buffbar');
      buffBar.appendChild(el('span', 'pb-title', '⚡ 增益钓点'));
      buffed.forEach(function (e) {
        const chip = el('button', 'pb-chip');
        chip.setAttribute('data-g', e.g.id);
        chip.setAttribute('data-s', e.sp.id);
        chip.innerHTML = '<b>' + esc(e.g.name + '·' + e.sp.name) + '</b>' +
          e.sp.buffs.map(function (b) {
            return '<i>' + esc(affixName(b.type) + (b.value > 0 ? '+' : '') + b.value + '%') + '</i>';
          }).join('');
        chip.addEventListener('pointerdown', function () { chooseSpot(chip); });
        buffBar.appendChild(chip);
      });
      left.appendChild(buffBar);
    }
    // 图例：帮助首次进入的玩家看懂地图标记
    const legend = el('div', 'px-legend');
    legend.innerHTML = '<span><i class="lg-bob"></i> 钓点</span>' +
      '<span><i class="lg-ring"></i> 当前垂钓位置</span>' +
      '<span><i class="lg-buff">⚡</i> 有增益的钓点</span>' +
      '<span>🔒 未开放钓场</span>';
    left.appendChild(legend);

    const ctrl = el('div', 'fish-ctrl');
    const stateBar = el('div', 'fish-state' + (st.fishing.active ? ' on' : ''));
    if (st.fishing.active) {
      const g = D.GROUNDS.find(function (x) { return x.id === st.player.groundId; });
      const sp = g && g.spots.find(function (x) { return x.id === st.player.spotId; });
      stateBar.innerHTML = '<span class="dot on"></span> 自动钓鱼中 · ' + esc(g ? g.name : '') + (sp ? '·' + esc(sp.name) : '') +
        '<span class="state-hint">' + esc(castText()) + ' · 再点当前钓点可取消</span>';
    } else {
      stateBar.innerHTML = '<span class="dot idle"></span> 未在钓鱼<span class="state-hint">点击任意垂钓点即可开始自动钓鱼</span>';
    }
    ctrl.appendChild(stateBar);
    left.appendChild(ctrl);
    main.appendChild(left);

    // 右：渔场实况（顶部为装饰性垂钓场景：水面/浮漂/游鱼动画，active 时浮漂跳动，无逻辑）
    const right = el('div', 'panel fish-live');
    right.innerHTML = '<h2>🌊 渔场实况</h2>';
    const scene = el('div', 'px-scene');
    scene.setAttribute('data-active', st.fishing.active ? '1' : '0');
    scene.innerHTML = '<div class="px-scene-water"></div><div class="px-scene-line"></div>' +
      '<div class="px-scene-bobber"></div>' +
      '<img class="px-fish px-f1" src="assets/fish/sardine.png" alt="" draggable="false">' +
      '<img class="px-fish px-f2" src="assets/fish/carp.png" alt="" draggable="false">' +
      '<img class="px-fish px-f3" src="assets/fish/bass.png" alt="" draggable="false">';
    right.appendChild(scene);
    const atGroundId = st.player.groundId;
    const gNow = atGroundId ? D.GROUNDS.find(function (x) { return x.id === atGroundId; }) : null;
    const spNow = gNow && gNow.spots.find(function (x) { return x.id === st.player.spotId; });
    if (!atGroundId) {
      right.appendChild(el('div', 'here-count', '当前不在任何钓点'));
      right.appendChild(el('div', 'hint', '点击左侧任意垂钓点即可开始自动钓鱼。'));
    } else {
      const here = E().playersAtSpot(atGroundId, st.player.spotId);
      // 只报所在位置；人数交给下面的「同钓点 N 人」（钓场级人数左侧钓场卡片已有 👥）
      right.appendChild(el('div', 'here-count', '所在：' + esc(gNow ? gNow.name : '') + (spNow ? '·' + esc(spNow.name) : '')));
      // 同屏最多 5 条，超出可下滑（不挤占下方的渔获日志入口）
      const peepHead = el('div', 'peeps-head', '同钓点 ' + here.length + ' 人' + (here.length > 5 ? '（可下滑查看全部）' : ''));
      right.appendChild(peepHead);
      const peeps = el('div', 'peeps scroll5');
      if (here.length === 0) peeps.appendChild(el('div', 'hint', '暂无同一钓点的玩家。'));
      here.forEach(function (b) { peeps.appendChild(peepCard(b)); });
      right.appendChild(peeps);
    }

    // 主界面渔获日志：随上鱼实时滚动刷新（同时也会写入「📜 日志 · 🐟 渔获」分列做长期留存）
    const logHead = el('h3', null, '📜 我的渔获日志');
    logHead.title = '上鱼时自动滚动刷新；完整记录见「日志 · 🐟 渔获」';
    right.appendChild(logHead);
    const log = el('div', 'catch-log');
    if (st.log.length === 0) log.appendChild(el('div', 'hint', '还没有渔获，去抛竿吧。'));
    st.log.slice(0, 25).forEach(function (e) {
      const meta = e.item || {};
      log.appendChild(el('div', 'log-line', timeStr(e.t) + ' · 钓到 <span class="' + qualityClass(meta) + '">' + esc(meta.name) +
        '</span>' + (meta.size ? ' <span class="muted">' + meta.size + 'cm</span>' : '') +
        (meta.rarity === 'rare' ? ' ✨稀有' : meta.rarity === 'epic' ? ' 💎史诗' : '')));
    });
    right.appendChild(log);
    right.appendChild(el('div', 'hint', '完整渔获记录已同步到 📜 日志 · 🐟 渔获（可在那里按时间线回看）'));

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
      row.innerHTML = '<span class="' + qualityClass(meta) + '">' + esc(meta.name) + '</span>' +
        '<span class="cnt">×' + st.inventory[k] + '</span>';
      const acts = el('span', 'inv-acts');
      if (opts.onSell) {
        const sellUnit = shopP ? shopP.price : meta.price;
        const sb = el('button', 'mini primary-mini', '出售 ' + sellUnit + '💰');
        sb.title = '按当前系统收购价出售 1 个';
        sb.addEventListener('click', function () { opts.onSell(k); });
        acts.appendChild(sb);
      }
      const lb = el('button', 'mini', '上架');
      lb.title = '挂到开放市集（选择时长，支付对应上架费，下架不退）';
      lb.addEventListener('click', function () { openListModal(k); });
      acts.appendChild(lb);
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
  // 安装 = 从背包取用 1 件组件；卸下（或换装）会把组件原样放回背包。
  function setPart(partKey, compId) {
    // 卸下配件会把这根已保存的钓竿拆开 → 对应槽位随之取消，先弹窗预警（避免误操作丢配置）
    const active = (typeof S().rodActiveSlot === 'number' && S().rodActiveSlot >= 0) ? S().rodActiveSlot : -1;
    if (!compId && active >= 0) {
      const part = D.ROD_PARTS.find(function (p) { return p.key === partKey; });
      return confirmModal({
        title: '卸下配件会取消钓竿槽位',
        html: '当前钓竿「' + esc(S().rodName || '未命名') + '」保存在<b>槽位 ' + (active + 1) + '</b>。' +
          '卸下' + esc((part && part.name) || partKey) + '会把这根钓竿拆开，<b>槽位 ' + (active + 1) + ' 会被取消</b>；' +
          '该配件退回背包，可重新装配后再保存到槽位。',
        okText: '仍要卸下',
      }).then(function (ok) { if (ok) doSetPart(partKey, null); });
    }
    doSetPart(partKey, compId);
  }
  function doSetPart(partKey, compId) {
    call(window.Net.bdSet(partKey, compId || null), null).then(function (r) {
      if (r && r.ok) {
        S().bd = r.data.bd;
        if (r.data.inventory) S().inventory = r.data.inventory;
        if (r.data.castInfo) { S().castInfo = r.data.castInfo; S().fishingInterval = r.data.castInfo.interval; }
        if (r.data.rodSlots) S().rodSlots = r.data.rodSlots;
        if (r.data.rodLocked) S().rodLocked = r.data.rodLocked;
        if (r.data.rodActiveSlot !== undefined) S().rodActiveSlot = r.data.rodActiveSlot;
        E().refreshEffects();
        const released = (typeof r.data.releasedSlot === 'number' && r.data.releasedSlot >= 0) ? r.data.releasedSlot : -1;
        toast((compId ? '已装备 ' + itemMeta(compId).name + '（消耗 1 件组件）' : '已卸下组件') +
          (released >= 0 ? '，槽位 ' + (released + 1) + ' 的钓竿已取消' : '') + '，加成已在服务器生效');
        renderTopbar();
        renderView();
      }
    });
  }

  // 装备面板状态：当前展开的部位 + 面板内筛选/排序（模块级：重绘间保留）
  let bdEquipPart = null;
  let bdEquipFilter = 'all';
  let bdEquipSort = 'rarity';
  let bdEquipDir = 'desc';
  const BD_AFFIXES = [['speed', '⚡ 钓速'], ['skill', '🎯 技巧'], ['rare', '✨ 稀有'], ['material', '🧵 材料'], ['size', '📏 体型'], ['double', '🎣 双钓']];

  // 装备子页面：以弹窗形式展示该部位可装备的组件（筛选 / 排序 / 装备），
  // 不再占用钓竿配置页下方的整块区域。
  function openBdEquipModal(partKey) {
    bdEquipPart = partKey;
    const part = D.ROD_PARTS.find(function (p) { return p.key === partKey; });
    if (!part) return;
    const st = S();

    document.querySelectorAll('.modal-overlay').forEach(function (m) { m.remove(); });
    const overlay = el('div', 'modal-overlay');
    overlay.addEventListener('click', function (ev) { if (ev.target === overlay) closeBdEquipModal(); });
    const box = el('div', 'modal-box shop-modal bd-equip-modal');
    box.innerHTML = '<div class="modal-head"><span class="modal-title">🎯 装备「' + esc(part.name) + '」组件</span>' +
      '<button class="mini modal-close">✕ 关闭</button></div>' +
      '<div class="modal-body"><div class="bde-note">装备会从背包取用 1 件（卸下时自动放回）</div><div id="bde-body"></div></div>';
    box.querySelector('.modal-close').addEventListener('click', closeBdEquipModal);
    overlay.appendChild(box);
    document.body.appendChild(overlay);

    renderBody();

    // 装备子窗口内的「直接出售」：与背包「出售 1」同源，售出后重绘本弹窗（保持部位/筛选/排序）
    function sellFromEquip(id) {
      const meta = D.componentOf(id) || itemMeta(id);
      call(window.Net.sell(id, 1), function (r) { return '售出 ' + meta.name + ' ×1，获得 💰' + r.data.gain; })
        .then(function (r) {
          if (r && r.ok) {
            st.inventory = r.data.inventory; st.player.coins = r.data.coins; st.shop = r.data.shop;
            renderTopbar();
            if (bdEquipPart) renderBody();
          }
        });
    }

    function renderBody() {
      const body = box.querySelector('#bde-body');
      if (!body) return;
      body.innerHTML = '';
      const equipped = D.componentOf(st.bd[part.key] && st.bd[part.key].compId);

      // 顶部：当前已装备组件与属性（便于对比决定是否替换）
      const cur = el('div', 'bde-current' + (equipped ? '' : ' empty'));
      if (equipped) {
        const eqAffs = (equipped.affixes || []).map(function (a) {
          const rng = affixRangeIn(equipped, a);
          return affSpanOpen(a) + esc(affixText(a)) + '</span>' +
            (rng ? '<span class="aff-rng">（' + esc(rangeText({ min: rng[0], max: rng[1] })) + '%）</span>' : '');
        }).join(' ');
        cur.innerHTML = '<div class="bec-head"><span class="bec-label">当前已装备</span>' +
          '<img class="bec-icon" src="assets/item/' + esc(equipped.baseId || '') + '.png" alt="" draggable="false">' +
          '<b class="' + qualityClass(equipped) + '">' + esc(equipped.name) + '</b>' +
          itemTag(equipped) +
          '<span class="inst-meta">' + esc(qualityName(equipped)) + '品质 · ' + equipped.affixes.length + '/' + equipped.maxAffixes + ' 词条</span>' +
          '<span class="bec-price">' + equipped.price + '💰</span></div>' +
          '<div class="bec-affs">' + (eqAffs || '<span class="muted">无词条</span>') + '</div>' +
          '<div class="bec-tip">对比下方组件决定是否替换：装备会消耗背包中的 1 件，被换下的旧组件自动放回背包。</div>';
      } else {
        cur.innerHTML = '<div class="bec-head"><span class="bec-label">当前已装备</span><b class="muted">（该栏位为空）</b></div>' +
          '<div class="bec-tip">下方是该栏位背包中的组件，点「装备」获得词缀加成。</div>';
      }
      body.appendChild(cur);

      const owned = Object.keys(st.inventory)
        .map(function (id) { return { c: D.componentOf(id), n: st.inventory[id] }; })
        .filter(function (o) { return o.c && o.c.part === part.key && o.n > 0; });
      if (!owned.length) { body.appendChild(el('div', 'hint', '背包暂无该部位的组件。')); return; }

      // 属性筛选 + 排序控件
      const ctr = el('div', 'bde-controls');
      [['all', '全部属性']].concat(BD_AFFIXES).forEach(function (kv) {
        const b = el('button', 'bf-cat' + (bdEquipFilter === kv[0] ? ' on' : ''), kv[1]);
        b.title = '选中词条后，排序自动按该词条的数值排';
        b.addEventListener('click', function () {
          if (bdEquipFilter === kv[0]) return;
          bdEquipFilter = kv[0];
          // 选中具体词条 → 排序自动切到「按该词条数值」；回到全部 → 恢复稀有度
          if (kv[0] === 'all') { if (bdEquipSort === 'affix') { bdEquipSort = 'rarity'; bdEquipDir = 'desc'; } }
          else { bdEquipSort = 'affix'; bdEquipDir = 'desc'; }
          renderBody();
        });
        ctr.appendChild(b);
      });
      ctr.appendChild(el('span', 'bf-sort-label', '排序'));
      // 排序按钮跟着筛选联动：选中词条时把「属性值」显示为「某词条值」
      const affSortName = (function () {
        if (bdEquipFilter === 'all') return '属性值';
        const hit = BD_AFFIXES.find(function (kv) { return kv[0] === bdEquipFilter; });
        const nm = hit ? hit[1].replace(/^\S+\s*/, '') : '属性值';
        return nm + '值';
      })();
      [['rarity', '稀有度'], ['price', '价格'], ['affix', affSortName]].forEach(function (kv) {
        const active = bdEquipSort === kv[0];
        const arrow = active ? (bdEquipDir === 'desc' ? ' ↓' : ' ↑') : '';
        const b = el('button', 'bf-cat bf-sort-btn' + (active ? ' on' : ''), kv[1] + arrow);
        b.addEventListener('click', function () {
          if (bdEquipSort === kv[0]) bdEquipDir = bdEquipDir === 'desc' ? 'asc' : 'desc';
          else { bdEquipSort = kv[0]; bdEquipDir = 'desc'; }
          renderBody();
        });
        ctr.appendChild(b);
      });
      body.appendChild(ctr);

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
            '<div class="bec-name"><img class="bec-icon" src="assets/item/' + esc(c.baseId || '') + '.png" alt="" draggable="false">' +
            '<span class="' + qualityClass(c) + '">' + esc(c.name) + itemTag(c) + '</span><span class="bec-price">' + c.price + '💰</span></div>' +
            '<div class="inst-meta">' + esc(qualityName(c)) + '品质 · ' + c.affixes.length + '/' + c.maxAffixes + ' 词条</div>' +
            c.affixes.map(function (a) { return '<div class="bec-aff' + (a.value < 0 ? ' aff-neg' : '') + (a.extra ? ' extra' : '') + '">' + esc(affixText(a)) + '</div>'; }).join('') +
            '<div class="bec-meta">持有 ×' + o.n + '</div>';
          const acts = el('div', 'bec-acts');
          const isOn = !!(equipped && equipped.id === c.id);
          const use = el('button', 'mini primary-mini', isOn ? '已装备' : '装备');
          if (isOn) { use.disabled = true; use.classList.add('locked'); }
          use.addEventListener('click', function () {
            closeBdEquipModal();
            setPart(part.key, c.id);
          });
          acts.appendChild(use);
          // 直接出售（组件固定价，无需等行情）
          const sellBtn = el('button', 'mini', '出售 1');
          sellBtn.title = '按系统固定价出售 1 个（组件不随市场浮动）';
          sellBtn.addEventListener('click', function () { sellFromEquip(c.id); });
          acts.appendChild(sellBtn);
          // 上架：复用市集「上架」子窗口（数量/单价/时长/费率/走势一致）
          const listBtn = el('button', 'mini', '上架');
          listBtn.title = '挂到开放市集（与市集「上架」同一子窗口：数量 / 单价 / 时长 / 费率）';
          listBtn.addEventListener('click', function () {
            openListModal(c.id, function () { openBdEquipModal(part.key); });
          });
          acts.appendChild(listBtn);
          card.appendChild(acts);
          grid2.appendChild(card);
        });
      }
      body.appendChild(grid2);
    }
  }
  function closeBdEquipModal() {
    bdEquipPart = null;
    document.querySelectorAll('.modal-overlay').forEach(function (m) { m.remove(); });
  }
  // ---- 钓竿存档 / 槽位 ----
  // 被钓竿（当前装备 + 已保存的槽位钓竿）占用的实例件数；背包/交易/市集据此显示锁定标记。
  function rodLockCount(id) { const m = S().rodLocked || {}; return m[id] || 0; }
  function rodLockBadge(id) {
    const n = rodLockCount(id);
    if (!n) return '';
    return '<span class="rod-lock" title="有 ' + n + ' 件装在钓竿上（已锁定，不可单独交易）；背包里的余量可正常出售">🔒×' + n + '</span>';
  }
  // 组件摘要（整竿用）
  function rodAffixBadges(affixes) {
    return (affixes || []).map(function (a) {
      return affSpanOpen(a) + esc(affixText(a)) + '</span>';
    }).join(' ');
  }
  // 钓竿槽位栏：免费 1 个 + 可购买 7 个（价格递增）；存档 = 收起当前钓竿并锁定其配件
  function renderRodSlots(strip) {
    const st = S();
    const slots = st.rodSlots || [];
    const bought = st.rodSlotsCount || 1;
    const max = st.rodSlotsMax || 8;
    const wrap = el('div', 'rod-slots');
    const head = el('div', 'rs-head');
    const activeSlot = (typeof st.rodActiveSlot === 'number' && st.rodActiveSlot >= 0) ? st.rodActiveSlot : -1;
    head.innerHTML = '<b>🎣 我的钓竿</b>' +
      '<span class="rs-cur">当前使用：<b>' + esc(st.rodName || '（未命名）') + '</b>' +
      (activeSlot >= 0 ? '（槽位 ' + (activeSlot + 1) + '）' : '（散件装配，未占用槽位）') +
      ' · ' + Object.keys(st.bd || {}).filter(function (k) { return st.bd[k] && st.bd[k].compId; }).length + ' 件已装</span>' +
      '<span class="rs-hint">装配好后点「保存」即占用槽位（配件锁定），可在槽位间切换；改名直接用槽位卡上的「改名」（使用中的竿改名会同步显示名）；「收起」在使用中槽位卡上，与「删除」并排</span>';
    wrap.appendChild(head);
    const grid = el('div', 'rs-grid');
    for (let i = 0; i < max; i++) {
      const card = el('div', 'rs-card' + (i >= bought ? ' locked' : '') + (slots[i] ? ' has' : ''));
      if (i >= bought) {
        const price = i === bought ? st.nextRodSlotPrice : null;
        card.innerHTML = '<div class="rs-name">🔒 槽位 ' + (i + 1) + '</div>' +
          '<div class="rs-sub">' + (price != null ? ('购买需 💰' + price) : '需先购买前一个槽位') + '</div>';
        if (price != null) {
          const isAdmin = !!(st.me && st.me.admin);
          const b = el('button', 'mini primary-mini' + ((st.player.coins || 0) < price ? ' locked' : ''), '购买');
          b.title = '购买后用金币解锁该槽位，可保存并快速切换钓竿';
          b.addEventListener('click', function () {
            if ((st.player.coins || 0) < price) { toast('金币不足（需 ' + price + '）'); return; }
            confirmModal({ title: '购买钓竿槽位', html: '花费 <b>💰' + price + '</b> 解锁第 ' + (i + 1) + ' 个钓竿槽位？', okText: '确认购买' }).then(function (ok) {
              if (!ok) return;
              call(window.Net.rodBuySlot(), function (r) { return '已解锁第 ' + r.data.rodSlotsCount + ' 个槽位（花费 💰' + r.data.price + '）'; }).then(function (r) {
                if (r && r.ok) { st.player.coins = r.data.coins; st.rodSlotsCount = r.data.rodSlotsCount; st.nextRodSlotPrice = r.data.nextRodSlotPrice; renderTopbar(); renderView(); }
              });
            });
          });
          card.appendChild(b);
        }
      } else if (!slots[i]) {
        card.innerHTML = '<div class="rs-name">槽位 ' + (i + 1) + '</div><div class="rs-sub">空槽位</div>';
        if (activeSlot >= 0) {
          card.appendChild(el('div', 'hint', '当前钓竿已占用槽位 ' + (activeSlot + 1) + '（可直接改名）'));
        } else {
          const b = el('button', 'mini', '保存当前钓竿');
          b.title = '把当前装配的钓竿整体放进该槽位（配件随之锁定），仍可继续使用与改名';
          b.addEventListener('click', function () {
            const parts = Object.keys(st.bd || {}).filter(function (k) { return st.bd[k] && st.bd[k].compId; });
            if (!parts.length) { toast('当前钓竿还没有装配任何组件'); return; }
            promptModal({ title: '保存钓竿到槽位 ' + (i + 1), numeric: false, value: st.rodName || '', okText: '保存', html: '<div class="cf-hint">给这根钓竿起个名字（最多 12 字）。保存后它占用该槽位，配件被锁定，可随时改名或切换。</div>' }).then(function (name) {
              if (name == null) return;
              call(window.Net.rodSave(i, name), '已占用槽位 ' + (i + 1) + '（配件已锁定，可继续使用）').then(function (r) {
                if (r && r.ok) { st.bd = r.data.bd; st.rodName = r.data.rodName; st.rodActiveSlot = r.data.rodActiveSlot; st.rodSlots = r.data.rodSlots; st.rodLocked = r.data.rodLocked; if (r.data.inventory) st.inventory = r.data.inventory; E().refreshEffects(); renderTopbar(); renderView(); }
              });
            });
          });
          card.appendChild(b);
        }
      } else {
        const sl = slots[i];
        const isActive = !!sl.active;
        card.innerHTML = '<div class="rs-name">' + esc(sl.name || ('槽位 ' + (i + 1))) +
          (isActive ? '<span class="rs-active">使用中</span>' : '') + '</div>' +
          '<div class="rs-sub">' + sl.count + ' 件 · 基准价 ' + sl.price + '💰</div>' +
          '<div class="rs-affs">' + rodAffixBadges(sl.affixes) + '</div>';
        const acts = el('div', 'rs-acts');
        const useBtn = el('button', 'mini primary-mini' + (isActive ? ' locked' : ''), isActive ? '使用中' : '使用');
        useBtn.title = isActive ? '这根钓竿正在使用中（槽位保持占用）' : '切换使用这根钓竿（原钓竿留在自己的槽位）';
        if (!isActive) {
          useBtn.addEventListener('click', function () {
            call(window.Net.rodUse(i), '已切换到「' + (sl.name || ('槽位 ' + (i + 1))) + '」').then(function (r) {
              if (r && r.ok) {
                st.bd = r.data.bd; st.rodName = r.data.rodName; st.rodActiveSlot = r.data.rodActiveSlot; st.rodSlots = r.data.rodSlots;
                st.rodLocked = r.data.rodLocked || {}; if (r.data.inventory) st.inventory = r.data.inventory;
                if (r.data.castInfo) { st.castInfo = r.data.castInfo; st.fishingInterval = r.data.castInfo.interval; }
                if (r.data.returned) toast('原散件装配已退回背包 ×' + r.data.returned);
                E().refreshEffects(); renderTopbar(); renderView();
              }
            });
          });
        }
        acts.appendChild(useBtn);
        const rn = el('button', 'mini', '改名');
        rn.addEventListener('click', function () {
          promptModal({ title: '重命名钓竿', numeric: false, value: sl.name || '', okText: '保存' }).then(function (name) {
            if (name == null) return;
            call(window.Net.rodRename(i, name), '已重命名').then(function (r) { if (r && r.ok) { st.rodSlots = r.data.rodSlots; if (r.data.rodName !== undefined) st.rodName = r.data.rodName; renderTopbar(); renderView(); } });
          });
        });
        acts.appendChild(rn);
        const sell = el('button', 'mini', '上架');
        sell.title = '把整根钓竿挂到开放市集（组件随竿一起卖出）';
        sell.addEventListener('click', function () { openListModal(sl.rodId, null, { rodSlot: i, name: sl.name, affixes: sl.affixes, price: sl.price, count: sl.count }); });
        acts.appendChild(sell);
        if (isActive) {
          const stow = el('button', 'mini', '📥 收起');
          stow.title = '收起当前钓竿：卸下装戴但保留在该槽位（配件继续锁定），可接着装配另一根';
          stow.addEventListener('click', function () {
            confirmModal({
              title: '收起当前钓竿',
              html: '当前钓竿「' + esc(st.rodName || '未命名') + '」会卸下装戴但<b>保留在槽位 ' + (i + 1) + '</b>（配件继续锁定），可以接着装配另一根。',
              okText: '收起',
            }).then(function (ok) {
              if (!ok) return;
              call(window.Net.rodStow(), '已卸下装戴（钓竿仍保留在槽位 ' + (i + 1) + '）').then(function (r) {
                if (r && r.ok) {
                  st.bd = r.data.bd; st.rodName = r.data.rodName; st.rodActiveSlot = r.data.rodActiveSlot;
                  st.rodSlots = r.data.rodSlots; st.rodLocked = r.data.rodLocked || {};
                  if (r.data.inventory) st.inventory = r.data.inventory;
                  if (r.data.castInfo) { st.castInfo = r.data.castInfo; st.fishingInterval = r.data.castInfo.interval; }
                  E().refreshEffects(); renderTopbar(); renderView();
                }
              });
            });
          });
          acts.appendChild(stow);
        }
        const del = el('button', 'mini danger-mini', '删除');
        del.title = '删除存档：配件退回背包（解除锁定）';
        del.addEventListener('click', function () {
          confirmModal({ title: '删除钓竿存档', html: '删除「' + esc(sl.name || ('槽位 ' + (i + 1))) + '」？<br>该钓竿的 ' + sl.count + ' 件组件会退回背包（可再次交易）。', okText: '删除', danger: true }).then(function (ok) {
            if (!ok) return;
            call(window.Net.rodDelete(i), function (r) {
              return r.data.wasActive ? '已解除该槽位占用（钓竿仍在使用中）' : '已删除存档，配件已退回背包';
            }).then(function (r) {
              if (r && r.ok) {
                st.rodSlots = r.data.rodSlots; st.rodLocked = r.data.rodLocked || {};
                if (r.data.rodActiveSlot !== undefined) st.rodActiveSlot = r.data.rodActiveSlot;
                if (r.data.inventory) st.inventory = r.data.inventory;
                renderTopbar(); renderView();
              }
            });
          });
        });
        acts.appendChild(del);
        card.appendChild(acts);
      }
      grid.appendChild(card);
    }
    wrap.appendChild(grid);
    strip.appendChild(wrap);
    return wrap;
  }

  function renderBD() {
    const main = $('main');
    const st = S();
    main.innerHTML = '';
    const panel = el('div', 'panel wide');
    panel.innerHTML = '<h2>🎯 钓竿配置 <span class="subtitle">装备组件获得词缀加成 · 存档并命名多根钓竿随时切换</span></h2>';
    renderRodSlots(panel);

    // 加成总览（与 Engine 的钓鱼逻辑同源）
    const eff = E().bdEffects();
    const effDefs = [['speed', '⚡ 钓速'], ['skill', '🎯 技巧'], ['rare', '✨ 稀有'], ['material', '🧵 材料'], ['size', '📏 体型'], ['double', '🎣 双钓']];
    const strip = el('div', 'eff-strip');
    let any = false;
    effDefs.forEach(function (kv) {
      const v = eff[kv[0]];
      if (!v) return;
      any = true;
      // 负值只显示一个 − 号，且整体加成为负时红底标注
      strip.appendChild(el('span', 'eff-chip' + (v < 0 ? ' eff-neg' : ''), kv[1] + ' ' + (v > 0 ? '+' : '') + v + '%'));
    });
    if (!any) strip.appendChild(el('span', 'eff-chip none', '暂无加成 · 装备组件后生效'));
    panel.appendChild(strip);

    const grid = el('div', 'bd-grid');
    D.ROD_PARTS.forEach(function (part) {
      const cur = st.bd[part.key] || {};
      const comp = D.componentOf(cur.compId);
      const cell = el('div', 'bd-cell' + (part.isCharm ? ' charm' : '') + (comp ? ' equipped' : ''));
      const affHtml = comp
        ? comp.affixes.map(function (a) { return '<div class="af-line on' + (a.value < 0 ? ' aff-neg' : '') + '">' + esc(affixText(a)) + '</div>'; }).join('')
        : '<div class="af-line"><span class="muted">标准 · 无加成</span></div>';
      // 组件图标：装备中显示底材贴图（assets/item/<baseId>.png），未装备显示通用组件螺母
      const bdIcon = comp
        ? '<img class="bd-icon" src="assets/item/' + esc(comp.baseId || '') + '.png" alt="" draggable="false">'
        : '<img class="bd-icon std" src="assets/item/comp_generic.png" alt="" draggable="false">';
      cell.innerHTML =
        '<div class="bd-part">' + esc(part.name) + (part.isCharm ? ' <span class="charm-tag">饰品</span>' : '') + '</div>' +
        bdIcon +
        '<div class="bd-comp ' + (comp ? qualityClass(comp) : '') + '">' + esc(comp ? comp.name : part.default.name) + itemTag(comp) + '</div>' +
        '<div class="affix-frame">' + affHtml + '</div>';
      const acts = el('div', 'bd-acts');
      if (comp) {
        const off = el('button', 'mini', '卸下');
        off.title = '卸下并恢复标准' + part.name;
        off.addEventListener('click', function () { setPart(part.key, null); });
        acts.appendChild(off);
      }
      // 背包中该部位的可用组件
      const owns = Object.keys(st.inventory).filter(function (id) {
        const c = D.componentOf(id);
        return c && c.part === part.key && st.inventory[id] > 0;
      });
      if (owns.length) {
        const btn = el('button', 'mini primary-mini', '装备组件');
        btn.addEventListener('click', function () { openBdEquipModal(part.key); });
        acts.appendChild(btn);
      } else {
        acts.appendChild(el('span', 'muted tiny', '背包暂无该部位组件'));
      }
      cell.appendChild(acts);
      grid.appendChild(cell);
    });
    panel.appendChild(grid);
    panel.appendChild(el('div', 'note-block',
      '<b>组件怎么获得？</b>钓鱼时有概率钓到各部位组件（稀有/史诗更少见）。' +
      '<b>装备取用</b>：安装会从背包取用 1 件该组件，加成持续生效并在服务器实时结算（正在钓鱼时钓速也会立即调整）。'));
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
      const buffCount = (g.spots || []).filter(function (sp) { return sp.buffs && sp.buffs.length; }).length;
      const box = el('div', 'gc-box' + (g.locked ? ' locked' : '') + (c > 0 ? ' live' : '') + (groundFilterId === g.id ? ' sel' : '') + (buffCount ? ' has-buff' : ''));
      box.innerHTML = '<div class="gcb-name">' + esc(g.name) + (buffCount ? ' <span class="spot-buff-mark" title="有 ' + buffCount + ' 个钓点带增益">⚡</span>' : '') + '</div>' +
        '<div class="gcb-num">' + c + '<span class="u">人</span></div>' +
        (g.locked ? '' : '<div class="gcb-hint">' + (buffCount ? '⚡ ' + buffCount + ' 个钓点有增益' : '点击查看') + '</div>');
      if (!g.locked) {
        box.title = '点击查看「' + g.name + '」的动态' + (buffCount ? '（' + buffCount + ' 个钓点带增益）' : '');
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
        esc(e.ground) + '·' + esc(e.spot) + ' 钓到 <span class="' + qualityClass(meta) + '">' + esc(meta.name) + '</span>' +
        (e.size ? ' <span class="muted">' + e.size + 'cm</span>' : '') +
        (e.record ? ' 🏆刷新纪录' : meta.rarity === 'epic' ? ' 💎史诗' : meta.rarity === 'rare' ? ' ✨稀有' : meta.kind === 'component' ? ' 🔧组件' : '');
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
  // 出售数量：对整个系统商店生效，直到下一次被修改（模块级，重绘与切换页面都保留）
  let sellQty = 1;
  let shopAuto = { loaded: false, all: null, fish: {} }; // 自动售出规则（来自服务器）
  let shopCat = 'all'; let shopOwnedOnly = false; let shopAutoOnly = false; let shopSort = 'default'; let shopSortDir = 'desc'; // 商店筛选/排序（再点同键反向）

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

  // ---- 上架弹窗：价格走势 + 数量/单价/时长 + 费用实时预览 ----
  const LIST_PLANS = { 6: '1%', 12: '3%', 24: '5%' };
  let listModalId = null;

  // onListed：可选回调，上架成功后调用（装备子窗口用它回到原界面继续挑选）
  // rodInfo：整根钓竿模式（{rodSlot, name, affixes, price, count}）——数量固定 1，组件随竿卖出
  function openListModal(id, onListed, rodInfo) {
    listModalId = id;
    const st = S();
    const meta = itemMeta(id);
    const isRod = !!(rodInfo && rodInfo.rodSlot != null);
    const have = isRod ? 1 : (st.inventory[id] || 0);
    document.querySelectorAll('.modal-overlay').forEach(function (m) { m.remove(); });
    const overlay = el('div', 'modal-overlay');
    overlay.addEventListener('click', function (ev) { if (ev.target === overlay) closeListModal(); });
    const box = el('div', 'modal-box shop-modal');
    box.innerHTML =
      '<div class="modal-head"><span class="modal-title">🏷️ 上架 ' + esc(isRod ? (rodInfo.name ? rodInfo.name + ' · 整根钓竿' : '整根钓竿') : meta.name) + (isRod ? '（' + rodInfo.count + ' 件组件）' : '（持有 ' + have + '）') + '</span><button class="mini modal-close">✕ 关闭</button></div>' +
      '<div class="modal-body">' +
      (isRod ? '<div class="lm-rod">' + rodAffixBadges(rodInfo.affixes) + '</div><div class="hint" style="margin-bottom:8px">整根钓竿按 1 件整体出售，组件随竿交给买家（买家收到的是背包中的组件，可自行组装）。</div>' : '') +
      '<div class="lm-trend" id="list-trend">价格走势加载中…</div>' +
      '<div class="lm-row"><label>出售数量</label><input type="number" id="list-qty" class="bulk-select" min="1" max="' + have + '" value="1"' + (isRod ? ' disabled' : '') + ' /></div>' +
      '<div class="lm-row"><label>单价（💰）</label><input type="number" id="list-price" class="bulk-select" min="1" value="' + Math.max(1, Math.round((isRod ? (rodInfo.price || meta.price) : (st.shop && st.shop[id] ? st.shop[id].price : meta.price)) * (isRod ? 1 : 2))) + '" /></div>' +
      '<div class="lm-row"><label>挂单时长</label><span id="list-hours">' +
      [[6, '6 小时 · 1%'], [12, '12 小时 · 3%'], [24, '24 小时 · 5%']].map(function (kv) {
        return '<button class="mini lm-hours' + (kv[0] === 6 ? ' on' : '') + '" data-h="' + kv[0] + '">' + kv[1] + '</button>';
      }).join('') + '</span></div>' +
      '<div class="bulk-est" id="list-est">—</div>' +
      '<button class="primary" id="list-confirm">确认上架</button>' +
      '<div class="hint" style="margin-top:8px">上架费 = 定价总额 × 时长费率，下架/过期均不退费；过期后物品自动退回背包。</div>' +
      '</div>';
    box.querySelector('.modal-close').addEventListener('click', function () { closeListModal(); });
    overlay.appendChild(box);
    document.body.appendChild(overlay);

    const recalc = function () {
      const qty = parseInt(document.getElementById('list-qty').value, 10) || 0;
      const price = parseInt(document.getElementById('list-price').value, 10) || 0;
      const hBtn = box.querySelector('.lm-hours.on');
      const hours = hBtn ? parseInt(hBtn.getAttribute('data-h'), 10) : 6;
      const rate = { 6: 0.01, 12: 0.03, 24: 0.05 }[hours];
      const fee = Math.ceil(price * qty * rate);
      document.getElementById('list-est').innerHTML =
        '上架费 <b>' + fee + '</b>💰（费率 ' + Math.round(rate * 100) + '% · ' + hours + ' 小时）<span class="muted"> · 下架/过期不退</span>';
    };
    box.querySelectorAll('.lm-hours').forEach(function (b) {
      b.addEventListener('click', function () {
        box.querySelectorAll('.lm-hours').forEach(function (x) { x.classList.remove('on'); });
        b.classList.add('on');
        recalc();
      });
    });
    document.getElementById('list-qty').addEventListener('input', recalc);
    document.getElementById('list-price').addEventListener('input', recalc);
    recalc(); // 打开即按默认数量/单价/时长算出上架费（不必等用户改动）
    document.getElementById('list-confirm').addEventListener('click', function () {
      const qty = parseInt(document.getElementById('list-qty').value, 10) || 0;
      const price = parseInt(document.getElementById('list-price').value, 10) || 0;
      const hBtn = box.querySelector('.lm-hours.on');
      const hours = hBtn ? parseInt(hBtn.getAttribute('data-h'), 10) : 6;
      if (qty <= 0 || price <= 0) { toast('请填写有效的数量与单价'); return; }
      const req = isRod
        ? window.Net.marketListRod(rodInfo.rodSlot, price, hours)
        : window.Net.marketList(id, Math.min(qty, have), price, hours);
      call(req, function (r) {
        return '已上架 ' + (isRod ? (rodInfo.name || '整根钓竿') : meta.name) + ' ×' + r.data.listing.qty + '（上架费 ' + r.data.fee + '💰 · ' + hours + ' 小时）';
      }).then(function (r) {
        if (r && r.ok) {
          closeListModal();
          if (r.data.inventory) st.inventory = r.data.inventory;
          st.player.coins = r.data.coins;
          if (r.data.rodSlots) st.rodSlots = r.data.rodSlots;
          renderTopbar(); renderView();
          if (typeof onListed === 'function') onListed();
        }
      });
    });

    // 价格走势（组件/整竿为固定价，无供需行情）
    if (meta.kind === 'component' || isRod) {
      const t0 = document.getElementById('list-trend');
      if (t0) t0.innerHTML = '<div class="sd-legend">' + (isRod
        ? '整根钓竿参考价 = 各组件基准价合计 ' + (rodInfo.price || meta.price) + '💰（可自由定价）'
        : '组件为固定价道具（按品质定价，不随市场浮动）：参考价 ' + meta.price + '💰') + '</div>';
      return;
    }
    window.Net.shopHistory(id).then(function (r) {
      const t = document.getElementById('list-trend');
      if (!t || listModalId !== id) return;
      t.innerHTML = '';
      const pts = ((r && r.ok && r.data.points) || []).slice(-60);
      if (pts.length >= 2) {
        const prices = pts.map(function (x) { return x.p; }).concat([meta.price]);
        const maxP = Math.max.apply(null, prices), minP = Math.min.apply(null, prices);
        const spark = el('div', 'sd-spark');
        pts.forEach(function (pt) {
          const h = maxP === minP ? 50 : Math.round(10 + 90 * (pt.p - minP) / (maxP - minP));
          const bar = el('i', pt.p >= meta.price ? 'up' : 'down');
          bar.style.height = h + '%';
          spark.appendChild(bar);
        });
        t.appendChild(spark);
        t.appendChild(el('div', 'sd-legend', '系统收购价近 ' + recentLen(pts) + ' 分钟走势 · 红=不低于基准 · 蓝=低于基准'));
      } else {
        t.appendChild(el('div', 'sd-legend', '暂无足够价格采样（服务器每分钟记录一次）。'));
      }
    });
  }
  function recentLen(pts) { return pts.length; }
  function closeListModal() {
    listModalId = null;
    document.querySelectorAll('.modal-overlay').forEach(function (m) { m.remove(); });
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
        const sampleSec = (S() && S().priceCfg && S().priceCfg.sampleSec) || 60;
        body.appendChild(el('div', 'sd-legend', '近 ' + spanMin + ' 分钟（每 ' + sampleSec + ' 秒一采样） · 红=不低于基准 · 蓝=低于基准'));
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

  // 商店头部文案：跟随后台经济参数（world.priceCfg 经 /api/version 与 pricecfg 广播同步）
  function shopSubtitle() {
    const c = (S() && S().priceCfg) || null;
    const divisorPct = c && c.saleDivisor != null ? (c.saleDivisor * 100) : 0.75;
    const tauMin = c && c.riseTauMin != null ? c.riseTauMin : 60;
    const targetX = c && c.riseTargetPct != null ? (c.riseTargetPct / 100) : 2;
    const tauText = tauMin >= 60 ? (Math.round(tauMin / 6) / 10) + ' 小时' : Math.round(tauMin) + ' 分钟';
    const fmtPct = Math.round(divisorPct * 100) / 100;
    return '供需定价 · 单乘数模型：每卖一件约 -' + fmtPct + '% · 闲置时以 ' + tauText + ' 为时间常数向 ' + targetX + ' 倍靠拢 · 点击商品查看走势与交易流水';
  }

  function renderShop() {
    const st = S();
    const main = $('main');
    // 首次进店：先拉自动售出规则，避免面板显示成「未设置」
    if (!shopAuto.loaded) {
      // 占位面板不带 id：否则规则拉取完成后会误判「骨架已建」而跳过，商店只剩「加载中…」
      main.innerHTML = '';
      const p0 = el('div', 'panel wide');
      p0.textContent = '加载中…';
      main.appendChild(p0);
      window.Net.autoSellGet().then(function (r) {
        if (r && r.ok) { shopAuto.loaded = true; shopAuto.all = r.data.all; shopAuto.fish = r.data.fish || {}; }
        if (currentView === 'shop') renderShop();
      }).catch(function () {});
      return;
    }
    // 骨架只在进入视图时建一次；上鱼/行情广播（shop/assets）只刷新网格与右栏列表，
    // 自动售出面板的输入框不再被广播清掉（此前与「后台输入被自动刷新清空」同源的老毛病）。
    if (!document.querySelector('#shop-panel .shop-grid')) {
      const panel = el('div', 'panel wide');
      panel.id = 'shop-panel';
      panel.innerHTML = '<h2>🏪 系统商店 <span class="subtitle" id="shop-sub">' + shopSubtitle() + '</span></h2>';
      const cols = el('div', 'shop-cols');
      const colMain = el('div', 'shop-colmain');

      // —— 出售数量（全局生效，模块级保留）——
      const qtyBar = el('div', 'shop-qtybar');
      qtyBar.innerHTML = '<span class="sqb-label">出售数量</span>';
      const minus = el('button', 'sqb-btn', '−');
      const qnum = el('input', 'sqb-num');
      qnum.type = 'number'; qnum.min = '1'; qnum.value = String(sellQty);
      const plus = el('button', 'sqb-btn', '+');
      function setQty(v) {
        v = Math.max(1, Math.min(9999, Math.floor(Number(v) || 1)));
        sellQty = v;
        if (qnum.value !== String(v)) qnum.value = String(v);
      }
      minus.addEventListener('click', function () { setQty(sellQty - 1); });
      plus.addEventListener('click', function () { setQty(sellQty + 1); });
      qnum.addEventListener('input', function () { setQty(qnum.value); });
      qnum.addEventListener('blur', function () { setQty(qnum.value); });
      qtyBar.appendChild(minus); qtyBar.appendChild(qnum); qtyBar.appendChild(plus);
      qtyBar.appendChild(el('span', 'sqb-hint', '该数量对全商店生效，直到你再次修改'));
      colMain.appendChild(qtyBar);

      // —— 筛选栏（类别 / 持有 / 自动售出 / 排序；模块级保留）——
      const fbar = el('div', 'shop-fbar');
      fbar.appendChild(el('span', 'bf-sort-label', '类别'));
      [['all', '全部'], ['fish', '🐟 鱼'], ['material', '🧵 材料']].forEach(function (kv) {
        const b = el('button', 'bf-cat' + (shopCat === kv[0] ? ' on' : ''), kv[1]);
        b.setAttribute('data-sc', kv[0]);
        b.addEventListener('click', function () { if (shopCat !== kv[0]) { shopCat = kv[0]; renderShop(); } });
        fbar.appendChild(b);
      });
      const ownChk = (function () {
        const l = el('label', 'chk'); const c = el('input'); c.type = 'checkbox'; c.checked = !!shopOwnedOnly;
        l.appendChild(c); l.appendChild(el('span', null, '仅显示我持有的'));
        return { wrap: l, box: c };
      })();
      ownChk.box.addEventListener('change', function () { shopOwnedOnly = ownChk.box.checked; renderShop(); });
      fbar.appendChild(ownChk.wrap);
      const autoChk = (function () {
        const l = el('label', 'chk'); const c = el('input'); c.type = 'checkbox'; c.checked = !!shopAutoOnly;
        l.appendChild(c); l.appendChild(el('span', null, '🤖 仅显示已设自动售出'));
        return { wrap: l, box: c };
      })();
      autoChk.box.addEventListener('change', function () { shopAutoOnly = autoChk.box.checked; renderShop(); });
      fbar.appendChild(autoChk.wrap);
      fbar.appendChild(el('span', 'bf-sort-label', '排序'));
      [['default', '目录顺序'], ['price', '价格'], ['pct', '涨幅'], ['have', '持有']].forEach(function (kv) {
        const active = shopSort === kv[0];
        const arrow = (active && kv[0] !== 'default') ? (shopSortDir === 'desc' ? ' ↓' : ' ↑') : '';
        const b = el('button', 'bf-cat' + (active ? ' on' : ''), kv[1] + arrow);
        b.setAttribute('data-ss', kv[0]);
        b.setAttribute('data-label', kv[1]);
        b.title = kv[0] === 'default' ? '' : '再次点击可反向排序';
        b.addEventListener('click', function () {
          if (shopSort === kv[0]) { if (kv[0] !== 'default') shopSortDir = shopSortDir === 'desc' ? 'asc' : 'desc'; }
          else { shopSort = kv[0]; shopSortDir = 'desc'; }
          renderShop();
        });
        fbar.appendChild(b);
      });
      colMain.appendChild(fbar);

      // —— 商品网格（广播只刷新这一块）——
      const grid = el('div', 'shop-grid');
      colMain.appendChild(grid);

      // —— 右栏：自动售出管理 ——
      const colSide = el('div', 'shop-colside');
      const asPanel = el('div', 'shop-autosell');
      asPanel.id = 'shop-as-panel';
      const a = shopAuto.all;
      asPanel.innerHTML =
        '<div class="sa-head"><b>🤖 自动售出</b></div>' +
        '<div class="hint" style="margin-bottom:8px">满足任一条件时，背包里的鱼按系统行情自动卖出（钓到即卖；价格闲置回升越过阈值也会卖）。</div>' +
        '<label class="sa-switch"><input type="checkbox" id="sa-all-on"' + (a ? ' checked' : '') + '><span>全部鱼自动售出</span></label>' +
        '<div class="sa-fld" style="margin-top:6px">基准 ≥ <input id="sa-pct" class="ipt mk-num" type="number" min="1" value="' + (a && a.minPct != null ? a.minPct : '') + '" placeholder="如 150">%</div>' +
        '<div class="sa-fld">价格 ≥ <input id="sa-price" class="ipt mk-num" type="number" min="1" value="' + (a && a.minPrice != null ? a.minPrice : '') + '" placeholder="如 200">💰</div>' +
        '<div class="sa-fld" title="行情在阈值附近回落时，允许提前「阈值 − 浮动」成交，避免错过">浮动：百分比 − <input id="sa-slack-pct" class="ipt mk-num" type="number" min="0" value="' + (a && a.slackPct != null ? a.slackPct : 0) + '">%</div>' +
        '<div class="sa-fld">价格 − <input id="sa-slack-price" class="ipt mk-num" type="number" min="0" value="' + (a && a.slackPrice != null ? a.slackPrice : 0) + '">💰</div>' +
        '<div class="sa-row" style="margin-top:8px">' +
        '<button class="btn mini primary" id="sa-save">保存全部鱼规则</button>' +
        '<button class="btn mini" id="sa-clear">清除</button></div>' +
        '<div id="sa-state" class="hint" style="margin-top:6px">' + esc(allRuleText()) + '</div>';
      colSide.appendChild(asPanel);
      colSide.appendChild(el('div', 'cd-sub', '🐟 逐鱼设置（单独设置优先于全部鱼）'));
      colSide.appendChild(el('div', 'hint', '每条鱼可单独设阈值；列表按目录顺序，价格随行情实时更新。'));
      const asList = el('div', 'as-list');
      asList.id = 'as-list';
      colSide.appendChild(asList);
      cols.appendChild(colMain);
      cols.appendChild(colSide);
      panel.appendChild(cols);
      main.innerHTML = '';
      main.appendChild(panel);

      // —— 事件绑定（骨架一次，随骨架存活）——
      asPanel.querySelector('#sa-save').onclick = function () {
        const on = asPanel.querySelector('#sa-all-on').checked;
        const pct = asPanel.querySelector('#sa-pct').value;
        const pri = asPanel.querySelector('#sa-price').value;
        if (on && pct === '' && pri === '') { toast('请至少填写一个阈值（基准百分比或价格）', true); return; }
        const spct = asPanel.querySelector('#sa-slack-pct').value;
        const spri = asPanel.querySelector('#sa-slack-price').value;
        window.Net.autoSellSet('all', on && pct !== '' ? pct : null, on && pri !== '' ? pri : null,
          on && pct !== '' ? (spct === '' ? 0 : spct) : 0, on && pri !== '' ? (spri === '' ? 0 : spri) : 0).then(function (r) {
          if (!r || !r.ok) { toast((r && r.data.error) || '保存失败', true); return; }
          shopAuto.all = r.data.all; shopAuto.fish = r.data.fish || {};
          const stateEl = document.getElementById('sa-state');
          if (stateEl) stateEl.textContent = allRuleText();
          if (r.data.sold) toast('规则已生效：' + r.data.sold.length + ' 种鱼达标并自动售出');
          else toast('全部鱼自动售出规则已保存');
          renderShopSide(); renderShopGrid();
        });
      };
      asPanel.querySelector('#sa-clear').onclick = function () {
        window.Net.autoSellSet('all', null, null).then(function (r) {
          if (!r || !r.ok) { toast((r && r.data.error) || '清除失败', true); return; }
          shopAuto.all = null;
          const stateEl = document.getElementById('sa-state');
          if (stateEl) stateEl.textContent = allRuleText();
          toast('已清除全部鱼规则');
          renderShopSide(); renderShopGrid();
        });
      };
    }

    // 广播刷新：只重建网格与右栏列表，不动输入框；头部文案跟随经济参数变化
    const subEl = document.getElementById('shop-sub');
    if (subEl) subEl.textContent = shopSubtitle();
    renderShopSide();
    renderShopGrid();
  }

  // 右栏逐鱼规则列表（按钮行，无输入框，可安全随广播重绘）
  function renderShopSide() {
    const st = S();
    const box = document.getElementById('as-list');
    if (!box) return;
    const ids = Object.keys(st.shop || {}).filter(function (id) { return itemMeta(id).kind === 'fish'; });
    if (!ids.length) { box.innerHTML = '<div class="hint">商店暂无鱼类。</div>'; return; }
    box.innerHTML = ids.map(function (id) {
      const s = st.shop[id];
      const meta = itemMeta(id);
      const pct = s.base ? Math.round(s.price / s.base * 100) : 100;
      const have = st.inventory[id] || 0;
      const own = shopAuto.fish[id];
      const covered = !own && shopAuto.all;
      const status = own ? ('🤖 ' + esc(autoRuleText(id, 'fish'))) : (covered ? '🤖 全部鱼规则' : '未设置');
      return '<div class="as-row' + (own ? ' on' : '') + '">' +
        '<span class="as-name ' + rarityClass(meta.rarity) + '">' + esc(meta.name) + '</span>' +
        '<span class="as-meta">💰' + s.price + ' · ' + pct + '% · 持有' + have + '</span>' +
        '<span class="as-rule">' + status + '</span>' +
        '<button class="mini' + (own ? ' primary-mini' : '') + '" data-as="' + esc(id) + '" title="设置该鱼的自动售出规则">设置</button></div>';
    }).join('');
    box.querySelectorAll('[data-as]').forEach(function (b) {
      b.addEventListener('click', function () { openShopAutoModal(b.getAttribute('data-as')); });
    });
  }

  // 商品网格 + 筛选状态（广播只刷新这一块；面板/筛选栏输入不受影响）
  function renderShopGrid() {
    const st = S();
    const grid = document.querySelector('#shop-panel .shop-grid');
    const fbar = document.querySelector('#shop-panel .shop-fbar');
    if (!grid || !fbar) return;
    // 同步筛选控件选中态（chips 点击后本地更新；广播重绘时按模块状态恢复）
    fbar.querySelectorAll('.bf-cat[data-sc]').forEach(function (b) { b.classList.toggle('on', b.getAttribute('data-sc') === shopCat); });
    fbar.querySelectorAll('.bf-cat[data-ss]').forEach(function (b) {
      const k = b.getAttribute('data-ss');
      b.classList.toggle('on', k === shopSort);
      if (k !== 'default') {
        const base = b.getAttribute('data-label') || b.textContent.replace(/ [↓↑]$/, '');
        b.textContent = base + (k === shopSort ? (shopSortDir === 'desc' ? ' ↓' : ' ↑') : '');
      }
    });
    let entries = Object.keys(st.shop || {}).map(function (id) {
      return { id: id, s: st.shop[id], meta: itemMeta(id), have: st.inventory[id] || 0 };
    });
    if (shopCat !== 'all') entries = entries.filter(function (o) { return o.meta.kind === shopCat; });
    if (shopOwnedOnly) entries = entries.filter(function (o) { return o.have > 0; });
    if (shopAutoOnly) entries = entries.filter(function (o) { return hasAutoRule(o.id, o.meta.kind); });
    const sdir = shopSortDir === 'asc' ? -1 : 1; // 基础比较式 (y-x) 已是降序，升序时才翻转
    if (shopSort === 'price') entries.sort(function (x, y) { return (y.s.price - x.s.price) * sdir; });
    if (shopSort === 'pct') entries.sort(function (x, y) { return ((y.s.price / (y.s.base || 1)) - (x.s.price / (x.s.base || 1))) * sdir; });
    if (shopSort === 'have') entries.sort(function (x, y) { return (y.have - x.have) * sdir; });
    grid.innerHTML = '';
    entries.forEach(function (o) {
      const id = o.id, s = o.s, meta = o.meta, have = o.have;
      const ratio = s.base ? s.price / s.base : 1;
      const pct = Math.round(ratio * 100);
      const cls = ratio < 0.75 ? 'low' : ratio < 0.95 ? 'mid' : 'high';
      const card = el('div', 'shop-card' + (hasAutoRule(id, meta.kind) ? ' has-auto' : ''));
      const fillPct = Math.max(6, Math.min(100, pct));
      const upPct = pct > 100 ? Math.min(100, pct - 100) : 0;
      const autoTag = hasAutoRule(id, meta.kind)
        ? '<span class="sc-auto" title="该鱼设置了自动售出规则">🤖 ' + esc(autoRuleText(id, meta.kind)) + '</span>' : '';
      card.innerHTML =
        '<div class="sc-name ' + rarityClass(meta.rarity) + '">' + esc(meta.name) +
        '<span class="sc-kind">' + esc(qualityName(meta)) + '</span>' + autoTag + '</div>' +
        '<div class="sc-price ' + cls + '">💰 ' + s.price + '<span class="base">基准 ' + s.base + '</span></div>' +
        '<div class="sc-bar"><i class="up" style="width:' + upPct + '%"></i><i style="width:' + fillPct + '%"></i></div>' +
        '<div class="sc-pct">当前 ' + pct + '% · 持有 ' + have + ' · 今日售出 ' + (s.soldToday || 0) + '</div>';
      card.title = '点击查看价格走势与交易量';
      const sellN = Math.min(sellQty, have);
      const btn = el('button', 'mini' + (have > 0 ? ' primary-mini' : ' locked'), have > 0 ? ('出售 ' + sellN + ' 个') : '无库存');
      btn.addEventListener('click', function (ev) {
        ev.stopPropagation();
        if (!(st.inventory[id] > 0)) return;
        const n = Math.min(sellQty, st.inventory[id]);
        call(window.Net.sell(id, n), function (r) { return '售出 ' + meta.name + ' ×' + n + '，获得 💰' + r.data.gain + '（单价 ' + r.data.unit + '）'; })
          .then(function (r) { if (r && r.ok) { st.player.coins = r.data.coins; st.inventory = r.data.inventory; st.shop = r.data.shop; renderTopbar(); renderShop(); } });
      });
      card.appendChild(btn);
      card.addEventListener('click', function () { openShopModal(id); });
      grid.appendChild(card);
    });
    if (!entries.length) grid.appendChild(el('div', 'hint', '没有符合筛选条件的商品。'));
  }


  // 自动售出：规则判断与文案（商店卡片共用）
  function hasAutoRule(id, kind) {
    if (kind !== 'fish') return false;
    return !!(shopAuto.fish[id] || shopAuto.all);
  }
  function autoRuleText(id, kind) {
    const r = shopAuto.fish[id] || shopAuto.all;
    if (!r) return '';
    const parts = [];
    if (r.minPct != null) parts.push('基准≥' + Math.max(1, r.minPct - (r.slackPct || 0)) + '%');
    if (r.minPrice != null) parts.push('价格≥' + Math.max(1, r.minPrice - (r.slackPrice || 0)));
    return parts.join(' 或 ');
  }
  function allRuleText() {
    if (!shopAuto.all) return '未启用（仅设置单条鱼也可用）';
    return '已启用（' + autoRuleText('all', 'fish') + '）';
  }
  // 单鱼自动售出设置弹窗
  function openShopAutoModal(id) {
    const meta = itemMeta(id);
    const cur = shopAuto.fish[id] || null;
    closeOverlays();
    const overlay = buildOverlay(function () { closeOverlays(); });
    const box = el('div', 'modal-box confirm-modal');
    box.innerHTML = '<div class="modal-head"><span class="modal-title">🤖 自动售出 · ' + esc(meta.name) + '</span></div>' +
      '<div class="modal-body">' +
      '<div class="hint" style="margin-bottom:8px">当前价达到任一条件时，背包里的「' + esc(meta.name) + '」按系统行情自动卖出（单独设置优先于「全部鱼」规则）。</div>' +
      '<div class="mgr-row"><label>基准 ≥</label><input id="as-pct" class="ipt mk-num" type="number" min="1" value="' + (cur && cur.minPct != null ? cur.minPct : '') + '" placeholder="如 150" /><span class="hint">%（基准价的百分比）</span></div>' +
      '<div class="mgr-row"><label>价格 ≥</label><input id="as-price" class="ipt mk-num" type="number" min="1" value="' + (cur && cur.minPrice != null ? cur.minPrice : '') + '" placeholder="如 200" /><span class="hint">💰（绝对价格）</span></div>' +
      '<div class="mgr-row"><label>浮动</label><input id="as-slack-pct" class="ipt mk-num" type="number" min="0" value="' + (cur && cur.slackPct != null ? cur.slackPct : 0) + '" /><span class="hint">%（百分比线提前量）</span>' +
      '<input id="as-slack-price" class="ipt mk-num" type="number" min="0" value="' + (cur && cur.slackPrice != null ? cur.slackPrice : 0) + '" /><span class="hint">💰（价格线提前量）</span></div>' +
      '<div class="hint" style="margin:6px 0">浮动 = 行情在阈值附近回落时的可接受提前量：达到「阈值 − 浮动」即卖出。两项都留空 = 只受「全部鱼」规则控制。</div>' +
      '<div class="cf-actions"><button class="btn mini cf-no">取消</button>' +
      '<button class="btn mini danger" id="as-clear">清除单鱼规则</button>' +
      '<button class="btn primary" id="as-save">保存</button></div>' +
      '</div></div>';
    overlay.appendChild(box);
    document.body.appendChild(overlay);
    overlay.addEventListener('click', function (e) { if (e.target === overlay) closeOverlays(); });
    box.querySelector('.cf-no').onclick = function () { closeOverlays(); };
    box.querySelector('#as-save').onclick = function () {
      const pct = box.querySelector('#as-pct').value;
      const pri = box.querySelector('#as-price').value;
      if (pct === '' && pri === '') { toast('请至少填写一个阈值，或用「清除单鱼规则」', true); return; }
      const spct = box.querySelector('#as-slack-pct').value;
      const spri = box.querySelector('#as-slack-price').value;
      window.Net.autoSellSet(id, pct !== '' ? pct : null, pri !== '' ? pri : null,
        pct !== '' ? (spct === '' ? 0 : spct) : 0, pri !== '' ? (spri === '' ? 0 : spri) : 0).then(function (r) {
        if (!r || !r.ok) { toast((r && r.data.error) || '保存失败', true); return; }
        shopAuto.all = r.data.all; shopAuto.fish = r.data.fish || {}; shopAuto.loaded = true;
        toast('已保存：' + meta.name + (r.data.sold ? '（当前已达标并自动售出）' : ''));
        closeOverlays(); renderView();
      });
    };
    box.querySelector('#as-clear').onclick = function () {
      window.Net.autoSellSet(id, null, null).then(function (r) {
        if (!r || !r.ok) { toast((r && r.data.error) || '清除失败', true); return; }
        shopAuto.fish = r.data.fish || {}; toast('已清除 ' + meta.name + ' 的单鱼规则');
        closeOverlays(); renderView();
      });
    };
  }

  // ---- 开放市集视图 ----
  // 当前页签与购买市场筛选状态（模块级：重绘间保留）
  let marketTab = 'buy';
  let buyCategory = 'all';
  let buySearch = '';
  let buySearchFocus = false;
  let buySort = { key: 'time', dir: 'desc' };
  let buyAffixType = 'all';   // 组件词条类型筛选：all / speed / big / ...
  let buyAffixMin = '';       // 该词条的最小数值（含），空 = 不限
  let buyAffixMax = '';       // 该词条的最大数值（含），空 = 不限
  let buyOnlyComponents = true; // 词条筛选仅在组件上生效，此开关便于混合搜索
  let marketFilterActive = false; // 市集筛选控件获得焦点时暂停广播重绘（防止下拉框被刷新关闭）
  // 一个挂单是否满足「词条类型 + 数值区间」筛选。非组件挂单：仅在筛选为 all 时通过。
  function listingMatchesAffix(l) {
    if (buyAffixType === 'all' && buyAffixMin === '' && buyAffixMax === '') return true;
    const meta = itemMeta(l.id);
    if ((meta.kind !== 'component' && meta.kind !== 'rod') || !meta.affixes) return false;
    return meta.affixes.some(function (a) {
      if (buyAffixType !== 'all' && a.type !== buyAffixType) return false;
      if (buyAffixMin !== '' && a.value < Number(buyAffixMin)) return false;
      if (buyAffixMax !== '' && a.value > Number(buyAffixMax)) return false;
      return true;
    });
  }
  function affixFilterActive() { return buyAffixType !== 'all' || buyAffixMin !== '' || buyAffixMax !== ''; }

  // 挂单行：自己的显示「下架」，他人的显示「购买」（seller 为小写 key，比对做大小写免疫）
  function marketRow(l, st, me) {
    const meta = itemMeta(l.id);
    const mine = !!(me && me.id != null && String(l.seller).toLowerCase() === String(me.id).toLowerCase());
    const total = l.price * l.qty;
    const row = el('div', 'mk-row' + (mine ? ' mine' : ''));
    // 整根钓竿：展出每件组件（部位 + 词条）
    const rodHtml = (meta.kind === 'rod' && meta.parts)
      ? '<div class="mk-rod-parts">' + meta.parts.map(function (it) {
          return '<div class="mk-rod-part"><span class="mrp-name ' + qualityClass(it.comp) + '">' + esc(it.partName) + ' · ' + esc(it.comp.name) + '</span>' +
            '<span class="mrp-affs">' + it.comp.affixes.map(function (a) {
              return affSpanOpen(a) + esc(affixText(a)) + '</span>';
            }).join('') + '</span></div>';
        }).join('') + '</div>'
      : '';
    const affHtml = (meta.kind === 'component' && meta.affixes && meta.affixes.length)
      ? '<div class="mk-aff">' + meta.affixes.map(function (a) {
          const rng = affixRangeIn(meta, a);
          const rangeTag = rng ? '<span class="aff-rng">（' + esc(rangeText({ min: rng[0], max: rng[1] })) + '%）</span>' : '';
          return affSpanOpen(a) + esc(affixText(a)) + rangeTag + '</span>';
        }).join('') + itemTag(meta) + '</div>'
      : '';
    row.innerHTML =
      '<div class="mk-main"><div class="mk-name ' + qualityClass(meta) + '">' + esc(l.name) + ' <span class="qty">×' + l.qty + '</span>' +
      (meta.kind === 'rod' ? '<span class="mk-tag">🎣 整竿' + (meta.parts ? ' · ' + meta.parts.length + ' 件' : '') + '</span>' : '') + '</div>' +
      affHtml + rodHtml +
      '<div class="mk-sub">卖家：' + esc(l.sellerName) + (mine ? '（你）' : '') + ' · 上架 ' + timeStr(l.t) + '</div></div>' +
      '<div class="mk-price"><b>💰 ' + l.price + '</b><span class="unit">/个</span><div class="total">合计 ' + total + '</div></div>';
    const acts = el('div', 'mk-acts');
    if (!mine && meta.kind === 'rod') {
      const st0 = S();
      const free = (st0.rodSlotsCount || 1) - (st0.rodSlots || []).filter(function (x) { return x; }).length;
      if (free <= 0) {
        const nb = el('button', 'mini locked', '槽位已满');
        nb.title = '钓竿槽位已满：整根钓竿需要占用一个槽位，请先购买槽位或清空一个槽位';
        acts.appendChild(nb);
        row.appendChild(acts);
        return row;
      }
    }
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
        // 支持自定义数量：默认 1，最多本挂单剩余数量（子窗口输入，不用浏览器 prompt）
        promptModal({
          title: '购买 ' + l.name,
          numeric: true, min: 1, max: l.qty, value: 1, okText: '购买',
          html: '<div class="cf-hint">本挂单剩余 ' + l.qty + ' 个 · 单价 💰' + l.price + '</div>',
        }).then(function (v) {
          if (v == null) return;
          const n = Math.max(1, Math.min(l.qty, Math.floor(Number(v) || 0)));
          if (!n) { toast('请输入有效的购买数量'); return; }
          const total = l.price * n;
          confirmModal({
            title: '确认购买',
            html: '花费 <b>💰' + total + '</b> 购买 <b>' + esc(l.name) + ' ×' + n + '</b>？',
            okText: '确定购买',
          }).then(function (ok) {
            if (!ok) return;
            call(window.Net.marketBuy(l.lid, n), '购买成功：' + l.name + ' ×' + n).then(function (r) {
              if (r && r.ok) {
                st.player.coins = r.data.coins; st.inventory = r.data.inventory;
                if (r.data.rodSlots) { st.rodSlots = r.data.rodSlots; }
                renderTopbar(); renderView();
              }
            });
          });
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
      [['all', '全部'], ['fish', '鱼'], ['material', '材料'], ['component', '组件'], ['rod', '🎣 钓竿']].forEach(function (kv) {
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
        if (affixFilterActive()) others = others.filter(listingMatchesAffix);
        others.sort(function (a, b) {
          if (buySort.key === 'price') {
            const d = buySort.dir === 'asc' ? a.price - b.price : b.price - a.price;
            return d || b.t - a.t;
          }
          if (buySort.key === 'qty') {
            const d = buySort.dir === 'asc' ? a.qty - b.qty : b.qty - a.qty;
            return d || b.t - a.t;
          }
          if (buySort.key === 'affix') {
            // 词条值排序：选中词条类型时用该词条数值，否则用全部词条合计（组件与整竿都适用）
            const av = function (id) {
              const m = itemMeta(id);
              if (!m.affixes || !m.affixes.length) return -1e9;
              if (buyAffixType !== 'all') {
                const hit = m.affixes.find(function (x) { return x.type === buyAffixType; });
                return hit ? hit.value : -1e9;
              }
              return m.affixes.reduce(function (s2, x) { return s2 + x.value; }, 0);
            };
            const d = buySort.dir === 'asc' ? av(a.id) - av(b.id) : av(b.id) - av(a.id);
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
        if (q || buyCategory !== 'all' || buySort.key !== 'time' || affixFilterActive()) list.appendChild(el('div', 'hint', '匹配 ' + others.length + ' 条挂单。'));
      }
      inp.addEventListener('input', function () { buySearch = inp.value; refreshList(); });
      inp.addEventListener('focus', function () { buySearchFocus = true; marketFilterActive = true; });
      inp.addEventListener('blur', function () { buySearchFocus = false; marketFilterActive = false; });
      filters.appendChild(inp);

      // 组件词条筛选：选择词条类型 + 数值区间，只搜带该词条的组件挂单
      // 下拉/输入获得焦点时置 marketFilterActive，广播重绘被暂停，避免下拉框被刷新关闭。
      const affWrap = el('div', 'aff-filter');
      affWrap.appendChild(el('span', 'bf-sort-label', '词条'));
      const affSel = el('select', 'bulk-select');
      [['all', '全部词条']].concat(BD_AFFIXES.map(function (kv) { return [kv[0], kv[1]]; })).forEach(function (kv) {
        const o = el('option', null, kv[1]); o.value = kv[0]; affSel.appendChild(o);
      });
      affSel.value = buyAffixType;
      affSel.addEventListener('change', function () { buyAffixType = affSel.value; renderView(); });
      affSel.addEventListener('focus', function () { marketFilterActive = true; });
      affSel.addEventListener('blur', function () { marketFilterActive = false; });
      affWrap.appendChild(affSel);
      const minInp = el('input', 'aff-num');
      minInp.type = 'number'; minInp.placeholder = '最小值'; minInp.value = buyAffixMin;
      const maxInp = el('input', 'aff-num');
      maxInp.type = 'number'; maxInp.placeholder = '最大值'; maxInp.value = buyAffixMax;
      function onNum() { buyAffixMin = minInp.value; buyAffixMax = maxInp.value; refreshList(); }
      function focusOn() { marketFilterActive = true; }
      function blurOff() { marketFilterActive = false; }
      minInp.addEventListener('input', onNum);
      maxInp.addEventListener('input', onNum);
      minInp.addEventListener('focus', focusOn); maxInp.addEventListener('focus', focusOn);
      minInp.addEventListener('blur', blurOff); maxInp.addEventListener('blur', blurOff);
      affWrap.appendChild(minInp);
      affWrap.appendChild(el('span', 'bf-sort-label', '~'));
      affWrap.appendChild(maxInp);
      if (affixFilterActive()) {
        const clr = el('button', 'bf-cat', '清除');
        clr.addEventListener('click', function () { buyAffixType = 'all'; buyAffixMin = ''; buyAffixMax = ''; renderView(); });
        affWrap.appendChild(clr);
      }
      filters.appendChild(affWrap);

      // 排序：时间（默认）/ 价格 / 数量；价格与数量可切换升降序
      const sortWrap = el('span', 'bf-sort');
      sortWrap.appendChild(el('span', 'bf-sort-label', '排序'));
      [['time', '时间'], ['price', '价格'], ['qty', '数量'], ['affix', '词条值']].forEach(function (kv) {
        const activeSort = buySort.key === kv[0];
        const arrow = activeSort && kv[0] !== 'time' ? (buySort.dir === 'asc' ? ' ↑' : ' ↓') : '';
        const b = el('button', 'bf-cat bf-sort-btn' + (activeSort ? ' on' : ''), kv[1] + arrow);
        b.title = kv[0] === 'affix' ? '按词条值排序：选中词条时按该词条数值，未选时按全部词条合计' : '';
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
    side.appendChild(marketSellPanel(st));
    panel.appendChild(side);

    main.appendChild(panel);
  }

  // ---- 市集右栏「我的背包」：简易分类筛选 + 多选 + 一键上架 ----
  // 分类只为快速定位要上架的物品；多选后统一设置时长与价格倍率，逐个调用挂单接口。
  let mktSellCat = 'all';
  let mktSellPick = {};      // 勾选的物品 id → true
  let mktSellScroll = 0;     // 列表滚动位置（重绘后还原，避免多选时被弹回顶部）
  function marketSellPanel(st) {
    const box = el('div', 'mkt-sell');
    const keysAll = Object.keys(st.inventory);
    const kindCount = { fish: 0, material: 0, chest: 0, component: 0 };
    keysAll.forEach(function (id) { const k = itemMeta(id).kind; if (kindCount[k] != null) kindCount[k] += 1; });
    box.appendChild(el('h3', null, '🎒 我的背包（上架）'));
    // 简易分类
    const cats = el('div', 'inv-cats mkt-cats');
    [['all', '📦 全部', keysAll.length], ['fish', '🐟 鱼类', kindCount.fish], ['material', '🧵 材料', kindCount.material], ['chest', '🎁 宝匣', kindCount.chest], ['component', '🔧 组件', kindCount.component]].forEach(function (kv) {
      const b = el('button', 'inv-cat' + (mktSellCat === kv[0] ? ' on' : ''), kv[1] + ' ' + kv[2]);
      b.addEventListener('click', function () { if (mktSellCat !== kv[0]) { mktSellCat = kv[0]; renderView(); } });
      cats.appendChild(b);
    });
    box.appendChild(cats);
    let keys = mktSellCat === 'all' ? keysAll : keysAll.filter(function (id) { return itemMeta(id).kind === mktSellCat; });
    if (!keys.length) { box.appendChild(el('div', 'hint', '该分类下没有可上架的物品。')); return box; }
    keys = keys.slice().sort(function (a, b) { return unitPriceOf(b) - unitPriceOf(a) || (a < b ? -1 : 1); });
    const list = el('div', 'mkt-sell-list');
    // 重绘（行情广播 / 上架后刷新）时还原滚动位置：列表可滚动，弹回顶部会让多选很难用
    list.scrollTop = mktSellScroll;
    list.addEventListener('scroll', function () { mktSellScroll = list.scrollTop; });
    // 勾选变化只更新底部按钮（不整页重绘）：列表可滚动，重绘会把滚动条弹回顶部，多选时很难用
    let syncFoot = function () {};
    keys.forEach(function (id) {
      const meta = itemMeta(id);
      const row = el('div', 'inv-row mkt-sell-row');
      const picked = !!mktSellPick[id];
      // 组件实例：词条直接显示在挂单列表里（含数值区间与满词条标记），便于挑要挂单的组件
      const affHtml = (meta.kind === 'component' && meta.affixes && meta.affixes.length)
        ? '<span class="mkt-sell-aff">' + meta.affixes.map(function (a) {
            const rng = affixRangeIn(meta, a);
            const rangeTag = rng ? '<span class="aff-rng">（' + esc(rangeText({ min: rng[0], max: rng[1] })) + '%）</span>' : '';
            return affSpanOpen(a) + esc(affixText(a)) + rangeTag + '</span>';
          }).join('') + itemTag(meta) + '</span>'
        : '';
      row.innerHTML = '<label class="mkt-pick"><input type="checkbox"' + (picked ? ' checked' : '') + ' /></label>' +
        '<span class="mkt-sell-info">' +
        '<span class="mkt-sell-name ' + qualityClass(meta) + '">' + esc(meta.name) + '</span>' + rodLockBadge(id) + affHtml +
        '</span>' +
        '<span class="cnt">×' + st.inventory[id] + '</span>' +
        '<span class="unit-price">' + unitPriceOf(id) + '💰</span>';
      const cb = row.querySelector('input[type=checkbox]');
      cb.addEventListener('change', function () {
        if (cb.checked) mktSellPick[id] = true; else delete mktSellPick[id];
        syncFoot();
      });
      const acts = el('span', 'inv-acts');
      const b1 = el('button', 'mini', '上架');
      b1.title = '单个上架（自定义数量/单价/时长）';
      b1.addEventListener('click', function () { openListModal(id); });
      acts.appendChild(b1);
      row.appendChild(acts);
      list.appendChild(row);
    });
    box.appendChild(list);
    const foot = el('div', 'mkt-sell-foot');
    const batch = el('button', 'primary');
    foot.appendChild(batch);
    const clr = el('button', 'mini', '清空选择');
    clr.addEventListener('click', function () {
      // 就地取消勾选（同样避免重绘导致的滚动跳动）
      mktSellPick = {};
      list.querySelectorAll('input[type=checkbox]').forEach(function (c) { c.checked = false; });
      syncFoot();
    });
    foot.appendChild(clr);
    box.appendChild(foot);
    box.appendChild(el('div', 'hint', '勾选多件后点「一键上架」：统一设置时长与价格倍率（按各物品现价计算），逐个挂单。'));
    // 底部按钮与勾选状态同步（就地更新：文案 / 禁用态 / 点击行为）
    syncFoot = function () {
      const pickedIds = keys.filter(function (id) { return mktSellPick[id]; });
      batch.textContent = '⚡ 一键上架（已选 ' + pickedIds.length + '）';
      batch.classList.toggle('locked', !pickedIds.length);
      batch.title = pickedIds.length ? '统一设置时长与价格倍率后逐个挂单' : '先勾选要上架的物品';
      batch.onclick = pickedIds.length ? function () { openBatchListModal(pickedIds); } : null;
    };
    syncFoot();
    return box;
  }
  // 一键上架子窗口：统一时长 + 价格倍率（或各物品现价），逐件挂单并汇总结果
  function openBatchListModal(ids) {
    const st = S();
    closeOverlays();
    const overlay = buildOverlay(function () { closeOverlays(); });
    const box = el('div', 'modal-box shop-modal batch-list-modal');
    let hours = 6;
    const rowsHtml = ids.map(function (id) {
      const meta = itemMeta(id);
      const qty = st.inventory[id] || 0;
      return '<div class="bl-row"><span class="' + qualityClass(meta) + '">' + esc(meta.name) + '</span>' +
        '<span class="cnt">×' + qty + '</span><span class="bl-unit" data-id="' + esc(id) + '">' + unitPriceOf(id) + '💰</span></div>';
    }).join('');
    box.innerHTML = '<div class="modal-head"><span class="modal-title">⚡ 一键上架（' + ids.length + ' 种）</span>' +
      '<button class="mini modal-close">✕ 关闭</button></div>' +
      '<div class="modal-body">' +
      '<div class="lm-row"><label>挂单时长</label><span id="bl-hours">' +
      [[6, '6 小时 · 1%'], [12, '12 小时 · 3%'], [24, '24 小时 · 5%']].map(function (kv) {
        return '<button class="mini lm-hours' + (kv[0] === 6 ? ' on' : '') + '" data-h="' + kv[0] + '">' + kv[1] + '</button>';
      }).join('') + '</span></div>' +
      '<div class="lm-row"><label>价格倍率</label><input id="bl-mult" class="bulk-select" type="number" min="0.1" step="0.5" value="2" style="width:90px" />' +
      '<span class="hint">按各物品现价 ×倍率 定价（现价见下表）</span></div>' +
      '<div class="bl-rows">' + rowsHtml + '</div>' +
      '<div class="bulk-est" id="bl-est">—</div>' +
      '<button class="primary" id="bl-go">确认一键上架</button>' +
      '<div class="hint" style="margin-top:8px">每种按「全部持有数量」上架；上架费 = 定价总额 × 时长费率，下架/过期不退。</div>' +
      '</div>';
    overlay.appendChild(box);
    document.body.appendChild(overlay);
    box.querySelector('.modal-close').addEventListener('click', closeOverlays);
    const multInp = box.querySelector('#bl-mult');
    function recalc() {
      const mult = Math.max(0.1, Number(multInp.value) || 1);
      const rate = { 6: 0.01, 12: 0.03, 24: 0.05 }[hours];
      let total = 0, fee = 0;
      ids.forEach(function (id) {
        const qty = st.inventory[id] || 0;
        const price = Math.max(1, Math.round(unitPriceOf(id) * mult));
        total += price * qty;
        fee += Math.ceil(price * qty * rate);
        const cell = box.querySelector('.bl-unit[data-id="' + id.replace(/"/g, '\\"') + '"]');
        if (cell) cell.textContent = price + '💰';
      });
      box.querySelector('#bl-est').innerHTML = '预计收入 <b>' + total + '</b>💰 · 上架费合计 <b>' + fee + '</b>💰（费率 ' + Math.round(rate * 100) + '% · ' + hours + ' 小时）';
    }
    box.querySelectorAll('.lm-hours').forEach(function (b) {
      b.addEventListener('click', function () {
        box.querySelectorAll('.lm-hours').forEach(function (x) { x.classList.remove('on'); });
        b.classList.add('on');
        hours = parseInt(b.getAttribute('data-h'), 10) || 6;
        recalc();
      });
    });
    multInp.addEventListener('input', recalc);
    recalc();
    box.querySelector('#bl-go').addEventListener('click', function () {
      const mult = Math.max(0.1, Number(multInp.value) || 1);
      const btn = box.querySelector('#bl-go');
      if (btn.disabled) return;
      btn.disabled = true;
      btn.textContent = '上架中…';
      let ok = 0, fail = 0, failMsg = '', chain = Promise.resolve();
      ids.forEach(function (id) {
        chain = chain.then(function () {
          const qty = st.inventory[id] || 0;
          if (qty <= 0) return null;
          const price = Math.max(1, Math.round(unitPriceOf(id) * mult));
          return window.Net.marketList(id, qty, price, hours).then(function (r) {
            if (r && r.ok) {
              ok++;
              st.player.coins = r.data.coins; st.inventory = r.data.inventory;
            } else {
              fail++;
              if (!failMsg) failMsg = (r && r.data && r.data.error) || '失败';
            }
          });
        });
      });
      chain.then(function () {
        closeOverlays();
        mktSellPick = {};
        renderTopbar(); renderView();
        toast('一键上架完成：成功 ' + ok + ' 种' + (fail ? ('，失败 ' + fail + ' 种（' + failMsg + '）') : ''));
      });
    });
  }

  // ---- 背包视图（独立分页：分类明细 + 出售/上架 + 汇总 + 我的挂单） ----
  // 当前分类（模块级：重绘间保留）
  let invCategory = 'all';
  // 子分类筛选（随分类页签切换显示）：
  //   鱼类/材料 → 品质；组件 → 一级「部位」 + 二级「词条 + 数值范围」
  let invSubRar = 'all';
  let invPart = 'all';
  let invAffixType = 'all';
  let invAffixMin = '';
  let invAffixMax = '';
  let invOpen = {};          // 组件按底材名分组的展开状态（{ baseId: true }）
  let invFocus = false;      // 子筛选控件聚焦时暂停广播重绘（避免下拉被关闭）
  let bulkCat = 'all';
  let bulkRar = 'all';

  // ---- 一键出售（预览弹窗）：筛选候选 → 逐项勾选/改数量 → 确认出售 ----
  // 筛选：种类 / 品质 / 词条类型 + 数值区间（词条筛选只作用于组件，与市集同款交互）。
  // 预览列表默认全选，可取消勾选或改数量；确认前可反复调整。出售顺序执行，避免并发覆盖资产。
  let bulkAffixType = 'all';
  let bulkAffixMin = '';
  let bulkAffixMax = '';
  let bulkSel = {};        // id -> 勾选数量（弹窗活动清单；改筛选时保留仍匹配的勾选）
  let bulkFocus = false;   // 筛选控件聚焦时暂停广播重绘（同类：市集筛选聚焦暂停）
  function bulkAffixActive() { return bulkAffixType !== 'all' || bulkAffixMin !== '' || bulkAffixMax !== ''; }
  function bulkMatch(id) {
    const m = itemMeta(id);
    if (bulkCat !== 'all' && m.kind !== bulkCat) return false;
    if (bulkRar !== 'all' && m.rarity !== bulkRar) return false;
    if (!bulkAffixActive()) return true;
    if (m.kind !== 'component' || !m.affixes) return false;
    return m.affixes.some(function (a) {
      if (bulkAffixType !== 'all' && a.type !== bulkAffixType) return false;
      if (bulkAffixMin !== '' && a.value < Number(bulkAffixMin)) return false;
      if (bulkAffixMax !== '' && a.value > Number(bulkAffixMax)) return false;
      return true;
    });
  }
  function bulkCandidates() {
    const st = S();
    return Object.keys(st.inventory).filter(bulkMatch).sort(function (a, b) {
      const ca = itemMeta(a).kind === 'component' ? 1 : 0, cb = itemMeta(b).kind === 'component' ? 1 : 0;
      if (ca !== cb) return ca - cb;
      return unitPriceOf(b) - unitPriceOf(a) || (a < b ? -1 : 1);
    });
  }
  function openBulkSellModal() {
    const st = S();
    bulkSel = {};
    bulkCandidates().forEach(function (id) { bulkSel[id] = st.inventory[id] || 0; });
    drawBulkModal(true);
  }
  // 重绘弹窗：rebuild=true 时重置勾选（打开弹窗），否则保留仍匹配的勾选、新候选默认全选
  function drawBulkModal(rebuild) {
    const st = S();
    const cands = bulkCandidates();
    if (rebuild) bulkSel = {};
    Object.keys(bulkSel).forEach(function (id) { if (cands.indexOf(id) < 0) delete bulkSel[id]; });
    cands.forEach(function (id) { if (bulkSel[id] == null) bulkSel[id] = st.inventory[id] || 0; });
    closeOverlays();
    const overlay = buildOverlay(function () { closeOverlays(); bulkFocus = false; });
    const box = el('div', 'modal-box shop-modal bulk-sell-modal');
    overlay.appendChild(box);
    document.body.appendChild(overlay);
    box.innerHTML = '<div class="modal-head"><span class="modal-title">⚡ 一键出售 · 预览</span>' +
      '<button class="mini modal-close">✕ 关闭</button></div>' +
      '<div class="modal-body"><div class="bulk-filters" id="bulk-filters"></div>' +
      '<div class="bulk-rows" id="bulk-rows"></div>' +
      '<div class="bulk-est" id="bulk-est"></div>' +
      '<div class="cf-actions bulk-acts"><button class="mini" id="bulk-all">全选</button>' +
      '<button class="mini" id="bulk-none">全不选</button><button class="mini" id="bulk-invert">反选</button>' +
      '<button class="mini cf-cancel">取消</button><button class="mini primary-mini" id="bulk-go">确认出售</button></div>' +
      '<div class="hint">预览列表默认全选；取消勾选或调整数量后点「确认出售」。词条 / 数值筛选只作用于组件。</div></div>';
    box.querySelector('.modal-close').addEventListener('click', function () { closeOverlays(); bulkFocus = false; });
    box.querySelector('.cf-cancel').addEventListener('click', function () { closeOverlays(); bulkFocus = false; });

    // ---- 筛选控件（种类 / 品质 / 词条 + 数值区间）----
    const fwrap = box.querySelector('#bulk-filters');
    const catSel = el('select', 'bulk-select');
    [['all', '全部种类'], ['fish', '🐟 鱼类'], ['material', '🧵 材料'], ['chest', '🎁 宝匣'], ['component', '🔧 组件']].forEach(function (kv) {
      const o = el('option', null, kv[1]); o.value = kv[0]; catSel.appendChild(o);
    });
    catSel.value = bulkCat;
    const rarSel = el('select', 'bulk-select');
    [['all', '全部品质'], ['common', '普通'], ['rare', '稀有'], ['epic', '史诗'], ['mythic', '神话']].forEach(function (kv) {
      const o = el('option', null, kv[1]); o.value = kv[0]; rarSel.appendChild(o);
    });
    rarSel.value = bulkRar;
    const affSel = el('select', 'bulk-select');
    [['all', '全部词条']].concat(BD_AFFIXES.map(function (kv) { return [kv[0], kv[1]]; })).forEach(function (kv) {
      const o = el('option', null, kv[1]); o.value = kv[0]; affSel.appendChild(o);
    });
    affSel.value = bulkAffixType;
    const minInp = el('input', 'aff-num');
    minInp.type = 'number'; minInp.placeholder = '最小值'; minInp.value = bulkAffixMin;
    const maxInp = el('input', 'aff-num');
    maxInp.type = 'number'; maxInp.placeholder = '最大值'; maxInp.value = bulkAffixMax;
    fwrap.appendChild(el('span', 'bf-sort-label', '种类'));
    fwrap.appendChild(catSel);
    fwrap.appendChild(el('span', 'bf-sort-label', '品质'));
    fwrap.appendChild(rarSel);
    fwrap.appendChild(el('span', 'bf-sort-label', '词条'));
    fwrap.appendChild(affSel);
    fwrap.appendChild(minInp);
    fwrap.appendChild(el('span', 'bf-sort-label', '~'));
    fwrap.appendChild(maxInp);
    if (bulkAffixActive()) {
      const clr = el('button', 'mini', '清除词条筛选');
      clr.addEventListener('click', function () { bulkAffixType = 'all'; bulkAffixMin = ''; bulkAffixMax = ''; drawBulkModal(false); });
      fwrap.appendChild(clr);
    }
    // 聚焦时暂停广播重绘（SSE 广播不会重建弹窗 DOM）
    [catSel, rarSel, affSel, minInp, maxInp].forEach(function (n) {
      n.addEventListener('focus', function () { bulkFocus = true; });
      n.addEventListener('blur', function () { bulkFocus = false; });
    });
    catSel.addEventListener('change', function () { bulkCat = catSel.value; drawBulkModal(false); });
    rarSel.addEventListener('change', function () { bulkRar = rarSel.value; drawBulkModal(false); });
    affSel.addEventListener('change', function () { bulkAffixType = affSel.value; drawBulkModal(false); });
    function onNum() { bulkAffixMin = minInp.value; bulkAffixMax = maxInp.value; }
    minInp.addEventListener('input', function () { onNum(); refreshBulkRows(); });
    maxInp.addEventListener('input', function () { onNum(); refreshBulkRows(); });

    // ---- 预览列表 ----
    const rows = box.querySelector('#bulk-rows');
    const est = box.querySelector('#bulk-est');
    function selectedItems() {
      return cands.filter(function (id) { return (bulkSel[id] || 0) > 0; })
        .map(function (id) { return { id: id, qty: Math.max(1, Math.min(st.inventory[id] || 0, bulkSel[id])) }; });
    }
    function refreshEst() {
      const items = selectedItems();
      const cnt = items.reduce(function (s, it) { return s + it.qty; }, 0);
      const money = items.reduce(function (s, it) { return s + unitPriceOf(it.id) * it.qty; }, 0);
      est.innerHTML = '已选 <b>' + items.length + '</b> 种 / <b>' + cnt + '</b> 件 · 预估收入 <b>' + Math.round(money) + '</b>💰<span class="muted">（按当前实时收购价）</span>';
      const go = box.querySelector('#bulk-go');
      if (go) go.classList.toggle('locked', cnt === 0);
      go.textContent = cnt > 0 ? ('确认出售（' + cnt + ' 件）') : '确认出售';
    }
    function buildRows() {
      rows.innerHTML = '';
      if (!cands.length) { rows.appendChild(el('div', 'hint', '没有符合筛选条件的物品。')); return; }
      cands.forEach(function (id) {
        const meta = itemMeta(id);
        const have = st.inventory[id] || 0;
        const row = el('div', 'bulk-row-item');
        const affHtml = (meta.kind === 'component' && meta.affixes && meta.affixes.length)
          ? '<div class="mk-aff">' + meta.affixes.map(function (a) {
              const rng = affixRangeIn(meta, a);
              const rangeTag = rng ? '<span class="aff-rng">（' + esc(rangeText({ min: rng[0], max: rng[1] })) + '%）</span>' : '';
              return affSpanOpen(a) + esc(affixText(a)) + rangeTag + '</span>';
            }).join('') + itemTag(meta) + '</div>'
          : '';
        row.innerHTML = '<label class="bk-check"><input type="checkbox" data-id="' + esc(id) + '"' + ((bulkSel[id] || 0) > 0 ? ' checked' : '') + ' /></label>' +
          '<div class="bk-main"><div class="bk-name ' + qualityClass(meta) + '">' + esc(meta.name) + '</div>' + affHtml + '</div>' +
          '<span class="bk-have">持有 ' + have + '</span>' +
          '<input class="bk-qty" type="number" min="1" max="' + have + '" value="' + Math.max(1, Math.min(have, bulkSel[id] || have)) + '"' + ((bulkSel[id] || 0) > 0 ? '' : ' disabled') + ' />' +
          '<span class="bk-unit">' + unitPriceOf(id) + '💰</span>' +
          '<span class="bk-sub">' + Math.round(unitPriceOf(id) * Math.max(0, bulkSel[id] || 0)) + '💰</span>';
        rows.appendChild(row);
        const cb = row.querySelector('input[type=checkbox]');
        const qi = row.querySelector('.bk-qty');
        const sub = row.querySelector('.bk-sub');
        function syncSub() { sub.textContent = Math.round(unitPriceOf(id) * (bulkSel[id] || 0)) + '💰'; }
        cb.addEventListener('change', function () {
          if (cb.checked) { bulkSel[id] = Math.max(1, Math.min(have, parseInt(qi.value, 10) || have)); qi.disabled = false; }
          else { delete bulkSel[id]; qi.disabled = true; }
          syncSub(); refreshEst();
        });
        qi.addEventListener('input', function () {
          if (!cb.checked) return;
          bulkSel[id] = Math.max(1, Math.min(have, parseInt(qi.value, 10) || 1));
          syncSub(); refreshEst();
        });
      });
    }
    // 数值区间变化：候选集不变时只同步可见行（不重建 DOM，避免输入框失焦）；候选集变化则重建
    let lastCandSig = '';
    function refreshBulkRows() {
      const next = bulkCandidates();
      const nowCands = {}; next.forEach(function (id) { nowCands[id] = 1; });
      Object.keys(bulkSel).forEach(function (id) { if (!nowCands[id]) delete bulkSel[id]; });
      let added = false;
      next.forEach(function (id) { if (bulkSel[id] == null) { bulkSel[id] = st.inventory[id] || 0; added = true; } });
      const sig = next.join('\u0001');
      if (added || sig !== lastCandSig) { lastCandSig = sig; buildRows(); refreshEst(); return; }
      // 候选集未变：仅同步每行勾选状态与行小计
      rows.querySelectorAll('.bulk-row-item').forEach(function (row) {
        const cbin = row.querySelector('input[type=checkbox]');
        if (!cbin) return;
        const id = cbin.getAttribute('data-id');
        const on = (bulkSel[id] || 0) > 0;
        cbin.checked = on;
        const qi = row.querySelector('.bk-qty');
        if (qi) { qi.disabled = !on; if (on) qi.value = Math.min(Number(qi.max) || 1, bulkSel[id]); }
        const sub = row.querySelector('.bk-sub');
        if (sub) sub.textContent = Math.round(unitPriceOf(id) * (bulkSel[id] || 0)) + '💰';
      });
      refreshEst();
    }
    box.querySelector('#bulk-all').addEventListener('click', function () { cands.forEach(function (id) { bulkSel[id] = st.inventory[id] || 0; }); buildRows(); refreshEst(); });
    box.querySelector('#bulk-none').addEventListener('click', function () { bulkSel = {}; buildRows(); refreshEst(); });
    box.querySelector('#bulk-invert').addEventListener('click', function () {
      const inv = {};
      cands.forEach(function (id) { if (!(bulkSel[id] > 0)) inv[id] = st.inventory[id] || 0; });
      bulkSel = inv; buildRows(); refreshEst();
    });
    box.querySelector('#bulk-go').addEventListener('click', function () {
      const items = selectedItems();
      if (!items.length) { toast('请先勾选要出售的物品'); return; }
      const cnt = items.reduce(function (s, it) { return s + it.qty; }, 0);
      const money = items.reduce(function (s, it) { return s + unitPriceOf(it.id) * it.qty; }, 0);
      confirmModal({
        title: '确认出售',
        html: '将出售 <b>' + items.length + '</b> 种共 <b>' + cnt + '</b> 件物品，<br>按当前收购价预计收入 <b>💰' + Math.round(money) + '</b>。',
        okText: '确认出售',
      }).then(function (ok) { if (ok) bulkSellExec(items); });
    });
    buildRows();
    refreshEst();
  }
  // 执行批量出售：逐个卖给系统商店（顺序执行，避免并发覆盖资产）
  function bulkSellExec(items) {
    const st = S();
    let gain = 0, sold = 0;
    let chain = Promise.resolve();
    items.forEach(function (it) {
      chain = chain.then(function () {
        const qty = Math.max(0, Math.min(st.inventory[it.id] || 0, it.qty));
        if (qty <= 0) return null;
        return window.Net.sell(it.id, qty).then(function (r) {
          if (r && r.ok) {
            gain += r.data.gain; sold += qty;
            st.player.coins = r.data.coins; st.inventory = r.data.inventory; st.shop = r.data.shop;
          }
        });
      });
    });
    chain.then(function () {
      closeOverlays();
      renderTopbar(); renderView();
      toast('一键出售完成：' + sold + ' 件，共收入 💰' + gain);
    });
  }

  // 批量出售子窗口：数量可手填或用滑块，显示价格趋势图与预估收入
  let batchSellId = null;
  function openBatchSellModal(id) {
    const st = S();
    const meta = itemMeta(id);
    const have = st.inventory[id] || 0;
    if (have <= 0) { toast('没有可出售的物品'); return; }
    batchSellId = id;
    closeOverlays();
    const overlay = buildOverlay(function () { closeBatchSell(); });
    const box = el('div', 'modal-box shop-modal batch-sell-modal');
    box.innerHTML = '<div class="modal-head"><span class="modal-title">💰 批量出售 · ' + esc(meta.name) + '</span>' +
      '<button class="mini modal-close">✕ 关闭</button></div>' +
      '<div class="modal-body">' +
      '<div class="bs-vol" id="bs-vol">持有 ×' + have + ' · 现价 <b>' + unitPriceOf(id) + '</b>💰</div>' +
      '<div class="bs-trend" id="bs-trend">价格走势加载中…</div>' +
      '<div class="bs-row"><label>出售数量</label>' +
      '<input id="bs-num" class="ipt bs-num" type="number" min="1" max="' + have + '" value="' + have + '" />' +
      '<button class="mini" id="bs-max">全部</button></div>' +
      '<input id="bs-range" class="bs-range" type="range" min="1" max="' + have + '" value="' + have + '" />' +
      '<div class="bs-est" id="bs-est">—</div>' +
      '<button class="primary big" id="bs-go">确认出售</button>' +
      '</div>';
    overlay.appendChild(box);
    document.body.appendChild(overlay);
    box.querySelector('.modal-close').addEventListener('click', closeBatchSell);

    const num = box.querySelector('#bs-num');
    const range = box.querySelector('#bs-range');
    const est = box.querySelector('#bs-est');
    function clampQty(v) { v = Math.floor(Number(v) || 0); return Math.max(1, Math.min(have, v)); }
    function recalc() {
      const q = clampQty(num.value);
      if (String(q) !== String(num.value)) num.value = q;
      range.value = q;
      est.innerHTML = '出售 <b>' + q + '</b> / ' + have + ' 个 · 预估收入 <b>💰' + Math.round(unitPriceOf(id) * q) + '</b><span class="muted">（按当前收购价）</span>';
    }
    num.addEventListener('input', function () { range.value = clampQty(num.value); recalc(); });
    num.addEventListener('change', recalc);
    range.addEventListener('input', function () { num.value = range.value; recalc(); });
    box.querySelector('#bs-max').addEventListener('click', function () { num.value = have; recalc(); });
    recalc();

    box.querySelector('#bs-go').addEventListener('click', function () {
      const q = clampQty(num.value);
      confirmModal({
        title: '确认出售',
        html: '以现价 💰' + unitPriceOf(id) + ' 出售 <b>' + esc(meta.name) + ' ×' + q + '</b>（合计 <b>💰' + Math.round(unitPriceOf(id) * q) + '</b>）？',
        okText: '确认出售',
      }).then(function (ok) {
        if (!ok) return;
        closeBatchSell();
        call(window.Net.sell(id, q), function (r) { return '售出 ' + meta.name + ' ×' + q + '，获得 💰' + r.data.gain; })
          .then(function (r) { if (r && r.ok) { st.player.coins = r.data.coins; st.inventory = r.data.inventory; st.shop = r.data.shop; renderTopbar(); renderView(); } });
      });
    });

    // 价格趋势图（与商店详情同一数据源）
    window.Net.shopHistory(id).then(function (r) {
      const t = box.querySelector('#bs-trend');
      if (!t || batchSellId !== id) return;
      t.innerHTML = '';
      if (!r || !r.ok) { t.appendChild(el('div', 'sd-legend', '价格走势不可用')); return; }
      const d = r.data;
      let pts = (d.points || []).slice();
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
        t.appendChild(spark);
        t.appendChild(el('div', 'sd-legend', '近 ' + pts.length + ' 个采样 · 红=不低于基准 · 蓝=低于基准'));
      } else {
        t.appendChild(el('div', 'sd-legend', '价格采样积累中（服务器每分钟记录一次）。'));
      }
    });
  }
  function closeBatchSell() { batchSellId = null; closeOverlays(); }

  // ---- 组件订阅提醒：筛选条件 + 提醒方式（背包红标 / 浏览器图标闪烁） ----
  // 判定在服务端（新组件入包时推送 subalert），这里只负责配置与提醒展示。
  function subCfg() { return (S().subCfg && typeof S().subCfg === 'object') ? S().subCfg : {}; }
  function clearSubAlerts(rerender) {
    if (!subUnseen) return;
    subUnseen = 0;
    navSig = null;
    updateBlink();
    renderNav();
    if (rerender) renderView();
  }
  function onSubAlert(item) {
    loadLog();
    // 人在背包页时无需红标（列表已可见），仍记日志与闪烁
    if (currentView !== 'inventory' && subCfg().badge !== false) { subUnseen++; navSig = null; }
    addLog('subscribe', '订阅命中：' + (item.name || item.id) +
      (item.affixes && item.affixes.length ? '（' + item.affixes.map(affixText).join('、') + '）' : ''));
    toast('🔔 订阅组件到货：' + (item.name || ''));
    updateBlink();
    renderNav();
  }
  function openSubscribeModal() {
    const cfg = subCfg();
    closeOverlays();
    const overlay = buildOverlay(function () { closeOverlays(); });
    const box = el('div', 'modal-box shop-modal subscribe-modal');
    const bases = D.COMPONENT_BASES || [];
    box.innerHTML = '<div class="modal-head"><span class="modal-title">🔔 组件订阅提醒</span>' +
      '<button class="mini modal-close">✕ 关闭</button></div>' +
      '<div class="modal-body">' +
      '<label class="sub-on"><input type="checkbox" id="sub-on"' + (cfg.on ? ' checked' : '') + ' /> 开启订阅（获得符合条件的组件时提醒）</label>' +
      '<div class="sub-grid">' +
      '<label>底材<select class="bulk-select" id="sub-base"><option value="">全部底材</option>' +
      bases.map(function (b) { return '<option value="' + esc(b.id) + '">' + esc(b.name) + '</option>'; }).join('') + '</select></label>' +
      '<label>品质<select class="bulk-select" id="sub-q"><option value="">全部品质</option>' +
      ['common', 'rare', 'epic', 'mythic'].map(function (k) { return '<option value="' + k + '">' + esc((D.QUALITY[k] || {}).name || k) + '</option>'; }).join('') + '</select></label>' +
      '<label>词条<select class="bulk-select" id="sub-aff"><option value="">全部词条</option>' +
      BD_AFFIXES.map(function (kv) { return '<option value="' + kv[0] + '">' + esc(kv[1]) + '</option>'; }).join('') + '</select></label>' +
      '<label>数值 <input class="aff-num" id="sub-min" type="number" placeholder="最小" /> ~ <input class="aff-num" id="sub-max" type="number" placeholder="最大" /></label>' +
      '</div>' +
      '<div class="sub-methods">提醒方式：<label><input type="checkbox" id="sub-badge"' + (cfg.badge === false ? '' : ' checked') + ' /> 背包红标</label>' +
      '<label><input type="checkbox" id="sub-blink"' + (cfg.blink === false ? '' : ' checked') + ' /> 浏览器图标闪烁</label></div>' +
      '<div class="hint">条件全部留空 = 任意组件都提醒。词条/数值筛选按「任一命中」判定（组件含该词条且数值在区间内）。</div>' +
      '<div class="cf-actions"><button class="mini cf-cancel">取消</button>' +
      '<button class="mini primary-mini" id="sub-save">保存订阅</button></div>' +
      '</div>';
    overlay.appendChild(box);
    document.body.appendChild(overlay);
    const baseSel = box.querySelector('#sub-base'), qSel = box.querySelector('#sub-q'), affSel = box.querySelector('#sub-aff');
    baseSel.value = cfg.baseId || ''; qSel.value = cfg.quality || ''; affSel.value = cfg.affixType || '';
    const minInp = box.querySelector('#sub-min'), maxInp = box.querySelector('#sub-max');
    if (cfg.min != null) minInp.value = cfg.min;
    if (cfg.max != null) maxInp.value = cfg.max;
    box.querySelector('.modal-close').addEventListener('click', closeOverlays);
    box.querySelector('.cf-cancel').addEventListener('click', closeOverlays);
    box.querySelector('#sub-save').addEventListener('click', function () {
      const min = minInp.value === '' ? null : Number(minInp.value);
      const max = maxInp.value === '' ? null : Number(maxInp.value);
      if ((min != null && !isFinite(min)) || (max != null && !isFinite(max))) { toast('数值范围需为数字'); return; }
      if (min != null && max != null && min > max) { toast('最小值不能大于最大值'); return; }
      const payload = {
        on: box.querySelector('#sub-on').checked,
        baseId: baseSel.value, quality: qSel.value, affixType: affSel.value,
        min: min, max: max,
        badge: box.querySelector('#sub-badge').checked,
        blink: box.querySelector('#sub-blink').checked,
      };
      call(window.Net.subscribeSave(payload), payload.on ? '订阅已保存，命中时会提醒' : '订阅已关闭').then(function (r) {
        if (r && r.ok) {
          S().subCfg = r.data.cfg;
          if (!r.data.cfg.on) clearSubAlerts(false);
          closeOverlays();
          updateBlink();
          renderView();
        }
      });
    });
  }

  // ---- 组件属性子窗口：直接查看词条与数值区间（交易/背包/市集前先看清属性） ----
  function openComponentDetail(id) {
    const meta = D.componentOf ? D.componentOf(id) : null;
    if (!meta) { toast('该物品没有可查看的组件属性'); return; }
    closeOverlays();
    const overlay = buildOverlay(function () { closeOverlays(); });
    const box = el('div', 'modal-box codex-modal comp-modal');
    const pool = meta.pool || [];
    const rowsHtml = (meta.affixes || []).map(function (a) {
      const p = pool.find(function (x) { return x.type === a.type; });
      const rng = p ? (D.affixRangeOf ? D.affixRangeOf(meta.baseId, p) : [p.min, p.max]) : null;
      const q = rng ? Math.max(0, Math.min(100, Math.round(100 * (a.value - rng[0]) / Math.max(1, rng[1] - rng[0])))) : null;
      return '<div class="cm-aff-row"><span class="inst-aff ' + (a.value < 0 ? 'neg' : 'pos') + '">' + esc(affixText(a)) + '</span>' +
        (rng ? '<span class="aff-rng">区间 ' + esc(rangeText({ min: rng[0], max: rng[1] })) + '%</span>' +
          '<span class="cm-bar"><i style="width:' + q + '%"></i></span><span class="muted">' + q + '%</span>' : '') + '</div>';
    }).join('') || '<div class="hint">该组件没有词条。</div>';
    const poolHtml = pool.map(function (p) {
      return '<span class="cm-pool-tag">' + esc(D.AFFIX_LABEL[p.type] || p.type) + ' ' + esc(rangeText(p)) + '%</span>';
    }).join('');
    box.innerHTML = '<div class="modal-head"><span class="modal-title">🔧 ' + esc(meta.name) + '</span>' +
      '<button class="mini modal-close">✕ 关闭</button></div>' +
      '<div class="modal-body"><div class="codex-detail">' +
      '<div class="cd-title ' + qualityClass(meta) + '">' + esc(meta.name) + '</div>' +
      '<div class="cd-line">品质 <b>' + esc(meta.qualityName || '') + '</b> · 部位 ' + esc((D.ROD_PARTS.find(function (p) { return p.key === meta.part; }) || {}).name || meta.part || '—') +
      ' · 基准价 <b>💰' + meta.price + '</b>' + (itemTag(meta) ? ' · ' + itemTag(meta) : '') + '</div>' +
      '<div class="cm-sec">词条（数值 / 区间 / 区间位置）</div>' + rowsHtml +
      '<div class="cm-sec">该底材词条池</div><div class="cm-pool">' + poolHtml + '</div>' +
      '</div></div>';
    overlay.appendChild(box);
    document.body.appendChild(overlay);
    box.querySelector('.modal-close').addEventListener('click', closeOverlays);
  }

  // 子分类筛选行：按当前分类给出「品质」或「部位 + 词条/数值范围」二级筛选
  function renderInvSubFilters(st) {
    const row = el('div', 'inv-subfilters');
    const invKeys = Object.keys(st.inventory);
    if (invCategory === 'component') {
      // 一级：部位
      const partCount = {};
      invKeys.forEach(function (id) {
        const m = itemMeta(id);
        if (m.kind !== 'component') return;
        partCount[m.part] = (partCount[m.part] || 0) + st.inventory[id];
      });
      const partsRow = el('div', 'inv-subrow');
      partsRow.appendChild(el('span', 'sub-label', '部位'));
      const total = invKeys.filter(function (id) { return itemMeta(id).kind === 'component'; })
        .reduce(function (n, id) { return n + st.inventory[id]; }, 0);
      [['all', '全部', total]].concat(D.ROD_PARTS.map(function (p) {
        return [p.key, p.name, partCount[p.key] || 0];
      })).forEach(function (kv) {
        if (kv[0] !== 'all' && !kv[2]) return; // 没有该部位组件就不显示，保持紧凑
        const b = el('button', 'inv-cat sub' + (invPart === kv[0] ? ' on' : ''), kv[1] + ' ' + kv[2]);
        b.addEventListener('click', function () { if (invPart !== kv[0]) { invPart = kv[0]; renderView(); } });
        partsRow.appendChild(b);
      });
      row.appendChild(partsRow);

      // 二级：词条类型 + 数值范围
      const affRow = el('div', 'inv-subrow');
      affRow.appendChild(el('span', 'sub-label', '词条'));
      const sel = el('select', 'bulk-select sub-sel');
      [['all', '全部词条']].concat(BD_AFFIXES.map(function (kv) { return [kv[0], kv[1]]; })).forEach(function (kv) {
        const o = el('option', null, kv[1]); o.value = kv[0]; sel.appendChild(o);
      });
      sel.value = invAffixType;
      sel.addEventListener('change', function () { invAffixType = sel.value; renderView(); });
      sel.addEventListener('focus', function () { invFocus = true; });
      sel.addEventListener('blur', function () { invFocus = false; });
      affRow.appendChild(sel);
      const minInp = el('input', 'aff-num');
      minInp.type = 'number'; minInp.placeholder = '最小'; minInp.value = invAffixMin;
      const maxInp = el('input', 'aff-num');
      maxInp.type = 'number'; maxInp.placeholder = '最大'; maxInp.value = invAffixMax;
      function onNum() { invAffixMin = minInp.value; invAffixMax = maxInp.value; renderView(); }
      [minInp, maxInp].forEach(function (n) {
        n.addEventListener('change', onNum);
        n.addEventListener('focus', function () { invFocus = true; });
        n.addEventListener('blur', function () { invFocus = false; });
      });
      affRow.appendChild(minInp);
      affRow.appendChild(el('span', 'sub-label', '~'));
      affRow.appendChild(maxInp);
      const active = invAffixType !== 'all' || invAffixMin !== '' || invAffixMax !== '';
      if (active) {
        const clr = el('button', 'mini', '清除');
        clr.addEventListener('click', function () { invAffixType = 'all'; invAffixMin = ''; invAffixMax = ''; renderView(); });
        affRow.appendChild(clr);
      }
      // 展开/折叠全部
      const exp = el('button', 'mini', '全部展开');
      exp.addEventListener('click', function () {
        const groupIds = Object.keys(st.inventory).filter(function (id) { return itemMeta(id).kind === 'component'; })
          .map(function (id) { return itemMeta(id).baseId; });
        groupIds.forEach(function (b) { invOpen[b] = true; });
        renderView();
      });
      const col = el('button', 'mini', '全部折叠');
      col.addEventListener('click', function () { invOpen = {}; renderView(); });
      affRow.appendChild(exp);
      affRow.appendChild(col);
      row.appendChild(affRow);
    } else {
      // 鱼/材料（含全部）：品质筛选
      const cnt = { all: invKeys.length };
      invKeys.forEach(function (id) {
        if (invCategory !== 'all' && itemMeta(id).kind !== invCategory) return;
        const r = itemMeta(id).rarity;
        cnt[r] = (cnt[r] || 0) + 1;
      });
      const rarRow = el('div', 'inv-subrow');
      rarRow.appendChild(el('span', 'sub-label', '品质'));
      [['all', '全部'], ['common', '普通'], ['rare', '稀有'], ['epic', '史诗'], ['mythic', '神话']].forEach(function (kv) {
        const b = el('button', 'inv-cat sub' + (invSubRar === kv[0] ? ' on' : ''), kv[1] + ' ' + (cnt[kv[0]] || 0));
        b.addEventListener('click', function () { if (invSubRar !== kv[0]) { invSubRar = kv[0]; renderView(); } });
        rarRow.appendChild(b);
      });
      row.appendChild(rarRow);
    }
    return row;
  }

  // 组件分类：按「底材名」分组、可展开；展开后逐件显示属性与操作（单独出售/上架）。
  // 分组键 = 底材 + 品质 + 词条类型集合（不含具体数值）；组内按具体数值排列。
  // 这样同底材同品质、词条种类相同（数值不同）的实例归为一组，便于比较取舍。
  // 组件列表：一级按「底材名」分组（可点击展开/折叠），展开后逐件列出实例（属性 + 单独出售/上架）。
  // 当筛选后只剩一个分组时自动展开，避免多余的点击。
  function renderComponentGroups(list, keys, st, unitPrice, itemValue, doSell) {
    const groups = {};   // baseId → { rep, items: [{id, meta}] }
    keys.forEach(function (id) {
      const meta = D.componentOf(id);
      if (!meta) {
        groups['__legacy__'] = groups['__legacy__'] || { rep: null, items: [] };
        groups['__legacy__'].items.push({ id: id, meta: D.itemOf(id) });
        return;
      }
      const gk = meta.baseId;
      groups[gk] = groups[gk] || { rep: meta, items: [] };
      groups[gk].items.push({ id: id, meta: meta });
    });
    const groupKeys = Object.keys(groups).sort(function (a, b) {
      const ga = groups[a], gb = groups[b];
      if (!ga.rep) return 1;
      if (!gb.rep) return -1;
      const q = (D.QUALITY_ORDER[gb.rep.quality] || 0) - (D.QUALITY_ORDER[ga.rep.quality] || 0);
      if (q) return q;
      return ga.rep.name.localeCompare(gb.rep.name);
    });
    const onlyOne = groupKeys.length === 1;

    groupKeys.forEach(function (gk) {
      const g = groups[gk];
      const totalCnt = g.items.reduce(function (n, it) { return n + st.inventory[it.id]; }, 0);
      const isOpen = onlyOne || !!invOpen[gk];
      // 组标题：底材名（品质色）+ 词条类型摘要 + 件数；点击整行展开/折叠
      const head = el('div', 'inv-group-head clickable' + (isOpen ? ' open' : ''));
      const types = g.rep ? g.rep.affixes.map(function (a) { return D.AFFIX_LABEL[a.type] || a.type; }).join(' · ') : '旧版通用组件';
      const priceRange = (function () {
        const ps = g.items.map(function (it) { return unitPrice(it.id); });
        const lo = Math.min.apply(null, ps), hi = Math.max.apply(null, ps);
        return lo === hi ? (lo + '💰') : (lo + ' ~ ' + hi + '💰');
      })();
      const lockCnt = g.items.reduce(function (n, it) { return n + (rodLockCount(it.id) > 0 ? 1 : 0); }, 0);
      head.innerHTML = '<span class="caret">' + (isOpen ? '▾' : '▸') + '</span>' +
        '<span class="' + qualityClass(g.rep || { kind: 'component', quality: 'common' }) + '">' + esc(g.rep ? g.rep.baseName : '旧版组件') + '</span>' +
        (lockCnt ? '<span class="rod-lock" title="该组有组件被钓竿占用（已锁定，不可单独交易）">🔒 ' + lockCnt + ' 种</span>' : '') +
        itemTag(g.rep) +
        '<span class="inv-group-tag">' + esc(types) + '</span>' +
        '<span class="inv-group-price">' + priceRange + '</span>' +
        '<span class="inv-group-cnt">共 ' + totalCnt + ' 个 / ' + g.items.length + ' 种</span>';
      head.addEventListener('click', function () {
        invOpen[gk] = !isOpen;
        renderView();
      });
      list.appendChild(head);
      if (!isOpen) return;

      // 展开：组内逐件（按词条数值排序，同内容相邻）
      g.items.sort(function (x, y) {
        const sx = x.meta.affixes.map(function (a) { return a.type + ':' + a.value; }).join(',');
        const sy = y.meta.affixes.map(function (a) { return a.type + ':' + a.value; }).join(',');
        return sx < sy ? -1 : (sx > sy ? 1 : 0);
      });
      g.items.forEach(function (it) {
        const meta = it.meta;
        const row = el('div', 'inv-row inv-page-row inv-comp-row indented');
        const affHtml = (meta.affixes || []).map(function (a) {
          const rng = affixRangeIn(meta, a);
          const rngTag = rng ? '<span class="aff-rng">（' + esc(rangeText({ min: rng[0], max: rng[1] })) + '%）</span>' : '';
          return affSpanOpen(a) + esc(affixText(a)) + rngTag + '</span>';
        }).join('');
        row.innerHTML =
          '<span class="inv-comp-affs">' + affHtml + '</span>' +
          rodLockBadge(it.id) +
          '<span class="cnt">×' + st.inventory[it.id] + '</span>' +
          '<span class="unit-price">现价 ' + unitPrice(it.id) + '💰</span>' +
          '<span class="subtotal">小计 ' + itemValue(it.id) + '💰</span>';
        const acts = el('span', 'inv-acts');
        const dt = el('button', 'mini', '属性');
        dt.title = '查看组件词条与数值区间';
        dt.addEventListener('click', function () { openComponentDetail(it.id); });
        acts.appendChild(dt);
        const sb = el('button', 'mini primary-mini', '出售 1');
        sb.title = '单独出售这 1 件（系统固定价）';
        sb.addEventListener('click', function () { doSell(it.id, 1); });
        acts.appendChild(sb);
        const sa = el('button', 'mini', '批量出售');
        sa.addEventListener('click', function () { openBatchSellModal(it.id); });
        acts.appendChild(sa);
        const lb = el('button', 'mini', '上架');
        lb.addEventListener('click', function () { openListModal(it.id); });
        acts.appendChild(lb);
        row.appendChild(acts);
        list.appendChild(row);
      });
    });
  }

  function renderInventory() {
    const main = $('main');
    const st = S();
    // 进入背包即视为已读订阅提醒（清红标与图标闪烁）
    clearSubAlerts(false);
    main.innerHTML = '';
    const panel = el('div', 'panel wide two-col');
    panel.innerHTML = '<h2>🎒 背包 <span class="subtitle">分类 → 子分类筛选（鱼/材料按品质；组件按部位 + 词条数值）· 组件按底材名分组可展开 · 逐件出售/上架</span></h2>';
    // 交易进行中：背包内容锁定（新渔获不会自动刷新列表，避免交易选物品时被冲掉）
    if (tradeLockOn()) panel.appendChild(tradeLockBar());

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
    const kindCount = { fish: 0, material: 0, chest: 0, component: 0 };
    Object.keys(st.inventory).forEach(function (id) {
      const k = itemMeta(id).kind;
      if (kindCount[k] != null) kindCount[k] += 1;
    });
    const tabs = el('div', 'inv-cats');
    [['all', '📦 全部', Object.keys(st.inventory).length], ['fish', '🐟 鱼类', kindCount.fish], ['material', '🧵 材料', kindCount.material], ['chest', '🎁 宝匣', kindCount.chest], ['component', '🔧 组件', kindCount.component]].forEach(function (kv) {
      const b = el('button', 'inv-cat' + (invCategory === kv[0] ? ' on' : ''), kv[1] + ' ' + kv[2]);
      b.addEventListener('click', function () { if (invCategory !== kv[0]) { invCategory = kv[0]; renderView(); } });
      tabs.appendChild(b);
    });

    const colMain = el('div', 'col-main');
    colMain.appendChild(el('h3', null, '📦 物品明细'));
    colMain.appendChild(tabs);
    colMain.appendChild(renderInvSubFilters(st)); // 子分类行（品质 / 部位 / 词条+数值）
    const list = el('div', 'inv-page');
    let keys = Object.keys(st.inventory);
    if (invCategory !== 'all') keys = keys.filter(function (id) { return itemMeta(id).kind === invCategory; });
    if (invCategory === 'component') {
      // 组件：一级按部位、二级按词条+数值范围筛选；列表按底材名分组可展开
      keys = keys.filter(function (id) {
        const m = itemMeta(id);
        if (invPart !== 'all' && (m.part || '') !== invPart) return false;
        if (invAffixType === 'all' && invAffixMin === '' && invAffixMax === '') return true;
        if (!m.affixes) return false;
        return m.affixes.some(function (a) {
          if (invAffixType !== 'all' && a.type !== invAffixType) return false;
          if (invAffixMin !== '' && a.value < Number(invAffixMin)) return false;
          if (invAffixMax !== '' && a.value > Number(invAffixMax)) return false;
          return true;
        });
      });
    } else if (invSubRar !== 'all') {
      keys = keys.filter(function (id) { return itemMeta(id).rarity === invSubRar; });
    }
    if (keys.length === 0) {
      list.appendChild(el('div', 'hint', Object.keys(st.inventory).length === 0
        ? '背包空空如也。去「钓鱼」页选个钓点抛竿，渔获会自动入包。'
        : '该筛选条件下没有物品。'));
    } else if (invCategory === 'component') {
      renderComponentGroups(list, keys, st, unitPrice, itemValue, doSell);
    } else {
      // 按单价排序：出售/获得不改变行位置（排序与数量无关）
      keys.sort(function (a, b) { return unitPrice(b) - unitPrice(a) || (a < b ? -1 : 1); });
      keys.forEach(function (id) {
        const meta = itemMeta(id);
        const cnt = st.inventory[id];
        const kindName = meta.kind === 'fish' ? '鱼' : meta.kind === 'material' ? '材料' : meta.kind === 'chest' ? '宝匣' : meta.kind === 'component' ? '组件' : '物品';
        const row = el('div', 'inv-row inv-page-row');
        row.innerHTML =
          '<span class="' + qualityClass(meta) + '">' + esc(meta.name) + '</span>' +
          '<span class="kind-tag">' + kindName + '</span>' +
          rodLockBadge(id) +
          '<span class="cnt">×' + cnt + '</span>' +
          '<span class="unit-price">现价 ' + unitPrice(id) + '💰</span>' +
          '<span class="subtotal">小计 ' + itemValue(id) + '💰</span>';
        const acts = el('span', 'inv-acts');
        // 宝匣只能市集交易（系统商店不收购），所以不出售按钮，只给「上架」+ 前往开箱页
        if (meta.kind !== 'chest') {
          const sellBtn = el('button', 'mini primary-mini', '出售 1');
          sellBtn.title = '按当前系统收购价出售 1 个';
          sellBtn.addEventListener('click', function () { doSell(id, 1); });
          acts.appendChild(sellBtn);
          const sellAll = el('button', 'mini', '批量出售');
          sellAll.title = '打开批量出售子窗口：可填数量或用滑块，并查看价格趋势';
          sellAll.addEventListener('click', function () { openBatchSellModal(id); });
          acts.appendChild(sellAll);
        } else {
          const goChest = el('button', 'mini', '去开箱');
          goChest.title = '宝匣只能在「宝匣合成」页开箱；系统商店不收购宝匣';
          goChest.addEventListener('click', function () { currentView = 'chest'; renderNav(); renderView(); loadViewData('chest'); });
          acts.appendChild(goChest);
        }
        const lb = el('button', 'mini', '上架');
        lb.title = '挂到开放市集（选择时长，支付对应上架费，下架不退）';
        lb.addEventListener('click', function () { openListModal(id); });
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

    // 一键出售（预览弹窗）+ 组件订阅提醒入口
    const bulk = el('div', 'bulk-sell');
    const bbtn = el('button', 'primary big', '⚡ 一键出售（预览）');
    bbtn.title = '打开预览子窗口：筛选后可逐项勾选与调整数量，确认后才会出售';
    bbtn.addEventListener('click', openBulkSellModal);
    bulk.appendChild(bbtn);
    const subBtn = el('button', 'mini sub-entry', '🔔 组件订阅提醒' + (subUnseen > 0 ? '（' + subUnseen + ' 条未读）' : ''));
    subBtn.title = '设置组件到货提醒：筛选条件 + 提醒方式（背包红标 / 浏览器图标闪烁）';
    subBtn.addEventListener('click', openSubscribeModal);
    bulk.appendChild(subBtn);
    side.appendChild(bulk);

    const breakdown = el('div', 'inv-breakdown');
    [['fish', '🐟 鱼类'], ['material', '🧵 材料'], ['chest', '🎁 宝匣'], ['component', '🔧 组件']].forEach(function (kv) {
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
        row.innerHTML = '<span class="' + qualityClass(itemMeta(l.id)) + '">' + esc(l.name) + '</span>' +
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
  // 交易锁定：交易进入选物品阶段后，背包与交易页的列表不随广播重绘——
  // 否则别人上鱼 / 自己上鱼（assets 广播）都会重建 DOM，把正在挑选的物品窗口刷新掉。
  // 需要看最新库存时点锁定条上的「刷新」按钮（草稿勾选会保留）。
  function tradeLockOn() {
    const t = S().trade;
    return !!(t && t.accepted && !t.done && !t.cancelled);
  }
  function tradeLockBar() {
    const bar = el('div', 'trade-lock');
    bar.innerHTML = '<span>🔒 交易进行中：背包内容已锁定，新渔获 / 广播不会刷新此列表</span>';
    const rf = el('button', 'mini', '🔄 刷新列表');
    rf.title = '按当前库存重建列表（已勾选的提供项保留）';
    rf.addEventListener('click', function () { renderTopbar(); renderView(); toast('列表已按当前库存刷新'); });
    bar.appendChild(rf);
    return bar;
  }
  // 冷却倒计时（锁定期间只改文字，不整页重建）
  function updateTradeCountdown(cd) {
    const stage = document.querySelector('.trade-head .th-stage');
    if (stage) stage.textContent = cd > 0 ? ('确认已重置，冷却 ' + Math.ceil(cd / 1000) + 's') : '请双方放入物品并确认';
    const btn = document.querySelector('.trade-actions button.primary');
    if (btn && !btn.classList.contains('done')) {
      btn.textContent = cd > 0 ? ('冷却中 ' + Math.ceil(cd / 1000) + 's') : '确认交易';
      btn.classList.toggle('locked', cd > 0);
    }
  }
  // 交易草稿状态：必须放在模块级并在重绘间保留，否则任何一次重绘
  // （SSE 广播非常频繁）都会把用户刚勾选的物品清空。
  let tradeDraft = { tid: null, sel: {} };
  let tradePickCat = 'all'; // 提供物品列表的分类页签（全部/鱼类/材料/组件）

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
    // 交易进行中：提示列表已锁定（新渔获不会自动刷新，可手动刷新）
    if (tradeLockOn()) panel.appendChild(tradeLockBar());

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

  // 交易双方可见的「提供」栏：除名称/数量外，展示物品信息——
  // 组件：品质 + 词条条数 + 每条词条的数值与底材区间（负值红色）；渔获/材料：稀有度 + 基准价。
  // 双方用同一渲染函数，物品实例签名（id）即包含词条，因此对方也能看到完整属性。
  function tradeSide(title, items, ok, isMine) {
    const box = el('div', 'trade-side' + (isMine ? ' mine' : ''));
    box.innerHTML = '<div class="ts-head">' + esc(title) + (ok ? ' <span class="ok-tag">✔ 已确认</span>' : ' <span class="wait-tag">待确认</span>') + '</div>';
    const list = el('div', 'ts-list');
    if (!items || items.length === 0) list.appendChild(el('div', 'hint', '（空）'));
    (items || []).forEach(function (it) {
      const meta = itemMeta(it.id);
      const row = el('div', 'ts-item');
      const affHtml = (meta.kind === 'component' && meta.affixes && meta.affixes.length)
        ? '<div class="mk-aff">' + meta.affixes.map(function (a) {
            const rng = affixRangeIn(meta, a);
            const rangeTag = rng ? '<span class="aff-rng">（' + esc(rangeText({ min: rng[0], max: rng[1] })) + '%）</span>' : '';
            return affSpanOpen(a) + esc(affixText(a)) + rangeTag + '</span>';
          }).join('') + itemTag(meta) + '</div>'
        : '';
      const subHtml = meta.kind === 'component'
        ? '<div class="ts-sub">' + esc(qualityName(meta)) + '品质 · ' + meta.affixes.length + '/' + meta.maxAffixes + ' 词条 · 基准价 ' + meta.price + '💰</div>'
        : '<div class="ts-sub">' + esc(qualityName(meta)) + (meta.price ? ' · 基准价 ' + meta.price + '💰' : '') + '</div>';
      row.innerHTML = '<div class="ts-line"><span class="' + qualityClass(meta) + '">' + esc(meta.name) + '</span>' +
        '<span class="cnt">×' + it.qty + '</span></div>' + subHtml + affHtml;
      list.appendChild(row);
    });
    box.appendChild(list);
    return box;
  }

  // 我方物品选择器：分类页签（同背包）+ 勾选 + 数量 + 组件词条直显。
  // 选择写入模块级草稿，重绘不丢失。点「更新我的提供」提交后，服务器让双方确认作废并进入 3s 冷却。
  function tradePicker(t, sel) {
    const st = S();
    // 清理已不在背包中的草稿项（例如中途把物品卖掉了）
    Object.keys(sel).forEach(function (id) { if (!(st.inventory[id] > 0)) delete sel[id]; });
    const box = el('div', 'trade-picker');
    box.innerHTML = '<div class="tp-head">选择我要提供的物品（改动会重置双方确认）</div>';
    const allKeys = Object.keys(st.inventory);
    if (allKeys.length === 0) { box.appendChild(el('div', 'hint', '背包为空，无法提供物品。')); return box; }

    // 分类页签：与背包一致的「全部 / 鱼类 / 材料 / 组件」
    const kindCount = { fish: 0, material: 0, chest: 0, component: 0 };
    allKeys.forEach(function (id) { const k = itemMeta(id).kind; if (kindCount[k] != null) kindCount[k] += 1; });
    const tabs = el('div', 'inv-cats tp-cats');
    [['all', '📦 全部', allKeys.length], ['fish', '🐟 鱼类', kindCount.fish], ['material', '🧵 材料', kindCount.material], ['chest', '🎁 宝匣', kindCount.chest], ['component', '🔧 组件', kindCount.component]].forEach(function (kv) {
      const b = el('button', 'inv-cat' + (tradePickCat === kv[0] ? ' on' : ''), kv[1] + ' ' + kv[2]);
      b.addEventListener('click', function () { if (tradePickCat !== kv[0]) { tradePickCat = kv[0]; renderView(); } });
      tabs.appendChild(b);
    });
    box.appendChild(tabs);

    let keys = allKeys;
    if (tradePickCat !== 'all') keys = keys.filter(function (id) { return itemMeta(id).kind === tradePickCat; });
    // 排序：组件在前（词条可比较），其余按现价降序；数量/勾选变化不改变行位置
    keys.sort(function (a, b) {
      const ca = itemMeta(a).kind === 'component' ? 0 : 1, cb = itemMeta(b).kind === 'component' ? 0 : 1;
      if (ca !== cb) return ca - cb;
      return unitPriceOf(b) - unitPriceOf(a) || (a < b ? -1 : 1);
    });
    if (!keys.length) { box.appendChild(el('div', 'hint', '该分类下没有可提供的物品。')); return box; }

    const rows = el('div', 'tp-rows');
    keys.forEach(function (id) {
      const meta = itemMeta(id);
      const have = st.inventory[id];
      const checked = sel[id] != null && sel[id] > 0;
      const qty = checked ? Math.min(sel[id], have) : 1;
      const row = el('div', 'tp-row');
      const affHtml = (meta.kind === 'component' && meta.affixes && meta.affixes.length)
        ? '<div class="mk-aff">' + meta.affixes.map(function (a) {
            const rng = affixRangeIn(meta, a);
            const rangeTag = rng ? '<span class="aff-rng">（' + esc(rangeText({ min: rng[0], max: rng[1] })) + '%）</span>' : '';
            return affSpanOpen(a) + esc(affixText(a)) + rangeTag + '</span>';
          }).join('') + itemTag(meta) + '</div>'
        : '';
      row.innerHTML = '<label class="tp-name"><input type="checkbox"' + (checked ? ' checked' : '') + ' /> <span class="' +
        qualityClass(meta) + '">' + esc(meta.name) + '</span>' + rodLockBadge(id) + '</label>' + affHtml +
        '<span class="tp-have">持有 ' + have + '</span>' +
        '<input class="tp-qty" type="number" min="1" max="' + have + '" value="' + qty + '"' + (checked ? '' : ' disabled') + ' />';
      if (meta.kind === 'component') {
        const dt = el('button', 'mini tp-attr', '属性');
        dt.title = '查看组件词条与数值区间';
        dt.addEventListener('click', function () { openComponentDetail(id); });
        row.appendChild(dt);
      }
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
      if (items.length === 0) {
        confirmModal({ title: '清空我的提供', html: '你还没有选择任何物品，确定要清空「我的提供」吗？', okText: '清空' }).then(function (ok) {
          if (!ok) return;
          call(window.Net.tradeSet(t.id, items), '已更新我的提供（双方确认已重置）').then(function (r) { if (r && r.ok) setTimeout(refreshAll, 200); });
        });
        return;
      }
      call(window.Net.tradeSet(t.id, items), '已更新我的提供（双方确认已重置）').then(function (r) { if (r && r.ok) setTimeout(refreshAll, 200); });
    });
    box.appendChild(apply);
    return box;
  }

  // ---- 鱼类图鉴视图 ----
  // 当前分类（模块级：重绘间保留）；详情改为子窗口，无需记录展开项
  let codexCategory = 'all';
  let mapTab = 'nearshore'; // 钓鱼页地图页签：nearshore 近岸 / voyage 出海预告
  let codexSortRarity = false;

  // 图鉴详情浮层：完整信息 + 全部产地（点击卡片开合；未解锁也可查看获取信息）
  // 图鉴详情：子窗口展示（替代原先卡片内展开）
  function openCodexDetail(it, rec) {
    const spots = D.spotsOf(it.id);
    const base = it.kind === 'component' ? D.componentBase(it.id) : null;
    const rarityName = qualityName(it);
    closeOverlays();
    const overlay = buildOverlay(function () { closeOverlays(); });
    const box = el('div', 'modal-box codex-modal');
    box.innerHTML = '<div class="modal-head"><span class="modal-title">' + esc(it.name) + '</span>' +
      '<button class="mini modal-close">✕ 关闭</button></div>' +
      '<div class="modal-body"><div class="codex-detail"></div></div>';
    overlay.appendChild(box);
    document.body.appendChild(overlay);
    box.querySelector('.modal-close').addEventListener('click', function () { closeOverlays(); });

    const inner = box.querySelector('.codex-detail');
    const cdIconSrc = it.kind === 'fish' ? 'assets/fish/' + esc(it.id) + '.png'
      : (it.kind === 'material' || it.kind === 'component') ? 'assets/item/' + esc(it.id) + '.png'
      : null;
    const cdIcon = cdIconSrc ? '<img class="cd-icon" src="' + cdIconSrc + '" alt="" draggable="false">' : '';
    inner.innerHTML =
      cdIcon +
      '<div class="cd-title ' + qualityClass(it) + '">' + esc(it.name) + '</div>' +
      (rec
        ? '<div class="cd-line">已钓 <b>' + rec.count + '</b> 次 · 首获 ' + timeStr(rec.first) + '</div>'
        : '<div class="cd-line muted">未解锁 · 去产地垂钓即可解锁</div>') +
      '<div class="cd-line">' + (base ? '组件底材' : '稀有度') + '：' + rarityName + ' · 基准价 ' + (it.price || 0) + '💰</div>' +
      (it.size ? '<div class="cd-line">体型 ' + it.size[0] + '-' + it.size[1] + ' cm</div>' : (base ? '' : '<div class="cd-line">材料 / 组件</div>')) +
      (rec && rec.max != null ? '<div class="cd-line">我钓到过：最大 <b>' + rec.max + '</b> cm · 最小 <b>' + rec.min + '</b> cm</div>' : '') +
      (rec && rec.max == null && it.size ? '<div class="cd-line muted">个人体型极值将在下次钓到后开始记录</div>' : '');
    if (base) {
      const cap = D.QUALITY.epic.cap;
      inner.appendChild(el('div', 'cd-sub', '⚙ 可拥有词缀（' + base.pool.length + ' 条 · 数值范围）'));
      const al = el('div', 'cd-spots');
      base.pool.forEach(function (p) {
        const rng = D.affixRangeOf ? D.affixRangeOf(base.id, p) : [p.min, p.max];
        const neg = rng[1] < 0;
        al.appendChild(el('div', 'cd-spot' + (neg ? ' cd-aff-neg' : ''),
          (D.AFFIX_LABEL[p.type] || p.type) + ' ' + rangeText({ min: rng[0], max: rng[1] }) + '%'));
      });
      inner.appendChild(al);
      const nw = (D.getComponentCfg && D.getComponentCfg().countWeights) || {};
      inner.appendChild(el('div', 'cd-line muted',
        '生成规则：从以上词缀中抽取 1 至 ' + Math.min(cap, base.pool.length) + ' 条并 roll 数值（模型：' +
        ((D.getComponentCfg && D.getComponentCfg().rollModel) || 'linear') + '）；品质越高可携带词缀越多。'));
      // 图鉴不再展示「满词条」标记：那是实例的属性，不该挂在底材/条目上
    }
    const comp = !base && it.kind === 'component' ? D.componentOf(it.id) : null;
    if (comp && comp.affixes && comp.affixes.length) {
      inner.appendChild(el('div', 'cd-sub', '⚙ 组件效果'));
      const al = el('div', 'cd-spots');
      comp.affixes.forEach(function (a) {
        al.appendChild(el('div', 'cd-spot' + (a.value < 0 ? ' cd-aff-neg' : ''), esc(affixText(a))));
      });
      inner.appendChild(al);
    }
    if (spots.length) {
      inner.appendChild(el('div', 'cd-sub', '📍 产出地点（全部 ' + spots.length + ' 处）'));
      const sl = el('div', 'cd-spots');
      spots.forEach(function (s) { sl.appendChild(el('div', 'cd-spot', '🎣 ' + esc(s))); });
      inner.appendChild(sl);
    } else {
      inner.appendChild(el('div', 'cd-line muted', '暂无产地信息。'));
    }
  }

  // 玩家背包中某底材的实例统计（用于图鉴金色满词条标注）
  // —— 钓点图鉴：查看各钓点能钓到什么，以及实时产出概率 ——
  // 数据源是 D.GROUNDS（后台改掉落池/增益后经 SSE groundcfg 推送、原位替换），
  // 弹窗开着时收到 groundcfg 会立即重绘（见 refreshAll 顶部钩子），所以始终与后台一致。
  let spotDetailRedraw = null;
  function openSpotDetail(groundId, spotId) {
    closeOverlays();
    function close() { spotDetailRedraw = null; closeOverlays(); }
    const overlay = buildOverlay(close);
    const box = el('div', 'modal-box codex-modal');
    box.innerHTML = '<div class="modal-head"><span class="modal-title">📍 钓点详情</span>' +
      '<button class="mini modal-close">✕ 关闭</button></div>' +
      '<div class="modal-body"><div class="codex-detail spot-detail"></div></div>';
    overlay.appendChild(box);
    document.body.appendChild(overlay);
    box.querySelector('.modal-close').addEventListener('click', close);
    function draw() {
      const g = D.GROUNDS.find(function (x) { return x.id === groundId; });
      const sp = g && (g.spots || []).find(function (x) { return x.id === spotId; });
      if (!g || !sp) return close(); // 该钓点刚被删除
      box.querySelector('.modal-title').textContent = '📍 ' + g.name + ' · ' + sp.name;
      const inner = box.querySelector('.spot-detail');
      const pool = (sp.pool || []).slice().sort(function (a, b) { return (b.weight || 0) - (a.weight || 0); });
      const total = pool.reduce(function (s, e) { return s + Math.max(0, e.weight || 0); }, 0);
      let html = '<div class="cd-line">' + (g.locked ? '🔒 钓场锁定中' : '🎣 可垂钓') +
        (sp.biteRate != null && sp.biteRate !== '' ? ' · 上鱼率 ' + esc(String(sp.biteRate)) + '%（钓点独立）' : '') +
        (sp.intervalMs ? ' · 抛竿间隔 ' + esc(String(sp.intervalMs)) + 'ms（钓点独立）' : '') + '</div>';
      if (sp.buffs && sp.buffs.length) {
        html += '<div class="cd-line">⚡ 增益：' + sp.buffs.map(function (bf) {
          return esc(affixName(bf.type) + (bf.value > 0 ? '+' : '') + bf.value + '%');
        }).join(' · ') + '</div>';
      }
      html += '<div class="cd-sub">🎯 可钓物品与实时产出概率（' + pool.length + ' 项）</div>';
      if (!pool.length) {
        html += '<div class="cd-line muted">该钓点尚未配置掉落池（可在后台「渔场钓点」配置）。</div>';
      } else {
        html += '<div class="spot-pool">';
        pool.forEach(function (e) {
          const i = e.pick.indexOf(':');
          const type = i < 0 ? e.pick : e.pick.slice(0, i);
          const iid = i < 0 ? '' : e.pick.slice(i + 1);
          let name = '组件（随机组件掉落）', cls = '';
          if (type === 'fish' || type === 'material') { const m = D.itemOf(iid); name = m.name; cls = qualityClass(m); }
          const w = Math.max(0, e.weight || 0);
          const pct = total > 0 ? Math.round(w / total * 1000) / 10 : 0;
          html += '<div class="spot-pool-row" data-pick="' + esc(e.pick) + '" data-pct="' + pct + '">' +
            '<span class="' + cls + '">' + esc(name) + '</span>' +
            '<span class="sp-type">' + esc(type === 'fish' ? '鱼' : (type === 'material' ? '材料' : '组件')) + '</span>' +
            '<span class="sp-bar"><i style="width:' + pct + '%"></i></span>' +
            '<span class="sp-pct">' + pct + '%</span>' +
            '<span class="hint">权重 ' + (e.weight || 0) + '</span></div>';
        });
        html += '</div>';
        html += '<div class="cd-line muted">以上为基础权重占比（与后台「渔场钓点」配置一致，改动即时同步）；' +
          '钓竿的大鱼 / 稀有 / 材料词缀会在此基础上放大对应类别的权重。</div>';
      }
      inner.innerHTML = html;
    }
    spotDetailRedraw = draw;
    draw();
  }

  // ---- 宝匣合成（沉船打捞）----
  // 四档梯度，每一档消除一层随机（档位定义见 data.js 的 CHESTS）：
  //   Ⅰ 基底随机 → Ⅱ 自选部位 → Ⅲ 自选底材 + 满词条 → Ⅳ 自选底材 + 神话（50% 突破词缀池边界）
  // 合成 = 残片 × costRelic + 金币 costCoins → 宝匣入包；开箱 = 服务器权威掷骰 → 组件实例。
  // 宝匣可市集交易但不可卖给系统商店；残片来自礁石区（可用「材料概率」词缀提高产出）。
  function chestPlanText(chest) {
    if (chest.extra) {
      const hit = Math.round((chest.chance != null ? chest.chance : 0.5) * 100);
      return '必定神话 · ' + hit + '% 突破到 4 词条（补 1~2 条本部位没有的词缀）';
    }
    if (chest.forceMax) return '必定史诗 · 词条填满该底材的词缀池';
    const w = chest.qualityWeights || {};
    const qn = function (k) { return (D.QUALITY[k] || {}).name || k; };
    const parts = Object.keys(w).map(function (k) { return qn(k) + ' ' + w[k] + '%'; }).join(' / ');
    return (chest.mode === 'part' ? '自选部位 · ' : '随机底材 · ') +
      '至少 ' + (chest.minAffixes || 1) + ' 条词缀' + (parts ? ' · ' + parts : '');
  }
  function chestMaxCraftable(chest, relicHave, coins) {
    const byRelic = Math.floor(relicHave / chest.costRelic);
    const byCoins = chest.costCoins > 0 ? Math.floor(coins / chest.costCoins) : 99;
    return Math.max(0, Math.min(99, byRelic, byCoins));
  }
  // 开箱目标选择控件：mode='part' 列出部位；mode='base' 列出底材（按部位分 optgroup）
  function chestTargetHtml(chest) {
    const opts = [];
    D.ROD_PARTS.forEach(function (p) {
      const cands = D.COMPONENT_BASES.filter(function (b) { return b.part === p.key; });
      if (!cands.length) return;
      if (chest.mode === 'part') {
        opts.push('<option value="' + esc(p.key) + '">' + esc(p.name) + '（' + cands.length + ' 种底材）</option>');
      } else {
        opts.push('<optgroup label="' + esc(p.name) + '">' + cands.map(function (b) {
          return '<option value="' + esc(b.id) + '">' + esc(b.name) + '</option>';
        }).join('') + '</optgroup>');
      }
    });
    return '<select class="bulk-select" id="chest-target">' + opts.join('') + '</select>';
  }
  // 词缀后括号里的数值区间：池内取底材区间，池外取「池外词缀区间」表
  function chestAffixRange(meta, a) {
    if (a.extra) {
      const r = D.extraAffixRangeOf ? D.extraAffixRangeOf(a.type) : null;
      return r ? rangeText({ min: r[0], max: r[1] }) : '';
    }
    const pool = (meta.pool || []).find(function (p) { return p.type === a.type; });
    if (!pool) return '';
    const rng = D.affixRangeOf ? D.affixRangeOf(meta.baseId, pool) : [pool.min, pool.max];
    return rangeText({ min: rng[0], max: rng[1] });
  }
  // 开箱结果卡片（大图展示一件组件实例）
  function chestItemCardHtml(meta) {
    const extras = meta.affixes.filter(function (a) { return a.extra; });
    // 品质类只挂叶子文本节点：.q-mythic 用 transparent 文字填充 + 背景裁切做彩虹字，
    // 而 -webkit-text-fill-color 是会继承的，挂到容器上会让整块文本（含标签）一起消失。
    return '<div class="chest-result">' +
      '<div class="cr-name ' + qualityClass(meta) + '">' + esc(meta.name) + itemTag(meta) + '</div>' +
      '<div class="cr-meta">' + esc(meta.qualityName) + '品质 · ' + meta.affixes.length + '/' + meta.maxAffixes +
        ' 词条 · 基准价 ' + meta.price + '💰</div>' +
      '<div class="cr-affs">' + meta.affixes.map(function (a) {
        const rng = chestAffixRange(meta, a);
        return affSpanOpen(a) + esc(affixText(a)) +
          (rng ? '<span class="aff-rng">（' + esc(rng) + '%）</span>' : '') + '</span>';
      }).join('') + '</div>' +
      (extras.length
        ? '<div class="cr-note">★ 标记的词缀不在「' + esc(meta.baseName) + '」的词缀池内——这是宝匣突破件补足的额外词缀。</div>'
        : (meta.breakthrough ? '' : '')) +
      '</div>';
  }
  function showChestResult(chest, data) {
    const meta = data.item;
    const st = S();
    const overlay = buildOverlay(null);
    const box = el('div', 'modal-box confirm-modal chest-result-modal');
    const pityN = data.pityN || 0;
    let pityLine = '';
    if (chest.extra && pityN > 0) {
      pityLine = data.forced
        ? '<div class="cr-pity hit">⚡ 保底触发：本次必出突破件</div>'
        : '<div class="cr-pity">保底：已连续 ' + (data.pityNow || 0) + ' 次未突破，再 ' +
            Math.max(0, (pityN - 1) - (data.pityNow || 0)) + ' 次未突破则必出</div>';
    }
    box.innerHTML = '<div class="modal-head"><span class="modal-title">🎁 开箱结果 · ' + esc(data.chestName || chest.name) + '</span>' +
      '<button class="mini modal-close">✕ 关闭</button></div>' +
      '<div class="modal-body">' +
      chestItemCardHtml(meta) +
      pityLine +
      '<div class="cf-actions">' +
      '<button class="mini primary-mini cr-again">再开一个（持有 ' + (data.chests ? (data.chests.find(function (c) { return c.id === chest.id; }) || {}).have || 0 : 0) + '）</button>' +
      '<button class="mini cr-ok">收下</button></div>' +
      '<div class="hint" style="margin-top:6px">开出的组件已进背包，可装备 / 出售 / 上架。</div>' +
      '</div>';
    overlay.appendChild(box);
    document.body.appendChild(overlay);
    const close = function () { overlay.remove(); };
    box.querySelector('.modal-close').addEventListener('click', close);
    box.querySelector('.cr-ok').addEventListener('click', close);
    if (overlay) overlay.addEventListener('click', function (ev) { if (ev.target === overlay) close(); });
    box.querySelector('.cr-again').addEventListener('click', function () {
      close();
      openChestModal(chest);
    });
    void st;
  }
  // 开箱子窗口：自选目标（Ⅱ/Ⅲ/Ⅳ）+ 确认；Ⅰ 档直接开
  function openChestModal(chest) {
    const st = S();
    const info = (st.chest && st.chest.chests || []).find(function (c) { return c.id === chest.id; }) || {};
    const have = info.have || 0;
    if (have <= 0) { toast('没有「' + chest.name + '」可开，请先合成'); return; }
    const doOpen = function (sel) {
      Promise.resolve(window.Net.chestOpen(chest.id, sel)).then(function (r) {
        if (!r || !r.ok) { toast((r && r.data && r.data.error) || '开箱失败'); return null; }
        st.player.coins = r.data.coins;
        st.inventory = r.data.inventory;
        if (r.data.chests) st.chest = Object.assign({}, st.chest, { chests: r.data.chests });
        renderTopbar(); renderView();
        showChestResult(chest, r.data);
        return r;
      }).catch(function () { toast('网络错误'); });
    };
    if (chest.mode === 'random') { doOpen({}); return; }
    const overlay = buildOverlay(null);
    const box = el('div', 'modal-box confirm-modal');
    box.innerHTML = '<div class="modal-head"><span class="modal-title">🎁 开箱 · ' + esc(chest.name) + '</span>' +
      '<button class="mini modal-close">✕ 关闭</button></div>' +
      '<div class="modal-body">' +
      '<div class="cr-plan">' + esc(chestPlanText(chest)) + '</div>' +
      '<div class="cf-row"><label>' + (chest.mode === 'part' ? '选择部位' : '选择底材') + '</label>' + chestTargetHtml(chest) + '</div>' +
      '<div class="hint" id="chest-target-hint"></div>' +
      (chest.extra && (st.chest && st.chest.pityN) > 0
        ? '<div class="cr-pity">保底：已连续 ' + (info.pityNow || 0) + ' 次未突破，再 ' +
            Math.max(0, ((st.chest.pityN - 1) - (info.pityNow || 0))) + ' 次未突破则必出</div>' : '') +
      '<div class="cf-actions"><button class="mini cf-cancel">取消</button>' +
      '<button class="mini primary-mini cf-ok">开箱（持有 ' + have + '）</button></div>' +
      '</div>';
    overlay.appendChild(box);
    document.body.appendChild(overlay);
    const sel = box.querySelector('#chest-target');
    const hint = box.querySelector('#chest-target-hint');
    const updHint = function () {
      if (!sel || !hint) return;
      const v = sel.value;
      if (chest.mode === 'part') {
        const n = D.COMPONENT_BASES.filter(function (b) { return b.part === v; }).length;
        hint.textContent = '该部位有 ' + n + ' 种底材，具体是哪一种随机（这就是「自选部位」与「自选底材」的差别）。';
      } else {
        const b = D.componentBase(v);
        if (b) hint.textContent = '词缀池：' + b.pool.map(function (p) { return (D.AFFIX_LABEL[p.type] || p.type) + ' ' + rangeText(p) + '%'; }).join(' · ');
      }
    };
    if (sel) { sel.addEventListener('change', updHint); updHint(); }
    const close = function () { overlay.remove(); };
    box.querySelector('.modal-close').addEventListener('click', close);
    box.querySelector('.cf-cancel').addEventListener('click', close);
    overlay.addEventListener('click', function (ev) { if (ev.target === overlay) close(); });
    box.querySelector('.cf-ok').addEventListener('click', function () {
      const v = sel ? sel.value : '';
      close();
      doOpen(chest.mode === 'part' ? { part: v } : { baseId: v });
    });
  }
  function renderChest() {
    const main = $('main');
    const st = S();
    const info = st.chest;
    main.innerHTML = '';
    const panel = el('div', 'panel wide');
    panel.innerHTML = '<h2>🎁 宝匣合成 <span class="subtitle">沉船打捞 · 残片换确定性：每一档消除一层随机</span></h2>';
    if (!info) {
      panel.appendChild(el('div', 'hint', '宝匣数据加载中…（若长时间无响应请刷新页面）'));
      main.appendChild(panel);
      return;
    }
    // 残片与宝匣持有量以背包为权威（SSE assets 会持续刷新），不用服务端快照里可能已过期的 have
    const invNow = st.inventory || {};
    const relicHave = invNow.relic || 0;
    const coins = st.player.coins || 0;
    const pityN = info.pityN || 0;
    panel.appendChild(el('div', 'chest-bar',
      '<span class="cb-item">' + esc(info.relicName || '沉船宝匣残片') + ' ×<b>' + relicHave + '</b></span>' +
      '<span class="cb-item">💰 <b>' + coins + '</b></span>' +
      '<span class="cb-item hint">残片来自「落日海湾 · 礁石区」，钓竿的「材料概率」词缀可提高产出</span>' +
      (pityN > 0 ? '<span class="cb-item hint">突破保底：连续 ' + (pityN - 1) + ' 次未突破后必出</span>' : '')));

    const grid = el('div', 'chest-grid');
    D.CHESTS.forEach(function (chest) {
      const cur = (info.chests || []).find(function (c) { return c.id === chest.id; }) || {};
      const have = invNow[chest.id] || 0;
      const maxN = chestMaxCraftable(chest, relicHave, coins);
      // 品质类只挂 .cc-name（叶子），见 chestItemCardHtml 的同款注释
      const card = el('div', 'chest-card');
      const pityLine = (chest.extra && pityN > 0)
        ? (cur.pityNow >= pityN - 1
            ? '<div class="cc-pity hit">⚡ 下次开箱必出突破件</div>'
            : '<div class="cc-pity">保底：已连续 ' + (cur.pityNow || 0) + ' 次未突破，再 ' + Math.max(0, (pityN - 1) - (cur.pityNow || 0)) + ' 次必出</div>')
        : '';
      card.innerHTML =
        '<img class="cc-icon" src="assets/item/' + esc(chest.id) + '.png" alt="" draggable="false">' +
        '<div class="cc-head"><span class="cc-name ' + (D.QUALITY[chest.rarity] ? D.QUALITY[chest.rarity].cls : '') + '">' + esc(chest.name) + '</span>' +
          '<span class="cc-have">持有 ×' + have + '</span></div>' +
        '<div class="cc-desc">' + esc(chest.desc) + '</div>' +
        '<div class="cc-plan">' + esc(chestPlanText(chest)) + '</div>' +
        '<div class="cc-cost">消耗：' + esc(info.relicName || '残片') + ' ×<b>' + chest.costRelic + '</b>' +
          ' + 💰<b>' + chest.costCoins + '</b></div>' +
        pityLine +
        '<div class="cc-acts"></div>';
      const acts = card.querySelector('.cc-acts');
      const b1 = el('button', 'mini primary-mini', '合成 ×1');
      b1.disabled = maxN < 1;
      b1.title = maxN < 1 ? '残片或金币不足' : '消耗 ' + chest.costRelic + ' 残片 + ' + chest.costCoins + ' 金币';
      b1.addEventListener('click', function () { craftChest(chest, 1); });
      acts.appendChild(b1);
      if (maxN > 1) {
        const bAll = el('button', 'mini', '合成最多 ×' + maxN);
        bAll.title = '消耗 ' + (chest.costRelic * maxN) + ' 残片 + ' + (chest.costCoins * maxN) + ' 金币';
        bAll.addEventListener('click', function () {
          confirmModal({ title: '批量合成', okText: '合成 ×' + maxN,
            html: '合成 <b>' + maxN + '</b> 个「' + esc(chest.name) + '」？<br/>消耗 ' +
              (chest.costRelic * maxN) + ' 个' + esc(info.relicName || '残片') + ' + 💰' + (chest.costCoins * maxN) + '。' })
            .then(function (ok) { if (ok) craftChest(chest, maxN); });
        });
        acts.appendChild(bAll);
      }
      const b2 = el('button', 'mini', '开箱');
      b2.disabled = have < 1;
      b2.title = have < 1 ? '先合成宝匣' : '消耗 1 个「' + chest.name + '」开箱';
      b2.addEventListener('click', function () { openChestModal(chest); });
      acts.appendChild(b2);
      grid.appendChild(card);
    });
    panel.appendChild(grid);
    panel.appendChild(el('div', 'hint',
      '宝匣可到「开放市集」出售或与玩家交易（系统商店不收购）。开箱产出的组件直接进背包，可装备 / 出售 / 上架。'));
    main.appendChild(panel);
  }
  function craftChest(chest, qty) {
    const st = S();
    Promise.resolve(window.Net.chestCraft(chest.id, qty)).then(function (r) {
      if (!r || !r.ok) { toast((r && r.data && r.data.error) || '合成失败'); return null; }
      st.player.coins = r.data.coins;
      st.inventory = r.data.inventory;
      if (r.data.chests) st.chest = Object.assign({}, st.chest, { chests: r.data.chests, relicHave: (r.data.inventory && r.data.inventory.relic) || 0 });
      toast('合成「' + chest.name + '」×' + qty + ' 成功');
      renderTopbar(); renderView();
      return r;
    }).catch(function () { toast('网络错误'); });
  }

  // ---- 工坊 · 熔炼 ----
  // 规则（服务器权威，成功率与花费由后台「⚒ 工坊配置」决定）：
  //   主件 + 副件 → 各选一条词条 → 熔炼成功后**主件的词条就是选中的这两条**，并重新 roll 数值；
  //   副件那条若不在主件词缀池内，就按「池外词缀区间」取值——等于把副件独有的词缀搬到主件上。
  //   可选投料：从主件自己的词缀池里再补一条主件没有的词缀（投料越多越容易成功，也越贵）。
  //   可选龙宫宝珠：roll 值改为掷两次取靠近区间边界的那次（与海王遗匣同一规则）。
  //   熔炼失败：副件与材料被熔毁、金币花掉，主件保持原样。
  let wsMain = '', wsSub = '', wsMainAffix = '', wsSubAffix = '', wsPearl = false;
  let wsMats = {};      // { 材料id: 份数 }（投料草稿，重绘间保留）
  let wsError = '';     // 上一次熔炼/预览的错误提示

  // 背包里可作为熔炼素材的组件实例（按签名排序，稳定展示）
  function wsComponents() {
    const st = S();
    const out = [];
    Object.keys(st.inventory || {}).forEach(function (id) {
      const meta = D.componentOf(id);
      if (!meta || !D.isInstance(id)) return;
      out.push({ id: id, meta: meta, count: st.inventory[id] });
    });
    out.sort(function (a, b) {
      return (b.meta.price || 0) - (a.meta.price || 0) || (a.id < b.id ? -1 : 1);
    });
    return out;
  }
  // 组件下拉选项：名称（品质 · 词条）＋ 持有数
  function wsOptionHtml(c) {
    const affs = c.meta.affixes.map(function (a) { return affixText(a); }).join(' / ');
    return '<option value="' + esc(c.id) + '">' + esc(c.meta.name) + '（' + esc(c.meta.qualityName) + ' · ' +
      esc(affs) + '）' + (c.count > 1 ? ' ×' + c.count : '') + '</option>';
  }
  // 词条选择：可点选的胶囊（每件组件一张）
  function wsAffixPickerHtml(comp, which) {
    if (!comp) return '<div class="hint">先选择组件</div>';
    const sel = which === 'main' ? wsMainAffix : wsSubAffix;
    return '<div class="ws-affs">' + comp.meta.affixes.map(function (a) {
      const rng = affixRangeIn(comp.meta, a);
      const rtxt = rng ? rangeText({ min: rng[0], max: rng[1] }) : '';
      return '<button class="ws-aff' + (a.type === sel ? ' on' : '') + (a.value < 0 ? ' neg' : '') +
        '" data-which="' + which + '" data-type="' + esc(a.type) + '">' + esc(affixText(a)) +
        (rtxt ? '<span class="ws-aff-rng">' + esc(rtxt) + '%</span>' : '') + '</button>';
    }).join('') + '</div>' +
      '<div class="hint">' + (which === 'main' ? '点击选择主件保留的词条' : '点击选择从副件搬到主件的词条') + '</div>';
  }
  function wsPlan() {
    const comps = wsComponents();
    const mainC = comps.find(function (c) { return c.id === wsMain; });
    const subC = comps.find(function (c) { return c.id === wsSub; });
    const mats = Object.keys(wsMats).map(function (id) { return { id: id, qty: Number(wsMats[id]) || 0 }; })
      .filter(function (e) { return e.qty > 0; });
    const load = D.smeltLoadOf(mats);
    const pearl = !!wsPearl && (S().inventory[D.SMELT_PEARL] || 0) > 0;
    const rates = D.smeltRatesOf(load, pearl);
    const gold = D.smeltGoldOf(load, pearl);
    let error = '';
    if (!mainC) error = '请选择主组件';
    else if (!subC) error = '请选择副组件';
    else if (!wsMainAffix) error = '请选择主件上要保留的词条';
    else if (!wsSubAffix) error = '请选择副件上要搬运的词条';
    else if (wsMainAffix === wsSubAffix) error = '主副选中的词条类型不能相同';
    else if (load.total > 0) {
      const addable = D.smeltAddableAffixes(mainC.meta.baseId, [wsMainAffix, wsSubAffix]);
      if (addable.indexOf(load.dominant) < 0) {
        error = '投料对应「' + (D.AFFIX_LABEL[load.dominant] || load.dominant) + '」，但主件词缀池里已没有可补的该类词缀';
      }
    }
    return {
      ok: !error, error: error, main: mainC, sub: subC, materials: mats, load: load,
      pearl: pearl, rates: rates, gold: gold, extraType: load.total > 0 ? load.dominant : null,
      rollBoundary: pearl && (D.getSmeltCfg().pearlRollTwice !== false),
    };
  }
  function wsRefreshPreview() {
    const panel = $('ws-preview');
    if (!panel) return;
    const p = wsPlan();
    const st = S();
    const canGold = (st.player.coins || 0) >= p.gold;
    if (!p.ok) {
      panel.innerHTML = '<div class="ws-line err">⚠ ' + esc(p.error) + '</div>';
      const go = $('ws-go');
      if (go) go.disabled = true;
      return;
    }
    const extra = p.extraType
      ? '<div class="ws-line">补缀：<b>' + esc(D.AFFIX_LABEL[p.extraType] || p.extraType) + '</b>（投料 ' + p.load.total +
        ' 份）· 成功率 <b>' + p.rates.extraRate + '%</b></div>'
      : '<div class="ws-line muted">未投料：熔炼后主件只有选中的两条词条</div>';
    panel.innerHTML =
      '<div class="ws-line">熔炼成功率 <b class="ok">' + p.rates.rate + '%</b>' +
      ' · 失败率 <b class="err">' + p.rates.failRate + '%</b>' +
      '（失败只损失副件与材料，主件不变）</div>' +
      extra +
      '<div class="ws-line">花费 <b class="' + (canGold ? '' : 'err') + '">' + p.gold + '💰</b>' +
      (p.pearl ? ' · 已加入龙宫宝珠：' + (p.rollBoundary ? 'roll 两次取靠近区间边界的值' : '（后台已关闭边界取值）') : '') + '</div>' +
      '<div class="ws-line muted">熔炼后主件词缀：' +
      [(D.AFFIX_LABEL[wsMainAffix] || wsMainAffix), (D.AFFIX_LABEL[wsSubAffix] || wsSubAffix)]
        .concat(p.extraType ? [D.AFFIX_LABEL[p.extraType] || p.extraType] : [])
        .map(function (t) { return esc(t); }).join(' + ') + '（数值重新 roll）</div>';
    const go = $('ws-go');
    if (go) go.disabled = false;
  }
  function renderWorkshop() {
    const main = $('main');
    const st = S();
    main.innerHTML = '';
    const panel = el('div', 'panel wide ws-panel');
    panel.innerHTML = '<h2>⚒ 工坊 <span class="subtitle">熔炼 · 用副件改写主件的词条</span></h2>' +
      '<div class="ws-help">放两件组件：<b>主件</b>保留、<b>副件</b>熔毁。各选一条词条后熔炼，主件的词条就变成这两条并重新 roll 数值——' +
      '把副件独有的词缀熔到主件上，是除宝匣之外唯一能跨出词缀池边界的途径。投料可为熔炼后的主件再补一条它还没有的词缀；' +
      '加入<b>龙宫宝珠</b>可让每个词条 roll 两次、取更靠近区间边界的那次。失败时副件与材料熔毁、金币花掉，主件保持原样。</div>';
    const comps = wsComponents();
    const mainC = comps.find(function (c) { return c.id === wsMain; }) || null;
    const subC = comps.find(function (c) { return c.id === wsSub; }) || null;
    if (!comps.length) {
      panel.appendChild(el('div', 'hint', '背包里还没有可熔炼的组件实例。钓竿组件来自钓鱼掉落、宝匣开箱或市集购买。'));
      main.appendChild(panel);
      return;
    }
    const body = el('div', 'ws-body');
    body.innerHTML =
      '<div class="ws-grid">' +
      '<div class="ws-col"><h3>🔧 主组件（保留）</h3>' +
      '<select class="ipt ws-select" id="ws-main"><option value="">— 选择主组件 —</option>' +
      comps.map(function (c) { return '<option value="' + esc(c.id) + '"' + (c.id === wsMain ? ' selected' : '') + '>' + wsOptionHtml(c) + '</option>'; }).join('') +
      '</select><div id="ws-main-affs">' + wsAffixPickerHtml(mainC, 'main') + '</div></div>' +
      '<div class="ws-col"><h3>🔥 副组件（熔毁）</h3>' +
      '<select class="ipt ws-select" id="ws-sub"><option value="">— 选择副组件 —</option>' +
      comps.map(function (c) { return '<option value="' + esc(c.id) + '"' + (c.id === wsSub ? ' selected' : '') + '>' + wsOptionHtml(c) + '</option>'; }).join('') +
      '</select><div id="ws-sub-affs">' + wsAffixPickerHtml(subC, 'sub') + '</div></div>' +
      '</div>' +
      '<h3>🧵 投料（可选）<span class="hint">每种材料对应一个词缀；投料份数最多的那种材料决定要补的词缀</span></h3>' +
      '<div class="ws-mat-grid" id="ws-mats">' + (function () {
        const mats = (st.workshop && st.workshop.materials) || [];
        if (!mats.length) return '<div class="hint">加载中…</div>';
        return mats.map(function (m) {
          const have = st.inventory[m.id] || 0;
          const qty = wsMats[m.id] || 0;
          return '<label class="ws-mat' + (have <= 0 ? ' none' : '') + '">' +
            '<span class="wm-name">' + esc(m.name) + '</span>' +
            '<span class="wm-aff">→ ' + esc(m.affixName || m.affix) + '</span>' +
            '<span class="wm-have">持有 ' + have + '</span>' +
            '<input class="ipt ws-mat-qty" type="number" min="0" max="99" data-mat="' + esc(m.id) + '" value="' + qty + '"' +
            (have <= 0 ? ' disabled' : '') + ' />' +
            '<span class="wm-unit">份</span></label>';
        }).join('');
      })() + '</div>' +
      '<label class="ws-pearl"><input type="checkbox" id="ws-pearl"' + (wsPearl ? ' checked' : '') + ' /> ' +
      '🐚 加入龙宫宝珠（持有 ' + (st.inventory[D.SMELT_PEARL] || 0) + '）· roll 两次取靠近区间边界的值</label>' +
      '<div class="ws-preview" id="ws-preview"></div>' +
      '<button class="primary big" id="ws-go">开始熔炼</button>';
    panel.appendChild(body);
    main.appendChild(panel);

    // ---- 交互绑定 ----
    $('ws-main').addEventListener('change', function () {
      wsMain = this.value; wsMainAffix = '';
      $('ws-main-affs').innerHTML = wsAffixPickerHtml(comps.find(function (c) { return c.id === wsMain; }) || null, 'main');
      bindWsAffix($('ws-main-affs'));
      wsRefreshPreview();
    });
    $('ws-sub').addEventListener('change', function () {
      wsSub = this.value; wsSubAffix = '';
      $('ws-sub-affs').innerHTML = wsAffixPickerHtml(comps.find(function (c) { return c.id === wsSub; }) || null, 'sub');
      bindWsAffix($('ws-sub-affs'));
      wsRefreshPreview();
    });
    bindWsAffix($('ws-main-affs'));
    bindWsAffix($('ws-sub-affs'));
    function bindWsAffix(host) {
      host.querySelectorAll('.ws-aff').forEach(function (b) {
        b.addEventListener('click', function () {
          const which = b.getAttribute('data-which'), type = b.getAttribute('data-type');
          if (which === 'main') wsMainAffix = type; else wsSubAffix = type;
          host.querySelectorAll('.ws-aff').forEach(function (x) { x.classList.toggle('on', x === b); });
          wsRefreshPreview();
        });
      });
    }
    body.querySelectorAll('.ws-mat-qty').forEach(function (inp) {
      inp.addEventListener('input', function () {
        const id = inp.getAttribute('data-mat');
        const v = Math.max(0, Math.min(99, Math.floor(Number(inp.value) || 0)));
        if (v > 0) wsMats[id] = v; else delete wsMats[id];
        wsRefreshPreview();
      });
    });
    $('ws-pearl').addEventListener('change', function () { wsPearl = this.checked; wsRefreshPreview(); });
    $('ws-go').addEventListener('click', function () { wsDoSmelt(); });
    wsRefreshPreview();
  }
  // 熔炼执行（二次确认 → 服务器掷骰 → 结果子窗口）
  function wsDoSmelt() {
    const p = wsPlan();
    if (!p.ok) { toast(p.error); return; }
    confirmModal({
      title: '⚒ 确认熔炼',
      okText: '开始熔炼（' + p.gold + '💰）',
      html: '主件 <b>' + esc(p.main.meta.name) + '</b> 保留「' + esc(D.AFFIX_LABEL[wsMainAffix] || wsMainAffix) + '」，' +
        '并把副件「' + esc(D.AFFIX_LABEL[wsSubAffix] || wsSubAffix) + '」熔入；<br/>' +
        '副件 <b>' + esc(p.sub.meta.name) + '</b> 与 ' + p.load.total + ' 份材料将被熔毁，花费 <b>' + p.gold + '💰</b>。<br/>' +
        '熔炼成功率 <b>' + p.rates.rate + '%</b>' + (p.extraType ? '，补缀成功率 <b>' + p.rates.extraRate + '%</b>' : '') +
        (p.pearl ? '，使用 🐚 龙宫宝珠' : '') + '。<br/>失败只损失副件与材料，主件保持原样。',
    }).then(function (ok) {
      if (!ok) return;
      Promise.resolve(window.Net.smelt({
        mainId: wsMain, subId: wsSub, mainAffix: wsMainAffix, subAffix: wsSubAffix,
        materials: p.materials, pearl: p.pearl,
      })).then(function (r) {
        if (!r || !r.ok) { toast((r && r.data && r.data.error) || '熔炼失败'); return; }
        const st = S();
        st.player.coins = r.data.coins;
        st.inventory = r.data.inventory;
        wsMats = {}; wsPearl = false;
        wsMain = ''; wsSub = ''; wsMainAffix = ''; wsSubAffix = '';
        renderTopbar(); renderView();
        wsShowResult(r.data);
      }).catch(function () { toast('网络错误'); });
    });
  }
  function wsShowResult(d) {
    const overlay = buildOverlay(function () { overlay.remove(); });
    const box = el('div', 'modal-box confirm-modal chest-result-modal');
    const inner = d.success
      ? (d.item
        ? chestItemCardHtml(d.item) +
          '<div class="cr-note">' + (d.item.hasExtra
            ? '★ 标记的词缀不在「' + esc(d.item.baseName) + '」的词缀池内——这是从副件熔入的池外词缀。'
            : '') + (d.extraType ? (d.extraOk ? ' 已补缀：' + esc(D.AFFIX_LABEL[d.extraType] || d.extraType) : ' 补缀未成功（本次没有新增词缀）') : '') + '</div>'
        : '')
      : '<div class="cr-fail">💥 熔炼失败：副件与材料已熔毁，主件保持原样。</div>';
    box.innerHTML = '<div class="modal-head"><span class="modal-title">' +
      (d.success ? '⚒ 熔炼成功' : '⚒ 熔炼失败') + '</span>' +
      '<button class="mini modal-close">✕ 关闭</button></div>' +
      '<div class="modal-body">' + inner +
      '<div class="hint" style="margin-top:6px">成功率 ' + d.rate + '%' +
      (d.extraType ? ' · 补缀成功率 ' + d.extraRate + '%' : '') +
      ' · 花费 ' + d.gold + '💰' + (d.pearl ? ' · 使用龙宫宝珠' : '') + '</div>' +
      '<div class="cf-actions"><button class="mini primary-mini cr-ok">知道了</button></div></div>';
    overlay.appendChild(box);
    document.body.appendChild(overlay);
    const close = function () { overlay.remove(); };
    box.querySelector('.modal-close').addEventListener('click', close);
    box.querySelector('.cr-ok').addEventListener('click', close);
    // 打开中的箱子：点遮罩关闭
    void 0;
  }

  // ---- 商城（每日限购）----
  // 官方金币直购，每件商品按「刷新时间」划分的周期限购；刷新时间、商品与金币价由管理后台配置。
  function mallNextText(mall) {
    if (!mall || !mall.nextRefreshAt) return '';
    const ms = mall.nextRefreshAt - Date.now();
    if (ms <= 0) return '即将刷新';
    const h = Math.floor(ms / 3600000), m = Math.floor((ms % 3600000) / 60000);
    return (h > 0 ? h + ' 小时 ' : '') + m + ' 分钟后刷新';
  }
  function mallBuyFlow(item) {
    const st = S();
    const maxQty = item.remain == null ? 99 : Math.min(99, item.remain);
    if (maxQty <= 0) { toast('「' + item.name + '」今日已售罄，等限购刷新后再来'); return; }
    promptModal({
      title: '🛒 购买 · ' + item.name,
      numeric: true, min: 1, max: maxQty, value: 1, okText: '购买',
      html: '<div class="hint">单价 ' + item.price + '💰 · 今日' +
        (item.limit > 0 ? '限购 ' + item.limit + ' 件（剩余 ' + item.remain + '）' : '不限购') +
        ' · 当前 ' + Math.round(st.player.coins || 0) + '💰</div>',
    }).then(function (v) {
      if (v == null) return;
      const qty = Math.max(1, Math.min(maxQty, Math.floor(v)));
      Promise.resolve(window.Net.mallBuy(item.id, qty)).then(function (r) {
        if (!r || !r.ok) { toast((r && r.data && r.data.error) || '购买失败'); return; }
        const s2 = S();
        s2.player.coins = r.data.coins;
        s2.inventory = r.data.inventory;
        if (r.data.mall) s2.mall = r.data.mall;
        toast('已购买 ' + r.data.name + ' ×' + r.data.qty + '（-' + r.data.cost + '💰）');
        renderTopbar(); renderView();
      }).catch(function () { toast('网络错误'); });
    });
  }
  function renderMall() {
    const main = $('main');
    const st = S();
    main.innerHTML = '';
    const panel = el('div', 'panel wide');
    panel.innerHTML = '<h2>🛒 商城 <span class="subtitle">每日限购 · 金币直购</span></h2>';
    const mall = st.mall;
    if (!mall || !mall.items) {
      panel.appendChild(el('div', 'hint', '正在读取商城…若长时间无内容，请刷新页面。'));
      main.appendChild(panel);
      return;
    }
    const bar = el('div', 'mall-bar');
    bar.innerHTML = '<span>🕓 限购刷新时间：<b>' + esc(mall.refreshTime) + '</b></span>' +
      '<span class="hint">' + esc(mallNextText(mall)) + '</span>' +
      '<span class="mall-coins">💰 ' + Math.round(st.player.coins || 0) + '</span>';
    panel.appendChild(bar);
    if (!mall.items.length) {
      panel.appendChild(el('div', 'hint', '管理后台尚未上架任何商品。'));
      main.appendChild(panel);
      return;
    }
    const grid = el('div', 'mall-grid');
    mall.items.forEach(function (it) {
      const meta = itemMeta(it.id);
      const cls = it.kind === 'component' ? qualityClass(meta) : rarityClass(meta.rarity || 'common');
      const soldOut = it.remain === 0;
      const card = el('div', 'mall-card' + (soldOut ? ' soldout' : ''));
      const iconSrc = it.kind === 'fish' ? 'assets/fish/' + esc(it.id) + '.png'
        : (it.kind === 'material' || it.kind === 'component') ? 'assets/item/' + esc(it.id) + '.png' : null;
      const limitText = it.limit > 0
        ? '今日限购 ' + it.limit + ' · 剩余 <b>' + it.remain + '</b>'
        : '不限购 · 本期已购 ' + it.bought;
      card.innerHTML =
        (iconSrc ? '<img class="mc-icon" src="' + iconSrc + '" alt="" draggable="false" onerror="this.style.display=\'none\'">' : '') +
        '<div class="mc-name ' + cls + '">' + esc(it.name) + '</div>' +
        '<div class="mc-price">' + it.price + '<span class="u">💰</span></div>' +
        '<div class="mc-limit' + (soldOut ? ' out' : '') + '">' + limitText + '</div>' +
        '<div class="mc-have hint">持有 ' + (it.have || 0) + '</div>';
      const acts = el('div', 'mc-acts');
      const b1 = el('button', 'mini primary-mini', soldOut ? '今日已售罄' : '购买');
      b1.disabled = soldOut || (st.player.coins || 0) < it.price;
      b1.title = soldOut ? '今日限购已用完，等刷新后重置'
        : ((st.player.coins || 0) < it.price ? '金币不足' : '购买（可选择数量）');
      b1.addEventListener('click', function () { mallBuyFlow(it); });
      acts.appendChild(b1);
      if (it.limit > 1 && !soldOut) {
        const bAll = el('button', 'mini', '买满 ×' + it.remain);
        bAll.title = '一次买完今日剩余限购（' + (it.price * it.remain) + '💰）';
        bAll.disabled = (st.player.coins || 0) < it.price * it.remain;
        bAll.addEventListener('click', function () {
          confirmModal({
            title: '一次买满', okText: '购买 ×' + it.remain,
            html: '购买 <b>' + esc(it.name) + ' ×' + it.remain + '</b>？<br/>花费 💰' + (it.price * it.remain) +
              '（单价 ' + it.price + '，今日剩余限购 ' + it.remain + '）',
          }).then(function (ok) {
            if (!ok) return;
            Promise.resolve(window.Net.mallBuy(it.id, it.remain)).then(function (r) {
              if (!r || !r.ok) { toast((r && r.data && r.data.error) || '购买失败'); return; }
              const s2 = S();
              s2.player.coins = r.data.coins; s2.inventory = r.data.inventory;
              if (r.data.mall) s2.mall = r.data.mall;
              toast('已购买 ' + r.data.name + ' ×' + r.data.qty + '（-' + r.data.cost + '💰）');
              renderTopbar(); renderView();
            }).catch(function () { toast('网络错误'); });
          });
        });
        acts.appendChild(bAll);
      }
      card.appendChild(acts);
      grid.appendChild(card);
    });
    panel.appendChild(grid);
    panel.appendChild(el('div', 'hint', '商城的限购按「刷新时间」划分周期：跨过刷新时刻即重置。商品与价格由管理后台维护。'));
    main.appendChild(panel);
  }

  function renderCodex() {
    const main = $('main');
    const st = S();
    main.innerHTML = '';
    const panel = el('div', 'panel wide');
    const caught = st.codex || {};
    const total = Object.keys(caught).length;
    panel.innerHTML = '<h2>📖 鱼类图鉴 <span class="subtitle">个人收集进度 · 点击卡片查看完整信息（产地/个人体型极值）</span></h2>';

    // 汇总：图鉴只收「钓得到」的物品——宝匣是合成的、不在任何钓点掉落池里，
    // 收录进来只会显示成「未解锁 · 去产地垂钓即可解锁」的假条目，所以这里剔除。
    const items = D.allItems().filter(function (i) { return i.kind !== 'chest'; });
    const fishItems = items.filter(function (i) { return i.kind === 'fish'; });
    const gotFish = fishItems.filter(function (i) { return caught[i.id]; }).length;
    const summary = el('div', 'codex-summary');
    summary.innerHTML = '<div class="cs-box"><b>' + gotFish + ' / ' + fishItems.length + '</b><span>鱼类收集</span></div>' +
      '<div class="cs-box"><b>' + total + '</b><span>图鉴条目</span></div>' +
      '<div class="cs-box"><b>' + (st.catchCount || 0) + '</b><span>累计渔获</span></div>';
    panel.appendChild(summary);

    // 分类页签（与背包一致；数量为各类条目数）
    const tabs = el('div', 'inv-cats');
    const spotTotal = D.GROUNDS.reduce(function (n, g) { return n + (g.spots || []).length; }, 0);
    [['all', '📦 全部', items.length], ['fish', '🐟 鱼类', fishItems.length],
     ['material', '🧵 材料', items.filter(function (i) { return i.kind === 'material'; }).length],
     ['component', '🔧 组件', items.filter(function (i) { return i.kind === 'component'; }).length],
     ['spots', '📍 钓点', spotTotal]].forEach(function (kv) {
      const b = el('button', 'inv-cat' + (codexCategory === kv[0] ? ' on' : ''), kv[1] + ' ' + kv[2]);
      b.title = kv[0] === 'spots' ? '查看每个钓点能钓到什么（点开看实时产出概率）' : '';
      b.addEventListener('click', function () { if (codexCategory !== kv[0]) { codexCategory = kv[0]; renderView(); } });
      tabs.appendChild(b);
    });
    // 品级倒序开关（史诗 > 稀有 > 大鱼 > 普通）；钓点视图下无品级概念，隐藏
    if (codexCategory !== 'spots') {
      const sortBtn = el('button', 'inv-cat codex-sort' + (codexSortRarity ? ' on' : ''), '⬇ 品级倒序');
      sortBtn.title = '按品级从高到低排序';
      sortBtn.addEventListener('click', function () { codexSortRarity = !codexSortRarity; renderView(); });
      tabs.appendChild(sortBtn);
    }
    panel.appendChild(tabs);

    const grid = el('div', 'codex-grid');
    if (codexCategory === 'spots') {
      // 钓点视图：每个钓点一张卡，点开看实时产出概率（与后台掉落池配置同步）
      D.GROUNDS.forEach(function (g) {
        (g.spots || []).forEach(function (sp) {
          const pool = sp.pool || [];
          const cell = el('div', 'codex-cell k-spots' + (g.locked ? ' locked' : ''));
          cell.innerHTML =
            '<img class="cx-icon spot-icon" src="assets/spot/' + esc(sp.id) + '.png" alt="" draggable="false">' +
            '<div class="cx-name">' + esc(g.name + ' · ' + sp.name) + '</div>' +
            '<div class="cx-meta">' + (pool.length ? '产出 ' + pool.length + ' 项' : '未配置掉落池') + '</div>' +
            '<div class="cx-meta muted">' + (g.locked ? '🔒 锁定中' : '🎣 可垂钓') + '</div>' +
            ((sp.buffs && sp.buffs.length) ? '<div class="cx-meta cx-spots">⚡ 增益 ' + sp.buffs.length + ' 项</div>' : '') +
            '<div class="cx-meta cx-spots">🎯 点看产出概率</div>';
          cell.title = '点击查看该钓点的实时产出概率（与后台掉落池同步）';
          cell.addEventListener('click', function () { openSpotDetail(g.id, sp.id); });
          grid.appendChild(cell);
        });
      });
      panel.appendChild(grid);
      main.appendChild(panel);
      return;
    }
    const baseList = codexCategory === 'all' ? items : items.filter(function (i) { return i.kind === codexCategory; });
    const TIER_ORDER = { epic: 4, rare: 3, big: 2, common: 1 };
    const shown = codexSortRarity
      ? baseList.slice().sort(function (a, b) { return (TIER_ORDER[b.rarity] || 0) - (TIER_ORDER[a.rarity] || 0); })
      : baseList;
    shown.forEach(function (it) {
      const rec = caught[it.id];
      const cell = el('div', 'codex-cell' + (rec ? ' got' : '') + ' k-' + it.kind);
      const spots = D.spotsOf(it.id);
      const base = it.kind === 'component' ? D.componentBase(it.id) : null;
      // 组件底材卡：展示可拥有的全部词缀与数值范围。
      // 品质配色统一后，图鉴不再按「是否拥有满词条实例」改色或加后缀（满词条强调只留在背包/市集/装备弹窗）。
      const poolHtml = base
        ? '<div class="cx-meta cx-pool">' + base.pool.map(function (p) {
            return '<span class="pool-line' + (p.max < 0 ? ' neg' : '') + '">' + esc((D.AFFIX_LABEL[p.type] || p.type)) +
              ' <span class="rng">' + esc(rangeText(p)) + '%</span></span>';
          }).join(' · ') + '</div>'
        : null;
      const nameCls = rec ? qualityClass(it) : 'locked-name';
      // 条目贴图：鱼 assets/fish/，材料与组件底材 assets/item/（像素 PNG，透明底）
      const iconSrc = it.kind === 'fish' ? 'assets/fish/' + esc(it.id) + '.png'
        : (it.kind === 'material' || it.kind === 'component') ? 'assets/item/' + esc(it.id) + '.png'
        : null;
      const iconHtml = iconSrc ? '<img class="cx-icon" src="' + iconSrc + '" alt="" draggable="false">' : '';
      // 统一五行骨架：全部卡片结构一致、高度对齐
      cell.innerHTML =
        iconHtml +
        '<div class="cx-name ' + nameCls + '">' + esc(it.name) + '</div>' +
        '<div class="cx-meta">' + (rec ? '已获得 ' + rec.count + ' 次' : '未解锁') + '</div>' +
        '<div class="cx-meta muted">' + (rec ? '首获 ' + timeStr(rec.first) : qualityName(it) + ' · ' + (it.price || 0) + '💰') + '</div>' +
        (it.size ? '<div class="cx-meta muted">体型 ' + it.size[0] + '-' + it.size[1] + 'cm</div>'
                  : (poolHtml || '<div class="cx-meta muted">材料 / 组件</div>')) +
        (spots.length ? '<div class="cx-meta cx-spots">📍 产地 ' + spots.length + ' 处</div>' : '<div class="cx-meta muted">📍 —</div>');
      cell.title = '点击查看完整信息（子窗口）';
      cell.addEventListener('click', function () { openCodexDetail(it, rec); });
      grid.appendChild(cell);
    });
    panel.appendChild(grid);
    main.appendChild(panel);
  }

  // ---- 渔获记录视图 ----
  // 某种鱼的前十大 / 前十小捕获记录弹窗（kind='small' 时为前十小）
  function openRecordsModal(fishId, kind) {
    const small = kind === 'small';
    document.querySelectorAll('.modal-overlay').forEach(function (m) { m.remove(); });
    const meta = itemMeta(fishId);
    const title = small ? ('🐠 ' + meta.name + ' · 全服前十小捕获') : ('🏆 ' + meta.name + ' · 全服前十大捕获');
    const overlay = el('div', 'modal-overlay');
    overlay.addEventListener('click', function (ev) { if (ev.target === overlay) closeRecordsModal(); });
    const box = el('div', 'modal-box shop-modal');
    box.innerHTML = '<div class="modal-head"><span class="modal-title">' + esc(title) + '</span><button class="mini modal-close">✕ 关闭</button></div><div class="modal-body" id="records-modal-body">加载中…</div>';
    box.querySelector('.modal-close').addEventListener('click', function () { closeRecordsModal(); });
    overlay.appendChild(box);
    document.body.appendChild(overlay);
    window.Net.recordsTop(fishId, small ? 'small' : 'big').then(function (r) {
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
          '<span class="top10-size' + (small ? ' sf' : '') + '">' + t.size + '<span class="u">cm</span></span>' +
          '<span class="top10-who">' + esc(t.who) + '</span>' +
          '<span class="top10-time">' + timeStr(t.t) + '</span>'));
      });
      body.appendChild(el('div', 'sd-legend', '共收录 ' + top.length + ' 条（每位玩家仅保留最好一条）· 每次捕获自动更新'));
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
    panel.innerHTML = '<h2>🏆 渔获记录 <span class="subtitle">全服纪录 · 按鱼类分项查看</span></h2>';

    const recs = Object.keys(st.records || {}).map(function (id) { return st.records[id]; })
      .sort(function (a, b) { return b.size - a.size; });

    // 全场最大纪录：单独置顶展示
    if (recs.length) {
      const top = recs[0];
      const topMeta = itemMeta(top.id);
      const hero = el('div', 'record-hero');
      hero.innerHTML =
        '<img class="rh-icon" src="assets/fish/' + esc(top.id) + '.png" alt="" draggable="false">' +
        '<div class="rh-crown">👑 全场最大</div>' +
        '<div class="rh-name ' + rarityClass(topMeta.rarity) + '">' + esc(top.name) + '</div>' +
        '<div class="rh-size">' + top.size + '<span class="u">cm</span></div>' +
        '<div class="rh-who">纪录保持者：' + esc(top.who) + ' · ' + timeStr(top.t) + '</div>';
      panel.appendChild(hero);
    } else {
      panel.appendChild(el('div', 'hint', '还没有渔获纪录。钓到一条鱼就会生成它的最大/最小纪录。'));
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
          '<img class="rc-icon" src="assets/fish/' + esc(e.f.id) + '.png" alt="" draggable="false">' +
          '<div class="rc-name ' + rarityClass(e.f.rarity) + '">' + esc(e.f.name) + '</div>' +
          '<div class="rc-size">' + e.rec.size + '<span class="u">cm</span></div>' +
          '<div class="rc-who">' + esc(e.rec.who) + ' · ' + timeStr(e.rec.t) + '</div>' +
          '<div class="rc-hint">点击查看前十大</div>';
        cell.title = '点击查看该鱼全服前十大捕获';
        cell.addEventListener('click', function () { openRecordsModal(e.f.id); });
      } else {
        cell.innerHTML =
          '<img class="rc-icon dim" src="assets/fish/' + esc(e.f.id) + '.png" alt="" draggable="false">' +
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
        const cell = el('div', 'record-cell small-fish with-rec');
        cell.innerHTML =
          '<img class="rc-icon" src="assets/fish/' + esc(r.id) + '.png" alt="" draggable="false">' +
          '<div class="rc-name ' + rarityClass(meta.rarity) + '">' + esc(r.name) + '</div>' +
          '<div class="rc-size sf-size">' + r.size + '<span class="u">cm</span></div>' +
          '<div class="rc-who">' + esc(r.who) + ' · ' + timeStr(r.t) + '</div>' +
          '<div class="rc-hint">点击查看前十小</div>';
        cell.title = '点击查看该鱼全服前十小捕获';
        cell.addEventListener('click', function () { openRecordsModal(r.id, 'small'); });
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
        ml.appendChild(el('div', 'rec-row', '<img class="rec-icon" src="assets/fish/' + esc(id) + '.png" alt="" draggable="false">' +
          '<div class="rec-main"><div class="rec-name ' + rarityClass(m.rarity) + '">' + esc(m.name) +
          '</div></div><div class="rec-size">' + m.size + '<span class="u">cm</span></div>'));
      });
      panel.appendChild(ml);
    }

    main.appendChild(panel);
  }

  // ---- 反馈意见视图 ----
  // 默认每人每 24 小时可提交 1 条；花 10000 金币可立即结束 CD。
  let fbKind = 'bug';
  const FB_KINDS = [['bug', '🐛 Bug'], ['idea', '💡 建议'], ['balance', '⚖️ 平衡'], ['other', '💬 其他']];
  const FB_STATUSES = { submitted: '已提交', accepted: '已受理', done: '已完成' };
  // 我的反馈列表筛选（模块级：重绘间保留）
  let fbFilterKind = 'all';
  let fbFilterStatus = 'all';
  function fmtRemain(ms) {
    const s = Math.max(0, Math.ceil(ms / 1000));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    return (h > 0 ? h + ' 小时 ' : '') + (h > 0 || m > 0 ? m + ' 分 ' : '') + sec + ' 秒';
  }
  function renderFeedback() {
    const main = $('main');
    const st = S();
    main.innerHTML = '';
    const fb = st.feedback || {};
    const status = fb.status || { ready: true, remainingMs: 0, nextAt: 0, skipCost: 10000, cdHours: 24 };
    // CD 时长与清空费用由服务器下发（管理后台可配）
    const cdHours = status.cdHours != null ? status.cdHours : 24;
    const cdText = cdHours >= 1 ? (cdHours + ' 小时') : Math.round(cdHours * 60) + ' 分钟';
    const panel = el('div', 'panel wide feedback-panel');
    panel.innerHTML = '<h2>📮 反馈意见 <span class="subtitle">Bug / 建议 / 平衡 · 每 ' + cdText + ' 可提交 1 条 · 花 ' + status.skipCost + ' 金币可立即结束冷却</span></h2>';

    // 冷却状态条
    const banner = el('div', 'fb-banner' + (status.ready ? ' ready' : ' cooling'));
    if (status.ready) {
      banner.innerHTML = '✅ 现在可以提交反馈（提交后进入 ' + cdText + ' 冷却）';
    } else {
      const cost = status.skipCost;
      const canPay = (st.player.coins || 0) >= cost;
      banner.innerHTML = '⏳ 冷却中 · 剩余 <b>' + fmtRemain(status.remainingMs) + '</b>';
      const skip = el('button', 'mini primary-mini' + (canPay ? '' : ' locked'), '💸 花 ' + cost + ' 金币立即结束 CD');
      skip.addEventListener('click', function () {
        if (!canPay) { toast('金币不足（需 ' + cost + '）'); return; }
        confirmModal({ title: '结束反馈冷却', html: '花费 <b>' + cost + '</b> 金币立即结束反馈冷却？', okText: '确认支付' }).then(function (ok) {
          if (!ok) return;
          call(window.Net.feedbackSkip(), '已结束冷却，现在可以提交反馈').then(function (r) {
            if (r && r.ok) { st.feedback = Object.assign({}, st.feedback, { status: r.data.status }); renderTopbar(); renderView(); }
          });
        });
      });
      banner.appendChild(skip);
    }
    panel.appendChild(banner);

    // 提交表单
    const form = el('div', 'fb-form');
    const kindWrap = el('div', 'fb-kinds');
    FB_KINDS.forEach(function (kv) {
      const b = el('button', 'inv-cat' + (fbKind === kv[0] ? ' on' : ''), kv[1]);
      b.addEventListener('click', function () { fbKind = kv[0]; renderView(); });
      kindWrap.appendChild(b);
    });
    form.appendChild(kindWrap);
    const ta = el('textarea', 'fb-input');
    ta.placeholder = '描述你遇到的问题或建议（最多 1000 字）…';
    form.appendChild(ta);
    const cnt = el('div', 'fb-count', '0 / 1000');
    ta.addEventListener('input', function () { cnt.textContent = ta.value.length + ' / 1000'; });
    form.appendChild(cnt);
    const submit = el('button', 'primary big' + (status.ready ? '' : ' locked'), status.ready ? '提交反馈' : '冷却中…');
    submit.disabled = !status.ready;
    submit.addEventListener('click', function () {
      const text = ta.value.trim();
      if (!text) { toast('请填写反馈内容'); return; }
      submit.disabled = true;
      submit.textContent = '提交中…';
      call(window.Net.feedbackSubmit(text, fbKind), '感谢反馈！已进入 24 小时冷却').then(function (r) {
        if (r && r.ok) {
          ta.value = '';
          st.feedback = { status: r.data.status, mine: [r.data.entry].concat((fb.mine || [])) };
          renderTopbar(); renderView();
        } else {
          submit.disabled = false; submit.textContent = '提交反馈';
        }
      });
    });
    form.appendChild(submit);
    panel.appendChild(form);

    // 我的历史反馈（可按「反馈类型 + 处理状态」筛选）
    panel.appendChild(el('h3', null, '📜 我提交过的反馈'));
    const mine = (fb.mine || []);
    if (!mine.length) {
      panel.appendChild(el('div', 'hint', '还没有提交过反馈。'));
    } else {
      const filters = el('div', 'fb-filters');
      filters.appendChild(el('span', 'bf-sort-label', '类型'));
      const kSel = el('select', 'bulk-select');
      [['all', '全部类型']].concat(FB_KINDS.map(function (k) { return [k[0], k[1]]; })).forEach(function (kv) {
        const o = el('option', null, kv[1]); o.value = kv[0]; kSel.appendChild(o);
      });
      kSel.value = fbFilterKind;
      kSel.addEventListener('change', function () { fbFilterKind = kSel.value; renderView(); });
      filters.appendChild(kSel);
      filters.appendChild(el('span', 'bf-sort-label', '状态'));
      const sSel = el('select', 'bulk-select');
      [['all', '全部状态'], ['submitted', '已提交'], ['accepted', '已受理'], ['done', '已完成']].forEach(function (kv) {
        const o = el('option', null, kv[1]); o.value = kv[0]; sSel.appendChild(o);
      });
      sSel.value = fbFilterStatus;
      sSel.addEventListener('change', function () { fbFilterStatus = sSel.value; renderView(); });
      filters.appendChild(sSel);
      const shown = mine.filter(function (f) {
        if (fbFilterKind !== 'all' && (f.kind || 'other') !== fbFilterKind) return false;
        if (fbFilterStatus !== 'all' && (f.status || 'submitted') !== fbFilterStatus) return false;
        return true;
      });
      filters.appendChild(el('span', 'hint', '匹配 ' + shown.length + ' / ' + mine.length + ' 条'));
      if (fbFilterKind !== 'all' || fbFilterStatus !== 'all') {
        const clr = el('button', 'mini', '清除筛选');
        clr.addEventListener('click', function () { fbFilterKind = 'all'; fbFilterStatus = 'all'; renderView(); });
        filters.appendChild(clr);
      }
      panel.appendChild(filters);
      const list = el('div', 'fb-history');
      if (!shown.length) list.appendChild(el('div', 'hint', '没有符合筛选条件的反馈。'));
      shown.forEach(function (f) {
        const row = el('div', 'fb-item');
        const kindName = (FB_KINDS.find(function (k) { return k[0] === f.kind; }) || ['', '其他'])[1];
        const stKey = f.status || 'submitted';
        const stName = FB_STATUSES[stKey] || FB_STATUSES.submitted;
        const rw = f.reward;
        row.innerHTML = '<div class="fb-item-head"><span class="fb-tag">' + esc(kindName) + '</span>' +
          '<span class="fb-status ' + stKey + '">' + esc(stName) + '</span>' +
          (rw && rw.coins ? '<span class="fb-reward">🎁 已获奖励 +' + rw.coins + '💰' + (rw.note ? '（' + esc(rw.note) + '）' : '') + '</span>' : '') +
          '<span class="fb-time">' + timeStr(f.t) + '</span></div>' +
          '<div class="fb-text">' + esc(f.text) + '</div>';
        list.appendChild(row);
      });
      panel.appendChild(list);
    }
    main.appendChild(panel);
  }

  // ---- 日志视图：记录玩家收到的服务器消息弹窗 ----
  // 来源：notice 提示、公告横幅、交易完成、破纪录播报、组件订阅提醒、顶号下线。
  // 数据为前端本地持久化（按账号），过滤页签与背包分类一致。
  let logFilter = 'all';
  function renderLogs() {
    loadLog();
    const main = $('main');
    main.innerHTML = '';
    const panel = el('div', 'panel wide');
    panel.innerHTML = '<h2>📜 日志 <span class="subtitle">渔获记录 · 公告 / 系统提示 / 交易 / 纪录 / 订阅提醒 · 本地按账号保留最近 ' + LOG_KEEP + ' 条</span></h2>';
    const counts = { all: msgLog.length };
    Object.keys(LOG_KINDS).forEach(function (k) { counts[k] = msgLog.filter(function (e) { return e.kind === k; }).length; });
    const tabs = el('div', 'inv-cats');
    const kindOrder = ['catch', 'system', 'trade', 'record', 'subscribe'].filter(function (k) { return !!LOG_KINDS[k]; });
    [['all', '📜 全部']].concat(kindOrder.map(function (k) { return [k, LOG_KINDS[k][0] + ' ' + LOG_KINDS[k][1]]; })).forEach(function (kv) {
      const b = el('button', 'inv-cat' + (logFilter === kv[0] ? ' on' : ''), kv[1] + ' ' + (counts[kv[0]] || 0));
      b.addEventListener('click', function () { if (logFilter !== kv[0]) { logFilter = kv[0]; renderView(); } });
      tabs.appendChild(b);
    });
    panel.appendChild(tabs);

    const list = el('div', 'log-page');
    const rows = msgLog.filter(function (e) { return logFilter === 'all' || e.kind === logFilter; });
    if (!rows.length) {
      list.appendChild(el('div', 'hint', msgLog.length ? '该分类下没有记录。' : '还没有收到服务器消息。公告、系统提示、交易与订阅提醒都会记录在这里。'));
    } else {
      rows.forEach(function (e) {
        const kind = LOG_KINDS[e.kind] || LOG_KINDS.system;
        const row = el('div', 'log-row');
        row.innerHTML = '<span class="log-time">' + timeStr(e.t) + '</span>' +
          '<span class="log-tag log-' + e.kind + '">' + kind[0] + ' ' + kind[1] + '</span>' +
          '<span class="log-msg">' + esc(e.msg) + '</span>';
        list.appendChild(row);
      });
    }
    panel.appendChild(list);
    const foot = el('div', 'log-foot');
    const clr = el('button', 'mini danger-mini', '清空日志');
    clr.addEventListener('click', function () {
      confirmModal({ title: '清空日志', html: '确定清空本账号的全部日志记录吗？此操作不可恢复。', okText: '清空', danger: true }).then(function (ok) {
        if (!ok) return;
        clearLog();
        renderView();
        toast('日志已清空');
      });
    });
    foot.appendChild(clr);
    foot.appendChild(el('span', 'hint', '日志仅保存在本机浏览器（按账号区分），不上传服务器。'));
    panel.appendChild(foot);
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
    else if (view === 'chest') window.Net.fetchChest();
    else if (view === 'mall') window.Net.fetchMall();
    else if (view === 'workshop') window.Net.fetchWorkshop();
    else if (view === 'market') window.Net.fetchMarket();
    else if (view === 'codex') window.Net.fetchCodex();
    else if (view === 'records') window.Net.fetchRecords();
    else if (view === 'feedback') window.Net.fetchFeedback();
  }

  // 重绘前记录可滚动容器位置，重绘后恢复。
  // SSE 广播（他人上鱼/新纪录）会触发整页重绘，若不保留滚动位置，
  // 浏览中的渔获日志 / 渔获记录 / 动态列表会被 innerHTML 重建并拽回顶部。
  const SCROLL_SELECTORS = ['.content', '.catch-log', '.feed', '.codex-detail', '.trade-lists', '.tp-rows', '.bulk-rows', '.log-page'];
  function captureScroll() {
    const saved = [];
    SCROLL_SELECTORS.forEach(function (sel) {
      document.querySelectorAll(sel).forEach(function (n, i) {
        if (n.scrollTop > 0) saved.push([sel, i, n.scrollTop]);
      });
    });
    return saved;
  }
  function restoreScroll(saved) {
    if (!saved || !saved.length) return;
    saved.forEach(function (rec) {
      const n = document.querySelectorAll(rec[0])[rec[1]];
      if (n) n.scrollTop = rec[2];
    });
  }

  function renderView() {
    const saved = captureScroll();
    if (currentView === 'fishing') renderFishing();
    else if (currentView === 'bd') renderBD();
    else if (currentView === 'ground') renderGround();
    else if (currentView === 'inventory') renderInventory();
    else if (currentView === 'chest') renderChest();
    else if (currentView === 'workshop') renderWorkshop();
    else if (currentView === 'mall') renderMall();
    else if (currentView === 'shop') renderShop();
    else if (currentView === 'market') renderMarket();
    else if (currentView === 'trade') renderTrade();
    else if (currentView === 'codex') renderCodex();
    else if (currentView === 'records') renderRecords();
    else if (currentView === 'feedback') renderFeedback();
    else if (currentView === 'logs') renderLogs();
    else {
      const navItem = D.NAV.find(function (x) { return x.id === currentView; });
      renderPlaceholder(navItem ? navItem.name : '未开放');
    }
    restoreScroll(saved);
  }

  // ---- 认证流程 ----
  let authTab = 'login';
  function wireAuth() {
    $('tab-login').onclick = function () { setAuthTab('login'); };
    $('tab-register').onclick = function () { setAuthTab('register'); };
    $('auth-submit').onclick = onAuthSubmit;
    $('auth-pass').addEventListener('keydown', function (e) { if (e.key === 'Enter') onAuthSubmit(); });
    $('auth-user').addEventListener('keydown', function (e) { if (e.key === 'Enter') onAuthSubmit(); });
    $('auth-pass2').addEventListener('keydown', function (e) { if (e.key === 'Enter') onAuthSubmit(); });
    $('auth-qq').addEventListener('keydown', function (e) { if (e.key === 'Enter') onAuthSubmit(); });
    const lo = $('logout-btn');
    if (lo) lo.addEventListener('click', doLogout);
  }
  // 登出：通知服务器使会话失效，清理本地状态并回到登录界面
  function doLogout() {
    confirmModal({ title: '退出登录', html: '确定要退出当前账号吗？', okText: '退出登录', danger: true }).then(function (ok) {
      if (!ok) return;
      const done = function () {
        try { localStorage.removeItem('fishing_token'); } catch (e) {}
        if (window.Net && window.Net.getMe && window.Net.getMe()) { try { window.Net.closeStream && window.Net.closeStream(); } catch (e) {} }
        // 清空与账号绑定的临时状态与横幅/闪烁
        if (window.Engine && window.Engine.resetTransient) window.Engine.resetTransient();
        seenBannerIds = {}; subUnseen = 0; msgLogOwner = null; msgLog = [];
        ['record', 'notice'].forEach(function (ln) {
          const st = lanes[ln];
          if (st.timer) { clearTimeout(st.timer); st.timer = null; }
          st.queue = []; st.playing = false; st.finish = null; st.current = null;
          const b = laneEl(ln);
          if (b) { b.classList.remove('show'); b.innerHTML = ''; b.style.background = ''; b.style.color = ''; }
        });
        syncBannerOffset();
        updateFaviconBlink(false);
        const rb = $('record-banner'); if (rb) { rb.classList.remove('show'); rb.innerHTML = ''; }
        document.body.classList.remove('banner-open');
        currentView = 'fishing';
        showAuth();
        authMsg('已退出登录');
        renderNav();
      };
      if (window.Net && window.Net.logout) {
        Promise.resolve(window.Net.logout()).then(done).catch(done);
      } else done();
    });
  }
  function setAuthTab(t) {
    authTab = t;
    $('tab-login').classList.toggle('active', t === 'login');
    $('tab-register').classList.toggle('active', t === 'register');
    const reg = t === 'register';
    $('auth-name').style.display = reg ? 'block' : 'none';
    $('auth-pass2').style.display = reg ? 'block' : 'none';
    $('auth-qq').style.display = reg ? 'block' : 'none';
    $('auth-submit').textContent = reg ? '注册' : '登录';
    $('auth-msg').textContent = '';
  }
  function showAuth() { $('auth').style.display = 'flex'; }
  // 顶号/会话失效：回到登录界面并提示原因
  function forceLogout(msg) {
    currentView = 'fishing';
    showAuth();
    authMsg(msg || '');
    renderNav();
  }
  function authMsg(text) { $('auth-msg').textContent = text || ''; }
  function onAuthSubmit() {
    const user = $('auth-user').value.trim();
    const pass = $('auth-pass').value;
    const name = $('auth-name').value.trim();
    if (!user || !pass) { authMsg('请填写用户名和密码'); return; }
    let qq = '', pass2 = '';
    if (authTab === 'register') {
      pass2 = $('auth-pass2').value;
      qq = $('auth-qq').value.trim();
      if (pass !== pass2) { authMsg('两次输入的密码不一致'); return; }
      if (!qq) { authMsg('请填写 QQ 号'); return; }
      if (!/^[0-9]{5,12}$/.test(qq)) { authMsg('QQ 号需为 5-12 位数字'); return; }
    }
    const btn = $('auth-submit');
    if (btn.disabled) return;
    btn.disabled = true;
    const oldLabel = btn.textContent;
    btn.textContent = authTab === 'register' ? '注册中…' : '登录中…';
    authMsg('');
    let p;
    try {
      p = authTab === 'register' ? window.Net.register(user, pass, name, qq, pass2) : window.Net.login(user, pass);
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
    // 组件订阅配置随登录下发（提醒方式/条件由玩家在背包页维护）
    st.subCfg = (profile && profile.subNotify) || null;
    subUnseen = 0;
    msgLogOwner = null; // 切换账号后日志按新账号重新加载
    window.Net.setAuth(token, profile);
    $('auth').style.display = 'none';
    renderNav();
    renderTopbar();
    renderView();
    // 拉取横幅队列（管理后台公告）并在该会话首次播放
    if (window.Net.fetchBanners) window.Net.fetchBanners();
    // 主动拉取钓场目录：兜底确保后进入/刷新的玩家也拿到含增益的最新目录（钓点 ⚡ 标记）
    if (window.Net.fetchGrounds) window.Net.fetchGrounds();
  }
  function onFishingTick() { if (currentView === 'fishing') { renderTopbar(); renderFishing(); } }

  // 刷新主视图。每个视图只关心与自己相关的广播类型（scope）：
  // 无关广播（如他人的渔获 feed/players）只更新顶栏/导航，不重绘主区——
  // 否则只要有人上鱼，钓竿配置/背包等页面的组件卡片都会跟着整页闪烁重绘。
  const VIEW_SCOPES = {
    fishing: ['players', 'grounds', 'catch', 'assets', 'groundcfg', 'castcfg'], // 实况/日志/钓速随广播更新
    bd: [],                                             // 钓竿配置：只随操作重绘（展示数据不受广播影响）
    ground: ['players', 'grounds', 'feed', 'groundcfg'],
    inventory: ['assets', 'shop', 'pricecfg'],
    // 宝匣页：随资产（残片/金币/宝匣数量）、后台宝匣配置广播更新；
    // 末位 'chest' 是视图自身 id —— fetchChest 完成后用 refreshAll('chest') 触发重绘，
    // 少了它就会命中「scope 不在列表内 → 不重绘」，页面永远停在「加载中」。
    chest: ['assets', 'chestcfg', 'chest'],
    shop: ['assets', 'shop', 'pricecfg'],
    market: ['assets', 'market'],
    trade: ['trade', 'assets', 'codex'],
    codex: ['codex', 'groundcfg'],
    records: ['records'],
    feedback: ['feedback'],                              // 反馈页：fetchFeedback 到达后重绘（CD/费用随服务器下发）
    logs: [],                                            // 日志页：仅在收到消息（addLog）或本地操作时重绘
    // 商城/工坊：末位是视图自身 id——fetchMall / fetchWorkshop 完成后用 refreshAll('mall'|'workshop')
    // 触发重绘；少了它就会命中「scope 不在列表内 → 不重绘」，页面永远停在「加载中…」。
    mall: ['assets', 'mall'],
    workshop: ['assets', 'smeltcfg', 'workshop'],
  };
  function refreshAll(scope) {
    if (scope === 'all') scope = null; // init 全量刷新
    if (shopModalId && scope === 'shop') fillShopModal(shopModalId); // 弹窗数据静默刷新
    // 钓点详情弹窗：后台改掉落池 / 增益（groundcfg 广播）时保持弹窗与最新配置同步
    if (scope === 'groundcfg' && spotDetailRedraw) { spotDetailRedraw(); }
    // 一键出售 / 订阅弹窗内的筛选控件获得焦点时暂停重绘（避免下拉框被广播冲掉）
    if (bulkFocus && scope && scope !== 'all') { renderTopbar(); renderNav(); return; }
    // 弹窗打开时（批量出售/订阅/组件属性等）不重绘背后的页面列表，避免广播把弹窗下的操作上下文冲掉
    if (document.querySelector('.modal-overlay') && currentView !== 'trade' && scope) {
      return;
    }
    // 交易进行中：背包与交易页锁定（新渔获等广播只更新数据，不重绘列表；可点锁定条手动刷新）
    if (tradeLockOn() && (currentView === 'inventory' || currentView === 'trade') && scope && scope !== 'trade') {
      renderTopbar(); renderNav();
      return;
    }
    // 背包子筛选控件获得焦点时同样暂停重绘（避免输入被广播冲掉）
    if (currentView === 'inventory' && invFocus && scope && scope !== 'all') {
      renderTopbar(); renderNav();
      return;
    }
    // 市集筛选控件（词条下拉/数值输入）获得焦点时暂停重绘：否则广播会重建 DOM 导致下拉框被关闭。
    if (currentView === 'market' && marketFilterActive && scope && scope !== 'all') {
      renderTopbar(); renderNav();
      return;
    }
    renderTopbar(); renderNav();
    const scopes = VIEW_SCOPES[currentView];
    if (!scope || !scopes || scopes.indexOf(scope) >= 0) renderView();
  }

  function init() {
    wireAuth();
    // 启动前先做版本守卫：服务器版本与本地前端不一致时带缓存参数强刷（避免旧缓存进不去新版页面）
    const boot = (window.Net && window.Net.guardVersion) ? window.Net.guardVersion() : Promise.resolve(false);
    boot.then(function (reloading) {
      if (reloading) return; // 已触发整页刷新，不再继续初始化
      initApp();
    }).catch(function () { initApp(); });
  }
  function initApp() {
    // 交易页冷却倒计时：仅在冷却期间重绘，冷却结束后补一次
    let cdLast = 0;
    setInterval(function () {
      if (currentView !== 'trade') { cdLast = 0; return; }
      const t = S().trade;
      if (!t) { cdLast = 0; return; }
      const cd = Math.max(0, (t.cooldownUntil || 0) - Date.now());
      if (cd > 0 || cdLast > 0) {
        // 锁定中只改倒计时文字，不整页重建（否则会刷新正在挑选的物品列表）
        if (cd > 0 && tradeLockOn()) updateTradeCountdown(cd);
        else { renderTopbar(); renderView(); }
      }
      cdLast = cd;
    }, 500);
    // 反馈页冷却倒计时：仅在反馈页且冷却中时按秒重绘剩余时间
    let fbLast = 0;
    setInterval(function () {
      if (currentView !== 'feedback') { fbLast = 0; return; }
      const st = S().feedback;
      if (!st || !st.status) { fbLast = 0; return; }
      const rem = Math.max(0, (st.status.nextAt || 0) - Date.now());
      if (rem > 0 || fbLast > 0) renderView();
      fbLast = rem;
    }, 1000);
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
    toast: toast, showRecordBanner: showRecordBanner, onBanners: onBanners, onBannerStop: onBannerStop,
    addLog: addLog, onSubAlert: onSubAlert, resetBanners: resetBanners, onUpdate: onUpdate,
    renderNav: renderNav, renderTopbar: renderTopbar, renderView: renderView, forceLogout: forceLogout,
    onConnChange: onConnChange,
    getView: function () { return currentView; },
    setView: function (v) { currentView = v; },
  };
})();

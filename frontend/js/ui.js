/*
 * 网页钓鱼小游戏 - UI 渲染与交互
 * 视图：钓鱼（含钓竿页签） / 角色 / 社交 / 背包 / 工坊 / 商城（限购·收购·市集） / 图鉴（含记录页签） / 反馈 / 日志
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
  function featureBlocked(id) { return window.GameFeatures && window.GameFeatures.blocked(S().features, id); }
  function featureGuard(id) {
    if (!featureBlocked(id)) return true;
    toast(window.GameFeatures.message(S().features, id)); return false;
  }
  function markFeature(button, id) {
    button.setAttribute('data-feature', id);
    if (featureBlocked(id)) {
      button.setAttribute('aria-disabled', 'true'); button.classList.add('feature-locked');
      button.title = window.GameFeatures.message(S().features, id);
    }
    return button;
  }
  document.addEventListener('click', function (ev) {
    const target = ev.target.closest && ev.target.closest('[data-feature]');
    if (target && !featureGuard(target.getAttribute('data-feature'))) { ev.preventDefault(); ev.stopImmediatePropagation(); }
  }, true);
  function applyFeatureControls() {
    const selectors = { '#ws-go': 'workshop.smelt', '#ws-recast-go': 'workshop.recast', '.sub-entry': 'inventory.subscribe', '.ab-open-btn': 'bd.autobuild', '#sa-open-list': 'mall.autosell', '#sa-tier': 'mall.autosell' };
    Object.keys(selectors).forEach(function (selector) { document.querySelectorAll(selector).forEach(function (b) { markFeature(b, selectors[selector]); }); });
  }
  function onFeatures() {
    closeOverlays();
    invFocus = false; bulkFocus = false;
    if (featureBlocked('ground.trade') && tradeModalRedraw) tradeModalClose({ noCancel: true });
    if (featureBlocked('fishing.cast')) { S().fishing.active = false; S().player.status = 'idle'; S().player.groundId = null; S().player.spotId = null; }
    navSig = null; renderNav(); renderTopbar(); renderView();
  }
  function E() { return window.Engine; }
  function S() { return window.Engine.state; }
  // 库存快照统一入口（v0.13.9）：带 invRev 的完整快照只在「不旧于已应用版本」时才生效。
  // 直接 `st.inventory = r.data.inventory` 会让先发后到的旧响应盖掉刚获得的物品（连开宝匣丢配件的根因）。
  function applyInvFrom(d) { return !!(d && d.inventory && window.Engine.applyInv(d.inventory, d.invRev)); }

  // v0.14.0：**鱼类暂时不许上市集**（临时开关，true = 恢复；后端 backend/server.js 有同名常量 MARKET_FISH_LIST，
  // 两边要一起改）。改版期间渔获只走系统收购：背包行 / 市集「我的背包」都不再给鱼类出「上架」入口，
  // 服务端同样拒绝（前端隐藏只是避免点了才报错）。已有挂单照常可买、可下架。
  const MARKET_FISH_LIST = false;

  // ---- 在途出售账本（v0.13.10：出售改本地实时刷新 + 回包对账）----
  // 点「出售」时**先本地扣显示量、加金币、就地更新那一行**，不等服务器回包（此前要等整个
  // 往返才动数字，玩家感觉「跟服务器刷新率挂钩」）。回包后以服务器权威值（inventory / coins /
  // shop / bigfish）对账，并撤掉这条在途记录；服务器拒单就只撤记录——界面自动回到真实值。
  // 关键不变量：**显示量 = 服务器可用量 − 在途出售量（下限 0）**，所以连点也不会卖出超过持有量；
  // 任何一次重绘（SSE 广播 / 切页签）都走同一套显示口径，在途期间不会「跳回旧数字」。
  const pendingSells = [];   // [{ id, tier, qty, est }]，tier 为 null = 普通通道
  function tierCn(t) { return t === 'G' ? '巨型' : '大型'; }
  // 在途出售量：tier 给了就只算该体型档，没给只算普通通道（两者互不影响，因为预留量是分开计的）
  function pendingQtyOf(id, tier) {
    const want = tier || null;
    let n = 0;
    pendingSells.forEach(function (e) { if (e.id === id && (e.tier || null) === want) n += e.qty; });
    return n;
  }
  // 显示用「可用量」/「某档预留量」= 服务器值 − 在途量
  function shownAvailOf(id) { return Math.max(0, availCountOf(id) - pendingQtyOf(id, null)); }
  function shownReservedOf(id, tier) { return Math.max(0, reservedCountOf(id, tier) - pendingQtyOf(id, tier)); }
  // 顶栏金币 = 服务器值 + 在途出售的预估收入（回包后按服务器权威值替换，误差自然收敛）
  function shownCoinsOf() {
    let extra = 0;
    pendingSells.forEach(function (e) { extra += e.est; });
    return (S().player.coins || 0) + extra;
  }
  // 出售已上架/预留的档位单价（与服务端 SIZE_TIER_BONUS 一致：大型 +50% / 巨型 +150%）
  function shownUnitOf(id, tier) {
    const u = unitPriceOf(id);
    return tier ? u + Math.round(u * (tier === 'G' ? 1.5 : 0.5)) : u;
  }
  // 本地实时出售：立刻扣显示量 + 加币 + 就地补丁，回包对账保无误。o = { id, qty, tier, unit, onLocal, onSync }
  function sellNow(o) {
    if (!featureGuard('mall.sell')) return Promise.resolve({ ok: false });
    const id = o.id, tier = o.tier || null, qty = Math.max(1, Math.floor(o.qty) || 1);
    const st = S();
    const shown = tier ? shownReservedOf(id, tier) : shownAvailOf(id);
    if (shown < qty) { toast(tier ? (tierCn(tier) + '鱼可出售数量不足') : '可出售数量不足（可能已自动售出或只剩预留量）', true); return Promise.resolve(null); }
    const unit = o.unit != null ? o.unit : unitPriceOf(id);
    const entry = { id: id, tier: tier, qty: qty, est: Math.round(unit * qty * (tier === 'G' ? 2.5 : tier ? 1.5 : 1)) };
    pendingSells.push(entry);
    renderTopbar();               // 金币立刻响应点击
    if (o.onLocal) o.onLocal();   // 那一行 / 那张卡立即按新数量重画
    const finish = function (r, netErr) {
      const i = pendingSells.indexOf(entry);
      if (i >= 0) pendingSells.splice(i, 1);
      if (r && r.ok) {
        // 对账：服务器权威值直接采纳（含行情快照，出售会压价）
        st.player.coins = r.data.coins;
        applyInvFrom(r.data);
        st.shop = r.data.shop;
        if (r.data.bigfish !== undefined) st.bigfish = r.data.bigfish || {};
        toast('售出 ' + itemMeta(id).name + ' ×' + qty + (tier ? '（' + tierCn(tier) + '）' : '') +
          '，获得 💰' + r.data.gain + (r.data.bonus ? '（含体型加成 +' + r.data.bonus + '💰）' : ''));
      } else {
        toast((r && r.data && r.data.error) || (netErr ? '网络错误' : '出售失败'), true);
      }
      renderTopbar();
      // 请求结果未知（超时 / 断线）：服务端可能**已经**卖掉这件物品 —— 光撤在途记录会让本地数字虚高，
      // 所以向服务器要一次权威状态（inventory / coins / bigfish）再校准（「售出时刷新保证无误」这一半）。
      if (!r && netErr) {
        Promise.resolve(window.Net.fetchMe()).then(function (m) {
          if (m && m.ok && m.data) {
            if (m.data.coins != null) st.player.coins = m.data.coins;
            applyInvFrom(m.data);
            if (m.data.bigfish !== undefined) st.bigfish = m.data.bigfish || {};
            renderTopbar();
          }
          if (o.onSync) o.onSync();
        }).catch(function () { if (o.onSync) o.onSync(); });
        return r;
      }
      if (o.onSync) o.onSync();
      return r;
    };
    return Promise.resolve(window.Net.sell(id, qty, tier)).then(function (r) { return finish(r, false); })
      .catch(function () { return finish(null, true); });
  }

  let currentView = 'fishing';
  // 与商城一致：相关功能共用一个导航入口，在页面内用一级页签切换。
  // 旧 view id 仍由 navigateView 接受，确保顶栏快捷入口与外部调用平滑迁移。
  let fishingTab = 'fishing';   // fishing | rod
  let codexMainTab = 'codex';   // codex | records
  let charTab = 'companion';    // companion | boat
  let fbTab = 'submit';         // submit | mine

  function $(id) { return document.getElementById(id); }
  function el(tag, cls, html) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    return e;
  }
  // 词缀/增益名称：组件词缀与钓点增益同一套标签（v0.13.3 起不再有大鱼概率）
  function affixName(type) { return D.AFFIX_LABEL[type] || type; }
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
  // 带日期的时刻（渔获记录这类长期留存的展示用）：纪录可能挂几个月，只给时分秒看不出是哪天
  function dateTimeStr(t) {
    const d = new Date(t);
    return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2) + ' ' + timeStr(t);
  }
  function itemMeta(id) { return D.itemOf ? D.itemOf(id) : { name: id, rarity: 'common', price: 10, kind: 'unknown' }; }
  // 现价：优先系统商店行情，无行情时退回基准价（模块级，供各视图与子窗口共用）
  function unitPriceOf(id) { const s = S().shop && S().shop[id]; return s ? s.price : itemMeta(id).price; }
  // v0.13.6：某种鱼的大型/巨型预留计数（模块级；无预留返回 0 / 传 tier 只看该档）
  function reservedCountOf(id, tier) {
    const bf = S().bigfish && S().bigfish[id];
    if (!bf) return 0;
    return tier ? (bf[tier] || 0) : ((bf.L || 0) + (bf.G || 0));
  }
  // 「普通」可用量 = 背包总量 − 大型/巨型预留（批量出售 / 上架弹窗的输入上限用它，服务器同样校验）
  function availCountOf(id) { return Math.max(0, (S().inventory[id] || 0) - reservedCountOf(id)); }
  // ---- 组件展示辅助 ----
  // 品质配色类（配色规范：普通=灰蓝 / 稀有=蓝 / 史诗=金 / 神话=彩虹，见 style.css 的 .q-*/.r-* 与 data.js QUALITY 注释）：
  // 组件满词条在背包/市集/装备弹窗额外高亮；渔获用的是同一套品质（稀有/史诗），不再有「大鱼」档位配色与皇冠前缀。
  function qualityClass(meta) {
    if (!meta) return 'r-common';
    if (meta.kind === 'component' && meta.quality) {
      // 神话（宝匣专属）优先于「满词条」金色：否则突破件会和普通满词条史诗长得一样，玩家分不出来
      if (meta.quality === 'mythic') return 'q-mythic';
      return meta.isFull ? 'q-full' : ('q-' + meta.quality);
    }
    return rarityClass(meta.rarity);
  }
  // 组件词缀 span 的起始标签：池外词缀（本底材词缀池里没有的词缀）额外加 extra 标记。
  // 池外词缀再按**真实来源**分三类，各自一个 class，配色/下划线区别见 style.css：
  //   突破词缀（.bt）：只有海王遗匣在池外补足才产生
  //   催化词缀（.ct）：工坊熔炼投入催化剂补缀产生
  //   普通池外词缀（.ex）：熔炼从附件（副件）搬来，或来源无法证实（后台定制件 / 旧存档）
  // 判据由 data.js 的 affixKindOf 统一给出（不能只看「不在池内」就当作突破词缀）。
  function affixKind(a) { return (D.affixKindOf ? D.affixKindOf(a) : (a && a.extra ? 'extra' : 'pool')); }
  function affixKindCls(a) {
    const k = affixKind(a);
    return k === 'breakthrough' ? ' bt' : (k === 'catalyst' ? ' ct' : (k === 'extra' ? ' ex' : ''));
  }
  function extraAffixName(a) { return D.extraKindName ? D.extraKindName(a) : '池外词缀'; }
  function extraAffixTitle(a) { return D.extraKindDesc ? D.extraKindDesc(a) : '池外词缀'; }
  function affSpanOpen(a) {
    const extra = !!(a && a.extra);
    return '<span class="inst-aff ' + (a.value < 0 ? 'neg' : 'pos') + (extra ? ' extra' : '') + affixKindCls(a) + '"' +
      (extra ? ' title="' + extraAffixTitle(a) + '"' : '') + '>';
  }
  // 词缀数值区间 [min,max]；来源优先：熔炼搬来的副件区间 / 催化 / 突破按词缀自带来源取，
  // 只有来源就是该底材本身（或没有来源）时才用底材区间；都没有则返回 null（不显示区间）
  function affixRangeIn(meta, a) {
    if (!a) return null;
    const pool = ((meta && meta.pool) || []).find(function (p) { return p.type === a.type; });
    // 词缀自带范围来源时按来源取区间（熔炼搬来的副件区间 / 催化 / 突破），与服务端 roll 口径一致；
    // 只有来源就是该底材本身（或没有来源）时才用底材区间。
    const src = a.src;
    if (src && !(pool && src === meta.baseId) && D.affixSrcRangeOf) {
      const r = D.affixSrcRangeOf(src, a.type, meta && meta.part);
      if (r) return r;
    }
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
  // 轨道顺序（自上而下）：纪录 → 公告
  function syncBannerOffset() {
    const rec = laneEl('record'), not = laneEl('notice');
    const recOn = !!(rec && rec.classList.contains('show'));
    const notOn = !!(not && not.classList.contains('show'));
    let top = 0;
    if (rec) rec.style.top = top + 'px';
    if (recOn) top += BANNER_LANE_H;
    if (not) not.style.top = top + 'px';
    const h = (recOn ? BANNER_LANE_H : 0) + (notOn ? BANNER_LANE_H : 0);
    document.body.style.setProperty('--banner-h', h + 'px');
    document.body.classList.toggle('banner-open', h > 0);
  }

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
  // 前端本地持久化（localStorage 按账号分开），不占服务器存储。
  // 保留策略（v0.13.4）：只有「渔获 / 系统」这两类**高频**日志各自动丢弃最旧的 300 条——挂机上鱼
  // 会持续刷，不设上限会把交易/纪录流水挤出本地存储；「交易 / 纪录 / 订阅」是低频且需要长期回查的
  // 流水，不自动删除，只受下面的本地总条数安全上限约束。
  const LOG_KEEP = 300;
  const LOG_CAPPED = { catch: true, system: true };
  const LOG_TOTAL_MAX = 2000;   // localStorage 体积兜底（正常玩不到这个量）
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
  // 丢弃超量的旧日志：按类型各留 LOG_KEEP 条（只对 LOG_CAPPED 里的类型生效），
  // 从最旧的一端（数组尾）往回扫，保证「交易 / 纪录 / 订阅」不会被自动清掉；
  // 只有突破本地总量兜底上限时才连非上限类型一起从最旧删。
  function trimLog() {
    const over = {};
    msgLog.forEach(function (e) { if (LOG_CAPPED[e.kind]) over[e.kind] = (over[e.kind] || 0) + 1; });
    Object.keys(over).forEach(function (k) { over[k] = Math.max(0, over[k] - LOG_KEEP); });
    for (let i = msgLog.length - 1; i >= 0; i--) {
      const k = msgLog[i].kind;
      if (over[k] > 0) { over[k]--; msgLog.splice(i, 1); }
      else if (msgLog.length > LOG_TOTAL_MAX) { msgLog.splice(i, 1); }
    }
  }
  // 记一条服务器消息（同一账号跨页面/刷新保留；不重复登录时不会串号）
  // items（可选）：这条日志涉及的物品 [{ id, qty, dir }]，dir='got'|'gave'。
  //   只存物品 id（组件实例签名），展示时再解析词条数值——日志数据因此与展示口径解耦。
  function addLog(kind, msg, items) {
    loadLog();
    const e = { t: Date.now(), kind: LOG_KINDS[kind] ? kind : 'system', msg: String(msg == null ? '' : msg) };
    if (items && items.length) e.items = items.filter(function (it) { return it && it.id != null; });
    msgLog.unshift(e);
    trimLog();
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
    // data-keep 的 overlay（交易子窗口）不被普通弹窗关闭——组件属性/确认框会叠在它上面打开
    document.querySelectorAll('.modal-overlay').forEach(function (m) { if (!m.dataset.keep) m.remove(); });
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
  // 页面骨架统一为「一行标题 + 可选页签 + 可选说明」：
  //   pageHead('🛒', '商城', '限购 · 金币直购 ｜ 收购 · 卖出换钱 ｜ 市集 · 玩家交易')
  //   sectionTabsHtml(scope, active, items) —— 商城「限购 / 收购 / 市集」同款页签
  //   pageHelp('一句话说清这一页怎么用') —— 页签下的操作说明，写在内容之前
  // 每个导航入口只承载一个主页面，主页面内的子功能一律用页签切换，不再各占一个侧栏入口。
  function pageHead(icon, title, subtitle) {
    return '<h2>' + icon + ' ' + esc(title) +
      (subtitle ? ' <span class="subtitle">' + subtitle + '</span>' : '') + '</h2>';
  }
  function pageHelp(text) {
    return '<div class="hint page-help">' + text + '</div>';
  }
  // 页签（与商城「限购 / 收购 / 市集」同款）：scope 决定点选后写哪个页签状态
  const SECTION_STATE = {
    fishing: function (v) { fishingTab = v; },
    codex: function (v) { codexMainTab = v; },
    character: function (v) { charTab = v; },
    feedback: function (v) { fbTab = v; },
  };
  function sectionTabsHtml(scope, active, items) {
    return '<div class="inv-cats ws-tabs section-tabs" role="tablist">' + items.map(function (kv) {
      return '<button class="inv-cat' + (active === kv[0] ? ' on' : '') + '" data-section="' + scope +
        '" data-sectiontab="' + kv[0] + '" role="tab" aria-selected="' + (active === kv[0] ? 'true' : 'false') + '">' + kv[1] + '</button>';
    }).join('') + '</div>';
  }
  function bindSectionTabs(panel, scope) {
    if (!panel) return;
    panel.querySelectorAll('[data-section="' + scope + '"]').forEach(function (b) {
      b.addEventListener('click', function () {
        const tab = b.getAttribute('data-sectiontab');
        const set = SECTION_STATE[scope];
        if (set) set(tab);
        renderView();
      });
    });
  }
  function navigateView(view) {
    if (view === 'bd') { currentView = 'fishing'; fishingTab = 'rod'; return; }
    if (view === 'records') { currentView = 'codex'; codexMainTab = 'records'; return; }
    currentView = view;
  }
  // 当前实际展示的页面 id（= 功能开关 id = 广播 scope 键）：
  // 合并页按「当前页签」折算回原页面 id，功能锁定、广播重绘范围都以它为准。
  function pageIdOf() {
    if (currentView === 'fishing') return fishingTab === 'rod' ? 'bd' : 'fishing';
    if (currentView === 'codex') return codexMainTab === 'records' ? 'records' : 'codex';
    return currentView === 'shop' || currentView === 'market' ? 'mall' : currentView;
  }
  // 内容签名： 当前视图 / 钓鱼徽标 / 交易徽标 / 订阅红标 任一变化才重建。
  // 否则每次广播都会 innerHTML 重建导航，悬停高亮与过渡动画被打断（左侧闪烁）。
  // 结构：全部入口平铺常驻（v0.11.3 起取消「更多」折叠组）——菜单一眼看全，
  // 一屏放不下时导航区自己滚动（滚动条样式与像素主题一致，见 style.css 的 .nav）。
  let navSig = null;
  function renderNav() {
    const st = S();
    const sig = [currentView, st.fishing.active ? 1 : 0, st.trade ? (st.trade.id || 1) : 0,
      st.me && st.me.admin ? 1 : 0, subUnseen, JSON.stringify(st.features || {})].join('|');
    if (sig === navSig) return;
    navSig = sig;
    const nav = $('nav');
    nav.innerHTML = '';
    const makeItem = function (item) {
      const b = el('button', 'nav-item' + (item.id === currentView ? ' active' : '') + (item.implemented ? '' : ' locked'));
      if (item.id === currentView) b.setAttribute('aria-current', 'page');
      markFeature(b, item.id);
      let badge = '';
      if (item.id === 'fishing' && S().fishing.active) badge = '<span class="nav-badge on">钓</span>';
      if (item.id === 'trade' && S().trade) badge = '<span class="nav-badge alert">!</span>';
      // 组件订阅提醒：背包入口显示未读红标（进入背包即清零）
      if (item.id === 'inventory' && subUnseen > 0) badge = '<span class="nav-badge unread">' + (subUnseen > 99 ? '99+' : subUnseen) + '</span>';
      // 像素导航图标（assets/nav/<id>.png，由 tools/gen_nav.py 生成）；emoji 作为降级兜底
      const navIcon = '<span class="nav-icon"><img class="nav-ico" src="assets/nav/' + esc(item.id) +
        '.png" alt="" draggable="false" onerror="this.outerHTML=\'' + item.icon + '\'"></span>';
      if (featureBlocked(item.id)) badge += '<span class="nav-badge">🔒</span>';
      b.innerHTML = navIcon + '<span>' + esc(item.name) + '</span>' + badge +
        (item.implemented ? '' : '<span class="lock">🔒</span>');
      b.addEventListener('click', function () {
        if (!item.implemented) {
          toast('「' + item.name + '」功能尚未开放（框架占位）');
          return; // 未完成功能：不可跳转
        }
        navigateView(item.id);
        if (item.id === 'inventory') clearSubAlerts();
        if (item.id !== 'ground') peepComposing = false; // 离开渔场页：搜索框已随 DOM 销毁，合成标记不能留成脏值
        renderNav();
        renderView();
        loadViewData(item.id);
      });
      return b;
    };
    D.NAV.forEach(function (item) { nav.appendChild(makeItem(item)); });
    revealActiveNav();
  }
  function revealActiveNav() {
    const nav = $('nav');
    if (nav && window.matchMedia && window.matchMedia('(max-width: 880px)').matches) {
      const active = nav.querySelector('.active'), sidebar = nav.parentElement;
      if (active && sidebar) {
        const a = active.getBoundingClientRect(), s = sidebar.getBoundingClientRect();
        sidebar.scrollLeft += a.left - s.left - (s.width - a.width) / 2;
      }
    }
  }
  let navResizeFrame = 0;
  window.addEventListener('resize', function () {
    if (navResizeFrame) return;
    navResizeFrame = requestAnimationFrame(function () { navResizeFrame = 0; revealActiveNav(); });
  });

  // 顶栏左上角品牌：管理员点击在新标签打开管理后台（admin.html 与游戏同源托管），普通玩家点击无反应。
  // 只在 init 里绑定一次，避免 renderTopbar / renderNav 反复重建时叠加重复监听。
  function wireBrand() {
    const b = $('brand-logo');
    if (!b) return;
    b.addEventListener('click', function () {
      const st = S();
      if (st && st.me && st.me.admin) window.open('admin.html', '_blank', 'noopener');
    });
  }
  // 管理员才挂 brand-admin（CSS 据此给出手型光标），普通玩家移除；幂等，可在每次渲染时调用
  function syncBrandAdmin() {
    const b = $('brand-logo');
    if (!b) return;
    b.classList.toggle('brand-admin', !!(S().me && S().me.admin));
  }

  // ---- 顶栏状态 ----
  function renderTopbar() {
    const p = S().player;
    const st = S();
    syncBrandAdmin();   // 登录账号是管理员时给品牌挂 brand-admin（CSS 出光标）
    const statusText = p.status === 'fishing' ? '正在钓鱼' : (p.groundId ? '空闲' : '未出发');
    const loc = p.groundId
      ? (function () {
          const g = D.GROUNDS.find(function (x) { return x.id === p.groundId; });
          const sp = g && g.spots.find(function (x) { return x.id === p.spotId; });
          return g ? (g.name + (sp ? '·' + sp.name : '')) : '';
        })()
      : '—';
    // 顶栏状态块可点击跳转（判定以**框体**为准：整块都是按钮，点空白也算）
    //   状态 / 位置 → 钓鱼页；抛竿间隔 → 钓竿页；在线人数 → 社交页；上鱼率 → 公式由后台控制，跳钓鱼页
    const navTo = function (view, tip) {
      return { cls: ' meta-btn', tip: tip, view: view };
    };
    const chips = [
      { cls: ' meta-btn', tip: '点击回到钓鱼页', view: 'fishing', html: '<span class="dot ' + (p.status === 'fishing' ? 'on' : 'idle') + '"></span>' +
        '<span class="pname">' + esc(p.name) + '</span><span class="meta-txt">状态：' + esc(statusText) + '</span>' },
    ];
    if (castSpeedShort()) chips.push(Object.assign(navTo('bd', '点击打开「钓鱼 · 钓竿」页签（抛竿间隔由钓竿词缀 / 钓点增益 / 全服钓速共同决定）'), { html: '<span class="meta-txt">🎣 ' + esc(castSpeedShort()) + '</span>' }));
    if (biteRateShort()) chips.push(Object.assign(navTo('fishing', '上鱼率由后台「公式管理」的上钩公式决定；点击回到钓鱼页'), { html: '<span class="meta-txt">🐟 ' + esc(biteRateShort()) + '</span>' }));
    chips.push(Object.assign(navTo('fishing', '点击回到钓鱼页'), { html: '<span class="meta-txt">位置：' + esc(loc) + '</span>' }));
    chips.push(Object.assign(navTo('ground', '点击查看「社交」页（各钓场人数、在线玩家与实时动态）'), { html: '<span class="meta-txt">在线：' + est.players + ' 人</span>' }));
    if (!connOk()) {
      chips.push({ cls: ' meta-btn conn-off', tip: '与服务器的实时连接已断开，正在自动重连；期间显示的数据可能不是最新。服务器若已更新，重连后会自动刷新到新版本。', view: '', html: '<span class="meta-txt">⚠ 连接断开 · 重连中</span>' });
    }
    chips.push({ cls: ' meta-btn coins', tip: '金币余额 · 点击打开商城', view: 'mall', html: '<span class="meta-txt">💰 ' + shownCoinsOf() + '</span>' });
    const status = $('player-status');
    const chipsHtml = chips.map(function (c) {
      // 保留原有 .meta 类（顶栏配色与像素主题都挂在它上面），再叠加 .meta-btn 表示可点击
      const cls = ('meta ' + c.cls).replace(/[ 	]+/g, ' ').trim();
      return '<button class="' + cls + '" data-view="' + esc(c.view || '') + '" title="' + esc(c.tip || '') + '">' + c.html + '</button>';
    }).join('');
    // 数值没变就不重建：上鱼等高频广播会顺带刷顶栏，重复 innerHTML 会让整条顶栏跟着闪一下
    if (status.getAttribute('data-sig') === chipsHtml) return;
    status.setAttribute('data-sig', chipsHtml);
    status.innerHTML = chipsHtml;
    status.querySelectorAll('[data-view]').forEach(function (b) {
      b.addEventListener('click', function () {
        const v = b.getAttribute('data-view');
        if (!v) return;
        navigateView(v);
        renderNav(); renderView(); loadViewData(v);
        renderTopbar();   // 选中态与提示随视图更新
      });
    });
  }
  // 顶栏在线数用小工具（避免每次手写）
  const est = { get players() { return S().onlineTotal || S().players.length || 0; } };
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

  // 渔获日志行的键：时间戳 + 品名 + 尺寸 + 稀有度（用于增量插入时判断哪几行是新的）
  function logKey(e) {
    const it = (e && e.item) || {};
    return [e && e.t, it.name, it.size, it.rarity].join('|');
  }
  function logRowHtml(e) {
    const meta = e.item || {};
    return timeStr(e.t) + ' · 钓到 <span class="' + qualityClass(meta) + '">' + esc(meta.name) +
      '</span>' + (meta.size ? ' <span class="muted">' + meta.size + 'cm</span>' : '') +
      (meta.rarity === 'rare' ? ' ✨稀有' : meta.rarity === 'epic' ? ' 💎史诗' : '');
  }
  // 钓场卡片文案（地图外那一排）：构建与增量刷新共用，保证两处一致
  function groundCardText(g, cnt) {
    return g.locked ? '🔒 活动钓场 · 即将开放'
      : (g.type === 'normal' ? '普通钓场' : '活动钓场') + ' · 👥 ' + cnt + ' 人';
  }
  // 左栏底部状态条文案（在钓鱼 / 未钓鱼）
  function fishStateHtml(st) {
    if (!st.fishing.active) {
      return '<span class="dot idle"></span> 未在钓鱼<span class="state-hint">点击任意垂钓点即可开始自动钓鱼</span>';
    }
    const g = D.GROUNDS.find(function (x) { return x.id === st.player.groundId; });
    const sp = g && g.spots.find(function (x) { return x.id === st.player.spotId; });
    return '<span class="dot on"></span> 自动钓鱼中 · ' + esc(g ? g.name : '') + (sp ? '·' + esc(sp.name) : '') +
      '<span class="state-hint">' + esc(castText()) + ' · 再点当前钓点可取消</span>';
  }
  // 「同钓点 N 人」文案：构建与增量刷新共用（切钓点后本地会先标成同步中，不等 5s 轮询）
  function peepsHeadText(st) {
    if (st.peepsLoading) return '同钓点人数同步中…';
    const pp = st.peepsPage || { total: 0 };
    return '同钓点 ' + pp.total + ' 人' + (pp.total > 5 ? '（可下滑查看全部）' : '');
  }
  // 同钓点玩家列表的内容签名：只有玩家/状态/近期渔获真的变了才重建这几行
  function peepSig(here) {
    return here.map(function (b) {
      return b.id + ',' + b.status + ',' + (b.recent || '') + ',' + (b.color || '');
    }).join(';');
  }
  // 钓鱼页结构签名：地图页签 / 钓点与增益 / 所点与所在钓点 / 是否在钓鱼。
  // 人数、渔获、金币等高频变化的**不进签名**——它们走 patchFishingLive() 原地更新；
  // 否则每次上鱼都整页重建，地图节点、水面动画、渔获日志会被重建而闪动（动画从头播）。
  function fishingSig(st) {
    const parts = [mapTab, st.selected.groundId || '', st.selected.spotId || '',
      st.player.groundId || '', st.player.spotId || '', st.fishing.active ? 1 : 0];
    D.GROUNDS.forEach(function (g) {
      parts.push(g.id + ':' + g.name + ':' + (g.locked ? 'L' : '') + ':' + g.type);
      (g.spots || []).forEach(function (sp) {
        parts.push(sp.id + ':' + sp.name + ':' + (Array.isArray(sp.pos) ? sp.pos.join(',') : '') + ':' +
          (sp.buffs || []).map(function (b) { return b.type + b.value; }).join('+'));
      });
    });
    return parts.join('|');
  }

  // ---- 渔场实况 · 游鱼（装饰动画，无逻辑） ----
  // 鱼群 = 当前钓点掉落池里的鱼（不在钓点则取当前所选钓场全部钓点），按掉落权重随机，
  // 每条按自身常见体型缩放；贴图鱼头朝左，向左游不翻转、向右游镜像。
  // 定时换鱼只挑已经游到画面边上的那条，半路上不换，免得鱼凭空消失。
  const SCENE_LANES = 4;                       // 同屏游鱼条数
  const SCENE_LANE_BOTTOM = [4, 11, 19, 27];   // 各条泳道离底百分比（越靠下的泳道越近、越清楚）
  let scenePool = [];                          // [{ id, weight, px }] 当前可能出现的鱼
  function scenePickId(e) {                    // 'fish:crucian' → 'crucian'（非鱼返回 ''）
    const s = e && e.pick;
    return (typeof s === 'string' && s.slice(0, 5) === 'fish:') ? s.slice(5) : '';
  }
  // 常见体型（cm）→ 贴图宽度 px：麦穗鱼 30 出头，巨鲟 70 上下
  function sceneFishPx(id) {
    const sz = D.itemOf(id).size;
    const mid = (Array.isArray(sz) && sz.length >= 2) ? (sz[0] + sz[1]) / 2 : 40;
    return Math.round(26 + 50 * Math.sqrt(Math.max(0, Math.min(1, mid / 320))));
  }
  // 当前实况该出现哪些鱼 + 池子签名（签名变了就重掷，见 patchFishingLive ⑤）
  function scenePoolOf(st) {
    const atG = st.player.groundId, atS = st.player.spotId;
    const gid = atG || st.selected.groundId;
    const g = gid ? D.GROUNDS.find(function (x) { return x.id === gid; }) : null;
    const sp = (g && atG) ? (g.spots || []).find(function (x) { return x.id === atS; }) : null;
    const pools = !g ? [] : (sp ? [sp.pool || []] : (g.spots || []).map(function (x) { return x.pool || []; }));
    const list = [], at = {};
    let sig = g ? g.id + (sp ? ':' + sp.id : '') : '';
    pools.forEach(function (pool) {
      (pool || []).forEach(function (e) {
        const id = scenePickId(e), w = Math.max(0, e.weight || 0);
        sig += '|' + id + ':' + w;
        if (!id) return;
        if (at[id] == null) { at[id] = list.length; list.push({ id: id, weight: w, px: sceneFishPx(id) }); }
        else if (list[at[id]].weight < w) list[at[id]].weight = w;   // 同一条鱼被重复配置时取较大权重
      });
    });
    if (!list.length) {   // 没配掉落池 / 不在任何钓场：回落默认淡水鱼，画面不留空
      sig = 'default';
      ['crucian', 'carp', 'white'].forEach(function (id) { list.push({ id: id, weight: 1, px: sceneFishPx(id) }); });
    }
    return { sig: sig, list: list };
  }
  // 按掉落权重随机取一条鱼（权重全为 0 时退化为等概率）
  function sceneFishPick() {
    let total = 0;
    scenePool.forEach(function (f) { total += f.weight; });
    if (total <= 0) return scenePool[Math.floor(Math.random() * scenePool.length)];
    let r = Math.random() * total;
    for (let i = 0; i < scenePool.length; i++) {
      r -= scenePool[i].weight;
      if (r <= 0) return scenePool[i];
    }
    return scenePool[scenePool.length - 1];
  }
  // 造一条游鱼：鱼种 / 朝向 / 泳道 / 速度都随机。
  // spread=true 时用负延迟把开局这几条错开（一上来就分布在水里），false 时从画面外游入（换鱼用）。
  function sceneFishEl(lane, spread) {
    const f = sceneFishPick();
    const right = Math.random() < .5;                          // 向右游？
    const dur = (12 + Math.random() * 8) * (.7 + f.px / 90);   // 大鱼游得慢些
    const img = el('img', 'px-fish ' + (right ? 'swim-r' : 'swim-l'));
    img.src = 'assets/fish/' + f.id + '.png';
    img.alt = '';
    img.draggable = false;
    img.setAttribute('data-lane', lane);
    img.setAttribute('data-fish', f.id);
    img.style.width = f.px + 'px';
    img.style.setProperty('--fw', f.px + 'px');                // 出画位置按鱼宽算（见 pixel.css）
    img.style.setProperty('--fo', (0.58 - lane * 0.08).toFixed(2));  // 越靠下的泳道越近、越清楚
    img.style.bottom = (SCENE_LANE_BOTTOM[lane] + (Math.random() * 4 - 2)).toFixed(1) + '%';
    img.style.animationDuration = dur.toFixed(1) + 's';
    img.style.animationDelay = (spread ? -Math.random() * dur : 0).toFixed(1) + 's';
    img.onerror = function () { img.style.display = 'none'; };  // 缺贴图时不留破图
    return img;
  }
  // 铺满场景游鱼（首次渲染、换钓点、后台改过掉落池时重掷整批）
  function fillSceneFish(scene, st, spread) {
    const p = scenePoolOf(st);
    scenePool = p.list;
    scene.setAttribute('data-pool', p.sig);
    Array.prototype.forEach.call(scene.querySelectorAll('.px-fish'), function (im) { im.remove(); });
    for (let i = 0; i < SCENE_LANES; i++) scene.appendChild(sceneFishEl(i, spread));
  }
  // 换掉一条已经游到画面边上的鱼（露出来的部分不超过自身 2/5，首尾 6% 又正好淡出到看不见）。
  // 判定量的是实际几何而不是动画进度：进度值与屏幕上真正画出来的位置差着几帧，
  // 按进度换会在窄面板里把还露着一大截的鱼换掉。
  function rollSceneFish(scene) {
    if (!scenePool.length) return;
    const box = scene.getBoundingClientRect();
    const fishes = scene.querySelectorAll('.px-fish');
    const out = [];
    Array.prototype.forEach.call(fishes, function (im, i) {
      const r = im.getBoundingClientRect();
      const vis = Math.min(r.right, box.right) - Math.max(r.left, box.left);   // 与画面重叠的宽度
      if (vis <= r.width * .4) out.push(i);
    });
    if (!out.length) return;
    const i = out[Math.floor(Math.random() * out.length)];
    const old = fishes[i];
    old.parentNode.replaceChild(sceneFishEl(i, false), old);
  }

  function renderFishing() {
    if (featureBlocked('fishing')) return renderView();
    const main = $('main');
    const st = S();
    const sig = fishingSig(st);
    const host = main.querySelector('.fish-select');
    // 结构没变（只是上鱼 / 人数 / 钓速变化）→ 原地增量更新，整页 DOM 与动画都不动
    if (host && host.getAttribute('data-sig') === sig) { patchFishingLive(st); return; }
    main.innerHTML = '';

    // 左：像素世界地图（钓场为区域、钓点为可点节点；点击节点=选择钓点，逻辑不变）
    // 多地图页签：近岸（现有地图，冰湖活动场也在此图上）/ 出海（未来航线新地图预告）
    const left = el('div', 'panel fish-select');
    left.innerHTML = pageHead('🎣', '钓鱼', '选钓点即自动垂钓 · 配装与存档在「钓竿」页签') +
      sectionTabsHtml('fishing', 'fishing', [['fishing', '🎣 钓鱼'], ['rod', '🎯 钓竿']]) +
      pageHelp('点地图上的浮漂选钓点，服务器随即自动抛竿收竿；再点同一个钓点收竿。') +
      '<h3>🗺 世界地图 · 选择钓点</h3>';
    bindSectionTabs(left, 'fishing');
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
      stillwater: { dock: [61, 34], reed: [68, 60], deep: [74, 48], label: [74, 72] },
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
    // 鼠标在按下时处理，避免广播重绘丢失 mouseup；触摸/笔只在 click 时处理，
    // 防止按下后重绘导致合成 click 再次进入新节点（开始后立刻退出），也允许滑动取消点击。
    function bindSpotInput(target, resolve) {
      target.addEventListener('pointerdown', function (ev) {
        lastSpotPointerType = ev.pointerType;
        if (ev.pointerType !== 'mouse' || ev.button !== 0) return;
        const node = resolve(ev);
        if (node) chooseSpot(node);
      });
      target.addEventListener('click', function (ev) {
        // detail=0 是键盘/辅助技术激活；鼠标真实点击已由 pointerdown 处理。
        if (ev.detail !== 0 && lastSpotPointerType === 'mouse') return;
        const node = resolve(ev);
        if (node) chooseSpot(node);
      });
    }
    function chooseSpot(t) {
      const gid = t.getAttribute('data-g');
      const sid = t.getAttribute('data-s');
      // 未开放的钓场：只提示，不进入选择流程（服务器同样会拒绝）
      const gT = D.GROUNDS.find(function (x) { return x.id === gid; });
      if (gT && gT.locked) { toast('「' + gT.name + '」暂未开放' + (gT.openFrom ? '（限时钓场，未到开放时间）' : '（活动钓场）')); return; }
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
      // 先让状态层乐观更新（含 player.groundId 与「同钓点」列表清空）再渲染：
      // 点下去的一瞬间本地就是新钓点，不必等服务器回包，也不必等 5s 轮询补同钓点列表。
      const pr = E().startFishing(gid, sid);
      renderTopbar(); renderNav(); renderFishing();
      pr.then(function (r) {
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
      // 未开放的钓点统一用 🔒 图标 + 名字后缀（暂未开放）：一眼看出「这里现在钓不了」
      VOYAGE_NODES.forEach(function (n) {
        const node = el('button', 'px-node locked');
        node.style.left = n.pos[0] + '%';
        node.style.top = n.pos[1] + '%';
        node.innerHTML = '<span class="pn-lock">🔒</span><span class="pn-name">' + esc(n.name) +
          '<span class="pn-soon">（暂未开放）</span></span>';
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
        // 锁定的钓场（活动场未开窗 / 后台手动锁定）：节点画成 🔒 并标注「暂未开放」，点击只提示
        const locked = !!g.locked;
        const node = el('button', 'px-node' + (on ? ' on' : '') + (here ? ' here' : '') + (buffed ? ' buffed' : '') + (locked ? ' locked' : ''));
        node.setAttribute('data-g', g.id);
        node.setAttribute('data-s', sp.id);
        node.style.left = pos[0] + '%';
        node.style.top = pos[1] + '%';
        node.innerHTML = (locked ? '<span class="pn-lock">🔒</span>' : '<span class="pn-bob"></span>') +
          '<span class="pn-name">' + esc(sp.name) + (locked ? '<span class="pn-soon">（暂未开放）</span>' : '') +
          (buffed ? '<span class="pn-buff">⚡</span>' : '') + '</span>' +
          (here ? '<img class="pn-fisher" src="' + charSrc('hold') + '" alt="">' : '');
        map.appendChild(node);
      });
    });
    bindSpotInput(map, function (ev) {
      const t = ev.target && ev.target.closest ? ev.target.closest('.px-node') : null;
      return t && t.getAttribute('data-g') ? t : null;
    });
    left.appendChild(map);
    // 甩杆动画（纯视觉）：侠客后摆→前挥→入水。换钓点/开始钓鱼时播一次；
    // 上鱼广播重绘时位置没变就不重播（lastFisherSpotKey 记忆）。
    const hereKey = st.player.groundId && st.player.spotId ? st.player.groundId + '/' + st.player.spotId : null;
    const fisherImg = map.querySelector('.pn-fisher');
    if (fisherImg && hereKey && lastFisherSpotKey !== hereKey) {
      const seq = [charSrc('a'), charSrc('b'), charSrc('hold')];
      fisherImg.src = seq[0];
      setTimeout(function () { if (fisherImg.isConnected) fisherImg.src = seq[1]; }, 150);
      setTimeout(function () { if (fisherImg.isConnected) fisherImg.src = seq[2]; }, 320);
    }
    lastFisherSpotKey = hereKey;
    }
    // 钓场状态卡（地图外）：图标 + 名称 + 类型 + 实时人数/锁定状态
    const groundsBar = el('div', 'px-grounds');
    D.GROUNDS.forEach(function (g) {
      const cnt = (st.groundCounts && st.groundCounts[g.id]) || 0;
      // 当前选中/正在垂钓的钓场：金色边框标注
      const onGround = st.selected.groundId === g.id || st.player.groundId === g.id;
      const card = el('div', 'px-region g-card' + (g.locked ? ' locked' : '') + (onGround ? ' on' : ''));
      card.setAttribute('data-g', g.id); // 增量刷新按钓场找卡片更新人数
      card.innerHTML = '<img class="pg-icon" src="assets/ground/' + esc(g.id) + '.png" alt="" draggable="false"' +
        ' onerror="this.style.display=\'none\'">' +
        '<div class="pg-info"><b>' + esc(g.name) + '</b>' +
        '<span>' + esc(groundCardText(g, cnt)) + '</span></div>';
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
        const chip = el('button', 'pb-chip' +
          // 当前正在垂钓的钓点是增益钓点时，同步高亮
          (st.player.groundId === e.g.id && st.player.spotId === e.sp.id ? ' on' : ''));
        chip.setAttribute('data-g', e.g.id);
        chip.setAttribute('data-s', e.sp.id);
        chip.innerHTML = '<b>' + esc(e.g.name + '·' + e.sp.name) + '</b>' +
          e.sp.buffs.map(function (b) {
            return '<i>' + esc(affixName(b.type) + (b.value > 0 ? '+' : '') + b.value + '%') + '</i>';
          }).join('');
        bindSpotInput(chip, function () { return chip; });
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
    stateBar.innerHTML = fishStateHtml(st);
    ctrl.appendChild(stateBar);
    left.appendChild(ctrl);
    left.setAttribute('data-sig', sig); // 增量刷新靠它判断结构是否变化
    main.appendChild(left);

    // 右：渔场实况（顶部为装饰性垂钓场景：水面 / 游鱼动画，无逻辑）
    const right = el('div', 'panel fish-live');
    right.innerHTML = pageHead('🌊', '渔场实况', '当前钓点画面 · 同钓点玩家 · 我的渔获日志');
    const scene = el('div', 'px-scene');
    scene.setAttribute('data-active', st.fishing.active ? '1' : '0');
    scene.innerHTML = '<div class="px-scene-water"></div>';
    fillSceneFish(scene, st, true);   // 游鱼：当前钓点会出现的鱼里随机取（换钓点 / 改掉落池时重掷）
    // Canvas 场景层（js/scene.js）：山景 / 星空 / 水面倒影 / 粒子，按所在渔场换配色
    if (window.PxScene) window.PxScene.mount(scene, st.player.groundId || st.selected.groundId);
    // 游鱼水色：写入当前渔场 key，CSS 按渔场把鱼调成水下剪影色（见 pixel.css --fishfilter）
    scene.setAttribute('data-ground', st.player.groundId || st.selected.groundId || 'stillwater');
    right.appendChild(scene);
    const atGroundId = st.player.groundId;
    const gNow = atGroundId ? D.GROUNDS.find(function (x) { return x.id === atGroundId; }) : null;
    const spNow = gNow && gNow.spots.find(function (x) { return x.id === st.player.spotId; });
    if (!atGroundId) {
      right.appendChild(el('div', 'here-count', '当前不在任何钓点'));
      right.appendChild(el('div', 'hint', '点左侧地图上的浮漂即可开始自动钓鱼。'));
    } else {
      // perf-9：同钓点列表改为服务端分页拉取（S.peepsPage，net.js 每 5s 拉取当前钓点）
      const pp = st.peepsPage || { page: 1, pages: 1, total: 0, list: [] };
      const here = pp.list || [];
      // 只报所在位置；人数交给下面的「同钓点 N 人」（钓场级人数左侧钓场卡片已有 👥）
      right.appendChild(el('div', 'here-count', '所在：' + esc(gNow ? gNow.name : '') + (spNow ? '·' + esc(spNow.name) : '')));
      // 同屏最多 5 条，超出可下滑（不挤占下方的渔获日志入口）
      right.appendChild(el('div', 'peeps-head', peepsHeadText(st)));
      const peeps = el('div', 'peeps scroll5');
      peeps.setAttribute('data-sig', peepSig(here)); // 内容没变就不重建这几行
      if (here.length === 0) peeps.appendChild(el('div', 'hint', st.peepsLoading ? '同钓点玩家同步中…' : '暂无同一钓点的玩家。'));
      here.forEach(function (b) { peeps.appendChild(peepCard(b)); });
      if (pp.pages > 1) {
        const pager = el('div', 'peep-pager');
        const prev = el('button', 'mini', '‹'); prev.disabled = pp.page <= 1;
        prev.addEventListener('click', function () { const pv = st.peepView = st.peepView || { size: 20, q: '' }; pv.page = pp.page - 1; });
        pager.appendChild(prev);
        pager.appendChild(el('span', 'muted', ' ' + pp.page + '/' + pp.pages + ' '));
        const next = el('button', 'mini', '›'); next.disabled = pp.page >= pp.pages;
        next.addEventListener('click', function () { const pv = st.peepView = st.peepView || { size: 20, q: '' }; pv.page = pp.page + 1; });
        pager.appendChild(next);
        peeps.appendChild(pager);
      }
      right.appendChild(peeps);
    }

    // 主界面渔获日志：随上鱼实时滚动刷新（同时也会写入「📜 日志 · 🐟 渔获」分列做长期留存）
    const logHead = el('h3', null, '📜 我的渔获日志');
    logHead.title = '上鱼时自动滚动刷新；完整记录见「日志 · 🐟 渔获」';
    right.appendChild(logHead);
    const log = el('div', 'catch-log');
    if (st.log.length === 0) log.appendChild(el('div', 'hint', '还没有渔获，去抛竿吧。'));
    st.log.slice(0, 25).forEach(function (e) {
      const row = el('div', 'log-line', logRowHtml(e));
      row.setAttribute('data-k', logKey(e));
      log.appendChild(row);
    });
    right.appendChild(log);
    right.appendChild(el('div', 'hint', '完整渔获记录见「📜 日志 · 🐟 渔获」，可按时间线回看。'));

    main.appendChild(right);
  }

  // 钓鱼页高频增量刷新：只改动「真的会变」的内容（钓场人数 / 实况玩家 / 渔获日志 / 状态条），
  // 地图节点、水面场景、日志旧行都原地保留 —— 上鱼不再整页重建，画面不闪、动画也不用从头播。
  function patchFishingLive(st) {
    const main = $('main');
    if (!main) return;
    // ① 钓场状态卡的人数
    D.GROUNDS.forEach(function (g) {
      const card = main.querySelector('.px-grounds .g-card[data-g="' + g.id + '"]');
      const span = card && card.querySelector('.pg-info span');
      if (!span) return;
      const text = groundCardText(g, (st.groundCounts && st.groundCounts[g.id]) || 0);
      if (span.textContent !== text) span.textContent = text;
    });
    // ② 左栏状态条：钓速 / 上鱼率会随后台配置（castcfg）变化
    const stateBar = main.querySelector('.fish-state');
    if (stateBar) {
      const html = fishStateHtml(st);
      if (stateBar.innerHTML !== html) stateBar.innerHTML = html; // 内容没变就不碰 DOM，免得打断动画
    }
    // ③ 右栏实况：同钓点玩家列表（perf-9 拉取制：S.peepsPage 由 net.js 每 5s 刷新）
    const peeps = main.querySelector('.fish-live .peeps');
    if (peeps && st.player.groundId) {
      const pp = st.peepsPage || { page: 1, pages: 1, total: 0, list: [] };
      const here = pp.list || [];
      const sig = peepSig(here) + '|' + pp.page + '/' + pp.pages + '/' + pp.total + '|' + (st.peepsLoading ? 'L' : '');
      if (peeps.getAttribute('data-sig') !== sig) {
        peeps.setAttribute('data-sig', sig);
        peeps.innerHTML = '';
        if (here.length === 0) peeps.appendChild(el('div', 'hint', st.peepsLoading ? '同钓点玩家同步中…' : '暂无同一钓点的玩家。'));
        here.forEach(function (b) { peeps.appendChild(peepCard(b)); });
        if (pp.pages > 1) {
          const pager = el('div', 'peep-pager');
          const prev = el('button', 'mini', '‹'); prev.disabled = pp.page <= 1;
          prev.addEventListener('click', function () { const pv = st.peepView = st.peepView || { size: 20, q: '' }; pv.page = pp.page - 1; window.Net.fetchPlayersPage({ target: 'peepsPage', page: pv.page, size: pv.size, q: pv.q, ground: st.player.groundId, spot: st.player.spotId }); });
          pager.appendChild(prev);
          pager.appendChild(el('span', 'muted', ' ' + pp.page + '/' + pp.pages + ' '));
          const next = el('button', 'mini', '›'); next.disabled = pp.page >= pp.pages;
          next.addEventListener('click', function () { const pv = st.peepView = st.peepView || { size: 20, q: '' }; pv.page = pp.page + 1; window.Net.fetchPlayersPage({ target: 'peepsPage', page: pv.page, size: pv.size, q: pv.q, ground: st.player.groundId, spot: st.player.spotId }); });
          pager.appendChild(next);
          peeps.appendChild(pager);
        }
        const head = main.querySelector('.peeps-head');
        if (head) head.textContent = peepsHeadText(st);
      }
    }
    // ④ 渔获日志：只把新渔获插到最前面，旧行原地不动（滚动位置自然保持，也不再整列重播入场动画）
    const log = main.querySelector('.fish-live .catch-log');
    if (log) {
      const keys = st.log.slice(0, 25).map(logKey);
      const rendered = Array.prototype.map.call(log.querySelectorAll('.log-line'), function (r) { return r.getAttribute('data-k'); });
      let fresh = keys;
      if (rendered.length) {
        const at = keys.indexOf(rendered[0]);
        if (at >= 0) fresh = keys.slice(0, at);        // 旧首行之前的都是新渔获
        else { log.innerHTML = ''; fresh = keys; }     // 旧行对不上（换账号 / 日志清空）→ 整列重画
      }
      if (fresh.length) {
        const hint = log.querySelector('.hint');
        if (hint) hint.remove();
        for (let i = fresh.length - 1; i >= 0; i--) {
          const row = el('div', 'log-line', logRowHtml(st.log[i]));
          row.setAttribute('data-k', fresh[i]);
          log.insertBefore(row, log.firstChild);
        }
        const rows = log.querySelectorAll('.log-line');   // 超出 25 条的旧行移除
        for (let i = rows.length - 1; i >= 25; i--) rows[i].remove();
      }
      if (!log.querySelector('.log-line') && !log.querySelector('.hint')) {
        log.appendChild(el('div', 'hint', '还没有渔获，去抛竿吧。'));
      }
    }
    // ⑤ 实况场景游鱼：钓点或掉落池变了（换钓点 / 后台改配置）→ 按新池子重掷整批；
    // 平时只由定时器换单条，所以这里不能无条件重掷，否则每次上鱼鱼都会跳一下。
    const scene = main.querySelector('.fish-live .px-scene');
    if (scene && scene.getAttribute('data-pool') !== scenePoolOf(st).sig) fillSceneFish(scene, st, true);
    // 换钓点后场景配色跟随渔场（结构没变时整页不重绘，这里原地更新）
    if (scene && window.PxScene) window.PxScene.update(scene, st.player.groundId || st.selected.groundId);
    if (scene) scene.setAttribute('data-ground', st.player.groundId || st.selected.groundId || 'stillwater');
  }

  function peepCard(b) {
    const st = S();
    const isSelf = st.me && b.id === st.me.id;
    const color = b.color || colorFor(b.name || '?');
    const card = el('div', 'peep' + (isSelf ? ' self' : ''));
    // 信息块单独成函数（peepInfoHtml）：广播只重写这一块，右部按钮原地不动
    card.innerHTML =
      '<span class="avatar" style="background:' + color + '">' + esc((b.name || '?').slice(0, 1)) + '</span>' +
      '<div class="peep-info">' + peepInfoHtml(b) + '</div>';
    // 卡片右部操作区：交易（弹出子窗口）+ 查看（钓竿组件构成）
    if (!isSelf) {
      const acts = el('div', 'peep-acts');
      const tb = el('button', 'mini primary-mini', '🤝 交易');
      markFeature(tb, 'ground.trade');
      tb.title = '与 ' + (b.name || '该玩家') + ' 进行在线交易';
      tb.addEventListener('click', function (ev) { ev.stopPropagation(); openTradeModal(b.id, b.name); });
      const vb = el('button', 'mini', '🔍 查看');
      vb.title = '查看 ' + (b.name || '该玩家') + ' 当前使用的钓竿组件构成';
      vb.addEventListener('click', function (ev) { ev.stopPropagation(); openRodModal(b.id, b.name); });
      acts.appendChild(tb);
      acts.appendChild(vb);
      card.appendChild(acts);
    }
    return card;
  }

  // ---- 钓竿页签视图（组件装备 + 词缀加成） ----
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
        if (r.data.inventory) applyInvFrom(r.data);
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

  // ---- 钓竿自动配装（配装器） ----
  // 从背包（含当前已装的那件）检索 7 个部位的候选组件，按「属性优先级 + 目标区间」求最优组合。
  // 求解全部在 GameData.autoBuildPlan / autoBuildPeek（纯函数、可单测）里，这里只做渲染与交互。
  // 面板每行的滑块 = 该属性的目标下限（拖动即「钓速定到多少」），右侧「可达」列由 autoBuildPeek
  // 现算：把它排到首位、在其余属性的目标区间下求最大值 —— 就是「其他属性还能配到多高」。
  const AB_PRIO_DEFAULT = ['speed', 'double', 'skill', 'rare', 'material', 'size'];
  let abOrder = AB_PRIO_DEFAULT.slice();
  let abEnabled = {};
  let abMin = {}, abMax = {};
  D.AFFIX_TYPES.forEach(function (t) { abEnabled[t] = true; abMin[t] = ''; abMax[t] = ''; });
  let abRefs = [];       // 行内元素引用：就地刷新，避免整块重建时打断拖动与输入
  let abPlan = null;     // 最近一次求解结果
  let abPeek = {};       // 各属性的可达上限（其余属性的目标约束下最高能配到多少）
  let abFloor = {};      // 各属性的可达下限（同一套约束下最低会到多少）—— 与 abPeek 一起构成「可达区间」
  const AB_FLOOR_STATES = 48;   // 下限探针的前沿：只求一个端点，小前沿足够快
  let abBusy = false;    // 正在装配（防止连点重复提交）
  function abLabel(t) { const kv = BD_AFFIXES.find(function (x) { return x[0] === t; }); return kv ? kv[1] : t; }
  function abSigned(v) { return (v > 0 ? '+' : '') + v + '%'; }
  // 候选 = 背包里数量 >0 的组件 + 当前已装的那件（已装件不在背包里，但它也是「可选方案」之一）
  function abCandidateMap(st) {
    const m = {};
    D.ROD_PARTS.forEach(function (p) {
      const list = [];
      const cur = st.bd && st.bd[p.key] && st.bd[p.key].compId;
      if (cur) list.push(cur);
      Object.keys(st.inventory).forEach(function (id) { if (st.inventory[id] > 0) list.push(id); });
      m[p.key] = list;
    });
    return m;
  }
  function autoBuildOpen() {
    if (!featureGuard('bd.autobuild')) return;
    document.querySelectorAll('.modal-overlay').forEach(function (m) { m.remove(); });
    const overlay = buildOverlay(function () { closeOverlays(); });
    const box = el('div', 'modal-box shop-modal ab-modal');
    box.innerHTML = '<div class="modal-head"><span class="modal-title">🧠 自动配装 · 从背包检索最优组合</span>' +
      '<button class="mini modal-close">✕ 关闭</button></div>' +
      '<div class="modal-body">' +
      '<div class="bde-note">检索 7 个部位的可用组件（含当前已装的那件），按<b>优先级</b>选出总属性最高的组合：' +
      '先让第 1 项最大，再在其中让第 2 项最大……<b>下限 / 上限</b>各有一个滑块（数字框可精填，拖到两端 = 不限），' +
      '轨道两端就是该属性当前能落到的<b>可达区间</b>：改动任意一项属性，其余属性的区间与手柄位置都会实时重算；' +
      '目标配不出来会提示「最高只能到多少」。</div>' +
      '<div class="ab-rows"></div>' +
      '<div class="ab-actions"><button class="mini ab-reset">重置目标</button>' +
      '<button class="mini primary-mini ab-apply">一键装配</button>' +
      '<span class="ab-hint ab-apply-hint"></span></div>' +
      '<div class="ab-res"></div></div>';
    overlay.appendChild(box);
    document.body.appendChild(overlay);
    const rowsBox = box.querySelector('.ab-rows');
    const resBox = box.querySelector('.ab-res');
    const applyBtn = box.querySelector('.ab-apply');
    const applyHint = box.querySelector('.ab-apply-hint');
    box.querySelector('.modal-close').addEventListener('click', function () { closeOverlays(); });

    // 本地 st.bd 可能不是服务端的当前装配（整竿上架 / 收起 / 别处改动后本地那份没刷新），
    // 拿旧装配当「已装」会把方案值算错（计划里含着其实没装上的配件）。所以打开面板、
    // 以及每次一键装配之前，都先向服务器要一份权威快照再求解 —— 与全项目「服务器权威」一致。
    function syncProfile(next) {
      const mk = window.Net.getMe && window.Net.getMe();
      if (!mk || !mk.token) { if (next) next(); return; }
      window.Net.fetchMe(mk.token).then(function (r) {
        if (r && r.ok && r.data) { E().applyProfile(r.data); renderTopbar(); renderView(); }
        if (next) next(); else abRefresh();
      }).catch(function () { if (next) next(); else abRefresh(); });
    }

    // 每行：[序号 ↑↓] [勾选 属性名] [下限] [滑块] [上限] [可达 X]
    function buildRows() {
      abRefs = [];
      rowsBox.innerHTML = '';
      abOrder.forEach(function (t, i) {
        const row = el('div', 'ab-row');
        row.appendChild(el('span', 'ab-idx', String(i + 1)));
        const up = el('button', 'mini ab-mv', '↑');
        up.title = '提高优先级：排在上面的属性先被最大化';
        const dn = el('button', 'mini ab-mv', '↓');
        dn.title = '降低优先级';
        up.addEventListener('click', function () {
          if (i <= 0) return;
          abOrder.splice(i, 1); abOrder.splice(i - 1, 0, t);
          buildRows(); abRefresh();
        });
        dn.addEventListener('click', function () {
          if (i >= abOrder.length - 1) return;
          abOrder.splice(i, 1); abOrder.splice(i + 1, 0, t);
          buildRows(); abRefresh();
        });
        row.appendChild(up);
        row.appendChild(dn);
        const cb = el('input');
        cb.type = 'checkbox';
        cb.checked = !!abEnabled[t];
        cb.title = '取消勾选 = 该属性不参与目标（仍会显示数值对比）';
        cb.addEventListener('change', function () { abEnabled[t] = cb.checked; abRefresh(); });
        const lab = el('label', 'ab-en');
        lab.appendChild(cb);
        lab.appendChild(el('span', null, abLabel(t)));
        row.appendChild(lab);
        const minInp = el('input', 'ab-num');
        minInp.type = 'number'; minInp.placeholder = '下限';
        minInp.value = abMin[t] === '' ? '' : abMin[t];
        minInp.title = '目标下限：配装必须不低于该值（留空 = 不限）';
        const maxInp = el('input', 'ab-num');
        maxInp.type = 'number'; maxInp.placeholder = '上限';
        maxInp.value = abMax[t] === '' ? '' : abMax[t];
        maxInp.title = '目标上限：配装不超过该值（留空 = 不限）';
        // 同轨双滑块：下限（青柄）与上限（金柄）共用一条轨道，中间高亮为目标区间；
        // 拖动时互相推挤，保证下限 ≤ 上限
        // 轨道两端 = 该属性在当前目标下的**可达区间**（abRefresh 按 abFloor/abPeek 现算）：
        // 所以调任一行属性时，其余行的轨道范围与两个手柄位置都会跟着重算。
        const sliderMin = el('input', 'ab-range ab-range-min');
        sliderMin.type = 'range'; sliderMin.step = '1';
        sliderMin.title = '下限手柄：拖动 = 设定该属性的目标下限（拖到最左 = 不限），并实时看其他属性还能配到多少';
        const sliderMax = el('input', 'ab-range ab-range-max');
        sliderMax.type = 'range'; sliderMax.step = '1';
        sliderMax.title = '上限手柄：拖动 = 设定该属性的目标上限（拖到最右 = 不限）';
        const dualFill = el('span', 'ab-dual-fill');
        const dual = el('span', 'ab-dual');
        dual.appendChild(el('span', 'ab-dual-track'));
        dual.appendChild(dualFill);
        dual.appendChild(sliderMin);
        dual.appendChild(sliderMax);
        const peekEl = el('span', 'ab-peek');
        peekEl.title = '该属性在当前目标下能落到的区间（下限 ~ 上限）：改任意一项属性都会实时重算';
        // 手柄位置 = 轨道 [base, cap] 内的归一化位置；目标留空（不限）= 停在对应端点
        function syncRow() {
          minInp.value = abMin[t] === '' ? '' : abMin[t];
          maxInp.value = abMax[t] === '' ? '' : abMax[t];
          const base = Number(sliderMin.min) || 0, cap = Number(sliderMax.max) || 0;
          sliderMin.value = String(abMin[t] === '' || abMin[t] == null
            ? base : Math.min(Math.max(Number(abMin[t]) || 0, base), cap));
          sliderMax.value = String(abMax[t] === '' || abMax[t] == null
            ? cap : Math.min(Math.max(Number(abMax[t]) || 0, base), cap));
          syncFill();
        }
        function syncFill() {
          const base = Number(sliderMin.min) || 0, cap = Number(sliderMax.max) || 0;
          const span = cap - base;
          if (span <= 0) { dualFill.style.left = '0%'; dualFill.style.width = '100%'; return; }
          const a = (Number(sliderMin.value) - base) / span * 100;
          const b = (Number(sliderMax.value) - base) / span * 100;
          dualFill.style.left = Math.min(a, b) + '%';
          dualFill.style.width = Math.abs(b - a) + '%';
        }
        sliderMin.addEventListener('input', function () {
          const v = Number(sliderMin.value) || 0;
          const base = Number(sliderMin.min) || 0;
          abMin[t] = v <= base ? '' : String(v);   // 拖到最左（= 可达下限）= 不限，与上限拖到最右对称
          if (abMin[t] !== '' && abMax[t] !== '' && abMax[t] != null && Number(abMax[t]) < v) abMax[t] = String(v);  // 推挤上限
          syncRow();
          abRefresh();
        });
        sliderMax.addEventListener('input', function () {
          const v = Number(sliderMax.value) || 0;
          const atCap = v >= (Number(sliderMax.max) || 0);
          abMax[t] = atCap ? '' : String(v);   // 拖到最右 = 不限
          if (!atCap && abMin[t] !== '' && abMin[t] != null && Number(abMin[t]) > v) abMin[t] = String(v);  // 推挤下限
          syncRow();
          abRefresh();
        });
        minInp.addEventListener('change', function () {
          // 不夹到 0：属性本身可以为负（如龙骨巨竿的钓速 -18~-8），下限也能负数
          abMin[t] = (minInp.value === '' ? '' : String(Math.round(Number(minInp.value) || 0)));
          if (abMin[t] !== '' && abMax[t] !== '' && abMax[t] != null && Number(abMax[t]) < Number(abMin[t])) abMax[t] = abMin[t];
          syncRow();
          abRefresh();
        });
        maxInp.addEventListener('change', function () {
          abMax[t] = (maxInp.value === '' ? '' : String(Math.round(Number(maxInp.value) || 0)));
          if (abMax[t] !== '' && abMin[t] !== '' && abMin[t] != null && Number(abMin[t]) > Number(abMax[t])) abMin[t] = abMax[t];
          syncRow();
          abRefresh();
        });
        const minGrp = el('span', 'ab-slider-grp');
        minGrp.appendChild(el('i', 'ab-grp-tag', '下限'));
        minGrp.appendChild(minInp);
        minGrp.appendChild(dual);
        minGrp.appendChild(maxInp);
        minGrp.appendChild(el('i', 'ab-grp-tag max', '上限'));
        row.appendChild(minGrp);
        row.appendChild(peekEl);
        rowsBox.appendChild(row);
        abRefs.push({ t: t, row: row, minInp: minInp, maxInp: maxInp, sliderMin: sliderMin, sliderMax: sliderMax, syncFill: syncFill, peek: peekEl });
      });
    }

    function abRefresh() {
      const st = S();
      const cfg = {
        parts: D.ROD_PARTS.map(function (p) { return p.key; }),
        candidates: abCandidateMap(st),
        order: abOrder, enabled: abEnabled, min: abMin, max: abMax,
      };
      const peekCfg = {};
      for (const k in cfg) peekCfg[k] = cfg[k];
      peekCfg.maxStates = 80;         // 探针只求一个端点，前沿小一点更快
      abPeek = {}; abFloor = {};
      D.AFFIX_TYPES.forEach(function (t) {
        // 可达区间 = 「其余属性的目标」（含刚刚改动的那一项）约束下，本属性最高/最低能到多少。
        // 上限探针复用同一套约束，所以调一项属性 → 其余属性的区间与手柄位置立刻跟着变。
        abPeek[t] = D.autoBuildPeek(peekCfg, t);
        abFloor[t] = D.autoBuildPeek(Object.assign({}, peekCfg, { maxStates: AB_FLOOR_STATES }), t, 'min');
      });
      abPlan = D.autoBuildPlan(cfg);
      abRefs.forEach(function (r) {
        const hi = Math.ceil(Number(abPeek[r.t]) || 0);
        const lo = Math.floor(Number(abFloor[r.t]) || 0);
        const hasTarget = abMin[r.t] !== '' && abMin[r.t] != null;
        r.row.classList.toggle('on', !!abEnabled[r.t]);
        // 轨道 = 可达区间（下端就到可达下限）：手柄位置与「可达」读数都以它为准。
        // 已填的目标仍放进轨道两端，否则刚填的数值会被手柄夹走、看不出来自己写了什么。
        const base = lo;
        const cap = Math.max(hi, base + 1, Number(abMin[r.t]) || 0, Number(abMax[r.t]) || 0, 10);
        // 正在拖动的手柄不写值/不重设轨道，否则会和手指抢位置（拖完下一次刷新自动归位）
        if (document.activeElement !== r.sliderMin && document.activeElement !== r.sliderMax) {
          r.sliderMin.min = String(base); r.sliderMin.max = String(cap);
          r.sliderMax.min = String(base); r.sliderMax.max = String(cap);
          r.sliderMin.value = String(abMin[r.t] === '' || abMin[r.t] == null
            ? base : Math.min(Math.max(Number(abMin[r.t]) || 0, base), cap));
          r.sliderMax.value = String(abMax[r.t] === '' || abMax[r.t] == null
            ? cap : Math.min(Math.max(Number(abMax[r.t]) || 0, base), cap));
        }
        if (r.syncFill) r.syncFill();
        const over = hasTarget && Number(abMin[r.t]) > hi;
        r.peek.textContent = '可达 ' + abSigned(lo) + '~' + abSigned(hi) + (over ? ' · 低于目标' : '');
        r.peek.classList.toggle('over', over);
      });
      renderResult(st);
    }

    function renderResult(st) {
      const p = abPlan;
      const cur = E().bdEffects();
      let changes = 0;
      let html = '<h4>推荐组合</h4><div class="ab-hint">优先级：' + esc((p.order || []).map(abLabel).join(' › ') || '（未启用属性）') + '</div>';
      D.ROD_PARTS.forEach(function (part) {
        const id = p.picks[part.key];
        const curId = st.bd[part.key] && st.bd[part.key].compId;
        const keep = !!id && id === curId;
        if (id && !keep) changes++;
        const meta = id ? itemMeta(id) : null;
        html += '<div class="ab-plan-row' + (keep ? ' keep' : '') + '">' +
          '<span class="abp-part">' + esc(part.name) + '</span>' +
          '<span class="abp-cur">' + esc(curId ? itemMeta(curId).name : part.default.name) + '</span>' +
          '<span class="abp-arrow">→</span>' +
          '<span class="abp-new ' + (meta ? qualityClass(meta) : '') + '">' + esc(meta ? meta.name : '（无可用组件 · 保持空置）') + '</span>' +
          '<span class="abp-tag">' + (keep ? '已装' : (id ? '替换' : '')) + '</span></div>';
      });
      html += '<h4>属性对比</h4>';
      const missed = [];
      D.AFFIX_TYPES.forEach(function (t) {
        const c0 = cur[t] || 0, c1 = p.vec[t] || 0;
        const d = c1 - c0;
        const tgt = (abMin[t] !== '' && abMin[t] != null) ? Number(abMin[t]) : null;
        const bad = tgt != null && c1 < tgt;
        if (bad) missed.push(t);
        html += '<div class="ab-diff-row">' +
          '<span class="abd-name">' + esc(abLabel(t)) + '</span>' +
          '<span class="abd-cur">' + abSigned(c0) + '</span>' +
          '<span class="abp-arrow">→</span>' +
          '<span class="abd-new ' + (d > 0 ? 'up' : (d < 0 ? 'down' : '')) + '">' + abSigned(c1) + '</span>' +
          '<span class="abd-delta">' + (d ? ((d > 0 ? '+' : '') + d) : '—') + '</span>' +
          '<span class="abd-tag">' + (tgt != null ? ('目标 ≥ ' + tgt + (bad ? ' ✗' : ' ✓')) : '') + '</span></div>';
      });
      if (missed.length) {
        html += '<div class="ab-warn">⚠ 目标配不出来：' + missed.map(function (t) {
          return esc(abLabel(t)) + ' 要求 ≥ ' + esc(String(abMin[t])) + '，现有组件最高只能到 ' + abSigned(Number(abPeek[t]) || 0);
        }).join('；') + '。可放宽目标，或先去市集收更好的组件。</div>';
      } else if (p.relaxed === 'max') {
        // 上限压得比「可达下限」还低（组件自带的最低值都超了）→ 说明白为什么忽略它；
        // 只是上下限互相矛盾（下限 > 上限）时才用通用文案。
        const tight = D.AFFIX_TYPES.filter(function (t) {
          return abMax[t] !== '' && abMax[t] != null && Number(abFloor[t]) > Number(abMax[t]);
        });
        html += tight.length
          ? '<div class="ab-warn">⚠ 上限设得比可达下限还低：' + tight.map(function (t) {
            return esc(abLabel(t)) + ' 最低也只能到 ' + abSigned(Number(abFloor[t]) || 0);
          }).join('；') + '，已忽略该上限。</div>'
          : '<div class="ab-warn">⚠ 上下限互相冲突，已忽略上限求最优组合。</div>';
      } else if (!changes) {
        html += '<div class="ab-ok">✅ 当前装配已经是该优先级下能配到的最优组合。</div>';
      } else {
        html += '<div class="ab-ok">✅ 按当前优先级与目标，共 ' + changes + ' 件可以换得更好。</div>';
      }
      resBox.innerHTML = html;
      applyBtn.disabled = !changes;
      applyBtn.textContent = changes ? ('一键装配（换 ' + changes + ' 件）') : '无需改动';
      applyHint.textContent = changes ? '' : '（改优先级或目标可换方案）';
    }

    // 逐个部位调用 /api/bd/set（服务器权威：校验部位匹配、背包持有、锁定与钓速即时生效）。
    // 每个部位各装各的，换下的组件原样退回背包，所以顺序执行不会互相干扰。
    function doApply() {
      const st = S();
      const todo = [];
      D.ROD_PARTS.forEach(function (part) {
        const id = abPlan && abPlan.picks[part.key];
        const curId = st.bd[part.key] && st.bd[part.key].compId;
        if (id && id !== curId) todo.push({ key: part.key, name: part.name, id: id, cur: curId });
      });
      if (!todo.length) { abBusy = false; toast('当前装配已经是最优组合，无需改动'); return; }
      let i = 0, done = 0;
      applyBtn.disabled = true;
      function step() {
        if (i >= todo.length) {
          abBusy = false;
          E().refreshEffects();
          renderTopbar(); renderView();
          abRefresh();
          toast('自动配装完成：已装 ' + done + ' 件，加成已在服务器生效');
          return;
        }
        const x = todo[i++];
        applyHint.textContent = '装配中 ' + i + '/' + todo.length + '…';
        window.Net.bdSet(x.key, x.id).then(function (r) {
          if (!r || !r.ok) {
            abBusy = false;
            toast((r && r.data && r.data.error) || '装配失败，已中止（前面的改动保留）');
            E().refreshEffects();
            renderTopbar(); renderView(); abRefresh();
            return;
          }
          const st2 = S();
          st2.bd = r.data.bd;
          if (r.data.inventory) applyInvFrom(r.data);
          if (r.data.castInfo) { st2.castInfo = r.data.castInfo; st2.fishingInterval = r.data.castInfo.interval; }
          if (r.data.rodSlots) st2.rodSlots = r.data.rodSlots;
          if (r.data.rodLocked) st2.rodLocked = r.data.rodLocked;
          if (r.data.rodActiveSlot !== undefined) st2.rodActiveSlot = r.data.rodActiveSlot;
          done++;
          step();
        }).catch(function () { abBusy = false; toast('网络错误，装配已中止'); });
      }
      step();
    }

    box.querySelector('.ab-reset').addEventListener('click', function () {
      D.AFFIX_TYPES.forEach(function (t) { abMin[t] = ''; abMax[t] = ''; abEnabled[t] = true; });
      abOrder = AB_PRIO_DEFAULT.slice();
      buildRows(); abRefresh();
    });
    // 装配前先对齐服务器装配（本地可能持有旧装配），再按最新方案落库；busy 防连点重复装配
    applyBtn.addEventListener('click', function () {
      if (abBusy) return;
      abBusy = true;
      syncProfile(doApply);
    });
    buildRows();
    abRefresh();      // 先用本地快照画一版（不等网络）
    syncProfile();    // 再对齐服务器后重绘
  }

  // 组件选择子窗口（模块级状态：筛选/排序在重绘间保留）
  // 两种模式共用同一个子页面：
  //   equip —— 钓竿页签「装备组件」：顶部显示当前已装备组件用于对比，卡片操作是「装备 / 出售 / 上架」
  //   pick  —— 工坊选主件/副件：顶部显示当前已选的组件，卡片操作只有「选择」，可限定部位
  let bdEquipPart = null;
  let compPickCtx = null;      // pick 模式的上下文 { title, note, part, pickLabel, exclude, getCurrent, onPick }
  let bdEquipFilter = 'all';
  let bdEquipFilterPart = '';
  let bdEquipSort = 'rarity';
  let bdEquipDir = 'desc';
  const BD_AFFIXES = [['speed', '⚡ 钓速'], ['skill', '🎯 技巧'], ['rare', '✨ 稀有'], ['material', '🧵 材料'], ['size', '📏 体型'], ['double', '🎣 双钓']];
  function partNameOf(key) {
    const p = D.ROD_PARTS.find(function (x) { return x.key === key; });
    return p ? p.name : key;
  }
  // 装备子页面：以弹窗形式展示该部位可装备的组件（筛选 / 排序 / 装备）
  function openBdEquipModal(partKey) { openCompPicker({ mode: 'equip', part: partKey }); }

  // opts（pick 模式）：{ title, note, part（限定部位，null = 全部部位）, pickLabel, exclude:[id…], getCurrent(), onPick(id) }
  function openCompPicker(opts) {
    const o = opts || {};
    const mode = o.mode === 'pick' ? 'pick' : 'equip';
    const wantPart = o.part || null;
    bdEquipPart = wantPart;
    // 每次打开都从「全部部位 / 全部属性」开始：筛选是模块级状态，若跨弹窗残留，
    // 换一个部位打开时列表会被上一个弹窗的部位/词条筛选整个滤空（表现为「组件都不见了」）。
    bdEquipFilterPart = '';
    bdEquipFilter = 'all';
    compPickCtx = (mode === 'pick') ? {
      title: o.title || '选择组件',
      note: o.note || '',
      part: wantPart,
      quality: o.quality || null,   // 只列出该品质（重铸用：只列宝匣产出的神话件）
      pickLabel: o.pickLabel || '选择',
      exclude: o.exclude || [],
      getCurrent: o.getCurrent || function () { return null; },
      onPick: o.onPick || function () {},
    } : null;
    const st = S();
    document.querySelectorAll('.modal-overlay').forEach(function (m) { m.remove(); });
    const overlay = el('div', 'modal-overlay');
    overlay.addEventListener('click', function (ev) { if (ev.target === overlay) closeBdEquipModal(); });
    const box = el('div', 'modal-box shop-modal bd-equip-modal');
    const title = mode === 'pick' ? ('🔧 ' + compPickCtx.title) : ('🎯 装备「' + partNameOf(wantPart) + '」组件');
    const note = mode === 'pick' ? compPickCtx.note : '装备会从背包取用 1 件（卸下时自动放回）';
    box.innerHTML = '<div class="modal-head"><span class="modal-title">' + esc(title) + '</span>' +
      '<button class="mini modal-close">✕ 关闭</button></div>' +
      '<div class="modal-body">' + (note ? '<div class="bde-note">' + esc(note) + '</div>' : '') +
      '<div id="bde-body"></div></div>';
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
            applyInvFrom(r.data); st.player.coins = r.data.coins; st.shop = r.data.shop;
            renderTopbar();
            if (bdEquipPart || compPickCtx) renderBody();
          }
        });
    }

    function renderBody() {
      const body = box.querySelector('#bde-body');
      if (!body) return;
      body.innerHTML = '';
      const pick = compPickCtx;
      const partKey = pick ? pick.part : bdEquipPart;
      // 顶部：当前对象（装备模式 = 已装备的组件；选择模式 = 已选中的组件）
      const currentId = pick ? pick.getCurrent() : (st.bd[partKey] && st.bd[partKey].compId);
      const cur0 = D.componentOf(currentId);
      const cur = el('div', 'bde-current' + (cur0 ? '' : ' empty'));
      if (cur0) {
        const curAffs = (cur0.affixes || []).map(function (a) {
          const rng = affixRangeIn(cur0, a);
          return affSpanOpen(a) + esc(affixText(a)) + '</span>' +
            (rng ? '<span class="aff-rng">（' + esc(rangeText({ min: rng[0], max: rng[1] })) + '%）</span>' : '');
        }).join(' ');
        cur.innerHTML = '<div class="bec-head"><span class="bec-label">' + (pick ? '已选' : '当前已装备') + '</span>' +
          '<img class="bec-icon" src="assets/item/' + esc(cur0.baseId || '') + '.png" alt="" draggable="false">' +
          '<b class="' + qualityClass(cur0) + '">' + esc(cur0.name) + '</b>' +
          itemTag(cur0) +
          '<span class="inst-meta">' + esc(partNameOf(cur0.part)) + ' · ' + esc(qualityName(cur0)) + '品质 · ' + cur0.affixes.length + '/' + cur0.maxAffixes + ' 词条</span>' +
          '<span class="bec-price">' + cur0.price + '💰</span></div>' +
          '<div class="bec-affs">' + (curAffs || '<span class="muted">无词条</span>') + '</div>' +
          '<div class="bec-tip">' + (pick
            ? '在下方换成其它组件，或直接关闭窗口保持当前选择。'
            : '对比下方组件决定是否替换：装备会消耗背包中的 1 件，被换下的旧组件自动放回背包。') + '</div>';
      } else {
        cur.innerHTML = '<div class="bec-head"><span class="bec-label">' + (pick ? '已选' : '当前已装备') + '</span><b class="muted">（' +
          (pick ? '尚未选择' : '该栏位为空') + '）</b></div>' +
          '<div class="bec-tip">' + (pick
            ? '在下方点「' + esc(pick.pickLabel) + '」选定。'
            : '下方是该栏位背包中的组件，点「装备」获得词缀加成。') + '</div>';
      }
      body.appendChild(cur);

      const owned = Object.keys(st.inventory)
        .map(function (id) { return { id: id, c: D.componentOf(id), n: st.inventory[id] }; })
        .filter(function (o2) {
          if (!o2.c || o2.n <= 0) return false;
          if (partKey && o2.c.part !== partKey) return false;
          if (pick && pick.quality && o2.c.quality !== pick.quality) return false;
          return true;
        });
      if (!owned.length) {
        const qn = pick && pick.quality ? ((D.QUALITY[pick.quality] || {}).name || pick.quality) : '';
        body.appendChild(el('div', 'hint', pick && pick.quality
          ? ('背包里没有「' + qn + '」品质的组件。' + qn + '是宝匣专属品质——只有海王遗匣开出来的组件才能重铸。')
          : (partKey ? ('背包暂无「' + partNameOf(partKey) + '」部位的组件。') : '背包里还没有可选的组件。')));
        return;
      }

      const ctr = el('div', 'bde-controls');
      // 部位筛选：仅在「未限定部位的选择模式」（工坊选主件）里出现
      const partFilterOn = !!(pick && !pick.part);   // 装备模式已按部位锁定，不能再套用上一个弹窗的部位筛选
      if (partFilterOn) {
        ctr.appendChild(el('span', 'bf-sort-label', '部位'));
        [['', '全部']].concat(D.ROD_PARTS.map(function (p) { return [p.key, p.name]; })).forEach(function (kv) {
          const b = el('button', 'bf-cat' + (bdEquipFilterPart === kv[0] ? ' on' : ''), kv[1]);
          b.addEventListener('click', function () { if (bdEquipFilterPart === kv[0]) return; bdEquipFilterPart = kv[0]; renderBody(); });
          ctr.appendChild(b);
        });
      }
      // 属性筛选 + 排序控件
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
        const nm = hit ? hit[1].replace(/^[^ ]+\s*/, '') : '属性值';
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
      let list = owned.filter(function (o2) {
        if (partFilterOn && bdEquipFilterPart && o2.c.part !== bdEquipFilterPart) return false;
        return bdEquipFilter === 'all' || o2.c.affixes.some(function (a) { return a.type === bdEquipFilter; });
      });
      const rank = { mythic: 4, epic: 3, rare: 2, common: 1 };
      const affVal = function (o2) {
        if (bdEquipFilter === 'all') return o2.c.affixes.reduce(function (s2, a) { return s2 + a.value; }, 0);
        const a = o2.c.affixes.find(function (x) { return x.type === bdEquipFilter; });
        return a ? a.value : 0;
      };
      list.sort(function (x, y) {
        if (bdEquipSort === 'price') return bdEquipDir === 'desc' ? y.c.price - x.c.price : x.c.price - y.c.price;
        if (bdEquipSort === 'affix') return bdEquipDir === 'desc' ? affVal(y) - affVal(x) : affVal(x) - affVal(y);
        const d = (rank[y.c.quality] || 0) - (rank[x.c.quality] || 0);
        return (bdEquipDir === 'desc' ? d : -d) || y.c.price - x.c.price;
      });
      const grid2 = el('div', 'bde-grid');
      if (!list.length) {
        // 有可用组件却被筛空时给出可操作提示：避免看起来像「组件不见了」（回归：跨弹窗残留的筛选）
        const tags = [];
        if (partFilterOn && bdEquipFilterPart) tags.push(partNameOf(bdEquipFilterPart));
        if (bdEquipFilter !== 'all') tags.push(affixName(bdEquipFilter));
        if (owned.length && tags.length) {
          grid2.appendChild(el('div', 'hint', '有 ' + owned.length + ' 件可用组件，但都被当前筛选（' +
            esc(tags.join(' / ')) + '）过滤掉了 —— 点「' + (partFilterOn && bdEquipFilterPart ? '全部' : '全部属性') +
            '」即可看到它们。'));
        } else {
          grid2.appendChild(el('div', 'hint', '没有符合筛选条件的组件。'));
        }
      } else {
        list.forEach(function (o2) {
          const c = o2.c;
          const card = el('div', 'bec-card');
          card.innerHTML =
            '<div class="bec-name"><img class="bec-icon" src="assets/item/' + esc(c.baseId || '') + '.png" alt="" draggable="false">' +
            '<span class="' + qualityClass(c) + '">' + esc(c.name) + itemTag(c) + '</span><span class="bec-price">' + c.price + '💰</span></div>' +
            '<div class="inst-meta">' + (partKey ? '' : esc(partNameOf(c.part)) + ' · ') + esc(qualityName(c)) + '品质 · ' + c.affixes.length + '/' + c.maxAffixes + ' 词条</div>' +
            c.affixes.map(function (a) { return '<div class="bec-aff' + (a.value < 0 ? ' aff-neg' : '') + (a.extra ? ' extra' : '') + affixKindCls(a) + '">' + esc(affixText(a)) + '</div>'; }).join('') +
            '<div class="bec-meta">持有 ×' + o2.n + '</div>';
          const acts = el('div', 'bec-acts');
          if (pick) {
            const excluded = pick.exclude.indexOf(o2.id) >= 0;
            const isCur = !!cur0 && cur0.id === o2.id;
            const use = el('button', 'mini primary-mini', isCur ? '已选' : (excluded ? '已被占用' : pick.pickLabel));
            if (isCur || excluded) { use.disabled = true; use.classList.add('locked'); }
            use.title = excluded ? '该组件已被另一端选中（同一件组件不能既是主件又是副件）' : '';
            use.addEventListener('click', function () { pick.onPick(o2.id); closeBdEquipModal(); });
            acts.appendChild(use);
          } else {
            const isOn = !!cur0 && cur0.id === o2.id;
            const use = el('button', 'mini primary-mini', isOn ? '已装备' : '装备');
            markFeature(use, 'bd.equip');
            if (isOn) { use.disabled = true; use.classList.add('locked'); }
            use.addEventListener('click', function () {
              closeBdEquipModal();
              setPart(partKey, o2.id);
            });
            acts.appendChild(use);
            // 直接出售（组件固定价，无需等行情）
            const sellBtn = el('button', 'mini', '出售 1');
            markFeature(sellBtn, 'mall.sell');
            sellBtn.title = '按系统固定价出售 1 个（组件不随市场浮动）';
            sellBtn.addEventListener('click', function () { sellFromEquip(o2.id); });
            acts.appendChild(sellBtn);
            // 上架：复用市集「上架」子窗口（数量/单价/时长/费率/走势一致）
            const listBtn = el('button', 'mini', '上架');
            markFeature(listBtn, 'mall.list');
            listBtn.title = '挂到开放市集（与市集「上架」同一子窗口：数量 / 单价 / 时长 / 费率）';
            listBtn.addEventListener('click', function () {
              openListModal(o2.id, function () { openBdEquipModal(partKey); });
            });
            acts.appendChild(listBtn);
          }
          card.appendChild(acts);
          grid2.appendChild(card);
        });
      }
      body.appendChild(grid2);
    }
  }
  function closeBdEquipModal() {
    bdEquipPart = null;
    compPickCtx = null;
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
          markFeature(b, 'bd.slots');
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
          markFeature(b, 'bd.save');
          b.title = '把当前装配的钓竿整体放进该槽位（配件随之锁定），仍可继续使用与改名';
          b.addEventListener('click', function () {
            const parts = Object.keys(st.bd || {}).filter(function (k) { return st.bd[k] && st.bd[k].compId; });
            if (!parts.length) { toast('当前钓竿还没有装配任何组件'); return; }
            promptModal({ title: '保存钓竿到槽位 ' + (i + 1), numeric: false, value: st.rodName || '', okText: '保存', html: '<div class="cf-hint">给这根钓竿起个名字（最多 12 字）。保存后它占用该槽位，配件被锁定，可随时改名或切换。</div>' }).then(function (name) {
              if (name == null) return;
              call(window.Net.rodSave(i, name), '已占用槽位 ' + (i + 1) + '（配件已锁定，可继续使用）').then(function (r) {
                if (r && r.ok) { st.bd = r.data.bd; st.rodName = r.data.rodName; st.rodActiveSlot = r.data.rodActiveSlot; st.rodSlots = r.data.rodSlots; st.rodLocked = r.data.rodLocked; if (r.data.inventory) applyInvFrom(r.data); E().refreshEffects(); renderTopbar(); renderView(); }
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
                st.rodLocked = r.data.rodLocked || {}; if (r.data.inventory) applyInvFrom(r.data);
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
        markFeature(sell, 'mall.list');
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
                  if (r.data.inventory) applyInvFrom(r.data);
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
                if (r.data.inventory) applyInvFrom(r.data);
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
    panel.innerHTML = pageHead('🎣', '钓鱼', '选钓点即自动垂钓 · 配装与存档在「钓竿」页签') +
      sectionTabsHtml('fishing', 'rod', [['fishing', '🎣 钓鱼'], ['rod', '🎯 钓竿']]) +
      pageHelp('装上组件即可拿到词缀加成（正在钓鱼也会立即生效）。最多保存 8 套钓竿方案，随时一键切换。') +
      '<h3>🎯 钓竿 · 配装与方案</h3>';
    bindSectionTabs(panel, 'fishing');
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

    // 配装器入口：从背包检索各部位候选件，按属性优先级与目标区间求最优组合，可一键装配
    const autoBar = el('div', 'bd-auto-bar');
    const abBtn = el('button', 'primary ab-open-btn', '🧠 自动配装 · 配装器');
    abBtn.title = '从背包检索 7 个部位的组件，按优先级（如先钓速、再双钓）求总属性最高的组合；' +
      '可设目标下限/上限，并用滑块反查「钓速定到多少时其他属性还能到多少」';
    abBtn.addEventListener('click', autoBuildOpen);
    autoBar.appendChild(abBtn);
    autoBar.appendChild(el('span', 'hint',
      '一键把 7 个部位换成目标属性最高的组合 · 可拖优先级与目标值 · 只换配件、不会自动卸下'));
    panel.appendChild(autoBar);

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
        markFeature(btn, 'bd.equip');
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

  // ---- 社交视图（全服概览 + 单地图点击查看） ----
  // 当前筛选的地图（null = 全服；模块级：重绘间保留）
  let groundFilterId = null;
  // perf-9：玩家列表搜索/翻页状态（服务端分页，一次最多渲染一页；列表限高可下滑，避免页面被拉长）
  const PEEP_PAGE_SIZE = 20;
  let peepSearchQ = '';        // 已生效的关键词（服务端按它过滤）
  let peepSearchDraft = '';    // 输入框里的原文：重绘很频繁，草稿必须留在状态里，否则打到一半的字会被重建冲掉
  let peepSearchCaret = 0;     // 光标位置（重建后还回去）
  let peepSearchTimer = null;
  let peepComposing = false;   // 中文输入法合成中：这一小段时间挂起重绘，否则候选词会被打断

  // ---- 数据广播的就地更新工具（社交 / 以后新增页面共用） ----
  // 就地更新带 key 的列表：已有节点原地改内容，保住节点身份、事件与**父容器的滚动位置**；
  // 只有「新增 / 删除 / 换序」才真的插删 DOM。广播到达时必须走这条路——整块重建会把
  // 用户滚到的位置、正在点的那一行、输入法候选一起冲掉。
  // update 返回新节点 = 该行必须换节点（结构变了），调用方按返回值继续用。
  function patchList(container, items, keyOf, create, update) {
    const have = Object.create(null);
    Array.prototype.slice.call(container.childNodes).forEach(function (n) {
      const k = n.getAttribute ? n.getAttribute('data-key') : null;
      if (k != null) have[k] = n;
    });
    const keep = Object.create(null);
    let prev = null;
    items.forEach(function (it) {
      const k = String(keyOf(it));
      keep[k] = 1;
      let node = have[k];
      if (node) node = update(node, it) || node;
      else { node = create(it); node.setAttribute('data-key', k); }
      const want = prev ? prev.nextSibling : container.firstChild;
      if (node !== want) container.insertBefore(node, want);
      prev = node;
    });
    Object.keys(have).forEach(function (k) { if (!keep[k]) container.removeChild(have[k]); });
  }

  // 视口登记：只在进入本页/翻页/搜索/切换钓场时发一次（playersPage 推送引发的更新不重复登记），
  // 之后服务器每秒只推当前页玩家状态
  function peepViewSigOf(page) {
    return [page || 1, PEEP_PAGE_SIZE, peepSearchQ, groundFilterId || ''].join('|');
  }
  function gotoPeepPage(n) {
    peepSearchQ = peepSearchQ || '';
    renderGround._lastViewSig = peepViewSigOf(n);   // 乐观登记：fetch 回来若被服务端夹页，syncPeepView 会再登记一次
    window.Net.fetchPlayersPage({ page: n, size: PEEP_PAGE_SIZE, q: peepSearchQ, ground: groundFilterId });
    window.Net.setPlayersView({ page: n, size: PEEP_PAGE_SIZE, q: peepSearchQ, ground: groundFilterId });
  }
  function syncPeepView() {
    const page = (S().playersPage && S().playersPage.page) || 1;
    const sig = peepViewSigOf(page);
    if (renderGround._lastViewSig === sig) return;
    renderGround._lastViewSig = sig;
    window.Net.setPlayersView({ page: page, size: PEEP_PAGE_SIZE, q: peepSearchQ, ground: groundFilterId });
  }

  // 地图概览：只改人数与状态类，节点原地保留（正在点的那张卡片不会被广播换掉）
  const TOTAL_GC = { id: '__total__', total: true };
  function gcBuffCount(g) { return (g.spots || []).filter(function (sp) { return sp.buffs && sp.buffs.length; }).length; }
  function paintGroundCountBox(box, g) {
    const c = g.total ? (S().onlineTotal || 0) : ((S().groundCounts && S().groundCounts[g.id]) || 0);
    const num = box.querySelector('.gcb-n');
    if (num && num.textContent !== String(c)) num.textContent = c;
    const cls = 'gc-box' + (g.total ? ' total' : '') + (g.locked ? ' locked' : '') +
      (g.total ? '' : (c > 0 ? ' live' : '')) +
      ((g.total ? !groundFilterId : groundFilterId === g.id) ? ' sel' : '') +
      (gcBuffCount(g) ? ' has-buff' : '');
    if (box.className !== cls) box.className = cls;
  }
  function groundCountBox(g) {
    const box = el('div', 'gc-box');
    box.setAttribute('data-gid', g.id);
    if (g.total) {
      box.innerHTML = '<div class="gcb-name">🌐 全服在线</div><div class="gcb-num"><span class="gcb-n">0</span><span class="u">人</span></div>';
      box.title = '点击返回全服动态';
      box.addEventListener('click', function () { if (groundFilterId) { groundFilterId = null; gotoPeepPage(1); renderView(); } });
    } else {
      const buffCount = gcBuffCount(g);
      box.innerHTML = '<div class="gcb-name">' + esc(g.name) + (buffCount ? ' <span class="spot-buff-mark" title="有 ' + buffCount + ' 个钓点带增益">⚡</span>' : '') + '</div>' +
        '<div class="gcb-num"><span class="gcb-n">0</span><span class="u">人</span></div>' +
        (g.locked ? '' : '<div class="gcb-hint">' + (buffCount ? '⚡ ' + buffCount + ' 个钓点有增益' : '点击查看') + '</div>');
      if (!g.locked) {
        box.title = '点击查看「' + g.name + '」的动态' + (buffCount ? '（⚡ ' + buffCount + ' 个钓点有增益）' : '');
        box.addEventListener('click', function () { groundFilterId = (groundFilterId === g.id) ? null : g.id; gotoPeepPage(1); renderView(); });
      }
    }
    paintGroundCountBox(box, g);
    return box;
  }
  function fillGroundCounts(panel) {
    const host = panel.querySelector('[data-region="gcounts"]');
    if (!host) return;
    const items = D.GROUNDS.concat([TOTAL_GC]);
    patchList(host, items, function (g) { return g.id; },
      function (g) { return groundCountBox(g); },
      function (node, g) { paintGroundCountBox(node, g); });
  }

  // 玩家卡片的信息块（名字 / 在线状态点 / 位置 / 近期渔获）：与卡片骨架分开，
  // 广播只重写这一块，右部的「🤝 交易 / 🔍 查看」按钮原地不动。
  function peepInfoHtml(b) {
    const st = S();
    const isSelf = st.me && b.id === st.me.id;
    const g = D.GROUNDS.find(function (x) { return x.id === b.groundId; });
    const sp = g && g.spots.find(function (x) { return x.id === b.spotId; });
    const recent = b.recent; // 近期渔获由服务器 presence 维护，前端只展示
    return '<div class="peep-name">' + esc(b.name || '玩家') + (isSelf ? '（你）' : '') +
      ' <span class="dot ' + (b.status === 'fishing' ? 'on' : 'idle') + '"></span></div>' +
      '<div class="peep-loc">' + (g ? esc(g.name) : '未出发') + (sp ? '·' + esc(sp.name) : '') + '</div>' +
      (recent ? '<div class="peep-recent">近期：' + esc(recent) + '</div>' : '');
  }
  function updatePeepCard(card, b) {
    const info = card.querySelector('.peep-info');
    if (!info) return null;
    const isSelf = !!(S().me && b.id === S().me.id);
    // 「是不是自己」变了（登录 / 切换账号）会增减右部按钮块，这种情况只能换整张卡
    if (!isSelf !== !!card.querySelector('.peep-acts')) return peepCard(b);
    const html = peepInfoHtml(b);
    if (info.innerHTML !== html) info.innerHTML = html;
    if (card.classList.contains('self') !== isSelf) card.classList.toggle('self', isSelf);
    return null;
  }
  // 玩家列表：按 id 就地增删改。搜索 / 翻页只是换整页内容，容器与滚动条仍不重建。
  function fillPeepList(panel) {
    const host = panel.querySelector('[data-region="peeps"]');
    if (!host) return;
    const vp = S().playersPage || { page: 1, pages: 1, total: 0, list: [] };
    const list = vp.list || [];
    const hintText = vp.total || peepSearchQ ? '没有匹配的玩家。' : (groundFilterId ? '该地图暂无玩家。' : '暂无在线玩家。');
    const items = list.length ? list : [{ id: '__hint__', hint: hintText }];
    patchList(host, items, function (b) { return b.id; },
      function (b) { return b.hint ? el('div', 'hint', b.hint) : peepCard(b); },
      function (node, b) {
        if (b.hint) { if (node.textContent !== b.hint) node.textContent = b.hint; return null; }
        return updatePeepCard(node, b);
      });
  }
  function fillPeepHeadFoot(panel) {
    const vp = S().playersPage || { page: 1, pages: 1, total: 0, list: [] };
    const head = panel.querySelector('[data-region="peep-head"]');
    if (head) {
      const t = '👥 ' + (groundFilterId ? '本地图在线玩家（' + vp.total + '）'
        : '在线玩家（' + vp.total + ' / 全服 ' + (S().onlineTotal || 0) + '）');
      if (head.textContent !== t) head.textContent = t;
    }
    const foot = panel.querySelector('[data-region="peep-foot"]');
    if (foot) {
      const t = vp.pages > 1
        ? '本页 ' + vp.list.length + ' 人 · 列表可下滑查看 · 共 ' + vp.pages + ' 页（每页 ' + PEEP_PAGE_SIZE + ' 人）'
        : '共 ' + vp.list.length + ' 人' + (vp.list.length > 6 ? ' · 列表可下滑查看' : '');
      if (foot.textContent !== t) foot.textContent = t;
    }
    const pager = panel.querySelector('[data-region="peep-pager"]');
    if (pager) {
      const prev = pager.querySelector('[data-pg="prev"]');
      const next = pager.querySelector('[data-pg="next"]');
      const label = pager.querySelector('.muted');
      if (prev) prev.disabled = vp.page <= 1;
      if (next) next.disabled = vp.page >= vp.pages;
      if (label) label.textContent = ' 第 ' + vp.page + ' / ' + vp.pages + ' 页 ';
    }
    syncPeepView();
  }

  // 动态流：上鱼只往头部插新行（旧行原地不动）→ 用户滚下去看历史时不会被弹回顶部，
  // 也没有「每钓一条鱼重建 60 个 DOM 节点」的开销。过滤/换钓场对不上时才整块重铺。
  function feedKey(e) {
    const it = e.item || {};
    return [e.t, e.who, e.ground, e.spot, it.id, e.size].join('|');
  }
  function feedLineNode(e) {
    const meta = e.item || {};
    const line = el('div', 'feed-line' + (e.record ? ' record' : ''));
    line.innerHTML = '<span class="ftime">' + timeStr(e.t) + '</span> <b>' + esc(e.who) + '</b> 在 ' +
      esc(e.ground) + '·' + esc(e.spot) + ' 钓到 <span class="' + qualityClass(meta) + '">' + esc(meta.name) + '</span>' +
      (e.size ? ' <span class="muted">' + e.size + 'cm</span>' : '') +
      (e.record ? ' 🏆刷新纪录' : meta.rarity === 'epic' ? ' 💎史诗' : meta.rarity === 'rare' ? ' ✨稀有' : meta.kind === 'component' ? ' 🔧组件' : '');
    return line;
  }
  function fillGroundFeed(panel) {
    const host = panel.querySelector('[data-region="gfeed"]');
    if (!host) return;
    const st = S();
    const filterGround = groundFilterId ? D.GROUNDS.find(function (g) { return g.id === groundFilterId; }) : null;
    const all = st.feed || [];
    const shown = (filterGround ? all.filter(function (e) { return e.ground === filterGround.name; }) : all).slice(0, 60);
    const keys = shown.map(feedKey);
    const old = host._feedKeys;
    // 旧序列一定是新序列「从某一位起」的连续前缀（feed 只从头部插入）→ 前面多出来的就是新渔获
    let head = -1;
    if (old && old.length) {
      for (let i = 0; i < keys.length && head < 0; i++) {
        if (keys[i] !== old[0]) continue;
        const n = Math.min(old.length, keys.length - i);
        let ok = true;
        for (let j = 0; j < n; j++) { if (keys[i + j] !== old[j]) { ok = false; break; } }
        if (ok) head = i;
      }
    }
    if (head < 0) {
      host.innerHTML = '';
      if (!shown.length) host.appendChild(el('div', 'hint', filterGround ? '该地图暂无动态，等待大家上鱼……' : '暂无动态，等待大家上鱼……'));
      shown.forEach(function (e) { host.appendChild(feedLineNode(e)); });
    } else if (head > 0) {
      const hint = host.querySelector('.hint');
      if (hint) hint.remove();
      const frag = document.createDocumentFragment();
      for (let i = 0; i < head; i++) frag.appendChild(feedLineNode(shown[i]));
      host.insertBefore(frag, host.firstChild);
    }
    // 尾部只留与 S.feed 同样多的行（客户端 feed 上限 60）
    let lines = host.querySelectorAll('.feed-line').length;
    while (lines > shown.length && host.lastChild) { host.removeChild(host.lastChild); lines--; }
    host._feedKeys = keys;
  }

  // 结构签名：只有它变了才允许重建骨架——换钓场 / 翻页 / 改搜索词 / 后台改渔场配置。
  // 上鱼播报、玩家状态、地图人数都不在里面，所以它们永远走不到重建那条路。
  function groundCfgSig() {
    const parts = [];
    D.GROUNDS.forEach(function (g) {
      parts.push(g.id + ':' + g.name + ':' + (g.locked ? 'L' : '') + ':' + (g.type || ''));
      (g.spots || []).forEach(function (sp) {
        parts.push(sp.id + ':' + sp.name + ':' + (sp.buffs || []).map(function (b) { return b.type + b.value; }).join('+'));
      });
    });
    return parts.join('|');
  }
  function groundSig(st) {
    const vp = st.playersPage || {};
    return [groundFilterId || '', vp.page || 1, peepSearchQ, groundCfgSig()].join('|');
  }

  // 数据广播（上鱼 feed / 玩家状态 players / 地图人数 grounds）到达时的就地更新入口：
  // 只改内容，不重建骨架（.peeps 的滚动位置与搜索框的焦点都在这里面被保住）。
  function groundLivePatch() {
    const main = $('main');
    const panel = main && main.querySelector('.ground-panel');
    if (!panel) return false;
    fillGroundCounts(panel);
    fillPeepList(panel);
    fillPeepHeadFoot(panel);
    fillGroundFeed(panel);
    return true;
  }

  function renderGround() {
    const main = $('main');
    const st = S();
    const sig = groundSig(st);
    const host = main.querySelector('.ground-panel');
    // 结构没变（只是上鱼 / 玩家状态 / 人数变化）→ 就地增量更新：
    // 这个面板带搜索框、分页与独立滚动条，整页重建会把滚动位置与正在读的列表一起冲掉。
    if (host && host.getAttribute('data-sig') === sig) { groundLivePatch(); return; }
    // 重建前先把「搜索框是否正被编辑 / 光标在哪 / 打到一半的字」记下来：
    // main.innerHTML='' 会把聚焦元素一并删除并触发它的 blur，所以「用户自己点走了」和
    // 「我们自己把它删了」只能靠重建前的 activeElement 区分，光靠 focus/blur 事件分不清。
    const focusEl = document.activeElement;
    const searchHadFocus = !!(focusEl && focusEl.classList && focusEl.classList.contains('peep-search-input'));
    if (searchHadFocus) {
      peepSearchDraft = focusEl.value;
      try { peepSearchCaret = focusEl.selectionStart || 0; } catch (e) {}
    }
    main.innerHTML = '';
    const panel = el('div', 'panel wide ground-panel');
    panel.setAttribute('data-sig', sig);   // 下次广播到达时按它判断「能不能就地更新」
    const filterGround = groundFilterId ? D.GROUNDS.find(function (g) { return g.id === groundFilterId; }) : null;
    panel.innerHTML = pageHead('🌊', '社交', '在线玩家 · 各钓场人数 · 实时渔获；玩家之间可直接交易') +
      pageHelp('点钓场卡片只看该钓场，点「🌐 返回全服」看全体；点玩家卡片上的「🤝 交易」即可发起以物易物。') +
      '<h3>' + (filterGround ? esc(filterGround.name) + ' · 实时动态' : '全服实时动态') + '</h3>';
    if (groundFilterId) {
      const back = el('button', 'mini ground-back', '🌐 返回全服');
      back.addEventListener('click', function () { groundFilterId = null; gotoPeepPage(1); renderView(); });
      panel.appendChild(back);
    }

    // 地图概览：点击进入单地图动态（人数变化走 fillGroundCounts 就地更新，不重建卡片）
    const counts = el('div', 'ground-counts');
    counts.setAttribute('data-region', 'gcounts');
    panel.appendChild(counts);

    // perf-9：玩家列表改为服务端分页（一次只渲染一页，不超过页面高度）+ 搜索；
    // 当前页玩家的状态更新由服务器按视口每秒推送（playersPage），不再全量下发在线列表。
    const cols = el('div', 'ground-cols');
    const left = el('div', 'sub');
    const head = el('h3');
    head.setAttribute('data-region', 'peep-head');
    left.appendChild(head);
    const searchBar = el('div', 'peep-search');
    const searchInput = el('input', 'peep-search-input');
    searchInput.type = 'text';
    searchInput.placeholder = '🔍 输入玩家名即时筛选…';
    searchInput.value = peepSearchDraft;   // 草稿而不是已生效词：多打一个字母不会因为中途重绘被吃掉
    // 注意：这里不挂 focus/blur 维护「是否聚焦」——重建删掉聚焦元素时浏览器也会发 blur，
    // 那会把标记清成 false，导致下面的焦点还回逻辑失效（打字打到一半就断）。
    // 是否还回焦点一律以 renderGround 开头记录的 searchHadFocus 为准。
    // 记住光标：只有结构重建（换钓场/翻页）才会走到这里，数据广播已改成就地更新，不碰输入框
    function rememberCaret() { try { peepSearchCaret = searchInput.selectionStart || 0; } catch (e) {} }
    // 输入即筛选（与后台「账号管理」一致，不再需要回车）：防抖 250ms 后按新关键词重取第一页
    function applyPeepSearch() {
      const q = peepSearchDraft.trim();
      if (q === peepSearchQ) return;
      peepSearchQ = q;
      gotoPeepPage(1);
    }
    searchInput.addEventListener('compositionstart', function () { peepComposing = true; });
    searchInput.addEventListener('compositionend', function () {
      peepComposing = false;
      peepSearchDraft = searchInput.value; rememberCaret();
      if (peepSearchTimer) clearTimeout(peepSearchTimer);
      peepSearchTimer = setTimeout(applyPeepSearch, 250);
    });
    searchInput.addEventListener('input', function (ev) {
      peepSearchDraft = searchInput.value; rememberCaret();
      // 输入法合成中的中间态（拼音串）不触发请求，否则会按拼音去搜
      if (peepComposing || ev.isComposing) return;
      if (peepSearchTimer) clearTimeout(peepSearchTimer);
      peepSearchTimer = setTimeout(applyPeepSearch, 250);
    });
    searchInput.addEventListener('keyup', rememberCaret);
    searchInput.addEventListener('keydown', function (ev) {
      if (ev.key !== 'Enter') return;
      if (peepSearchTimer) { clearTimeout(peepSearchTimer); peepSearchTimer = null; }
      peepSearchDraft = searchInput.value;
      applyPeepSearch();
    });
    searchBar.appendChild(searchInput);
    left.appendChild(searchBar);
    // 限高滚动：只铺一页，超出的下滑查看，避免在线人数多时把整页拉长
    const list = el('div', 'peeps scroll5');
    list.setAttribute('data-region', 'peeps');
    left.appendChild(list);
    const foot = el('div', 'peeps-head');
    foot.setAttribute('data-region', 'peep-foot');
    left.appendChild(foot);
    const pager = el('div', 'peep-pager');
    pager.setAttribute('data-region', 'peep-pager');
    const prevBtn = el('button', 'mini', '‹ 上一页');
    prevBtn.setAttribute('data-pg', 'prev');
    // 页码现读：就地更新后这里的快照会过期，闭包里绝不能存页码
    prevBtn.addEventListener('click', function () { gotoPeepPage(((S().playersPage || {}).page || 1) - 1); });
    pager.appendChild(prevBtn);
    pager.appendChild(el('span', 'muted', ''));
    const nextBtn = el('button', 'mini', '下一页 ›');
    nextBtn.setAttribute('data-pg', 'next');
    nextBtn.addEventListener('click', function () { gotoPeepPage(((S().playersPage || {}).page || 1) + 1); });
    pager.appendChild(nextBtn);
    left.appendChild(pager);
    cols.appendChild(left);

    const right = el('div', 'sub');
    right.appendChild(el('h3', null, '📡 最新动态' + (groundFilterId ? ' · ' + esc(filterGround.name) : '')));
    const feed = el('div', 'feed feed-big');
    feed.setAttribute('data-region', 'gfeed');
    right.appendChild(feed);
    cols.appendChild(right);
    panel.appendChild(cols);
    main.appendChild(panel);
    // 首次铺内容：与广播触发的就地更新共用同一套填充函数，两条路渲染出的 DOM 必须一样
    fillGroundCounts(panel);
    fillPeepList(panel);
    fillPeepHeadFoot(panel);   // 顺带做视口登记（含去重）
    fillGroundFeed(panel);
    // 焦点还回搜索框必须放在**面板挂进文档之后**：对游离节点调 focus() 是空操作，
    // 放前面会让焦点直接掉到 body，下一个字就打不进去了。
    if (searchHadFocus) {
      searchInput.focus();
      try { searchInput.setSelectionRange(peepSearchCaret, peepSearchCaret); } catch (e) {}
    } else {
      peepComposing = false; // 合成中被打断（元素被删）时 compositionend 不会来，标记要能自愈
    }
  }

  // ---- 系统商店视图 ----
  // 商品详情弹窗：固定居中子窗口，独立于页面重绘流程（广播只更新数据不重建窗口）
  let shopModalId = null;
  // 出售数量：对整个系统商店生效，直到下一次被修改（模块级，重绘与切换页面都保留）
  let sellQty = 1;
  let shopAuto = { loaded: false, items: {}, batch: 0, tier: false }; // 自动售出规则（来自服务器）：items=逐物品规则；batch=全服打包阈值；tier=体型档是否参与
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
    const isRod0 = !!(rodInfo && rodInfo.rodSlot != null);
    // v0.14.0：鱼类暂时不能上市集（见顶部 MARKET_FISH_LIST）——入口已经隐掉，这里再兜一道，
    // 免得旧页面 / 快捷路径绕过 UI 直接开窗（服务端也会拒，但让玩家少一次白填参数）
    if (!isRod0 && !MARKET_FISH_LIST && itemMeta(id).kind === 'fish') {
      toast('鱼类暂时不能上市集（改版中）：请在「商城 · 收购」出售，大型/巨型鱼可按档位卖（另有加成）', true);
      return;
    }
    // 悬空引用检测：物品可能刚被卖掉 / 熔炼掉 / 交易走，不能再挂单（否则填完参数才被服务器拒绝）
    if (!isRod0 && availCountOf(id) <= 0) {
      const total0 = S().inventory[id] || 0;
      toast(total0 > 0
        ? '「' + itemMeta(id).name + '」的可上架数量为 0（' + reservedCountOf(id) + ' 条是大型/巨型预留，普通通道不能上架）'
        : '背包里已经没有「' + itemMeta(id).name + '」了');
      return;
    }
    listModalId = id;
    const st = S();
    const meta = itemMeta(id);
    const isRod = !!(rodInfo && rodInfo.rodSlot != null);
    // v0.13.9：上架走普通通道，服务端按可用量校验 —— 数量上限必须用可用量（此前用总量，必然被拒）
    const total = isRod ? 1 : (st.inventory[id] || 0);
    const have = isRod ? 1 : availCountOf(id);
    // 挂单上限提示（上限由后台按账号设置：默认 40，0 = 不限；后台批量上架也会占用这个额度）
    const capRaw = Number(st && st.me ? st.me.listingCap : NaN);
    const myCap = isFinite(capRaw) && capRaw > 0 ? capRaw : 0;
    let capHint = '';
    if (myCap) {
      const used = (st.market || []).filter(function (l) {
        return st.me && st.me.id != null && String(l.seller).toLowerCase() === String(st.me.id).toLowerCase();
      }).length;
      const full = used >= myCap;
      capHint = '<div class="hint" style="margin-top:6px' + (full ? ';color:var(--bad)' : '') + '">你的挂单 ' + used + ' / 上限 ' + myCap +
        (full ? '（已达上限，先下架一些再上架）' : '') + '</div>';
    }
    document.querySelectorAll('.modal-overlay').forEach(function (m) { m.remove(); });
    const overlay = el('div', 'modal-overlay');
    overlay.addEventListener('click', function (ev) { if (ev.target === overlay) closeListModal(); });
    const box = el('div', 'modal-box shop-modal');
    box.innerHTML =
      '<div class="modal-head"><span class="modal-title">🏷️ 上架 ' + esc(isRod ? (rodInfo.name ? rodInfo.name + ' · 整根钓竿' : '整根钓竿') : meta.name) + (isRod ? '（' + rodInfo.count + ' 件组件）' : '（可用 ' + have + (total > have ? ' / 持有 ' + total : '') + '）') + '</span><button class="mini modal-close">✕ 关闭</button></div>' +
      '<div class="modal-body">' +
      (isRod ? '<div class="lm-rod">' + rodAffixBadges(rodInfo.affixes) + '</div><div class="hint" style="margin-bottom:8px">整根钓竿按 1 件整体出售，组件随竿交给买家（买家收到的是背包中的组件，可自行组装）。</div>' : '') +
      (!isRod && total > have ? '<div class="hint" style="margin-bottom:8px">其中 <b>' + (total - have) + '</b> 条是大型/巨型预留，普通上架动不了（要卖请到背包按体型档行出售）。</div>' : '') +
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
      capHint +
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
          if (r.data.inventory) applyInvFrom(r.data);
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
        t.appendChild(buildPriceChart(pts, meta.price));
        t.appendChild(el('div', 'sd-legend', '系统收购价近 ' + recentLen(pts) + ' 分钟走势 · 红=不低于基准 · 蓝=低于基准 · 悬停柱子看价格与时间'));
      } else {
        t.appendChild(el('div', 'sd-legend', '暂无足够价格采样（服务器每分钟记录一次）。'));
      }
    });
  }
  function recentLen(pts) { return pts.length; }

  // v0.14.0：价格走势图统一带数值 —— 每根柱子悬停给「时间 · 价格（相对基准 ±X%）」，
  // 左侧标出本段最高 / 最低价刻度，下方标出起止时间与基准价。
  // 上架弹窗 / 商店详情 / 批量出售三处共用（此前各画一套，柱子上没有任何数值）。
  function priceTipText(pt, base) {
    const d = pt.p - base;
    const rel = base ? '（' + (d === 0 ? '与基准持平' : (d > 0 ? '+' : '') + (Math.round(d / base * 1000) / 10) + '%）') : '';
    return dateTimeStr(pt.t) + ' · ' + pt.p + '💰' + rel;
  }
  function buildPriceChart(pts, base) {
    const prices = pts.map(function (x) { return x.p; }).concat([base]);
    const maxP = Math.max.apply(null, prices), minP = Math.min.apply(null, prices);
    const box = el('div', 'sd-chart-box');
    const chart = el('div', 'sd-chart');
    chart.innerHTML = '<div class="sd-yaxis"><span>' + maxP + '💰</span><span>' + minP + '💰</span></div>';
    const spark = el('div', 'sd-spark');
    pts.forEach(function (pt) {
      const h = maxP === minP ? 50 : Math.round(10 + 90 * (pt.p - minP) / (maxP - minP));
      const bar = el('i', pt.p >= base ? 'up' : 'down');
      bar.style.height = h + '%';
      bar.title = priceTipText(pt, base);
      spark.appendChild(bar);
    });
    chart.appendChild(spark);
    box.appendChild(chart);
    box.appendChild(el('div', 'sd-xaxis',
      '<span>' + timeStr(pts[0].t) + '</span>' +
      '<span class="sd-xmid">基准 ' + base + '💰 · 本段最高 ' + maxP + '💰 · 最低 ' + minP + '💰</span>' +
      '<span>' + timeStr(pts[pts.length - 1].t) + '</span>'));
    return box;
  }
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
        body.appendChild(buildPriceChart(pts, d.base));
        const spanMin = Math.max(1, Math.round((pts[pts.length - 1].t - pts[0].t) / 60000));
        const sampleSec = (S() && S().priceCfg && S().priceCfg.sampleSec) || 60;
        body.appendChild(el('div', 'sd-legend', '近 ' + spanMin + ' 分钟（每 ' + sampleSec + ' 秒一采样，共 ' + pts.length + ' 个采样点） · 红=不低于基准 · 蓝=低于基准 · 悬停柱子看该点的价格与时间'));
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
    return '价格随供需浮动 · 每卖一件约 -' + fmtPct + '% · 闲置约 ' + tauText + ' 回到 ' + targetX + ' 倍基准价';
  }

  function renderShop() {
    if (featureBlocked('mall')) return renderView();
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
        if (r && r.ok) { shopAuto.loaded = true; shopAuto.items = r.data.items || {}; shopAuto.batch = Number(r.data.batch) || 0; shopAuto.tier = !!r.data.tier; }
        if (inShopView()) renderShop();
      }).catch(function () {});
      return;
    }
    // 骨架只在进入视图时建一次；上鱼/行情广播（shop/assets）只刷新网格与右栏列表，
    // 自动售出面板的输入框不再被广播清掉（此前与「后台输入被自动刷新清空」同源的老毛病）。
    if (!document.querySelector('#shop-panel .shop-grid')) {
      const panel = el('div', 'panel wide');
      panel.id = 'shop-panel';
      panel.innerHTML = '<h2>🪙 收购 <span class="subtitle" id="shop-sub">' + shopSubtitle() + '</span></h2>' + mallTabsHtml('shop');
      bindMallTabs(panel);
      panel.appendChild(el('div', 'hint page-help',
        '按现价把渔获与材料卖给系统：卖得越多价格越低（后台可调）。左上「出售数量」对全商店生效，卡片上的按钮按该数量结算。'));
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

      // —— 右栏：自动售出（骨架只建一次；逐项控制都在弹窗子菜单里）——
      const colSide = el('div', 'shop-colside');
      const asPanel = el('div', 'shop-autosell');
      asPanel.id = 'shop-as-panel';
      asPanel.innerHTML =
        '<div class="sa-head"><b>🤖 自动售出</b></div>' +
        '<div class="hint" style="margin-bottom:8px">点下面的按钮打开<b>清单子窗口</b>，逐条勾选要自动卖的渔获 / 材料，每条都能单独设价格线与保留数量。可卖余量（持有 − 保留）攒够 <b id="sa-batch">' + autoSellBatch() + '</b> 条才打包成交一次（阈值由后台设置），一次推送结算全部物品；价格线两条都留空 = 不看价格。</div>' +
        '<div class="sa-row"><button class="btn primary" id="sa-open-list">📋 打开自动售出清单</button></div>' +
        '<label class="sa-tier-switch"><input type="checkbox" id="sa-tier"' + (autoSellTierOn() ? ' checked' : '') + ' /> ' +
        '体型档也自动售出（大型 +50% / 巨型 +150%）</label>' +
        '<div class="hint" style="margin:-2px 0 8px 22px">默认关闭＝只卖普通量、大鱼留着。开启后按「普通量 → 大型 → 巨型」的顺序动用，' +
        '加成照算；关闭时大型/巨型鱼不参与自动售出（仍可手动按档位卖）。</div>' +
        '<div id="sa-state" class="hint" style="margin-top:6px"></div>' +
        '<div id="sa-enabled" class="sa-enabled"></div>';
      colSide.appendChild(asPanel);
      cols.appendChild(colMain);
      cols.appendChild(colSide);
      panel.appendChild(cols);
      main.innerHTML = '';
      main.appendChild(panel);

      // —— 事件绑定（骨架一次，随骨架存活）——
      asPanel.querySelector('#sa-open-list').onclick = function () { openAutoSellListModal(); };
      markFeature(asPanel.querySelector('#sa-open-list'), 'mall.autosell');
      const tierSw = asPanel.querySelector('#sa-tier');
      if (tierSw) markFeature(tierSw, 'mall.autosell');
      if (tierSw) {
        tierSw.addEventListener('change', function () {
          const next = !!tierSw.checked;
          tierSw.disabled = true;
          window.Net.autoSellSet({ tier: next }).then(function (r) {
            tierSw.disabled = false;
            if (!afterAutoSellChange(r, next ? '已开启：大型/巨型鱼也会被自动售出（含体型加成）' : '已关闭：大型/巨型鱼不再参与自动售出')) {
              tierSw.checked = !next;
            }
          }).catch(function () { tierSw.disabled = false; tierSw.checked = !next; toast('网络错误', true); });
        });
      }
    }

    // 广播刷新：只重建网格与右栏一览，不动输入框；头部文案跟随经济参数变化
    const subEl = document.getElementById('shop-sub');
    if (subEl) subEl.textContent = shopSubtitle();
    renderShopSide();
    renderShopGrid();
    // 清单子窗口开着时就地刷新列表（价格 / 持有 / 可卖余量随行情变）——
    // 只重写列表，筛选框与批量输入框不受影响
    if (document.getElementById('as-list-modal')) fillAutoSellList();
  }

  // 右栏自动售出一览（已启用清单；逐项控制都在清单子窗口里）
  function renderShopSide() {
    const st = S();
    const batchEl = document.getElementById('sa-batch');
    if (batchEl) batchEl.textContent = String(autoSellBatch());
    const stateEl = document.getElementById('sa-state');
    if (stateEl) stateEl.textContent = autoSellSummary();
    // 右栏只做「一览」：已启用的物品名 + 规则摘要；逐条控制都在清单子窗口里
    const box = document.getElementById('sa-enabled');
    if (!box) return;
    const items = shopAuto.items || {};
    const on = Object.keys(items).filter(function (id) { return items[id] && items[id].on; });
    if (!on.length) { box.innerHTML = '<div class="hint">还没有启用任何物品。</div>'; return; }
    const batch = autoSellBatch();
    box.innerHTML = on.map(function (id) {
      const meta = itemMeta(id);
      const r = items[id];
      const excess = autoSellExcessOf(id, r);
      const ok = !!autoSellHitOf(id, r);
      return '<div class="as-mini-row">' +
        '<span class="as-mini-name ' + rarityClass(meta.rarity) + '">' + esc(meta.name) + '</span>' +
        '<span class="as-mini-rule">' + esc(autoRuleText(id)) + '</span>' +
        '<span class="as-mini-avail">' + (excess > 0 ? ('可卖' + excess + (ok ? '' : '·未达标')) : '—') + '</span>' +
        '</div>';
    }).join('');
  }

  // ---- 自动售出清单子窗口（v0.13.8）：逐条勾选 / 单独设置 / 批量应用 ----
  // 面板只放「打开清单」一个入口，逐项控制都收敛到这个子窗口里（面板右栏太窄，行内放不下）。
  let asListCat = 'all', asListQ = '', asListFocus = false;
  function asListRows() {
    const st = S();
    return Object.keys(st.shop || {}).map(function (id) {
      return { id: id, s: st.shop[id], meta: itemMeta(id), have: st.inventory[id] || 0 };
    }).filter(function (o) { return o.meta.kind === 'fish' || o.meta.kind === 'material'; });
  }
  function openAutoSellListModal() {
    if (!featureGuard('mall.autosell')) return;
    closeOverlays();
    const overlay = buildOverlay(function () { closeOverlays(); asListFocus = false; });
    const box = el('div', 'modal-box shop-modal as-list-modal');
    box.id = 'as-list-modal';
    overlay.appendChild(box);
    document.body.appendChild(overlay);
    overlay.addEventListener('click', function (e) { if (e.target === overlay) { closeOverlays(); asListFocus = false; } });
    drawAutoSellListModal();
  }
  function drawAutoSellListModal() {
    const box = document.getElementById('as-list-modal');
    if (!box) return;
    box.innerHTML =
      '<div class="modal-head"><span class="modal-title">🤖 自动售出清单</span>' +
      '<button class="mini modal-close">✕ 关闭</button></div>' +
      '<div class="modal-body">' +
      '<div class="hint" style="margin-bottom:8px">勾选即启用该物品的自动售出；取消勾选只是停用（价格线 / 保留量留着）。' +
      '可卖余量 = 可用量（持有 − 大型/巨型预留）− 保留量；<b>所有已勾选物品的可卖余量合计</b>攒够 <b>' + autoSellBatch() + '</b> 条才打包成交一次，' +
      '成交时价格达标的物品一起结算（一次推送）。价格未达标的余量不计入合计，也不会卖。</div>' +
      '<div class="asl-filters">' +
      '<input id="asl-search" class="ipt" placeholder="搜索名称 / ID" value="' + esc(asListQ) + '" style="width:200px">' +
      '<button class="inv-cat sub' + (asListCat === 'all' ? ' on' : '') + '" data-aslcat="all">全部</button>' +
      '<button class="inv-cat sub' + (asListCat === 'fish' ? ' on' : '') + '" data-aslcat="fish">🐟 渔获</button>' +
      '<button class="inv-cat sub' + (asListCat === 'material' ? ' on' : '') + '" data-aslcat="material">🧵 材料</button>' +
      '<span class="hint" id="asl-count"></span></div>' +
      '<div class="asl-bulk">' +
      '<div class="sa-fld">基准 ≥ <input id="asl-pct" class="ipt mk-num" type="number" min="1" placeholder="留空=不看">%</div>' +
      '<div class="sa-fld">价格 ≥ <input id="asl-price" class="ipt mk-num" type="number" min="1" placeholder="留空=不看">💰</div>' +
      '<div class="sa-fld">保留 <input id="asl-keep" class="ipt mk-num" type="number" min="0" placeholder="0"> 个</div>' +
      '<div class="sa-fld" title="行情在阈值附近回落时，允许提前「阈值 − 浮动」成交，避免错过">浮动 − <input id="asl-slack-pct" class="ipt mk-num" type="number" min="0" value="0">% / <input id="asl-slack-price" class="ipt mk-num" type="number" min="0" value="0">💰</div>' +
      '<div class="sa-row"><button class="btn mini primary" id="asl-apply-fish">应用到全部鱼</button>' +
      '<button class="btn mini primary" id="asl-apply-mat">应用到全部材料</button>' +
      '<button class="btn mini" id="asl-off-all">全部停用</button>' +
      '<button class="btn mini danger" id="asl-clear-all">清空全部规则</button></div>' +
      '</div>' +
      '<div class="as-list" id="asl-list"></div>' +
      '</div>';
    box.querySelector('.modal-close').onclick = function () { closeOverlays(); asListFocus = false; };
    const sv = function (sel) { const e = box.querySelector(sel); return e ? e.value : ''; };
    const search = box.querySelector('#asl-search');
    search.oninput = function () { asListQ = search.value; fillAutoSellList(); };
    search.onfocus = function () { asListFocus = true; };
    search.onblur = function () { asListFocus = false; };
    box.querySelectorAll('[data-aslcat]').forEach(function (b) {
      b.onclick = function () { asListCat = b.getAttribute('data-aslcat'); drawAutoSellListModal(); };
    });
    // 批量应用：阈值 / 保留量取自上面的输入框；材料会先过「稀有及以上」的保护确认
    const applyBulk = function (kind, label) {
      const body = { bulk: kind, minPct: sv('#asl-pct'), minPrice: sv('#asl-price'), keep: sv('#asl-keep'),
        slackPct: sv('#asl-slack-pct'), slackPrice: sv('#asl-slack-price') };
      const run = function () {
        window.Net.autoSellSet(body).then(function (r) { afterAutoSellChange(r, label + '已应用规则'); });
      };
      const risky = asListRows().filter(function (o) {
        return o.meta.kind === kind && materialNeedsProtect(o.id);
      }).map(function (o) { return o.id; });
      if (kind === 'material' && risky.length) { confirmMaterialAutoSell(risky, run); return; }
      if (body.minPct !== '' || body.minPrice !== '') { run(); return; }
      confirmModal({ title: '批量设置自动售出', danger: true, okText: '确定应用',
        html: '两条价格线都留空 = <b>不看价格</b>，可卖余量计入合计、攒够 <b>' + autoSellBatch() + '</b> 条就整批卖出。<br>确定应用到' + label + '？' })
        .then(function (ok) { if (ok) run(); });
    };
    box.querySelector('#asl-apply-fish').onclick = function () { applyBulk('fish', '全部鱼'); };
    box.querySelector('#asl-apply-mat').onclick = function () { applyBulk('material', '全部材料'); };
    box.querySelector('#asl-off-all').onclick = function () {
      window.Net.autoSellSet({ bulk: 'all', on: false }).then(function (r) { afterAutoSellChange(r, '已停用全部自动售出（阈值保留）'); });
    };
    box.querySelector('#asl-clear-all').onclick = function () {
      confirmModal({ title: '清空自动售出规则', danger: true, okText: '清空',
        html: '各物品的价格线、浮动与保留数量都会一起删掉。' }).then(function (ok) {
        if (!ok) return;
        window.Net.autoSellSet({ bulk: 'all', remove: true }).then(function (r) { afterAutoSellChange(r, '已清空全部规则'); });
      });
    };
    fillAutoSellList();
  }
  // 清单列表（搜索 / 分类筛选后就地重绘；批量表单不重建，避免输入被冲掉）
  function fillAutoSellList() {
    const box = document.getElementById('asl-list');
    if (!box) return;
    const st = S();
    const items = shopAuto.items || {};
    const q = (asListQ || '').trim().toLowerCase();
    const batch = autoSellBatch();
    const all = asListRows();
    const rows = all.filter(function (o) {
      if (asListCat !== 'all' && o.meta.kind !== asListCat) return false;
      if (q && o.meta.name.toLowerCase().indexOf(q) < 0 && o.id.indexOf(q) < 0) return false;
      return true;
    });
    const cntEl = document.getElementById('asl-count');
    if (cntEl) {
      const onIds = Object.keys(items).filter(function (id) { return items[id] && items[id].on; });
      const plan = autoSellPlan();
      cntEl.textContent = '已启用 ' + onIds.length + ' 项 · 本页 ' + rows.length + ' 项 · 可卖合计 ' + plan.pool + ' / 阈值 ' + batch +
        (plan.pool >= batch ? '（已够一包）' : '（还差 ' + (batch - plan.pool) + '）') +
        (plan.blocked ? ' · 价格未达标 ' + plan.blocked + ' 条不计入' : '');
    }
    if (!rows.length) { box.innerHTML = '<div class="hint">没有匹配的渔获或材料。</div>'; return; }
    box.innerHTML = rows.map(function (o) {
      const r = items[o.id];
      const on = !!(r && r.on);
      const excess = r ? autoSellExcessOf(o.id, r) : 0;
      const ok = !r || !!autoSellHitOf(o.id, r);
      const pct = o.s.base ? Math.round(o.s.price / o.s.base * 100) : 100;
      const summary = autoRuleText(o.id) || '不看价格';
      const status = !r ? '未设置'
        : (!on ? '已停用 · ' + summary
          : summary + (excess > 0 ? (' · 可卖' + excess + (ok ? '' : '（价格未达标，不计入打包）')) : ''));
      const protect = materialNeedsProtect(o.id) ? '<span class="asl-guard" title="稀有及以上品质材料：启用前会二次确认">⚠️ 保护</span>' : '';
      return '<div class="as-row' + (on ? ' on' : '') + '">' +
        '<input class="as-chk" type="checkbox" data-ason="' + esc(o.id) + '"' + (on ? ' checked' : '') +
          ' title="' + (r ? '勾选 / 取消即启用 / 停用（价格线与保留量保留）' : '点一下先设置规则') + '">' +
        '<span class="as-name ' + rarityClass(o.meta.rarity) + '">' + esc(o.meta.name) + protect + '</span>' +
        '<span class="as-meta">💰' + o.s.price + ' · ' + pct + '% · 持有' + o.have +
          (reservedCountOf(o.id) > 0 ? '（可用 ' + availCountOf(o.id) + '）' : '') + '</span>' +
        '<span class="as-rule">' + esc(status) + '</span>' +
        '<button class="mini' + (r ? ' primary-mini' : '') + '" data-as="' + esc(o.id) + '" title="设置「' + esc(o.meta.name) + '」的价格线与保留数量">设置</button></div>';
    }).join('');
    box.querySelectorAll('[data-ason]').forEach(function (c) {
      c.addEventListener('change', function () {
        const id = c.getAttribute('data-ason');
        // 没配置过 → 直接开设置（避免「无条件卖光」误触）；复选框先复位，否则勾选态会留在界面上
        if (!(shopAuto.items || {})[id]) { c.checked = false; openShopAutoModal(id); return; }
        const apply = function () {
          window.Net.autoSellSet({ id: id, on: c.checked }).then(function (r) {
            if (!r || !r.ok) { toast((r && r.data.error) || '操作失败', true); fillAutoSellList(); return; }
            shopAuto.items = r.data.items || {};
            fillAutoSellList(); renderShopSide(); renderShopGrid();
          });
        };
        // 稀有及以上品质的材料：启用前先确认（停用不需要）
        if (c.checked && materialNeedsProtect(id)) { confirmMaterialAutoSell([id], apply); return; }
        apply();
      });
    });
    box.querySelectorAll('[data-as]').forEach(function (b) {
      b.addEventListener('click', function () { openShopAutoModal(b.getAttribute('data-as')); });
    });
  }
  // 规则变更后的统一收尾：同步本地状态 + 提示 + 重绘（清单窗口、右栏、商品网格）
  function afterAutoSellChange(r, msg) {
    if (!r || !r.ok) { toast((r && r.data.error) || '保存失败', true); return false; }
    shopAuto.loaded = true;
    shopAuto.items = (r.data && r.data.items) || {};
    if (r.data && r.data.batch) shopAuto.batch = Number(r.data.batch) || shopAuto.batch;
    if (r.data && r.data.tier !== undefined) shopAuto.tier = !!r.data.tier;   // v0.14.0：体型档开关
    if (r.data && r.data.inventory) applyInvFrom(r.data);
    if (r.data && r.data.bigfish !== undefined) S().bigfish = r.data.bigfish || {};
    if (r.data && r.data.coins != null) S().player.coins = r.data.coins;
    if (msg) toast(msg + (r.data && r.data.sold ? '；已达标并打包售出 ' + r.data.sold.length + ' 项' : ''));
    fillAutoSellList(); renderShopSide(); renderShopGrid(); renderTopbar();
    return true;
  }
  // 材料保护（v0.13.8）：稀有及以上品质的材料是熔炼 / 宝匣的硬通货，误开自动售出代价大 ——
  // 启用前弹一次确认（普通材料如诱饵包不弹，那是「留够就卖」的主力）。
  const MATERIAL_GUARD = ['rare', 'epic', 'mythic'];
  function materialNeedsProtect(id) {
    const m = itemMeta(id);
    return m.kind === 'material' && MATERIAL_GUARD.indexOf(m.rarity) >= 0;
  }
  function confirmMaterialAutoSell(ids, then) {
    const risky = ids.filter(materialNeedsProtect);
    if (!risky.length) { then(); return; }
    // ⚠️ confirmModal 会 closeOverlays()（连同清单子窗口一起关掉）→ 确认结束后先把清单恢复出来，
    // 再把结果交给调用方；否则「取消」之后玩家会直接掉回商店页，勾选态也无处复位。
    const hadList = !!document.getElementById('as-list-modal');
    confirmModal({
      title: '⚠️ 材料保护确认', danger: true, okText: '确认自动出售',
      html: '以下材料是<b>稀有及以上品质</b>（熔炼 / 宝匣的常用消耗）：<br><b>' +
        risky.map(function (id) { return esc(itemMeta(id).name); }).join('、') +
        '</b><br>确定要自动出售' + (risky.length > 1 ? '它们' : '它') + '吗？建议同时设置「保留数量」，只卖超出的部分。',
    }).then(function (ok) {
      if (hadList && !document.getElementById('as-list-modal')) openAutoSellListModal();
      if (ok) then();
    });
  }

  // 商品网格的条目（筛选 + 排序）：初始化渲染与就地补丁共用同一套口径，
  // 否则「补丁」和「重建」会得出两套数字（本项目踩过的老坑）。
  function shopGridEntries(st) {
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
    return entries;
  }
  // v0.14.0：体型档小按钮的文案 / 可用量（卡片渲染与就地补丁共用，避免两条路两套数字）
  function shopTierInfo(id, tier) {
    const n = shownReservedOf(id, tier);
    const pct = tier === 'G' ? 150 : 50;
    return {
      n: n, pct: pct,
      text: (tier === 'G' ? '巨型' : '大型') + ' +' + pct + '%' + (n > 0 ? ' ×' + n : ''),
      title: n > 0
        ? '按当前收购价出售 ' + n + ' 条' + (tier === 'G' ? '巨型' : '大型') + '鱼：额外 +' + pct + '% 金币（单价 ×' + (tier === 'G' ? '2.5' : '1.5') + '）'
        : '没有' + (tier === 'G' ? '巨型' : '大型') + '鱼可卖（超出默认最大体型的渔获会自动进这一档，单独预留、普通通道卖不了）',
    };
  }
  // 档位出售：走服务端 tier 通道（含加成），就地补丁这张卡
  function sellShopTier(id, tier) {
    const info = shopTierInfo(id, tier);
    if (info.n <= 0) { toast('这条鱼没有' + (tier === 'G' ? '巨型' : '大型') + '档可卖', true); return; }
    const s = S().shop && S().shop[id];
    sellNow({
      id: id, tier: tier, qty: Math.min(sellQty, info.n), unit: s ? s.price : unitPriceOf(id),
      onLocal: function () { patchShopCard(id); },
      onSync: function () { if (!patchShopCard(id) && inShopView()) renderShop(); },
    });
  }
  // 收购卡片：就地补丁（现价 / 持有·可用 / 出售按钮）。出售后不等回包先按账本改，
  // 行情广播到达时也只刷数字——列表不重排、滚动位置与正在点的卡片都不会被顶走。
  function patchShopCard(id) {
    const card = document.querySelector('#shop-panel .shop-card[data-id="' + id + '"]');
    if (!card) return false;
    const st = S();
    const s = st.shop && st.shop[id];
    if (!s) return false;
    const have = st.inventory[id] || 0;
    const avail = shownAvailOf(id);          // 显示量 = 服务器可用量 − 在途出售量
    const ratio = s.base ? s.price / s.base : 1;
    const pct = Math.round(ratio * 100);
    const priceEl = card.querySelector('.sc-price');
    if (priceEl) {
      priceEl.className = 'sc-price ' + (ratio < 0.75 ? 'low' : ratio < 0.95 ? 'mid' : 'high');
      priceEl.innerHTML = '💰 ' + s.price + '<span class="base">基准 ' + s.base + '</span>';
    }
    const bars = card.querySelectorAll('.sc-bar i');
    if (bars.length === 2) {
      bars[0].style.width = (pct > 100 ? Math.min(100, pct - 100) : 0) + '%';
      bars[1].style.width = Math.max(6, Math.min(100, pct)) + '%';
    }
    const pctEl = card.querySelector('.sc-pct');
    if (pctEl) {
      pctEl.textContent = '当前 ' + pct + '% · 持有 ' + have +
        (avail < have ? '（可用 ' + avail + '）' : '') + ' · 今日售出 ' + (s.soldToday || 0);
    }
    const btn = card.querySelector('.sc-sell-btn');
    if (btn) {
      btn.textContent = avail > 0 ? ('出售 ' + Math.min(sellQty, avail) + ' 个') : (have > 0 ? '仅体型档可卖' : '无库存');
      btn.classList.toggle('primary-mini', avail > 0);
      btn.classList.toggle('locked', avail <= 0);
      markFeature(btn, 'mall.sell');
      if (avail <= 0 && have > 0) btn.title = '这些鱼都是大型/巨型预留，普通通道卖不了：请到背包按「大型 / 巨型」行出售（有额外金币加成）';
      else btn.removeAttribute('title');
    }
    // v0.14.0：两个档位小按钮跟着刷（数量 / 是否可用）
    card.querySelectorAll('.sc-tier-btn').forEach(function (tb) {
      const t = tb.getAttribute('data-tier');
      const info = shopTierInfo(id, t);
      tb.textContent = info.text;
      tb.title = info.title;
      tb.disabled = info.n <= 0;
      tb.classList.toggle('locked', info.n <= 0);
    });
    return true;
  }
  // 整片卡片补丁：只有当页面上这批卡片正好等于「当前筛选/排序的结果」时才就地刷，
  // 否则交回整页重建（例如刚钓到新鱼种、筛选项变了、某项已卖光被「只看持有」筛掉）。
  function patchShopCards() {
    const grid = document.querySelector('#shop-panel .shop-grid');
    if (!grid) return false;
    const ids = shopGridEntries(S()).map(function (o) { return o.id; });
    const dom = Array.prototype.map.call(grid.querySelectorAll('.shop-card[data-id]'), function (c) { return c.getAttribute('data-id'); });
    if (dom.length !== ids.length) return false;
    const want = {};
    ids.forEach(function (i) { want[i] = 1; });
    if (dom.some(function (i) { return !want[i]; })) return false;
    ids.forEach(function (i) { patchShopCard(i); });
    return true;
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
    const entries = shopGridEntries(st);
    grid.innerHTML = '';
    entries.forEach(function (o) {
      const id = o.id, s = o.s, meta = o.meta, have = o.have;
      const avail = shownAvailOf(id);   // 显示量：普通通道可出售量（持有 − 大型/巨型预留）− 在途出售量
      const ratio = s.base ? s.price / s.base : 1;
      const pct = Math.round(ratio * 100);
      const cls = ratio < 0.75 ? 'low' : ratio < 0.95 ? 'mid' : 'high';
      const card = el('div', 'shop-card' + (hasAutoRule(id, meta.kind) ? ' has-auto' : ''));
      card.setAttribute('data-id', id);   // 就地补丁用（见 patchShopCard / patchShopCards）
      const fillPct = Math.max(6, Math.min(100, pct));
      const upPct = pct > 100 ? Math.min(100, pct - 100) : 0;
      const autoTag = hasAutoRule(id, meta.kind)
        ? '<span class="sc-auto" title="该鱼设置了自动售出规则">🤖 ' + esc(autoRuleText(id, meta.kind)) + '</span>' : '';
      card.innerHTML =
        '<div class="sc-name ' + rarityClass(meta.rarity) + '">' + esc(meta.name) +
        '<span class="sc-kind">' + esc(qualityName(meta)) + '</span>' + autoTag + '</div>' +
        '<div class="sc-price ' + cls + '">💰 ' + s.price + '<span class="base">基准 ' + s.base + '</span></div>' +
        '<div class="sc-bar"><i class="up" style="width:' + upPct + '%"></i><i style="width:' + fillPct + '%"></i></div>' +
        '<div class="sc-pct">当前 ' + pct + '% · 持有 ' + have + (avail < have ? '（可用 ' + avail + '）' : '') + ' · 今日售出 ' + (s.soldToday || 0) + '</div>';
      card.title = '点击查看价格走势与交易量';
      // v0.13.9：收购走普通通道（服务端按可用量校验），按钮与夹紧必须用可用量，
      // 否则「持有 3（全是大型/巨型预留）」的鱼点出售必然收到 400「数量不足」。
      // v0.13.10：点击后走 sellNow —— 本地立刻扣显示量与加币，**不等服务器回包**（回包再对账）。
      const sellN = Math.min(sellQty, avail);
      const btn = el('button', 'mini sc-sell-btn' + (avail > 0 ? ' primary-mini' : ' locked'), avail > 0 ? ('出售 ' + sellN + ' 个') : (have > 0 ? '仅体型档可卖' : '无库存'));
      if (avail <= 0 && have > 0) btn.title = '这些鱼都是大型/巨型预留，普通通道卖不了：请到背包按「大型 / 巨型」行出售（有额外金币加成）';
      btn.addEventListener('click', function (ev) {
        ev.stopPropagation();
        const now = shownAvailOf(id);
        if (!(now > 0)) { toast(have > 0 ? '这条鱼都是大型/巨型预留，请到背包按体型档行出售' : '背包里没有可出售的数量', true); return; }
        sellNow({
          id: id, qty: Math.min(sellQty, now), unit: s.price,
          onLocal: function () { patchShopCard(id); },
          // 回包对账：卡片还在就就地校准；卡不在（例如已卖光被「只看持有」筛掉）且仍停在收购页才整页重建
          // （renderShop 直接往 #main 画收购页，切走了还调用会把当前页盖掉）
          onSync: function () { if (!patchShopCard(id) && inShopView()) renderShop(); },
        });
      });
      card.appendChild(btn);
      // v0.14.0：体型档小按钮（大型 +50% / 巨型 +150%）——大型/巨型鱼单独预留，普通通道动不了，
      // 这里各给一个按钮直接按档位卖（没量时灰掉）。档位量只在「该鱼种有预留」时出现，
      // 但按钮始终渲染：没量的鱼也看得到这一档存在，只是灰着（与主按钮的「无库存」同一套处理）。
      const tierBar = el('div', 'sc-tiers');
      [['L', 50], ['G', 150]].forEach(function (tk) {
        const t = tk[0];
        const info = shopTierInfo(id, t);
        const tb = el('button', 'mini sc-tier-btn tier-' + (t === 'G' ? 'giant' : 'large') + (info.n > 0 ? '' : ' locked'), info.text);
        markFeature(tb, 'mall.sell');
        tb.setAttribute('data-tier', t);
        tb.disabled = info.n <= 0;
        tb.title = info.title;
        tb.addEventListener('click', function (ev) {
          ev.stopPropagation();
          sellShopTier(id, t);
        });
        tierBar.appendChild(tb);
      });
      card.appendChild(tierBar);
      card.addEventListener('click', function () { openShopModal(id); });
      grid.appendChild(card);
    });
    if (!entries.length) grid.appendChild(el('div', 'hint', '没有符合筛选条件的商品。'));
  }


  // ---- 自动售出：规则判断 / 文案 / 打包阈值（商店卡片、右栏与设置弹窗共用）----
  // 全服打包阈值以服务器为准（/api/version 与 autosellcfg 广播同步；规则接口的返回只作兜底），
  // 后台改阈值后面板文案要立刻跟上——所以这里必须优先读全局配置，而不是上一次规则响应里的快照。
  function autoSellBatch() {
    const n = Number((S().autoSellCfg || {}).batch) || Number(shopAuto.batch) || 0;
    return n > 0 ? n : 1;
  }
  function autoSellRule(id) { return (shopAuto.items || {})[id] || null; }
  function autoSellKeep(rule) { return Math.max(0, Math.floor(Number(rule && rule.keep)) || 0); }
  // 可卖余量：可用量（持有 − 大型/巨型预留）− 保留量。与服务端 autoSellExcess 同口径
  // v0.14.0：账号开了「体型档」开关时可卖余量改用持有总量（档位鱼也参与），与服务端同步。
  function autoSellTierOn() { return !!(shopAuto && shopAuto.tier); }
  function autoSellExcessOf(id, rule) {
    const r = rule === undefined ? autoSellRule(id) : rule;
    const pool = autoSellTierOn() ? (S().inventory[id] || 0) : availCountOf(id);
    return Math.max(0, pool - autoSellKeep(r));
  }
  // 价格线判定（服务端 autoSellHit 的前端镜像：浮动接受值允许提前成交，最低钳到 1）
  function autoSellHitOf(id, rule) {
    const r = rule === undefined ? autoSellRule(id) : rule;
    if (!r) return null;
    const s = S().shop && S().shop[id];
    const base = s ? (s.base || 0) : 0;
    const price = unitPriceOf(id);
    const pctLine = r.minPct != null ? Math.max(1, r.minPct - (Number(r.slackPct) || 0)) : null;
    const priceLine = r.minPrice != null ? Math.max(1, r.minPrice - (Number(r.slackPrice) || 0)) : null;
    if (pctLine == null && priceLine == null) return { price: price, base: base, by: '无条件' };
    const pctOk = pctLine != null && base > 0 && price >= base * pctLine / 100;
    const priceOk = priceLine != null && price >= priceLine;
    return (pctOk || priceOk) ? { price: price, base: base, by: pctOk ? '基准' : '价格' } : null;
  }
  // 打包计划（与服务端 autoSellPlan 同口径）：只把**价格达标**的余量计入合计——
  // 价格未达标的余量永远卖不掉，若计入就会把合计顶在阈值之上，变成每上一条鱼推一次。
  function autoSellPlan() {
    const items = shopAuto.items || {};
    const out = { pool: 0, blocked: 0, ready: 0, online: 0, per: {} };
    Object.keys(items).forEach(function (id) {
      if (!hasAutoRule(id, itemMeta(id).kind)) return;
      out.online++;
      const excess = autoSellExcessOf(id, items[id]);
      if (excess <= 0) return;
      if (!autoSellHitOf(id, items[id])) { out.blocked += excess; out.per[id] = { excess: excess, ok: false }; return; }
      out.pool += excess; out.ready++; out.per[id] = { excess: excess, ok: true };
    });
    return out;
  }
  function hasAutoRule(id, kind) {
    if (kind !== 'fish' && kind !== 'material') return false;
    const r = autoSellRule(id);
    return !!(r && r.on);
  }
  function autoRuleText(id, kind) {
    const r = autoSellRule(id);
    if (!r) return '';
    const parts = [];
    if (r.minPct != null) parts.push('基准≥' + Math.max(1, r.minPct - (r.slackPct || 0)) + '%');
    if (r.minPrice != null) parts.push('价格≥' + Math.max(1, r.minPrice - (r.slackPrice || 0)));
    if (!parts.length) parts.push('不看价格');
    const keep = autoSellKeep(r);
    if (keep) parts.push('保留' + keep);
    return parts.join(' ');
  }
  function autoSellSummary() {
    const items = shopAuto.items || {};
    const on = Object.keys(items).filter(function (id) { return items[id] && items[id].on; });
    if (!on.length) return '未启用：勾选渔获或材料即可自动出售';
    const fish = on.filter(function (id) { return itemMeta(id).kind === 'fish'; }).length;
    const mat = on.filter(function (id) { return itemMeta(id).kind === 'material'; }).length;
    const plan = autoSellPlan();
    const batch = autoSellBatch();
    return '已启用 ' + on.length + ' 项（渔获 ' + fish + ' / 材料 ' + mat + '）· 可卖合计 ' + plan.pool + ' / 阈值 ' + batch +
      (plan.pool >= batch ? '（已够一包）' : '（还差 ' + (batch - plan.pool) + '）');
  }
  // 单物品自动售出设置弹窗
  function openShopAutoModal(id) {
    const meta = itemMeta(id);
    const cur = autoSellRule(id);
    const have = S().inventory[id] || 0;
    const batch = autoSellBatch();
    // 从清单子窗口点进来的：关掉后要把它重新开出来（closeOverlays 会清掉所有浮层）
    const reopenList = !!document.getElementById('as-list-modal');
    closeOverlays();
    const overlay = buildOverlay(function () { closeOverlays(); });
    const box = el('div', 'modal-box confirm-modal');
    box.innerHTML = '<div class="modal-head"><span class="modal-title">🤖 自动售出 · ' + esc(meta.name) + '</span></div>' +
      '<div class="modal-body">' +
      '<div class="hint" style="margin-bottom:8px">可卖余量 = 可用量 − 保留量；可用量 = 持有 ' + have +
      (reservedCountOf(id) > 0 ? ' − 大型/巨型预留 ' + reservedCountOf(id) : '') +
      '。它与其它已启用物品的可卖余量<b>合计</b>攒够 <b>' + batch + '</b> 条、且本物品达到价格线时，按系统行情一起打包卖出。</div>' +
      '<label class="sa-switch"><input type="checkbox" id="as-on"' + (!cur || cur.on ? ' checked' : '') + '><span>启用「' + esc(meta.name) + '」自动售出</span></label>' +
      '<div class="mgr-row"><label>基准 ≥</label><input id="as-pct" class="ipt mk-num" type="number" min="1" value="' + (cur && cur.minPct != null ? cur.minPct : '') + '" placeholder="留空=不看" /><span class="hint">%（基准价的百分比）</span></div>' +
      '<div class="mgr-row"><label>价格 ≥</label><input id="as-price" class="ipt mk-num" type="number" min="1" value="' + (cur && cur.minPrice != null ? cur.minPrice : '') + '" placeholder="留空=不看" /><span class="hint">💰（绝对价格）</span></div>' +
      '<div class="mgr-row"><label>浮动</label><input id="as-slack-pct" class="ipt mk-num" type="number" min="0" value="' + (cur && cur.slackPct != null ? cur.slackPct : 0) + '" /><span class="hint">%（百分比线提前量）</span>' +
      '<input id="as-slack-price" class="ipt mk-num" type="number" min="0" value="' + (cur && cur.slackPrice != null ? cur.slackPrice : 0) + '" /><span class="hint">💰（价格线提前量）</span></div>' +
      '<div class="mgr-row"><label>保留数量</label><input id="as-keep" class="ipt mk-num" type="number" min="0" value="' + autoSellKeep(cur) + '" /><span class="hint">个（最少留下不卖，只卖超出的部分）</span></div>' +
      '<div class="hint" style="margin:6px 0">价格线两条都留空 = 不看价格：可卖余量计入合计，合计攒够一包就卖（材料常用，如「留 100 个诱饵包，多的卖掉」）。浮动 = 行情回落到「阈值 − 浮动」即成交，避免错过。</div>' +
      '<div class="cf-actions"><button class="btn mini cf-no">取消</button>' +
      '<button class="btn mini danger" id="as-clear">清除规则</button>' +
      '<button class="btn primary" id="as-save">保存</button></div>' +
      '</div></div>';
    overlay.appendChild(box);
    document.body.appendChild(overlay);
    overlay.addEventListener('click', function (e) { if (e.target === overlay) closeOverlays(); });
    box.querySelector('.cf-no').onclick = function () { closeOverlays(); if (reopenList) openAutoSellListModal(); };
    // 保存后：关掉本窗口 → 回到清单（若原本从清单进来）；状态与列表统一由 afterAutoSellChange 收尾
    const done = function (r, msg) {
      if (!r || !r.ok) { toast((r && r.data.error) || '保存失败', true); return; }
      const keepList = reopenList;
      closeOverlays();
      if (keepList) openAutoSellListModal();
      afterAutoSellChange(r, msg);
    };
    box.querySelector('#as-save').onclick = function () {
      const payload = {
        id: id,
        on: box.querySelector('#as-on').checked,
        minPct: box.querySelector('#as-pct').value,
        minPrice: box.querySelector('#as-price').value,
        slackPct: box.querySelector('#as-slack-pct').value,
        slackPrice: box.querySelector('#as-slack-price').value,
        keep: box.querySelector('#as-keep').value,
      };
      const send = function () {
        window.Net.autoSellSet(payload).then(function (r) {
          done(r, '已保存：' + meta.name + (r && r.data && r.data.sold ? '（已达标并打包售出）' : ''));
        });
      };
      // 材料保护：本次是「新启用」且属于稀有及以上品质的材料 → 先确认
      if (payload.on && materialNeedsProtect(id) && !(cur && cur.on)) { confirmMaterialAutoSell([id], send); return; }
      send();
    };
    box.querySelector('#as-clear').onclick = function () {
      window.Net.autoSellSet({ id: id, remove: true }).then(function (r) { done(r, '已清除 ' + meta.name + ' 的自动售出规则'); });
    };
  }

  // ---- 开放市集视图 ----
  // 当前页签与购买市场筛选状态（模块级：重绘间保留）
  let marketTab = 'buy';
  let buyCategory = 'all';
  let buyPart = 'all';        // 「组件」分类下的二级筛选：部位（口径与背包一致：meta.part）
  let buySearch = '';
  let buySearchFocus = false;
  let buySort = { key: 'time', dir: 'desc' };
  let buyAffixType = 'all';   // 组件词条类型筛选：all / speed / big / ...
  let buyAffixMin = '';       // 该词条的最小数值（含），空 = 不限
  let buyAffixMax = '';       // 该词条的最大数值（含），空 = 不限
  let buyOnlyComponents = true; // 词条筛选仅在组件上生效，此开关便于混合搜索
  let marketFilterActive = false; // 市集筛选控件获得焦点时暂停广播重绘（防止下拉框被刷新关闭）
  let marketHistCache = null;     // 历史订单缓存：资产广播重绘时先画旧数据，避免闪「加载中…」
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
        call(window.Net.marketCancel(l.lid), '已下架，物品退回背包（上架费不退）').then(function (r) { if (r && r.ok) { applyInvFrom(r.data); renderTopbar(); renderView(); } });
      });
      acts.appendChild(cb);
    } else {
      const bb = el('button', 'mini primary-mini', '购买');
      markFeature(bb, 'mall.marketbuy');
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
                st.player.coins = r.data.coins; applyInvFrom(r.data);
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
    // 右栏「我的背包（上架）」优先复用已有节点（别人挂单 / 成交的广播会整页重建市集）：
    // 重建右栏会把滚动位置、勾选焦点与鼠标悬停全丢掉，多选上架时列表被弹回顶部、点击落空。
    const prevSell = main.querySelector('.mkt-sell');
    const keepSell = (prevSell && prevSell.getAttribute('data-cat') === mktSellCat) ? prevSell : null;
    const prevList = keepSell ? keepSell.querySelector('.mkt-sell-list') : null;
    const prevScroll = prevList ? prevList.scrollTop : 0;
    main.innerHTML = '';
    const panel = el('div', 'panel wide two-col');
    panel.innerHTML = '<h2>💱 市集 <span class="subtitle">购买 / 我的挂单 / 历史订单 分页管理 · 成交收 10% 税（卖家承担）</span></h2>' + mallTabsHtml('market');
    bindMallTabs(panel);
    panel.appendChild(el('div', 'hint page-help',
      '玩家之间的挂单买卖：上架费按 6 / 12 / 24 小时收 1% / 3% / 5%（下架不退），成交再收 10% 税（卖家承担）。右栏可直接从背包上架。'));

    const colMain = el('div', 'col-main');
    const market = st.market || [];
    const mineCount = market.filter(function (l) { return me && me.id != null && String(l.seller).toLowerCase() === String(me.id).toLowerCase(); }).length;
    // 挂单上限（后台按账号设；0 = 不限）：顶满时在页签上直接标出来，免得反复被服务器拒绝
    const myCap = me && Number(me.listingCap) > 0 ? Number(me.listingCap) : 0;
    const tabs = el('div', 'inv-cats sub-cats');
    [['buy', '🛒 购买市场', market.length - mineCount], ['mine', '🏷️ 我的挂单', mineCount], ['history', '📜 历史订单', null]].forEach(function (kv) {
      const label = kv[1] + (kv[2] != null ? ' ' + kv[2] : '') + (kv[0] === 'mine' && myCap ? ' / ' + myCap : '');
      const b = el('button', 'inv-cat' + (marketTab === kv[0] ? ' on' : ''), label);
      if (kv[0] === 'mine' && myCap && mineCount >= myCap) b.title = '挂单已达上限 ' + myCap + '，下架后才能再上架';
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
      // 结果缓存一份：本页会随资产广播（上鱼 / 售出）重绘，若每次都清空再请求，
      // 列表会先闪成「加载中…」再重排——缓存后立刻用旧数据画出，请求回来再原地替换。
      const hist = el('div', 'market-history');
      colMain.appendChild(hist);
      function drawHist(trades) {
        hist.innerHTML = '';
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
      }
      if (marketHistCache) drawHist(marketHistCache); else hist.textContent = '加载中…';
      window.Net.marketHistory().then(function (r) {
        if (marketTab !== 'history') return; // 已切走
        if (!r || !r.ok) {
          if (!marketHistCache) hist.textContent = (r && r.data && r.data.error) || '加载失败';
          return;
        }
        marketHistCache = r.data.trades || [];
        drawHist(marketHistCache);
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
      // 「组件」分类下的二级筛选：按部位（竿身/线组/钩/饵/卷线器/配件/饰品栏位）缩小范围。
      // 判定口径与背包「物品明细」完全一致（itemMeta(id).part），挂单不存属性快照，靠 id 反解。
      if (buyCategory === 'component') {
        const comps = othersAll.filter(function (l) { return itemMeta(l.id).kind === 'component'; });
        const partCount = {};
        comps.forEach(function (l) { const p = itemMeta(l.id).part || ''; partCount[p] = (partCount[p] || 0) + 1; });
        const partRow = el('div', 'bf-subrow');
        partRow.appendChild(el('span', 'sub-label', '部位'));
        [['all', '全部', comps.length]].concat(D.ROD_PARTS.map(function (p) {
          return [p.key, p.name, partCount[p.key] || 0];
        })).forEach(function (kv) {
          if (kv[0] !== 'all' && !kv[2]) return;   // 没有该部位挂单就不显示，保持紧凑（同背包）
          const b = el('button', 'inv-cat sub' + (buyPart === kv[0] ? ' on' : ''), kv[1] + ' ' + kv[2]);
          b.addEventListener('click', function () { if (buyPart !== kv[0]) { buyPart = kv[0]; renderView(); } });
          partRow.appendChild(b);
        });
        filters.appendChild(partRow);
      }
      function refreshList() {
        const q = buySearch.trim().toLowerCase();
        let others = othersAll.filter(function (l) { return buyCategory === 'all' || itemMeta(l.id).kind === buyCategory; });
        if (buyCategory === 'component' && buyPart !== 'all') {
          others = others.filter(function (l) {
            const m = itemMeta(l.id);
            return m.kind === 'component' && (m.part || '') === buyPart;
          });
        }
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
          list.appendChild(el('div', 'hint', othersAll.length ? '没有符合条件的挂单。' : '市集未上架商品（您上架的商品在我的挂单查看）'));
          return;
        }
        others.forEach(function (l) { list.appendChild(marketRow(l, st, me)); });
        if (q || buyCategory !== 'all' || buyPart !== 'all' || buySort.key !== 'time' || affixFilterActive()) list.appendChild(el('div', 'hint', '匹配 ' + others.length + ' 条挂单。'));
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
    side.appendChild(el('div', 'hint', '「上架」把你的物品挂到市集（收定价总额 1% 上架费，下架不退）；成交另收 10% 税（卖家承担）。'));
    side.appendChild(keepSell || marketSellPanel(st));
    panel.appendChild(side);

    main.appendChild(panel);
    if (keepSell) {
      patchMarketAssets();   // 复用旧节点后按最新背包补齐行（增删 / 数量 / 现价 / 分类计数）
      const l = keepSell.querySelector('.mkt-sell-list');
      if (l && prevScroll) l.scrollTop = prevScroll;   // 节点被摘走过，滚动位置显式还原
    }
  }

  // ---- 市集右栏「我的背包」：简易分类筛选 + 多选 + 一键上架 ----
  // 分类只为快速定位要上架的物品；多选后统一设置时长与价格倍率，逐个调用挂单接口。
  let mktSellCat = 'all';
  let mktSellPick = {};      // 勾选的物品 id → true
  let mktSellScroll = 0;     // 列表滚动位置（仅在必须重建时还原，避免多选时被弹回顶部）
  const MKT_SELL_CATS = [
    ['all', '📦 全部'], ['fish', '🐟 鱼类'], ['material', '🧵 材料'], ['chest', '🎁 宝匣'], ['component', '🔧 组件'],
  ];
  // 当前分类下要列出的物品 id（按现价从高到低；现价随售出量浮动）
  // v0.14.0：鱼类暂时不能上架 → 从「我的背包（上架）」里整个隐去（分类页签也不出鱼类）
  function mktSellKeys(st) {
    const ids = Object.keys(st.inventory).filter(function (id) {
      const kind = itemMeta(id).kind;
      if (!MARKET_FISH_LIST && kind === 'fish') return false;
      return mktSellCat === 'all' || kind === mktSellCat;
    });
    return ids.sort(function (a, b) { return unitPriceOf(b) - unitPriceOf(a) || (a < b ? -1 : 1); });
  }
  function mktSellCatCounts(st) {
    const n = { fish: 0, material: 0, chest: 0, component: 0 };
    let all = 0;
    Object.keys(st.inventory).forEach(function (id) {
      const k = itemMeta(id).kind;
      if (!MARKET_FISH_LIST && k === 'fish') return;   // 鱼类不算进「我的背包（上架）」口径
      all++;
      if (n[k] != null) n[k] += 1;
    });
    n.all = all;
    return n;
  }
  // 组件实例：词条直接显示在挂单列表里（含数值区间与满词条标记），便于挑要挂单的组件
  function mktSellAffHtml(meta) {
    if (meta.kind !== 'component' || !meta.affixes || !meta.affixes.length) return '';
    return '<span class="mkt-sell-aff">' + meta.affixes.map(function (a) {
      const rng = affixRangeIn(meta, a);
      const rangeTag = rng ? '<span class="aff-rng">（' + esc(rangeText({ min: rng[0], max: rng[1] })) + '%）</span>' : '';
      return affSpanOpen(a) + esc(affixText(a)) + rangeTag + '</span>';
    }).join('') + itemTag(meta) + '</span>';
  }
  // 单行。行上带 data-mkt-id：资产广播时按 id 就地改数量 / 现价，DOM 本身不重建
  //（重建会让滚动位置、勾选焦点与鼠标悬停全部丢失 —— 多选上架时表现为列表弹回顶部、点击落空）。
  function mktSellRow(id, st) {
    const meta = itemMeta(id);
    const row = el('div', 'inv-row mkt-sell-row');
    row.setAttribute('data-mkt-id', id);
    row.innerHTML = '<label class="mkt-pick"><input type="checkbox"' + (mktSellPick[id] ? ' checked' : '') + ' /></label>' +
      '<span class="mkt-sell-info">' +
      '<span class="mkt-sell-name ' + qualityClass(meta) + '">' + esc(meta.name) + '</span>' +
      '<span class="mkt-lock">' + rodLockBadge(id) + '</span>' + mktSellAffHtml(meta) +
      '</span>' +
      '<span class="cnt">×' + availCountOf(id) + '</span>' + (reservedCountOf(id) > 0 ? '<span class="cnt inv-total" title="背包总量（含大型/巨型预留）">总 ×' + (st.inventory[id] || 0) + '</span>' : '') +
      '<span class="unit-price">' + unitPriceOf(id) + '💰</span>';
    row.querySelector('input[type=checkbox]').addEventListener('change', function (e) {
      if (e.target.checked) mktSellPick[id] = true; else delete mktSellPick[id];
      syncMktSellFoot();
    });
    const acts = el('span', 'inv-acts');
    if (meta.kind === 'fish' && !MARKET_FISH_LIST) {
      const off = el('span', 'mini locked mk-off', '上架暂停');
      off.title = '鱼类暂时不能上市集（改版中）：渔获请在「商城 · 收购」出售';
      acts.appendChild(off);
    } else {
      const b1 = el('button', 'mini', '上架');
      markFeature(b1, 'mall.list');
      b1.title = '单个上架（自定义数量/单价/时长）';
      b1.addEventListener('click', function () { openListModal(id); });
      acts.appendChild(b1);
    }
    row.appendChild(acts);
    return row;
  }
  // 勾选集合取自当前 DOM 里的行：物品已从背包消失时自动排除，不会把幽灵 id 带进一键上架
  function mktSellPickedIds() {
    const host = document.querySelector('.mkt-sell');
    if (!host) return [];
    return Array.prototype.map.call(host.querySelectorAll('.mkt-sell-row[data-mkt-id]'), function (r) {
      return r.getAttribute('data-mkt-id');
    }).filter(function (id) { return !!mktSellPick[id]; });
  }
  // 底部按钮随勾选就地更新（文案 / 禁用态 / 点击行为），不整页重绘
  function syncMktSellFoot() {
    const host = document.querySelector('.mkt-sell');
    const batch = host && host.querySelector('.mkt-sell-foot .primary');
    if (!batch) return;
    const pickedIds = mktSellPickedIds();
    batch.textContent = '⚡ 一键上架（已选 ' + pickedIds.length + '）';
    batch.classList.toggle('locked', !pickedIds.length);
    batch.title = pickedIds.length ? '统一设置时长与价格倍率后逐个挂单' : '先勾选要上架的物品';
    batch.onclick = pickedIds.length ? function () { openBatchListModal(pickedIds); } : null;
  }
  function marketSellPanel(st) {
    const box = el('div', 'mkt-sell');
    box.setAttribute('data-cat', mktSellCat);   // 供 renderMarket 判断这个节点能否原样复用
    box.appendChild(el('h3', null, '🎒 我的背包（上架）'));
    // 简易分类
    const counts = mktSellCatCounts(st);
    const cats = el('div', 'inv-cats mkt-cats');
    MKT_SELL_CATS.forEach(function (kv) {
      if (!MARKET_FISH_LIST && kv[0] === 'fish') return;   // v0.14.0：鱼类暂时不能上架，分类页签也不出
      const b = el('button', 'inv-cat' + (mktSellCat === kv[0] ? ' on' : ''), kv[1] + ' ' + counts[kv[0]]);
      b.setAttribute('data-cat', kv[0]);
      b.addEventListener('click', function () {
        if (mktSellCat === kv[0]) return;
        mktSellCat = kv[0];
        mktSellScroll = 0;   // 换分类从头看起
        renderView();
      });
      cats.appendChild(b);
    });
    box.appendChild(cats);
    if (!MARKET_FISH_LIST) {
      box.appendChild(el('div', 'hint mk-off-hint', '🐟 鱼类暂时不能上架（改版中）：渔获请在「商城 · 收购」出售，大型/巨型鱼可按档位卖（+50% / +150% 加成）。'));
    }
    const keys = mktSellKeys(st);
    if (!keys.length) { box.appendChild(el('div', 'hint', '该分类下没有可上架的物品。')); return box; }
    const list = el('div', 'mkt-sell-list');
    list.addEventListener('scroll', function () { mktSellScroll = list.scrollTop; });
    keys.forEach(function (id) { list.appendChild(mktSellRow(id, st)); });
    box.appendChild(list);
    const foot = el('div', 'mkt-sell-foot');
    foot.appendChild(el('button', 'primary'));
    const clr = el('button', 'mini', '清空选择');
    clr.addEventListener('click', function () {
      // 就地取消勾选（同样避免重绘导致的滚动跳动）
      mktSellPick = {};
      list.querySelectorAll('input[type=checkbox]').forEach(function (c) { c.checked = false; });
      syncMktSellFoot();
    });
    foot.appendChild(clr);
    box.appendChild(foot);
    box.appendChild(el('div', 'hint', '勾选多件后点「一键上架」：统一设置时长与价格倍率（按各物品现价计算），逐个挂单。'));
    syncMktSellFoot();
    return box;
  }
  // 市集：纯资产广播（上鱼 / 售出 / 交易只改背包与金币）就地更新右栏「我的背包（上架）」——
  // 按 id 改数量 / 现价、增删行、刷新分类计数，DOM 节点（含滚动位置与勾选）原样保留。
  // 此前是整块 replaceWith 重建，上鱼广播一来就把列表弹回顶部、把正在点的勾选框换掉，
  // 表现就是「选不到下面要上架的物品」。左栏挂单 / 历史订单同样不重建。
  function patchMarketAssets() {
    const main = $('main');
    const st = S();
    if (!main) return false;
    const host = main.querySelector('.mkt-sell');
    if (!host) return false;
    if (host.getAttribute('data-cat') !== mktSellCat) return false;  // 分类刚变：交给整页重建
    const list = host.querySelector('.mkt-sell-list');
    const keys = mktSellKeys(st);
    const hasRows = !!(list && list.querySelector('.mkt-sell-row'));
    // 面板当前是空分类提示、或该分类刚好变空：这两种情况下没有勾选与滚动位置要保留，
    // 整块原地换新最省事（此时换 DOM 不会被用户感知）。
    if (!hasRows || !keys.length) { host.replaceWith(marketSellPanel(st)); return true; }
    const counts = mktSellCatCounts(st);
    host.querySelectorAll('.mkt-cats .inv-cat[data-cat]').forEach(function (b) {
      const c = b.getAttribute('data-cat');
      const label = (MKT_SELL_CATS.filter(function (kv) { return kv[0] === c; })[0] || [null, c])[1];
      const txt = label + ' ' + (counts[c] || 0);
      if (b.textContent !== txt) b.textContent = txt;
    });
    const rows = Object.create(null);
    list.querySelectorAll('.mkt-sell-row[data-mkt-id]').forEach(function (r) { rows[r.getAttribute('data-mkt-id')] = r; });
    // 1) 按目标顺序更新已有行 / 补新行。已有行只改动态字段，不重排（现价浮动导致的换序
    //    会顶动用户正在点的行；下次整页重绘自然归位）。
    let prev = null;
    keys.forEach(function (id) {
      let row = rows[id];
      if (row) {
        delete rows[id];
        const cnt = row.querySelector('.cnt');
        const cntTxt = '×' + availCountOf(id);   // v0.13.9：与上架校验同口径（可用量）
        if (cnt && cnt.textContent !== cntTxt) cnt.textContent = cntTxt;
        const up = row.querySelector('.unit-price');
        const upTxt = unitPriceOf(id) + '💰';
        if (up && up.textContent !== upTxt) up.textContent = upTxt;
        const lock = row.querySelector('.mkt-lock');
        const lockHtml = rodLockBadge(id);
        if (lock && lock.innerHTML !== lockHtml) lock.innerHTML = lockHtml;
      } else {
        row = mktSellRow(id, st);
        if (prev) prev.parentNode.insertBefore(row, prev.nextSibling);
        else list.insertBefore(row, list.firstChild);
      }
      prev = row;
    });
    // 2) 剩下的行背包里已经没有了（全部售出 / 上架 / 交易掉）：移除并清掉勾选
    Object.keys(rows).forEach(function (id) { rows[id].remove(); delete mktSellPick[id]; });
    syncMktSellFoot();
    return true;
  }
  // 一键上架子窗口：统一时长 + 价格倍率（或各物品现价），逐件挂单并汇总结果
  function openBatchListModal(rawIds) {
    const st = S();
    // v0.13.9：上架走普通通道，只按**可用量**上架（持有 − 大型/巨型预留）——
    // 与 /api/market/list 的校验同口径；可用量为 0 的（纯预留 / 已卖光）不列进来。
    const ids = (rawIds || []).filter(function (id) { return availCountOf(id) > 0; });
    if (!ids.length) { toast('选中的物品没有可上架数量（可能都是大型/巨型预留）', true); return; }
    closeOverlays();
    const overlay = buildOverlay(function () { closeOverlays(); });
    const box = el('div', 'modal-box shop-modal batch-list-modal');
    let hours = 6;
    const rowsHtml = ids.map(function (id) {
      const meta = itemMeta(id);
      const qty = availCountOf(id);
      const totalHeld = st.inventory[id] || 0;
      return '<div class="bl-row"><span class="' + qualityClass(meta) + '">' + esc(meta.name) + '</span>' +
        '<span class="cnt">×' + qty + '</span>' + (totalHeld > qty ? '<span class="cnt inv-total" title="背包总量（含大型/巨型预留）">总 ×' + totalHeld + '</span>' : '') +
        '<span class="bl-unit" data-id="' + esc(id) + '">' + unitPriceOf(id) + '💰</span></div>';
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
      '<div class="hint" style="margin-top:8px">每种按「可用数量」（持有 − 大型/巨型预留）上架；上架费 = 定价总额 × 时长费率，下架/过期不退。</div>' +
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
        const qty = availCountOf(id);
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
          const qty = availCountOf(id);
          if (qty <= 0) return null;
          const price = Math.max(1, Math.round(unitPriceOf(id) * mult));
          return window.Net.marketList(id, qty, price, hours).then(function (r) {
            if (r && r.ok) {
              ok++;
              st.player.coins = r.data.coins; applyInvFrom(r.data);
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
  let invSearch = '', invPage = 1, invFilterSig = '';
  const INV_PAGE_SIZE = 12;
  // 子分类筛选（随分类页签切换显示）：
  //   鱼类/材料 → 品质；组件 → 一级「部位」 + 二级「词条 + 数值范围」
  let invSubRar = 'all';
  // v0.13.6：体型档筛选（鱼类页签）—— all / L(大型) / G(巨型)，只显示带该档标签的行
  let invTier = 'all';
  let invPart = 'all';
  let invAffixType = 'all';
  let invAffixCount = 'all';   // 组件词条数量筛选：all / 0(无词条) / 1 / 2 / 3 / 4p(4条及以上)
  let invAffixMin = '';
  let invAffixMax = '';
  let invOpen = {};          // 组件按底材名分组的展开状态（{ baseId: true }）
  let invFocus = false;      // 子筛选控件聚焦时暂停广播重绘（避免下拉被关闭）
  let bulkCat = 'all';
  let bulkRar = 'all';

  // ---- 一键出售（预览弹窗）：筛选候选 → 逐项勾选/改数量 → 确认出售 ----
  // 筛选随「种类」联动（v0.13.8）：鱼类＝品质 + 体型档，材料/宝匣＝品质，组件＝品质 + 词条数值；
  // 选「全部」时不显示细分。品质档只列该分类真实存在的档位。
  let bulkAffixType = 'all';
  let bulkAffixMin = '';
  let bulkAffixMax = '';
  let bulkTier = 'all';    // 体型筛选：all / N（一般）/ L（大型）/ G（巨型）——只对鱼类有意义
  let bulkSel = {};        // 行键 -> 勾选数量（弹窗活动清单；改筛选时保留仍匹配的勾选）
  let bulkFocus = false;   // 筛选控件聚焦时暂停广播重绘（同类：市集筛选聚焦暂停）
  function bulkAffixActive() { return bulkAffixType !== 'all' || bulkAffixMin !== '' || bulkAffixMax !== ''; }
  // 体型档加成（与服务端 SIZE_TIER_BONUS 一致）：大型 +50% / 巨型 +150%
  const BULK_TIER_BONUS = { L: 0.5, G: 1.5 };
  // v0.13.10：预览列表按「鱼种 × 通道」成行——同一条鱼的一般量 / 大型 / 巨型各占一行（与背包同一口径）。
  // 此前一个鱼种只有一行、数量恒为普通可用量：选「大型/巨型」只能整列切通道，「全部体型」也不含档位量。
  // 行键：普通通道 = 物品 id；体型档 = id + '@' + 档位（与背包体型档行的 data-id 同构）。
  function bulkRowId(key) { const i = key.indexOf('@'); return i < 0 ? key : key.slice(0, i); }
  function bulkRowTier(key) { const i = key.indexOf('@'); return i < 0 ? 'N' : key.slice(i + 1); }
  function bulkTierCn(t) { return t === 'G' ? '巨型' : t === 'L' ? '大型' : '一般'; }
  // 本次可卖上限：一般行 = 可用量（持有 − 预留）；体型档行 = 该档预留量
  function bulkMaxQtyOf(key) {
    const t = bulkRowTier(key), id = bulkRowId(key);
    return t === 'N' ? availCountOf(id) : Math.max(0, reservedCountOf(id, t));
  }
  // 展示 / 预估单价：体型档含加成
  function bulkUnitOf(key) {
    const t = bulkRowTier(key), id = bulkRowId(key);
    const u = unitPriceOf(id);
    return t === 'N' ? u : u + Math.round(u * BULK_TIER_BONUS[t]);
  }
  // 某鱼种当前要列出的行键（体型筛选在这里按通道生效）
  function bulkRowKeysOf(id) {
    const want = (bulkCat === 'fish' && bulkTier !== 'all') ? bulkTier : 'all';
    const out = [];
    if (availCountOf(id) > 0 && (want === 'all' || want === 'N')) out.push(id);
    if (itemMeta(id).kind === 'fish') {
      ['L', 'G'].forEach(function (t) {
        if (reservedCountOf(id, t) > 0 && (want === 'all' || want === t)) out.push(id + '@' + t);
      });
    }
    return out;
  }
  // 初次出现的行默认勾多少：一般行全勾，体型档行**不勾**——打开预览即全选会把加成鱼一起卖掉
  function bulkDefaultQty(key) { return bulkRowTier(key) === 'N' ? bulkMaxQtyOf(key) : 0; }
  // 子筛选随种类归一（与背包同一套规则）
  function normalizeBulkFilters() {
    if (bulkCat === 'all') {
      bulkRar = 'all'; bulkTier = 'all';
      bulkAffixType = 'all'; bulkAffixMin = ''; bulkAffixMax = '';
      return;
    }
    if (bulkCat !== 'fish') bulkTier = 'all';
    if (bulkCat !== 'component') { bulkAffixType = 'all'; bulkAffixMin = ''; bulkAffixMax = ''; }
    if (bulkRar !== 'all' && !raritiesOfKind(bulkCat).some(function (kv) { return kv[0] === bulkRar; })) bulkRar = 'all';
  }
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
  // 候选行键：种类 / 品质 / 词条按鱼种筛（bulkMatch），体型按通道筛（bulkRowKeysOf）
  function bulkCandidates() {
    const st = S();
    // 收购不收宝匣与整竿（服务端会拒）——直接不进候选，免得点了「确认出售」全是失败
    const rows = [];
    Object.keys(st.inventory).forEach(function (id) {
      const k = itemMeta(id).kind;
      if (k === 'chest' || k === 'rod' || k === 'unknown') return;
      if (!bulkMatch(id)) return;
      bulkRowKeysOf(id).forEach(function (key) { rows.push({ key: key, id: id }); });
    });
    // 排序：非组件在前（组件垫底），一般行在前、体型档行成组在后；组内按单价降序、同鱼种按一般→大型→巨型
    const order = { N: 0, L: 1, G: 2 };
    rows.sort(function (a, b) {
      const ca = itemMeta(a.id).kind === 'component' ? 1 : 0, cb = itemMeta(b.id).kind === 'component' ? 1 : 0;
      if (ca !== cb) return ca - cb;
      const ta = order[bulkRowTier(a.key)], tb = order[bulkRowTier(b.key)];
      if ((ta === 0) !== (tb === 0)) return ta === 0 ? -1 : 1;
      return unitPriceOf(b.id) - unitPriceOf(a.id) || (a.key < b.key ? -1 : 1);
    });
    return rows.map(function (r) { return r.key; });
  }
  function openBulkSellModal() {
    const st = S();
    bulkSel = {};
    // v0.13.8：预览前先跟服务端对齐一次背包。此前用本地缓存开预览，若期间背包已被
    // 自动售出 / 其它页面卖掉，列表里还是旧数量，确认时逐条被服务器拒掉（表现是「已完成 0 件」）。
    window.Net.fetchMe().then(function (r) {
      if (r && r.ok && r.data) {
        if (r.data.inventory) applyInvFrom(r.data);
        if (r.data.bigfish !== undefined) st.bigfish = r.data.bigfish || {};
        if (r.data.coins != null) st.player.coins = r.data.coins;
      }
      bulkCandidates().forEach(bulkSeedSel);
      drawBulkModal(true);
    }).catch(function () {
      bulkCandidates().forEach(bulkSeedSel);
      drawBulkModal(true);
    });
  }
  // 新出现的行给默认勾选量（一般行全勾、体型档行不勾）
  function bulkSeedSel(key) { if (bulkSel[key] == null) { const d = bulkDefaultQty(key); if (d > 0) bulkSel[key] = d; } }
  // 重绘弹窗：rebuild=true 时重置勾选（打开弹窗），否则保留仍匹配的勾选、新候选默认全选
  function drawBulkModal(rebuild) {
    const st = S();
    normalizeBulkFilters();
    const cands = bulkCandidates();
    if (rebuild) bulkSel = {};
    Object.keys(bulkSel).forEach(function (id) { if (cands.indexOf(id) < 0) delete bulkSel[id]; });
    cands.forEach(bulkSeedSel);
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
      '<div class="hint">列表按「一般 / 大型 / 巨型」分行（与背包同口径）：一般行默认勾选，体型档行需手动勾选（售出另有 +50% / +150% 加成）。词条 / 数值筛选只作用于组件。</div></div>';
    box.querySelector('.modal-close').addEventListener('click', function () { closeOverlays(); bulkFocus = false; });
    box.querySelector('.cf-cancel').addEventListener('click', function () { closeOverlays(); bulkFocus = false; });

    // ---- 筛选控件：种类常驻，其余细分随种类联动 ----
    const fwrap = box.querySelector('#bulk-filters');
    const catSel = el('select', 'bulk-select');
    catSel.id = 'bulk-cat';
    [['all', '全部种类'], ['fish', '🐟 鱼类'], ['material', '🧵 材料'], ['chest', '🎁 宝匣'], ['component', '🔧 组件']].forEach(function (kv) {
      const o = el('option', null, kv[1]); o.value = kv[0]; catSel.appendChild(o);
    });
    catSel.value = bulkCat;
    fwrap.appendChild(el('span', 'bf-sort-label', '种类'));
    fwrap.appendChild(catSel);
    const focusables = [catSel];
    // 品质：只列当前分类真实存在的档位（材料与鱼类没有神话、宝匣只有稀有/史诗）
    const rarSel = el('select', 'bulk-select');
    rarSel.id = 'bulk-rar';
    const affSel = el('select', 'bulk-select');
    affSel.id = 'bulk-aff';
    const minInp = el('input', 'aff-num');
    const maxInp = el('input', 'aff-num');
    if (bulkCat !== 'all') {
      [['all', '全部品质']].concat(raritiesOfKind(bulkCat)).forEach(function (kv) {
        const o = el('option', null, kv[1]); o.value = kv[0]; rarSel.appendChild(o);
      });
      rarSel.value = bulkRar;
      fwrap.appendChild(el('span', 'bf-sort-label', '品质'));
      fwrap.appendChild(rarSel);
      focusables.push(rarSel);
    }
    if (bulkCat === 'fish') {
      // 体型筛选：一般（普通量，走普通通道）与 大型 / 巨型（单独预留，售出额外加成）分开列
      const tierSel = el('select', 'bulk-select');
      tierSel.id = 'bulk-tier';
      [['all', '全部体型'], ['N', '一般'], ['L', '大型'], ['G', '巨型']].forEach(function (kv) {
        const o = el('option', null, kv[1]); o.value = kv[0]; tierSel.appendChild(o);
      });
      tierSel.value = bulkTier;
      tierSel.addEventListener('change', function () { bulkTier = tierSel.value; drawBulkModal(false); });
      fwrap.appendChild(el('span', 'bf-sort-label', '体型'));
      fwrap.appendChild(tierSel);
      focusables.push(tierSel);
      if (bulkTier === 'N') {
        fwrap.appendChild(el('span', 'hint', '只列普通量（按当前收购价出售，不含大型/巨型预留）'));
      } else if (bulkTier !== 'all') {
        fwrap.appendChild(el('span', 'hint', '按' + bulkTierCn(bulkTier) + '档出售（额外 +' + (bulkTier === 'G' ? '150' : '50') + '%💰），普通量不受影响'));
      }
    }
    if (bulkCat === 'component') {
      [['all', '全部词条']].concat(BD_AFFIXES.map(function (kv) { return [kv[0], kv[1]]; })).forEach(function (kv) {
        const o = el('option', null, kv[1]); o.value = kv[0]; affSel.appendChild(o);
      });
      affSel.value = bulkAffixType;
      minInp.type = 'number'; minInp.placeholder = '最小值'; minInp.value = bulkAffixMin;
      maxInp.type = 'number'; maxInp.placeholder = '最大值'; maxInp.value = bulkAffixMax;
      fwrap.appendChild(el('span', 'bf-sort-label', '词条'));
      fwrap.appendChild(affSel);
      fwrap.appendChild(minInp);
      fwrap.appendChild(el('span', 'bf-sort-label', '~'));
      fwrap.appendChild(maxInp);
      focusables.push(affSel, minInp, maxInp);
      if (bulkAffixActive()) {
        const clr = el('button', 'mini', '清除词条筛选');
        clr.addEventListener('click', function () { bulkAffixType = 'all'; bulkAffixMin = ''; bulkAffixMax = ''; drawBulkModal(false); });
        fwrap.appendChild(clr);
      }
    }
    if (bulkCat === 'all') {
      fwrap.appendChild(el('span', 'hint', '选好种类后这里会出现对应的细分筛选（鱼类＝品质/体型，材料与宝匣＝品质，组件＝品质/词条）'));
    }
    // 聚焦时暂停广播重绘（SSE 广播不会重建弹窗 DOM）
    focusables.forEach(function (n) {
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
      // 只保留「现在真的还有可卖量」的行：拿旧快照勾上的条目在确认时会被服务器拒，
      // 以前它们会静默变成 0，最后报「一键出售完成：0 件」，玩家完全不知道发生了什么。
      return cands.filter(function (key) { return (bulkSel[key] || 0) > 0 && bulkMaxQtyOf(key) > 0; })
        .map(function (key) {
          const t = bulkRowTier(key);
          return {
            id: bulkRowId(key), tier: t === 'N' ? null : t, unit: bulkUnitOf(key),
            qty: Math.max(1, Math.min(bulkMaxQtyOf(key), bulkSel[key])),
          };
        });
    }
    function refreshEst() {
      const items = selectedItems();
      const cnt = items.reduce(function (s, it) { return s + it.qty; }, 0);
      const money = items.reduce(function (s, it) { return s + (it.unit || bulkUnitOf(it.id)) * it.qty; }, 0);
      est.innerHTML = '已选 <b>' + items.length + '</b> 项 / <b>' + cnt + '</b> 件 · 预估收入 <b>' + Math.round(money) + '</b>💰<span class="muted">（按当前实时收购价）</span>';
      const go = box.querySelector('#bulk-go');
      if (go) go.classList.toggle('locked', cnt === 0);
      go.textContent = cnt > 0 ? ('确认出售（' + cnt + ' 件）') : '确认出售';
    }
    function buildRows() {
      rows.innerHTML = '';
      if (!cands.length) { rows.appendChild(el('div', 'hint', '没有符合筛选条件的物品。')); return; }
      cands.forEach(function (key) {
        const id = bulkRowId(key), tier = bulkRowTier(key);
        const meta = itemMeta(id);
        const have = bulkMaxQtyOf(key);          // 一般行 = 可用量；体型档行 = 该档预留量
        const unitShown = bulkUnitOf(key);       // 体型档含 +50% / +150% 加成后的单价
        const row = el('div', 'bulk-row-item' + (tier === 'N' ? '' : ' bulk-tier-row'));
        const affHtml = (meta.kind === 'component' && meta.affixes && meta.affixes.length)
          ? '<div class="mk-aff">' + meta.affixes.map(function (a) {
              const rng = affixRangeIn(meta, a);
              const rangeTag = rng ? '<span class="aff-rng">（' + esc(rangeText({ min: rng[0], max: rng[1] })) + '%）</span>' : '';
              return affSpanOpen(a) + esc(affixText(a)) + rangeTag + '</span>';
            }).join('') + itemTag(meta) + '</div>'
          : '';
        const tagHtml = '<span class="kind-tag ' + (tier === 'N' ? 'tag-normal' : tier === 'G' ? 'tag-giant' : 'tag-large') + '">' +
          bulkTierCn(tier) + '</span>';
        if (tier !== 'N') row.title = bulkTierCn(tier) + '鱼单独预留，售出额外 +' + (tier === 'G' ? '150' : '50') + '% 金币；默认不勾选，需手动勾选才会随「确认出售」卖出。';
        row.innerHTML = '<label class="bk-check"><input type="checkbox" data-id="' + esc(key) + '"' + ((bulkSel[key] || 0) > 0 ? ' checked' : '') + ' /></label>' +
          '<div class="bk-main"><div class="bk-name ' + qualityClass(meta) + '">' + esc(meta.name) + tagHtml + '</div>' + affHtml + '</div>' +
          '<span class="bk-have">' + (tier === 'N' ? '持有' : bulkTierCn(tier)) + ' ' + have + '</span>' +
          '<input class="bk-qty" type="number" min="1" max="' + have + '" value="' + Math.max(1, Math.min(have, bulkSel[key] || have)) + '"' + ((bulkSel[key] || 0) > 0 ? '' : ' disabled') + ' />' +
          '<span class="bk-unit">' + unitShown + '💰</span>' +
          '<span class="bk-sub">' + Math.round(unitShown * Math.max(0, bulkSel[key] || 0)) + '💰</span>';
        rows.appendChild(row);
        const cb = row.querySelector('input[type=checkbox]');
        const qi = row.querySelector('.bk-qty');
        const sub = row.querySelector('.bk-sub');
        function syncSub() { sub.textContent = Math.round(unitShown * (bulkSel[key] || 0)) + '💰'; }
        cb.addEventListener('change', function () {
          if (cb.checked) { bulkSel[key] = Math.max(1, Math.min(have, parseInt(qi.value, 10) || have)); qi.disabled = false; }
          else { delete bulkSel[key]; qi.disabled = true; }
          syncSub(); refreshEst();
        });
        qi.addEventListener('input', function () {
          if (!cb.checked) return;
          bulkSel[key] = Math.max(1, Math.min(have, parseInt(qi.value, 10) || 1));
          syncSub(); refreshEst();
        });
      });
    }
    // 数值区间变化：候选集不变时只同步可见行（不重建 DOM，避免输入框失焦）；候选集变化则重建
    let lastCandSig = '';
    function refreshBulkRows() {
      const next = bulkCandidates();
      const nowCands = {}; next.forEach(function (key) { nowCands[key] = 1; });
      Object.keys(bulkSel).forEach(function (key) { if (!nowCands[key]) delete bulkSel[key]; });
      let added = false;
      next.forEach(function (key) { const before = bulkSel[key] == null; bulkSeedSel(key); if (before && bulkSel[key] != null) added = true; });
      const sig = next.join('\u0001');
      if (added || sig !== lastCandSig) { lastCandSig = sig; buildRows(); refreshEst(); return; }
      // 候选集未变：仅同步每行勾选状态与行小计
      rows.querySelectorAll('.bulk-row-item').forEach(function (row) {
        const cbin = row.querySelector('input[type=checkbox]');
        if (!cbin) return;
        const key = cbin.getAttribute('data-id');
        const on = (bulkSel[key] || 0) > 0;
        cbin.checked = on;
        const qi = row.querySelector('.bk-qty');
        if (qi) { qi.disabled = !on; if (on) qi.value = Math.min(Number(qi.max) || 1, bulkSel[key]); }
        const sub = row.querySelector('.bk-sub');
        if (sub) sub.textContent = Math.round(bulkUnitOf(key) * (bulkSel[key] || 0)) + '💰';
      });
      refreshEst();
    }
    box.querySelector('#bulk-all').addEventListener('click', function () { cands.forEach(function (key) { bulkSel[key] = bulkMaxQtyOf(key); }); buildRows(); refreshEst(); });
    box.querySelector('#bulk-none').addEventListener('click', function () { bulkSel = {}; buildRows(); refreshEst(); });
    box.querySelector('#bulk-invert').addEventListener('click', function () {
      const inv = {};
      cands.forEach(function (key) { if (!(bulkSel[key] > 0)) inv[key] = bulkMaxQtyOf(key); });
      bulkSel = inv; buildRows(); refreshEst();
    });
    box.querySelector('#bulk-go').addEventListener('click', function () {
      const items = selectedItems();
      if (!items.length) { toast('请先勾选要出售的物品'); return; }
      const cnt = items.reduce(function (s, it) { return s + it.qty; }, 0);
      const money = items.reduce(function (s, it) { return s + (it.unit || bulkUnitOf(it.id)) * it.qty; }, 0);
      const tierCnt = items.reduce(function (s, it) { return s + (it.tier ? it.qty : 0); }, 0);
      confirmModal({
        title: '确认出售',
        html: '将出售 <b>' + items.length + '</b> 项共 <b>' + cnt + '</b> 件物品，<br>按当前收购价预计收入 <b>💰' + Math.round(money) + '</b>。' +
          (tierCnt ? '<br><span class="muted">其中大型/巨型档 <b>' + tierCnt + '</b> 件（含体型加成）</span>' : ''),
        okText: '确认出售',
      }).then(function (ok) { if (ok) bulkSellExec(items); });
    });
    buildRows();
    refreshEst();
  }
  // 执行批量出售：逐个卖给系统商店（顺序执行，避免并发覆盖资产）
  // v0.13.8：按**实时可用量**夹紧数量；跳过的条目与服务器拒绝的原因都统计出来，
  // 结束时如实汇报（不再出现「已完成 0 件」这种黑箱结果）。
  function bulkSellExec(items, label) {
    const st = S();
    let gain = 0, sold = 0, skipped = 0;
    const errs = [];
    let chain = Promise.resolve();
    const done = label || '一键出售完成';
    items.forEach(function (it) {
      chain = chain.then(function () {
        const tier = it.tier || null;    // null = 普通通道；'L' / 'G' = 体型档通道
        const cap = tier ? Math.max(0, reservedCountOf(it.id, tier)) : availCountOf(it.id);
        const qty = Math.min(cap, it.qty);
        if (qty <= 0) { skipped++; return null; }        // 已被别处卖掉 / 只剩预留量
        return window.Net.sell(it.id, qty, tier).then(function (r) {
          if (r && r.ok) {
            gain += r.data.gain; sold += qty;
            st.player.coins = r.data.coins; applyInvFrom(r.data); st.shop = r.data.shop;
            if (r.data.bigfish !== undefined) st.bigfish = r.data.bigfish || {};  // 预留计数同步（此前被丢掉）
          } else {
            skipped++;
            const msg = (r && r.data && r.data.error) || '未知错误';
            if (errs.indexOf(msg) < 0 && errs.length < 3) errs.push(msg);
          }
        });
      });
    });
    chain.then(function () {
      closeOverlays();
      renderTopbar(); renderView();
      if (!sold && skipped) {
        toast('没有卖出任何物品：' + (errs.length ? errs.join('；') : '所选物品已不在背包（可能已被自动售出或其它页面卖掉）'), true);
        return;
      }
      toast(done + '：' + sold + ' 件，共收入 💰' + gain +
        (skipped ? ('；' + skipped + ' 项未成交' + (errs.length ? '（' + errs.join('；') + '）' : '') ) : ''));
    });
  }

  // 批量出售子窗口（v0.14.0：支持一般 / 大型 / 巨型三条通道）
  // 一条鱼的三档可以各自填数量（手填或滑块），一次确认按「一般 → 大型 → 巨型」顺序逐笔卖出；
  // 档位量走服务端 tier 通道，含 +50% / +150% 金币加成。此前这个窗口只能卖普通量，
  // 于是「只有大型/巨型预留」的鱼在背包里只能一次一条慢慢点。
  let batchSellId = null;
  // 该鱼当前可卖的三条通道（没量的不列）：tier=null 为普通通道
  function batchChannelsOf(id) {
    const out = [];
    if (shownAvailOf(id) > 0) out.push({ tier: null, label: '一般', n: shownAvailOf(id), unit: unitPriceOf(id), bonus: 0 });
    ['L', 'G'].forEach(function (t) {
      const n = shownReservedOf(id, t);
      if (n > 0) out.push({ tier: t, label: t === 'G' ? '巨型' : '大型', n: n, unit: shownUnitOf(id, t), bonus: t === 'G' ? 150 : 50 });
    });
    return out;
  }
  function openBatchSellModal(id) {
    const st = S();
    const meta = itemMeta(id);
    const chans = batchChannelsOf(id);
    if (!chans.length) { toast('没有可出售的物品'); return; }
    batchSellId = id;
    closeOverlays();
    const overlay = buildOverlay(function () { closeBatchSell(); });
    const box = el('div', 'modal-box shop-modal batch-sell-modal');
    const totalHeld = st.inventory[id] || 0;
    const head = '持有 ×' + totalHeld + '（' + chans.map(function (c) { return c.label + ' ' + c.n; }).join(' · ') + '）· 现价 <b>' + unitPriceOf(id) + '</b>💰';
    box.innerHTML = '<div class="modal-head"><span class="modal-title">💰 批量出售 · ' + esc(meta.name) + '</span>' +
      '<button class="mini modal-close">✕ 关闭</button></div>' +
      '<div class="modal-body">' +
      '<div class="bs-vol" id="bs-vol">' + head + '</div>' +
      '<div class="bs-trend" id="bs-trend">价格走势加载中…</div>' +
      '<div class="bs-chans" id="bs-chans"></div>' +
      '<div class="bs-est" id="bs-est">—</div>' +
      '<button class="primary big" id="bs-go">确认出售</button>' +
      '</div>';
    overlay.appendChild(box);
    document.body.appendChild(overlay);
    box.querySelector('.modal-close').addEventListener('click', closeBatchSell);

    const est = box.querySelector('#bs-est');
    const wrap = box.querySelector('#bs-chans');
    // 每条通道一行：名称 + 档位加成 + 可卖量 + 数量框 + 滑块 + 该通道小计
    const rows = chans.map(function (c, ci) {
      const row = el('div', 'bs-chan');
      row.setAttribute('data-tier', c.tier || 'N');
      // 第一条通道沿用旧类名（bs-num / bs-range），额外的档位通道用 bs-chan-*，
      // 避免同页出现多个同名控件（既有回归断言按「唯一」判断）
      const numCls = ci === 0 ? 'bs-num' : 'bs-chan-num';
      const rngCls = ci === 0 ? 'bs-range' : 'bs-chan-range';
      row.innerHTML =
        '<div class="bs-chan-head"><span class="bs-chan-name ' + (c.tier === 'G' ? 't-giant' : c.tier === 'L' ? 't-large' : '') + '">' +
          c.label + (c.bonus ? ' <b>+' + c.bonus + '%</b>' : '') + '</span>' +
        '<span class="bs-chan-have">可卖 ×' + c.n + '</span>' +
        '<span class="bs-chan-unit">' + c.unit + '💰/个</span></div>' +
        '<div class="bs-row"><label>数量</label>' +
        '<input class="ipt ' + numCls + '" type="number" min="0" max="' + c.n + '" value="' + c.n + '" />' +
        '<button class="mini bs-max-btn">全部</button></div>' +
        '<input class="' + rngCls + '" type="range" min="0" max="' + c.n + '" value="' + c.n + '" />' +
        '<div class="bs-chan-est">—</div>';
      wrap.appendChild(row);
      const num = row.querySelector('input[type=number]');
      const range = row.querySelector('input[type=range]');
      const sub = row.querySelector('.bs-chan-est');
      const clamp = function (v) { v = Math.floor(Number(v) || 0); return Math.max(0, Math.min(c.n, v)); };
      const sync = function () {
        const q = clamp(num.value);
        if (String(q) !== String(num.value)) num.value = q;
        range.value = q;
        sub.innerHTML = '小计 <b>' + Math.round(c.unit * q) + '</b>💰' + (c.bonus && q > 0 ? '（含加成 +' + Math.round(c.unit * q - unitPriceOf(id) * q) + '）' : '');
        recalcTotal();
      };
      num.addEventListener('input', function () { range.value = clamp(num.value); sync(); });
      num.addEventListener('change', sync);
      range.addEventListener('input', function () { num.value = range.value; sync(); });
      row.querySelector('.bs-max-btn').addEventListener('click', function () { num.value = c.n; sync(); });
      return { chan: c, num: num, sync: sync };
    });
    function picked() {
      return rows.filter(function (r) { return Number(r.num.value) > 0; })
        .map(function (r) { return { id: id, tier: r.chan.tier, unit: r.chan.unit, qty: Number(r.num.value), label: r.chan.label }; });
    }
    function recalcTotal() {
      const items = picked();
      const cnt = items.reduce(function (s, it) { return s + it.qty; }, 0);
      const money = items.reduce(function (s, it) { return s + it.unit * it.qty; }, 0);
      est.innerHTML = '共售出 <b>' + cnt + '</b> 个 · 预估收入 <b>💰' + Math.round(money) + '</b>' +
        '<span class="muted">（档位量含 +50% / +150% 加成，按当前收购价）</span>';
      const go = box.querySelector('#bs-go');
      if (go) { go.classList.toggle('locked', cnt === 0); go.textContent = cnt > 0 ? ('确认出售（' + cnt + ' 个）') : '确认出售'; }
    }
    rows.forEach(function (r) { r.sync(); });

    box.querySelector('#bs-go').addEventListener('click', function () {
      const items = picked();
      if (!items.length) { toast('请先填写要出售的数量'); return; }
      const money = items.reduce(function (s, it) { return s + it.unit * it.qty; }, 0);
      confirmModal({
        title: '确认出售',
        html: '以现价出售 <b>' + esc(meta.name) + '</b>：<br>' +
          items.map(function (it) { return '· ' + it.label + ' ×' + it.qty + ' → 💰' + Math.round(it.unit * it.qty); }).join('<br>') +
          '<br>合计预计收入 <b>💰' + Math.round(money) + '</b>。',
        okText: '确认出售',
      }).then(function (ok) {
        if (!ok) return;
        // 与「一键出售」共用执行器：按实时可用量夹紧、逐笔顺序卖出、如实汇报跳过的条目
        bulkSellExec(items.map(function (it) { return { id: it.id, tier: it.tier, qty: it.qty }; }), '出售完成');
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
        t.appendChild(buildPriceChart(pts, d.base));
        t.appendChild(el('div', 'sd-legend', '近 ' + pts.length + ' 个采样 · 红=不低于基准 · 蓝=低于基准 · 悬停柱子看价格与时间'));
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
      // 区间按词缀自带范围来源解析（熔炼搬来的副件区间 / 催化 / 突破同服务端口径）
      const rng = affixRangeIn(meta, a);
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
  // 各分类实际存在的品质（来自物品目录，不是背包）：材料与鱼类没有神话，宝匣只有稀有/史诗。
  // 品质档按「该分类真实存在的档位」渲染，避免出现「神话 0」这种永远点不出东西的按钮。
  const RAR_ORDER = [['common', '普通'], ['rare', '稀有'], ['epic', '史诗'], ['mythic', '神话']];
  function raritiesOfKind(kind) {
    const set = {};
    D.allItems().forEach(function (it) { if (it.kind === kind) set[it.rarity] = 1; });
    return RAR_ORDER.filter(function (kv) { return set[kv[0]]; });
  }
  // 子筛选随分类归一：切到「全部」清空所有细分；非鱼类清掉体型档；非组件清掉部位/词条；
  // 当前分类不存在的品质档回落「全部」。
  function normalizeInvFilters() {
    if (invCategory === 'all') {
      invSubRar = 'all'; invTier = 'all';
      invPart = 'all'; invAffixCount = 'all'; invAffixType = 'all'; invAffixMin = ''; invAffixMax = '';
      return;
    }
    if (invCategory !== 'fish') invTier = 'all';
    if (invCategory !== 'component') {
      invPart = 'all'; invAffixCount = 'all'; invAffixType = 'all'; invAffixMin = ''; invAffixMax = '';
    }
    if (invSubRar !== 'all' && !raritiesOfKind(invCategory).some(function (kv) { return kv[0] === invSubRar; })) invSubRar = 'all';
  }

  function renderInvSubFilters(st) {
    const row = el('div', 'inv-subfilters');
    const invKeys = Object.keys(st.inventory);
    if (invCategory === 'all') {
      // 大分类没点开之前不显示细分筛选（细分只对具体分类有意义）
      row.appendChild(el('div', 'hint', '点开上面的分类后再选细分：鱼类＝品质 / 体型档，材料与宝匣＝品质，组件＝部位 / 词条。'));
      return row;
    }
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

      // 二级：词条数量 + 词条类型 + 数值范围
      const affRow = el('div', 'inv-subrow');
      // 词条数量筛选（放在「词条类型」筛选左侧，与部位 / 词条类型叠加生效）
      const countOpts = [['all', '全部'], ['0', '无词条'], ['1', '1条'], ['2', '2条'], ['3', '3条'], ['4p', '4+条']];
      const countWrap = el('span', 'aff-count-wrap');
      countWrap.appendChild(el('span', 'sub-label', '词条数'));
      countOpts.forEach(function (kv) {
        const b = el('button', 'inv-cat sub' + (invAffixCount === kv[0] ? ' on' : ''), kv[1]);
        b.addEventListener('click', function () { if (invAffixCount !== kv[0]) { invAffixCount = kv[0]; renderView(); } });
        countWrap.appendChild(b);
      });
      affRow.appendChild(countWrap);
      affRow.appendChild(el('span', 'sub-label', '类型'));
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
      // 鱼/材料/宝匣：品质筛选；「全部」计数与各项同口径，只统计当前分类下的物品。
      // 品质档只列出该分类真实存在的档位（材料与鱼类没有神话、宝匣只有稀有/史诗）。
      const cnt = { all: 0 };
      invKeys.forEach(function (id) {
        if (itemMeta(id).kind !== invCategory) return;
        cnt.all += 1;
        const r = itemMeta(id).rarity;
        cnt[r] = (cnt[r] || 0) + 1;
      });
      const rarRow = el('div', 'inv-subrow');
      rarRow.appendChild(el('span', 'sub-label', '品质'));
      [['all', '全部']].concat(raritiesOfKind(invCategory)).forEach(function (kv) {
        const b = el('button', 'inv-cat sub' + (invSubRar === kv[0] ? ' on' : ''), kv[1] + ' ' + (cnt[kv[0]] || 0));
        b.addEventListener('click', function () { if (invSubRar !== kv[0]) { invSubRar = kv[0]; renderView(); } });
        rarRow.appendChild(b);
      });
      row.appendChild(rarRow);
      // v0.13.6：体型档筛选（只在「🐟 鱼类」页签出现）——一般量 / 大型 / 巨型在背包中各自成行
      if (invCategory === 'fish') {
        const tc = { all: 0, N: 0, L: 0, G: 0 };
        invKeys.forEach(function (id) {
          if (itemMeta(id).kind !== 'fish') return;
          tc.all += 1;
          if (shownAvailOf(id) > 0) tc.N += 1;          // 一般量（可走普通通道）尚存的鱼种
          const bf = st.bigfish && st.bigfish[id];
          if (bf && (bf.L || 0) > 0) tc.L += 1;
          if (bf && (bf.G || 0) > 0) tc.G += 1;
        });
        const tierRow = el('div', 'inv-subrow');
        tierRow.appendChild(el('span', 'sub-label', '体型档'));
        [['all', '全部'], ['N', '一般'], ['L', '大型'], ['G', '巨型']].forEach(function (kv) {
          const b = el('button', 'inv-cat sub' + (invTier === kv[0] ? ' on' : ''), kv[1] + ' ' + (tc[kv[0]] || 0));
          b.title = kv[0] === 'all' ? '显示全部鱼（一般量 + 大型/巨型档行）'
            : kv[0] === 'N' ? '只显示一般量的鱼（可走普通通道出售 / 上架 / 交易）'
            : '只显示' + kv[1] + '档行（超出默认最大体型' + (kv[0] === 'G' ? '80% 以上' : ' 0~80%') + '，售出额外 +' + (kv[0] === 'G' ? '150' : '50') + '%💰）';
          b.addEventListener('click', function () { if (invTier !== kv[0]) { invTier = kv[0]; renderView(); } });
          tierRow.appendChild(b);
        });
        row.appendChild(tierRow);
      }
    }
    return row;
  }

  // 组件分类：按「底材名」分组、可展开；展开后逐件显示属性与操作（单独出售/上架）。
  // 组间顺序按「部位（竿身→线组→钩→饵→卷线器→配件→饰品）→ 底材名」固定排列：
  // 两个排序键都只由分组身份决定、不含任何具体实例，所以出售组件不会让分组换位。
  // （旧实现的排序读「组内第一个遇到的实例」的品质与名字，售出那件就会让整组重新排序。）
  // 组头的品质取组内最高品质、词条标签取组内类型并集，混品质的同底材组也能如实反映内容。
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
    // 组头汇总（只看组身份与当前内容，不依赖某个代表件）
    function groupQuality(g) {
      let best = 'common', bestO = 0;
      g.items.forEach(function (it) {
        const o = (it.meta && D.QUALITY_ORDER[it.meta.quality]) || 0;
        if (o > bestO) { bestO = o; best = it.meta.quality; }
      });
      return best;
    }
    function groupTypes(g) {
      const seen = [], order = D.AFFIX_TYPES || [];
      g.items.forEach(function (it) {
        ((it.meta && it.meta.affixes) || []).forEach(function (a) { if (seen.indexOf(a.type) < 0) seen.push(a.type); });
      });
      // 按固定词缀顺序展示：实例先后变化时标签不会跟着跳
      seen.sort(function (a, b) { const ia = order.indexOf(a), ib = order.indexOf(b); return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib); });
      return seen.map(function (t) { return D.AFFIX_LABEL[t] || t; }).join(' · ');
    }
    function groupTagMeta(g) {
      let bt = null, full = null;
      g.items.forEach(function (it) {
        if (!it.meta || it.meta.kind !== 'component') return;
        if (it.meta.breakthrough) bt = it.meta;
        else if (it.meta.isFull && !full) full = it.meta;
      });
      return bt || full || g.rep;
    }
    const partIndex = {};
    (D.ROD_PARTS || []).forEach(function (p, i) { partIndex[p.key] = i; });
    const groupKeys = Object.keys(groups).sort(function (a, b) {
      const ga = groups[a], gb = groups[b];
      if (!ga.rep) return 1;   // 旧版通用组件固定垫底
      if (!gb.rep) return -1;
      const pa = partIndex[ga.rep.part], pb = partIndex[gb.rep.part];
      const d = (pa == null ? 99 : pa) - (pb == null ? 99 : pb);
      if (d) return d;
      return ga.rep.baseName.localeCompare(gb.rep.baseName, 'zh');
    });
    const onlyOne = groupKeys.length === 1;

    groupKeys.forEach(function (gk) {
      const g = groups[gk];
      const totalCnt = g.items.reduce(function (n, it) { return n + st.inventory[it.id]; }, 0);
      const isOpen = onlyOne || !!invOpen[gk];
      // 组标题：底材名（品质色）+ 词条类型摘要 + 件数；点击整行展开/折叠
      const head = el('div', 'inv-group-head clickable' + (isOpen ? ' open' : ''));
      const types = g.rep ? groupTypes(g) : '旧版通用组件';
      const priceRange = (function () {
        const ps = g.items.map(function (it) { return unitPrice(it.id); });
        const lo = Math.min.apply(null, ps), hi = Math.max.apply(null, ps);
        return lo === hi ? (lo + '💰') : (lo + ' ~ ' + hi + '💰');
      })();
      const lockCnt = g.items.reduce(function (n, it) { return n + (rodLockCount(it.id) > 0 ? 1 : 0); }, 0);
      head.setAttribute('data-group', gk); // 出售后就地更新组头计数用
      head.innerHTML = '<span class="caret">' + (isOpen ? '▾' : '▸') + '</span>' +
        '<span class="' + qualityClass(g.rep ? { kind: 'component', quality: groupQuality(g), isFull: g.items.some(function (it) { return it.meta && it.meta.isFull; }) } : null) + '">' + esc(g.rep ? g.rep.baseName : '旧版组件') + '</span>' +
        (lockCnt ? '<span class="rod-lock" title="该组有组件被钓竿占用（已锁定，不可单独交易）">🔒 ' + lockCnt + ' 种</span>' : '') +
        itemTag(groupTagMeta(g)) +
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
        row.setAttribute('data-id', it.id);        // 出售后就地更新这一行（不整页重建）
        row.setAttribute('data-group', gk);        // 组头计数同步用
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
        markFeature(sb, 'mall.sell');
        sb.title = '单独出售这 1 件（系统固定价）';
        sb.addEventListener('click', function () { doSell(it.id, 1); });
        acts.appendChild(sb);
        const sa = el('button', 'mini', '批量出售');
        markFeature(sa, 'mall.sell');
        sa.addEventListener('click', function () { openBatchSellModal(it.id); });
        acts.appendChild(sa);
        const lb = el('button', 'mini', '上架');
        markFeature(lb, 'mall.list');
        lb.addEventListener('click', function () { openListModal(it.id); });
        acts.appendChild(lb);
        row.appendChild(acts);
        list.appendChild(row);
      });
    });
  }

  // 出售后只更新受影响的行（数量 / 小计；售罄则移除该行，空组连组头一起去掉），
  // 并同步右栏概览与分类计数——不整页重建：展开的组件分组、列表顺序、滚动位置全部保持
  //（此前整页重绘会让列表按新价格重排，还可能把展开的配件栏收起来）。
  // 返回 false 表示没找到对应行（例如被筛选隐藏）→ 调用方退回整页重绘兜底。
  function patchInventoryRow(id) {
    const st = S();
    const row = document.querySelector('.inv-page-row[data-id="' + id + '"]');
    if (!row) return false;
    const meta = itemMeta(id);
    const total = st.inventory[id] || 0;
    // v0.13.9：一般行代表「普通量」，与 renderInventory / 服务端校验同口径（鱼类扣掉大型/巨型预留）
    // v0.13.10：再扣掉「在途出售量」——出售后不必等回包，那一行当场就变（回包对账后仍是这个口径）
    const cnt = meta.kind === 'fish' ? Math.min(total, shownAvailOf(id)) : total;
    if (cnt > 0) {
      const c = row.querySelector('.cnt');
      if (c) c.textContent = '×' + cnt;
      const sub = row.querySelector('.subtotal');
      if (sub) sub.textContent = '小计 ' + (unitPriceOf(id) * cnt) + '💰';
      const tot = row.querySelector('.inv-total');
      if (tot) tot.textContent = '总 ×' + total;
    } else {
      // 普通量归零 → 去掉一般行（与 renderInventory 同口径：鱼若还有预留量，下面的档位行仍在）
      const gk = row.getAttribute('data-group');
      row.remove();
      if (gk) {
        const rest = document.querySelectorAll('.inv-page-row[data-group="' + gk + '"]');
        const head = document.querySelector('.inv-group-head[data-group="' + gk + '"]');
        if (head) {
          if (!rest.length) head.remove();
          else {
            let total = 0;
            rest.forEach(function (r) { total += (st.inventory[r.getAttribute('data-id')] || 0); });
            const box = head.querySelector('.inv-group-cnt');
            if (box) box.textContent = '共 ' + total + ' 个 / ' + rest.length + ' 种';
          }
        }
      }
    }
    // 分类计数 / 右栏概览：按服务器权威的 inventory 重算
    patchInventoryNumbers(st);
    return true;
  }

  // 背包「分类页签计数 + 右栏概览」：出售后与数据广播就地刷新共用（同一套口径）
  function patchInventoryNumbers(st) {
    const kinds = { fish: 0, material: 0, chest: 0, component: 0 };
    let kindsAll = 0, totalCnt = 0, totalValue = 0, totalReserved = 0;
    Object.keys(st.inventory).forEach(function (k) {
      if ((st.inventory[k] || 0) <= 0) return;
      kindsAll++;
      totalCnt += st.inventory[k];
      totalValue += itemMeta(k).price * st.inventory[k];
      const kk = itemMeta(k).kind;
      if (kinds[kk] != null) kinds[kk]++;
      if (kk === 'fish') totalReserved += reservedCountOf(k);
    });
    const tabsEl = document.querySelector('.inv-page-tabs');
    if (tabsEl) {
      const labels = ['📦 全部', '🐟 鱼类', '🧵 材料', '🎁 宝匣', '🔧 组件'];
      const nums = [kindsAll, kinds.fish, kinds.material, kinds.chest, kinds.component];
      tabsEl.querySelectorAll('.inv-cat').forEach(function (b, i) {
        if (labels[i]) b.textContent = labels[i] + ' ' + nums[i];
      });
    }
    const boxes = document.querySelectorAll('.col-side .codex-summary .cs-box b');
    if (boxes.length === 3) {
      boxes[0].textContent = kindsAll;
      boxes[1].textContent = totalCnt;
      boxes[2].textContent = totalValue;
    }
    const rsv = document.querySelector('.col-side .inv-reserved');
    if (rsv) {
      rsv.innerHTML = totalReserved > 0
        ? '其中大型/巨型预留 <b>' + totalReserved + '</b> 件（共 ' + (totalCnt - totalReserved) + ' 件普通量可在本页出售 / 上架 / 交易）'
        : '';
    }
    const bd = document.querySelector('.col-side .inv-breakdown');
    if (bd) {
      bd.innerHTML = [['fish', '🐟 鱼类'], ['material', '🧵 材料'], ['chest', '🎁 宝匣'], ['component', '🔧 组件']]
        .filter(function (kv) { return kinds[kv[0]]; })
        .map(function (kv) { return '<div class="inv-kind-line">' + kv[1] + '　' + kinds[kv[0]] + ' 种</div>'; }).join('');
    }
    return true;
  }

  // 背包：数据广播（上鱼 / 自动售出 / 别处出售带来 assets）的就地刷新。
  // v0.14.0：此前只有行情广播（shop/pricecfg）走就地补丁，assets 一律整页重建 —— 挂机每 1.5 秒
  // 上一条鱼就把整页重建一次（实测一次重建 125 个按钮），页签 / 出售 / 上架 / 下架按钮肉眼可见地闪，
  // 组件的展开状态与滚动位置也每次都被冲掉。现在按结构签名判断：
  //   · 签名一致（没有新鱼种、没有卖光、筛选没变）→ 只刷行内数量 / 价格 / 小计 / 概览，一个节点都不重建；
  //   · 签名变了 → 返回 false，交给调用方整页重建（此时列表结构本来就该变）。
  // 逐行数字复用「出售后就地补丁」同一套函数，避免两条路两套口径。
  function patchInventoryLive() {
    const main = $('main');
    if (!main || !main.querySelector('.inv-page-tabs')) return false;
    const host = main.querySelector('.inv-page');
    const st = S();
    if (!host || host.getAttribute('data-sig') !== invSigOf(st)) return false;
    main.querySelectorAll('.inv-page-row[data-id]').forEach(function (row) {
      const key = row.getAttribute('data-id');
      const i = key.indexOf('@');
      if (i < 0) patchInventoryRow(key);
      else patchInventoryTierRow(key.slice(0, i), key.slice(i + 1));
    });
    patchInventoryNumbers(st);          // 页签计数 + 右栏概览（总件数 / 预估总价 / 预留量）
    patchInventoryGroupHeads(st);       // 组件分组头：共 X 个 / Y 种
    patchInventoryPrices();             // 行内价格 + 分组价格区间（与行情广播同一条路）
    return true;
  }
  // 组件分组头的「共 X 个 / Y 种」：数量随资产广播变（分组本身不变，因为底材不会变）
  function patchInventoryGroupHeads(st) {
    const main = $('main');
    if (!main) return;
    main.querySelectorAll('.inv-group-head[data-group]').forEach(function (head) {
      const gk = head.getAttribute('data-group');
      const rows = main.querySelectorAll('.inv-page-row[data-group="' + gk + '"]');
      let total = 0;
      rows.forEach(function (r) { total += (st.inventory[r.getAttribute('data-id')] || 0); });
      const box = head.querySelector('.inv-group-cnt');
      if (box) box.textContent = '共 ' + total + ' 个 / ' + rows.length + ' 种';
    });
  }

  // 体型档行（大型 / 巨型）的就地补丁：数量按「服务器预留量 − 在途出售量」，归零就把这一行去掉。
  // 返回 false 表示行不在（被筛选隐藏 / 已经没有预留），调用方兜底整页重绘。
  function patchInventoryTierRow(id, tier) {
    const row = document.querySelector('.inv-tier-row[data-id="' + id + '@' + tier + '"]');
    if (!row) return false;
    const n = shownReservedOf(id, tier);
    if (n <= 0) { row.remove(); return true; }
    const u = unitPriceOf(id);
    const bonus = function (q) { return Math.round(u * q * (tier === 'G' ? 1.5 : 0.5)); };
    const c = row.querySelector('.cnt');
    if (c) c.textContent = '×' + n;
    const up = row.querySelector('.unit-price');
    if (up) up.textContent = '现价 ' + u + '💰 +' + bonus(1) + '💰';
    const sub = row.querySelector('.subtotal');
    if (sub) sub.textContent = '小计 ' + (u * n + bonus(n)) + '💰';
    return true;
  }
  // 出售后就地校准：优先补丁那一行，行不在了（例如刚被卖掉 / 被筛选隐藏）才整页重绘
  function patchRowOrView(id, tier) {
    if (currentView === 'inventory') {
      const host = document.querySelector('.inv-page');
      if (host && host.getAttribute('data-sig') !== invSigOf(S())) { renderView(); return; }
    }
    if (tier) { if (!patchInventoryTierRow(id, tier)) renderView(); return; }
    if (!patchInventoryRow(id)) renderView();
  }

  // 背包：行情广播（出售会改变动态收购价）只更新行内价格，不整页重建——
  // 否则每次出售都按新价格重排列表、还可能把展开的组件分组收起来（用户反馈的问题来源）。
  // 返回 false 表示当前不在背包页（或被筛选隐藏的项对不上，交给调用方兜底）。
  function patchInventoryPrices() {
    const main = $('main');
    const st = S();
    if (!main || !main.querySelector('.inv-page-tabs')) return false;
    const price = function (id) { return unitPriceOf(id); };
    main.querySelectorAll('.inv-page-row[data-id]').forEach(function (row) {
      const id = row.getAttribute('data-id');
      if ((st.inventory[id] || 0) <= 0) return;
      const up = row.querySelector('.unit-price');
      if (up) up.textContent = '现价 ' + price(id) + '💰';
      const sub = row.querySelector('.subtotal');
      if (sub) sub.textContent = '小计 ' + (price(id) * st.inventory[id]) + '💰';
    });
    // 组件分组头的价格区间同样随行情变
    main.querySelectorAll('.inv-group-head[data-group]').forEach(function (head) {
      const box = head.querySelector('.inv-group-price');
      if (!box) return;
      const rows = main.querySelectorAll('.inv-page-row[data-group="' + head.getAttribute('data-group') + '"]');
      const ps = Array.prototype.map.call(rows, function (r) { return price(r.getAttribute('data-id')); });
      if (!ps.length) return;
      const lo = Math.min.apply(null, ps), hi = Math.max.apply(null, ps);
      box.textContent = lo === hi ? (lo + '💰') : (lo + ' ~ ' + hi + '💰');
    });
    return true;
  }

  // ---- 物品简介（v0.11.8）----
  // 背包里鼠标停一下给轻量浮标（这是什么 / 现价 / 干嘛用），点一下开完整简介：
  // 图片 + 一句话简介 + 用途 + 产地或合成配方 + 持有量与图鉴纪录。
  // 鱼 / 材料 / 宝匣走这里；组件仍走原有的「属性」窗口（openComponentDetail）。
  // 文案全部由实际机制与当前后台配置现算（宝匣用配置里的 desc），不另写死一份说明。
  function itemKindName(it) {
    return it.kind === 'fish' ? '渔获' : it.kind === 'material' ? '材料' : it.kind === 'chest' ? '宝匣' : it.kind === 'component' ? '组件' : '物品';
  }
  function itemIconSrc(it) {
    if (it.kind === 'fish') return 'assets/fish/' + it.id + '.png';
    if (it.kind === 'material' || it.kind === 'chest' || it.kind === 'component') return 'assets/item/' + it.id + '.png';
    return '';
  }
  function itemIconHtml(it, cls) {
    const src = itemIconSrc(it);
    if (!src) return '';
    return '<img class="' + cls + '" src="' + esc(src) + '" alt="" draggable="false" onerror="this.style.display=\'none\'">';
  }
  // 一句话简介
  function itemBriefText(it) {
    if (it.kind === 'chest') return (it.chest && it.chest.desc) || '宝匣：开启后获得带词条的组件。';
    if (it.kind === 'fish') {
      const spots = D.spotsOf(it.id);
      return qualityName(it) + '渔获 · 体型 ' + it.size[0] + '~' + it.size[1] + 'cm' +
        (spots.length ? ' · 见于 ' + spots[0] + (spots.length > 1 ? ' 等 ' + spots.length + ' 处' : '') : '');
    }
    if (it.kind === 'material') {
      if (it.id === D.SMELT_PEARL) return '熔炼催化剂：让熔炼的每条词条 roll 两次、取更靠近区间边界的那次。';
      const aff = D.smeltMaterialAffix(it.id);
      if (aff) {
        return '熔炼催化剂 → 定向补「' + (D.AFFIX_LABEL[aff] || aff) + '」词缀' +
          (it.id === 'relic' ? '；另用于合成宝匣、工坊残片保留与重铸。' : '。');
      }
      return qualityName(it) + '材料 · 可在系统商店出售，或挂到开放市集。';
    }
    return qualityName(it) + '物品。';
  }
  // 用途条目（数值与开关全部读当前后台配置）
  function itemUses(it) {
    const cfg = (D.getSmeltCfg && D.getSmeltCfg()) || {};
    const out = [];
    if (it.kind === 'chest') {
      const c = it.chest || {};
      out.push('开启：在「⚒ 工坊 · 开箱」页消耗 <b>' + (c.costRelic || 0) + '</b> 片沉船宝匣残片 + <b>' + (c.costCoins || 0) + '</b>💰 开箱');
      out.push('选材：' + (c.mode === 'part' ? '自选部位' : c.mode === 'base' ? '自选底材' : '随机部位'));
      const w = Object.keys(c.qualityWeights || {}).map(function (k) {
        return (D.QUALITY[k] ? D.QUALITY[k].name : k) + ' ' + c.qualityWeights[k] + '%';
      }).join(' / ');
      if (w) out.push('产出品质：' + w);
      if (c.forceMax) out.push('词条：填满所选底材的全部词缀池');
      else if (c.hitCount) {
        out.push('词条数：' + (c.chance != null ? Math.round(c.chance * 100) + '% 概率 ' : '') + c.hitCount + ' 条' +
          (c.chance != null ? ' / ' + Math.round((1 - c.chance) * 100) + '% 概率 ' + c.missCount + ' 条' : '') +
          (c.extra ? '（多出的那条是池外词缀：海王遗匣产生的是突破词缀）' : ''));
      } else if (c.minAffixes) out.push('词条数：至少 ' + c.minAffixes + ' 条');
      out.push('交易：收购不收宝匣，只能挂到商城的市集页');
    } else if (it.kind === 'fish') {
      out.push('出售：商城「收购」页按现价动态出售（卖出越多价越低）');
      out.push('挂单：商城「市集」页上架付定价总额 1% 上架费，成交另收 10% 税');
      out.push('记录：计入「📖 图鉴」与「🏆 记录」的大小鱼榜');
    } else {
      const aff = D.smeltMaterialAffix && D.smeltMaterialAffix(it.id);
      if (it.id === D.SMELT_PEARL) out.push('熔炼：作为催化剂（每件熔炼至多 1 个），让每条词条 roll 两次取更靠近边界的值');
      else if (aff) {
        out.push('熔炼催化剂：对应「' + (D.AFFIX_LABEL[aff] || aff) + '」词缀 —— 投得最多的那种材料决定补哪条，每份 ' +
          (cfg.extraRatePerMaterial || 0) + '% 补缀率、失败率 ' + (cfg.failPerMaterial || 0) + '%');
      }
      if (it.id === 'relic') {
        out.push('宝匣：合成各档宝匣的主材料（' + (D.CHESTS || []).map(function (c) { return c.name + ' ' + c.costRelic + ' 片'; }).join(' · ') + '）');
        out.push('熔炼：残片保留（按后台公式 ' + (cfg.retainFormula || '?') + ' 计算每片保留池外词缀的概率；公式变量 breakthrough 只数突破词缀）+ 重铸（洗词条数值）');
      }
      out.push('出售 / 挂单：系统商店 ' + (it.price || 0) + '💰，也可挂到开放市集');
    }
    return out;
  }
  function itemDetailHtml(id) {
    const st = S();
    const it = itemMeta(id);
    const shopP = st.shop && st.shop[id];
    const rec = (st.codex && st.codex[id]) || null;
    const spots = D.spotsOf(id);
    let html = itemIconHtml(it, 'cd-icon') +
      '<div class="cd-title ' + qualityClass(it) + '">' + esc(it.name) + '</div>' +
      '<div class="cd-line">' + esc(itemKindName(it)) + ' · ' + esc(qualityName(it)) + ' · 基准价 ' + (it.price || 0) + '💰' +
      (shopP ? ' · 现价 <b>' + shopP.price + '💰</b>' : '') + '</div>' +
      '<div class="cd-line">背包持有 <b>×' + (st.inventory[id] || 0) + '</b>' +
      (reservedCountOf(id) > 0 ? '（其中大型/巨型预留 ' + reservedCountOf(id) + '，可出售/上架/交易 ' + availCountOf(id) + '）' : '') +
      (it.size ? ' · 体型 ' + it.size[0] + '~' + it.size[1] + ' cm' : '') + '</div>' +
      (rec && it.kind !== 'chest'
        ? '<div class="cd-line muted">图鉴：' + (it.kind === 'fish' ? '已钓 ' : '已获得 ') + rec.count + ' 次（首获 ' + timeStr(rec.first) + '）' +
          (rec.max != null ? ' · 最大 ' + rec.max + ' cm / 最小 ' + rec.min + ' cm' : '') + '</div>'
        : '') +
      '<div class="cd-desc">' + esc(itemBriefText(it)) + '</div>' +
      '<div class="cd-sub">🧭 用途</div><ul class="cd-uses">' +
      itemUses(it).map(function (t) { return '<li>' + t + '</li>'; }).join('') + '</ul>';
    if (it.kind === 'chest') {
      html += '<div class="cd-sub">📦 来源</div><div class="cd-line muted">在「⚒ 工坊 · 开箱」页用沉船宝匣残片 + 金币合成；残片来自钓鱼掉落与商城。</div>';
    } else if (spots.length) {
      html += '<div class="cd-sub">📍 产出地点（全部 ' + spots.length + ' 处）</div><div class="cd-spots">' +
        spots.map(function (s) { return '<div class="cd-spot">🎣 ' + esc(s) + '</div>'; }).join('') + '</div>';
    } else {
      html += '<div class="cd-line muted">暂无产地信息。</div>';
    }
    return html;
  }
  function openItemDetail(id) {
    const it = itemMeta(id);
    if (it.kind === 'component') return openComponentDetail(id);   // 组件沿用原有「属性」窗口
    closeOverlays();
    const overlay = buildOverlay(function () { closeOverlays(); });
    const box = el('div', 'modal-box codex-modal item-detail-modal');
    box.innerHTML = '<div class="modal-head"><span class="modal-title">' + esc(it.name) + '</span>' +
      '<button class="mini modal-close">✕ 关闭</button></div>' +
      '<div class="modal-body"><div class="codex-detail"></div></div>';
    overlay.appendChild(box);
    document.body.appendChild(overlay);
    box.querySelector('.modal-close').addEventListener('click', function () { closeOverlays(); });
    box.querySelector('.codex-detail').innerHTML = itemDetailHtml(id);
  }
  // 悬停浮标：跟着光标走且不出界；内容只在换了物品时重画
  let itemTipEl = null, itemTipId = '';
  function itemTipNode() {
    if (!itemTipEl) {
      itemTipEl = el('div', 'item-tip');
      document.body.appendChild(itemTipEl);
      document.addEventListener('scroll', function () { hideItemTip(); }, true);
    }
    return itemTipEl;
  }
  function hideItemTip() {
    if (itemTipEl) itemTipEl.classList.remove('show');
    itemTipId = '';
  }
  function placeItemTip(x, y) {
    const tip = itemTipNode();
    const r = tip.getBoundingClientRect();
    let left = x + 16, top = y + 16;
    if (left + r.width > window.innerWidth - 10) left = Math.max(10, x - r.width - 16);
    if (top + r.height > window.innerHeight - 10) top = Math.max(10, y - r.height - 16);
    tip.style.left = left + 'px';
    tip.style.top = top + 'px';
  }
  function showItemTip(id, x, y) {
    const st = S();
    const it = itemMeta(id);
    const tip = itemTipNode();
    if (id !== itemTipId) {
      const shopP = st.shop && st.shop[id];
      tip.innerHTML = itemIconHtml(it, 'it-icon') +
        '<div class="it-name ' + qualityClass(it) + '">' + esc(it.name) + '</div>' +
        '<div class="it-line">' + esc(itemKindName(it)) + ' · ' + esc(qualityName(it)) + ' · ' +
        (shopP ? '现价 ' + shopP.price + '💰' : '基准价 ' + (it.price || 0) + '💰') + ' · 持有 ×' + (st.inventory[id] || 0) +
        (reservedCountOf(id) > 0 ? '（可用 ' + availCountOf(id) + '）' : '') + '</div>' +
        '<div class="it-desc">' + esc(itemBriefText(it)) + '</div>' +
        '<div class="it-hint">点击查看完整简介</div>';
      itemTipId = id;
    }
    tip.classList.add('show');
    placeItemTip(x, y);
  }
  // 给背包里的鱼 / 材料 / 宝匣行挂上「悬停简介 + 点击详情」（组件行已有「属性」按钮，不接）
  function wireItemIntro(row, id) {
    if (itemMeta(id).kind === 'component') return;
    row.classList.add('clickable');
    // 不设 row.title：原生浮框晚一拍才冒出来、还会叠在自绘浮标上，像卡出的白框。
    row.addEventListener('mouseenter', function (e) { showItemTip(id, e.clientX, e.clientY); });
    row.addEventListener('mousemove', function (e) { if (itemTipId) placeItemTip(e.clientX, e.clientY); });
    row.addEventListener('mouseleave', hideItemTip);
    row.addEventListener('click', function (e) {
      if (e.target.closest('button')) return;   // 点的是出售 / 上架等按钮，不弹简介
      hideItemTip();
      openItemDetail(id);
    });
  }

  // v0.14.0：背包列表的**结构签名**与行计划（渲染与就地补丁共用同一套筛选/排序代码，
  // 避免「补丁」和「重建」得出两套数字——这是本项目反复踩过的坑）。
  // 签名只包含会改变 DOM 结构的量：当前筛选 + 列表里应有的行键（含一般行 / 大型 / 巨型档行）。
  // 数量、价格、总件数这些纯数据不进签名，它们由就地补丁更新。
  function invListPlan(st) {
    let keys = Object.keys(st.inventory).filter(function (id) { return (st.inventory[id] || 0) > 0; });
    if (invCategory !== 'all') keys = keys.filter(function (id) { return itemMeta(id).kind === invCategory; });
    if (invCategory === 'component') {
      // 组件：一级按部位、二级按词条+数值范围筛选；列表按底材名分组可展开
      keys = keys.filter(function (id) {
        const m = itemMeta(id);
        if (invPart !== 'all' && (m.part || '') !== invPart) return false;
        if (invAffixCount !== 'all') {
          const n = (m.affixes || []).length;
          if (invAffixCount === '0' && n !== 0) return false;
          if (invAffixCount === '1' && n !== 1) return false;
          if (invAffixCount === '2' && n !== 2) return false;
          if (invAffixCount === '3' && n !== 3) return false;
          if (invAffixCount === '4p' && n < 4) return false;
        }
        if (invAffixType === 'all' && invAffixMin === '' && invAffixMax === '') return true;
        if (!m.affixes) return false;
        return m.affixes.some(function (a) {
          if (invAffixType !== 'all' && a.type !== invAffixType) return false;
          if (invAffixMin !== '' && a.value < Number(invAffixMin)) return false;
          if (invAffixMax !== '' && a.value > Number(invAffixMax)) return false;
          return true;
        });
      });
      keys.sort(function (a, b) { return a < b ? -1 : 1; });   // 组件行序由分组决定，这里只要确定性
    } else if (invSubRar !== 'all') {
      keys = keys.filter(function (id) { return itemMeta(id).rarity === invSubRar; });
    }
    // v0.13.6：体型档筛选——一般（普通量）/ 大型 / 巨型 各自对应一种行。
    // ⚠️ 必须限定在「🐟 鱼类」页签：这个筛选行只在鱼类页签渲染，若让它跨分类生效，
    // 切到材料/宝匣时会被静默过滤成空列表，而且界面上去不掉（v0.13.8 修）。
    // v0.13.10：筛选同时作用到「行」——选一般只看一般行事，选大型/巨型只看该档行（与一键出售预览同口径）。
    const tierShown = (invTier !== 'all' && invCategory === 'fish') ? invTier : 'all';
    if (tierShown !== 'all') {
      keys = keys.filter(function (id) {
        const meta0 = itemMeta(id);
        if (meta0.kind !== 'fish') return false;
        return tierShown === 'N' ? shownAvailOf(id) > 0 : reservedCountOf(id, tierShown) > 0;
      });
    }
    // 按单价排序：出售/获得不改变行位置（排序与数量无关）
    if (invCategory !== 'component') keys.sort(function (a, b) { return unitPriceOf(b) - unitPriceOf(a) || (a < b ? -1 : 1); });
    const query = invSearch.trim().toLocaleLowerCase();
    if (query) keys = keys.filter(function (id) {
      const m = itemMeta(id);
      const text = [m.name, m.baseName, partNameOf(m.part), qualityName(m)]
        .concat((m.affixes || []).map(affixText)).join(' ').toLocaleLowerCase();
      return query.split(/\s+/).every(function (word) { return text.indexOf(word) >= 0; });
    });
    const filterSig = JSON.stringify([invCategory, invSubRar, invTier, invPart,
      invAffixCount, invAffixType, invAffixMin, invAffixMax, query]);
    if (filterSig !== invFilterSig) { invPage = 1; invFilterSig = filterSig; }
    const total = keys.length, pages = Math.max(1, Math.ceil(total / INV_PAGE_SIZE));
    invPage = Math.max(1, Math.min(invPage, pages));
    return { keys: keys.slice((invPage - 1) * INV_PAGE_SIZE, invPage * INV_PAGE_SIZE),
      tierShown: tierShown, total: total, pages: pages };
  }
  // 行计划：每行一个键（一般行 = 物品 id；体型档行 = id@档位），与行内 data-id 完全一致
  function invRowsPlan(plan, st) {
    const out = [];
    plan.keys.forEach(function (id) {
      const meta = itemMeta(id);
      const total = st.inventory[id] || 0;
      const cnt = meta.kind === 'fish' ? Math.min(total, shownAvailOf(id)) : total;
      if (cnt > 0 && (plan.tierShown === 'all' || plan.tierShown === 'N')) out.push(id);
      if (meta.kind === 'fish') {
        ['L', 'G'].forEach(function (t) {
          if (shownReservedOf(id, t) > 0 && (plan.tierShown === 'all' || plan.tierShown === t)) out.push(id + '@' + t);
        });
      }
    });
    return out;
  }
  function invSigOf(st) {
    const plan = invListPlan(st);
    return 'inv|' + invCategory + '|' + invSubRar + '|' + invTier + '|' + invPart + '|' + invAffixCount + '|' +
      invAffixType + '|' + invAffixMin + '|' + invAffixMax + '|' + invSearch + '|' + invPage + '|' + plan.total + '|' + invRowsPlan(plan, st).join(',') + '|' + myListingSig(st);
  }
  // 我的挂单结构（下架 / 被买走后要重建这一块）：只在挂单本身变化时才让签名变
  function myListingSig(st) {
    const me = st.me && st.me.id != null ? String(st.me.id).toLowerCase() : '';
    return (st.market || []).filter(function (l) { return me && String(l.seller).toLowerCase() === me; })
      .map(function (l) { return l.lid + ':' + l.qty + ':' + l.price; }).sort().join(',');
  }

  function renderInventory() {
    const main = $('main');
    const st = S();
    // v0.13.9：只认「持有 > 0」的条目——服务端 invAdd 减到 0 会删键，但管理后台快照 /
    // 开发种子接口可能留下 0 件键；全量渲染与 patchInventoryRow 必须同口径，否则同一页两套数字。
    const invKeys = Object.keys(st.inventory).filter(function (id) { return (st.inventory[id] || 0) > 0; });
    // 进入背包即视为已读订阅提醒（清红标与图标闪烁）
    clearSubAlerts(false);
    // v0.13.8：子筛选只在「点开的大分类」下显示，切分类时把该分类用不到的筛选归一清零——
    // 否则会留下「神话 / 大型」这类对当前分类不存在的筛选，界面上一片空列表且无处可清。
    normalizeInvFilters();
    main.innerHTML = '';
    const panel = el('div', 'panel wide two-col inventory-panel');
    panel.innerHTML = pageHead('🎒', '背包', '渔获 / 材料 / 宝匣 / 组件分类存放；出售、上架与订阅都在这里') +
      pageHelp('上方页签切换分类，每页 12 项；搜索框支持名称、部位、品质与词条，点物品可看简介与用途。');
    // 交易进行中：背包内容锁定（新渔获不会自动刷新列表，避免交易选物品时被冲掉）
    if (tradeLockOn()) panel.appendChild(tradeLockBar());

    // 现价优先（服务器动态价），无行情时退回基准价
    function unitPrice(id) { const s = st.shop && st.shop[id]; return s ? s.price : itemMeta(id).price; }
    function itemValue(id) { return unitPrice(id) * st.inventory[id]; }
    // v0.13.6：某种鱼的大型/巨型预留计数（无则 0）
    function reservedOf(id, tier) {
      const bf = st.bigfish && st.bigfish[id];
      if (!bf) return 0;
      return tier ? (bf[tier] || 0) : ((bf.L || 0) + (bf.G || 0));
    }
    function tierBonus(id, tier, n) { return Math.round(unitPrice(id) * (n || 1) * (tier === 'G' ? 1.5 : 0.5)); }
    function doSell(id, qty, tier) {
      // v0.13.10 本地实时刷新：点击当场按账本扣显示量 + 加金币 + 就地补丁，**不等服务器回包**；
      // 回包后按服务器权威值对账（库存 / 金币 / 行情）并撤掉在途记录 —— 见顶部 sellNow()。
      return sellNow({
        id: id, qty: qty, tier: tier,
        onLocal: function () { patchRowOrView(id, tier); },
        onSync: function () { patchRowOrView(id, tier); },
      });
    }
    function listFee(price, qty) { return Math.ceil(price * qty * 0.01); }

    // 分类页签（重绘间保留当前选择）
    const kindCount = { fish: 0, material: 0, chest: 0, component: 0 };
    invKeys.forEach(function (id) {
      const k = itemMeta(id).kind;
      if (kindCount[k] != null) kindCount[k] += 1;
    });
    const tabs = el('div', 'inv-cats inv-page-tabs');
    [['all', '📦 全部', invKeys.length], ['fish', '🐟 鱼类', kindCount.fish], ['material', '🧵 材料', kindCount.material], ['chest', '🎁 宝匣', kindCount.chest], ['component', '🔧 组件', kindCount.component]].forEach(function (kv) {
      const b = el('button', 'inv-cat' + (invCategory === kv[0] ? ' on' : ''), kv[1] + ' ' + kv[2]);
      b.addEventListener('click', function () { if (invCategory !== kv[0]) { invCategory = kv[0]; renderView(); } });
      tabs.appendChild(b);
    });

    const colMain = el('div', 'col-main');
    colMain.appendChild(el('h3', null, '📦 物品明细'));
    colMain.appendChild(tabs);
    const searchForm = el('form', 'inv-search');
    const searchInput = el('input', 'ipt');
    searchInput.type = 'search'; searchInput.value = invSearch;
    searchInput.placeholder = '搜索名称、部位、品质或词条';
    searchInput.setAttribute('aria-label', '搜索背包');
    const searchButton = el('button', 'mini primary-mini', '搜索');
    searchButton.type = 'submit';
    const clearSearch = el('button', 'mini', '清空');
    clearSearch.type = 'button';
    searchForm.appendChild(searchInput); searchForm.appendChild(searchButton); searchForm.appendChild(clearSearch);
    searchForm.addEventListener('submit', function (ev) {
      ev.preventDefault(); invSearch = searchInput.value.trim(); invPage = 1; renderView();
    });
    clearSearch.addEventListener('click', function () { invSearch = ''; invPage = 1; renderView(); });
    colMain.appendChild(searchForm);
    colMain.appendChild(renderInvSubFilters(st)); // 子分类行（品质 / 部位 / 词条+数值）
    const list = el('div', 'inv-page');
    // 行计划（筛选 / 排序）与结构签名：就地补丁（patchInventoryLive）按同一个签名判断能否不重建
    const plan = invListPlan(st);
    const keys = plan.keys;
    const tierShown = plan.tierShown;
    list.setAttribute('data-sig', invSigOf(st));
    if (keys.length === 0) {
      list.appendChild(el('div', 'hint', Object.keys(st.inventory).length === 0
        ? '背包空空如也。去「钓鱼」页选个钓点抛竿，渔获会自动入包。'
        : '该筛选条件下没有物品。'));
    } else if (invCategory === 'component') {
      renderComponentGroups(list, keys, st, unitPrice, itemValue, doSell);
    } else {
      keys.forEach(function (id) {
        const meta = itemMeta(id);
        const total = st.inventory[id];
        // v0.13.9：一般行只代表「普通量」= 总量 − 大型/巨型预留（此前显示总量，与旁边档位行重复计数、
        // 也与「出售 1 / 批量出售」的可用量校验口径不一致：全预留的鱼点出售必然被服务端拒）。
        // 普通量为 0 的鱼不画这一行，只留下面的档位行。
        const cnt = meta.kind === 'fish' ? Math.min(total, shownAvailOf(id)) : total;
        // ⚠️ 普通量为 0 时**只跳过这一行**，不能 return —— 下面的体型档行还要照常渲染
        if (cnt > 0 && (tierShown === 'all' || tierShown === 'N')) {
          const kindName = meta.kind === 'fish' ? '一般' : meta.kind === 'material' ? '材料' : meta.kind === 'chest' ? '宝匣' : meta.kind === 'component' ? '组件' : '物品';
          const row = el('div', 'inv-row inv-page-row');
          row.setAttribute('data-id', id);           // 出售后就地更新这一行（不整页重建）
          row.innerHTML =
            '<span class="' + qualityClass(meta) + '">' + esc(meta.name) + '</span>' +
            '<span class="kind-tag' + (meta.kind === 'fish' ? ' tag-normal' : '') + '">' + kindName + '</span>' +
            rodLockBadge(id) +
            '<span class="cnt">×' + cnt + '</span>' +
            '<span class="unit-price">现价 ' + unitPrice(id) + '💰</span>' +
            '<span class="subtotal">小计 ' + (unitPrice(id) * cnt) + '💰</span>' +
            (meta.kind === 'fish' && total > cnt ? '<span class="inv-total" title="背包总量（含大型/巨型预留）">总 ×' + total + '</span>' : '');
          const acts = el('span', 'inv-acts');
          // 宝匣只能市集交易（系统商店不收购），所以不出售按钮，只给「上架」+ 前往开箱页
          if (meta.kind !== 'chest') {
            const sellBtn = el('button', 'mini primary-mini', '出售 1');
            markFeature(sellBtn, 'mall.sell');
            sellBtn.title = '按当前系统收购价出售 1 个';
            sellBtn.addEventListener('click', function () { doSell(id, 1); });
            acts.appendChild(sellBtn);
            const sellAll = el('button', 'mini', '批量出售');
            markFeature(sellAll, 'mall.sell');
            sellAll.title = '打开批量出售子窗口：可填数量或用滑块，并查看价格趋势';
            sellAll.addEventListener('click', function () { openBatchSellModal(id); });
            acts.appendChild(sellAll);
          } else {
            const goChest = el('button', 'mini', '去开箱');
            goChest.title = '宝匣只能在「⚒ 工坊 · 开箱」页开箱；系统商店不收购宝匣';
            goChest.addEventListener('click', function () { currentView = 'workshop'; wsTab = 'open'; renderNav(); renderView(); loadViewData('workshop'); });
            acts.appendChild(goChest);
          }
          if (meta.kind === 'fish' && !MARKET_FISH_LIST) {
            // v0.14.0：鱼类暂时不能上市集（见顶部 MARKET_FISH_LIST）——不出按钮，说明去哪儿卖
            const off = el('span', 'mini locked mk-off', '上架暂停');
            off.title = '鱼类暂时不能上市集（改版中）：渔获请在「商城 · 收购」出售；大型/巨型鱼可按档位卖，另有 +50% / +150% 加成';
            acts.appendChild(off);
          } else {
            const lb = el('button', 'mini', '上架');
            markFeature(lb, 'mall.list');
            lb.title = '挂到开放市集（选择时长，支付对应上架费，下架不退）';
            lb.addEventListener('click', function () { openListModal(id); });
            acts.appendChild(lb);
          }
          row.appendChild(acts);
          wireItemIntro(row, id);   // 悬停出简介浮标 + 点击开完整简介（鱼 / 材料 / 宝匣）
          list.appendChild(row);
        }
        // v0.13.6：大型/巨型鱼单独存放——紧跟普通行之后各出一行带标签的独立行，出售走加成通道
        // v0.13.10：选了体型档筛选时只画该档行（一般 / 大型 / 巨型 三档互斥显示）
        if (meta.kind === 'fish' && reservedOf(id) > 0) {
          [['L', '大型', 'tag-large'], ['G', '巨型', 'tag-giant']].forEach(function (tk) {
            const t = tk[0], n = shownReservedOf(id, t);   // 显示量 = 服务器预留量 − 在途出售量
            if (n <= 0) return;
            if (tierShown !== 'all' && tierShown !== t) return;
            const bonus = tierBonus(id, t, 1);
            const trow = el('div', 'inv-row inv-page-row inv-tier-row');
            trow.setAttribute('data-id', id + '@' + t);
            trow.innerHTML =
              '<span class="' + qualityClass(meta) + '">' + esc(meta.name) + '</span>' +
              '<span class="kind-tag ' + tk[2] + '">' + tk[1] + '</span>' +
              '<span class="cnt">×' + n + '</span>' +
              '<span class="unit-price">现价 ' + unitPrice(id) + '💰 +' + bonus + '💰</span>' +
              '<span class="subtotal">小计 ' + (unitPrice(id) * n + tierBonus(id, t, n)) + '💰</span>';
            const tact = el('span', 'inv-acts');
            const tsb = el('button', 'mini primary-mini', '出售 1');
            markFeature(tsb, 'mall.sell');
            tsb.title = '出售' + (t === 'G' ? '巨型' : '大型') + '（额外 +' + (t === 'G' ? '150' : '50') + '% 金币加成）';
            tsb.addEventListener('click', function () { doSell(id, 1, t); });
            tact.appendChild(tsb);
            // v0.14.0：批量出售入口也放到档位行上——「一般量为 0、只剩预留」的鱼本来一个入口都没有，
            // 只能一条一条点（批量窗口里三档都能填数量，见 openBatchSellModal）
            const tall = el('button', 'mini', '批量出售');
            markFeature(tall, 'mall.sell');
            tall.title = '打开批量出售窗口：一般 / 大型 / 巨型 三档都能填数量，一次结算';
            tall.addEventListener('click', function () { openBatchSellModal(id); });
            tact.appendChild(tall);
            trow.appendChild(tact);
            wireItemIntro(trow, id);
            list.appendChild(trow);
          });
        }
      });
    }
    colMain.appendChild(list);
    const pager = el('div', 'inv-pagination');
    const previous = el('button', 'mini', '上一页');
    const next = el('button', 'mini', '下一页');
    previous.disabled = invPage <= 1; next.disabled = invPage >= plan.pages;
    previous.addEventListener('click', function () { invPage--; renderView(); });
    next.addEventListener('click', function () { invPage++; renderView(); });
    const pageInfo = el('span', 'inv-page-info', '第 ' + invPage + ' / ' + plan.pages + ' 页 · 共 ' + plan.total + ' 项');
    pageInfo.setAttribute('aria-live', 'polite');
    pager.appendChild(previous); pager.appendChild(pageInfo); pager.appendChild(next);
    colMain.appendChild(pager);
    colMain.appendChild(el('div', 'hint', '提示：出售走系统商店动态收购价（售出越多价越低）；「上架」挂到开放市集等玩家购买，需支付定价总额 1% 上架费（下架不退），成交另收 10% 税（卖家承担）。'));
    panel.appendChild(colMain);

    const side = el('div', 'col-side');
    side.appendChild(el('h3', null, '📊 背包概览'));
    const kinds = {}; let totalCnt = 0, totalValue = 0, totalReserved = 0;
    invKeys.forEach(function (id) {
      kinds[itemMeta(id).kind] = (kinds[itemMeta(id).kind] || 0) + 1;
      totalCnt += st.inventory[id];
      totalValue += itemMeta(id).price * st.inventory[id]; // 预估总价：按基准价，不随市场浮动
      totalReserved += itemMeta(id).kind === 'fish' ? reservedOf(id) : 0;
    });
    const summary = el('div', 'codex-summary');
    summary.innerHTML =
      '<div class="cs-box"><b>' + invKeys.length + '</b><span>物品种类</span></div>' +
      '<div class="cs-box"><b>' + totalCnt + '</b><span>总件数</span></div>' +
      '<div class="cs-box"><b>' + totalValue + '</b><span>预估总价（基准）</span></div>';
    side.appendChild(summary);
    // 大型/巨型鱼单独预留（普通出售 / 上架 / 交易动不了它们）——概览里明说，免得对不上列表数字
    side.appendChild(el('div', 'hint inv-reserved',
      totalReserved > 0
        ? '其中大型/巨型预留 <b>' + totalReserved + '</b> 件（共 ' + (totalCnt - totalReserved) + ' 件普通量可在本页出售 / 上架 / 交易）'
        : ''));

    // 一键出售（预览弹窗）+ 组件订阅提醒入口
    const bulk = el('div', 'bulk-sell');
    const bbtn = el('button', 'primary big', '⚡ 一键出售（预览）');
    markFeature(bbtn, 'mall.sell');
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
            if (r && r.ok) { applyInvFrom(r.data); renderTopbar(); renderView(); }
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
    rf.addEventListener('click', function () {
      renderTopbar();
      if (tradeModalRedraw) tradeModalRedraw(); else renderView(); // 交易子窗口打开时只重绘窗口
      toast('列表已按当前库存刷新');
    });
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
  let tradePickCat = 'all'; // 提供物品列表的分类页签（全部/鱼类/材料/宝匣/组件）
  // 提供物品列表的细分筛选（v0.13.8：与背包同一套口径与逻辑）——
  // 点开大分类才出现对应细分：材料/宝匣＝品质，组件＝品质+部位+词条。
  // v0.13.9：鱼类不再有「体型档」行——大型/巨型预留走普通通道交易不了（服务端按可用量校验），
  // 那个筛选只会列出选不中的鱼；鱼现在只有「品质」一行。
  let tradePickRar = 'all', tradePickPart = 'all';
  let tradePickAffixCount = 'all', tradePickAffixType = 'all';
  let tradePickAffixMin = '', tradePickAffixMax = '';
  function tradePickAffixActive() { return tradePickAffixType !== 'all' || tradePickAffixMin !== '' || tradePickAffixMax !== ''; }
  function normalizeTradePickFilters() {
    if (tradePickCat === 'all') {
      tradePickRar = 'all'; tradePickPart = 'all';
      tradePickAffixCount = 'all'; tradePickAffixType = 'all'; tradePickAffixMin = ''; tradePickAffixMax = '';
      return;
    }
    if (tradePickCat !== 'component') {
      tradePickPart = 'all'; tradePickAffixCount = 'all'; tradePickAffixType = 'all';
      tradePickAffixMin = ''; tradePickAffixMax = '';
    }
    if (tradePickRar !== 'all' && !raritiesOfKind(tradePickCat).some(function (kv) { return kv[0] === tradePickRar; })) tradePickRar = 'all';
  }
  function tradePickMatch(id) {
    const m = itemMeta(id);
    // v0.13.9：交易走普通通道（服务端按可用量校验）→ 可用量为 0 的（大型/巨型预留、已卖光）不可交易，
    // 不出现在列表里；也因此不再提供「体型档」筛选（那个筛选只会列出交易不了的大鱼）。
    if (availCountOf(id) <= 0) return false;
    if (tradePickCat !== 'all' && m.kind !== tradePickCat) return false;
    if (tradePickRar !== 'all' && m.rarity !== tradePickRar) return false;
    if (tradePickCat !== 'component') return true;
    if (tradePickPart !== 'all' && (m.part || '') !== tradePickPart) return false;
    if (tradePickAffixCount !== 'all') {
      const n = (m.affixes || []).length;
      if (tradePickAffixCount === '4p' ? n < 4 : n !== Number(tradePickAffixCount)) return false;
    }
    if (!tradePickAffixActive()) return true;
    if (!m.affixes) return false;
    return m.affixes.some(function (a) {
      if (tradePickAffixType !== 'all' && a.type !== tradePickAffixType) return false;
      if (tradePickAffixMin !== '' && a.value < Number(tradePickAffixMin)) return false;
      if (tradePickAffixMax !== '' && a.value > Number(tradePickAffixMax)) return false;
      return true;
    });
  }
  // 细分筛选行（与背包 renderInvSubFilters 同款交互，复用交易侧的筛选状态）
  function tradePickSubFilters() {
    const row = el('div', 'inv-subfilters tp-subfilters');
    if (tradePickCat === 'all') {
      row.appendChild(el('div', 'hint', '点开上面的分类后再选细分：鱼类＝品质，材料与宝匣＝品质，组件＝部位 / 词条。'));
      return row;
    }
    const redraw = function () { if (tradeModalRedraw) tradeModalRedraw(); else renderView(); };
    const st = S();
    const keys = Object.keys(st.inventory);
    const cnt = { all: 0 };
    keys.forEach(function (id) {
      if (itemMeta(id).kind !== tradePickCat) return;
      if (availCountOf(id) <= 0) return;      // 与列表同口径：不可交易的不计数
      cnt.all += 1;
      const r = itemMeta(id).rarity;
      cnt[r] = (cnt[r] || 0) + 1;
    });
    const rarRow = el('div', 'inv-subrow');
    rarRow.appendChild(el('span', 'sub-label', '品质'));
    [['all', '全部']].concat(raritiesOfKind(tradePickCat)).forEach(function (kv) {
      const b = el('button', 'inv-cat sub' + (tradePickRar === kv[0] ? ' on' : ''), kv[1] + ' ' + (cnt[kv[0]] || 0));
      b.addEventListener('click', function () { if (tradePickRar !== kv[0]) { tradePickRar = kv[0]; redraw(); } });
      rarRow.appendChild(b);
    });
    row.appendChild(rarRow);
    if (tradePickCat === 'component') {
      const partRow = el('div', 'inv-subrow');
      partRow.appendChild(el('span', 'sub-label', '部位'));
      const partCount = {};
      keys.forEach(function (id) {
        const m = itemMeta(id);
        if (m.kind !== 'component') return;
        partCount[m.part] = (partCount[m.part] || 0) + st.inventory[id];
      });
      const total = keys.filter(function (id) { return itemMeta(id).kind === 'component'; })
        .reduce(function (n, id) { return n + st.inventory[id]; }, 0);
      [['all', '全部', total]].concat(D.ROD_PARTS.map(function (p) { return [p.key, p.name, partCount[p.key] || 0]; })).forEach(function (kv) {
        if (kv[0] !== 'all' && !kv[2]) return;
        const b = el('button', 'inv-cat sub' + (tradePickPart === kv[0] ? ' on' : ''), kv[1] + ' ' + kv[2]);
        b.addEventListener('click', function () { if (tradePickPart !== kv[0]) { tradePickPart = kv[0]; redraw(); } });
        partRow.appendChild(b);
      });
      row.appendChild(partRow);
      const affRow = el('div', 'inv-subrow');
      affRow.appendChild(el('span', 'sub-label', '词条数'));
      [['all', '全部'], ['0', '无词条'], ['1', '1条'], ['2', '2条'], ['3', '3条'], ['4p', '4+条']].forEach(function (kv) {
        const b = el('button', 'inv-cat sub' + (tradePickAffixCount === kv[0] ? ' on' : ''), kv[1]);
        b.addEventListener('click', function () { if (tradePickAffixCount !== kv[0]) { tradePickAffixCount = kv[0]; redraw(); } });
        affRow.appendChild(b);
      });
      affRow.appendChild(el('span', 'sub-label', '类型'));
      const sel = el('select', 'bulk-select sub-sel');
      [['all', '全部词条']].concat(BD_AFFIXES.map(function (kv) { return [kv[0], kv[1]]; })).forEach(function (kv) {
        const o = el('option', null, kv[1]); o.value = kv[0]; sel.appendChild(o);
      });
      sel.value = tradePickAffixType;
      sel.addEventListener('change', function () { tradePickAffixType = sel.value; redraw(); });
      sel.addEventListener('focus', function () { invFocus = true; });
      sel.addEventListener('blur', function () { invFocus = false; });
      affRow.appendChild(sel);
      const minInp = el('input', 'aff-num');
      minInp.type = 'number'; minInp.placeholder = '最小值'; minInp.value = tradePickAffixMin;
      const maxInp = el('input', 'aff-num');
      maxInp.type = 'number'; maxInp.placeholder = '最大值'; maxInp.value = tradePickAffixMax;
      minInp.addEventListener('input', function () { tradePickAffixMin = minInp.value; redraw(); });
      maxInp.addEventListener('input', function () { tradePickAffixMax = maxInp.value; redraw(); });
      [minInp, maxInp].forEach(function (n) {
        n.addEventListener('focus', function () { invFocus = true; });
        n.addEventListener('blur', function () { invFocus = false; });
      });
      affRow.appendChild(el('span', 'sub-label', '~'));
      affRow.appendChild(minInp);
      affRow.appendChild(maxInp);
      row.appendChild(affRow);
    }
    return row;
  }

  // 提供物品列表的视口与编辑态：必须在重绘间保留，否则任何一次重建（对方改动 / 手动刷新 / 冷却结束）
  // 都会让列表滚回顶部、正在填的数量框丢焦点——背包几百行时用户报「东西太多拉下去直接弹回去」。
  let tradePickScroll = 0;   // .tp-rows 的 scrollTop
  let tradeQtyFocus = null;  // 正在编辑的数量框 { id, caret }（按物品 id 定位，重建后还回去）

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

  // ---- 交易子窗口（v0.12：独立「在线交易」页面已删除）----
  // 入口合并到 社交 → 在线玩家列表 的玩家卡片右部「🤝 交易」按钮，交易 UI 整体
  // 搬进弹出子窗口。会话建立前显示「等待对方同意中…」，会话状态由 trade 广播驱动重绘。
  let tradeModalEl = null;          // 当前交易子窗口 overlay
  let tradeModalRedraw = null;      // 子窗口重绘钩子（trade 广播到达时调用）
  let tradeModalTarget = null;      // 邀请已发出、会话尚未建立时的对象 { id, name }
  let tradeModalHadSession = false; // 子窗口存续期间出现过交易会话（用于识别会话结束）
  let lastIncomingTradeId = null;   // 最近一次自动弹窗展示过的邀请（避免重复弹）
  let tradeCancelOnArrive = false;  // 「邀请刚发出、会话还没回来时点了关闭」：等 trade 广播到达立刻补一次撤回

  // 关闭交易子窗口。邀请尚未被接受时，关闭＝撤回邀请——只关窗口不发 /api/trade/cancel 的话，
  // 服务端会话还挂着：对方仍会收到邀请，而自己因为「同一对玩家只能有一个活跃会话」再也发不出新邀请。
  // 已进入交易（对方已接受）时关闭只是收起窗口，不替玩家取消：进行中的交易另有「取消交易」按钮。
  // v0.13.8：点关闭就是「不交易了」——未接受＝撤回邀请，进行中＝取消交易并通知对方断开
  //（两种情况都发 /api/trade/cancel：服务端把 cancelled 广播给对面，对方窗口随之下线）。
  function tradeModalClose(opts) {
    const t = S().trade;
    const live = t && !t.done && !t.cancelled;
    if (live && window.Net && window.Net.tradeCancel && !(opts && opts.noCancel)) {
      window.Net.tradeCancel(t.id);
      toast(t.accepted ? '已取消交易（对方已收到通知）' : '已撤回交易邀请');
    } else if (!t && tradeModalTarget && !(opts && opts.noCancel)) {
      // 会话还没回来的空窗期（邀请请求在途）：先记下意图，trade 广播到达时补撤回
      tradeCancelOnArrive = true;
    }
    if (tradeModalEl) { const m = tradeModalEl; tradeModalEl = null; m.remove(); }
    tradeModalRedraw = null;
    tradeModalTarget = null;
    tradeModalHadSession = false;
  }
  // trade 广播到达时调用：补上「空窗期关闭」欠下的那次撤回。
  // 只对**自己发起的**未接受邀请生效，否则会误撤后来收到的别人的邀请。
  function settlePendingTradeCancel() {
    if (!tradeCancelOnArrive) return;
    const t = S().trade;
    tradeCancelOnArrive = false;
    const meKey = S().me && S().me.id != null ? String(S().me.id).toLowerCase() : null;
    if (t && !t.accepted && meKey && t.a && t.a.key === meKey && window.Net && window.Net.tradeCancel) {
      window.Net.tradeCancel(t.id);
      toast('已撤回交易邀请');
    }
  }

  function openTradeModal(targetId, targetName) {
    // 换目标重开窗口时只收起旧窗口，不撤回：点别人的「交易」按钮时若手上正有一条**别人发来的**
    // 未接受邀请，撤回等于替玩家拒了对方；撤回一律只由窗口里的按钮 / ✕ 触发。
    if (tradeModalEl) tradeModalClose({ noCancel: true });
    closeOverlays(); // 关掉其它普通弹窗（组件属性等），避免叠层混乱
    const st = S();
    if (st.trade) {
      // 已有会话（可能就是与该玩家的）→ 直接展示会话
      tradeModalTarget = null;
      tradeModalHadSession = true;
    } else if (targetId != null) {
      tradeModalTarget = { id: targetId, name: targetName || targetId };
      // 邀请失败（对方不在线 / 已有会话）时 call 会 toast 错误，这里把空窗口关掉
      call(window.Net.tradeInvite(targetId), null).then(function (r) {
        if ((!r || !r.ok) && !S().trade) tradeModalClose({ noCancel: true }); // 邀请压根没建起来，别留下撤回意图
      });
    }
    const overlay = el('div', 'modal-overlay');
    overlay.dataset.keep = '1'; // 组件属性 / 确认框要能叠在交易窗口上（见 closeOverlays）
    overlay.addEventListener('click', function (ev) { if (ev.target === overlay) tradeModalClose(); });
    const box = el('div', 'modal-box trade-modal');
    box.innerHTML = '<div class="modal-head"><span class="modal-title">🤝 在线交易</span>' +
      '<button class="mini modal-close" title="关闭窗口（邀请尚未被接受时会同时撤回邀请）">✕ 关闭</button></div>' +
      '<div class="modal-body"><div class="trade-modal-body"></div></div>';
    overlay.appendChild(box);
    document.body.appendChild(overlay);
    tradeModalEl = overlay;
    box.querySelector('.modal-close').addEventListener('click', function () { tradeModalClose(); });
    tradeModalRedraw = drawTradeModal;
    tradePickScroll = 0;  // 新窗口从列表顶部开始：沿用上一单的滚动位置会让人找不到刚才在看的东西
    tradeQtyFocus = null;
    drawTradeModal();
  }

  function drawTradeModal() {
    if (!tradeModalEl || !tradeModalRedraw) return;
    const bodyEl = tradeModalEl.querySelector('.trade-modal-body');
    if (!bodyEl) return;
    // 重建前记下提供物品列表的视口与正在编辑的数量框（列表会长到几百行，重建后不能把人弹回顶部）
    const prevRowsEl = bodyEl.querySelector('.tp-rows');
    if (prevRowsEl) tradePickScroll = prevRowsEl.scrollTop;
    const ae = document.activeElement;
    tradeQtyFocus = null;
    if (ae && ae.classList && ae.classList.contains('tp-qty') && bodyEl.contains(ae)) {
      const row = ae.closest ? ae.closest('.tp-row') : null;
      const id = row && row.getAttribute('data-id');
      if (id) { try { tradeQtyFocus = { id: id, caret: ae.selectionStart }; } catch (e) { tradeQtyFocus = { id: id, caret: null }; } }
    }
    const st = S();
    const t = st.trade;
    // 无会话：等待邀请被接受，或会话刚结束
    if (!t) {
      if (tradeModalHadSession) {
        bodyEl.innerHTML = '<div class="trade-wait"><div class="tw-ico">✅</div><b>交易已结束</b>' +
          (st.tradeFlash ? '<div class="hint">' + esc(st.tradeFlash) + '</div>' : '') + '</div>';
        if (st.tradeFlash) { toast(st.tradeFlash); st.tradeFlash = null; }
        setTimeout(function () { if (tradeModalEl && !S().trade) tradeModalClose(); }, 1500);
        return;
      }
      if (tradeModalTarget) {
        // 在玩家接受交易前：等待对方同意中…
        bodyEl.innerHTML = '<div class="trade-wait"><div class="tw-ico tw-spin">⏳</div>' +
          '<b>等待对方同意中…</b>' +
          '<div class="hint">已向 ' + esc(tradeModalTarget.name) + ' 发出交易邀请，对方接受后进入交易。</div></div>';
        const acts0 = el('div', 'trade-actions center');
        const cl0 = el('button', 'mini danger-mini', '✕ 撤回邀请并关闭');
        cl0.title = '关闭窗口会同时撤回这条交易邀请';
        cl0.addEventListener('click', function () { tradeModalClose(); });
        acts0.appendChild(cl0);
        bodyEl.appendChild(acts0);
        return;
      }
      bodyEl.innerHTML = '<div class="trade-wait"><div class="tw-ico">🤝</div><b>没有进行中的交易</b>' +
        '<div class="hint">在「社交 → 在线玩家」里点击玩家卡片右部的「🤝 交易」按钮发起交易。</div></div>';
      return;
    }
    tradeModalHadSession = true;
    tradeModalTarget = null;
    // 先确定双方身份（key 均为小写，比对时做大小写免疫），再按阶段渲染
    const meKey = st.me && st.me.id != null ? String(st.me.id).toLowerCase() : null;
    const meIsA = !!(meKey && t.a.key === meKey);
    const myItems = meIsA ? t.aItems : t.bItems;
    const otherItems = meIsA ? t.bItems : t.aItems;
    const myOk = meIsA ? t.aOk : t.bOk;
    const otherOk = meIsA ? t.bOk : t.aOk;
    const otherName = meIsA ? t.b.name : t.a.name;
    const cd = Math.max(0, (t.cooldownUntil || 0) - Date.now());
    const sel = draftFor(t);
    bodyEl.innerHTML = '';

    if (!t.accepted) {
      const pend = el('div', 'trade-wait');
      if (meIsA) {
        // 我是发起方：等待对方同意。撤回按钮放在窗口下方居中并标红（与右上角 ✕ 同一动作）
        pend.innerHTML = '<div class="tw-ico tw-spin">⏳</div><b>等待对方同意中…</b>' +
          '<div class="hint">已向 ' + esc(otherName) + ' 发出交易邀请。</div>';
        bodyEl.appendChild(pend);
        const acts = el('div', 'trade-actions center');
        const wd = el('button', 'mini danger-mini', '✕ 撤回邀请');
        wd.title = '撤回后对方将不再看到这条邀请，可重新发起';
        wd.addEventListener('click', function () { call(window.Net.tradeCancel(t.id), '已撤回邀请'); });
        acts.appendChild(wd);
        bodyEl.appendChild(acts);
      } else {
        // 我是被邀请方：接受 / 拒绝
        pend.innerHTML = '<div class="tw-ico">📨</div><b>' + esc(otherName) + ' 邀请你进行交易</b>' +
          '<div class="hint">接受后双方各自放入物品，确认成交（双方免税）。</div>';
        bodyEl.appendChild(pend);
        const acts = el('div', 'trade-actions center');
        const ok = el('button', 'primary', '接受邀请');
        ok.addEventListener('click', function () { call(window.Net.tradeRespond(t.id, true), null).then(function (r) { if (r && r.ok) setTimeout(refreshAll, 200); }); });
        const no = el('button', 'mini danger-mini', '拒绝');
        no.addEventListener('click', function () { call(window.Net.tradeRespond(t.id, false), '已拒绝交易'); });
        acts.appendChild(ok); acts.appendChild(no);
        bodyEl.appendChild(acts);
      }
      return;
    }

    // 会话进行中：头部 + 锁定条 + 双方提供栏 + 物品选择器 + 操作按钮
    const head = el('div', 'trade-head');
    head.innerHTML = '<div class="th-with">交易对象：<b>' + esc(otherName) + '</b> ' +
      '<span class="live-check"><span class="muted">在线</span></span></div>' +
      '<div class="th-stage">' + (cd > 0 ? '确认已重置，冷却 ' + Math.ceil(cd / 1000) + 's' : '请双方放入物品并确认') + '</div>';
    bodyEl.appendChild(head);
    if (tradeLockOn()) bodyEl.appendChild(tradeLockBar());
    const sides = el('div', 'trade-sides');
    sides.appendChild(tradeSide('我的提供', myItems, myOk, true));
    sides.appendChild(tradeSide(otherName + ' 的提供', otherItems, otherOk, false));
    sides.appendChild(tradePicker(t, sel));
    bodyEl.appendChild(sides);
    const acts = el('div', 'trade-actions');
    const confirmBtn = el('button', 'primary' + (myOk ? ' done' : '') + (cd > 0 ? ' locked' : ''), myOk ? '✔ 已确认' : (cd > 0 ? '冷却中 ' + Math.ceil(cd / 1000) + 's' : '确认交易'));
    // 无条件绑定点击：「能不能点」在点击时按最新状态判断（构建时的 myOk / cd 只决定外观）。
    // 冷却结束后不再重建弹窗（见 initApp 里的冷却定时器），所以不能靠重建来"解锁"按钮。
    confirmBtn.addEventListener('click', function () {
      const cur = S().trade;
      if (!cur || cur.id !== t.id) return;                              // 已换会话 / 已结束
      if ((meIsA ? cur.aOk : cur.bOk) || Math.max(0, (cur.cooldownUntil || 0) - Date.now()) > 0) return; // 已确认 / 冷却中
      call(window.Net.tradeConfirm(t.id), null).then(function (r) { if (r && r.ok) setTimeout(refreshAll, 200); });
    });
    const cancelBtn = el('button', 'mini', '取消交易');
    cancelBtn.addEventListener('click', function () { call(window.Net.tradeCancel(t.id), '交易已取消'); });
    acts.appendChild(confirmBtn); acts.appendChild(cancelBtn);
    bodyEl.appendChild(acts);
    // 视口与焦点还原必须放在**挂进文档之后**（对游离节点设 scrollTop / focus 都是空操作）
    const nextRows = bodyEl.querySelector('.tp-rows');
    if (nextRows) nextRows.scrollTop = tradePickScroll;
    if (tradeQtyFocus) {
      const all = bodyEl.querySelectorAll('.tp-row');
      for (let i = 0; i < all.length; i++) {
        if (all[i].getAttribute('data-id') !== tradeQtyFocus.id) continue;
        const q = all[i].querySelector('input.tp-qty');
        // 该项已被取消勾选 / 库存清零（框被禁用）时不再抢焦点，避免把焦点丢到一个不可编辑的框里
        if (q && !q.disabled) {
          q.focus();
          if (tradeQtyFocus.caret != null) { try { q.setSelectionRange(tradeQtyFocus.caret, tradeQtyFocus.caret); } catch (e) {} }
        }
        break;
      }
      tradeQtyFocus = null;
    }
  }

  // ---- 查看其他玩家的钓竿组件构成（社交页玩家卡片「🔍 查看」按钮） ----
  function openRodModal(targetId, targetName) {
    closeOverlays();
    const overlay = buildOverlay(function () { closeOverlays(); });
    const box = el('div', 'modal-box rod-modal');
    box.innerHTML = '<div class="modal-head"><span class="modal-title">🎣 ' + esc(targetName || '玩家') + ' 的钓竿</span>' +
      '<button class="mini modal-close">✕ 关闭</button></div>' +
      '<div class="modal-body"><div class="hint">加载中…</div></div>';
    overlay.appendChild(box);
    document.body.appendChild(overlay);
    box.querySelector('.modal-close').addEventListener('click', closeOverlays);
    call(window.Net.fetchPlayerRod(targetId), null).then(function (r) {
      const body = box.querySelector('.modal-body');
      if (!body) return;
      if (!r || !r.ok) { body.innerHTML = '<div class="hint">' + esc((r && r.data && r.data.error) || '无法获取对方钓竿信息') + '</div>'; return; }
      const d = r.data || {};
      const partCards = D.ROD_PARTS.map(function (p) {
        const slot = (d.bd || {})[p.key];
        const comp = slot && slot.compId ? (D.componentOf ? D.componentOf(slot.compId) : null) : null;
        const meta = comp || (slot ? { name: slot.name, quality: slot.rare, affixes: slot.affixes || [] } : null);
        const nameHtml = slot && slot.compId
          ? '<span class="' + qualityClass(meta) + '">' + esc((meta && meta.name) || slot.name || slot.compId) + '</span>' + itemTag(meta)
          : '<span class="muted">（未装配）</span>';
        const affHtml = (meta && meta.affixes && meta.affixes.length)
          ? meta.affixes.map(function (a) { return affSpanOpen(a) + esc(affixText(a)) + '</span>'; }).join(' ')
          : '<span class="muted">无词条</span>';
        return '<div class="rod-part-row"><div class="rp-part">' + esc(p.name) + (slot && slot.isCharm ? ' · 饰品' : '') + '</div>' +
          '<div class="rp-comp">' + nameHtml + '</div><div class="rp-affs">' + affHtml + '</div></div>';
      }).join('');
      // 钓竿属性总和：把各部位组件词缀按类型求和（与钓竿页 eff-strip 同格式 / 同类名）
      const total = {};
      D.ROD_PARTS.forEach(function (p) {
        const slot = (d.bd || {})[p.key];
        const meta = slot && slot.compId ? (D.componentOf ? D.componentOf(slot.compId) : null) : null;
        const affs = (meta && meta.affixes) || (slot ? (slot.affixes || []) : []);
        (affs || []).forEach(function (a) { if (a && a.type != null) total[a.type] = (total[a.type] || 0) + (Number(a.value) || 0); });
      });
      const effDefs = [['speed', '⚡ 钓速'], ['skill', '🎯 技巧'], ['rare', '✨ 稀有'], ['material', '🧵 材料'], ['size', '📏 体型'], ['double', '🎣 双钓']];
      let anyTotal = false;
      const totalChips = effDefs.map(function (kv) {
        const v = total[kv[0]];
        if (!v) return '';
        anyTotal = true;
        return '<span class="eff-chip' + (v < 0 ? ' eff-neg' : '') + '">' + kv[1] + ' ' + (v > 0 ? '+' : '') + v + '%</span>';
      }).join('');
      body.innerHTML = '<div class="rod-view">' +
        (d.rodName ? '<div class="rod-view-name">竿名 <b>' + esc(d.rodName) + '</b></div>' : '') +
        (anyTotal ? '<div class="eff-strip rod-total">' + totalChips + '</div>'
          : '<div class="eff-strip rod-total"><span class="eff-chip none">暂无加成 · 未装备组件</span></div>') +
        '<div class="rod-parts">' + partCards + '</div>' +
        '</div>';
    });
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
    // 清理已不在背包中 / 已不可交易的草稿项（例如中途把物品卖掉，或全剩大型/巨型预留）
    Object.keys(sel).forEach(function (id) { if (!(st.inventory[id] > 0) || availCountOf(id) <= 0) delete sel[id]; });
    const box = el('div', 'trade-picker');
    box.innerHTML = '<div class="tp-head">选择我要提供的物品（改动会重置双方确认）</div>';
    // v0.13.9：可提供的 = 可用量 > 0 的（大型/巨型预留与已卖光的不列出，服务端也会按可用量拒）
    const allKeys = Object.keys(st.inventory).filter(function (id) { return availCountOf(id) > 0; });
    if (allKeys.length === 0) { box.appendChild(el('div', 'hint', '背包里没有可交易的物品（大型/巨型预留的鱼走普通通道交易不了）。')); return box; }
    const hiddenReserved = Object.keys(st.inventory).filter(function (id) { return (st.inventory[id] || 0) > 0 && availCountOf(id) <= 0; }).length;

    // 分类页签：与背包一致的「全部 / 鱼类 / 材料 / 组件」
    const kindCount = { fish: 0, material: 0, chest: 0, component: 0 };
    allKeys.forEach(function (id) { const k = itemMeta(id).kind; if (kindCount[k] != null) kindCount[k] += 1; });
    const tabs = el('div', 'inv-cats tp-cats');
    [['all', '📦 全部', allKeys.length], ['fish', '🐟 鱼类', kindCount.fish], ['material', '🧵 材料', kindCount.material], ['chest', '🎁 宝匣', kindCount.chest], ['component', '🔧 组件', kindCount.component]].forEach(function (kv) {
      const b = el('button', 'inv-cat' + (tradePickCat === kv[0] ? ' on' : ''), kv[1] + ' ' + kv[2]);
      b.addEventListener('click', function () { if (tradePickCat !== kv[0]) { tradePickCat = kv[0]; tradePickScroll = 0; tradeQtyFocus = null; if (tradeModalRedraw) tradeModalRedraw(); else renderView(); } });
      tabs.appendChild(b);
    });
    box.appendChild(tabs);
    normalizeTradePickFilters();
    box.appendChild(tradePickSubFilters());
    if (hiddenReserved) box.appendChild(el('div', 'hint', '另有 ' + hiddenReserved + ' 种物品（大型/巨型预留或已售罄）不可交易，未列入。'));

    let keys = allKeys.filter(tradePickMatch);
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
      // v0.13.9：交易也走普通通道（服务端按可用量校验），上限与夹紧都用可用量
      const have = availCountOf(id);
      const totalHeld = st.inventory[id] || 0;
      const checked = sel[id] != null && sel[id] > 0;
      const qty = checked ? Math.min(sel[id], have) : 1;
      const row = el('div', 'tp-row');
      row.setAttribute('data-id', id); // 重建后按它找回正在编辑的数量框（见 drawTradeModal）
      const affHtml = (meta.kind === 'component' && meta.affixes && meta.affixes.length)
        ? '<div class="mk-aff">' + meta.affixes.map(function (a) {
            const rng = affixRangeIn(meta, a);
            const rangeTag = rng ? '<span class="aff-rng">（' + esc(rangeText({ min: rng[0], max: rng[1] })) + '%）</span>' : '';
            return affSpanOpen(a) + esc(affixText(a)) + rangeTag + '</span>';
          }).join('') + itemTag(meta) + '</div>'
        : '';
      row.innerHTML = '<label class="tp-name"><input type="checkbox"' + (checked ? ' checked' : '') + ' /> <span class="' +
        qualityClass(meta) + '">' + esc(meta.name) + '</span>' + rodLockBadge(id) + '</label>' + affHtml +
        '<span class="tp-have">持有 ' + have + (totalHeld > have ? '（总 ' + totalHeld + '）' : '') + '</span>' +
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
        .filter(function (id) { return availCountOf(id) > 0; })
        .map(function (id) {
          return { id: id, qty: Math.max(1, Math.min(availCountOf(id), sel[id])) };
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

  // ---- 图鉴视图 ----
  // 当前分类（模块级：重绘间保留）；详情改为子窗口，无需记录展开项
  let codexCategory = 'all';
  let lastSpotPointerType = ''; // 跨重绘保留，兼容不提供 click.pointerType 的浏览器
  let mapTab = 'nearshore'; // 钓鱼页地图页签：nearshore 近岸 / voyage 出海预告
  let lastFisherSpotKey = null; // 甩杆动画记忆：同一钓点重绘不重复播放

  // ---- 角色模块：钓鱼小人皮肤可更换（本地偏好，后续可升级进服务器存档）----
  // 贴图由 assets/ui/fisher_{a,b,hold}.png 换色重制，剪影与地图甩杆小人完全一致，
  // 地图节点 / 实况场景 / 甩杆三帧全部走 charSrc()，换装即时生效。
  const CHARS = [
    { id: 'classic', name: '云游侠客' },
    { id: 'teal',    name: '青衫客' },
    { id: 'red',     name: '赤焰渔郎' },
    { id: 'ink',     name: '墨衣钓叟' },
    { id: 'amber',   name: '金秋蓑翁' },
  ];
  const CHAR_KEY = 'fishing_char_v1';
  function charId() {
    try {
      const v = localStorage.getItem(CHAR_KEY);
      if (v && CHARS.some(function (c) { return c.id === v; })) return v;
    } catch (e) { /* 忽略 */ }
    return 'classic';
  }
  function charSrc(pose) { return 'assets/ui/chars/' + charId() + '_' + pose + '.png'; }

  // ---- 角色系统（v2）：人 + 狗 + 船的展示与搭配（本地偏好，后续可升级服务器存档）----
  // 贴图为官方 angler 风格生成后像素化（assets/ui/char/），外观 = 帽子×服装×肤色 48 组合预渲染，
  // 选哪套就换哪张图，无需运行时叠加。同伴与船先开放基础款，其余占位（后续接商城/掉落）。
  const CHAR2_KEY = 'fishing_char_v2';
  const CHAR2_DEF = { hat: 'orange', outfit: 'green', skin: 'light', dog: 'golden', boat: 'wood' };
  const CHAR2_HATS = [['orange', '橙线帽'], ['teal', '青线帽'], ['red', '红线帽'], ['cream', '米线帽']];
  const CHAR2_OUTFITS = [['green', '苔绿工装'], ['yellow', '雨黄工装'], ['red', '砖红工装'], ['blue', '海蓝工装']];
  const CHAR2_SKINS = [['light', '浅麦'], ['tan', '小麦'], ['dark', '深麦']];
  const CHAR2_DOGS = [
    // 官方同伴图标（unpack.wiki 游戏资源，统一化调色后接入），全部可选
    ['golden', '金毛', true], ['corgi', '柯基', true], ['malamute', '阿拉斯加', true],
    ['basset', '巴吉度', true], ['shepherd', '德牧', true], ['dachshund', '腊肠', true],
    ['bernese', '伯恩山', true], ['mainecoon', '缅因猫', true],
  ];
  // 船贴图为 Cast n Chill 官方图标（unpack.wiki 游戏资源），名称沿用官方中文译名
  const CHAR2_BOATS = [
    ['wood', '池塘划手', true, '初始船只'],
    ['leaky', '破水桶', false, '💰200 · 湖泊 · 商城即将上架'],
    ['loon', '追鹅者', false, '💰1000 · 湖泊 · 商城即将上架'],
    ['rambler', '海岸漫步者', false, '💰5000 · 湖泊 · 商城即将上架'],
    ['snowwolf', '雪狼 XT1', false, '💰2000 · 海洋 · 商城即将上架'],
  ];
  function char2() {
    try {
      const raw = localStorage.getItem(CHAR2_KEY);
      if (raw) return Object.assign({}, CHAR2_DEF, JSON.parse(raw));
    } catch (e) { /* 忽略 */ }
    return Object.assign({}, CHAR2_DEF);
  }
  function char2Save(patch) {
    const s = Object.assign(char2(), patch);
    try { localStorage.setItem(CHAR2_KEY, JSON.stringify(s)); } catch (e) { /* 忽略 */ }
    return s;
  }
  function anglerSrc(s) { return 'assets/ui/char/angler_' + s.hat + '_' + s.outfit + '_' + s.skin + '.png'; }

  function renderCharacter() {
    const main = $('main');
    main.innerHTML = '';
    const st = char2();
    const wrap = el('div', 'panel char-view');
    wrap.innerHTML = pageHead('🧍', '角色', '同伴与船型只改外观，不影响钓竿加成与背包') +
      sectionTabsHtml('character', charTab, [['companion', '🐶 同伴'], ['boat', '⛵ 船型']]) +
      pageHelp(charTab === 'boat'
        ? '点船型卡片即换上；锁定的船型后续在商城上架。'
        : '点同伴卡片即换上（随钓手出现在渔场实况里）。');
    bindSectionTabs(wrap, 'character');
    // 展示台：静水湖黄昏背景 + 木码头 + 船 + 同伴狗（人物外观模块暂缓，贴图保留在 assets/ui/char/）
    const stage = el('div', 'char-stage');
    stage.innerHTML =
      '<img class="cs-bg" src="assets/scene/stillwater.png" alt="" draggable="false">' +
      '<img class="cs-dock" src="assets/ui/char/dock.png" alt="" draggable="false">' +
      '<img class="cs-boat" src="assets/ui/char/boat_' + st.boat + '.png" alt="" draggable="false">' +
      '<img class="cs-dog" src="assets/ui/char/dog_' + st.dog + '.png" alt="" draggable="false" onerror="this.style.display=\'none\'">';
    wrap.appendChild(stage);
    // 展示台是两张卡片的共用预览，下面的卡片列表按页签只画一张，避免来回滚动
    if (charTab === 'boat') {
      wrap.appendChild(el('h3', null, '⛵ 船型'));
      const boats = el('div', 'char-cards');
      CHAR2_BOATS.forEach(function (b) {
        const card = el('button', 'cc-card wide' + (st.boat === b[0] ? ' on' : '') + (b[2] ? '' : ' locked'));
        card.innerHTML = '<img src="assets/ui/char/boat_' + b[0] + '.png" alt="" draggable="false"' +
          ' onerror="this.outerHTML=\'<span class=cc-lock>🔒</span>\'">' +
          '<b>' + b[1] + (b[2] ? '' : ' 🔒') + '</b><i>' + b[3] + '</i>';
        card.addEventListener('click', function () {
          if (!b[2]) { toast('「' + b[1] + '」即将在商城上架'); return; }
          if (!featureGuard('character.boat')) return;
          char2Save({ boat: b[0] });
          renderView();
        });
        markFeature(card, 'character.boat');
        boats.appendChild(card);
      });
      wrap.appendChild(boats);
      main.appendChild(wrap);
      return;
    }
    // 同伴
    wrap.appendChild(el('h3', null, '🐶 同伴'));
    const dogs = el('div', 'char-cards');
    CHAR2_DOGS.forEach(function (d) {
      const card = el('button', 'cc-card' + (st.dog === d[0] ? ' on' : '') + (d[2] ? '' : ' locked'));
      card.innerHTML = (d[2]
        ? '<img src="assets/ui/char/dog_' + d[0] + '.png" alt="" draggable="false">'
        : '<span class="cc-lock">🔒</span>') +
        '<b>' + d[1] + '</b>' + (d[2] ? '' : '<i>敬请期待</i>');
      card.addEventListener('click', function () {
        if (!d[2]) { toast('「' + d[1] + '」后续版本加入'); return; }
        if (!featureGuard('character.companion')) return;
        char2Save({ dog: d[0] });
        renderView();
      });
      markFeature(card, 'character.companion');
      dogs.appendChild(card);
    });
    wrap.appendChild(dogs);
    main.appendChild(wrap);
  }
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
      (rec && it.kind === 'fish' ? '<div class="cd-line">最高体型档位：<b>' + (rec.tier === 'G' ? '🥇 巨型（金框）' : rec.tier === 'L' ? '🥈 大型（银框）' : '🥉 普通（铜框）') + '</b><span class="muted"> · 超出默认最大体型 0~80% 为大型，80% 以上为巨型</span></div>' : '') +
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
      let html = '<div class="cd-line">' + (g.locked ? '🔒 尚未开放（后台锁定 / 限时未开窗）' : '✅ 已解锁 · 可前往垂钓') +
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

  // ---- 工坊 · 开箱（原「宝匣合成」独立页，v0.12.x 并入工坊）----
  // 内容不变：四档梯度，每一档消除一层随机（档位定义见 data.js 的 CHESTS）：
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
  // 词缀后括号里的数值区间：来源优先（熔炼搬来的副件区间 / 催化 / 突破按词缀自带来源取），
  // 只有来源就是该底材本身（或没有来源）时才用底材区间
  function chestAffixRange(meta, a) {
    if (!a) return '';
    const pool = (meta.pool || []).find(function (p) { return p.type === a.type; });
    const src = a.src;
    if (src && !(pool && src === meta.baseId) && D.affixSrcRangeOf) {
      const r = D.affixSrcRangeOf(src, a.type, meta && meta.part);
      if (r) return rangeText({ min: r[0], max: r[1] });
    }
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
        ? '<div class="cr-note">★ 标记的词缀不在「' + esc(meta.baseName) + '」的词缀池内（池外词缀）；' +
          '本件含' + esc(extraAffixName(extras[0])) + '（悬停词条可看来源说明）。</div>'
        : (meta.breakthrough ? '' : '')) +
      '</div>';
  }
  function showChestResult(chest, data) {
    const meta = data.item;
    const st = S();
    // 结果弹窗只保留一个：并发/连开的旧响应不该再叠一个窗在上层（也会让「再开一个」点错目标）
    if (chestResultOverlay) { try { chestResultOverlay.remove(); } catch (e) {} chestResultOverlay = null; }
    const overlay = buildOverlay(null);
    chestResultOverlay = overlay;
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
      '<button class="mini primary-mini cr-again">再开一个（持有 ' + ((st.inventory && st.inventory[chest.id]) || 0) + '）</button>' +
      '<button class="mini cr-ok">收下</button></div>' +
      '<div class="hint" style="margin-top:6px">开出的组件已进背包，可装备 / 出售 / 上架。</div>' +
      '</div>';
    overlay.appendChild(box);
    document.body.appendChild(overlay);
    // 关闭时顺带重绘：开箱期间（有 .modal-overlay）广播只更新数据不重绘，关掉后要把工坊/顶栏的
    // 持有数与背包同步一次，否则数字停在开箱前（看起来像「开了没进包」）
    const close = function () {
      overlay.remove();
      if (chestResultOverlay === overlay) chestResultOverlay = null;
      renderTopbar();
      if (currentView === 'workshop') renderView();
    };
    box.querySelector('.modal-close').addEventListener('click', close);
    box.querySelector('.cr-ok').addEventListener('click', close);
    if (overlay) overlay.addEventListener('click', function (ev) { if (ev.target === overlay) close(); });
    box.querySelector('.cr-again').addEventListener('click', function () {
      close();
      openChestModal(chest);
    });
  }
  // 开箱子窗口：自选目标（Ⅱ/Ⅲ/Ⅳ）+ 确认；Ⅰ 档直接开
  // v0.13.9：开箱是「扣宝匣 + 得组件」的不可逆操作，响应里还带一份全量背包快照。
  // 连点 / 双击会并发两笔请求，先发的旧快照后到就会把新开出的配件从界面上抹掉
  //（用户报的「连续开箱丢配件」）——所以同一时刻只允许一笔在途，且结果弹窗只留一个。
  let chestOpening = false;
  let chestResultOverlay = null;
  function openChestModal(chest) {
    const st = S();
    const info = (st.chest && st.chest.chests || []).find(function (c) { return c.id === chest.id; }) || {};
    // 持有一律以背包为准（st.chest 快照可能比一次开箱响应旧，会让「还有几箱」判断与实际不符）
    const have = (st.inventory && st.inventory[chest.id] != null) ? st.inventory[chest.id] : (info.have || 0);
    if (!(have > 0)) { toast('没有「' + chest.name + '」可开，请先合成'); renderView(); return; }
    const doOpen = function (sel) {
      if (chestOpening) { toast('正在开箱，请稍候…'); return; }
      chestOpening = true;
      const release = function () { chestOpening = false; };
      Promise.resolve(window.Net.chestOpen(chest.id, sel)).then(function (r) {
        if (!r || !r.ok) { toast((r && r.data && r.data.error) || '开箱失败'); return null; }
        st.player.coins = r.data.coins;
        applyInvFrom(r.data);
        if (r.data.chests) st.chest = Object.assign({}, st.chest, { chests: r.data.chests });
        renderTopbar(); renderView();
        showChestResult(chest, r.data);
        return r;
      }).catch(function () { toast('网络错误'); }).then(release, release);
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
  // 工坊「开箱」页签：渲染进 ws-body（原 renderChest 渲染整个 main，并入工坊后只画页签内容区）
  function wsRenderOpen(body) {
    const st = S();
    const info = st.chest;
    body.innerHTML = '';
    body.appendChild(el('div', 'ws-open-head',
      '<h3>🎁 开箱 · 沉船打捞</h3>' + pageHelp('残片 + 金币换宝匣，档位越高消除的随机越多：Ⅲ 档自选底材且满词条，Ⅳ 档必定神话。开箱后才产出组件。')));
    if (!info) {
      body.appendChild(el('div', 'hint', '宝匣数据加载中…（若长时间无响应请刷新页面）'));
      return;
    }
    // 残片与宝匣持有量以背包为权威（SSE assets 会持续刷新），不用服务端快照里可能已过期的 have
    const invNow = st.inventory || {};
    const relicHave = invNow.relic || 0;
    const coins = st.player.coins || 0;
    const pityN = info.pityN || 0;
    body.appendChild(el('div', 'chest-bar',
      '<span class="cb-item">' + esc(info.relicName || '沉船宝匣残片') + ' ×<b data-have="relic">' + relicHave + '</b></span>' +
      '<span class="cb-item">💰 <b data-have="@coins">' + coins + '</b></span>' +
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
          '<span class="cc-have">持有 ×<span data-have="' + esc(chest.id) + '">' + have + '</span></span></div>' +
        '<div class="cc-desc">' + esc(chest.desc) + '</div>' +
        '<div class="cc-plan">' + esc(chestPlanText(chest)) + '</div>' +
        '<div class="cc-cost">消耗：' + esc(info.relicName || '残片') + ' ×<b>' + chest.costRelic + '</b>' +
          ' + 💰<b>' + chest.costCoins + '</b></div>' +
        pityLine +
        '<div class="cc-acts"></div>';
      const acts = card.querySelector('.cc-acts');
      const b1 = el('button', 'mini primary-mini', '合成 ×1');
      markFeature(b1, 'workshop.craft');
      b1.disabled = maxN < 1;
      b1.title = maxN < 1 ? '残片或金币不足' : '消耗 ' + chest.costRelic + ' 残片 + ' + chest.costCoins + ' 金币';
      b1.addEventListener('click', function () { craftChest(chest, 1); });
      acts.appendChild(b1);
      if (maxN > 1) {
        const bAll = el('button', 'mini', '合成最多 ×' + maxN);
        markFeature(bAll, 'workshop.craft');
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
      markFeature(b2, 'workshop.open');
      b2.disabled = have < 1;
      b2.title = have < 1 ? '先合成宝匣' : '消耗 1 个「' + chest.name + '」开箱';
      b2.addEventListener('click', function () { openChestModal(chest); });
      acts.appendChild(b2);
      grid.appendChild(card);
    });
    body.appendChild(grid);
    body.appendChild(el('div', 'hint',
      '宝匣可到「开放市集」出售或与玩家交易（系统商店不收购）。开箱产出的组件直接进背包，可装备 / 出售 / 上架。'));
  }
  function craftChest(chest, qty) {
    const st = S();
    Promise.resolve(window.Net.chestCraft(chest.id, qty)).then(function (r) {
      if (!r || !r.ok) { toast((r && r.data && r.data.error) || '合成失败'); return null; }
      st.player.coins = r.data.coins;
      applyInvFrom(r.data);
      if (r.data.chests) st.chest = Object.assign({}, st.chest, { chests: r.data.chests, relicHave: (r.data.inventory && r.data.inventory.relic) || 0 });
      toast('合成「' + chest.name + '」×' + qty + ' 成功');
      renderTopbar(); renderView();
      return r;
    }).catch(function () { toast('网络错误'); });
  }

  // ---- 工坊 · 熔炼 / 重铸 ----
  // 熔炼：主件 + 副件（**必须同部位**）各选一条词条 → 熔炼成功后主件的词条就是这两条，并重新 roll 数值；
  //   v0.11.5 起**副件连区间一起提供**：副件搬来的词缀按副件自己的底材区间取值（副件本身是突破件、
  //   该词缀在副件池外时按池外区间）；后台可关掉该行为，回退「主件池内按主件区间」的旧规则。
  //   可选催化剂（旧称投料）：补一条熔炼结果还没有的词缀——默认**不受主件底材池限制**（可取全部 6 类词缀里没有的那些），
  //   补缀后词条数上限默认 3（越过品质上限与池长）；补缀词缀默认按**池外（突破）区间**取值，
  //   与宝匣突破件同一套区间（后台「池外词缀数值区间」改动即时生效）。以上三项都可在后台「⚒ 工坊配置」调整。
  //   可选龙宫宝珠：roll 值改为掷两次取靠近区间边界的那次（与海王遗匣同一规则）。
  //   可选残片保留（v0.11.3，仅海王遗匣产出的神话主件）：投至多 10 片沉船宝匣残片，成功时按概率
  //     （每片概率由后台公式按主件突破词缀条数算，默认 10 - 突破数×0.5，见 D.retainChancePerRelic）
  //     把主件的池外词缀按原值保留到结果上（突破/催化/附件搬来的都算）；残片不计入催化剂 → 不改成功率与花费。
  //   失败（v0.11.3 起）：副件 / 催化剂 / 残片熔毁、金币花掉，主件被熔掉**选中的那条词条**（其余词条与品质保留）；
  //     但若投入了残片，主件选中的词条在失败时也受保护（服务端回传 protectedAffix）。
  // 重铸：把宝匣产出的**神话**组件放进去，用沉船宝匣残片重 roll 全部词条的数值（类型与条数不变）。
  //   成功率和花费都由后台「⚒ 工坊配置」决定，服务器权威。
  let wsTab = 'smelt';          // 'open' | 'smelt' | 'recast'（'open' = 原宝匣合成页并入的开箱页签）
  let wsMain = '', wsSub = '', wsMainAffix = '', wsSubAffix = '', wsPearl = false;
  let wsMats = {};              // { 材料id: 份数 }（催化剂草稿，重绘间保留）
  let wsRelics = 0;             // 残片保留：投入的沉船宝匣残片片数（0 ~ smeltCfg.retainMaxRelic）
  let wsRecast = '';            // 重铸选中的组件签名

  // 选中的组件实例是否还在背包里（被熔炼 / 重铸消耗、出售、上架、交易后就不在了）
  function wsAlive(id) { return !!(id && D.componentOf(id) && (S().inventory[id] || 0) > 0); }
  // 清掉指向「已不存在的组件」的选中项：否则工坊会停在「卡片还是旧组件、点熔炼/重铸却报错」的悬空状态。
  // 装备到钓竿上的组件不在背包里，同样按不可选处理（与选择列表的口径一致）。
  function wsPruneStale() {
    if (wsMain && !wsAlive(wsMain)) { wsMain = ''; wsMainAffix = ''; wsRelics = 0; }
    if (wsSub && !wsAlive(wsSub)) { wsSub = ''; wsSubAffix = ''; }
    if (wsRecast && !wsAlive(wsRecast)) wsRecast = '';
    // 主件换了部位（或已失效）后，原副件必须与主件同部位，否则清掉
    const a = D.componentOf(wsMain), b = D.componentOf(wsSub);
    if (wsSub && (!b || !a || a.part !== b.part)) { wsSub = ''; wsSubAffix = ''; }
  }

  // 背包里可作为素材的组件实例（按价格降序，稳定展示）
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
  // 主/副件卡片（点击打开与「装备组件」同一个组件选择子页面）
  function wsCompCardHtml(which, comp, hint) {
    const title = which === 'main' ? '主组件（保留）' : '副组件（熔毁）';
    const icon = which === 'main' ? '🔧' : '🔥';
    if (!comp) {
      return '<div class="ws-col"><h3>' + icon + ' ' + title + '</h3>' +
        '<button class="ws-pick empty" data-pick="' + which + '">＋ 点击选择组件</button>' +
        '<div class="hint">' + esc(hint) + '</div></div>';
    }
    const affs = comp.meta.affixes.map(function (a) {
      const rng = affixRangeIn(comp.meta, a);
      const rtxt = rng ? rangeText({ min: rng[0], max: rng[1] }) : '';
      return '<button class="ws-aff' + (a.value < 0 ? ' neg' : '') + (a.extra ? ' extra' : '') + affixKindCls(a) +
        ((which === 'main' ? wsMainAffix : wsSubAffix) === a.type ? ' on' : '') +
        '" data-which="' + which + '" data-type="' + esc(a.type) + '">' + esc(affixText(a)) +
        (rtxt ? '<span class="ws-aff-rng">' + esc(rtxt) + '%</span>' : '') + '</button>';
    }).join('');
    return '<div class="ws-col"><h3>' + icon + ' ' + title + '</h3>' +
      '<button class="ws-pick chosen" data-pick="' + which + '">' +
      '<img class="ws-pick-icon" src="assets/item/' + esc(comp.meta.baseId) + '.png" alt="" draggable="false" onerror="this.style.display=\'none\'">' +
      '<span class="ws-pick-name ' + qualityClass(comp.meta) + '">' + esc(comp.meta.name) + '</span>' +
      itemTag(comp.meta) +
      '<span class="ws-pick-meta">' + esc(partNameOf(comp.meta.part)) + ' · ' + esc(comp.meta.qualityName) + ' · 持有 ×' + comp.count + '</span>' +
      '<span class="ws-pick-change">更换</span></button>' +
      '<div class="ws-affs">' + affs + '</div>' +
      '<div class="hint">' + (which === 'main' ? '点击选择主件保留的词条' : '点击选择从副件搬到主件的词条') + '</div></div>';
  }
  // 残片保留信息（只对海王遗匣产出的神话主件开放，判据与「重铸」一致 = 神话品质）
  //   eligible：主件是神话件且**确实带池外词缀**（突破/催化/附件搬来的都算）——没有可保留的词条时投入残片没有意义
  //   cap：还能投入几片（后台上限与背包持有量取小）；qty：当前草稿夹紧后的片数
  //   bt：主件的**突破词缀**条数（只数 src='bt' 的海王遗匣池外词缀）—— 每片保留概率由后台公式算
  //       （默认 10 - bt×0.5），突破越多越难保留；附件搬来的普通池外词缀与催化词缀不参与该公式
  function wsRetainInfo(comp) {
    const cfg = D.getSmeltCfg();
    const max = Math.max(0, Math.floor(Number(cfg.retainMaxRelic) || 0));
    const meta = comp && comp.meta;
    const affixes = meta ? D.smeltExtraAffixesOf(meta.baseId, meta.affixes) : [];
    const eligible = !!(meta && D.canRecast(meta) && affixes.length > 0);
    const bt = affixes.length;
    const per = D.retainChancePerRelic(bt);
    const have = S().inventory.relic || 0;
    const cap = Math.max(0, Math.min(max, have));
    const qty = eligible ? Math.max(0, Math.min(cap, Math.floor(wsRelics) || 0)) : 0;
    return {
      eligible: eligible, max: max, per: per, bt: bt, formula: cfg.retainFormula || '', affixes: affixes,
      have: have, cap: cap, qty: qty, chance: D.smeltRetainChance(qty, bt),
    };
  }
  function wsPlan() {
    const cfg = D.getSmeltCfg();
    const comps = wsComponents();
    const mainC = comps.find(function (c) { return c.id === wsMain; });
    const subC = comps.find(function (c) { return c.id === wsSub; });
    const mats = Object.keys(wsMats).map(function (id) { return { id: id, qty: Number(wsMats[id]) || 0 }; })
      .filter(function (e) { return e.qty > 0; });
    const load = D.smeltLoadOf(mats);
    const pearl = !!wsPearl && (S().inventory[D.SMELT_PEARL] || 0) > 0;
    const rates = D.smeltRatesOf(load, pearl);
    const gold = D.smeltGoldOf(load, pearl);
    const retain = wsRetainInfo(mainC);
    const addCap = D.smeltAddAffixCap();
    let error = '';
    if (!mainC) error = '请选择主组件';
    else if (!subC) error = '请选择副组件';
    else if (mainC.meta.part !== subC.meta.part) {
      error = '主件与副件必须是同一部位的组件（当前：' + partNameOf(mainC.meta.part) + ' / ' + partNameOf(subC.meta.part) + '）';
    } else if (!wsMainAffix) error = '请选择主件上要保留的词条';
    else if (!wsSubAffix) error = '请选择副件上要搬运的词条';
    else if (wsMainAffix === wsSubAffix) error = '主副选中的词条类型不能相同';
    else if (load.total > Number(cfg.maxMaterials)) {
      error = '催化剂最多 ' + cfg.maxMaterials + ' 份（当前 ' + load.total + ' 份），请减少份数';
    } else if (Object.keys(load.byAffix).length > Number(cfg.maxTypes)) {
      error = '催化剂最多 ' + cfg.maxTypes + ' 种（当前 ' + Object.keys(load.byAffix).length + ' 种），请清空多余材料';
    } else if (load.total > 0) {
      const addable = D.smeltAddableAffixes(mainC.meta.baseId, [wsMainAffix, wsSubAffix]);
      if (addable.indexOf(load.dominant) < 0) {
        error = '催化剂对应「' + (D.AFFIX_LABEL[load.dominant] || load.dominant) + '」，但熔炼结果里已经有这条词缀了';
      } else if (2 + 1 > addCap) {
        error = '补缀后词条数会超过上限（' + addCap + ' 条），可在后台「⚒ 工坊配置」调整';
      }
    }
    // 预览里要点出的三条词缀区间（与服务端掷骰同一份口径，见 data.js 的 smeltRangeEx）。
    // v0.12.2：按词缀自己的范围来源取区间（副件那条按副件带来的区间、补缀按催化/突破区间）。
    const mid = mainC ? mainC.meta.baseId : null, sid = subC ? subC.meta.baseId : null;
    const extraType = load.total > 0 ? load.dominant : null;
    const mPart = mainC ? mainC.meta.part : null;
    const mainAff = mainC && wsMainAffix ? mainC.meta.affixes.find(function (a) { return a.type === wsMainAffix; }) : null;
    const subAff = subC && wsSubAffix ? subC.meta.affixes.find(function (a) { return a.type === wsSubAffix; }) : null;
    const ranges = (mainC && subC) ? {
      main: wsMainAffix ? D.smeltRangeEx(mid, sid, 'main', wsMainAffix, { part: mPart, src: mainAff && mainAff.src }) : null,
      sub: wsSubAffix ? D.smeltRangeEx(mid, sid, 'sub', wsSubAffix, { part: mPart, src: subAff && subAff.src }) : null,
      add: extraType ? D.smeltRangeEx(mid, sid, 'add', extraType, { part: mPart }) : null,
    } : null;
    return {
      ok: !error, error: error, main: mainC, sub: subC, materials: mats, load: load,
      pearl: pearl, rates: rates, gold: gold, extraType: extraType, ranges: ranges, addCap: addCap,
      rollBoundary: pearl && (D.getSmeltCfg().pearlRollTwice !== false),
      retain: retain,
    };
  }
  // 取值区间的来源说明（与 D.smeltRangeEx 同一套口径，只用于界面上标注「这条词缀按谁的区间 roll」）
  // re = { range, src }：src = 底材id / 'bt' 突破区间 / 'ct' 催化区间
  function wsRangeNote(re, kind) {
    if (!re) return '';
    const src = re.src;
    if (src === 'bt') return '突破区间';
    if (src === 'ct') return '催化区间';
    const main = D.componentOf(wsMain), sub = D.componentOf(wsSub);
    if (src && D.componentBase(src)) {
      if (main && src === main.baseId) return '主件区间';
      if (sub && src === sub.baseId) return '副件区间';
      return '来源底材区间';
    }
    return kind === 'main' ? '主件区间' : '突破区间';
  }
  // 「词缀：来源区间 +a ~ +b%」一行（熔炼结果预览用）
  function wsAffixRangeLine(kind, type, re) {
    if (!type || !re || !re.range) return '';
    return '<li>' + esc(D.AFFIX_LABEL[type] || type) + '：<span class="muted">' + esc(wsRangeNote(re, kind)) +
      '</span> <b>' + esc(rangeText({ min: re.range[0], max: re.range[1] })) + '%</b></li>';
  }
  // 催化剂区按规则过滤（服务端 smelt 校验的同一套判据，见 data.js 的 smeltAddableAffixes）：
  //   主副各选一条词条后，熔炼结果就是这两条 → 只有「结果里还没有」的词缀才补得进去，其余材料直接不显示；
  //   顺带按上限判断（补缀后 2+1 条不得超过 addAffixCap），超限时整个催化剂区都不可用。
  //   两条词条没选完时规则未定，仍然全列出来，免得还没选就被藏掉选项。
  // 被隐藏的材料连同已填份数一起清掉：否则会留下「看不见却仍在投」的份数，到熔炼时才报错。
  function wsFitMaterials() {
    const comps = wsComponents();
    const mainC = comps.find(function (c) { return c.id === wsMain; });
    const known = !!(mainC && wsMainAffix && wsSubAffix);
    const addable = known ? D.smeltAddableAffixes(mainC.meta.baseId, [wsMainAffix, wsSubAffix]) : [];
    const capOk = 2 + 1 <= D.smeltAddAffixCap();
    const note = $('ws-mats-note');
    let hidden = 0;
    document.querySelectorAll('.ws-mat[data-mat]').forEach(function (row) {
      const aff = row.getAttribute('data-affix');
      const fit = !known || (capOk && !!aff && addable.indexOf(aff) >= 0);
      row.classList.toggle('hide', !fit);
      if (fit) return;
      hidden++;
      const id = row.getAttribute('data-mat');
      if (!wsMats[id]) return;
      delete wsMats[id];
      const inp = row.querySelector('.ws-mat-qty');
      if (inp) inp.value = '0';
    });
    if (note) {
      note.textContent = !known ? ''
        : (!capOk ? '⚠ 当前补缀上限为 ' + D.smeltAddAffixCap() + ' 条，主副两条词条已占满，本次催化剂补不进任何词缀（可在后台「⚒ 工坊配置」调整）'
          : (hidden ? '已按所选词条过滤：只显示这次补得进去的材料（' + hidden + ' 种材料对应的词缀已经在熔炼结果里）' : ''));
    }
  }
  function wsRefreshPreview() {
    const panel = $('ws-preview');
    if (!panel) return;
    wsFitMaterials();                 // 先按规则把补不进去的材料剔掉，再算方案
    const p = wsPlan();
    const st = S();
    const canGold = (st.player.coins || 0) >= p.gold;
    const go = $('ws-go');
    if (!p.ok) {
      panel.innerHTML = '<div class="ws-line err">⚠ ' + esc(p.error) + '</div>';
      if (go) go.disabled = true;
      return;
    }
    const rr = p.ranges || {};
    const extra = p.extraType
      ? '<div class="ws-line">补缀：<b>' + esc(D.AFFIX_LABEL[p.extraType] || p.extraType) + '</b>（催化剂 ' + p.load.total +
        ' 份）· 成功率 <b>' + p.rates.extraRate + '%</b>' +
        (rr.add ? ' · ' + esc(wsRangeNote(rr.add, 'add')) + ' <b>' + esc(rangeText({ min: rr.add.range[0], max: rr.add.range[1] })) + '%</b>' : '') +
        '</div>'
      : '<div class="ws-line muted">未投入催化剂：熔炼后主件只有选中的两条词条</div>';
    // 残片保留：只在主件是海王遗匣神话件（且带池外词缀）时出现
    //   每片概率与总概率都由后台公式按主件的突破词缀条数算（突破越多越难保留），这里把条数一起点出来
    const rt = p.retain;
    const retainLine = rt.eligible
      ? '<div class="ws-line">🛡 残片保留 <b>' + rt.qty + '</b> / ' + rt.max + ' 片（持有 ' + rt.have + '）' +
        ' · 保留池外词缀概率 <b class="ok">' + rt.chance + '%</b>' +
        '<span class="hint">（主件 ' + rt.bt + ' 条突破词缀' +
        (rt.affixes.length > rt.bt ? '（池外词缀共 ' + rt.affixes.length + ' 条）' : '') + ' → 每片 ' + rt.per + '%' +
        (rt.formula ? '，公式：' + esc(rt.formula) : '') + '；成功后保留下面的词条原值；' +
        '残片不计入催化剂，不影响成功率与花费）</span></div>' +
        '<div class="ws-line muted">可保留的池外词缀：' +
        rt.affixes.map(function (a) { return esc(affixText(a)); }).join(' · ') + '</div>'
      : '';
    panel.innerHTML =
      '<div class="ws-line">熔炼成功率 <b class="ok">' + p.rates.rate + '%</b>' +
      ' · 失败率 <b class="err">' + p.rates.failRate + '%</b>' +
      '（失败损失副件 / 催化剂 / 残片，且主件被熔掉选中的那条词条）</div>' +
      extra + retainLine +
      '<div class="ws-line">花费 <b class="' + (canGold ? '' : 'err') + '">' + p.gold + '💰</b>' +
      (rt.qty > 0 ? ' · 另有 ' + rt.qty + ' 片沉船宝匣残片' : '') +
      (p.pearl ? ' · 已加入龙宫宝珠：' + (p.rollBoundary ? 'roll 两次取靠近区间边界的值' : '（后台已关闭边界取值）') : '') + '</div>' +
      '<div class="ws-line muted">熔炼后主件词缀（数值重新 roll' + (rt.qty > 0 ? '；池外词缀按原值保留' : '') + '）：</div>' +
      '<ul class="ws-res-affs">' +
      wsAffixRangeLine('main', wsMainAffix, rr.main) +
      wsAffixRangeLine('sub', wsSubAffix, rr.sub) +
      wsAffixRangeLine('add', p.extraType, rr.add) +
      (rt.qty > 0 ? '<li>🛡 ' + rt.affixes.map(function (a) { return esc(D.AFFIX_LABEL[a.type] || a.type); }).join(' + ') +
        '：<span class="muted">保留原值</span></li>' : '') +
      '</ul>';
    if (go) go.disabled = false;
  }
  // 打开组件选择子页面（与钓竿页「装备组件」同一个子页面）
  function wsOpenPicker(which) {
    const mainC = which === 'sub' ? D.componentOf(wsMain) : null;
    openCompPicker({
      mode: 'pick',
      part: which === 'sub' ? (mainC ? mainC.part : null) : null,
      title: which === 'main' ? '选择主组件' : ('选择副组件（需与主件同部位：' + (mainC ? partNameOf(mainC.part) : '?') + '）'),
      note: which === 'main'
        ? '从背包里挑一件组件作为主件（保留的那件）。可按部位与词条筛选。'
        : '副件会被熔毁，且必须与主件**同部位**——这里只列出与主件同部位的组件。',
      pickLabel: which === 'main' ? '选为主件' : '选为副件',
      exclude: which === 'main' ? [wsSub] : [wsMain],
      getCurrent: function () { return which === 'main' ? wsMain : wsSub; },
      onPick: function (id) {
        if (which === 'main') {
          const before = D.componentOf(wsMain);
          const after = D.componentOf(id);
          wsMain = id; wsMainAffix = '';
          // 主件换了，残片保留的目标词缀也可能换人：片数草稿清零，避免带着上一件的片数过夜
          wsRelics = 0;
          // 主件换部位后，原副件若不同部位就不再合法：直接清掉，避免提交时才报错
          if (before && after && before.part !== after.part) { wsSub = ''; wsSubAffix = ''; }
        } else {
          wsSub = id; wsSubAffix = '';
        }
        renderView();
      },
    });
  }
  function renderWorkshop() {
    const main = $('main');
    const st = S();
    wsPruneStale(); // 选中的组件若已被消耗 / 出售（悬空引用），先清掉再渲染
    main.innerHTML = '';
    const panel = el('div', 'panel wide ws-panel');
    panel.innerHTML = pageHead('⚒', '工坊', '开箱得组件 · 熔炼换词缀 · 重铸洗数值') +
      '<div class="inv-cats ws-tabs section-tabs" role="tablist">' +
      [['open', '🎁 开箱'], ['smelt', '🔥 熔炼'], ['recast', '♻ 重铸']].map(function (kv) {
        return '<button class="inv-cat' + (wsTab === kv[0] ? ' on' : '') + '" data-wstab="' + kv[0] +
          '" role="tab" aria-selected="' + (wsTab === kv[0] ? 'true' : 'false') + '">' + kv[1] + '</button>';
      }).join('') + '</div>';
    const body = el('div', 'ws-body');
    panel.appendChild(body);
    main.appendChild(panel);
    // 页签按钮在 panel 上（body 是它下面的内容容器），绑定要查 panel 而不是 body
    panel.querySelectorAll('[data-wstab]').forEach(function (b) {
      b.addEventListener('click', function () { const t = b.getAttribute('data-wstab'); if (t !== wsTab) { wsTab = t; renderView(); } });
    });
    if (wsTab === 'recast') return wsRenderRecast(body);
    if (wsTab === 'open') return wsRenderOpen(body);
    wsRenderSmelt(body);
  }
  function wsRenderSmelt(body) {
    const st = S();
    const comps = wsComponents();
    if (!comps.length) {
      body.innerHTML = '<div class="ws-help">背包里还没有可熔炼的组件实例。钓竿组件来自钓鱼掉落、宝匣开箱或市集购买。</div>';
      return;
    }
    const mainC = comps.find(function (c) { return c.id === wsMain; }) || null;
    const subC = comps.find(function (c) { return c.id === wsSub; }) || null;
    const rt = wsRetainInfo(mainC);
    // 残片保留：只在主件是「海王遗匣产出的神话件 + 带池外词缀」时出现（否则显一行灰字说明为何没有）
    const retainRow = rt.eligible
      ? '<h3>🛡 残片保留（可选）<span class="hint">成功后按概率保留下主件的池外词缀（突破/催化/附件搬来的）；' +
        '主件 ' + rt.bt + ' 条突破词缀' + (rt.affixes.length > rt.bt ? '（池外词缀共 ' + rt.affixes.length + ' 条）' : '') +
        ' → 每片残片 ' + rt.per + '%' +
        (rt.formula ? '（公式：' + esc(rt.formula) + '）' : '') + '，最多投入 ' + rt.max + ' 片</span></h3>' +
        '<label class="ws-pearl"><input type="checkbox" id="ws-relic-on"' + (rt.qty > 0 ? ' checked' : '') + ' /> ' +
        '🛡 放入 <b>沉船宝匣残片</b>（持有 <span data-have="relic">' + rt.have + '</span>）· 不影响熔炼成功率与花费</label>' +
        '<div class="ws-relic-row" id="ws-relic-row"' + (rt.qty > 0 ? '' : ' style="display:none"') + '>' +
        '<span class="wrl-label">投入片数</span>' +
        '<input class="ipt ws-relic-qty" id="ws-relic-qty" type="number" min="0" max="' + rt.cap + '" value="' + rt.qty + '"' + (rt.cap <= 0 ? ' disabled' : '') + ' />' +
        '<span class="wrl-unit">/ ' + rt.max + ' 片</span>' +
        '<span class="wrl-chance" id="ws-relic-chance">保留概率 ' + rt.chance + '%</span>' +
        '</div>' +
        '<div class="hint wrl-affs">可保留的池外词缀：' + rt.affixes.map(function (a) { return esc(affixText(a)); }).join(' · ') + '</div>'
      : (mainC
        ? '<h3>🛡 残片保留<span class="hint">' +
          (D.canRecast(mainC.meta)
            ? '未启用：该主件没有池外词缀，投入残片没有可保留的词条'
            : '未启用：只有海王遗匣产出的神话主件才能投入残片') +
          '</span></h3>'
        : '');
    body.innerHTML =
      pageHelp('两件<b>同部位</b>组件：主件保留、副件熔毁，各选一条词条熔成主件的新词缀（副件词条连区间一起熔入）；' +
      '成功率与花费随投料变化，失败只丢你选中的那条词条。词缀分<b>池内</b>与<b>池外</b>：池外词缀 = 本底材词缀池里没有的词缀，按来源分三种——' +
      '<b>突破词缀</b>（只有海王遗匣在池外补足才产生）、<b>催化词缀</b>（投入催化剂补缀产生）、' +
      '<b>普通池外词缀</b>（熔炼从附件搬来的词缀）。' +
      '催化剂可为主件再补一条词缀，按<b>催化</b>区间取值；主件是海王遗匣神话件时，残片可在成功时保留其<b>池外词缀</b>' +
      '（公式变量 breakthrough 只数突破词缀）。加入龙宫宝珠可 roll 两次、取更靠区间边界的值。') +
      '<div class="ws-grid">' +
      wsCompCardHtml('main', mainC, '点上方按钮打开组件选择窗口（与钓竿页「装备组件」同一个子页面）') +
      wsCompCardHtml('sub', subC, mainC ? '副件必须与主件同部位（' + esc(partNameOf(mainC.part)) + '）' : '先选主件，再选同部位的副件') +
      '</div>' +
      '<h3>🧵 催化剂（可选）<span class="hint">每种材料对应一个词缀；催化剂份数最多的那种材料决定要补的词缀' +
      '（可补熔炼结果还没有的<b>任意</b>词缀，数值按催化区间取值）</span></h3>' +
      '<div class="ws-mat-grid" id="ws-mats">' + (function () {
        const mats = (st.workshop && st.workshop.materials) || [];
        if (!mats.length) return '<div class="hint">加载中…</div>';
        return mats.map(function (m) {
          const have = st.inventory[m.id] || 0;
          const qty = wsMats[m.id] || 0;
          return '<label class="ws-mat' + (have <= 0 ? ' none' : '') + '" data-mat="' + esc(m.id) + '" data-affix="' + esc(m.affix || '') + '">' +
            '<span class="wm-name">' + esc(m.name) + '</span>' +
            '<span class="wm-aff">→ ' + esc(m.affixName || m.affix) + '</span>' +
            '<span class="wm-have">持有 ' + have + '</span>' +
            '<input class="ipt ws-mat-qty" type="number" min="0" max="99" data-mat="' + esc(m.id) + '" value="' + qty + '"' +
            (have <= 0 ? ' disabled' : '') + ' />' +
            '<span class="wm-unit">份</span>' +
            '<span class="wm-quick">' +
            '<button type="button" class="mini wm-q" data-q="1">+1</button>' +
            '<button type="button" class="mini wm-q" data-q="5">+5</button>' +
            '<button type="button" class="mini wm-q" data-q="0" title="清空该材料的份数">清空</button>' +
            '</span></label>';
        }).join('');
      })() + '</div>' +
      '<div class="hint" id="ws-mats-note"></div>' +
      '<label class="ws-pearl"><input type="checkbox" id="ws-pearl"' + (wsPearl ? ' checked' : '') + ' /> ' +
      '🐚 加入龙宫宝珠（持有 <span data-have="' + esc(D.SMELT_PEARL) + '">' + (st.inventory[D.SMELT_PEARL] || 0) + '</span>）· roll 两次取靠近区间边界的值</label>' +
      retainRow +
      '<div class="ws-preview" id="ws-preview"></div>' +
      '<button class="primary big" id="ws-go">开始熔炼</button>';

    body.querySelectorAll('[data-pick]').forEach(function (b) {
      b.addEventListener('click', function () { wsOpenPicker(b.getAttribute('data-pick')); });
    });
    body.querySelectorAll('.ws-aff').forEach(function (b) {
      b.addEventListener('click', function () {
        const which = b.getAttribute('data-which'), type = b.getAttribute('data-type');
        if (which === 'main') wsMainAffix = type; else wsSubAffix = type;
        body.querySelectorAll('.ws-aff[data-which="' + which + '"]').forEach(function (x) { x.classList.toggle('on', x === b); });
        wsRefreshPreview();
      });
    });
    body.querySelectorAll('.ws-mat-qty').forEach(function (inp) {
      inp.addEventListener('input', function () {
        const id = inp.getAttribute('data-mat');
        const v = Math.max(0, Math.min(99, Math.floor(Number(inp.value) || 0)));
        if (v > 0) wsMats[id] = v; else delete wsMats[id];
        wsRefreshPreview();
      });
    });
    // 催化剂快捷份数按钮：+1 / +5 / 清空（大量投入不用再手打数字）
    body.querySelectorAll('.wm-q').forEach(function (b) {
      b.addEventListener('click', function (ev) {
        ev.preventDefault(); ev.stopPropagation(); // 在 <label> 里，别让点击穿透到输入框
        const row = b.closest('.ws-mat');
        const id = row && row.getAttribute('data-mat');
        if (!id) return;
        const inp = row.querySelector('.ws-mat-qty');
        const have = S().inventory[id] || 0;
        const q = b.getAttribute('data-q');
        const cur = Number(wsMats[id]) || 0;
        // 清空（data-q="0"）：直接归零，不再叠加当前份数；+1 / +5 在现有份数上累加。
        // 注意 Number('0') || 0 === 0，旧写法会让「清空」变成「不动」，这里单独判 q。
        const v = q === '0' ? 0 : Math.max(0, Math.min(have, Math.floor(cur + (Number(q) || 0))));
        if (v > 0) wsMats[id] = v; else delete wsMats[id];
        if (inp) inp.value = v;
        wsRefreshPreview();
      });
    });
    $('ws-pearl').addEventListener('change', function () { wsPearl = this.checked; wsRefreshPreview(); });
    if ($('ws-relic-on')) {
      // 勾选 = 放入残片（默认填满上限），取消勾选 = 不投入；片数输入即时夹紧到「后台上限 ∩ 持有量」
      $('ws-relic-on').addEventListener('change', function () {
        wsRelics = this.checked ? rt.cap : 0;
        renderView();
      });
      if ($('ws-relic-qty')) {
        $('ws-relic-qty').addEventListener('input', function () {
          wsRelics = Math.max(0, Math.min(rt.cap, Math.floor(Number(this.value) || 0)));
          const box = $('ws-relic-chance');
          if (box) box.textContent = '保留概率 ' + D.smeltRetainChance(wsRelics, rt.bt) + '%';
          wsRefreshPreview();
        });
      }
    }
    $('ws-go').addEventListener('click', function () { wsDoSmelt(); });
    wsRefreshPreview();
  }
  // 熔炼执行（二次确认 → 服务器掷骰 → 结果子窗口）
  function wsDoSmelt() {
    const p = wsPlan();
    if (!p.ok) { toast(p.error); return; }
    confirmModal({
      title: '⚒ 确认熔炼',
      okText: '开始熔炼（' + p.gold + '💰' + (p.retain.qty > 0 ? ' + ' + p.retain.qty + ' 残片' : '') + '）',
      html: '主件 <b>' + esc(p.main.meta.name) + '</b> 保留「' + esc(D.AFFIX_LABEL[wsMainAffix] || wsMainAffix) + '」，' +
        '并把副件「' + esc(D.AFFIX_LABEL[wsSubAffix] || wsSubAffix) + '」熔入；<br/>' +
        '副件 <b>' + esc(p.sub.meta.name) + '</b> 与 ' + p.load.total + ' 份材料将被熔毁，花费 <b>' + p.gold + '💰</b>。' +
        (p.retain.qty > 0 ? '<br/>另投入 <b>' + p.retain.qty + '</b> 片沉船宝匣残片：成功后 <b>' + p.retain.chance +
          '%</b> 概率保留池外词缀（' + p.retain.affixes.map(function (a) { return esc(D.AFFIX_LABEL[a.type] || a.type); }).join(' / ') +
          '）；残片不改变成功率与花费。' : '') + '<br/>' +
        '熔炼成功率 <b>' + p.rates.rate + '%</b>' + (p.extraType ? '，补缀成功率 <b>' + p.rates.extraRate + '%</b>' : '') +
        (p.pearl ? '，使用 🐚 龙宫宝珠' : '') + '。<br/>失败损失副件 / 催化剂 / 残片，且主件被熔掉选中的那条词条（其余词条保留）。',
    }).then(function (ok) {
      if (!ok) return;
      Promise.resolve(window.Net.smelt({
        mainId: wsMain, subId: wsSub, mainAffix: wsMainAffix, subAffix: wsSubAffix,
        materials: p.materials, pearl: p.pearl, relics: p.retain.qty,
      })).then(function (r) {
        if (!r || !r.ok) { toast((r && r.data && r.data.error) || '熔炼失败'); return; }
        const st = S();
        st.player.coins = r.data.coins;
        applyInvFrom(r.data);
        wsMats = {}; wsPearl = false; wsRelics = 0;
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
          // 卡片里已经解释过 ★ 标记（池外词缀）；这里只说本次熔炼自身的结算：
          // 补缀是否成功、残片保留是否命中（补缀得来的词缀是催化词缀，不再是「突破词缀」）
          '<div class="cr-note">' +
          (d.extraType ? (d.extraOk ? '已补缀：' + esc(D.AFFIX_LABEL[d.extraType] || d.extraType) + '。' : '补缀未成功（本次没有新增词缀）。') : '') +
          (d.relics > 0
            ? (d.retainOk
              ? ' 🛡 残片保留命中（' + d.relics + ' 片 / ' + d.retainChance + '%）：池外词缀 ' +
                (d.retained || []).map(function (a) { return esc(affixText(a)); }).join(' / ') + ' 已按原值保留。'
              : ' 🛡 残片保留未命中（' + d.relics + ' 片 / ' + d.retainChance + '%）：池外词缀本次丢失，残片已消耗。')
            : '') + '</div>'
        : '')
      : '<div class="cr-fail">💥 熔炼失败：副件 / 催化剂 / 残片已熔毁' +
        (d.protectedAffix ? '；主件选中的词条已被残片保护。' : '，主件被熔掉选中的那条词条。') + '</div>' +
        // 投入残片且失败：protectedAffix = true 表示主件选中的词条因残片保护而未被熔毁
        (d.protectedAffix
          ? '<div class="hint" style="margin:6px 0 2px">🛡 投入残片：主组件选中的词条在失败时已被保护（未被熔毁）</div>'
          : '') +
        (!d.protectedAffix && d.mainAfter
          ? '<div class="hint" style="margin:6px 0 2px">熔毁的是「' + esc(D.AFFIX_LABEL[d.removedAffix] || d.removedAffix) +
            '」，主件剩余词条与品质保留：</div>' + chestItemCardHtml(d.mainAfter)
          : '');
    box.innerHTML = '<div class="modal-head"><span class="modal-title">' +
      (d.success ? '⚒ 熔炼成功' : '⚒ 熔炼失败') + '</span>' +
      '<button class="mini modal-close">✕ 关闭</button></div>' +
      '<div class="modal-body">' + inner +
      '<div class="hint" style="margin-top:6px">成功率 ' + d.rate + '%' +
      (d.extraType ? ' · 补缀成功率 ' + d.extraRate + '%' : '') +
      ' · 花费 ' + d.gold + '💰' + (d.pearl ? ' · 使用龙宫宝珠' : '') +
      (d.relics > 0 ? ' · 残片 ' + d.relics + ' 片（保留概率 ' + d.retainChance + '%）' : '') + '</div>' +
      // 本次熔炼三条词缀各自用的取值区间与范围来源（副件那条按它带来的区间 —— v0.12.2 词缀自带范围来源）
      (d.ranges && d.ranges.main && d.ranges.sub
        ? '<div class="hint" style="margin-top:2px">取值区间：主件 ' + esc(rangeText({ min: d.ranges.main[0], max: d.ranges.main[1] })) + '%' +
          ' · 副件 ' + esc(rangeText({ min: d.ranges.sub[0], max: d.ranges.sub[1] })) + '%' +
          (d.ranges.add ? ' · 补缀（' + esc(d.ranges.addSrc === 'ct' ? '催化区间' : '突破区间') + '）' +
            esc(rangeText({ min: d.ranges.add[0], max: d.ranges.add[1] })) + '%' : '') + '</div>'
        : '') +
      '<div class="cf-actions"><button class="mini primary-mini cr-ok">知道了</button></div></div>';
    overlay.appendChild(box);
    document.body.appendChild(overlay);
    const close = function () { overlay.remove(); };
    box.querySelector('.modal-close').addEventListener('click', close);
    box.querySelector('.cr-ok').addEventListener('click', close);
  }

  // ---- 工坊 · 重铸 ----
  // 放一件宝匣产出的神话组件 → 自动列出所需材料（目前只有沉船宝匣残片）→ 重 roll 全部词条数值。
  function wsRecastInfo() {
    const ws = S().workshop || {};
    const r = ws.recast || {};
    const cfg = D.getSmeltCfg();
    return {
      quality: r.quality || D.RECAST_QUALITY,
      qualityName: r.qualityName || '神话',
      relicId: r.relicId || 'relic',
      relicName: r.relicName || '沉船宝匣残片',
      relicNeed: r.relicNeed != null ? r.relicNeed : (cfg.recastRelic || 0),
      relicHave: S().inventory[r.relicId || 'relic'] || 0,
      gold: r.gold != null ? r.gold : (cfg.recastGold || 0),
      minValue: r.minValue != null ? !!r.minValue : !!cfg.recastMinValue,
    };
  }
  function wsRenderRecast(body) {
    const st = S();
    const info = wsRecastInfo();
    const comp = wsRecast ? D.componentOf(wsRecast) : null;
    const eligible = comp && D.canRecast(comp) ? comp : null;
    const enough = info.relicHave >= info.relicNeed && (st.player.coins || 0) >= info.gold;
    body.innerHTML =
      '<div class="ws-help">重铸只针对<b>宝匣产出的神话组件</b>（海王遗匣的产出，含突破件）：' +
      '保持词条类型与条数不变，把<b>全部词条的数值</b>按当前 roll 模型重新掷一遍。' +
      (info.minValue ? '<b class="ok">当前设置为「至少不比原来差」</b>：每条取新旧里更好的那个。' : '') +
      '所需材料随组件自动识别，目前只有一种。</div>' +
      '<div class="ws-grid">' +
      '<div class="ws-col"><h3>♻ 待重铸组件（' + esc(info.qualityName) + '品质）</h3>' +
      (eligible
        ? '<button class="ws-pick chosen" data-recast-pick="1">' +
          '<img class="ws-pick-icon" src="assets/item/' + esc(eligible.baseId) + '.png" alt="" draggable="false" onerror="this.style.display=\'none\'">' +
          '<span class="ws-pick-name ' + qualityClass(eligible) + '">' + esc(eligible.name) + '</span>' + itemTag(eligible) +
          '<span class="ws-pick-meta">' + esc(partNameOf(eligible.part)) + ' · ' + eligible.affixes.length + ' 词条 · 基准价 ' + eligible.price + '💰</span>' +
          '<span class="ws-pick-change">更换</span></button>' +
          '<div class="ws-affs ws-affs-lines">' + eligible.affixes.map(function (a) {
            const rng = affixRangeIn(eligible, a);
            return affSpanOpen(a) + esc(affixText(a)) +
              (rng ? '<span class="ws-aff-rng">（' + esc(rangeText({ min: rng[0], max: rng[1] })) + '%）</span>' : '') + '</span>';
          }).join('') + '</div>'
        : '<button class="ws-pick empty" data-recast-pick="1">＋ 点击选择组件</button>' +
          '<div class="hint">只有' + esc(info.qualityName) + '品质（宝匣产出）的组件可以重铸；背包里没有符合条件的组件时会列不出来。</div>') +
      '</div>' +
      '<div class="ws-col"><h3>🧾 重铸材料（自动识别）</h3>' +
      '<div class="ws-mat-grid" id="ws-recast-mats">' +
      '<label class="ws-mat' + (info.relicHave >= info.relicNeed ? '' : ' none') + '" data-mat="' + esc(info.relicId) + '" data-need="' + info.relicNeed + '">' +
      '<span class="wm-name">' + esc(info.relicName) + '</span>' +
      '<span class="wm-aff">→ 重铸全部词条</span>' +
      '<span class="wm-have">持有 ' + info.relicHave + '</span>' +
      '<span class="wm-unit">需要 ' + info.relicNeed + '</span></label>' +
      (info.gold > 0 ? '<label class="ws-mat' + ((st.player.coins || 0) >= info.gold ? '' : ' none') +
        '" data-mat="@coins" data-need="' + info.gold + '"><span class="wm-name">金币</span><span class="wm-aff">→ 手续费</span>' +
        '<span class="wm-have">持有 ' + Math.round(st.player.coins || 0) + '</span>' +
        '<span class="wm-unit">需要 ' + info.gold + '</span></label>' : '') +
      '</div>' +
      '<div class="ws-preview">' +
      '<div class="ws-line" id="ws-recast-state">' + (eligible
        ? (enough ? '<b class="ok">材料充足</b>' : '<b class="err">材料不足</b>') +
          '：' + esc(info.relicName) + ' ×' + info.relicNeed + (info.gold > 0 ? ' + 💰' + info.gold : '') +
          ' · 重 roll ' + eligible.affixes.length + ' 条词条的数值'
        : '<span class="muted">先放入一件待重铸的组件</span>') + '</div>' +
      '<div class="ws-line muted">重铸不改变品质 / 底材 / 词条类型与条数，也不会失败——只有数值会变。</div>' +
      '</div>' +
      '<button class="primary big" id="ws-recast-go"' + (eligible && enough ? '' : ' disabled') + '>开始重铸（' +
      info.relicNeed + ' 残片' + (info.gold > 0 ? ' + ' + info.gold + '💰' : '') + '）</button>' +
      '</div></div>';
    body.querySelectorAll('[data-recast-pick]').forEach(function (b) {
      b.addEventListener('click', function () {
        openCompPicker({
          mode: 'pick', part: null, quality: info.quality,
          title: '选择要重铸的组件（' + info.qualityName + '）',
          note: '只列出' + info.qualityName + '品质的组件——目前只有「海王遗匣」的产出（含突破件）符合条件。',
          pickLabel: '选为重铸件',
          exclude: [], getCurrent: function () { return wsRecast; },
          onPick: function (id) { wsRecast = id; renderView(); },
        });
      });
    });
    if ($('ws-recast-go')) $('ws-recast-go').addEventListener('click', function () { wsDoRecast(); });
  }

  // 重铸页的「材料充足 / 不足」与按钮禁用态：资产变化后原地更新（.none 与「持有」数字由 wsPatchAssets 处理）
  function wsRecastPatchState() {
    const st = S();
    const info = wsRecastInfo();
    const comp = wsRecast ? D.componentOf(wsRecast) : null;
    const eligible = comp && D.canRecast(comp) ? comp : null;
    const enough = info.relicHave >= info.relicNeed && (st.player.coins || 0) >= info.gold;
    const line = $('ws-recast-state');
    if (line) {
      const html = eligible
        ? (enough ? '<b class="ok">材料充足</b>' : '<b class="err">材料不足</b>') +
          '：' + esc(info.relicName) + ' ×' + info.relicNeed + (info.gold > 0 ? ' + 💰' + info.gold : '') +
          ' · 重 roll ' + eligible.affixes.length + ' 条词条的数值'
        : '<span class="muted">先放入一件待重铸的组件</span>';
      if (line.innerHTML !== html) line.innerHTML = html;
    }
    const go = $('ws-recast-go');
    if (go) go.disabled = !(eligible && enough);
  }

  // 工坊：纯资产广播（上鱼 / 售出 / 交易只改背包与金币）不整页重建——
  // 只更新「持有 N」数字与下方预览，输入框的焦点、光标与已填份数全部保留
  //（此前每次上鱼都整页重画，正在填的份数会被重建冲掉）。返回 false 表示当前不在工坊页。
  function wsPatchAssets() {
    const main = $('main');
    const st = S();
    if (!main || !main.querySelector('.ws-panel')) return false;
    const have = function (id) {
      return id === '@coins' ? Math.round(st.player.coins || 0) : ((st.inventory && st.inventory[id]) || 0);
    };
    main.querySelectorAll('.ws-mat[data-mat]').forEach(function (lab) {
      const n = have(lab.getAttribute('data-mat'));
      const box = lab.querySelector('.wm-have');
      if (box && box.textContent !== '持有 ' + n) box.textContent = '持有 ' + n;
      const need = Number(lab.getAttribute('data-need')) || 0;
      lab.classList.toggle('none', need > 0 ? n < need : n <= 0);
      const qty = lab.querySelector('.ws-mat-qty');   // 持有量归零时禁用催化剂输入框（与首次渲染一致）
      if (qty && qty.disabled !== (n <= 0)) qty.disabled = n <= 0;
    });
    main.querySelectorAll('[data-have]').forEach(function (sp) {
      const n = String(have(sp.getAttribute('data-have')));
      if (sp.textContent !== n) sp.textContent = n;
    });
    if (wsTab === 'recast') wsRecastPatchState(); else wsRefreshPreview();
    return true;
  }
  function wsDoRecast() {
    const info = wsRecastInfo();
    const comp = D.componentOf(wsRecast);
    if (!comp || !D.canRecast(comp)) { toast('请先选择一件宝匣产出的神话组件'); return; }
    confirmModal({
      title: '♻ 确认重铸',
      okText: '开始重铸（' + info.relicNeed + ' 残片）',
      html: '重铸 <b>' + esc(comp.name) + '</b>？<br/>消耗 <b>' + esc(info.relicName) + ' ×' + info.relicNeed + '</b>' +
        (info.gold > 0 ? ' + 💰' + info.gold : '') + '。<br/>' +
        '全部 ' + comp.affixes.length + ' 条词条会重新掷数值（类型与条数不变）' +
        (info.minValue ? '，且每条都保证不比原来差' : '') + '。',
    }).then(function (ok) {
      if (!ok) return;
      Promise.resolve(window.Net.recast(wsRecast)).then(function (r) {
        if (!r || !r.ok) { toast((r && r.data && r.data.error) || '重铸失败'); return; }
        const st = S();
        st.player.coins = r.data.coins;
        applyInvFrom(r.data);
        wsRecast = r.data.id || '';
        renderTopbar(); renderView();
        wsShowRecastResult(comp, r.data);
      }).catch(function () { toast('网络错误'); });
    });
  }
  function wsShowRecastResult(before, d) {
    const overlay = buildOverlay(function () { overlay.remove(); });
    const box = el('div', 'modal-box confirm-modal chest-result-modal');
    const lines = (d.item ? d.item.affixes : []).map(function (a, i) {
      const b = (before && before.affixes[i]) || { value: null };
      const up = b.value != null && a.value > b.value;
      const same = b.value != null && a.value === b.value;
      return '<div class="rc-line">' + esc(D.AFFIX_LABEL[a.type] || a.type) +
        '<span class="rc-old">' + (b.value == null ? '—' : (b.value > 0 ? '+' : '') + b.value) + '</span>' +
        '<span class="rc-arrow">→</span>' +
        '<span class="rc-new ' + (up ? 'up' : (same ? 'same' : 'down')) + '">' + (a.value > 0 ? '+' : '') + a.value + '</span>' +
        (a.extra ? '<span class="aff-extra-tag ' + (affixKind(a) === 'breakthrough' ? 'bt' : (affixKind(a) === 'catalyst' ? 'ct' : 'ex')) + '">' + esc(extraAffixName(a)) + '</span>' : '') + '</div>';
    }).join('');
    box.innerHTML = '<div class="modal-head"><span class="modal-title">♻ 重铸完成</span>' +
      '<button class="mini modal-close">✕ 关闭</button></div>' +
      '<div class="modal-body">' +
      (d.item ? chestItemCardHtml(d.item) : '') +
      '<div class="rc-diff">' + lines + '</div>' +
      '<div class="hint" style="margin-top:6px">消耗 ' + esc((d.materials && d.materials[0] && d.materials[0].name) || '材料') + ' ×' + d.relicNeed +
      (d.gold ? ' + 💰' + d.gold : '') + ' · 剩余 ' + (d.materials && d.materials[0] ? d.materials[0].have : '—') + ' 个</div>' +
      '<div class="cf-actions"><button class="mini primary-mini cr-ok">知道了</button></div></div>';
    overlay.appendChild(box);
    document.body.appendChild(overlay);
    const close = function () { overlay.remove(); };
    box.querySelector('.modal-close').addEventListener('click', close);
    box.querySelector('.cr-ok').addEventListener('click', close);
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
        applyInvFrom(r.data);
        if (r.data.mall) s2.mall = r.data.mall;
        toast('已购买 ' + r.data.name + ' ×' + r.data.qty + '（-' + r.data.cost + '💰）');
        renderTopbar(); renderView();
      }).catch(function () { toast('网络错误'); });
    });
  }
  // ---- 商城：限购 / 收购（原系统商店）/ 市集（原开放市集）三合一 ----
  // 采用工坊「熔炼 / 重铸」同款页签切换（.inv-cats.ws-tabs）；原两个独立页面已从 NAV 移除。
  let mallTab = 'mall';         // 'mall' 限购 | 'shop' 收购 | 'market' 市集
  function mallTabsHtml(active) {
    return '<div class="inv-cats ws-tabs section-tabs" role="tablist">' +
      [['mall', '🛒 限购'], ['shop', '🪙 收购'], ['market', '💱 市集']].map(function (kv) {
        return '<button class="inv-cat' + (active === kv[0] ? ' on' : '') + '" data-malltab="' + kv[0] +
          '" role="tab" aria-selected="' + (active === kv[0] ? 'true' : 'false') + '">' + kv[1] + '</button>';
      }).join('') + '</div>';
  }
  function bindMallTabs(panel) {
    if (!panel) return;
    panel.querySelectorAll('[data-malltab]').forEach(function (b) {
      b.addEventListener('click', function () { const t = b.getAttribute('data-malltab'); if (t !== mallTab) { mallTab = t; renderView(); } });
    });
  }
  // 「商城页里的收购 / 市集」判定：广播刷新与骨架判断要用（旧视图 id 已并入 mall）
  function inShopView() { return currentView === 'mall' && mallTab === 'shop'; }
  function inMarketView() { return currentView === 'mall' && mallTab === 'market'; }
  // 商城·限购：资产广播（上鱼 / 别处出售改金币）就地刷新，不整页重建。
  // 限购卡上的「剩余 / 持有」都取自服务器下发的 mall 快照（只有 mall 广播才换新），
  // 所以资产广播真正会变的只有顶栏金币与按钮的可购状态——照这两处刷即可，DOM 一个都不重建。
  function patchMallLimit() {
    const main = $('main');
    if (!main || !main.querySelector('.mall-grid')) return false;
    const st = S();
    const mall = st.mall;
    if (!mall || !mall.items) return false;
    const coins = Math.round(st.player.coins || 0);
    const cEl = main.querySelector('.mall-coins');
    if (cEl) cEl.textContent = '💰 ' + coins;
    mall.items.forEach(function (it) {
      const card = main.querySelector('.mall-card[data-id="' + it.id + '"]');
      if (!card) return;
      const soldOut = it.remain === 0;
      const b1 = card.querySelector('.mc-acts button');
      if (b1) {
        b1.disabled = soldOut || coins < it.price;
        b1.title = soldOut ? '今日限购已用完，等刷新后重置' : (coins < it.price ? '金币不足' : '购买（可选择数量）');
      }
      const bAll = card.querySelectorAll('.mc-acts button')[1];
      if (bAll) bAll.disabled = coins < it.price * it.remain;
    });
    return true;
  }
  function renderMall() {    if (mallTab === 'shop') return renderShop();
    if (mallTab === 'market') return renderMarket();
    const main = $('main');
    const st = S();
    main.innerHTML = '';
    const panel = el('div', 'panel wide');
    panel.innerHTML = pageHead('🛒', '商城', '限购 · 金币直购 ｜ 收购 · 卖给系统 ｜ 市集 · 玩家挂单') + mallTabsHtml('mall') +
      pageHelp('限购用金币直购官方商品（按刷新时间每日重置）；收购把渔获与材料卖给系统换金币；市集是玩家之间的挂单买卖。');
    bindMallTabs(panel);
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
      card.setAttribute('data-id', it.id);   // 就地补丁用（见 patchMallLimit）
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
      markFeature(b1, 'mall.buy');
      b1.disabled = soldOut || (st.player.coins || 0) < it.price;
      b1.title = soldOut ? '今日限购已用完，等刷新后重置'
        : ((st.player.coins || 0) < it.price ? '金币不足' : '购买（可选择数量）');
      b1.addEventListener('click', function () { mallBuyFlow(it); });
      acts.appendChild(b1);
      if (it.limit > 1 && !soldOut) {
        const bAll = el('button', 'mini', '买满 ×' + it.remain);
        markFeature(bAll, 'mall.buy');
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
              s2.player.coins = r.data.coins; applyInvFrom(r.data);
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

  // 图鉴的「软刷新」（v0.13.8）：结构没变就只更新卡片文字与档位框，**不重建 DOM**。
  // 卡片里的鱼走 CSS 游动动画（pixel.css px-swim），任何 innerHTML 重建都会让整页动画重头播；
  // 而图鉴会因为「上鱼增量 / 纪录变化 / 价格广播」等各种原因被要求刷新——一律走软刷新才根治。
  let codexSigCache = '';
  function codexStructureSig() {
    const st = S();
    const caught = st.codex || {};
    const items = D.allItems().filter(function (i) { return i.kind !== 'chest'; });
    return [codexCategory, codexSortRarity ? '1' : '0', Object.keys(caught).length, items.length, currentView].join('|');
  }
  function softRefreshCodex() {
    if (currentView !== 'codex') return false;
    if (!document.querySelector('#main .codex-cell[data-cxid]')) return false;
    if (!codexSigCache || codexSigCache !== codexStructureSig()) return false;   // 结构变了交给整页重建
    const st = S();
    const caught = st.codex || {};
    let n = 0;
    document.querySelectorAll('#main .codex-cell[data-cxid]').forEach(function (cell) {
      const id = cell.getAttribute('data-cxid');
      const rec = caught[id];
      if (!rec) return;
      const metas = cell.querySelectorAll('.cx-meta');
      if (metas[0]) metas[0].textContent = '已获得 ' + rec.count + ' 次';
      if (metas[1]) metas[1].textContent = '首获 ' + timeStr(rec.first);
      if (!cell.classList.contains('got')) cell.classList.add('got');
      const meta = itemMeta(id);
      if (meta.kind === 'fish') {
        cell.classList.remove('tier-bronze', 'tier-silver', 'tier-gold');
        cell.classList.add(rec.tier === 'G' ? 'tier-gold' : rec.tier === 'L' ? 'tier-silver' : 'tier-bronze');
      }
      n++;
    });
    const sumCatch = document.getElementById('cx-sum-catch');
    if (sumCatch) sumCatch.textContent = String(st.catchCount || 0);
    return n > 0;
  }

  function renderCodex() {
    const main = $('main');
    const st = S();
    if (softRefreshCodex()) return;   // 只更新数据，不动节点（游动动画不重头播）
    main.innerHTML = '';
    const panel = el('div', 'panel wide');
    const caught = st.codex || {};
    const total = Object.keys(caught).length;
    panel.innerHTML = pageHead('📖', '图鉴', '收集进度与全服纪录合并在这一页') +
      sectionTabsHtml('codex', 'codex', [['codex', '📖 图鉴'], ['records', '🏆 记录']]) +
      pageHelp('按鱼种与底材列出收集进度、产地与个人体型极值；点卡片看完整资料，未解锁的也能查到去哪钓。');
    bindSectionTabs(panel, 'codex');

    // 汇总：图鉴只收「钓得到」的物品——宝匣是合成的、不在任何钓点掉落池里，
    // 收录进来只会显示成「未解锁 · 去产地垂钓即可解锁」的假条目，所以这里剔除。
    const items = D.allItems().filter(function (i) { return i.kind !== 'chest'; });
    const fishItems = items.filter(function (i) { return i.kind === 'fish'; });
    const gotFish = fishItems.filter(function (i) { return caught[i.id]; }).length;
    const summary = el('div', 'codex-summary');
    summary.innerHTML = '<div class="cs-box"><b id="cx-sum-got">' + gotFish + ' / ' + fishItems.length + '</b><span>鱼类收集</span></div>' +
      '<div class="cs-box"><b id="cx-sum-entries">' + total + '</b><span>图鉴条目</span></div>' +
      '<div class="cs-box"><b id="cx-sum-catch">' + (st.catchCount || 0) + '</b><span>累计渔获</span></div>';
    panel.appendChild(summary);

    // 分类页签（与背包一致；数量为各类条目数）
    const tabs = el('div', 'inv-cats sub-cats');
    const spotTotal = D.GROUNDS.reduce(function (n, g) { return n + (g.spots || []).length + ((g.spots || []).length ? 0 : 1); }, 0);
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
          // 可前往的钓点（服务端未锁定）在图鉴里点亮为「已解锁」；锁定的钓场保持压暗的锁态
          const canGo = !g.locked;
          const cell = el('div', 'codex-cell k-spots ' + (canGo ? 'unlocked' : 'locked'));
          cell.innerHTML =
            '<img class="cx-icon spot-icon" src="assets/spot/' + esc(sp.id) + '.png" alt="" draggable="false">' +
            '<div class="cx-name' + (canGo ? '' : ' locked-name') + '">' + esc(g.name + ' · ' + sp.name) + '</div>' +
            '<div class="cx-meta">' + (pool.length ? '产出 ' + pool.length + ' 项' : '未配置掉落池') + '</div>' +
            '<div class="cx-meta locked-line">' + (canGo ? '✅ 已解锁 · 可前往垂钓' : '🔒 尚未开放') + '</div>' +
            ((sp.buffs && sp.buffs.length) ? '<div class="cx-meta cx-spots">⚡ 增益 ' + sp.buffs.length + ' 项</div>' : '') +
            '<div class="cx-meta cx-spots">🎯 点看产出概率</div>';
          cell.title = '点击查看该钓点的实时产出概率（与后台掉落池同步）';
          cell.addEventListener('click', function () { openSpotDetail(g.id, sp.id); });
          grid.appendChild(cell);
        });
        // 无钓点的锁定活动钓场（如霜月冰湖）：钓场卡占位 + 钓场图标，让玩家在图鉴里看得到它
        if (!(g.spots || []).length) {
          const cell = el('div', 'codex-cell k-spots locked');
          cell.innerHTML =
            '<img class="cx-icon spot-icon" src="assets/ground/' + esc(g.id) + '.png" alt="" draggable="false">' +
            '<div class="cx-name locked-name">' + esc(g.name) + '</div>' +
            '<div class="cx-meta">限时活动钓场</div>' +
            '<div class="cx-meta locked-line">🔒 尚未开放</div>' +
            '<div class="cx-meta cx-spots">' + esc(g.desc || '') + '</div>';
          grid.appendChild(cell);
        }
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
      // v0.13.6：图鉴框体品质按已钓到的最高体型档——普通=铜 / 大型=银 / 巨型=金
      // v0.13.8：只有渔获有体型档。材料/组件没有大小，不该被套上「普通=铜框」，
      // 改用与「图鉴 · 钓点」卡一致的高亮边框（k-nosize，见 style.css / pixel.css）。
      const tierCls = !rec ? '' : (it.kind !== 'fish' ? ' k-nosize'
        : (rec.tier === 'G' ? ' tier-gold' : rec.tier === 'L' ? ' tier-silver' : ' tier-bronze'));
      const tierLine = (rec && it.kind === 'fish')
        ? '<div class="cx-meta cx-tier">' + (rec.tier === 'G' ? '🥇 巨型 · 金框' : rec.tier === 'L' ? '🥈 大型 · 银框' : '🥉 普通 · 铜框') + '</div>'
        : '';
      const cell = el('div', 'codex-cell' + (rec ? ' got' + tierCls : '') + ' k-' + it.kind);
      cell.setAttribute('data-cxid', it.id);   // 就地补丁用（上鱼只改这张卡的文字，不重建节点）
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
    codexSigCache = codexStructureSig();
  }

  // 图鉴就地补丁（v0.13.8）：上鱼只改对应卡片的两行文字，不重建 DOM ——
  // 图鉴卡片里的鱼是按 CSS 动画游动的（pixel.css 的 px-swim），任何 innerHTML 重建都会让
  // 动画从头播放，整页的鱼一起「跳」一下（上鱼播报每竿都来，观感就是一直在闪）。
  // 返回 false 表示这张卡不存在（新收录的物种）或不在图鉴页，交给整页重建。
  function patchCodexCell(id) {
    if (currentView !== 'codex') return false;
    const rec = (S().codex || {})[id];
    const cell = document.querySelector('#main .codex-cell[data-cxid="' + id + '"]');
    if (!rec || !cell) return false;
    const metas = cell.querySelectorAll('.cx-meta');
    if (metas[0]) metas[0].textContent = '已获得 ' + rec.count + ' 次';
    if (metas[1]) metas[1].textContent = '首获 ' + timeStr(rec.first);
    // 体型档框体（普通=铜 / 大型=银 / 巨型=金）就地换类；材料与组件没有体型档，保持高亮边框
    const meta = itemMeta(id);
    if (meta.kind === 'fish') {
      cell.classList.remove('tier-bronze', 'tier-silver', 'tier-gold');
      cell.classList.add(rec.tier === 'G' ? 'tier-gold' : rec.tier === 'L' ? 'tier-silver' : 'tier-bronze');
    }
    const sumCatch = document.getElementById('cx-sum-catch');
    if (sumCatch) sumCatch.textContent = String(S().catchCount || 0);
    return true;
  }

  // ---- 记录页签视图 ----
  // 排行榜弹窗：默认「日榜 · 最大」，可切 日榜 / 周榜 / 总榜 × 最大 / 最小。
  // 总榜 = 全服历史前十（服务端 topCatches / topSmall）；日榜与周榜按时间桶现算。
  let recTopFish = null, recTopKind = 'big', recTopRange = 'day';
  function openRecordsModal(fishId, kind, range) {
    recTopFish = fishId;
    recTopKind = kind === 'small' ? 'small' : 'big';
    recTopRange = (range === 'week' || range === 'all') ? range : 'day';
    document.querySelectorAll('.modal-overlay').forEach(function (m) { m.remove(); });
    const meta = itemMeta(fishId);
    const overlay = el('div', 'modal-overlay');
    overlay.addEventListener('click', function (ev) { if (ev.target === overlay) closeRecordsModal(); });
    const box = el('div', 'modal-box shop-modal');
    box.innerHTML = '<div class="modal-head"><span class="modal-title">🏆 ' + esc(meta.name) + ' · 排行榜</span>' +
      '<button class="mini modal-close">✕ 关闭</button></div>' +
      '<div class="modal-body">' +
      '<div class="rec-tabs" id="rt-range"></div>' +
      '<div class="rec-tabs" id="rt-kind"></div>' +
      '<div id="records-modal-body">加载中…</div></div>';
    box.querySelector('.modal-close').addEventListener('click', function () { closeRecordsModal(); });
    overlay.appendChild(box);
    document.body.appendChild(overlay);
    renderRecordsTop();
  }
  function renderRecordsTop() {
    const body = document.getElementById('records-modal-body');
    if (!body) return;
    const labels = S().recordsRankLabel || {};
    const rangeBox = document.getElementById('rt-range');
    const kindBox = document.getElementById('rt-kind');
    if (rangeBox) {
      rangeBox.innerHTML = '';
      rangeBox.appendChild(el('span', 'sub-label', '范围'));
      [['day', '日榜'], ['week', '周榜'], ['all', '总榜']].forEach(function (kv) {
        const b = el('button', 'inv-cat sub' + (recTopRange === kv[0] ? ' on' : ''), kv[1]);
        b.title = labels[kv[0]] || '';
        b.addEventListener('click', function () { if (recTopRange !== kv[0]) { recTopRange = kv[0]; renderRecordsTop(); } });
        rangeBox.appendChild(b);
      });
      if (labels[recTopRange]) rangeBox.appendChild(el('span', 'hint', '（' + labels[recTopRange] + '）'));
    }
    if (kindBox) {
      kindBox.innerHTML = '';
      kindBox.appendChild(el('span', 'sub-label', '榜单'));
      [['big', '🐟 最大'], ['small', '🐠 最小']].forEach(function (kv) {
        const b = el('button', 'inv-cat sub' + (recTopKind === kv[0] ? ' on' : ''), kv[1]);
        b.addEventListener('click', function () { if (recTopKind !== kv[0]) { recTopKind = kv[0]; renderRecordsTop(); } });
        kindBox.appendChild(b);
      });
    }
    const small = recTopKind === 'small';
    body.innerHTML = '加载中…';
    window.Net.recordsTop(recTopFish, recTopKind, recTopRange).then(function (r) {
      if (!document.getElementById('records-modal-body')) return;      // 期间被关掉了
      const box = document.getElementById('records-modal-body');
      if (!r || !r.ok || (r.status && r.status !== 200)) {
        box.innerHTML = '<div class="hint">' + esc((r && r.data && r.data.error) || '加载失败') + '</div>';
        return;
      }
      const top = r.data.top || [];
      const base = fishBaseOf(recTopFish);      // 该鱼基准区间：每条后面的百分比按它的上限算
      box.innerHTML = '';
      if (!top.length) {
        box.appendChild(el('div', 'hint', recTopRange === 'day' ? '今天还没有该鱼种的入榜渔获。' :
          (recTopRange === 'week' ? '本周还没有该鱼种的入榜渔获。' : '该鱼还没有捕获记录。')));
        return;
      }
      top.forEach(function (t, i) {
        const rank = i + 1;
        const medal = rank === 1 ? '🥇' : rank === 2 ? '🥈' : rank === 3 ? '🥉' : '#' + rank;
        const pct = fishBasePct(t.size, base);
        box.appendChild(el('div', 'top10-row',
          '<span class="top10-rank">' + medal + '</span>' +
          '<span class="top10-size' + (small ? ' sf' : '') + '">' + t.size + '<span class="u">cm</span></span>' +
          (pct == null ? '' : '<span class="top10-pct" title="该鱼基准上限 ' + base[1] + 'cm：超过即大型，超过 80% 为巨型">（基准 ' + pct + '）</span>') +
          '<span class="top10-who">' + esc(t.who) + '</span>' +
          '<span class="top10-time">' + dateTimeStr(t.t) + '</span>'));
      });
      box.appendChild(el('div', 'sd-legend', '共收录 ' + top.length + ' 条（每位玩家仅保留最好一条）' +
        (base ? ' · 括号 = 超出该鱼基准上限 ' + base[1] + 'cm 的百分比（>0% 大型 · >80% 巨型）' : '') +
        ' · ' + (recTopRange === 'all' ? '总榜为全服历史成绩' : '日/周榜按入榜时间滚动')));
    });
  }
  function closeRecordsModal() {
    document.querySelectorAll('.modal-overlay').forEach(function (m) { m.remove(); });
  }

  // 鱼的基准体型（data.js 的 size = [min, max]）：记录页与排行榜弹窗共用同一口径。
  // 大型 / 巨型判定就是拿 size[1] 当基准上限（服务端 sizeTierOf），所以标出来最有用。
  function fishBaseOf(id) {
    const m = itemMeta(id);
    return (m && Array.isArray(m.size) && m.size.length === 2) ? m.size : null;
  }
  // 「基准 15~40cm」小字：挂在鱼名后面，省得为看一眼基准去翻图鉴
  function fishBaseTag(id) {
    const b = fishBaseOf(id);
    return b ? '<span class="rc-base" title="该鱼基准体型区间（记录页与排行榜的百分比都按它的上限算）">基准 ' +
      b[0] + '~' + b[1] + 'cm</span>' : '';
  }
  // 超出基准上限的百分比（+ = 比基准上限还大，>0 大型、>80 巨型；负数 = 比基准上限小）
  function fishBasePct(size, base) {
    if (!base || !(size > 0)) return null;
    const p = Math.round((size - base[1]) / base[1] * 1000) / 10;
    return (p >= 0 ? '+' : '') + p + '%';
  }

  function renderRecords() {
    const main = $('main');
    const st = S();
    main.innerHTML = '';
    const panel = el('div', 'panel wide');
    panel.innerHTML = pageHead('📖', '图鉴', '收集进度与全服纪录合并在这一页') +
      sectionTabsHtml('codex', 'records', [['codex', '📖 图鉴'], ['records', '🏆 记录']]) +
      pageHelp('汇总每种鱼的全服最大与最小渔获；点鱼类卡片可切换日榜、周榜与总榜。');
    bindSectionTabs(panel, 'codex');

    const recs = Object.keys(st.records || {}).map(function (id) { return st.records[id]; })
      .sort(function (a, b) { return b.size - a.size; });

    // 顶部：当前最新播报的鱼（与横幅播报同源；还没播报过时退回「全场最大」）
    // 贴图缩放/偏移由后台配置（默认 175% = 245×147）；用 CSS 变量驱动 width/height
    // （而不是 transform: scale），这样放大后卡片会跟着长高、不会压住文字。
    const rc = S().recordsCfg || { scale: 175, x: 0, y: 0 };
    const last = st.recordsLast || null;
    const heroRec = last || (recs.length ? recs[0] : null);
    if (heroRec) {
      const topMeta = itemMeta(heroRec.id);
      const hero = el('div', 'record-hero' + (last ? ' live' : ''));
      hero.innerHTML =
        '<img class="rh-icon" style="--rh-scale:' + (rc.scale / 100).toFixed(4) +
        ';--rh-dx:' + (rc.x || 0) + 'px;--rh-dy:' + (rc.y || 0) + 'px" src="assets/fish/' + esc(heroRec.id) + '.png" alt="" draggable="false">' +
        '<div class="rh-crown">' + (last ? '🔔 最新播报' : '👑 全场最大') + '</div>' +
        '<div class="rh-name ' + rarityClass(topMeta.rarity) + '">' + esc(heroRec.name) + '</div>' +
        (heroRec.size != null ? '<div class="rh-size">' + heroRec.size + '<span class="u">cm</span></div>' : '') +
        (last && last.text ? '<div class="rh-text">' + esc(last.text) + '</div>' : '') +
        '<div class="rh-who">' + (last ? '播报于' : '纪录保持者：') + esc(heroRec.who) + ' · ' + dateTimeStr(heroRec.t) + '</div>';
      panel.appendChild(hero);
    } else {
      panel.appendChild(el('div', 'hint', '还没有渔获纪录。钓到一条鱼就会生成它的最大/最小纪录。'));
    }

    // 分鱼类查看：每种鱼一个卡片，最大与最小合并在一起（大图＝最大纪录、小图＝最小纪录）
    panel.appendChild(el('h3', null, '🐟 分鱼类纪录（最大 / 最小）'));
    panel.appendChild(el('div', 'hint', '每张卡同时给出该鱼的最大与最小纪录：上行＝最大、下行（蓝字）＝最小；鱼名后的灰字是该鱼的基准体型。点击卡片查看排行榜。'));
    const withRec = [], without = [];
    D.allItems().filter(function (i) { return i.kind === 'fish'; }).forEach(function (f) {
      const big = st.records && st.records[f.id];
      const sm = st.smallRecords && st.smallRecords[f.id];
      ((big || sm) ? withRec : without).push({ f: f, big: big, sm: sm });
    });
    withRec.sort(function (a, b) { return ((b.big && b.big.size) || 0) - ((a.big && a.big.size) || 0); });
    const grid = el('div', 'record-grid');
    withRec.concat(without).forEach(function (e) {
      const any = !!(e.big || e.sm);
      const cell = el('div', 'record-cell' + (any ? ' with-rec' : ' none'));
      if (!any) {
        cell.innerHTML =
          '<img class="rc-icon dim" src="assets/fish/' + esc(e.f.id) + '.png" alt="" draggable="false">' +
          '<div class="rc-name locked-name">' + esc(e.f.name) + fishBaseTag(e.f.id) + '</div>' +
          '<div class="rc-size muted">—</div>' +
          '<div class="rc-who">暂无纪录</div>';
        grid.appendChild(cell);
        return;
      }
      cell.innerHTML =
        '<img class="rc-icon" src="assets/fish/' + esc(e.f.id) + '.png" alt="" draggable="false">' +
        '<div class="rc-name ' + rarityClass(e.f.rarity) + '">' + esc(e.f.name) + fishBaseTag(e.f.id) + '</div>' +
        '<div class="rc-size">' + (e.big ? e.big.size + '<span class="u">cm</span>' : '—') + '</div>' +
        '<div class="rc-who">' + (e.big ? esc(e.big.who) + ' · ' + dateTimeStr(e.big.t) : '暂无最大纪录') + '</div>' +
        '<div class="rc-size sf-size">' + (e.sm ? e.sm.size + '<span class="u">cm</span>' : '—') + '</div>' +
        '<div class="rc-who">' + (e.sm ? esc(e.sm.who) + ' · ' + dateTimeStr(e.sm.t) : '暂无最小纪录') + '</div>' +
        '<div class="rc-hint">点击查看排行榜</div>';
      cell.title = '点击查看该鱼的排行榜（默认日榜，可切周榜/总榜与最小）';
      cell.addEventListener('click', function () { openRecordsModal(e.f.id, 'big', 'day'); });
      grid.appendChild(cell);
    });
    panel.appendChild(grid);

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

  // ---- 反馈视图 ----
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
    const mine = (fb.mine || []);
    panel.innerHTML = pageHead('📮', '反馈', '每 ' + cdText + ' 可提交 1 条 · ' + status.skipCost + ' 金币可结束冷却') +
      sectionTabsHtml('feedback', fbTab, [['submit', '✍ 提交'], ['mine', '📜 我的反馈' + (mine.length ? ' ' + mine.length : '')]]) +
      pageHelp(fbTab === 'submit'
        ? '写清复现步骤或建议理由；管理员可在后台逐条改状态并发放奖励。'
        : '按类型与处理状态筛选；已受理 / 已完成会带上奖励与时间。');
    bindSectionTabs(panel, 'feedback');

    // 冷却状态条
    const banner = el('div', 'fb-banner' + (status.ready ? ' ready' : ' cooling'));
    if (status.ready) {
      banner.innerHTML = '✅ 现在可以提交反馈（提交后进入 ' + cdText + ' 冷却）';
    } else {
      const cost = status.skipCost;
      const canPay = (st.player.coins || 0) >= cost;
      banner.innerHTML = '⏳ 冷却中 · 剩余 <b>' + fmtRemain(status.remainingMs) + '</b>';
      const skip = el('button', 'mini primary-mini' + (canPay ? '' : ' locked'), '💸 花 ' + cost + ' 金币立即结束 CD');
      markFeature(skip, 'feedback.skip');
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

    // 提交表单（「✍ 提交」页签）
    if (fbTab === 'submit') {
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
    markFeature(submit, 'feedback.submit');
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
          fbTab = 'mine';   // 提交后直接跳到「我的反馈」：刚提交的这条就在最上面
          renderTopbar(); renderView();
        } else {
          submit.disabled = false; submit.textContent = '提交反馈';
        }
      });
    });
    form.appendChild(submit);
    panel.appendChild(form);
    }

    // 我的历史反馈（可按「反馈类型 + 处理状态」筛选，「📜 我的反馈」页签）
    if (fbTab === 'mine') {
    panel.appendChild(el('h3', null, '📜 我提交过的反馈'));
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
    }
    main.appendChild(panel);
  }

  // ---- 日志视图：记录玩家收到的服务器消息弹窗 ----
  // 来源：notice 提示、公告横幅、交易完成、市集成交、破纪录播报、组件订阅提醒、顶号下线。
  // 数据为前端本地持久化（按账号），过滤页签与背包分类一致。
  // 日志明细行（交易/市集成交流水用）：物品名按品质配色，组件再列出部位与词条数值。
  // 词条数值不在日志里存——物品 id 就是组件实例签名（baseId#quality#code+value），展示时解析即可。
  function logItemsHtml(items) {
    if (!items || !items.length) return '';
    const dirs = { got: [], gave: [] };
    items.forEach(function (it) { (it.dir === 'gave' ? dirs.gave : dirs.got).push(it); });
    const dirLabel = { got: '获得', gave: '给出' };
    return ['got', 'gave'].filter(function (d) { return dirs[d].length; }).map(function (d) {
      const list = dirs[d].map(function (it) {
        const meta = itemMeta(it.id);
        const part = (meta.kind === 'component' && meta.part) ? partCatName(meta.part) : '';
        const affs = (meta.kind === 'component' && meta.affixes && meta.affixes.length)
          ? '<span class="log-item-affs">' + meta.affixes.map(function (a) {
              return affSpanOpen(a) + esc(affixText(a)) + '</span>';
            }).join('') + '</span>'
          : '';
        return '<span class="log-item">' +
          '<span class="' + qualityClass(meta) + '">' + esc(meta.name || it.id) + '</span>' +
          (it.qty > 1 ? '<span class="log-item-qty"> ×' + it.qty + '</span>' : '') +
          (part ? '<span class="log-item-part">' + esc(part) + '</span>' : '') + affs + '</span>';
      }).join('');
      return '<div class="log-detail"><span class="log-dir">' + dirLabel[d] + '</span>' + list + '</div>';
    }).join('');
  }
  // 部位 key → 中文名（组件日志明细里标出「钓竿 / 卷线器 / 鱼钩 / 饰品」）
  function partCatName(key) {
    const p = (D.ROD_PARTS || []).find(function (x) { return x.key === key; });
    return p ? p.name : '';
  }
  let logFilter = 'all';
  function renderLogs() {
    loadLog();
    const main = $('main');
    main.innerHTML = '';
    const panel = el('div', 'panel wide');
    panel.innerHTML = pageHead('📜', '日志', '按类型回看渔获、公告、交易、纪录与订阅提醒');
    const counts = { all: msgLog.length };
    Object.keys(LOG_KINDS).forEach(function (k) { counts[k] = msgLog.filter(function (e) { return e.kind === k; }).length; });
    const tabs = el('div', 'inv-cats sub-cats');
    const kindOrder = ['catch', 'system', 'trade', 'record', 'subscribe'].filter(function (k) { return !!LOG_KINDS[k]; });
    [['all', '📜 全部']].concat(kindOrder.map(function (k) { return [k, LOG_KINDS[k][0] + ' ' + LOG_KINDS[k][1]]; })).forEach(function (kv) {
      const b = el('button', 'inv-cat' + (logFilter === kv[0] ? ' on' : ''), kv[1] + ' ' + (counts[kv[0]] || 0));
      b.addEventListener('click', function () { if (logFilter !== kv[0]) { logFilter = kv[0]; renderView(); } });
      tabs.appendChild(b);
    });
    panel.appendChild(tabs);
    panel.appendChild(el('div', 'hint page-help', '日志只存在本机浏览器（按账号区分），不上传服务器：「🐟 渔获」与「🖥 系统」各留最近 ' +
      LOG_KEEP + ' 条，交易 / 纪录 / 订阅提醒长期保留。'));

    const list = el('div', 'log-page');
    const rows = msgLog.filter(function (e) { return logFilter === 'all' || e.kind === logFilter; });
    if (!rows.length) {
      list.appendChild(el('div', 'hint', msgLog.length ? '该分类下没有记录。' : '还没有收到服务器消息。公告、系统提示、交易与订阅提醒都会记录在这里。'));
    } else {
      rows.forEach(function (e) {
        const kind = LOG_KINDS[e.kind] || LOG_KINDS.system;
        const row = el('div', 'log-row');
        row.innerHTML = '<span class="log-time">' + dateTimeStr(e.t) + '</span>' +
          '<span class="log-tag log-' + e.kind + '">' + kind[0] + ' ' + kind[1] + '</span>' +
          '<span class="log-msg">' + esc(e.msg) + logItemsHtml(e.items) + '</span>';
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
    // 商城 = 限购 + 收购 + 市集 三合一：进页把三份数据都拉齐，页签切换不再单独请求
    else if (view === 'mall') { window.Net.fetchMall(); window.Net.fetchShop(); window.Net.fetchMarket(); }
    // 工坊 = 开箱（原宝匣合成页）+ 熔炼 + 重铸 三合一：进页把宝匣数据也拉齐
    else if (view === 'workshop') { window.Net.fetchWorkshop(); window.Net.fetchChest(); }
    else if (view === 'market') window.Net.fetchMarket();
    else if (view === 'codex') window.Net.fetchCodex();
    else if (view === 'records') window.Net.fetchRecords();
    else if (view === 'feedback') window.Net.fetchFeedback();
  }

  // 重绘前记录可滚动容器位置，重绘后恢复。
  // SSE 广播（他人上鱼/新纪录）会触发整页重绘，若不保留滚动位置，
  // 浏览中的渔获日志 / 记录 / 动态列表会被 innerHTML 重建并拽回顶部。
  const SCROLL_SELECTORS = ['.content', '.catch-log', '.feed', '.codex-detail', '.trade-lists', '.tp-rows', '.bulk-rows', '.log-page', '.market-history'];
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
    const pageId = pageIdOf();
    if (featureBlocked(pageId)) {
      const main = $('main'); main.innerHTML = '';
      const panel = el('div', 'panel wide feature-closed');
      panel.textContent = '🔒 ' + window.GameFeatures.message(S().features, pageId);
      main.appendChild(panel); return;
    }
    hideItemTip();   // 整页重绘会把行换掉（mouseleave 不一定触发），浮标先收起来
    const saved = captureScroll();
    // perf-9：离开社交页时取消玩家列表视口登记（服务器随即停止向本连接推送该页）
    if (currentView !== 'ground' && renderGround._lastViewSig) {
      renderGround._lastViewSig = null;
      if (window.Net) window.Net.setPlayersView({ clear: true });
    }
    // 合并页按当前页签分发（钓鱼 / 钓竿、图鉴 / 记录）；旧 view id 保留分支以便外部平滑迁移
    if (currentView === 'fishing') { if (fishingTab === 'rod') renderBD(); else renderFishing(); }
    else if (currentView === 'character') renderCharacter();
    else if (currentView === 'bd') renderBD();
    else if (currentView === 'ground') renderGround();
    else if (currentView === 'inventory') renderInventory();
    else if (currentView === 'workshop') renderWorkshop();
    else if (currentView === 'mall') renderMall();
    else if (currentView === 'shop') renderShop();
    else if (currentView === 'market') renderMarket();
    else if (currentView === 'codex') { if (codexMainTab === 'records') renderRecords(); else renderCodex(); }
    else if (currentView === 'records') renderRecords();
    else if (currentView === 'feedback') renderFeedback();
    else if (currentView === 'logs') renderLogs();
    else {
      const navItem = D.NAV.find(function (x) { return x.id === currentView; });
      renderPlaceholder(navItem ? navItem.name : '未开放');
    }
    applyFeatureControls();
    const group = window.GameFeatures && window.GameFeatures.byId[pageId];
    const locked = group && group.children && group.children.filter(function (a) { return featureBlocked(a.id); });
    if (locked && locked.length) {
      const panel = document.querySelector('#main .panel');
      if (panel) { const notice = el('div', 'hint feature-notice'); notice.textContent = '🔒 暂停开放：' + locked.map(function (a) { return a.name; }).join('、'); panel.insertBefore(notice, panel.firstChild); }
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
  function showAuth() { $('auth').style.display = 'flex'; syncBrandAdmin(); }
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
    S().features = (profile && profile.features) || {};
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
  // 每秒的钓鱼循环回包：只在「钓鱼」页签刷新主区；停到「钓竿」页签时只刷顶栏，不夺回页面。
  function onFishingTick() {
    if (featureBlocked('fishing')) return;
    if (currentView !== 'fishing') return;
    renderTopbar();
    if (fishingTab === 'fishing') renderFishing();
  }

  // 刷新主视图。每个视图只关心与自己相关的广播类型（scope）：
  // 无关广播（如他人的渔获 feed/players）只更新顶栏/导航，不重绘主区——
  // 否则只要有人上鱼，钓竿页/背包等页面的组件卡片都会跟着整页闪烁重绘。
  //
  // ⚠️ 底层刷新纪律（加新页面 / 加新广播前先读这一段，别再重犯）：
  //  1) 广播只有两类：**数据广播**（上鱼 feed/catch、资产 assets、玩家状态 players/playersPage、
  //     地图人数 grounds、市集 market、商店 shop/pricecfg、宝匣 chest…）与**结构广播**
  //     （后台改配置：groundcfg/castcfg/smeltcfg/componentcfg/chestcfg/mall，以及视图自身完成
  //     拉取后的自绘 scope）。
  //  2) **数据广播永远不许重建页面骨架**。带本地交互状态的容器（搜索框、分页、展开/收起、
  //     勾选、独立滚动条）必须走就地更新：`main.innerHTML=''` 会把滚动位置、焦点、输入法候选、
  //     正在点的那一行一起冲掉，用户报过多次（交易弹窗「东西太多拉下去直接弹回去」、
  //     社交页玩家列表「上鱼播报一来就刷回顶部」）。
  //  3) 就地更新的标准姿势（照抄即可）：
  //     a. 给页面根节点写 `data-sig` 结构签名（renderGround 的 groundSig / renderFishing 的
  //        fishingSig）：签名只包含「会改变 DOM 结构」的量——当前页/页码/搜索词/后台配置，
  //        **绝不包含**次数、人数、渔获、滚动等纯数据；
  //     b. 渲染函数开头 `if (host && host.getAttribute('data-sig') === sig) { 就地更新; return; }`，
  //        只有签名变了才 main.innerHTML='' 重建；
  //     c. 列表用 patchList() 按 key 复用节点，只改文本/class，不重造行；填充函数必须被
  //        「首次铺」和「广播更新」两条路共用，避免两条路渲染出不同的 DOM。
  const VIEW_SCOPES = {
    fishing: ['players', 'grounds', 'catch', 'assets', 'groundcfg', 'castcfg'], // 实况/日志/钓速随广播更新
    bd: [],                                             // 钓竿页签：只随操作重绘（展示数据不受广播影响）
    ground: ['players', 'grounds', 'feed', 'groundcfg'],
    inventory: ['assets', 'shop', 'pricecfg', 'autosellcfg'],
    shop: ['assets', 'shop', 'pricecfg', 'autosellcfg'],
    market: ['assets', 'market'],
    // trade：独立页面已删除（入口在社交页玩家卡片，子窗口自行响应 trade 广播）
    codex: ['codex', 'groundcfg'],
    records: ['records'],
    feedback: ['feedback'],                              // 反馈页：fetchFeedback 到达后重绘（CD/费用随服务器下发）
    logs: [],                                            // 日志页：仅在收到消息（addLog）或本地操作时重绘
    // 商城/工坊：末位是视图自身 id——fetchMall / fetchWorkshop 完成后用 refreshAll('mall'|'workshop')
    // 触发重绘；少了它就会命中「scope 不在列表内 → 不重绘」，页面永远停在「加载中…」。
    // mall 三合一（限购/收购/市集）：三份数据源的广播都要能重绘本页
    mall: ['assets', 'mall', 'shop', 'market', 'pricecfg', 'autosellcfg'],
    // componentcfg（后台改池外/突破区间）也要重绘：工坊补缀与副件搬词的预览区间都取自它。
    // 工坊三合一（开箱/熔炼/重铸）：宝匣数据源的广播（chestcfg 后台配置 / chest 数据到达 /
    // 资产变化中的宝匣数量）也要能重绘本页——fetchChest 完成后 refreshAll('chest') 命中 'chest' scope。
    workshop: ['assets', 'smeltcfg', 'componentcfg', 'workshop', 'chestcfg', 'chest'],
  };
  // 主区内是否有输入控件正被编辑（数字框 / 文本 / 下拉 / 可编辑元素）
  // 例外：渔场页的玩家搜索框。它靠「重建后还回焦点与光标」保证输入不丢（见 renderGround），
  // 若在这里也算「正在编辑」，搜索结果会被这道闸挡住、列表永远不刷新。
  function mainInputFocused() {
    const a = document.activeElement;
    const main = $('main');
    if (!a || !main || a === main || !main.contains(a)) return false;
    if (a.classList && a.classList.contains('peep-search-input')) return false;
    return /^(INPUT|SELECT|TEXTAREA)$/.test(a.tagName) || a.isContentEditable === true;
  }
  function refreshAll(scope) {
    if (featureBlocked(pageIdOf())) { renderTopbar(); renderNav(); renderView(); return; }
    if (scope === 'all') scope = null; // init 全量刷新
    if (scope === 'trade' || !scope) settlePendingTradeCancel(); // 「关闭时邀请还在途」欠下的撤回，会话一落地就补上
    if (shopModalId && scope === 'shop') fillShopModal(shopModalId); // 弹窗数据静默刷新
    // 交易子窗口：打开时 trade/assets 广播只重绘窗口内容，不打断背后页面
    if (tradeModalRedraw && (!scope || scope === 'trade' || scope === 'assets' || scope === 'codex')) {
      renderTopbar(); renderNav();
      // v0.13.4：交易进行中（双方已进入选物品阶段）时，**纯数据广播**（上鱼 / 售出 / 市集成交 /
      // 图鉴新增）不再重建窗口内容。否则每钓到一条鱼都会 bodyEl.innerHTML = '' 重建整个弹窗：
      // 提供物品列表滚回顶部、正在填的数量框被冲掉、刚滚下去勾的行跳走（用户报「东西太多拉下去
      // 直接弹回去」）。这与主交易页既有设计一致（见 tradeLockOn / tradeLockBar）——锁定期间的
      // 库存变化由锁定条上的「🔄 刷新列表」手动同步。
      // 'trade' scope 必须放行：对方增删物品、双方确认状态都靠它更新。
      if (tradeLockOn() && scope && scope !== 'trade') return;
      tradeModalRedraw();
      return;
    }
    // 收到交易邀请（我是被邀请方）且交易子窗口未打开 → 自动弹出（替代原「在线交易」页入口，每个邀请只弹一次）
    if (!tradeModalRedraw) {
      const t0 = S().trade;
      if (t0 && !t0.accepted && !t0.done && !t0.cancelled && t0.id !== lastIncomingTradeId) {
        const meKey0 = S().me && S().me.id != null ? String(S().me.id).toLowerCase() : null;
        if (meKey0 && t0.a && t0.b && t0.b.key === meKey0) {
          lastIncomingTradeId = t0.id;
          openTradeModal(null, t0.a && t0.a.name);
          toast('收到 ' + ((t0.a && t0.a.name) || '对方') + ' 的交易邀请');
        }
      }
    }
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
    // perf-9 / v0.13.4：渔场页玩家搜索框在**输入法合成中**才暂停重绘。
    // 之前是「获得焦点就暂停」，结果回车搜索后列表永远刷不出来（重绘被自己挡掉）；
    // 现在改成重绘后把焦点与光标还回搜索框（见 renderGround），搜索即时生效。
    if (currentView === 'ground' && peepComposing && scope && scope !== 'all') {
      renderTopbar(); renderNav();
      return;
    }
    // 市集筛选控件（词条下拉/数值输入）获得焦点时暂停重绘：否则广播会重建 DOM 导致下拉框被关闭。
    if (inMarketView() && marketFilterActive && scope && scope !== 'all') {
      renderTopbar(); renderNav();
      return;
    }
    // 工坊：纯资产广播（上鱼 / 售出只改背包与金币）原地更新「持有」数字与预览，
    // 不整页重建——正在填的催化剂份数、输入焦点与光标都不受影响。
    if (currentView === 'workshop' && scope === 'assets' && wsPatchAssets()) {
      renderTopbar(); renderNav();
      return;
    }
    // 市集：同上，只重画右栏上架面板，左栏挂单 / 历史订单不重建（不再闪「加载中…」）
    if (inMarketView() && scope === 'assets' && !marketFilterActive && patchMarketAssets()) {
      renderTopbar(); renderNav();
      return;
    }
    // 背包：行情 / 经济参数广播只刷行内价格，不整页重建（售出会改动态价 → 重排 + 收起展开栏）
    if (currentView === 'inventory' && (scope === 'shop' || scope === 'pricecfg') && !invFocus && patchInventoryPrices()) {
      renderTopbar(); renderNav();
      return;
    }
    // 背包：资产广播（上鱼 / 自动售出 / 别处出售）——结构没变就只刷数字，不整页重建。
    // v0.14.0 之前这里会走到 renderView()，挂机时每 1.5 秒重建一次整页（实测一次 125 个按钮），
    // 页签与行内按钮持续闪动、组件展开状态与滚动位置每次都被冲掉。
    if (currentView === 'inventory' && scope === 'assets' && !invFocus && patchInventoryLive()) {
      renderTopbar(); renderNav();
      return;
    }
    // 商城·限购：资产广播只刷金币与可购状态（卡片上的剩余 / 持有来自 mall 快照，资产广播改不了它）
    if (currentView === 'mall' && mallTab === 'mall' && scope === 'assets' && patchMallLimit()) {
      renderTopbar(); renderNav();
      return;
    }
    // 商城·收购：行情 / 资产广播只就地刷卡片数字（现价、持有·可用、出售按钮），不整页重建——
    // 出售会压价，整页重建会按新价格重排、把滚动位置和正在点的卡片顶走（与背包 / 市集同一套做法）。
    // 自动售出规则变了不在这里刷（卡片右上角的 🤖 标记也要跟着变，交给整页重建）。
    if (inShopView() && (scope === 'shop' || scope === 'assets' || scope === 'pricecfg') && !mainInputFocused() && patchShopCards()) {
      renderTopbar(); renderNav();
      return;
    }
    // 主区内任何输入控件获得焦点时（工坊份数 / 商城数量 / 自动售出 / 筛选框…）不重建主区：
    // 广播只刷顶栏与导航，用户正在输入的内容不会被冲掉。交易页除外（有自己的草稿机制）。
    if (scope && currentView !== 'trade' && mainInputFocused()) {
      renderTopbar(); renderNav();
      return;
    }
    renderTopbar(); renderNav();
    // 广播重绘范围按「当前页签折算出的页面 id」取，合并页不会因为另一个页签的广播被整页重建
    const scopes = VIEW_SCOPES[pageIdOf()];
    if (!scope || !scopes || scopes.indexOf(scope) >= 0) renderView();
  }

  function init() {
    wireAuth();
    wireBrand();   // 顶栏品牌 → 管理后台（仅管理员；只绑一次）
    // 启动前先做版本守卫：服务器版本与本地前端不一致时带缓存参数强刷（避免旧缓存进不去新版页面）
    const boot = (window.Net && window.Net.guardVersion) ? window.Net.guardVersion() : Promise.resolve(false);
    boot.then(function (reloading) {
      if (reloading) return; // 已触发整页刷新，不再继续初始化
      initApp();
    }).catch(function () { initApp(); });
  }
  function initApp() {
    // 交易冷却倒计时：交易子窗口打开时，仅在冷却期间更新倒计时文字，冷却结束后补一次重绘
    let cdLast = 0;
    setInterval(function () {
      if (!tradeModalRedraw) { cdLast = 0; return; }
      const t = S().trade;
      if (!t) { cdLast = 0; return; }
      const cd = Math.max(0, (t.cooldownUntil || 0) - Date.now());
      if (cd > 0 || cdLast > 0) {
        // 冷却中 / 刚结束都只改倒计时文字与按钮锁定态，不重建：重建会把用户正在挑的物品列表刷掉。
        // 按钮的点击处理内部会重新判断冷却是否已过（见 drawTradeModal），所以不需要重建来「解锁」。
        if (tradeLockOn()) updateTradeCountdown(cd);
        else tradeModalRedraw();
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
    // 渔场实况游鱼：每秒看有没有鱼游到画面边上（露不到 1/4 且正在淡出），
    // 有就换成同钓点掉落池里的另一条 —— 平均几秒换一条，画面保持实时变化且不会半路跳鱼
    setInterval(function () {
      if (currentView !== 'fishing') return;
      const scene = document.querySelector('.fish-live .px-scene');
      if (scene) rollSceneFish(scene);
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
    onFeatures: onFeatures, init: init, onFishingTick: onFishingTick, refreshAll: refreshAll,
    patchCodexCell: patchCodexCell,
    toast: toast, showRecordBanner: showRecordBanner, onBanners: onBanners, onBannerStop: onBannerStop,
    addLog: addLog, onSubAlert: onSubAlert, resetBanners: resetBanners,
    renderNav: renderNav, renderTopbar: renderTopbar, renderView: renderView, forceLogout: forceLogout,
    onConnChange: onConnChange,
    getView: function () { return currentView; },
    setView: function (v) { navigateView(v); },
  };
})();

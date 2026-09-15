/*
 * 钓鱼后台管理 - 页面逻辑（零依赖，与游戏前端共用后端 /api/admin/*）
 * 登录：游戏账号 + admin 标志（服务器无管理员时首个登录自动引导）。
 * 功能页：概览 / 账号授权 / 渔场钓点（掉落池权重实时百分比 + 增益）/ 市集退回 / 上钩公式 / 通知等级。
 */
window.Admin = (function () {
  'use strict';

  // ---- 状态 ----
  let token = null;
  let me = null;
  let view = 'overview';
  let worldCfg = null;          // /api/admin/world 结果（grounds + catalog + 设置）
  let usersList = null;         // /api/admin/users 结果
  let listings = [];            // 市集挂单
  let mkSearch = '';            // 市集管理搜索
  let mkKind = 'all';           // 市集管理类型筛选
  let mkAffix = 'all';          // 市集管理词条筛选
  let mkAffixMin = '', mkAffixMax = '';
  let mkSort = { key: 'time', dir: 'desc' };
  let timer = null;             // 概览自动刷新
  let bannerTimer = null;       // 横幅滚播面板自动刷新
  // 渔场编辑器状态
  let selGround = null, selSpot = null;
  let poolDraft = [], buffsDraft = [], poolDirty = false, buffsDirty = false;
  let posDraft = {};            // 钓点地图坐标草稿 { spotId: [x%, y%] }（拖动后未保存的值）

  // ---- API 基地址探测：同源（集成模式）→ :9000 → :8080（分离模式） ----
  let API_BASE = null;
  function candidates() {
    const list = [];
    if (location.protocol === 'http:' || location.protocol === 'https:') list.push('');
    const host = location.hostname || 'localhost';
    list.push(location.protocol + '//' + host + ':9000');
    if (location.port !== '8080') list.push(location.protocol + '//' + host + ':8080');
    return list;
  }
  function detectBase() {
    if (API_BASE != null) return Promise.resolve();
    const list = candidates();
    let i = 0;
    function tryNext() {
      if (i >= list.length) { API_BASE = ''; return Promise.resolve(); }
      const base = list[i++];
      return fetch(base + '/shop').then(function (r) { return r.ok ? r.json() : null; }).then(function (j) {
        if (j && j.crucian && j.crucian.base != null) { API_BASE = base; return; }
        return tryNext();
      }).catch(tryNext);
    }
    return tryNext();
  }
  // 请求超时：浏览器偶发请求悬挂（连接池/网络抖动）会让页面永远停在「加载中…」，
  // 超时后中断连接并按网络错误处理，GET 再自动重试一次，页面可自愈。
  const API_TIMEOUT_MS = 8000;
  function apiOnce(method, path, body) {
    const opts = { method: method, headers: { 'Content-Type': 'application/json' } };
    if (body) opts.body = JSON.stringify(body);
    let ctrl = null, timer = null;
    if (typeof AbortController !== 'undefined') {
      ctrl = new AbortController();
      opts.signal = ctrl.signal;
      timer = setTimeout(function () { try { ctrl.abort(); } catch (e) {} }, API_TIMEOUT_MS);
    }
    const done = function () { if (timer) { clearTimeout(timer); timer = null; } };
    return fetch(API_BASE + path, opts).then(function (r) {
      done();
      return r.json().catch(function () { return {}; }).then(function (j) { return { ok: r.ok, status: r.status, data: j }; });
    }).catch(function () {
      done();
      return { ok: false, status: 0, data: { error: '网络错误' }, timedOut: true };
    });
  }
  function api(method, path, body) {
    return detectBase().then(function () {
      return apiOnce(method, path, body).then(function (r) {
        // GET 悬挂/失败 → 重试一次（写操作不重试，避免重复提交）
        if (r.timedOut && method === 'GET') return apiOnce(method, path, body);
        return r;
      });
    });
  }
  // 所有管理 API 的统一出口：权限被收回（403）时回到登录页
  function adminApi(method, path, body) {
    return api(method, path, body).then(function (r) {
      if (r.status === 403) { logout('登录已失效或管理员权限被收回，请重新登录'); }
      return r;
    });
  }

  // ---- 小工具 ----
  function $(id) { return document.getElementById(id); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  let toastTimer = null;
  function toast(msg, err) {
    const t = $('toast');
    t.textContent = msg; t.classList.toggle('err', !!err); t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove('show'); }, 2600);
  }
  // 异步回调里写状态提示：请求往返期间页面可能已经切走或重绘，元素不在就静默跳过
  // （否则会抛 "Cannot set properties of null (setting 'innerHTML')"，测试里算页面错误）
  function setHint(id, html) {
    const el = $(id);
    if (el) el.innerHTML = html;
    return !!el;
  }
  function fmtTime(ts) { return ts ? new Date(ts).toLocaleString('zh-CN', { hour12: false }) : '—'; }
  function remainText(expireAt) {
    const ms = expireAt - Date.now();
    if (ms <= 0) return '已过期';
    const m = Math.floor(ms / 60000);
    if (m < 60) return m + ' 分钟';
    return Math.floor(m / 60) + ' 小时 ' + (m % 60) + ' 分';
  }
  const RARITY_TAG = { common: '', big: 'big', rare: 'rare', epic: 'epic' };
  const RARITY_NAME = { common: '普通', big: '大鱼', rare: '稀有', epic: '史诗' };

  // ================================
  // 登录 / 会话
  // ================================
  function showLogin(msg) {
    $('login').style.display = 'flex';
    $('login-msg').textContent = msg || '';
    $('who').textContent = '';
  }
  function logout(msg) {
    token = null; me = null; worldCfg = null; usersList = null;
    try { localStorage.removeItem('fishing_admin_token'); } catch (e) {}
    stopOverviewTimer();
    showLogin(msg);
  }
  function enter() {
    $('login').style.display = 'none';
    $('who').textContent = '👤 ' + me.name + '（' + me.username + '）';
    renderNav();
    switchView(view || 'overview');
  }
  function doLogin() {
    const user = $('login-user').value.trim();
    const pass = $('login-pass').value;
    if (!user || !pass) { $('login-msg').textContent = '请填写用户名和密码'; return; }
    const btn = $('login-btn');
    btn.disabled = true; btn.textContent = '登录中…';
    api('POST', '/api/admin/login', { username: user, password: pass }).then(function (r) {
      btn.disabled = false; btn.textContent = '登录管理后台';
      if (!r.ok) {
        $('login-msg').textContent = (r.data && r.data.error) || '登录失败';
        return;
      }
      token = r.data.token; me = { username: r.data.username, name: r.data.name };
      try { localStorage.setItem('fishing_admin_token', token); } catch (e) {}
      enter();
    });
  }

  // ================================
  // 导航 / 视图切换
  // ================================
  const NAV = [
    { id: 'overview', name: '📊 概览' },
    { id: 'accounts', name: '👥 账号授权' },
    { id: 'accountmgr', name: '🔑 账号管理' },
    { id: 'grounds', name: '🌊 渔场钓点' },
    { id: 'market', name: '💱 市集管理' },
    { id: 'component', name: '🧩 组件生成' },
    { id: 'fishsize', name: '🐟 鱼类体型' },
    { id: 'economy', name: '💰 经济参数' },
    { id: 'chest', name: '🎁 宝匣配置' },
    { id: 'workshop', name: '⚒ 工坊配置' },
    { id: 'mall', name: '🛒 商城配置' },
    { id: 'formula', name: '🧮 公式管理' },
    { id: 'notify', name: '🔔 通知等级' },
    { id: 'banner', name: '📢 横幅管理' },
    { id: 'feedback', name: '📮 反馈意见' },
    { id: 'records', name: '🏆 纪录贴图' },
    { id: 'update', name: '🔄 版本更新' },
  ];
  function renderNav() {
    const nav = $('nav');
    nav.innerHTML = '';
    NAV.forEach(function (n) {
      const b = document.createElement('button');
      b.className = 'nav-item' + (n.id === view ? ' active' : '');
      b.textContent = n.name;
      b.onclick = function () { switchView(n.id); };
      nav.appendChild(b);
    });
  }
  function switchView(v) {
    view = v;
    stopOverviewTimer();
    stopBannerTimer();
    stopUpdateTimer();
    renderNav();
    if (v === 'overview') return renderOverview();
    if (v === 'accounts') return renderAccounts();
    if (v === 'accountmgr') return renderAccountMgr();
    if (v === 'grounds') return renderGrounds();
    if (v === 'market') return renderMarket();
    if (v === 'component') return renderComponent();
    if (v === 'fishsize') return renderFishSize();
    if (v === 'economy') return renderEconomy();
    if (v === 'chest') return renderChest();
    if (v === 'workshop') return renderWorkshop();
    if (v === 'mall') return renderMall();
    if (v === 'records') return renderRecords();
    if (v === 'update') return renderUpdate();
    if (v === 'formula') return renderFormula();
    if (v === 'notify') return renderNotify();
    if (v === 'banner') return renderBanner();
    if (v === 'feedback') return renderFeedback();
  }

  // ================================
  // 反馈意见（只读列表）
  // ================================
  // 反馈页筛选状态（模块级：重绘间保留）
  let fbFilterKind = 'all';
  let fbFilterStatus = 'all';
  let fbFilterReward = false;
  // 奖励反馈玩家：输入金币（可附备注）→ 服务器给该玩家加币并通知
  function rewardFeedback(id, who) {
    promptModalLocal({ title: '🎁 奖励反馈玩家', label: '奖励金币', value: 1000, numeric: true, hint: '奖励对象：' + (who || id) + '（立即到账并通知）' })
      .then(function (val) {
        if (val == null) return null;
        const coins = Math.floor(Number(val) || 0);
        if (coins <= 0) { toast('奖励金币需大于 0', true); return null; }
        return promptModalLocal({ title: '备注（可选）', label: '备注', value: '', hint: '例如：优质 Bug 反馈，感谢' }).then(function (note) {
          if (note == null) return null;
          return adminApi('POST', '/api/admin/feedback/reward', { token: token, id: id, coins: coins, note: note }).then(function (r) {
            if (!r.ok) { toast(r.data.error || '奖励失败', true); return null; }
            toast('已奖励 ' + coins + ' 金币给 ' + (who || '该玩家'));
            renderFeedback();
            return r.data;
          });
        });
      });
  }
  function renderFeedback() {
    const main = $('main');
    main.innerHTML = '<h2>📮 玩家反馈</h2><div class="hint" style="margin-bottom:12px">玩家提交的 Bug / 建议 / 平衡反馈，按时间倒序。</div>' +
      '<div class="panel"><h3 style="margin-top:0">⚙ 反馈规则</h3>' +
      '<div class="mgr-row"><label>CD 时长</label><input id="fbc-cd" class="ipt mk-num" type="number" min="0" max="8760" step="0.5" />' +
      '<span class="hint">小时（0 = 不限制）</span>' +
      '<label class="hint" style="margin-left:12px">清空 CD 费用</label><input id="fbc-cost" class="ipt mk-num" type="number" min="0" step="1" />' +
      '<span class="hint">金币</span>' +
      '<button class="btn primary" id="fbc-save">保存</button><span id="fbc-state" class="hint"></span></div></div>' +
      '<div id="fb-body" class="panel">加载中…</div>';
    $('fbc-save').onclick = function () {
      const cdHours = Number($('fbc-cd').value);
      const skipCost = Number($('fbc-cost').value);
      if (!isFinite(cdHours) || cdHours < 0 || cdHours > 8760) { toast('CD 时长需在 0 - 8760 小时之间', true); return; }
      if (!isFinite(skipCost) || skipCost < 0) { toast('清空 CD 费用需为非负整数', true); return; }
      adminApi('POST', '/api/admin/feedback/cfg', { token: token, cdHours: cdHours, skipCost: skipCost }).then(function (r) {
        if (!r.ok) { $('fbc-state').innerHTML = '<span class="err">' + esc(r.data.error || '保存失败') + '</span>'; return; }
        $('fbc-cd').value = r.data.cfg.cdHours; $('fbc-cost').value = r.data.cfg.skipCost;
        $('fbc-state').innerHTML = '<span style="color:var(--ok)">已保存，立即生效</span>';
        toast('反馈规则已保存');
      });
    };
    adminApi('GET', '/api/admin/feedback?token=' + encodeURIComponent(token)).then(function (r) {
      if (view !== 'feedback') return;
      const box = $('fb-body');
      if (!r.ok) { box.textContent = (r.data && r.data.error) || '加载失败'; return; }
      // 回填反馈规则
      if (r.data.cfg) { $('fbc-cd').value = r.data.cfg.cdHours; $('fbc-cost').value = r.data.cfg.skipCost; }
      const all = r.data.feedback || [];
      const KIND = { bug: '🐛 Bug', idea: '💡 建议', balance: '⚖️ 平衡', other: '💬 其他' };
      const STATUSES = r.data.statuses || { submitted: '已提交', accepted: '已受理', done: '已完成' };
      // 分类筛选：反馈类型 + 处理状态（另附「仅未奖励」）
      const list = all.filter(function (f) {
        if (fbFilterKind !== 'all' && (f.kind || 'other') !== fbFilterKind) return false;
        if (fbFilterStatus !== 'all' && (f.status || 'submitted') !== fbFilterStatus) return false;
        if (fbFilterReward && !(f.reward && f.reward.coins)) return false;
        return true;
      });
      const kindOpts = [['all', '全部类型']].concat(Object.keys(KIND).map(function (k) { return [k, KIND[k]]; }))
        .map(function (kv) { return '<option value="' + kv[0] + '"' + (fbFilterKind === kv[0] ? ' selected' : '') + '>' + esc(kv[1]) + '</option>'; }).join('');
      const stOpts = [['all', '全部状态']].concat(Object.keys(STATUSES).map(function (k) { return [k, STATUSES[k]]; }))
        .map(function (kv) { return '<option value="' + kv[0] + '"' + (fbFilterStatus === kv[0] ? ' selected' : '') + '>' + esc(kv[1]) + '</option>'; }).join('');
      const barHtml = '<div class="fb-admin-filters" style="margin-bottom:10px">' +
        '<label class="hint">类型</label><select class="ipt" id="fba-kind" style="width:auto">' + kindOpts + '</select>' +
        '<label class="hint" style="margin-left:10px">状态</label><select class="ipt" id="fba-status" style="width:auto">' + stOpts + '</select>' +
        '<label class="hint" style="margin-left:10px"><input type="checkbox" id="fba-reward"' + (fbFilterReward ? ' checked' : '') + ' /> 仅未奖励</label>' +
        '<span class="hint" style="margin-left:10px">匹配 ' + list.length + ' / ' + all.length + ' 条</span></div>';
      if (!all.length) { box.innerHTML = '<div class="hint">暂无反馈。</div>'; return; }
      box.innerHTML = barHtml + (list.length ? list.map(function (f) {
        const dt = new Date(f.t);
        const ts = dt.getFullYear() + '-' + ('0' + (dt.getMonth() + 1)).slice(-2) + '-' + ('0' + dt.getDate()).slice(-2) + ' ' +
          ('0' + dt.getHours()).slice(-2) + ':' + ('0' + dt.getMinutes()).slice(-2);
        const cur = f.status || 'submitted';
        const opts = Object.keys(STATUSES).map(function (k) {
          return '<option value="' + k + '"' + (k === cur ? ' selected' : '') + '>' + esc(STATUSES[k]) + '</option>';
        }).join('');
        const rw = f.reward;
        return '<div class="fb-admin-item">' +
          '<div class="fb-admin-head"><span class="fb-tag">' + esc(KIND[f.kind] || f.kind || '其他') + '</span>' +
          '<span class="fb-admin-who">' + esc(f.name || f.key) + '</span>' +
          '<span class="fb-status ' + cur + '">' + esc(STATUSES[cur] || cur) + '</span>' +
          (rw && rw.coins ? '<span class="fb-reward">🎁 已奖励 +' + rw.coins + '💰' + (rw.note ? '（' + esc(rw.note) + '）' : '') + '</span>' : '') +
          '<span class="fb-admin-time">' + ts + (f.version ? ' · ' + esc(f.version) : '') + '</span></div>' +
          '<div class="fb-admin-text">' + esc(f.text) + '</div>' +
          '<div class="fb-admin-foot"><label class="hint">状态</label>' +
          '<select class="ipt fb-status-sel" data-id="' + esc(f.id) + '" style="width:auto">' + opts + '</select>' +
          '<button class="btn mini primary" data-reward="' + esc(f.id) + '" data-who="' + esc(f.name || f.key) + '">🎁 奖励金币</button>' +
          (f.statusBy ? '<span class="hint">由 ' + esc(f.statusBy) + ' 更新</span>' : '') + '</div></div>';
      }).join('') : '<div class="hint">没有符合筛选条件的反馈。</div>');
      $('fba-kind').onchange = function () { fbFilterKind = $('fba-kind').value; renderFeedback(); };
      $('fba-status').onchange = function () { fbFilterStatus = $('fba-status').value; renderFeedback(); };
      $('fba-reward').onchange = function () { fbFilterReward = $('fba-reward').checked; renderFeedback(); };
      box.querySelectorAll('[data-reward]').forEach(function (b) {
        b.onclick = function () { rewardFeedback(b.getAttribute('data-reward'), b.getAttribute('data-who')); };
      });
      box.querySelectorAll('.fb-status-sel').forEach(function (sel) {
        sel.onchange = function () {
          adminApi('POST', '/api/admin/feedback/status', { token: token, id: sel.getAttribute('data-id'), status: sel.value }).then(function (rr) {
            if (!rr.ok) { toast(rr.data.error || '更新失败', true); return; }
            toast('反馈状态已更新为：' + (STATUSES[sel.value] || sel.value));
            renderFeedback();
          });
        };
      });
    });
  }

  // ================================
  // 概览
  // ================================
  function stopOverviewTimer() { if (timer) { clearInterval(timer); timer = null; } }
  function stopBannerTimer() { if (bannerTimer) { clearInterval(bannerTimer); bannerTimer = null; } }
  function renderOverview() {
    const main = $('main');
    main.innerHTML = '<h2>📊 服务器概览</h2><div id="ov-body" class="hint">加载中…</div>';
    const load = function () {
      if (view !== 'overview') return;
      adminApi('GET', '/api/admin/overview?token=' + encodeURIComponent(token)).then(function (r) {
        if (!r.ok || view !== 'overview') return;
        const d = r.data;
        const lvName = (worldCfg && worldCfg.notifyLevels && worldCfg.notifyLevels[d.notifyLevel]) || d.notifyLevel;
        // 请求往返期间页面可能已被重绘（例如刚切到别的页签又切回来）——元素不在就跳过
        const ovBody = $('ov-body');
        if (!ovBody) return;
        ovBody.innerHTML =
          '<div class="stat-grid">' +
          '<div class="stat"><div class="v">' + d.online + '</div><div class="k">在线玩家</div></div>' +
          '<div class="stat"><div class="v">' + d.fishingCount + '</div><div class="k">正在钓鱼</div></div>' +
          '<div class="stat"><div class="v">' + d.userCount + '</div><div class="k">注册账号</div></div>' +
          '<div class="stat"><div class="v">' + d.listings + '</div><div class="k">市集挂单</div></div>' +
          '<div class="stat"><div class="v">' + d.activeTrades + '</div><div class="k">进行中交易</div></div>' +
          '<div class="stat"><div class="v">' + d.groundCount + ' / ' + d.spotCount + '</div><div class="k">钓场 / 钓点</div></div>' +
          '</div>' +
          '<div class="panel"><h3>当前生效配置</h3>' +
          '<div class="kv">通知等级：<code>' + esc(d.notifyLevel) + '</code> — ' + esc(lvName) + '<br>' +
          '上钩公式：<code>' + esc(d.biteFormula) + '</code></div>' +
          '<div class="hint" style="margin-top:8px">统计每 5 秒自动刷新；配置修改即时生效并广播给在线玩家。</div></div>';
      });
    };
    load();
    stopOverviewTimer();
    timer = setInterval(load, 5000);
  }

  // ================================
  // 账号授权
  // ================================
  function renderAccounts() {
    const main = $('main');
    main.innerHTML = '<h2>👥 账号与管理员授权</h2>' +
      '<div class="hint" style="margin-bottom:12px">开启「管理员」后，该账号即可打开管理后台（admin.html）。不能撤销自己的管理员权限。</div>' +
      '<div id="acc-body" class="panel">加载中…</div>';
    adminApi('GET', '/api/admin/users?token=' + encodeURIComponent(token)).then(function (r) {
      if (!r.ok || view !== 'accounts') return;
      usersList = r.data;
      const rows = usersList.users.map(function (u) {
        const self = u.key === usersList.me;
        return '<tr>' +
          '<td><b>' + esc(u.name) + '</b> <span class="hint">' + esc(u.username) + (self ? '（你）' : '') + '</span></td>' +
          '<td class="num">' + u.coins + '</td>' +
          '<td class="num">' + u.catchCount + '</td>' +
          '<td>' + (u.online ? '<span class="tag on">在线' + (u.fishing ? ' · 钓鱼中' : '') + '</span>' : '<span class="tag">离线</span>') + '</td>' +
          '<td>' + fmtTime(u.createdAt) + '</td>' +
          '<td><label class="switch"><input type="checkbox" data-key="' + esc(u.key) + '"' + (u.admin ? ' checked' : '') + (self ? ' disabled title="不能撤销自己的权限"' : '') + '><span class="sl"></span></label></td>' +
          '</tr>';
      }).join('');
      $('acc-body').innerHTML = '<table class="tbl"><thead><tr>' +
        '<th>账号</th><th class="num">金币</th><th class="num">捕获数</th><th>状态</th><th>注册时间</th><th>管理员</th>' +
        '</tr></thead><tbody>' + rows + '</tbody></table>';
      $('acc-body').querySelectorAll('input[type=checkbox]').forEach(function (cb) {
        cb.onchange = function () {
          const key = cb.getAttribute('data-key');
          const want = cb.checked;
          cb.disabled = true;
          adminApi('POST', '/api/admin/users/setadmin', { token: token, target: key, admin: want }).then(function (r) {
            cb.disabled = selfOf(key);
            if (!r.ok) { cb.checked = !want; toast(r.data.error || '操作失败', true); return; }
            toast(want ? '已授予管理员权限' : '已收回管理员权限');
            if (r.ok && want) loadWorldCfg(); // 目录可能变化，预取
          });
        };
        function selfOf(k) { return k === usersList.me; }
      });
    });
  }

  // ================================
  // 账号管理（列表形式：改密码 / 改显示名 / 调整金币 / 删除 / 快照编辑背包）
  // ================================
  // 账号管理：搜索与排序状态（模块级，切页/重绘间保留）
  let mgrQuery = '';
  let mgrSort = { key: 'createdAt', dir: 'desc' };
  let mgrRows = [];
  let mgrMeKey = '';
  function renderAccountMgr() {
    const main = $('main');
    main.innerHTML = '<h2>🔑 账号管理</h2>' +
      '<div class="hint" style="margin-bottom:12px">与「账号授权」同款列表；可改密码 / 显示名 / 金币，查看并编辑玩家快照（金币与背包），或删除账号（需二次确认）。修改密码会使其所有登录会话失效。点击表头可排序。</div>' +
      '<div class="mgr-row" style="margin-bottom:10px">' +
      '<label>🔍 搜索</label>' +
      '<span style="position:relative;display:inline-block;vertical-align:middle">' +
      '<input id="mgr-q" class="ipt" style="width:300px" placeholder="账号 ID / 显示名 / QQ 号" value="' + esc(mgrQuery) + '" autocomplete="off" />' +
      '<div id="mgr-sug" class="mgr-sug"></div></span>' +
      '<button class="btn mini" id="mgr-q-clear">清空</button>' +
      '<span class="hint">输入即过滤；点联想项直接定位到该账号</span></div>' +
      '<div id="mgr-list" class="panel">加载中…</div>';
    const q = $('mgr-q');
    q.oninput = function () { mgrQuery = q.value; drawMgrList(); drawMgrSug(); };
    q.onfocus = function () { drawMgrSug(); };
    // 延迟隐藏，让「点联想项」的 click 先于 blur 生效
    q.onblur = function () { setTimeout(function () { const b = $('mgr-sug'); if (b) b.style.display = 'none'; }, 180); };
    $('mgr-q-clear').onclick = function () { mgrQuery = ''; q.value = ''; drawMgrList(); drawMgrSug(); };
    loadMgrList();
  }
  function loadMgrList() {
    adminApi('GET', '/api/admin/users?token=' + encodeURIComponent(token)).then(function (r) {
      if (!r.ok || view !== 'accountmgr') return;
      mgrRows = r.data.users || [];
      mgrMeKey = r.data.me || '';
      drawMgrList();
      drawMgrSug();
    });
  }
  // 联想：按账号 ID / 显示名 / QQ 匹配，点击直接把该账号填入搜索框
  function drawMgrSug() {
    const box = $('mgr-sug');
    if (!box) return;
    const q = mgrQuery.trim().toLowerCase();
    if (!q) { box.style.display = 'none'; box.innerHTML = ''; return; }
    const hits = mgrRows.filter(function (u) {
      return (u.username || '').toLowerCase().indexOf(q) >= 0 || (u.name || '').toLowerCase().indexOf(q) >= 0 || String(u.qq || '').indexOf(q) >= 0;
    }).slice(0, 8);
    if (!hits.length) { box.style.display = 'none'; box.innerHTML = ''; return; }
    box.innerHTML = hits.map(function (u) {
      return '<div class="mgr-sug-item" data-k="' + esc(u.key) + '"><b>' + esc(u.name) + '</b> <span class="hint">' + esc(u.username) + '</span>' +
        (u.qq ? ' <span class="hint">QQ:' + esc(u.qq) + '</span>' : '') + '</div>';
    }).join('');
    box.style.display = 'block';
    box.querySelectorAll('.mgr-sug-item').forEach(function (d) {
      d.onclick = function () {
        mgrQuery = d.getAttribute('data-k');
        const inp = $('mgr-q'); if (inp) inp.value = mgrQuery;
        box.style.display = 'none'; drawMgrList();
      };
    });
  }
  // 列表渲染：过滤 + 排序（点表头切换）
  function drawMgrList() {
    if (view !== 'accountmgr') return;
    const q = mgrQuery.trim().toLowerCase();
    let rows = mgrRows.filter(function (u) {
      if (!q) return true;
      return (u.username || '').toLowerCase().indexOf(q) >= 0 || (u.name || '').toLowerCase().indexOf(q) >= 0 || String(u.qq || '').indexOf(q) >= 0;
    });
    const cmp = {
      name: function (a, b) { return String(a.name || '').localeCompare(String(b.name || ''), 'zh'); },
      key: function (a, b) { return String(a.key || '').localeCompare(String(b.key || '')); },
      coins: function (a, b) { return (a.coins || 0) - (b.coins || 0); },
      catchCount: function (a, b) { return (a.catchCount || 0) - (b.catchCount || 0); },
      online: function (a, b) { return (a.online ? 1 : 0) - (b.online ? 1 : 0); },
      createdAt: function (a, b) { return (a.createdAt || 0) - (b.createdAt || 0); },
    };
    const fn = cmp[mgrSort.key] || cmp.createdAt;
    rows = rows.slice().sort(fn);
    if (mgrSort.dir < 0) rows.reverse();
    const meKey = mgrMeKey;
    const arrow = function (k) { return mgrSort.key === k ? (mgrSort.dir < 0 ? ' ▼' : ' ▲') : ''; };
    const body = rows.map(function (u) {
      const self = u.key === meKey;
      return '<tr>' +
        '<td><b>' + esc(u.name) + '</b> <span class="hint">' + esc(u.username) + (self ? '（你）' : '') + '</span>' +
        (u.qq ? '<div class="hint">QQ：' + esc(u.qq) + '</div>' : '') + '</td>' +
        '<td class="num">' + u.coins + '</td>' +
        '<td class="num">' + u.catchCount + '</td>' +
        '<td>' + (u.online ? '<span class="tag on">在线</span>' : '<span class="tag">离线</span>') + '</td>' +
        '<td>' + fmtTime(u.createdAt) + '</td>' +
        '<td class="mgr-acts">' +
        '<button class="btn mini" data-edit="' + esc(u.key) + '">编辑</button>' +
        '<button class="btn mini" data-snap="' + esc(u.key) + '">快照</button>' +
        '<button class="btn mini danger" data-del="' + esc(u.key) + '"' + (self ? ' disabled title="不能删除自己"' : '') + '>删除</button>' +
        '</td></tr>';
    }).join('');
    $('mgr-list').innerHTML =
      '<div class="hint" style="margin-bottom:8px">共 ' + mgrRows.length + ' 个账号' + (q ? '，匹配 ' + rows.length + ' 个' : '') +
      '；当前排序：' + ({ name: '显示名', coins: '金币', catchCount: '捕获数', online: '状态', createdAt: '注册时间' }[mgrSort.key] || mgrSort.key) + (mgrSort.dir < 0 ? ' ↓' : ' ↑') + '</div>' +
      '<table class="tbl"><thead><tr>' +
      '<th class="sortable" data-sort="name">账号' + arrow('name') + '</th>' +
      '<th class="num sortable" data-sort="coins">金币' + arrow('coins') + '</th>' +
      '<th class="num sortable" data-sort="catchCount">捕获数' + arrow('catchCount') + '</th>' +
      '<th class="sortable" data-sort="online">状态' + arrow('online') + '</th>' +
      '<th class="sortable" data-sort="createdAt">注册时间' + arrow('createdAt') + '</th>' +
      '<th>操作</th>' +
      '</tr></thead><tbody>' + body + '</tbody></table>';
    $('mgr-list').querySelectorAll('th.sortable').forEach(function (th) {
      th.style.cursor = 'pointer';
      th.onclick = function () {
        const k = th.getAttribute('data-sort');
        if (mgrSort.key === k) mgrSort.dir = -mgrSort.dir;
        else mgrSort = { key: k, dir: (k === 'name' ? 1 : -1) };
        drawMgrList();
      };
    });
    $('mgr-list').querySelectorAll('[data-edit]').forEach(function (b) { b.onclick = function () { openMgrEdit(b.getAttribute('data-edit')); }; });
    $('mgr-list').querySelectorAll('[data-snap]').forEach(function (b) { b.onclick = function () { openMgrSnapshot(b.getAttribute('data-snap')); }; });
    $('mgr-list').querySelectorAll('[data-del]').forEach(function (b) { b.onclick = function () { confirmDeleteUser(b.getAttribute('data-del')); }; });
  }
  // 编辑密码 / 显示名 / 金币
  function openMgrEdit(key) {
    document.querySelectorAll('.modal-overlay').forEach(function (m) { m.remove(); });
    const ov = document.createElement('div');
    ov.className = 'modal-overlay';
    ov.innerHTML = '<div class="modal-box confirm-modal"><div class="modal-head"><span class="modal-title">编辑账号 ' + esc(key) + '</span></div>' +
      '<div class="modal-body mgr-form">' +
      '<div class="mgr-row"><label>新密码</label><input id="mgr-pass" class="ipt" type="text" placeholder="留空则不修改（至少 4 位）" /></div>' +
      '<div class="mgr-row"><label>显示名</label><input id="mgr-name" class="ipt" placeholder="留空则不修改" /></div>' +
      '<div class="mgr-row"><label>金币</label><input id="mgr-coins" class="ipt" type="number" min="0" placeholder="留空则不修改" /></div>' +
      '<div class="cf-actions"><button class="btn mini cf-no">取消</button><button class="btn primary" id="mgr-save">保存修改</button></div>' +
      '<span id="mgr-msg" class="hint"></span>' +
      '</div></div>';
    document.body.appendChild(ov);
    ov.addEventListener('click', function (e) { if (e.target === ov) ov.remove(); });
    ov.querySelector('.cf-no').onclick = function () { ov.remove(); };
    ov.querySelector('#mgr-save').onclick = function () {
      const payload = { token: token, target: key };
      const pw = ov.querySelector('#mgr-pass').value;
      const nm = ov.querySelector('#mgr-name').value.trim();
      const co = ov.querySelector('#mgr-coins').value;
      if (pw) payload.password = pw;
      if (nm) payload.name = nm;
      if (co !== '') payload.coins = Number(co);
      if (!pw && !nm && co === '') { toast('没有需要修改的字段', true); return; }
      adminApi('POST', '/api/admin/users/update', payload).then(function (r) {
        if (!r.ok) { toast(r.data.error || '修改失败', true); return; }
        toast('已修改：' + (r.data.changed || []).join(' / '));
        ov.remove(); loadMgrList();
      });
    };
  }
  // 快照：查看金币与背包，可编辑
  function openMgrSnapshot(key) {
    adminApi('GET', '/api/admin/users/snapshot?token=' + encodeURIComponent(token) + '&key=' + encodeURIComponent(key)).then(function (r) {
      if (!r.ok) { toast(r.data.error || '读取快照失败', true); return; }
      const d = r.data;
      // 物品目录（鱼/材料/组件底材）来自前端共享数据，新增物品改为按名称选择
      const hasData = (typeof GameData !== 'undefined' && !!GameData.allItems);
      const byKind = { fish: [], material: [], component: [] };
      (hasData ? GameData.allItems() : []).forEach(function (it) { (byKind[it.kind] || (byKind[it.kind] = [])).push(it); });
      const opt = function (it) { return '<option value="' + esc(it.id) + '">' + esc(it.name) + '（' + esc(it.id) + '）</option>'; };
      const grp = function (label, arr) { return arr.length ? '<optgroup label="' + label + '">' + arr.map(opt).join('') + '</optgroup>' : ''; };
      const itemOptions = hasData
        ? (grp('鱼', byKind.fish) + grp('材料', byKind.material) + grp('组件（底材）', byKind.component))
        : '<option value="">（数据目录未加载，请手动输入 ID）</option>';
      document.querySelectorAll('.modal-overlay').forEach(function (m) { m.remove(); });
      const ov = document.createElement('div');
      ov.className = 'modal-overlay';
      ov.innerHTML = '<div class="modal-box confirm-modal snap-modal"><div class="modal-head"><span class="modal-title">资产快照 · ' + esc(d.name) + '（' + esc(key) + '）</span></div>' +
        '<div class="modal-body">' +
        '<div class="mgr-row"><label>金币</label><input id="snap-coins" class="ipt" type="number" min="0" value="' + d.coins + '" /></div>' +
        '<div class="hint" style="margin:10px 0 6px">背包（直接编辑每行的数量，0 或留空 = 移除）</div>' +
        '<div id="snap-inv" class="snap-inv"></div>' +
        '<div class="mgr-row" style="margin-top:10px"><label>新增物品</label>' +
        '<select id="snap-add-id" class="ipt" style="min-width:240px">' + itemOptions + '</select>' +
        '<input id="snap-add-qty" class="ipt mk-num" type="number" min="1" value="1" />' +
        '<button class="btn mini" id="snap-add">添加</button></div>' +
        '<div class="hint" style="margin:14px 0 6px">🔧 定制配件（自选底材 / 品质 / 词条数值，生成后直接放进背包）</div>' +
        '<div class="mgr-row"><label>底材</label><select id="cus-base" class="ipt" style="min-width:240px"></select>' +
        '<label>品质</label><select id="cus-quality" class="ipt"></select></div>' +
        '<div id="cus-affixes" style="margin:6px 0"></div>' +
        '<div class="mgr-row"><button class="btn mini" id="cus-aff-add">＋ 添加词条</button>' +
        '<span class="hint">词条类型只能选该底材支持的；数值可超出自然区间（管理员定制）</span></div>' +
        '<div class="hint" id="cus-preview" style="margin-top:6px"></div>' +
        '<div class="mgr-row" style="margin-top:6px"><label>数量</label>' +
        '<input id="cus-qty" class="ipt mk-num" type="number" min="1" value="1" />' +
        '<button class="btn mini primary" id="cus-add">添加到背包</button></div>' +
        '<div class="cf-actions"><button class="btn mini cf-no">取消</button><button class="btn primary" id="snap-save">保存快照</button></div>' +
        '</div></div>';
      document.body.appendChild(ov);
      ov.addEventListener('click', function (e) { if (e.target === ov) ov.remove(); });
      ov.querySelector('.cf-no').onclick = function () { ov.remove(); };
      const invBox = ov.querySelector('#snap-inv');
      function drawInv(inv) {
        const keys = Object.keys(inv);
        if (!keys.length) { invBox.innerHTML = '<div class="hint">背包为空</div>'; return; }
        invBox.innerHTML = keys.map(function (id) {
          const meta = (typeof GameData !== 'undefined' && GameData.itemOf) ? GameData.itemOf(id) : null;
          const nm = meta ? meta.name : id;
          return '<div class="mgr-row snap-line"><label title="' + esc(id) + '">' + esc(nm) + '<div class="hint">' + esc(id) + '</div></label>' +
            '<input class="ipt mk-num" type="number" min="0" data-inv="' + esc(id) + '" value="' + inv[id] + '" /></div>';
        }).join('');
      }
      drawInv(d.inventory || {});
      // 统一的「往背包草稿加一件」：已有同 id 就叠加数量，否则追加一行
      function invAddDraft(id, qty) {
        if (!id) return false;
        const inputs = ov.querySelectorAll('[data-inv]');
        for (const inp of inputs) { if (inp.getAttribute('data-inv') === id) { inp.value = (Number(inp.value) || 0) + qty; return true; } }
        const cur = {};
        inputs.forEach(function (inp) { cur[inp.getAttribute('data-inv')] = Number(inp.value) || 0; });
        cur[id] = qty;
        drawInv(cur);
        return true;
      }
      function itemNameOf(id) {
        const meta = (window.GameData && GameData.itemOf) ? GameData.itemOf(id) : null;
        return meta ? meta.name : id;
      }
      ov.querySelector('#snap-add').onclick = function () {
        const sel = ov.querySelector('#snap-add-id');
        const id = sel.value;
        const qty = Math.max(1, Number(ov.querySelector('#snap-add-qty').value) || 1);
        if (!id) return;
        invAddDraft(id, qty);
        toast('已加入草稿：' + itemNameOf(id) + ' × ' + qty);
      };
      // —— 定制配件：底材 × 品质 × 词条 → 组件实例。id 用 GameData.instanceId 生成（与游戏同一套编码），
      // 服务端按实例规则校验后入包；词条类型只能选底材支持的，数值不设限（管理员定制）。——
      const bases = (window.GameData && GameData.COMPONENT_BASES) || [];
      const affLabel = (window.GameData && GameData.AFFIX_LABEL) || {};
      const qDef = (window.GameData && GameData.QUALITY) || {};
      const partName = {};
      ((window.GameData && GameData.ROD_PARTS) || []).forEach(function (p) { partName[p.key] = p.name; });
      const bSel = ov.querySelector('#cus-base');
      bSel.innerHTML = bases.map(function (b) {
        return '<option value="' + esc(b.id) + '">' + esc(partName[b.part] || b.part) + ' · ' + esc(b.name) + '（' + esc(b.id) + '）</option>';
      }).join('');
      ov.querySelector('#cus-quality').innerHTML = Object.keys(qDef).map(function (k) {
        return '<option value="' + k + '">' + esc(qDef[k].name) + '</option>';
      }).join('');
      let cusList = [];
      function cusBase() { return bases.find(function (b) { return b.id === bSel.value; }) || null; }
      function drawCus() {
        const b = cusBase();
        const box = ov.querySelector('#cus-affixes');
        if (!b) return;
        const pool = b.pool || [];
        cusList = cusList.filter(function (a) { return pool.some(function (p) { return p.type === a.type; }); }); // 换底材后清掉不支持的
        box.innerHTML = cusList.length ? cusList.map(function (a, i) {
          const pr = pool.find(function (p) { return p.type === a.type; });
          return '<div class="cus-aff">' +
            '<select class="ipt" data-cus-t="' + i + '">' + pool.map(function (p) {
              return '<option value="' + esc(p.type) + '"' + (p.type === a.type ? ' selected' : '') + '>' + esc(affLabel[p.type] || p.type) + '</option>';
            }).join('') + '</select>' +
            '<input class="ipt mk-num" type="number" data-cus-v="' + i + '" value="' + a.value + '" />' +
            '<span class="hint">自然 ' + (pr ? pr.min : '?') + '~' + (pr ? pr.max : '?') + '</span>' +
            '<button class="btn mini danger" data-cus-del="' + i + '" title="移除词条">✕</button></div>';
        }).join('') : '<div class="hint">暂无词条（0 条 = 无词条配件）</div>';
        box.querySelectorAll('[data-cus-t]').forEach(function (sel) {
          sel.onchange = function () { cusList[+sel.getAttribute('data-cus-t')].type = sel.value; drawCus(); };
        });
        box.querySelectorAll('[data-cus-v]').forEach(function (inp) {
          inp.oninput = function () { cusList[+inp.getAttribute('data-cus-v')].value = Math.round(Number(inp.value) || 0); updateCusPreview(); };
        });
        box.querySelectorAll('[data-cus-del]').forEach(function (btn) {
          btn.onclick = function () { cusList.splice(+btn.getAttribute('data-cus-del'), 1); drawCus(); };
        });
        updateCusPreview();
      }
      function cusId() {
        const b = cusBase();
        if (!b || !window.GameData || !GameData.instanceId) return '';
        try { return GameData.instanceId(b.id, ov.querySelector('#cus-quality').value, cusList.slice()); } catch (e) { return ''; }
      }
      function updateCusPreview() {
        const el = ov.querySelector('#cus-preview');
        const id = cusId();
        const meta = (window.GameData && GameData.instanceMeta) ? GameData.instanceMeta(id) : null;
        if (!meta) { el.innerHTML = '<span class="err">无法生成该配件（词条类型与底材不匹配）</span>'; return; }
        const aff = meta.affixes.length
          ? meta.affixes.map(function (a) { return esc((affLabel[a.type] || a.type) + (a.value > 0 ? '+' : '') + a.value); }).join(' / ')
          : '无词条';
        const b = cusBase();
        const cap = qDef[ov.querySelector('#cus-quality').value] ? qDef[ov.querySelector('#cus-quality').value].cap : '?';
        el.innerHTML = '预览：<b>' + esc(meta.name) + '</b> · ' + esc(meta.qualityName) + ' · ' + aff +
          ' <span class="hint">（' + esc(id) + '；该品质常规最多 ' + cap + ' 条，当前 ' + meta.affixes.length + ' 条）</span>';
      }
      bSel.onchange = function () { cusList = []; drawCus(); };
      ov.querySelector('#cus-quality').onchange = function () { updateCusPreview(); };
      ov.querySelector('#cus-aff-add').onclick = function () {
        const b = cusBase(); if (!b) return;
        const used = cusList.map(function (a) { return a.type; });
        const next = (b.pool || []).find(function (p) { return used.indexOf(p.type) < 0; });
        if (!next) { toast('该底材支持的词条类型都已添加', true); return; }
        cusList.push({ type: next.type, value: next.min });
        drawCus();
      };
      ov.querySelector('#cus-add').onclick = function () {
        const id = cusId();
        const meta = (window.GameData && GameData.instanceMeta) ? GameData.instanceMeta(id) : null;
        if (!meta) { toast('无法生成该配件：词条类型与底材不匹配', true); return; }
        const qty = Math.max(1, Number(ov.querySelector('#cus-qty').value) || 1);
        invAddDraft(id, qty);
        toast('已加入草稿：' + meta.name + ' × ' + qty);
      };
      drawCus();

      ov.querySelector('#snap-save').onclick = function () {
        const inv = {};
        ov.querySelectorAll('[data-inv]').forEach(function (inp) {
          const q = Math.floor(Number(inp.value) || 0);
          if (q > 0) inv[inp.getAttribute('data-inv')] = q;
        });
        adminApi('POST', '/api/admin/users/snapshot', { token: token, target: key, coins: Number(ov.querySelector('#snap-coins').value) || 0, inventory: inv }).then(function (rr) {
          if (!rr.ok) { toast(rr.data.error || '保存失败', true); return; }
          toast('快照已保存'); ov.remove(); loadMgrList();
        });
      };
    });
  }
  // 删除账号（二次确认）
  function confirmDeleteUser(key) {
    document.querySelectorAll('.modal-overlay').forEach(function (m) { m.remove(); });
    const ov = document.createElement('div');
    ov.className = 'modal-overlay';
    ov.innerHTML = '<div class="modal-box confirm-modal"><div class="modal-head"><span class="modal-title">删除账号</span></div>' +
      '<div class="modal-body"><div class="cf-text">确定删除账号 <b>' + esc(key) + '</b>？<br>此操作不可恢复：账号、背包、图鉴将被移除，该账号挂单也会一并清空。</div>' +
      '<div class="cf-actions"><button class="btn mini cf-no">取消</button><button class="btn danger" id="del-ok">确认删除</button></div></div></div>';
    document.body.appendChild(ov);
    ov.addEventListener('click', function (e) { if (e.target === ov) ov.remove(); });
    ov.querySelector('.cf-no').onclick = function () { ov.remove(); };
    ov.querySelector('#del-ok').onclick = function () {
      const btn = ov.querySelector('#del-ok'); btn.disabled = true; btn.textContent = '删除中…';
      adminApi('POST', '/api/admin/users/delete', { token: token, target: key, confirm: true }).then(function (r) {
        if (!r.ok) { toast(r.data.error || '删除失败', true); ov.remove(); return; }
        toast('已删除账号 ' + key); ov.remove(); loadMgrList();
      });
    };
  }

  // ================================
  // 渔场钓点编辑器
  // ================================
  function loadWorldCfg(force) {
    if (worldCfg && !force) return Promise.resolve(worldCfg);
    return adminApi('GET', '/api/admin/world?token=' + encodeURIComponent(token)).then(function (r) {
      if (r.ok) worldCfg = r.data;
      return worldCfg;
    });
  }
  function renderGrounds() {
    const main = $('main');
    main.innerHTML = '<h2>🌊 渔场与钓点管理</h2>' +
      '<div class="hint" style="margin-bottom:12px">选择钓场与钓点后编辑掉落池（权重实时换算百分比）与增益。保存后全服即时生效，正在钓鱼的玩家下一竿即按新配置掷骰。</div>' +
      '<div id="gd-body">加载中…</div>';
    loadWorldCfg(true).then(function (cfg) {
      if (!cfg || view !== 'grounds') return;
      if (!selGround || !cfg.grounds.some(function (g) { return g.id === selGround; })) {
        selGround = cfg.grounds.length ? cfg.grounds[0].id : null;
        selSpot = null;
      }
      drawGrounds(cfg);
    });
  }
  function drawGrounds(cfg) {
    const g = cfg.grounds.find(function (x) { return x.id === selGround; });
    if (!g) return;
    if (!selSpot || !g.spots.some(function (s) { return s.id === selSpot; })) selSpot = g.spots.length ? g.spots[0].id : null;
    const body = $('gd-body');
    // 拉数据期间页面可能已被切走或重绘（例如快速来回切页签）：容器不在就什么都不做
    if (!body) return;
    const presets = cfg.poolPresets || {};
    const presetOpts = Object.keys(presets).map(function (k) {
      return '<option value="' + k + '">' + esc(presets[k].name) + '</option>';
    }).join('');
    const removedG = cfg.removedGrounds || [];
    const removedS = cfg.removedSpots || [];
    body.innerHTML =
      // —— 新建渔场（支持一键填充 + 限时窗口）——
      '<div class="panel gd-new">' +
      '<h3 style="margin-top:0">➕ 新建渔场</h3>' +
      '<div class="mgr-row"><label>ID</label><input id="ng-id" class="ipt gi-id" placeholder="如 coral_bay（小写字母/数字/下划线）" />' +
      '<label class="hint">名称</label><input id="ng-name" class="ipt gi-name" placeholder="如 珊瑚湾" maxlength="20" />' +
      '<label class="hint">类型</label><select id="ng-type" class="ipt gi-type"><option value="normal">普通钓场</option><option value="event">活动钓场</option></select>' +
      '<label class="hint">首个钓点</label><input id="ng-spot" class="ipt gi-name" value="主钓点" maxlength="20" /></div>' +
      '<div class="mgr-row"><label>简介</label><input id="ng-desc" class="ipt gi-desc" placeholder="一句话描述（可选）" maxlength="80" />' +
      '<label class="hint">一键填充</label><select id="ng-preset" class="ipt gi-type">' + presetOpts + '</select>' +
      '<label class="hint" title="创建首个钓点时就按预设填好掉落池，之后仍可在下方逐条调整">填充掉落池</label>' +
      '<input type="checkbox" id="ng-fill" checked /></div>' +
      '<div class="mgr-row"><label>限时开放</label><input id="ng-from" class="ipt gi-time" type="datetime-local" />' +
      '<span class="hint">~</span><input id="ng-to" class="ipt gi-time" type="datetime-local" />' +
      '<span class="hint">留空 = 常驻开放；到点自动开/关并广播</span>' +
      '<button class="btn primary" id="ng-create">创建渔场</button><span id="ng-state" class="hint"></span></div>' +
      ((removedG.length || removedS.length)
        ? '<div class="gd-removed"><b>已删除（可恢复）</b>：' +
          removedG.map(function (id) {
            const base = GROUND_NAME_HINT(cfg, id);
            return '<span class="gd-chip">🌊 ' + esc(base) + ' <button class="btn mini" data-rstg="' + esc(id) + '">恢复</button></span>';
          }).join('') +
          removedS.map(function (key) {
            const parts = key.split(':');
            return '<span class="gd-chip">🎣 ' + esc(GROUND_NAME_HINT(cfg, parts[0])) + ' · ' + esc(parts[1]) + ' <button class="btn mini" data-rsts="' + esc(key) + '">恢复</button></span>';
          }).join('') + '</div>'
        : '') +
      '</div>' +
      // —— 渔场卡片 ——
      '<div class="ground-tabs">' + cfg.grounds.map(function (gr) {
        const limited = !!(gr.openFrom || gr.openTo);
        const badge = (gr.custom ? '<span class="gd-badge custom">自定义</span>' : '') +
          (limited ? '<span class="gd-badge limited" title="限时渔场">⏰ 限时</span>' : '');
        return '<div class="gcard' + (gr.id === selGround ? ' sel' : '') + (gr.locked ? ' locked' : '') + '" data-g="' + esc(gr.id) + '">' +
          '<b>' + esc(gr.name) + (gr.locked ? ' 🔒' : '') + badge + '</b>' +
          '<span class="gi">' + esc(gr.desc) + '</span>' +
          '<div style="margin-top:6px"><button class="btn mini" data-lock="' + esc(gr.id) + '">' + (gr.locked ? '解锁钓场' : '锁定钓场') + '</button>' +
          '<button class="btn mini danger" data-rmg="' + esc(gr.id) + '">删除</button></div>' +
          '</div>';
      }).join('') + '</div>' +
      '<div class="panel">' +
      // —— 选中渔场的信息编辑 + 钓点管理 ——
      '<div class="mgr-row gd-info"><label>名称</label><input id="gi-name" class="ipt gi-name" value="' + esc(g.name) + '" maxlength="20" />' +
      '<label class="hint">类型</label><select id="gi-type" class="ipt gi-type"><option value="normal"' + (g.type !== 'event' ? ' selected' : '') + '>普通钓场</option><option value="event"' + (g.type === 'event' ? ' selected' : '') + '>活动钓场</option></select>' +
      '<label class="hint">简介</label><input id="gi-desc" class="ipt gi-desc" value="' + esc(g.desc || '') + '" maxlength="80" />' +
      '<button class="btn primary" id="gi-save">保存信息</button><span id="gi-state" class="hint"></span></div>' +
      '<div class="mgr-row gd-info"><label>限时开放</label><input id="gi-from" class="ipt gi-time" type="datetime-local" value="' + esc(toLocalInput(g.openFrom)) + '" />' +
      '<span class="hint">~</span><input id="gi-to" class="ipt gi-time" type="datetime-local" value="' + esc(toLocalInput(g.openTo)) + '" />' +
      '<button class="btn" id="gi-window">保存限时</button><button class="btn mini" id="gi-clearwin">清除限时</button>' +
      '<span class="hint">窗口外自动锁定（含手动锁定叠加）</span></div>' +
      '<div class="spot-tabs">' + g.spots.map(function (s) {
        return '<button class="spot-tab' + (s.id === selSpot ? ' on' : '') + '" data-s="' + esc(s.id) + '">' + esc(s.name) + '</button>';
      }).join('') +
      '<span class="gd-spot-acts"><input id="ns-name" class="ipt gi-name" placeholder="新钓点名称" maxlength="20" />' +
      '<select id="ns-preset" class="ipt gi-type">' + presetOpts + '</select>' +
      '<button class="btn mini" id="ns-add">＋ 新建钓点（一键填充）</button>' +
      (sp0Exists(g) ? '<button class="btn mini danger" id="ns-del">🗑 删除当前钓点</button>' : '') +
      '</span></div>' +
      '<div id="gd-map"></div>' +
      '<div id="ed-body"></div>' +
      '</div>';
    void presets;

    body.querySelectorAll('.gcard').forEach(function (c) {
      c.onclick = function (ev) {
        if (ev.target && ev.target.getAttribute && (ev.target.getAttribute('data-lock') || ev.target.getAttribute('data-rmg'))) return;
        selGround = c.getAttribute('data-g'); selSpot = null;
        poolDirty = buffsDirty = false; posDraft = {};
        drawGrounds(cfg);
      };
    });
    body.querySelectorAll('[data-lock]').forEach(function (b) {
      b.onclick = function () {
        const gid = b.getAttribute('data-lock');
        const gr = cfg.grounds.find(function (x) { return x.id === gid; });
        adminApi('POST', '/api/admin/ground/lock', { token: token, groundId: gid, locked: !gr.locked }).then(function (r) {
          if (!r.ok) { toast(r.data.error || '操作失败', true); return; }
          toast(gr.locked ? '钓场已解锁' : '钓场已锁定（该场钓鱼已停止）');
          loadWorldCfg(true).then(function (c2) { if (view === 'grounds' && c2) drawGrounds(c2); });
        });
      };
    });
    // 删除渔场（内置渔场可恢复；自定义直接移除）
    body.querySelectorAll('[data-rmg]').forEach(function (b) {
      b.onclick = function () {
        const gid = b.getAttribute('data-rmg');
        const gr = cfg.grounds.find(function (x) { return x.id === gid; });
        confirmModalLocal('删除渔场「' + (gr ? gr.name : gid) + '」？该场正在钓鱼的玩家会被停止' + (gr && gr.custom ? '（自定义渔场删除后不可恢复）' : '（内置渔场可在上方「已删除」中恢复）')).then(function (ok) {
          if (!ok) return;
          adminApi('POST', '/api/admin/ground/remove', { token: token, groundId: gid }).then(function (r) {
            if (!r.ok) { toast(r.data.error || '删除失败', true); return; }
            toast('渔场已删除' + (r.data.restorable ? '（可恢复）' : ''));
            if (selGround === gid) selGround = null;
            loadWorldCfg(true).then(function (c2) { if (view === 'grounds' && c2) drawGrounds(c2); });
          });
        });
      };
    });
    body.querySelectorAll('[data-rstg]').forEach(function (b) {
      b.onclick = function () {
        adminApi('POST', '/api/admin/ground/restore', { token: token, groundId: b.getAttribute('data-rstg') }).then(function (r) {
          if (!r.ok) { toast(r.data.error || '恢复失败', true); return; }
          toast('渔场已恢复');
          loadWorldCfg(true).then(function (c2) { if (view === 'grounds' && c2) drawGrounds(c2); });
        });
      };
    });
    body.querySelectorAll('[data-rsts]').forEach(function (b) {
      b.onclick = function () {
        const key = b.getAttribute('data-rsts');
        const parts = key.split(':');
        adminApi('POST', '/api/admin/ground/restore', { token: token, groundId: parts[0], spotId: parts[1] }).then(function (r) {
          if (!r.ok) { toast(r.data.error || '恢复失败', true); return; }
          toast('钓点已恢复');
          loadWorldCfg(true).then(function (c2) { if (view === 'grounds' && c2) drawGrounds(c2); });
        });
      };
    });
    body.querySelectorAll('.spot-tab').forEach(function (t) {
      t.onclick = function () {
        selSpot = t.getAttribute('data-s');
        poolDirty = buffsDirty = false; posDraft = {};
        drawGrounds(cfg);
      };
    });
    // 新建渔场
    $('ng-create').onclick = function () {
      const bodyNow = {
        token: token,
        id: $('ng-id').value.trim(),
        name: $('ng-name').value.trim(),
        type: $('ng-type').value,
        desc: $('ng-desc').value.trim(),
        spotId: 'main',
        spotName: $('ng-spot').value.trim() || '主钓点',
        preset: $('ng-preset').value,
        fill: $('ng-fill').checked,
        openFrom: $('ng-from').value || null,
        openTo: $('ng-to').value || null,
      };
      if (!bodyNow.id) { $('ng-state').innerHTML = '<span class="err">请填写渔场 ID</span>'; return; }
      if (!bodyNow.name) { $('ng-state').innerHTML = '<span class="err">请填写渔场名称</span>'; return; }
      adminApi('POST', '/api/admin/ground/add', bodyNow).then(function (r) {
        if (!r.ok) { $('ng-state').innerHTML = '<span class="err">' + esc(r.data.error || '创建失败') + '</span>'; return; }
        toast('渔场已创建' + (bodyNow.fill ? '（已按预设填充掉落池）' : ''));
        selGround = bodyNow.id; selSpot = 'main';
        poolDirty = buffsDirty = false;
        loadWorldCfg(true).then(function (c2) { if (view === 'grounds' && c2) drawGrounds(c2); });
      });
    };
    // 选中渔场的信息/限时窗口
    $('gi-save').onclick = function () {
      adminApi('POST', '/api/admin/ground/update', {
        token: token, groundId: selGround,
        name: $('gi-name').value.trim(), type: $('gi-type').value, desc: $('gi-desc').value.trim(),
      }).then(function (r) {
        if (!r.ok) { $('gi-state').innerHTML = '<span class="err">' + esc(r.data.error || '保存失败') + '</span>'; return; }
        $('gi-state').innerHTML = '<span style="color:var(--ok)">已保存</span>';
        toast('渔场信息已更新');
        loadWorldCfg(true).then(function (c2) { if (view === 'grounds' && c2) drawGrounds(c2); });
      });
    };
    $('gi-window').onclick = function () {
      adminApi('POST', '/api/admin/ground/update', {
        token: token, groundId: selGround,
        openFrom: $('gi-from').value || null, openTo: $('gi-to').value || null,
      }).then(function (r) {
        if (!r.ok) { $('gi-state').innerHTML = '<span class="err">' + esc(r.data.error || '保存失败') + '</span>'; return; }
        toast('限时窗口已保存，到点自动开/关');
        loadWorldCfg(true).then(function (c2) { if (view === 'grounds' && c2) drawGrounds(c2); });
      });
    };
    $('gi-clearwin').onclick = function () {
      adminApi('POST', '/api/admin/ground/update', { token: token, groundId: selGround, clearWindow: true }).then(function (r) {
        if (!r.ok) { toast(r.data.error || '操作失败', true); return; }
        toast('已清除限时窗口（恢复常驻）');
        loadWorldCfg(true).then(function (c2) { if (view === 'grounds' && c2) drawGrounds(c2); });
      });
    };
    // 新建钓点（一键填充）
    $('ns-add').onclick = function () {
      const name = $('ns-name').value.trim();
      if (!name) { toast('请填写新钓点名称', true); return; }
      const autoId = 'spot_' + Date.now().toString(36).slice(-5);
      adminApi('POST', '/api/admin/spot/add', { token: token, groundId: selGround, id: autoId, name: name, preset: $('ns-preset').value, fill: true }).then(function (r) {
        if (!r.ok) { toast(r.data.error || '创建失败', true); return; }
        toast('钓点「' + name + '」已创建（掉落池已按预设填充）');
        selSpot = r.data.spot.id;
        poolDirty = buffsDirty = false;
        loadWorldCfg(true).then(function (c2) { if (view === 'grounds' && c2) drawGrounds(c2); });
      });
    };
    if ($('ns-del')) {
      $('ns-del').onclick = function () {
        const spNow = g.spots.find(function (x) { return x.id === selSpot; });
        if (!spNow) return;
        confirmModalLocal('删除钓点「' + spNow.name + '」？在该点钓鱼的玩家会被停止' + (g.custom ? '（自定义渔场内的钓点删除后不可恢复）' : '（内置钓点可在「已删除」中恢复）')).then(function (ok) {
          if (!ok) return;
          adminApi('POST', '/api/admin/spot/remove', { token: token, groundId: g.id, spotId: spNow.id }).then(function (r) {
            if (!r.ok) { toast(r.data.error || '删除失败', true); return; }
            toast('钓点已删除' + (r.data.restorable ? '（可恢复）' : ''));
            selSpot = null;
            loadWorldCfg(true).then(function (c2) { if (view === 'grounds' && c2) drawGrounds(c2); });
          });
        });
      };
    }

    drawSpotMap(g);
    const sp = g.spots.find(function (x) { return x.id === selSpot; });
    if (!sp) { $('ed-body').innerHTML = '<div class="hint">该渔场暂无钓点，可用上方「＋ 新建钓点」添加（自动填充掉落池）。</div>'; return; }
    // 草稿：首次进入或切换钓点时从服务器数据拷贝
    if (!poolDirty && !buffsDirty) {
      poolDraft = (sp.pool || []).map(function (e) { return poolToRow(e.pick, e.weight); });
      buffsDraft = (sp.buffs || []).map(function (b) { return { type: b.type, value: b.value }; });
    }
    drawEditors(cfg, g, sp);
  }
  // ---- 钓点地图定位（拖动设置）----
  // 玩家端「钓鱼」页的世界地图坐标与钓点数据一起下发（data.js 的 spot.pos，后台可覆盖）。
  // 这里提供一张缩略世界地图：拖动节点 = 改坐标，坐标以地图宽高的百分比保存（2~98，防止拖出视野）。
  // 草稿存在 posDraft（模块级），因此上鱼广播/切页重绘都不会丢掉尚未保存的拖动结果。
  function drawSpotMap(g) {
    const host = $('gd-map');
    if (!host) return;
    const spots = g.spots || [];
    if (!spots.length) { host.innerHTML = ''; return; }
    const posOf = function (sp) { return posDraft[sp.id] || (Array.isArray(sp.pos) ? sp.pos : null) || [50, 50]; };
    host.innerHTML = '<h3>🗺 地图定位 — ' + esc(g.name) + '</h3>' +
      '<div class="hint" style="margin-bottom:8px">直接拖动节点调整钓点在玩家端世界地图上的位置（坐标 = 地图宽高的百分比）。' +
      '「恢复出厂」把该钓点退回 data.js 的默认坐标。改完点「保存坐标」立即对全服生效。</div>' +
      '<div class="gd-map" id="gd-map-canvas">' +
      '<img class="gd-map-img" src="assets/worldmap.png" alt="" draggable="false">' +
      spots.map(function (sp) {
        const p = posOf(sp);
        return '<button class="gd-node" data-s="' + esc(sp.id) + '" style="left:' + p[0] + '%;top:' + p[1] + '%" title="拖动调整位置">' +
          '<span class="gd-node-dot"></span><span class="gd-node-name">' + esc(sp.name) + '</span></button>';
      }).join('') +
      '</div>' +
      '<div class="mgr-row" style="margin-top:8px"><button class="btn primary" id="gd-map-save">保存坐标</button>' +
      '<button class="btn" id="gd-map-reset">全部恢复出厂坐标</button>' +
      '<span id="gd-map-state" class="hint" style="margin-left:10px">拖动节点后记得保存</span></div>';

    const canvas = $('gd-map-canvas');
    let drag = null;
    function setPos(node, sid, x, y) {
      const nx = Math.max(2, Math.min(98, Math.round(x * 10) / 10));
      const ny = Math.max(2, Math.min(98, Math.round(y * 10) / 10));
      node.style.left = nx + '%';
      node.style.top = ny + '%';
      posDraft[sid] = [nx, ny];
    }
    canvas.querySelectorAll('.gd-node').forEach(function (node) {
      node.addEventListener('pointerdown', function (ev) {
        ev.preventDefault();
        const rect = canvas.getBoundingClientRect();
        drag = { node: node, sid: node.getAttribute('data-s'), rect: rect };
        try { node.setPointerCapture(ev.pointerId); } catch (e) {}
        node.classList.add('dragging');
        onMove(ev);
      });
      node.addEventListener('pointermove', function (ev) { if (drag && drag.node === node) onMove(ev); });
      node.addEventListener('pointerup', function (ev) {
        if (!drag || drag.node !== node) return;
        node.classList.remove('dragging');
        try { node.releasePointerCapture(ev.pointerId); } catch (e) {}
        drag = null;
        $('gd-map-state').innerHTML = '<span style="color:var(--warn)">未保存：' + esc(node.getAttribute('data-s')) +
          ' → ' + posDraft[node.getAttribute('data-s')].join(', ') + '</span>';
      });
      function onMove(ev) {
        const r = drag.rect;
        if (!r.width || !r.height) return;
        setPos(node, drag.sid, ((ev.clientX - r.left) / r.width) * 100, ((ev.clientY - r.top) / r.height) * 100);
      }
    });
    $('gd-map-save').onclick = function () {
      const list = spots.map(function (sp) {
        return { spotId: sp.id, pos: posDraft[sp.id] || (Array.isArray(sp.pos) ? sp.pos : null) };
      }).filter(function (e) { return e.pos; });
      adminApi('POST', '/api/admin/spot/pos', { token: token, groundId: g.id, list: list }).then(function (r) {
        if (!r.ok) { toast((r.data && r.data.error) || '保存失败', true); return; }
        posDraft = {};
        setHint('gd-map-state', '<span style="color:var(--ok)">已保存 ' + (r.data.changed || 0) + ' 处坐标，玩家端地图立即生效</span>');
        toast('钓点坐标已保存');
      });
    };
    $('gd-map-reset').onclick = function () {
      confirmModalLocal('把「' + g.name + '」的钓点坐标全部恢复为出厂值？').then(function (ok) {
        if (!ok) return;
        adminApi('POST', '/api/admin/spot/pos', {
          token: token, groundId: g.id,
          list: spots.map(function (sp) { return { spotId: sp.id, pos: null }; }),
        }).then(function (r) {
          if (!r.ok) { toast((r.data && r.data.error) || '操作失败', true); return; }
          posDraft = {};
          worldCfg = null;
          toast('已恢复出厂坐标');
          renderGrounds();
        });
      });
    };
  }
  // 已删除项的名称提示（内置目录已不在 cfg.grounds 中，退回显示 id）
  function GROUND_NAME_HINT(cfg, id) {
    const g = cfg.grounds.find(function (x) { return x.id === id; });
    return g ? g.name : id;
  }
  function sp0Exists(g) { return !!(g && g.spots && g.spots.length); }
  // 毫秒时间戳 → datetime-local 输入值（本地时区）
  function toLocalInput(ms) {
    if (!ms) return '';
    const d = new Date(ms);
    function p(n) { return ('0' + n).slice(-2); }
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + 'T' + p(d.getHours()) + ':' + p(d.getMinutes());
  }
  function poolToRow(pick, weight) {
    const i = pick.indexOf(':');
    const type = pick.slice(0, i);
    const id = pick.slice(i + 1);
    return { type: type, id: id, weight: weight };
  }
  function rowToPick(r) { return r.type === 'component' ? 'component:' : r.type + ':' + r.id; }

  function drawEditors(cfg, g, sp) {
    const ed = $('ed-body');
    const presetOpts2 = Object.keys(cfg.poolPresets || {}).map(function (k) {
      return '<option value="' + k + '">' + esc(cfg.poolPresets[k].name) + '</option>';
    }).join('');
    const rateBite = sp.biteRate != null && sp.biteRate !== '' ? sp.biteRate : '';
    const rateMs = sp.intervalMs != null && sp.intervalMs !== '' ? sp.intervalMs : '';
    ed.innerHTML = '<h3>🎯 钓点独立上鱼率 / 速率 — ' + esc(g.name) + ' · ' + esc(sp.name) + '</h3>' +
      '<div class="hint" style="margin-bottom:8px">留空 = 使用全服默认：上鱼率走「公式管理」的上钩公式，抛竿间隔按「基础间隔 + 钓速」计算。' +
      '上鱼率填 100 表示该钓点必上钩；间隔填写后该钓点固定按此间隔抛竿（玩家钓速不再影响）。</div>' +
      '<div class="mgr-row"><label>上鱼率</label>' +
      '<input id="sr-bite" class="ipt mk-num" type="number" min="0" max="100" step="1" placeholder="留空=全服公式" value="' + esc(rateBite) + '" />' +
      '<span class="hint">%</span>' +
      '<label class="hint" style="margin-left:12px">抛竿间隔</label>' +
      '<input id="sr-ms" class="ipt mk-num" type="number" min="100" max="60000" step="100" placeholder="留空=按钓速计算" value="' + esc(rateMs) + '" />' +
      '<span class="hint">ms</span>' +
      '<button class="btn primary" id="sr-save">保存</button>' +
      '<button class="btn mini" id="sr-clear">恢复默认</button>' +
      '<span id="sr-state" class="hint"></span></div>' +
      '<h3>🎣 掉落池 — ' + esc(g.name) + ' · ' + esc(sp.name) + '</h3>' +
      '<div id="pool-rows"></div>' +
      '<div class="editor-foot">' +
      '<button id="pool-add" class="btn mini">＋ 添加条目</button>' +
      '<select id="pool-preset" class="ipt gi-type" title="一键填充的预设组合">' + presetOpts2 + '</select>' +
      '<button id="pool-fill" class="btn mini" title="按预设替换整份掉落池（填充后仍可逐条修改，保存才生效）">⚡ 一键填充</button>' +
      '<span id="pool-state" class="hint"></span>' +
      '<span style="flex:1"></span>' +
      '<button id="pool-save" class="btn primary">保存掉落池</button>' +
      '</div>' +
      '<h3>✨ 钓点增益（数值 + 类别，可与钓竿词缀叠加）</h3>' +
      '<div class="hint" style="margin-bottom:8px">数值范围 <b>-100 ~ 100</b>（超出会被服务器拒绝）。</div>' +
      '<div id="buff-rows"></div>' +
      '<div class="editor-foot">' +
      '<button id="buff-add" class="btn mini">＋ 添加增益</button>' +
      '<span id="buff-state" class="hint"></span>' +
      '<span style="flex:1"></span>' +
      '<button id="buff-save" class="btn primary">保存增益</button>' +
      '</div>';

    // 钓点增益可选的类别 = buffTypes（组件 6 类 + 大鱼概率）；组件词缀表 affixTypes 不含大鱼概率
    const affixes = cfg.buffTypes || cfg.affixTypes;
    const buffNote = {
      speed: '钓速：该钓点抛竿速率的最终乘算（× (1-数值/100)），不与钓竿词缀/全服加成相加', big: '大鱼概率：放大「大鱼」条目权重',
      rare: '稀有概率：放大「稀有」条目权重', material: '材料概率：放大材料条目权重',
      size: '体型：放大捕获体型（不与钓竿词缀的体型上限相冲，按百分比放大结果）', double: '双钓概率：触发后立即再结算一竿',
    };

    function drawPool() {
      const wrap = $('pool-rows');
      wrap.innerHTML = poolDraft.map(function (r, idx) {
        return '<div class="pool-row">' +
          '<select class="ipt c-type" data-idx="' + idx + '" data-f="type">' +
          '<option value="fish"' + (r.type === 'fish' ? ' selected' : '') + '>鱼</option>' +
          '<option value="material"' + (r.type === 'material' ? ' selected' : '') + '>材料</option>' +
          '<option value="component"' + (r.type === 'component' ? ' selected' : '') + '>组件</option>' +
          '</select>' +
          itemSelectHtml(r, idx) +
          '<input class="ipt c-w" type="number" min="0" step="1" value="' + esc(r.weight) + '" data-idx="' + idx + '" data-f="weight">' +
          '<div class="c-pct"><div class="pct-bar"><i data-bar="' + idx + '"></i></div><span class="pct-val" data-pct="' + idx + '"></span></div>' +
          '<button class="row-del" data-del="' + idx + '" title="删除">✕</button>' +
          '</div>';
      }).join('');
      wrap.querySelectorAll('select').forEach(function (sel) {
        sel.onchange = function () { const r = poolDraft[+sel.getAttribute('data-idx')]; r[sel.getAttribute('data-f')] = sel.value; if (sel.getAttribute('data-f') === 'type') r.id = ''; poolDirty = true; drawPool(); };
      });
      wrap.querySelectorAll('input').forEach(function (inp) {
        inp.oninput = function () { poolDraft[+inp.getAttribute('data-idx')].weight = Number(inp.value) || 0; poolDirty = true; updatePcts(); };
      });
      wrap.querySelectorAll('[data-del]').forEach(function (b) {
        b.onclick = function () { poolDraft.splice(+b.getAttribute('data-del'), 1); poolDirty = true; drawPool(); };
      });
      updatePcts();
      function updatePcts() {
        const total = poolDraft.reduce(function (n, r) { return n + (Number(r.weight) || 0); }, 0);
        const sums = $('pool-state');
        if (total <= 0) {
          sums.innerHTML = '<span class="err">总权重为 0，无法掷骰</span>';
          $('pool-save').disabled = true;
          poolDraft.forEach(function (_, i) {
            const bar = wrap.querySelector('[data-bar="' + i + '"]'); if (bar) bar.style.width = '0%';
            const pv = wrap.querySelector('[data-pct="' + i + '"]'); if (pv) pv.textContent = '0%';
          });
          return;
        }
        let warn = '';
        for (const r of poolDraft) {
          const w = Number(r.weight);
          if (!isFinite(w) || w < 0 || w > 1000000) warn = '存在无效权重（需 0 - 1000000）';
          if (r.type !== 'component' && !r.id) warn = '存在未选择物品的条目';
        }
        sums.innerHTML = '总权重 ' + (Math.round(total * 100) / 100) + (warn ? ' · <span class="err">' + esc(warn) + '</span>' : ' · 实时占比：');
        $('pool-save').disabled = !!warn;
        poolDraft.forEach(function (r, i) {
          const pct = total > 0 ? (Number(r.weight) || 0) / total * 100 : 0;
          const bar = wrap.querySelector('[data-bar="' + i + '"]');
          if (bar) bar.style.width = Math.min(100, pct) + '%';
          const pv = wrap.querySelector('[data-pct="' + i + '"]');
          if (pv) pv.textContent = (Math.round(pct * 100) / 100) + '%';
        });
      }
    }
    function itemSelectHtml(r, idx) {
      if (r.type === 'component') {
        return '<select class="ipt c-item" disabled><option>组件（随机组件掉落）</option></select>';
      }
      const opts = r.type === 'fish' ? cfg.catalog.fish : cfg.catalog.materials;
      const valid = opts.some(function (o) { return o.id === r.id; });
      return '<select class="ipt c-item" data-idx="' + idx + '" data-f="id">' +
        '<option value=""' + (!r.id || !valid ? ' selected' : '') + disabledAttr(!r.id || !valid) + '>— 选择 —</option>' +
        opts.map(function (o) {
          const extra = o.rarity && o.rarity !== 'common' ? '（' + (RARITY_NAME[o.rarity] || o.rarity) + '）' : '';
          return '<option value="' + esc(o.id) + '"' + (r.id === o.id ? ' selected' : '') + '>' + esc(o.name) + extra + '</option>';
        }).join('') +
        '</select>';
    }
    function disabledAttr(d) { return d ? ' disabled' : ''; }

    function drawBuffs() {
      const wrap = $('buff-rows');
      if (!buffsDraft.length) wrap.innerHTML = '<div class="hint" style="margin-bottom:8px">暂无增益，钓点按原始掉落与速度运行。</div>';
      else wrap.innerHTML = buffsDraft.map(function (b, idx) {
        return '<div class="buff-row">' +
          '<select class="ipt c-type" data-idx="' + idx + '" data-f="type">' +
          Object.keys(affixes).map(function (k) { return '<option value="' + k + '"' + (b.type === k ? ' selected' : '') + '>' + esc(affixes[k]) + '（' + k + '）</option>'; }).join('') +
          '</select>' +
          '<input class="ipt c-v" type="number" min="-100" max="100" step="1" value="' + esc(b.value) + '" data-idx="' + idx + '" data-f="value" title="范围 -100 ~ 100">' +
          '<span class="buff-note">' + esc(buffNote[b.type] || '') + '</span>' +
          '<button class="row-del" data-bdel="' + idx + '" title="删除">✕</button>' +
          '</div>';
      }).join('');
      wrap.querySelectorAll('select').forEach(function (sel) {
        sel.onchange = function () { buffsDraft[+sel.getAttribute('data-idx')].type = sel.value; buffsDirty = true; drawBuffs(); };
      });
      wrap.querySelectorAll('input').forEach(function (inp) {
        inp.oninput = function () { buffsDraft[+inp.getAttribute('data-idx')].value = Number(inp.value) || 0; buffsDirty = true; };
      });
      wrap.querySelectorAll('[data-bdel]').forEach(function (b) {
        b.onclick = function () { buffsDraft.splice(+b.getAttribute('data-bdel'), 1); buffsDirty = true; drawBuffs(); };
      });
      $('buff-state').innerHTML = buffsDraft.length ? '增益在保存后立即并入该钓点的掷骰加成' : '';
    }

    drawPool();
    drawBuffs();

    // 钓点独立上鱼率 / 速率（留空 = 全服默认）
    function saveSpotRate(clear) {
      const biteRaw = $('sr-bite').value.trim();
      const msRaw = $('sr-ms').value.trim();
      const payload = { token: token, groundId: g.id, spotId: sp.id };
      if (clear) { payload.biteRate = ''; payload.intervalMs = ''; }
      else {
        if (biteRaw !== '') {
          const b = Number(biteRaw);
          if (!isFinite(b) || b < 0 || b > 100) { $('sr-state').innerHTML = '<span class="err">上鱼率需在 0 - 100 之间</span>'; return; }
        }
        if (msRaw !== '') {
          const m = Number(msRaw);
          if (!isFinite(m) || m < 100 || m > 60000) { $('sr-state').innerHTML = '<span class="err">间隔需在 100 - 60000 ms 之间</span>'; return; }
        }
        payload.biteRate = biteRaw;
        payload.intervalMs = msRaw;
      }
      adminApi('POST', '/api/admin/spot/rate', payload).then(function (r) {
        if (!r.ok) { $('sr-state').innerHTML = '<span class="err">' + esc(r.data.error || '保存失败') + '</span>'; return; }
        const parts = [];
        parts.push(r.data.biteRate != null ? ('上鱼率 ' + r.data.biteRate + '%') : '上鱼率=全服公式');
        parts.push(r.data.intervalMs != null ? ('间隔 ' + r.data.intervalMs + 'ms') : '间隔=按钓速计算');
        $('sr-state').innerHTML = '<span style="color:var(--ok)">已保存：' + esc(parts.join(' · ')) + '</span>';
        toast('钓点速率已保存，正在该钓点钓鱼的玩家立即生效');
        loadWorldCfg(true).then(function (c) { if (view === 'grounds' && c) drawGrounds(c); });
      });
    }
    $('sr-save').onclick = function () { saveSpotRate(false); };
    $('sr-clear').onclick = function () {
      confirmModalLocal('恢复该钓点的上鱼率与间隔为全服默认？').then(function (ok) { if (ok) saveSpotRate(true); });
    };
    $('pool-add').onclick = function () { poolDraft.push({ type: 'fish', id: '', weight: 10 }); poolDirty = true; drawPool(); };
    // 一键填充：按预设（经济浅水/大物塘/稀有秘境/材料工坊）替换草稿，保存后生效
    $('pool-fill').onclick = function () {
      const preset = $('pool-preset').value;
      adminApi('POST', '/api/admin/pool/preset', { token: token, preset: preset }).then(function (r) {
        if (!r.ok) { toast(r.data.error || '加载预设失败', true); return; }
        poolDraft = r.data.pool.map(function (e) { return poolToRow(e.pick, e.weight); });
        poolDirty = true;
        drawPool();
        const nm = (r.data.presets && r.data.presets[preset]) ? r.data.presets[preset].name : preset;
        toast('已按「' + nm + '」填充 ' + poolDraft.length + ' 条，点「保存掉落池」生效');
      });
    };
    $('buff-add').onclick = function () { buffsDraft.push({ type: 'speed', value: 10 }); buffsDirty = true; drawBuffs(); };
    $('pool-save').onclick = function () {
      adminApi('POST', '/api/admin/spot/pool', { token: token, groundId: g.id, spotId: sp.id, pool: poolDraft.map(function (r) { return { pick: rowToPick(r), weight: Number(r.weight) || 0 }; }) }).then(function (r) {
        if (!r.ok) { toast(r.data.error || '保存失败', true); return; }
        poolDirty = false;
        toast('掉落池已保存，全服即时生效');
        loadWorldCfg(true).then(function (c) { if (view === 'grounds' && c) drawGrounds(c); }); // 重新拉取，避免用保存前的缓存重绘
      });
    };
    $('buff-save').onclick = function () {
      adminApi('POST', '/api/admin/spot/buffs', { token: token, groundId: g.id, spotId: sp.id, buffs: buffsDraft.map(function (b) { return { type: b.type, value: Number(b.value) || 0 }; }) }).then(function (r) {
        if (!r.ok) { toast(r.data.error || '保存失败', true); return; }
        buffsDirty = false;
        toast('增益已保存，正在该钓点钓鱼的玩家立即按新加成循环');
        loadWorldCfg(true).then(function (c) { if (view === 'grounds' && c) drawGrounds(c); });
      });
    };
  }

  // ================================
  // 市集管理
  // ================================
  function renderMarket() {
    const main = $('main');
    main.innerHTML = '<h2>💱 开放市集管理</h2>' +
      '<div class="hint" style="margin-bottom:12px">「退回」将挂单物品退回卖家背包（上架费不退，与过期规则一致），卖家在线时会收到通知。</div>' +
      '<div class="mk-filters">' +
      '<input id="mk-search" class="ipt mk-search" placeholder="🔍 搜索物品 / 卖家 / 账号…" />' +
      '<select id="mk-kind" class="ipt mk-kind"><option value="all">全部类型</option><option value="fish">🐟 鱼类</option><option value="material">🧵 材料</option><option value="component">🔧 组件</option></select>' +
      // 词条 + 数值筛选（仅对组件生效）
      '<select id="mk-aff" class="ipt mk-kind"><option value="all">全部词条</option></select>' +
      '<input id="mk-amin" class="ipt mk-num" type="number" placeholder="最小值" />' +
      '<span class="hint">~</span>' +
      '<input id="mk-amax" class="ipt mk-num" type="number" placeholder="最大值" />' +
      // 排序：时间 / 价格 / 数量
      '<select id="mk-sort" class="ipt mk-kind"><option value="time">排序：时间</option><option value="price">排序：价格</option><option value="qty">排序：数量</option></select>' +
      '<select id="mk-dir" class="ipt mk-kind"><option value="desc">降序</option><option value="asc">升序</option></select>' +
      '<span id="mk-count" class="hint"></span></div>' +
      '<div id="mk-body" class="panel">加载中…</div>';
    // 词条选项来自共享目录
    const affSel = $('mk-aff');
    if (typeof GameData !== 'undefined' && GameData.AFFIX_LABEL) {
      Object.keys(GameData.AFFIX_LABEL).forEach(function (t) {
        const o = document.createElement('option'); o.value = t; o.textContent = GameData.AFFIX_LABEL[t]; affSel.appendChild(o);
      });
    }
    $('mk-search').value = mkSearch; $('mk-kind').value = mkKind;
    affSel.value = mkAffix; $('mk-amin').value = mkAffixMin; $('mk-amax').value = mkAffixMax;
    $('mk-sort').value = mkSort.key; $('mk-dir').value = mkSort.dir;
    $('mk-search').addEventListener('input', function () { mkSearch = this.value; drawMarket(); });
    $('mk-kind').addEventListener('change', function () { mkKind = this.value; drawMarket(); });
    affSel.addEventListener('change', function () { mkAffix = this.value; drawMarket(); });
    $('mk-amin').addEventListener('input', function () { mkAffixMin = this.value; drawMarket(); });
    $('mk-amax').addEventListener('input', function () { mkAffixMax = this.value; drawMarket(); });
    $('mk-sort').addEventListener('change', function () { mkSort.key = this.value; drawMarket(); });
    $('mk-dir').addEventListener('change', function () { mkSort.dir = this.value; drawMarket(); });
    return refreshMarket();
  }
  function filteredListings() {
    const q = mkSearch.trim().toLowerCase();
    let out = listings.filter(function (l) {
      if (mkKind !== 'all') {
        const meta = (typeof GameData !== 'undefined' && GameData.itemOf) ? GameData.itemOf(l.id) : null;
        if (!meta || meta.kind !== mkKind) return false;
      }
      if (q) {
        const hay = (l.name + ' ' + (l.sellerName || '') + ' ' + l.seller).toLowerCase();
        if (hay.indexOf(q) < 0) return false;
      }
      if (mkAffix !== 'all' || mkAffixMin !== '' || mkAffixMax !== '') {
        const meta = (typeof GameData !== 'undefined' && GameData.itemOf) ? GameData.itemOf(l.id) : null;
        if (!meta || meta.kind !== 'component' || !meta.affixes) return false;
        const ok = meta.affixes.some(function (a) {
          if (mkAffix !== 'all' && a.type !== mkAffix) return false;
          if (mkAffixMin !== '' && a.value < Number(mkAffixMin)) return false;
          if (mkAffixMax !== '' && a.value > Number(mkAffixMax)) return false;
          return true;
        });
        if (!ok) return false;
      }
      return true;
    });
    const dir = mkSort.dir === 'asc' ? 1 : -1;
    out.sort(function (a, b) {
      let d;
      if (mkSort.key === 'price') d = a.price - b.price;
      else if (mkSort.key === 'qty') d = a.qty - b.qty;
      else d = a.t - b.t;
      return d * dir || (b.t - a.t);
    });
    return out;
  }
  function drawMarket() {
    const body = $('mk-body');
    if (!body) return;
    const cnt = $('mk-count');
    const shown = filteredListings();
    if (cnt) cnt.textContent = '显示 ' + shown.length + ' / ' + listings.length + ' 条挂单';
    if (!listings.length) { body.innerHTML = '<div class="hint">当前没有挂单。</div>'; return; }
    if (!shown.length) { body.innerHTML = '<div class="hint">没有符合条件的挂单。</div>'; return; }
    body.innerHTML = '<table class="tbl"><thead><tr>' +
      '<th>物品</th><th>卖家</th><th class="num">数量</th><th class="num">单价</th><th class="num">总价</th><th>剩余时长</th><th>操作</th>' +
      '</tr></thead><tbody>' +
      shown.map(function (l) {
        return '<tr>' +
          '<td><b>' + esc(l.name) + '</b></td>' +
          '<td>' + esc(l.sellerName) + ' <span class="hint">' + esc(l.seller) + '</span></td>' +
          '<td class="num">' + l.qty + '</td>' +
          '<td class="num">' + l.price + '</td>' +
          '<td class="num">' + (l.price * l.qty) + '</td>' +
          '<td class="remain">' + remainText(l.expireAt) + '</td>' +
          '<td><button class="btn mini danger" data-ret="' + l.lid + '">退回</button></td>' +
          '</tr>';
      }).join('') + '</tbody></table>';
    body.querySelectorAll('[data-ret]').forEach(function (b) {
      b.onclick = function () {
        const lid = Number(b.getAttribute('data-ret'));
        const l = listings.find(function (x) { return x.lid === lid; });
        confirmModalLocal('确认退回挂单「' + (l ? l.name : lid) + '」？物品将退回卖家背包，上架费不退。').then(function (ok) {
          if (!ok) return;
          b.disabled = true;
          adminApi('POST', '/api/admin/market/return', { token: token, lid: lid }).then(function (r) {
            if (!r.ok) { toast(r.data.error || '退回失败', true); b.disabled = false; refreshMarket(); return; }
            toast('已退回：' + (r.data.returned ? r.data.returned.name : '') + ' ×' + (r.data.returned ? r.data.returned.qty : ''));
            refreshMarket();
          });
        });
      };
    });
  }
  // 子窗口确认（管理后台也用子窗口，替代浏览器 confirm）
  function confirmModalLocal(text) {
    return new Promise(function (resolve) {
      document.querySelectorAll('.modal-overlay').forEach(function (m) { m.remove(); });
      const ov = document.createElement('div');
      ov.className = 'modal-overlay';
      ov.innerHTML = '<div class="modal-box confirm-modal"><div class="modal-head"><span class="modal-title">请确认</span></div>' +
        '<div class="modal-body"><div class="cf-text">' + esc(text) + '</div>' +
        '<div class="cf-actions"><button class="btn mini cf-no">取消</button><button class="btn mini danger cf-yes">确定</button></div></div></div>';
      document.body.appendChild(ov);
      ov.addEventListener('click', function (e) { if (e.target === ov) { ov.remove(); resolve(false); } });
      ov.querySelector('.cf-no').onclick = function () { ov.remove(); resolve(false); };
      ov.querySelector('.cf-yes').onclick = function () { ov.remove(); resolve(true); };
    });
  }
  // 子窗口输入（数字/文本；替代浏览器 prompt）
  function promptModalLocal(opts) {
    opts = opts || {};
    return new Promise(function (resolve) {
      document.querySelectorAll('.modal-overlay').forEach(function (m) { m.remove(); });
      const ov = document.createElement('div');
      ov.className = 'modal-overlay';
      ov.innerHTML = '<div class="modal-box confirm-modal"><div class="modal-head"><span class="modal-title">' + esc(opts.title || '请输入') + '</span>' +
        '<button class="btn mini cf-x">✕</button></div>' +
        '<div class="modal-body">' + (opts.hint ? '<div class="cf-hint">' + esc(opts.hint) + '</div>' : '') +
        '<div class="cf-row"><label class="hint">' + esc(opts.label || '') + '</label>' +
        '<input class="ipt cf-val" type="' + (opts.numeric ? 'number' : 'text') + '" value="' + esc(opts.value != null ? opts.value : '') + '" /></div>' +
        '<div class="cf-actions"><button class="btn mini cf-no">取消</button><button class="btn mini primary cf-yes">确定</button></div></div></div>';
      document.body.appendChild(ov);
      const inp = ov.querySelector('.cf-val');
      function done(v) { ov.remove(); resolve(v); }
      ov.addEventListener('click', function (e) { if (e.target === ov) done(null); });
      ov.querySelector('.cf-x').onclick = function () { done(null); };
      ov.querySelector('.cf-no').onclick = function () { done(null); };
      ov.querySelector('.cf-yes').onclick = function () { done(opts.numeric ? Number(inp.value) : inp.value); };
      inp.addEventListener('keydown', function (e) { if (e.key === 'Enter') done(opts.numeric ? Number(inp.value) : inp.value); });
      inp.focus(); inp.select();
    });
  }
  function refreshMarket() {
    return api('GET', '/api/market').then(function (r) {
      if (!r.ok || view !== 'market') return;
      listings = r.data.listings || [];
      drawMarket();
    });
  }

  // ================================
  // 上钩公式
  // ================================
  // 上钩公式的可用变量（顺序与服务器 BITE_VAR_NAMES 一致，供文档与试算表单共用）
  // skill = v0.11 起由「技巧」词缀提供的变量，是新版提升上钩率的主参数；big 是旧版遗留变量（恒为 0）。
  const BITE_VARS_DOC = [
    ['speed', '钓速加成 %（钓竿词缀 + 钓点增益）'],
    ['skill', '技巧加成 %（钓竿「技巧」词缀合计 · v0.11 新增，默认公式 90 + skill）'],
    ['rare', '稀有概率加成 %'],
    ['material', '材料概率加成 %'],
    ['size', '体型加成 %'],
    ['double', '双钓叠加值 A（概率按 A/(A+100) 换算）'],
    ['interval', '当前抛竿间隔 ms'],
    ['big', '（旧版遗留）大鱼概率加成 %：v0.11 起组件不再产出该词缀，恒为 0，保留仅为兼容历史公式'],
  ];
  // 🎁 宝匣配置：档位一览（只读，配方写在 data.js 的 CHESTS）+ 突破保底次数 + 池外词缀区间
  function renderChest() {
    const main = $('main');
    main.innerHTML = '<h2>🎁 宝匣配置</h2>' +
      '<div class="hint" style="margin-bottom:12px">宝匣四档的配方（残片数 / 金币 / 基底模式 / 品质权重）定义在游戏目录 <code>frontend/js/data.js</code> 的 <code>CHESTS</code>，随版本发布；本页只放运行期可调项，保存即生效并落盘 config.json。</div>' +
      '<div id="ch-body" class="panel">加载中…</div>';
    loadWorldCfg(true).then(function (cfg) {
      if (!cfg || view !== 'chest') return;
      drawChest(cfg);
    });
  }
  function drawChest(cfg) {
    const body = $('ch-body');
    if (!body) return;
    const C = cfg.chestCfg || {};
    const MAX = cfg.chestPityMax || 50;
    const chests = cfg.chests || [];
    const AR = cfg.extraAffixRanges || {};
    const AD = cfg.extraAffixDefaults || {};
    // 词缀名称取服务器下发的组件词缀表（含「技巧」；钓点增益另有一类「大鱼概率」，不属于组件词缀）
    const LABEL = cfg.affixTypes || {};
    const MODE = { random: '基底随机', part: '自选部位', base: '自选底材' };
    const CM = (cfg.chestCostMax) || { relic: 9999, coins: 100000000 };
    const row = function (c) {
      const changed = c.costRelic !== c.baseRelic || c.costCoins !== c.baseCoins;
      return '<tr><td><b>' + esc(c.name) + '</b>' + (changed ? ' <span class="tag on">已改</span>' : '') + '</td>' +
        '<td>' + esc(MODE[c.mode] || c.mode) + '</td>' +
        '<td class="num"><input class="ipt mk-num ch-cost" data-cid="' + esc(c.id) + '" data-k="costRelic" type="number" min="0" max="' + CM.relic + '" step="1" value="' + c.costRelic + '"></td>' +
        '<td class="num"><input class="ipt mk-num ch-cost" data-cid="' + esc(c.id) + '" data-k="costCoins" type="number" min="0" max="' + CM.coins + '" step="1" value="' + c.costCoins + '"></td>' +
        '<td>' + (c.hasExtra
          ? '神话 · 50% 突破（' + c.missCount + '~' + c.hitCount + ' 条）'
          : (c.id === 'chest_abyss' ? '史诗 · 满词条' : '稀有 / 史诗')) + '</td></tr>';
    };
    body.innerHTML =
      '<h3 style="margin-top:0">📦 档位与合成成本（残片 / 金币可直接改）</h3>' +
      '<table class="tbl"><thead><tr><th>档位</th><th>基底</th><th class="num">残片</th><th class="num">金币</th><th>产出</th></tr></thead><tbody>' +
      chests.map(row).join('') + '</tbody></table>' +
      '<div class="mgr-row" style="margin-top:8px"><button class="btn primary" id="ch-cost-save">保存成本</button>' +
      '<button class="btn" id="ch-cost-reset">恢复出厂成本</button>' +
      '<span id="ch-cost-state" class="hint" style="margin-left:10px">出厂值：' +
      chests.map(function (c) { return esc(c.name) + ' ' + c.baseRelic + ' 残片/💰' + c.baseCoins; }).join('｜') + '</span></div>' +
      '<div class="hint" style="margin-top:6px">改动会立即同步到玩家端「🎁 宝匣合成」页与合成校验（无需重启）。' +
      '档位模式 / 品质权重 / 词条数等结构性配方仍写在 <code>data.js</code> 的 <code>CHESTS</code>，随版本发布。</div>' +

      '<h3>⚡ 突破保底</h3>' +
      '<div class="hint" style="margin-bottom:8px">「海王遗匣」的破突判定为 50% 掷骰。设 N 后：连续 N−1 次未突破，第 N 次必出突破件（命中即清零）。<b>0 = 关闭</b>。</div>' +
      // 输入框必须包在 .ch-fix 里：.mgr-row .ipt 默认 flex:1，直接放会被拉满整行
      '<div class="mgr-row"><span class="ch-fix"><label>保底次数 N</label>' +
      '<input id="ch-pity" class="ipt mk-num" type="number" min="0" max="' + MAX + '" step="1" value="' + (C.pityN || 0) + '"></span>' +
      '<span class="hint">0 = 关闭；1~' + MAX + '。改小会让已累计次数的玩家更容易触发，改大会让「下次必出」退回。</span></div>' +
      '<div class="mgr-row"><button class="btn primary" id="ch-pity-save">保存保底</button>' +
      '<button class="btn" id="ch-pity-reset" style="margin-left:8px">关闭保底（0）</button>' +
      '<span id="ch-pity-state" class="hint" style="margin-left:10px"></span></div>' +
      '<div class="hint" style="margin-top:6px">参考：期望开箱次数 关闭=2.00 / N=4 → 1.88 / N=3 → 1.75 / N=2 → 1.50；N=3 把最坏情况从「无上限」压到 3 次，是性价比最高的一档。</div>' +

      '<h3>🎲 池外词缀数值区间</h3>' +
      '<div class="hint" style="margin-bottom:8px">突破件在底材词缀池之外补足的词缀所用的数值区间。<b>应当明显弱于池内区间</b>，否则 2 条池的弱底材补上强池外后会反超 4 条池底材。留空 = 用默认值。</div>' +
      '<div class="ch-ar-wrap">' +
      Object.keys(AD).map(function (t) {
        const cur = AR[t];
        const dv = AD[t];
        return '<span class="ch-fix"><label class="hint">' + (LABEL[t] || t) + '</label>' +
          '<input id="ch-ar-' + t + '-min" class="ipt mk-num" type="number" placeholder="' + dv[0] + '" value="' + (cur ? cur[0] : '') + '">' +
          '<span class="hint">~</span>' +
          '<input id="ch-ar-' + t + '-max" class="ipt mk-num" type="number" placeholder="' + dv[1] + '" value="' + (cur ? cur[1] : '') + '">' +
          '<span class="hint">%（默认 ' + dv[0] + '~' + dv[1] + '）</span></span>';
      }).join('') + '</div>' +
      '<div class="mgr-row"><button class="btn primary" id="ch-ar-save">保存池外区间</button>' +
      '<button class="btn" id="ch-ar-reset" style="margin-left:8px">恢复默认</button>' +
      '<span id="ch-ar-state" class="hint" style="margin-left:10px"></span></div>';

    $('ch-pity-save').onclick = function () {
      const v = Number(($('ch-pity') || {}).value);
      adminApi('POST', '/api/admin/settings', { token: token, chestCfg: { pityN: isFinite(v) && v > 0 ? v : 0 } }).then(function (r) {
        if (!r.ok) { toast((r.data && r.data.error) || '保存失败', true); return; }
        worldCfg = null;
        $('ch-pity-state').innerHTML = '<span style="color:var(--ok,#4ade80)">已保存：保底 ' + ((r.data.chestCfg || {}).pityN || 0) + ' 次，立即生效</span>';
        toast('宝匣保底已保存，立即生效');
      });
    };
    $('ch-pity-reset').onclick = function () {
      adminApi('POST', '/api/admin/settings', { token: token, chestCfg: { pityN: 0 } }).then(function (r) {
        if (!r.ok) { toast((r.data && r.data.error) || '保存失败', true); return; }
        worldCfg = null;
        $('ch-pity').value = 0;
        $('ch-pity-state').innerHTML = '<span style="color:var(--warn,#f59e0b)">已关闭保底</span>';
        toast('已关闭宝匣保底');
      });
    };
    // 合成成本（残片 / 金币）：一次提交全部档位，留空/为 0 按 0 处理（0 = 免费）
    $('ch-cost-save').onclick = function () {
      const costs = {};
      body.querySelectorAll('.ch-cost').forEach(function (inp) {
        const cid = inp.getAttribute('data-cid'), k = inp.getAttribute('data-k');
        const v = Math.floor(Number(inp.value));
        if (!isFinite(v) || v < 0) { costs[cid] = costs[cid] || {}; return; }
        costs[cid] = costs[cid] || {};
        costs[cid][k] = v;
      });
      adminApi('POST', '/api/admin/settings', { token: token, chestCfg: { costs: costs } }).then(function (r) {
        if (!r.ok) { toast((r.data && r.data.error) || '保存失败', true); return; }
        worldCfg = null;
        setHint('ch-cost-state', '<span style="color:var(--ok)">已保存，立即生效（玩家端宝匣页同步更新）</span>');
        toast('宝匣合成成本已保存');
        renderChest();
      });
    };
    $('ch-cost-reset').onclick = function () {
      confirmModalLocal('把四档宝匣的合成成本恢复为出厂值？').then(function (ok) {
        if (!ok) return;
        adminApi('POST', '/api/admin/settings', { token: token, chestCfg: { costs: {} } }).then(function (r) {
          if (!r.ok) { toast((r.data && r.data.error) || '保存失败', true); return; }
          worldCfg = null;
          toast('已恢复出厂成本');
          renderChest();
        });
      });
    };
    $('ch-ar-save').onclick = function () {
      const out = {};
      Object.keys(AD).forEach(function (t) {
        const mn = ($('ch-ar-' + t + '-min') || {}).value;
        const mx = ($('ch-ar-' + t + '-max') || {}).value;
        if (mn === '' && mx === '') return;             // 留空 = 用默认
        const a = Number(mn), b = Number(mx);
        if (!isFinite(a) || !isFinite(b) || b < a) return;
        out[t] = [Math.round(a), Math.round(b)];
      });
      adminApi('POST', '/api/admin/component/config', { token: token, extraAffixRanges: out }).then(function (r) {
        if (!r.ok) { toast((r.data && r.data.error) || '保存失败', true); return; }
        worldCfg = null;
        $('ch-ar-state').innerHTML = '<span style="color:var(--ok,#4ade80)">已保存 ' + Object.keys(out).length + ' 项，立即生效</span>';
        toast('池外词缀区间已保存');
      });
    };
    $('ch-ar-reset').onclick = function () {
      adminApi('POST', '/api/admin/component/config', { token: token, extraAffixRanges: {} }).then(function (r) {
        if (!r.ok) { toast((r.data && r.data.error) || '保存失败', true); return; }
        worldCfg = null;
        renderChest();
        toast('池外词缀区间已恢复默认');
      });
    };
  }

  // ================================
  // 商城配置（每日限购）
  // ================================
  // 商品 = 物品 id + 金币价 + 每日限购（0 = 不限购）；限购按「刷新时间 HH:MM」划分周期，
  // 跨过刷新点即重置。物品从目录下拉选（鱼 / 材料 / 宝匣），也可直接填组件实例签名。
  let mallDraft = null;
  function mallCatalog(cfg) {
    const out = [];
    const cat = cfg.catalog || {};
    (cat.fish || []).forEach(function (f) { out.push({ id: f.id, name: f.name }); });
    (cat.materials || []).forEach(function (m) { out.push({ id: m.id, name: m.name }); });
    (cat.chests || []).forEach(function (c) { out.push({ id: c.id, name: c.name }); });
    return out;
  }
  function renderMall() {
    const main = $('main');
    main.innerHTML = '<h2>🛒 商城配置</h2>' +
      '<div class="hint" style="margin-bottom:12px">玩家端「🛒 商城」页的金币直购商品：每件商品可设金币价与<b>每日限购</b>（0 = 不限购）。' +
      '限购按「刷新时间」划分周期——到点即重置为满额。保存后立即同步给在线玩家。</div>' +
      '<div id="ml-body" class="panel">加载中…</div>';
    loadWorldCfg(true).then(function (cfg) {
      if (!cfg || view !== 'mall') return;
      drawMall(cfg);
    });
  }
  function drawMall(cfg) {
    const body = $('ml-body');
    if (!body) return;
    const M = cfg.mallCfg || { refreshTime: '04:00', items: [] };
    const DEF = cfg.mallDefaults || { refreshTime: '04:00', items: [] };
    if (!mallDraft) mallDraft = (M.items || []).map(function (e) { return { id: e.id, price: e.price, limit: e.limit }; });
    const cat = mallCatalog(cfg);
    const nameOf = function (id) {
      const it = window.GameData ? window.GameData.itemOf(id) : null;
      return it ? it.name : id;
    };
    const rows = mallDraft.map(function (e, i) {
      return '<tr>' +
        '<td>' + esc(nameOf(e.id)) + ' <span class="hint">' + esc(e.id) + '</span></td>' +
        '<td class="num"><input class="ipt mk-num ml-price" data-i="' + i + '" type="number" min="0" step="1" value="' + e.price + '"></td>' +
        '<td class="num"><input class="ipt mk-num ml-limit" data-i="' + i + '" type="number" min="0" max="9999" step="1" value="' + e.limit + '"></td>' +
        '<td><button class="btn mini danger" data-ml-rm="' + i + '">移除</button></td></tr>';
    }).join('');
    body.innerHTML =
      '<h3 style="margin-top:0">🕓 限购刷新时间</h3>' +
      '<div class="mgr-row"><span class="ch-fix"><label>每日刷新</label>' +
      '<input id="ml-rt" class="ipt mk-num" type="time" value="' + esc(M.refreshTime) + '"></span>' +
      '<span class="hint">服务器本地时间；到点后所有玩家的每日限购重置。默认 ' + esc(DEF.refreshTime) + '。</span></div>' +
      '<h3>📦 商品列表（' + mallDraft.length + ' 件）</h3>' +
      '<table class="tbl ml-tbl"><thead><tr><th>物品</th><th class="num">金币价</th><th class="num">每日限购</th><th></th></tr></thead><tbody>' +
      (rows || '<tr><td colspan="4" class="hint">还没有商品，用下方「添加商品」上架。</td></tr>') + '</tbody></table>' +
      '<div class="mgr-row" style="margin-top:10px">' +
      '<select id="ml-add-id" class="ipt" style="max-width:280px">' +
      cat.map(function (c) { return '<option value="' + esc(c.id) + '">' + esc(c.name) + '</option>'; }).join('') +
      '</select>' +
      '<input id="ml-add-custom" class="ipt" placeholder="自定义物品 id（如组件实例签名）" style="max-width:260px">' +
      '<input id="ml-add-price" class="ipt mk-num" type="number" min="0" placeholder="金币价" style="max-width:120px">' +
      '<input id="ml-add-limit" class="ipt mk-num" type="number" min="0" max="9999" placeholder="每日限购" value="1" style="max-width:120px">' +
      '<button class="btn" id="ml-add">＋ 添加商品</button></div>' +
      '<div class="mgr-row" style="margin-top:10px"><button class="btn primary" id="ml-save">保存商城配置</button>' +
      '<button class="btn" id="ml-reset">恢复默认商品</button>' +
      '<span id="ml-state" class="hint" style="margin-left:10px"></span></div>';

    body.querySelectorAll('.ml-price').forEach(function (inp) {
      inp.onchange = function () { mallDraft[Number(inp.getAttribute('data-i'))].price = Math.max(0, Math.floor(Number(inp.value) || 0)); };
    });
    body.querySelectorAll('.ml-limit').forEach(function (inp) {
      inp.onchange = function () { mallDraft[Number(inp.getAttribute('data-i'))].limit = Math.max(0, Math.floor(Number(inp.value) || 0)); };
    });
    body.querySelectorAll('[data-ml-rm]').forEach(function (b) {
      b.onclick = function () { mallDraft.splice(Number(b.getAttribute('data-ml-rm')), 1); drawMall(cfg); };
    });
    $('ml-add').onclick = function () {
      const id = ($('ml-add-id').value || $('ml-add-custom').value).trim();
      if (!id) { toast('请选择或填写物品 id', true); return; }
      if (mallDraft.some(function (e) { return e.id === id; })) { toast('该物品已在商品列表中', true); return; }
      const price = Math.max(0, Math.floor(Number($('ml-add-price').value) || 0));
      const limit = Math.max(0, Math.floor(Number($('ml-add-limit').value) || 0));
      mallDraft.push({ id: id, price: price, limit: limit });
      drawMall(cfg);
    };
    $('ml-save').onclick = function () {
      adminApi('POST', '/api/admin/mall/config', { token: token, refreshTime: $('ml-rt').value || '04:00', items: mallDraft })
        .then(function (r) {
          if (!r.ok) { toast((r.data && r.data.error) || '保存失败', true); return; }
          worldCfg = null;
          mallDraft = null;
          const C = r.data.mallCfg || {};
          setHint('ml-state', '<span style="color:var(--ok)">已保存：' + (C.items || []).length + ' 件商品，刷新时间 ' + esc(C.refreshTime || '') + '</span>');
          toast('商城配置已保存，立即生效');
        });
    };
    $('ml-reset').onclick = function () {
      confirmModalLocal('把商城商品恢复为出厂默认列表？').then(function (ok) {
        if (!ok) return;
        adminApi('POST', '/api/admin/mall/config', { token: token, reset: true }).then(function (r) {
          if (!r.ok) { toast((r.data && r.data.error) || '操作失败', true); return; }
          worldCfg = null; mallDraft = null;
          toast('已恢复默认商品');
          renderMall();
        });
      });
    };
  }

  // ================================
  // 工坊配置（熔炼参数）
  // ================================
  function renderWorkshop() {
    const main = $('main');
    main.innerHTML = '<h2>⚒ 工坊配置（熔炼）</h2>' +
      '<div class="hint" style="margin-bottom:12px">熔炼的成功率与花费系数。玩家端「⚒ 工坊」页的预览与实际掷骰都用这套参数（服务器权威）。</div>' +
      '<div id="ws-body" class="panel">加载中…</div>';
    loadWorldCfg(true).then(function (cfg) {
      if (!cfg || view !== 'workshop') return;
      drawWorkshop(cfg);
    });
  }
  function drawWorkshop(cfg) {
    const body = $('ws-body');
    if (!body) return;
    const SC = cfg.smeltCfg || {};
    const DEF = cfg.smeltDefaults || {};
    const mats = cfg.smeltMaterials || [];
    const F = function (k, label, hint, step) {
      return '<span class="ch-fix"><label>' + esc(label) + '</label>' +
        '<input id="ws-cfg-' + k + '" class="ipt mk-num" type="number" step="' + (step || '1') + '" value="' + (SC[k] != null ? SC[k] : '') + '"></span>' +
        '<span class="hint">' + esc(hint || ('默认 ' + DEF[k])) + '</span>';
    };
    body.innerHTML =
      '<h3 style="margin-top:0">🎯 熔炼成功率</h3>' +
      '<div class="mgr-row" style="flex-wrap:wrap;gap:8px">' +
      F('baseRate', '基础成功率 %', '默认 50') +
      F('failPerMaterial', '每份材料对失败率的影响', '负数 = 投料越多越不易失败（默认 -2）', '0.1') +
      F('rateMin', '成功率下限', '默认 5') + F('rateMax', '成功率上限', '默认 99') +
      '</div>' +
      '<h3>✨ 补缀（新增词缀）成功率</h3>' +
      '<div class="mgr-row" style="flex-wrap:wrap;gap:8px">' +
      F('extraRatePerMaterial', '每份材料加成 %', '默认 8', '0.1') +
      F('extraRatePearl', '龙宫宝珠加成 %', '默认 0', '0.1') +
      F('extraRateMax', '补缀成功率上限', '默认 95') +
      '</div>' +
      '<h3>💰 金币花费</h3>' +
      '<div class="mgr-row" style="flex-wrap:wrap;gap:8px">' +
      F('goldBase', '基础花费', '默认 5000') +
      F('goldPerMaterial', '每份材料花费', '默认 900') +
      F('goldPearl', '龙宫宝珠花费', '默认 20000') +
      '</div>' +
      '<h3>📦 投料上限</h3>' +
      '<div class="mgr-row" style="flex-wrap:wrap;gap:8px">' +
      F('maxMaterials', '单次最多投料份数', '默认 20') +
      F('maxTypes', '单次最多投料种类', '默认 4') +
      '<span class="ch-fix"><label>龙宫宝珠边界取值</label><input type="checkbox" id="ws-cfg-pearlRollTwice"' +
      (SC.pearlRollTwice !== false ? ' checked' : '') + '></span>' +
      '<span class="hint">勾选 = 投入龙宫宝珠时每个词条 roll 两次、取靠近区间边界的那次</span>' +
      '</div>' +
      '<h3>♻ 重铸（宝匣神话件重 roll 词条数值）</h3>' +
      '<div class="mgr-row" style="flex-wrap:wrap;gap:8px">' +
      F('recastRelic', '每次消耗残片', '默认 10（材料目前只有沉船宝匣残片）') +
      F('recastGold', '每次消耗金币', '默认 0（只收残片）') +
      '<span class="ch-fix"><label>至少不比原来差</label><input type="checkbox" id="ws-cfg-recastMinValue"' +
      (SC.recastMinValue ? ' checked' : '') + '></span>' +
      '<span class="hint">勾选 = 重铸时每条词条取新旧里更好的那个（不会把好数值洗坏）</span>' +
      '</div>' +
      '<div class="mgr-row" style="margin-top:10px"><button class="btn primary" id="ws-cfg-save">保存熔炼参数</button>' +
      '<button class="btn" id="ws-cfg-reset">恢复默认</button><span id="ws-cfg-state" class="hint" style="margin-left:10px"></span></div>' +
      '<h3>🧵 材料 → 词缀对照（只读）</h3>' +
      '<div class="hint" style="margin-bottom:6px">投料份数最多的那种材料决定熔炼后补的词缀；龙宫宝珠是催化剂（不指向词缀）。</div>' +
      '<div class="ch-ar-wrap">' + mats.map(function (m) {
        return '<span class="ch-fix"><label class="hint">' + esc(m.name) + '</label><span class="tag">' + esc(m.affixName) + '</span>' +
          '<span class="hint">(' + esc(m.rarity) + ')</span></span>';
      }).join('') +
      '<span class="ch-fix"><label class="hint">' + esc((cfg.smeltPearl || {}).name || '龙宫宝珠') + '</label><span class="tag">催化剂</span></span></div>';

    $('ws-cfg-save').onclick = function () {
      adminApi('POST', '/api/admin/smelt/config', {
        token: token,
        baseRate: $('ws-cfg-baseRate').value,
        failPerMaterial: $('ws-cfg-failPerMaterial').value,
        rateMin: $('ws-cfg-rateMin').value,
        rateMax: $('ws-cfg-rateMax').value,
        extraRatePerMaterial: $('ws-cfg-extraRatePerMaterial').value,
        extraRatePearl: $('ws-cfg-extraRatePearl').value,
        extraRateMax: $('ws-cfg-extraRateMax').value,
        goldBase: $('ws-cfg-goldBase').value,
        goldPerMaterial: $('ws-cfg-goldPerMaterial').value,
        goldPearl: $('ws-cfg-goldPearl').value,
        maxMaterials: $('ws-cfg-maxMaterials').value,
        maxTypes: $('ws-cfg-maxTypes').value,
        pearlRollTwice: $('ws-cfg-pearlRollTwice').checked,
        recastRelic: $('ws-cfg-recastRelic').value,
        recastGold: $('ws-cfg-recastGold').value,
        recastMinValue: $('ws-cfg-recastMinValue').checked,
      }).then(function (r) {
        if (!r.ok) { toast((r.data && r.data.error) || '保存失败', true); return; }
        worldCfg = null;
        setHint('ws-cfg-state', '<span style="color:var(--ok)">已保存：基础成功率 ' + ((r.data.smeltCfg || {}).baseRate) + '%，立即生效</span>');
        toast('熔炼参数已保存');
      });
    };
    $('ws-cfg-reset').onclick = function () {
      adminApi('POST', '/api/admin/smelt/config', { token: token, reset: true }).then(function (r) {
        if (!r.ok) { toast((r.data && r.data.error) || '操作失败', true); return; }
        worldCfg = null;
        toast('已恢复默认熔炼参数');
        renderWorkshop();
      });
    };
  }

  // ================================
  // 纪录贴图（全场最大鱼图标的缩放 / 偏移）
  // ================================
  const RECORDS_PREVIEW_FISH = 'tuna';   // 预览用鱼（黄金枪鱼，体型大、贴图辨识度高）
  function recordsCssVars(scale, x, y) {
    // 前端 .rh-icon 的基准尺寸是 140×84，--rh-scale 是相对该基准的倍数（175% → 1.75）
    return '--rh-scale:' + (scale / 100).toFixed(4) + ';--rh-dx:' + x + 'px;--rh-dy:' + y + 'px';
  }
  function renderRecords() {
    stopUpdateTimer();
    const main = $('main');
    main.innerHTML = '<h2>🏆 纪录贴图</h2>' +
      '<div class="hint" style="margin-bottom:12px">玩家端「渔获记录」页顶部「全场最大」那张大贴图：可调缩放（50 ~ 500%）与 xy 偏移（像素）。' +
      '保存后立即对全服生效（在线玩家的纪录页会即时重绘）。</div>' +
      '<div id="rc-body" class="panel">加载中…</div>';
    loadWorldCfg(true).then(function (cfg) {
      if (!cfg || view !== 'records') return;
      drawRecords(cfg);
    });
  }
  function drawRecords(cfg) {
    const body = $('rc-body');
    if (!body) return;
    const C = cfg.recordsCfg || { scale: 175, x: 0, y: 0 };
    const DEF = cfg.recordsDefaults || { scale: 175, x: 0, y: 0 };
    const L = cfg.recordsLimits || { scaleMin: 50, scaleMax: 500, offsetMin: -400, offsetMax: 400 };
    body.innerHTML =
      '<div class="mgr-row" style="flex-wrap:wrap;gap:8px">' +
      '<span class="ch-fix"><label>缩放 %</label>' +
      '<input id="rc-scale" class="ipt mk-num" type="range" min="' + L.scaleMin + '" max="' + L.scaleMax + '" step="5" value="' + C.scale + '" style="width:220px">' +
      '<input id="rc-scale-num" class="ipt mk-num" type="number" min="' + L.scaleMin + '" max="' + L.scaleMax + '" step="5" value="' + C.scale + '"></span>' +
      '<span class="ch-fix"><label>横向偏移</label><input id="rc-x" class="ipt mk-num" type="number" min="' + L.offsetMin + '" max="' + L.offsetMax + '" step="1" value="' + C.x + '"><span class="hint">px</span></span>' +
      '<span class="ch-fix"><label>纵向偏移</label><input id="rc-y" class="ipt mk-num" type="number" min="' + L.offsetMin + '" max="' + L.offsetMax + '" step="1" value="' + C.y + '"><span class="hint">px</span></span>' +
      '</div>' +
      '<div class="mgr-row"><button class="btn primary" id="rc-save">保存贴图设置</button>' +
      '<button class="btn" id="rc-reset">恢复默认（175% / 0,0）</button>' +
      '<span id="rc-state" class="hint" style="margin-left:10px">默认 ' + DEF.scale + '% · ' + DEF.x + ',' + DEF.y + '</span></div>' +
      '<h3>预览</h3>' +
      '<div class="gd-removed" style="text-align:center">' +
      '<div class="rc-preview-wrap"><img id="rc-preview" class="rh-icon" src="assets/fish/' + RECORDS_PREVIEW_FISH + '.png" alt="" draggable="false"></div>' +
      '<div class="hint" id="rc-preview-txt"></div></div>';

    const sync = function () {
      const sc = Math.round(Number($('rc-scale-num').value) || DEF.scale);
      const x = Math.round(Number($('rc-x').value) || 0);
      const y = Math.round(Number($('rc-y').value) || 0);
      const img = $('rc-preview');
      if (img) img.setAttribute('style', recordsCssVars(sc, x, y));
      const txt = $('rc-preview-txt');
      if (txt) txt.textContent = '缩放 ' + sc + '% · 偏移 ' + x + ', ' + y +
        ' · 实际尺寸 ' + Math.round(140 * sc / 100) + '×' + Math.round(84 * sc / 100) + 'px';
      return { scale: sc, x: x, y: y };
    };
    $('rc-scale').oninput = function () { $('rc-scale-num').value = this.value; sync(); };
    $('rc-scale-num').oninput = function () { $('rc-scale').value = this.value; sync(); };
    $('rc-x').oninput = sync;
    $('rc-y').oninput = sync;
    $('rc-save').onclick = function () {
      const v = sync();
      adminApi('POST', '/api/admin/records/config', { token: token, scale: v.scale, x: v.x, y: v.y }).then(function (r) {
        if (!r.ok) { toast((r.data && r.data.error) || '保存失败', true); return; }
        worldCfg = null;
        setHint('rc-state', '<span style="color:var(--ok)">已保存：缩放 ' + r.data.recordsCfg.scale + '% · 偏移 ' +
          r.data.recordsCfg.x + ',' + r.data.recordsCfg.y + '（玩家端即时生效）</span>');
        toast('纪录贴图设置已保存');
      });
    };
    $('rc-reset').onclick = function () {
      adminApi('POST', '/api/admin/records/config', { token: token, reset: true }).then(function (r) {
        if (!r.ok) { toast((r.data && r.data.error) || '操作失败', true); return; }
        worldCfg = null;
        toast('已恢复默认贴图设置');
        renderRecords();
      });
    };
    sync();
  }

  // ================================
  // 版本更新（优雅热更）
  // ================================
  // 流程：选一个「新版本启动用的 run.bat」→ 全服播报 60 秒更新通知横幅 → 横幅结束 5 秒后
  //       服务器启动新版本并关闭当前版本。倒计时期间可取消（横幅立刻撤回）。
  let updateTimer = null;
  function stopUpdateTimer() { if (updateTimer) { clearInterval(updateTimer); updateTimer = null; } }
  function renderUpdate() {
    stopUpdateTimer();
    const main = $('main');
    main.innerHTML = '<h2>🔄 版本更新</h2>' +
      '<div class="hint" style="margin-bottom:12px">选择新版本要运行的 <code>.bat</code> 启动脚本并发布更新：' +
      '全服会先看到 <b>60 秒</b>更新通知横幅（带倒计时），横幅结束后 <b>5 秒</b>服务器启动新版本并关闭当前版本。' +
      '玩家页面在服务器重启后会自动重连，无需手动刷新。</div>' +
      '<div id="up-body" class="panel">加载中…</div>';
    loadWorldCfg(true).then(function () {
      if (view !== 'update') return;
      adminApi('GET', '/api/admin/update/list?token=' + encodeURIComponent(token)).then(function (r) {
        if (view !== 'update') return;
        if (!r.ok) { $('up-body').textContent = (r.data && r.data.error) || '读取失败'; return; }
        drawUpdate(r.data);
      });
    });
  }
  function drawUpdate(d) {
    const body = $('up-body');
    if (!body) return;
    const bats = d.bats || [];
    const bannerSec = Math.round((d.bannerMs || 60000) / 1000);
    body.innerHTML =
      '<h3 style="margin-top:0">📄 启动脚本（项目目录：' + esc(d.root || '') + '）</h3>' +
      (bats.length
        ? '<div class="mgr-row" style="flex-wrap:wrap"><span class="ch-fix"><label>新版本 .bat</label>' +
          '<select id="up-bat" class="ipt" style="min-width:320px">' +
          bats.map(function (b) { return '<option value="' + esc(b.path) + '">' + esc(b.path) + '</option>'; }).join('') +
          '</select></span>' +
          '<span class="ch-fix"><label>备注（可选）</label><input id="up-note" class="ipt" maxlength="120" placeholder="如：v0.11.1 修复公告" style="min-width:220px"></span></div>' +
          '<div class="mgr-row"><button class="btn primary" id="up-start">发布更新（通知 ' + bannerSec + ' 秒后切换）</button>' +
          '<button class="btn" id="up-cancel" style="margin-left:8px">取消更新</button>' +
          '<span id="up-state" class="hint" style="margin-left:10px"></span></div>' +
          '<div class="hint" style="margin-top:6px">脚本路径必须是项目目录内的 .bat。' +
          '把新版本解压到 <code>releases/版本号/</code> 后，下拉里会直接出现它的 <code>run.bat</code>。</div>'
        : '<div class="hint">项目目录里没有找到任何 .bat 启动脚本（可把新版本放到 <code>releases/版本号/run.bat</code>）。</div>') +
      '<div id="up-live" style="margin-top:12px"></div>';
    if ($('up-start')) $('up-start').onclick = function () { startUpdate(false); };
    if ($('up-cancel')) $('up-cancel').onclick = function () { cancelUpdate(); };
    drawUpdateLive(d.current);
    // 常驻轮询：本页停留期间每 2 秒同步一次任务状态。
    // 不这样做的话，「打开页面时没有任务、之后由另一个人发布」就永远看不到倒计时；
    // 离开本页由 switchView 的 stopUpdateTimer 收尾。
    updateTimer = setInterval(function () {
      if (view !== 'update') { stopUpdateTimer(); return; }
      adminApi('GET', '/api/admin/update/list?token=' + encodeURIComponent(token)).then(function (r) {
        if (view !== 'update' || !r.ok) return;
        drawUpdateLive(r.data.current);
      });
    }, 2000);
  }
  function drawUpdateLive(cur) {
    const host = $('up-live');
    if (!host) return;   // 页面可能已切走：元素不在就什么都不做（切回来会重新拉取）
    if (!cur || !cur.active) { host.innerHTML = '<div class="hint">当前没有进行中的更新任务。</div>'; return; }
    const left = Math.max(0, Math.round((cur.endAt - Date.now()) / 1000));
    const fire = Math.max(0, Math.round((cur.fireAt - Date.now()) / 1000));
    const phase = cur.phase === 'restarting' ? '正在切换（启动新版本 + 关闭当前版本）'
      : cur.phase === 'grace' ? '通知已结束，即将切换' : '通知横幅播报中';
    host.innerHTML = '<div class="gd-removed"><b>进行中：' + esc(phase) + '</b><br/>' +
      '脚本：<code>' + esc(cur.bat) + '</code>' + (cur.note ? '（' + esc(cur.note) + '）' : '') + '<br/>' +
      '通知剩余 <b>' + left + '</b> 秒 · 距切换 <b>' + fire + '</b> 秒' +
      (cur.dryRun ? '<br/><span class="hint">（演练模式：到点也不会真的拉起新版本 / 退出进程）</span>' : '') +
      '</div>';
  }
  function startUpdate(dryRun) {
    const bat = $('up-bat') ? $('up-bat').value : '';
    if (!bat) { toast('请选择启动脚本', true); return; }
    const note = $('up-note') ? $('up-note').value.trim() : '';
    confirmModalLocal('发布更新并切换到「' + bat + '」？\n\n全服会立刻出现 60 秒更新通知横幅，横幅结束后 5 秒服务器启动新版本并关闭当前版本。' +
      (dryRun ? '\n\n（演练模式：不会真的切换）' : '')).then(function (ok) {
      if (!ok) return;
      adminApi('POST', '/api/admin/update/start', { token: token, bat: bat, note: note, dryRun: !!dryRun }).then(function (r) {
        if (!r.ok) { toast((r.data && r.data.error) || '发布失败', true); return; }
        toast('已发布更新通知，' + Math.round(((r.data.update || {}).bannerMs || 60000) / 1000) + ' 秒后自动切换');
        renderUpdate();
      });
    });
  }
  function cancelUpdate() {
    adminApi('POST', '/api/admin/update/cancel', { token: token }).then(function (r) {
      if (!r.ok) { toast((r.data && r.data.error) || '取消失败', true); return; }
      toast('已取消更新，横幅已撤回');
      renderUpdate();
    });
  }

  function renderFormula() {
    const main = $('main');
    main.innerHTML = '<h2>🧮 公式管理</h2>' +
      '<div class="hint" style="margin-bottom:12px">集中管理上钩概率公式与双钓率。修改保存后对全服立即生效。</div>' +
      '<div class="formula-box">' +
      '<div class="panel">' +
      '<h3>公式</h3>' +
      '<textarea id="fx-src" class="ipt" spellcheck="false"></textarea>' +
      '<div class="editor-foot"><button id="fx-check" class="btn">校验</button><button id="fx-save" class="btn primary">保存公式</button><span id="fx-state"></span></div>' +
      '<h3>试算（用下面的变量值求概率）</h3>' +
      '<div class="eval-grid" id="fx-vars">' +
      BITE_VARS_DOC.map(function (v) {
        return '<div><label>' + v[0] + '</label><input class="ipt" id="fxv-' + v[0] + '" type="number" value="0"></div>';
      }).join('') +
      '</div>' +
      '<button id="fx-eval" class="btn mini">试算概率</button>' +
      '<div id="fx-prob" class="prob-out"></div>' +
      '</div>' +
      '<div class="panel"><h3>可用变量</h3>' +
      '<div class="hint" style="margin-bottom:8px">变量值 = 该玩家当前生效的加成（钓竿词缀 + 钓点增益）。' +
      '<b><code>skill</code> 是 v0.11 新增的「技巧」词缀变量</b>——钓竿上的「技巧」词缀全部计入它，' +
      '默认公式 <code>clamp(90 + skill, 0, 100)</code> 就是靠它提升上钩率（代码里不写死钩率提示，一切以本页公式为准）。</div>' +
      '<div class="kv">' +
      BITE_VARS_DOC.map(function (v) { return '<code>' + v[0] + '</code> — ' + v[1] + '<br>'; }).join('') +
      '</div><h3>可用函数</h3><div class="kv"><code>min</code> <code>max</code> <code>floor</code> <code>ceil</code> <code>round</code> <code>abs</code> <code>clamp(x, lo, hi)</code><br>' +
      '示例：<code>clamp(90 + skill, 0, 100)</code>（默认：基础 90% + 技巧词缀） ／ <code>90</code>（平值 90% 上钩） ／ ' +
      '<code>clamp(85 + rare + skill * 0.5, 50, 100)</code>（稀有与技巧各占一部分）</div></div>' +
      '<div class="panel" style="flex:1 1 100%;min-width:0">' +
      '<h3>🎣 双钓率</h3>' +
      '<div class="hint" style="margin-bottom:10px">叠加值 A（百分比点数）→ 单次追加概率 <code>P = A/(A+100) = 1 − 1/(1+A/100)</code>。' +
      '基础上钩 1 条；掷 &lt; P 成功追加 +1，再掷 &lt; P 成功再 +1，最多 3 条。分布 1−P / P(1−P) / P²，期望 1+P+P²。' +
      '若配置基础双钓率 B，最终概率 <code>1 − (1−B)(1−P)</code>。</div>' +
      '<div class="pool-row"><label style="width:150px;color:var(--txt-dim);font-size:13px">基础双钓率 B</label>' +
      '<input id="db-base" class="ipt" type="number" min="0" max="100" step="1" style="width:110px" />' +
      '<span class="hint">%</span>' +
      '<button id="db-save" class="btn primary">保存</button><span id="db-state" class="hint"></span></div>' +
      '<div id="db-preview" class="hint"></div></div>' +
      '<div class="panel" style="flex:1 1 100%;min-width:0">' +
      '<h3>🎣 抛竿间隔与全服钓速</h3>' +
      '<div class="hint" style="margin-bottom:10px">服务端每隔该间隔自动抛一竿。<b>钓速只影响抛竿间隔</b>：间隔 = 基础 × (1 − 有效钓速/100)，不低于最短间隔；' +
      '有效钓速 = 钓竿词缀 + 钓点增益 + <b>全服钓速加成</b>，并按<b>钓速上限</b>截断。上钩率由上方公式单独决定（默认平值 90%）。' +
      '保存后正在钓鱼的玩家循环会立即按新间隔重启。</div>' +
      '<div class="pool-row"><label style="width:150px;color:var(--txt-dim);font-size:13px">基础间隔</label>' +
      '<input id="cast-base" class="ipt" type="number" min="200" max="60000" step="100" style="width:110px" />' +
      '<span class="hint">ms（默认 3000）</span>' +
      '<label style="width:110px;color:var(--txt-dim);font-size:13px;margin-left:12px">最短间隔</label>' +
      '<input id="cast-min" class="ipt" type="number" min="100" max="60000" step="100" style="width:110px" />' +
      '<span class="hint">ms（默认 800）</span></div>' +
      '<div class="pool-row"><label style="width:150px;color:var(--txt-dim);font-size:13px">全服钓速加成</label>' +
      '<input id="cast-bonus" class="ipt" type="number" min="-100" max="500" step="5" style="width:110px" />' +
      '<span class="hint">%（加到每位玩家的有效钓速上，默认 0）</span>' +
      '<label style="width:110px;color:var(--txt-dim);font-size:13px;margin-left:12px">钓速上限</label>' +
      '<input id="cast-cap" class="ipt" type="number" min="0" max="100" step="5" style="width:110px" />' +
      '<span class="hint">%（默认 80）</span>' +
      '<button id="cast-save" class="btn primary" style="margin-left:12px">保存</button><span id="cast-state" class="hint"></span>' +
      '<button id="cast-reset" class="btn mini" style="margin-left:8px">恢复默认</button></div>' +
      '<div id="cast-preview" class="hint"></div></div>' +
      '</div>';
    loadWorldCfg().then(function (cfg) {
      if (!cfg || view !== 'formula') return;
      $('fx-src').value = cfg.biteFormula || '';
      const dbInp = $('db-base');
      dbInp.value = Math.round((cfg.doubleBase || 0) * 100);
      function preview() {
        const b = Math.max(0, Math.min(1, (Number(dbInp.value) || 0) / 100));
        const A = 50;
        let p = A / (A + 100);
        if (b > 0) p = 1 - (1 - b) * (1 - p);
        $('db-preview').innerHTML = '示例：叠加值 A=50 时，双钓概率 <b>' + (p * 100).toFixed(1) + '%</b>（期望上钩 ' + (1 + p + p * p).toFixed(2) + ' 条）';
      }
      dbInp.addEventListener('input', preview);
      preview();
      $('db-save').onclick = function () {
        const b = Math.max(0, Math.min(100, Number(dbInp.value) || 0)) / 100;
        adminApi('POST', '/api/admin/settings', { token: token, doubleBase: b }).then(function (r) {
          if (!r.ok) { $('db-state').innerHTML = '<span class="err">' + esc(r.data.error || '保存失败') + '</span>'; return; }
          if (worldCfg) worldCfg.doubleBase = r.data.doubleBase;
          $('db-state').innerHTML = '<span style="color:var(--ok)">已保存，立即生效</span>';
          toast('基础双钓率已保存');
        });
      };
      // 抛竿间隔 + 全服钓速（基础值 / 最短值 / 全服加成 / 上限）；保存后服务器广播并重启在线循环
      const cbInp = $('cast-base'), cmInp = $('cast-min'), cboInp = $('cast-bonus'), ccpInp = $('cast-cap');
      const cdft = cfg.castDefaults || { baseMs: 3000, minMs: 800, speedBonus: 0, speedCap: 80 };
      cbInp.value = cfg.castBaseMs != null ? cfg.castBaseMs : cdft.baseMs;
      cmInp.value = cfg.castMinMs != null ? cfg.castMinMs : cdft.minMs;
      cboInp.value = cfg.castSpeedBonus != null ? cfg.castSpeedBonus : cdft.speedBonus;
      ccpInp.value = cfg.castSpeedCap != null ? cfg.castSpeedCap : cdft.speedCap;
      function castPreview() {
        const base = Number(cbInp.value) || 0, min = Number(cmInp.value) || 0;
        const bonus = Number(cboInp.value) || 0, cap = Number(ccpInp.value) || 0;
        const samples = [0, 20, 45, 60, 80].map(function (sp) {
          const eff = Math.max(0, Math.min(cap, sp + bonus));
          const ms = Math.max(min, Math.round(base * (1 - eff / 100)));
          return '玩家钓速 ' + sp + '%→有效 ' + Math.round(eff) + '%→' + (ms / 1000).toFixed(2) + 's';
        }).join('　');
        $('cast-preview').innerHTML = '实际间隔预览：' + samples;
      }
      [cbInp, cmInp, cboInp, ccpInp].forEach(function (n) { n.addEventListener('input', castPreview); });
      castPreview();
      $('cast-save').onclick = function () {
        const body = {
          token: token,
          castBaseMs: Number(cbInp.value), castMinMs: Number(cmInp.value),
          castSpeedBonus: Number(cboInp.value), castSpeedCap: Number(ccpInp.value),
        };
        adminApi('POST', '/api/admin/settings', body).then(function (r) {
          if (!r.ok) { $('cast-state').innerHTML = '<span class="err">' + esc(r.data.error || '保存失败') + '</span>'; return; }
          $('cast-base').value = r.data.castBaseMs; $('cast-min').value = r.data.castMinMs;
          $('cast-bonus').value = r.data.castSpeedBonus; $('cast-cap').value = r.data.castSpeedCap;
          castPreview();
          $('cast-state').innerHTML = '<span style="color:var(--ok)">已保存，在线玩家循环已按新间隔重启</span>';
          toast('抛竿间隔与钓速已保存');
        });
      };
      $('cast-reset').onclick = function () {
        adminApi('POST', '/api/admin/settings', { token: token, castBaseMs: cdft.baseMs, castMinMs: cdft.minMs, resetCastSpeed: true }).then(function (r) {
          if (!r.ok) { $('cast-state').innerHTML = '<span class="err">' + esc(r.data.error || '重置失败') + '</span>'; return; }
          $('cast-base').value = r.data.castBaseMs; $('cast-min').value = r.data.castMinMs;
          $('cast-bonus').value = r.data.castSpeedBonus; $('cast-cap').value = r.data.castSpeedCap;
          castPreview();
          $('cast-state').innerHTML = '<span style="color:var(--ok)">已恢复默认</span>';
          toast('已恢复默认抛竿间隔与钓速');
        });
      };
    });
    $('fx-check').onclick = function () { saveFormula(true); };
    $('fx-save').onclick = function () { saveFormula(false); };
    $('fx-eval').onclick = function () {
      const vars = {};
      BITE_VARS_DOC.forEach(function (v) { vars[v[0]] = Number($('fxv-' + v[0]).value) || 0; });
      adminApi('POST', '/api/admin/settings', { token: token, biteFormula: $('fx-src').value, validateOnly: true, evalVars: vars }).then(function (r) {
        if (!r.ok) { $('fx-prob').textContent = ''; $('fx-state').innerHTML = '<span class="err">' + esc(r.data.error || '校验失败') + '</span>'; return; }
        $('fx-prob').textContent = '≈ ' + r.data.prob + '%';
        $('fx-state').innerHTML = '<span style="color:var(--ok)">公式有效</span>';
      });
    };
  }
  function saveFormula(validateOnly) {
    const src = $('fx-src').value;
    const body = { token: token, biteFormula: src };
    if (validateOnly) body.validateOnly = true;
    adminApi('POST', '/api/admin/settings', body).then(function (r) {
      const st = $('fx-state');
      if (!r.ok) { st.innerHTML = '<span class="err">' + esc(r.data.error || '保存失败') + '</span>'; return; }
      if (worldCfg) worldCfg.biteFormula = r.data.biteFormula;
      st.innerHTML = validateOnly ? '<span style="color:var(--ok)">公式有效，可以保存</span>' : '<span style="color:var(--ok)">已保存，立即生效</span>';
      if (!validateOnly) toast('上钩公式已保存');
    });
  }

  // ================================
  // 通知等级
  // ================================
  const NOTIFY_HINT = {
    all: '所有玩家的每次渔获都会进入全服动态。',
    uncommon: '普通鱼与材料不再刷屏，只有大鱼、稀有鱼和组件掉落进入动态。',
    offrange: '只有体型超出该鱼基准 [最小,最大] 范围的捕获进入动态（钓竿体型加成钓出的超大鱼）。',
    records: '只有打破全服最大 / 最小纪录时才进入动态。',
    none: '完全关闭全服渔获动态（钓者自己仍能看到自己的渔获）。',
  };
  function renderNotify() {
    const main = $('main');
    main.innerHTML = '<h2>🔔 全服动态通知等级</h2>' +
      '<div class="hint" style="margin-bottom:12px">控制全服动态（钓鱼页滚动条）推送哪些渔获。钓者本人的渔获推送不受影响。</div>' +
      '<div id="nt-body" class="panel">加载中…</div>';
    loadWorldCfg(true).then(function (cfg) {
      if (!cfg || view !== 'notify') return;
      drawNotify(cfg);
    });
  }
  function drawNotify(cfg) {
    const body = $('nt-body');
    body.innerHTML = Object.keys(cfg.notifyLevels).map(function (k) {
      return '<label class="radio-card' + (cfg.notifyLevel === k ? ' sel' : '') + '" data-lv="' + k + '">' +
        '<input type="radio" name="ntlv" value="' + k + '"' + (cfg.notifyLevel === k ? ' checked' : '') + '>' +
        '<div><b>' + esc(k) + ' — ' + esc(cfg.notifyLevels[k]) + '</b><span>' + esc(NOTIFY_HINT[k] || '') + '</span></div>' +
        '</label>';
    }).join('') +
      '<div class="editor-foot"><button id="nt-save" class="btn primary">保存通知等级</button><span id="nt-state" class="hint"></span></div>';
    body.querySelectorAll('.radio-card').forEach(function (c) {
      c.onclick = function () {
        body.querySelectorAll('.radio-card').forEach(function (x) { x.classList.remove('sel'); });
        c.classList.add('sel');
        c.querySelector('input').checked = true;
      };
    });
    $('nt-save').onclick = function () {
      const sel = body.querySelector('input[name=ntlv]:checked');
      if (!sel) return;
      adminApi('POST', '/api/admin/settings', { token: token, notifyLevel: sel.value }).then(function (r) {
        if (!r.ok) { $('nt-state').innerHTML = '<span class="err">' + esc(r.data.error || '保存失败') + '</span>'; return; }
        if (worldCfg) worldCfg.notifyLevel = r.data.notifyLevel;
        $('nt-state').innerHTML = '<span style="color:var(--ok)">已保存，立即生效</span>';
        toast('通知等级已保存：' + sel.value);
      });
    };
  }

  // ================================
  // 组件生成配置（品质概率 / 词条数概率 / roll 模型 / 数值区间 / 修饰词规则）
  // ================================
  let compCfg = null;
  function renderComponent() {
    const main = $('main');
    main.innerHTML = '<h2>🧩 组件生成配置</h2>' +
      '<div class="hint" style="margin-bottom:12px">控制组件掉落的品质概率、词条数量概率、数值 roll 模型、各底材词缀数值范围，以及修饰词组合规则。保存后对全服即时生效。</div>' +
      '<div id="comp-body" class="panel">加载中…</div>';
    loadWorldCfg(true).then(function (cfg) {
      if (!cfg || view !== 'component') return;
      compCfg = cfg.componentCfg || {};
      drawComponent();
    });
  }
  function drawComponent() {
    const cfg = compCfg || {};
    const qw = cfg.qualityWeights || {};
    const cw = cfg.countWeights || {};
    const ranges = cfg.affixRanges || {};
    const rules = cfg.adjectiveRules || [];
    const bases = (worldCfg && worldCfg.catalog && worldCfg.catalog.components) || [];
    const qKeys = ['common', 'rare', 'epic'];
    const qName = { common: '普通', rare: '稀有', epic: '史诗' };
    const body = $('comp-body');
    body.innerHTML =
      '<h3>品质掉落概率（相对权重）</h3>' +
      '<div class="cmp-row">' + qKeys.map(function (k) {
        return '<label class="cmp-cell">' + qName[k] + ' <input class="ipt" type="number" min="0" step="0.01" id="qw-' + k + '" value="' + (qw[k] != null ? qw[k] : 0) + '"></label>';
      }).join('') + '</div>' +
      '<h3>词条数量概率（权重：1 条 / 2 条 / 3 条）</h3>' +
      '<div class="cmp-row">' + qKeys.map(function (k) {
        const arr = cw[k] || [];
        return '<label class="cmp-cell">' + qName[k] + ' <span class="cmp-3">' +
          [0, 1, 2].map(function (i) { return '<input class="ipt" type="number" min="0" step="0.01" id="cw-' + k + '-' + i + '" value="' + (arr[i] != null ? arr[i] : '') + '" placeholder="0">'; }).join('') +
          '</span></label>';
      }).join('') + '</div>' +
      '<h3>数值 roll 模型</h3>' +
      '<div class="cmp-row"><label class="radio-card' + ((cfg.rollModel || 'linear') === 'linear' ? ' sel' : '') + '" data-rm="linear"><input type="radio" name="rm" value="linear"' + ((cfg.rollModel || 'linear') === 'linear' ? ' checked' : '') + '><div><b>线性（均匀）</b><span>区间内等概率取值</span></div></label>' +
      '<label class="radio-card' + (cfg.rollModel === 'normal' ? ' sel' : '') + '" data-rm="normal"><input type="radio" name="rm" value="normal"' + (cfg.rollModel === 'normal' ? ' checked' : '') + '><div><b>正态</b><span>靠近区间中值概率更高</span></div></label>' +
      '<label class="radio-card' + (cfg.rollModel === 'skew' ? ' sel' : '') + '" data-rm="skew"><input type="radio" name="rm" value="skew"' + (cfg.rollModel === 'skew' ? ' checked' : '') + '><div><b>偏态</b><span>偏向低值（更常见低 roll）</span></div></label></div>' +
      '<h3>修饰词规则（自上而下取第一条命中；留空字段表示不限制）</h3>' +
      '<div class="hint" style="margin-bottom:8px">条件：满词条 / 无负词条 / 净收益区间 / 词条数区间。例如「满词条+无负」→ 完美的。</div>' +
      '<div id="adj-rows">' + rules.map(adjRuleRow).join('') + '</div>' +
      '<button class="btn mini" id="adj-add">＋ 添加规则</button>' +
      '<h3 style="margin-top:20px">底材词缀数值范围</h3>' +
      '<div id="range-rows">' + bases.map(function (b) {
        const ov = ranges[b.id] || {};
        return '<div class="cmp-range"><div class="cmp-range-title">' + esc(b.name) + ' <span class="hint">' + esc(b.id) + '</span></div>' +
          b.pool.map(function (p) {
            const cur = ov[p.type] || [p.min, p.max];
            return '<span class="cmp-aff">' + esc(p.type) +
              ' <input class="ipt cmp-num" type="number" data-bid="' + esc(b.id) + '" data-t="' + esc(p.type) + '" data-i="0" value="' + cur[0] + '">' +
              ' ~ <input class="ipt cmp-num" type="number" data-bid="' + esc(b.id) + '" data-t="' + esc(p.type) + '" data-i="1" value="' + cur[1] + '">' +
              ' <span class="hint">默认 ' + p.min + '~' + p.max + '</span></span>';
          }).join('') + '</div>';
      }).join('') + '</div>' +
      '<div class="editor-foot" style="margin-top:18px">' +
      '<button class="btn primary" id="cmp-save">保存配置</button>' +
      '<button class="btn" id="cmp-sim">按当前配置试算 2 万次</button>' +
      '<button class="btn danger" id="cmp-reset">恢复默认</button>' +
      '<span id="cmp-state" class="hint"></span></div>' +
      '<div id="cmp-sim-out" class="hint" style="margin-top:10px"></div>';

    body.querySelectorAll('.radio-card[data-rm]').forEach(function (c) {
      c.onclick = function () {
        body.querySelectorAll('.radio-card[data-rm]').forEach(function (x) { x.classList.remove('sel'); });
        c.classList.add('sel'); c.querySelector('input').checked = true;
      };
    });
    function bindAdjRemove() {
      body.querySelectorAll('.adj-del').forEach(function (b) { b.onclick = function () { b.closest('.adj-row').remove(); }; });
    }
    body.querySelector('#adj-add').onclick = function () {
      const box = $('adj-rows'); const wrap = document.createElement('div'); wrap.innerHTML = adjRuleRow({ name: '' }); box.appendChild(wrap.firstChild); bindAdjRemove();
    };
    bindAdjRemove();
    $('cmp-save').onclick = saveComponent;
    $('cmp-reset').onclick = function () {
      adminApi('POST', '/api/admin/component/reset', { token: token }).then(function (r) {
        if (!r.ok) { toast(r.data.error || '重置失败', true); return; }
        toast('已恢复默认'); loadWorldCfg(true).then(function (cfg) { compCfg = cfg.componentCfg; drawComponent(); });
      });
    };
    $('cmp-sim').onclick = function () {
      adminApi('POST', '/api/admin/component/simulate', { token: token, n: 20000 }).then(function (r) {
        if (!r.ok) { $('cmp-sim-out').textContent = r.data.error || '试算失败'; return; }
        const d = r.data;
        const qp = Object.keys(d.quality).map(function (k) { return k + ' ' + (d.quality[k] / d.n * 100).toFixed(1) + '%'; }).join(' / ');
        $('cmp-sim-out').innerHTML = '品质分布：' + qp + '　|　' + Object.keys(d.affix).map(function (t) { return t + ' 均值 ' + d.affix[t].mean; }).join('，');
      });
    };
  }
  function adjRuleRow(r) {
    r = r || {};
    function chk(k, lab) { return '<label class="adj-chk"><input type="checkbox" data-f="' + k + '"' + (r[k] ? ' checked' : '') + '> ' + lab + '</label>'; }
    function num(k, ph) { return '<input class="ipt cmp-num" type="number" data-f="' + k + '" value="' + (r[k] != null ? r[k] : '') + '" placeholder="' + ph + '">'; }
    return '<div class="adj-row">' +
      '<input class="ipt adj-name" data-f="name" value="' + esc(r.name || '') + '" placeholder="修饰词（如 完美的）">' +
      chk('full', '满词条') + chk('noNeg', '无负词条') +
      '<span class="adj-num">净收益≥' + num('netMin', '不限') + '</span>' +
      '<span class="adj-num">≤' + num('netMax', '不限') + '</span>' +
      '<span class="adj-num">词条数≥' + num('minAffixes', '-') + '</span>' +
      '<span class="adj-num">≤' + num('maxAffixes', '-') + '</span>' +
      '<button class="btn mini danger adj-del">删除</button></div>';
  }
  function saveComponent() {
    const cbody = $('comp-body');
    const qw = {};
    ['common', 'rare', 'epic'].forEach(function (k) { const e2 = document.getElementById('qw-' + k); if (e2) qw[k] = Number(e2.value) || 0; });
    const cw = {};
    ['common', 'rare', 'epic'].forEach(function (k) {
      const arr = [0, 1, 2].map(function (i) { const e2 = document.getElementById('cw-' + k + '-' + i); return e2 && e2.value !== '' ? Number(e2.value) || 0 : 0; });
      if (arr.some(function (x) { return x > 0; })) cw[k] = arr;
    });
    const rmCard = cbody.querySelector('.radio-card[data-rm].sel');
    const rmInput = cbody.querySelector('input[name=rm]:checked');
    const rm = (rmCard && rmCard.getAttribute('data-rm')) || (rmInput && rmInput.value) || 'linear';
    const ranges = {};
    cbody.querySelectorAll('input[data-bid]').forEach(function (inp) {
      const bid = inp.getAttribute('data-bid'), t = inp.getAttribute('data-t'), i = Number(inp.getAttribute('data-i'));
      ranges[bid] = ranges[bid] || {}; ranges[bid][t] = ranges[bid][t] || [null, null];
      ranges[bid][t][i] = Number(inp.value);
    });
    Object.keys(ranges).forEach(function (bid) {
      const base = (worldCfg.catalog.components || []).find(function (b) { return b.id === bid; });
      Object.keys(ranges[bid]).forEach(function (t) {
        const r = ranges[bid][t];
        const def = base && base.pool.find(function (p) { return p.type === t; });
        if (!isFinite(r[0]) || !isFinite(r[1]) || r[1] < r[0] || (def && r[0] === def.min && r[1] === def.max)) delete ranges[bid][t];
      });
      if (!Object.keys(ranges[bid]).length) delete ranges[bid];
    });
    const rules = [];
    cbody.querySelectorAll('.adj-row').forEach(function (row) {
      const name = row.querySelector('.adj-name').value.trim();
      if (!name) return;
      const rule = { name: name };
      row.querySelectorAll('input[data-f]').forEach(function (inp) {
        const f = inp.getAttribute('data-f');
        if (f === 'name') return;
        if (inp.type === 'checkbox') { if (inp.checked) rule[f] = true; }
        else if (inp.value !== '') rule[f] = Number(inp.value);
      });
      rules.push(rule);
    });
    adminApi('POST', '/api/admin/component/config', { token: token, qualityWeights: qw, countWeights: cw, rollModel: rm, affixRanges: ranges, adjectiveRules: rules }).then(function (r) {
      if (!r.ok) { $('cmp-state').innerHTML = '<span class="err">' + esc(r.data.error || '保存失败') + '</span>'; return; }
      compCfg = r.data.componentCfg; worldCfg.componentCfg = compCfg;
      $('cmp-state').innerHTML = '<span style="color:var(--ok)">已保存，立即生效</span>';
      toast('组件生成配置已保存');
    });
  }

  // ================================
  // 鱼类体型（roll 模型 + 分布预览）
  // ================================
  // 体型 roll 模型存在 world.fishCfg.sizeModel，默认 normal(正态)。
  // 预览走服务端 /api/admin/fish/simulate 并带上当前点选的模型，因此
  // 尚未保存的选择也能先看效果；采样用的是与线上同一套 rollSizeOf。
  let fishCfg = null;
  const SIZE_MODEL_INFO = [
    { k: 'linear', name: '线性（均匀）', desc: '区间内等概率取值' },
    { k: 'normal', name: '正态', desc: '靠近区间中值概率更高（默认）' },
    { k: 'skew', name: '偏态', desc: '偏向小值（小鱼更常见）' },
  ];
  function renderFishSize() {
    const main = $('main');
    main.innerHTML = '<h2>🐟 鱼类体型</h2>' +
      '<div class="hint" style="margin-bottom:12px">控制上鱼体型在该鱼基准区间内的取值分布，影响所有渔获、大小鱼榜与图鉴体型。保存后对全服即时生效。</div>' +
      '<div id="fish-body" class="panel">加载中…</div>';
    loadWorldCfg(true).then(function (cfg) {
      if (!cfg || view !== 'fishsize') return;
      fishCfg = cfg.fishCfg || {};
      drawFishSize();
    });
  }
  function drawFishSize() {
    const cfg = fishCfg || {};
    const saved = SIZE_MODEL_INFO.some(function (m) { return m.k === cfg.sizeModel; }) ? cfg.sizeModel : 'normal';
    let pick = saved; // 试算用模型（可能尚未保存）
    const fishList = (worldCfg && worldCfg.catalog && worldCfg.catalog.fish) || [];
    const withSize = fishList.filter(function (f) { return f.size; });
    const body = $('fish-body');
    body.innerHTML =
      '<h3 style="margin-top:0">体型 roll 模型</h3>' +
      '<div class="hint" style="margin-bottom:8px">当前生效：<b>' + esc(modelName(saved)) + '</b></div>' +
      '<div class="cmp-row">' + SIZE_MODEL_INFO.map(function (m) {
        return '<label class="radio-card' + (m.k === pick ? ' sel' : '') + '" data-fm="' + m.k + '">' +
          '<input type="radio" name="fm" value="' + m.k + '"' + (m.k === pick ? ' checked' : '') + '>' +
          '<div><b>' + m.name + '</b><span>' + m.desc + '</span></div></label>';
      }).join('') + '</div>' +
      '<h3 style="margin-top:20px">分布预览</h3>' +
      '<div class="mgr-row">' +
      '<label class="hint">目标鱼</label>' +
      '<select class="ipt" id="fish-pick"><option value="">全部鱼种（归一化）</option>' +
      withSize.map(function (f) {
        return '<option value="' + esc(f.id) + '">' + esc(f.name) + '（基准 ' + f.size[0] + '~' + f.size[1] + ' cm）</option>';
      }).join('') + '</select>' +
      '<label class="hint">体型加成</label><input id="fish-bonus" class="ipt mk-num" type="number" step="5" value="0" style="width:80px" />' +
      '<span class="hint">%（模拟体型词缀，0 = 无加成）</span>' +
      '<button class="btn mini" id="fish-sim">刷新预览</button></div>' +
      '<div id="fish-chart" class="hint" style="margin-top:10px">…</div>' +
      '<div class="editor-foot" style="margin-top:18px">' +
      '<button class="btn primary" id="fish-save">保存配置</button>' +
      '<button class="btn danger" id="fish-reset">恢复默认（正态）</button>' +
      '<span id="fish-state" class="hint">' + (cfg.sizeModel ? '' : '（尚未保存过，线上按默认正态运行）') + '</span></div>';

    function modelName(k) {
      const m = SIZE_MODEL_INFO.find(function (x) { return x.k === k; });
      return m ? m.name : k;
    }
    function drawChart(data) {
      const chart = $('fish-chart');
      if (!chart) return;
      const bs = data.buckets || [];
      const max = Math.max.apply(null, bs.concat([1]));
      const bars = bs.map(function (v, i) {
        const pct = (v / max) * 100;
        const lo = Math.round((i / bs.length) * 100), hi = Math.round(((i + 1) / bs.length) * 100);
        return '<div title="' + lo + '~' + hi + '%：' + v + ' 次" style="flex:1;display:flex;flex-direction:column;justify-content:flex-end;height:90px;margin:0 1px">' +
          '<div style="height:' + pct.toFixed(1) + '%;background:linear-gradient(180deg,#38bdf8,#0ea5e9);border-radius:2px"></div></div>';
      }).join('');
      const axis = '<div class="hint" style="display:flex;justify-content:space-between"><span>基准下限</span><span>区间中值</span><span>基准上限</span></div>';
      const head = data.stats
        ? esc(data.fishName) + '（基准 ' + data.range[0] + '~' + data.range[1] + ' cm' + (data.sizeBonus ? '，体型 +' + data.sizeBonus + '%' : '') + '）：' +
          '中位数 ' + data.stats.p50 + ' cm · 均值 ' + data.stats.mean + ' cm · 25~75 分位 ' + data.stats.p25 + '~' + data.stats.p75 + ' cm'
        : '全鱼种 · 位置分布（' + data.n + ' 次采样，左小右大）';
      chart.innerHTML = '<div style="margin-bottom:6px">' + head + '</div>' +
        '<div style="display:flex;align-items:flex-end;gap:1px">' + bars + '</div>' + axis;
    }
    function runSim() {
      const chart = $('fish-chart');
      if (chart) chart.textContent = '采样中…';
      const sel = $('fish-pick');
      adminApi('POST', '/api/admin/fish/simulate', {
        token: token, n: 20000, model: pick,
        fishId: (sel && sel.value) || undefined,
        sizeBonus: Number(($('fish-bonus') || {}).value) || 0,
      }).then(function (r) {
        if (view !== 'fishsize' || !$('fish-chart')) return;
        if (!r.ok) { $('fish-chart').innerHTML = '<span class="err">' + esc(r.data.error || '试算失败') + '</span>'; return; }
        drawChart(r.data);
      });
    }
    body.querySelectorAll('.radio-card[data-fm]').forEach(function (c) {
      c.onclick = function () {
        body.querySelectorAll('.radio-card[data-fm]').forEach(function (x) { x.classList.remove('sel'); });
        c.classList.add('sel'); c.querySelector('input').checked = true;
        pick = c.getAttribute('data-fm');
        runSim();
      };
    });
    $('fish-sim').onclick = runSim;
    $('fish-pick').onchange = runSim;
    $('fish-save').onclick = function () {
      adminApi('POST', '/api/admin/fish/config', { token: token, sizeModel: pick }).then(function (r) {
        if (!r.ok) { $('fish-state').innerHTML = '<span class="err">' + esc(r.data.error || '保存失败') + '</span>'; return; }
        fishCfg = r.data.fishCfg; worldCfg.fishCfg = fishCfg;
        toast('鱼类体型模型已保存（' + modelName(fishCfg.sizeModel) + '）');
        drawFishSize();
      });
    };
    $('fish-reset').onclick = function () {
      adminApi('POST', '/api/admin/fish/reset', { token: token }).then(function (r) {
        if (!r.ok) { $('fish-state').innerHTML = '<span class="err">' + esc(r.data.error || '恢复失败') + '</span>'; return; }
        fishCfg = r.data.fishCfg; worldCfg.fishCfg = fishCfg;
        toast('已恢复默认（正态）');
        drawFishSize();
      });
    };
    runSim();
  }

  // ================================
  // 💰 经济参数（价格模型全程可调 + 产出倍率 + 品质层覆盖 + 单品干预）
  // ================================
  let ecoSearch = '';       // 单品列表搜索（模块级：重绘间保留）
  const ECO_PRESETS = [
    { k: 'std', name: '保守（现状）', desc: '1 小时回升 · 每件 -0.75%', cfg: { floorPct: 40, ceilPct: 200, saleDivisor: 0.0075, riseTauMin: 60, riseTargetPct: 200, sampleSec: 60, historyMin: 360 } },
    { k: 'fast', name: '推荐（15 分钟）', desc: '回升快 4 倍 · 容量 ×4', cfg: { floorPct: 40, ceilPct: 200, saleDivisor: 0.0075, riseTauMin: 15, riseTargetPct: 200, sampleSec: 60, historyMin: 360 } },
    { k: 'event', name: '活动（10 分钟）', desc: '活跃行情 · 适合在线高峰', cfg: { floorPct: 40, ceilPct: 200, saleDivisor: 0.0075, riseTauMin: 10, riseTargetPct: 200, sampleSec: 30, historyMin: 360 } },
    { k: 'tight', name: '紧缩（重税）', desc: '每件 -2% · 30 分钟回升 · 抑制肝度', cfg: { floorPct: 40, ceilPct: 200, saleDivisor: 0.02, riseTauMin: 30, riseTargetPct: 200, sampleSec: 60, historyMin: 360 } },
  ];
  function renderEconomy() {
    const main = $('main');
    main.innerHTML = '<h2>💰 经济参数</h2>' +
      '<div class="hint" style="margin-bottom:12px">系统商店价格模型与产出倍率的全程可调参数。保存后即时生效：玩家端商店文案、图鉴/钓点概率自动同步；「采样间隔」改动会重挂服务器采样定时器。</div>' +
      '<div id="eco-body" class="panel">加载中…</div>';
    loadWorldCfg(true).then(function (cfg) {
      if (!cfg || view !== 'economy') return;
      drawEconomy(cfg);
    });
  }
  // 从表单读取价格参数（数字化；校验交给服务器，这里只做基础兜底）
  function ecoReadForm() {
    const num = function (id, dft) { const v = Number(($(id) || {}).value); return isFinite(v) ? v : dft; };
    const tiers = {};
    [['common', '普通'], ['big', '大鱼'], ['rare', '稀有']].forEach(function (tk) {
      const tier = tk[0];
      const follow = $('pc-t-' + tier + '-follow');
      if (follow && follow.checked) return;
      const o = {};
      const sd = Number(($('pc-t-' + tier + '-div') || {}).value);
      const rt = Number(($('pc-t-' + tier + '-tau') || {}).value);
      if (isFinite(sd) && sd > 0) o.saleDivisor = sd / 100; // 界面按 % 输入
      if (isFinite(rt) && rt > 0) o.riseTauMin = rt;
      if (Object.keys(o).length) tiers[tier] = o;
    });
    return {
      floorPct: num('pc-floor', 40), ceilPct: num('pc-ceil', 200),
      saleDivisor: num('pc-div', 0.75) / 100, riseTauMin: num('pc-tau', 60), riseTargetPct: num('pc-target', 200),
      sampleSec: num('pc-sample', 60), historyMin: num('pc-history', 360),
      tiers: tiers,
    };
  }
  // 容量试算：稳态均衡 s = (target − m) / (ln(1+divisor) · m · τ)；毕业玩家满产 ≈ 5184 件/h
  function ecoCapacityInfo(P) {
    const tauH = Math.max(0.001, P.riseTauMin / 60);
    const c = Math.log(1 + Math.max(0.0001, P.saleDivisor));
    const target = P.riseTargetPct / 100, floor = P.floorPct / 100;
    const sBase = Math.max(0, (target - 1) / (c * 1 * tauH));
    const sFloor = Math.max(0, (target - floor) / (c * floor * tauH));
    return { sBase: sBase, sFloor: sFloor, gradEquiv: sFloor / 5184 };
  }
  function drawEconomy(cfg) {
    const body = $('eco-body');
    if (!body) return;
    const P = cfg.priceCfg || {};
    const D = cfg.priceDefaults || {};
    const DC = cfg.dropCfg || {};
    const DD = cfg.dropDefaults || {};
    const tiers = P.tiers || {};
    const trow = function (key, name) {
      const t = tiers[key] || null;
      const follow = !t;
      return '<div class="mgr-row" style="margin-bottom:6px">' +
        '<label style="width:60px">' + name + '</label>' +
        '<label class="chk"><input type="checkbox" id="pc-t-' + key + '-follow"' + (follow ? ' checked' : '') + '><span>跟随全局</span></label>' +
        '<label class="hint">每件下压</label><input id="pc-t-' + key + '-div" class="ipt mk-num" type="number" step="0.05" min="0.1" max="5" style="width:90px" value="' + (t && t.saleDivisor != null ? (t.saleDivisor * 100) : '') + '" placeholder="' + (D.saleDivisor != null ? (D.saleDivisor * 100) : 0.75) + '">' +
        '<span class="hint">%</span>' +
        '<label class="hint" style="margin-left:10px">回升</label><input id="pc-t-' + key + '-tau" class="ipt mk-num" type="number" step="1" min="5" max="1440" style="width:90px" value="' + (t && t.riseTauMin != null ? t.riseTauMin : '') + '" placeholder="' + (P.riseTauMin != null ? P.riseTauMin : 60) + '">' +
        '<span class="hint">分钟</span></div>';
    };
    body.innerHTML =
      '<h3 style="margin-top:0">📈 价格模型参数</h3>' +
      '<div class="hint" style="margin-bottom:8px">乘数 m ∈ [地板, 天花板]；售出按「每件下压」逐件压低，闲置时以「回升时间常数」向「回升目标」靠拢（高于目标会缓慢回落）。</div>' +
      '<div class="mgr-row"><label style="width:110px">地板价</label><input id="pc-floor" class="ipt mk-num" type="number" min="10" max="100" step="5" value="' + (P.floorPct != null ? P.floorPct : 40) + '" style="width:100px">' +
      '<span class="hint">% 基准价（10-100）</span>' +
      '<label class="hint" style="margin-left:16px">天花板价</label><input id="pc-ceil" class="ipt mk-num" type="number" min="100" max="500" step="10" value="' + (P.ceilPct != null ? P.ceilPct : 200) + '" style="width:100px">' +
      '<span class="hint">%（100-500）</span></div>' +
      '<div class="mgr-row"><label style="width:110px">每件下压</label><input id="pc-div" class="ipt mk-num" type="number" min="0.1" max="5" step="0.05" value="' + (P.saleDivisor != null ? Math.round(P.saleDivisor * 10000) / 100 : 0.75) + '" style="width:100px">' +
      '<span class="hint">%（0.1-5，即每卖一件乘数 ÷(1+x)）</span>' +
      '<label class="hint" style="margin-left:16px">回升时间常数</label><input id="pc-tau" class="ipt mk-num" type="number" min="5" max="1440" step="5" value="' + (P.riseTauMin != null ? P.riseTauMin : 60) + '" style="width:100px">' +
      '<span class="hint">分钟（5-1440）</span></div>' +
      '<div class="mgr-row"><label style="width:110px">回升目标</label><input id="pc-target" class="ipt mk-num" type="number" min="100" max="300" step="10" value="' + (P.riseTargetPct != null ? P.riseTargetPct : 200) + '" style="width:100px">' +
      '<span class="hint">%（100-300，默认=天花板）</span>' +
      '<label class="hint" style="margin-left:16px">采样间隔</label><input id="pc-sample" class="ipt mk-num" type="number" min="15" max="300" step="15" value="' + (P.sampleSec != null ? P.sampleSec : 60) + '" style="width:100px">' +
      '<span class="hint">秒（15-300）</span>' +
      '<label class="hint" style="margin-left:16px">历史保留</label><input id="pc-history" class="ipt mk-num" type="number" min="60" max="1440" step="60" value="' + (P.historyMin != null ? P.historyMin : 360) + '" style="width:100px">' +
      '<span class="hint">分钟（60-1440）</span></div>' +
      '<h3 style="margin-top:16px">🎚 品质层覆盖（空 = 跟随全局）</h3>' +
      trow('common', '普通') + trow('big', '大鱼') + trow('rare', '稀有') +
      '<div class="effect-line" id="eco-cap" style="margin:10px 0 4px">—</div>' +
      '<div class="mgr-row" style="margin-top:8px"><label style="width:110px">预设</label>' +
      ECO_PRESETS.map(function (p) { return '<button class="btn mini" data-preset="' + p.k + '" title="' + esc(p.desc) + '">' + p.name + '</button>'; }).join('') +
      '<button class="btn primary" id="pc-save" style="margin-left:10px">保存价格参数</button>' +
      '<button class="btn danger" id="pc-reset">恢复默认</button>' +
      '<span id="pc-state" class="hint"></span></div>' +
      '<div class="mgr-row" style="margin-top:14px;border-top:1px solid var(--line);padding-top:12px">' +
      '<h3 style="margin:0">🌊 产出倍率（掉落池权重倍率；组件只吃全局）</h3></div>' +
      '<div class="mgr-row">' +
      '<label style="width:80px">全局</label><input id="dc-global" class="ipt mk-num" type="number" min="0" max="500" step="10" value="' + (DC.global != null ? DC.global : 100) + '" style="width:90px"><span class="hint">%</span>' +
      '<label class="hint" style="margin-left:12px">普通鱼</label><input id="dc-common" class="ipt mk-num" type="number" min="0" max="500" step="10" value="' + (DC.common != null ? DC.common : 100) + '" style="width:90px"><span class="hint">%</span>' +
      '<label class="hint" style="margin-left:12px">大鱼</label><input id="dc-big" class="ipt mk-num" type="number" min="0" max="500" step="10" value="' + (DC.big != null ? DC.big : 100) + '" style="width:90px"><span class="hint">%</span>' +
      '<label class="hint" style="margin-left:12px">稀有鱼</label><input id="dc-rare" class="ipt mk-num" type="number" min="0" max="500" step="10" value="' + (DC.rare != null ? DC.rare : 100) + '" style="width:90px"><span class="hint">%</span>' +
      '<label class="hint" style="margin-left:12px">材料</label><input id="dc-material" class="ipt mk-num" type="number" min="0" max="500" step="10" value="' + (DC.material != null ? DC.material : 100) + '" style="width:90px"><span class="hint">%</span></div>' +
      '<div class="mgr-row"><button class="btn mini" data-dpreset="daily">日常 ×1</button><button class="btn mini" data-dpreset="event">活动 ×2</button><button class="btn mini" data-dpreset="big">大鱼季（大鱼 ×2）</button>' +
      '<button class="btn primary" id="dc-save" style="margin-left:10px">保存产出倍率</button>' +
      '<button class="btn danger" id="dc-reset">恢复默认</button><span id="dc-state" class="hint"></span></div>' +
      '<h3 style="margin-top:18px">🎯 单品干预（覆盖基准价 / 锁定乘数；分钟留空 = 永久）</h3>' +
      '<div class="mgr-row"><label class="hint">搜索</label><input id="eco-search" class="ipt" placeholder="鱼名 / ID" value="' + esc(ecoSearch) + '" style="width:200px">' +
      '<span class="hint" id="eco-count"></span></div>' +
      '<div id="eco-list">…</div>' +
      '<h3 style="margin-top:18px">📝 最近改动</h3>' +
      '<div id="eco-log" class="hint">' + ((cfg.economyLog && cfg.economyLog.length)
        ? cfg.economyLog.slice().reverse().map(function (l) { return '<div>' + fmtTime(l.t) + ' · ' + esc(l.who) + ' · ' + esc(l.text) + '</div>'; }).join('')
        : '暂无改动记录。') + '</div>';

    // ---- 容量试算实时更新 ----
    function refreshCap() {
      const info = ecoCapacityInfo(ecoReadForm());
      const el2 = $('eco-cap');
      if (!el2) return;
      el2.innerHTML = '📐 按当前参数：单鱼种可维持 <b>基准价</b> 的销量 ≈ <b>' + Math.round(info.sBase) + '</b> 件/h · ' +
        '压到 <b>地板价</b> 前 ≈ <b>' + Math.round(info.sFloor) + '</b> 件/h（≈ <b>' + info.gradEquiv.toFixed(2) + '</b> 个毕业玩家满产并发）';
    }
    ['pc-floor', 'pc-ceil', 'pc-div', 'pc-tau', 'pc-target'].forEach(function (id) {
      const el2 = $(id); if (el2) el2.addEventListener('input', refreshCap);
    });
    refreshCap();

    // ---- 预设按钮：填入表单（需再点保存） ----
    body.querySelectorAll('[data-preset]').forEach(function (b) {
      b.onclick = function () {
        const p = ECO_PRESETS.find(function (x) { return x.k === b.getAttribute('data-preset'); });
        if (!p) return;
        $('pc-floor').value = p.cfg.floorPct; $('pc-ceil').value = p.cfg.ceilPct;
        $('pc-div').value = Math.round(p.cfg.saleDivisor * 10000) / 100; $('pc-tau').value = p.cfg.riseTauMin;
        $('pc-target').value = p.cfg.riseTargetPct; $('pc-sample').value = p.cfg.sampleSec; $('pc-history').value = p.cfg.historyMin;
        $('pc-state').innerHTML = '<span style="color:var(--warn,#f59e0b)">已填入「' + p.name + '」，点「保存价格参数」生效</span>';
        refreshCap();
      };
    });
    body.querySelectorAll('[data-dpreset]').forEach(function (b) {
      b.onclick = function () {
        const k = b.getAttribute('data-dpreset');
        const set = function (id, v) { $(id).value = v; };
        if (k === 'daily') { set('dc-global', 100); set('dc-common', 100); set('dc-big', 100); set('dc-rare', 100); set('dc-material', 100); }
        if (k === 'event') { set('dc-global', 200); set('dc-common', 100); set('dc-big', 100); set('dc-rare', 100); set('dc-material', 100); }
        if (k === 'big') { set('dc-global', 100); set('dc-common', 80); set('dc-big', 200); set('dc-rare', 100); set('dc-material', 100); }
        $('dc-state').innerHTML = '<span style="color:var(--warn,#f59e0b)">已填入预设，点「保存产出倍率」生效</span>';
      };
    });
    // 品质层「跟随全局」勾选时禁用输入
    ['common', 'big', 'rare'].forEach(function (tier) {
      const f = $('pc-t-' + tier + '-follow');
      const sync = function () {
        ['pc-t-' + tier + '-div', 'pc-t-' + tier + '-tau'].forEach(function (id) { const el2 = $(id); if (el2) el2.disabled = f.checked; });
      };
      f.onchange = sync; sync();
    });

    // ---- 保存：价格参数 / 产出倍率 / 干预 ----
    $('pc-save').onclick = function () {
      adminApi('POST', '/api/admin/settings', { token: token, priceCfg: ecoReadForm() }).then(function (r) {
        if (!r.ok) { $('pc-state').innerHTML = '<span class="err">' + esc(r.data.error || '保存失败') + '</span>'; return; }
        toast('价格参数已保存，立即生效');
        worldCfg = null;
        loadWorldCfg(true).then(function (c2) { if (c2 && view === 'economy') drawEconomy(c2); });
      });
    };
    $('pc-reset').onclick = function () {
      adminApi('POST', '/api/admin/settings', { token: token, resetPriceCfg: true }).then(function (r) {
        if (!r.ok) { $('pc-state').innerHTML = '<span class="err">' + esc(r.data.error || '恢复失败') + '</span>'; return; }
        toast('价格参数已恢复默认');
        worldCfg = null;
        loadWorldCfg(true).then(function (c2) { if (c2 && view === 'economy') drawEconomy(c2); });
      });
    };
    $('dc-save').onclick = function () {
      const dc = {
        global: Number($('dc-global').value), common: Number($('dc-common').value), big: Number($('dc-big').value),
        rare: Number($('dc-rare').value), material: Number($('dc-material').value),
      };
      adminApi('POST', '/api/admin/settings', { token: token, dropCfg: dc }).then(function (r) {
        if (!r.ok) { $('dc-state').innerHTML = '<span class="err">' + esc(r.data.error || '保存失败') + '</span>'; return; }
        toast('产出倍率已保存，图鉴概率已同步');
        worldCfg = null;
        loadWorldCfg(true).then(function (c2) { if (c2 && view === 'economy') drawEconomy(c2); });
      });
    };
    $('dc-reset').onclick = function () {
      adminApi('POST', '/api/admin/settings', { token: token, resetDropCfg: true }).then(function (r) {
        if (!r.ok) { $('dc-state').innerHTML = '<span class="err">' + esc(r.data.error || '恢复失败') + '</span>'; return; }
        toast('产出倍率已恢复默认');
        worldCfg = null;
        loadWorldCfg(true).then(function (c2) { if (c2 && view === 'economy') drawEconomy(c2); });
      });
    };
    $('eco-search').oninput = function () { ecoSearch = $('eco-search').value.trim(); drawEcoList(cfg); };
    drawEcoList(cfg);
  }
  // 单品干预列表（搜索过滤 + 逐项覆盖/清除）
  function drawEcoList(cfg) {
    const box = $('eco-list');
    if (!box) return;
    const all = (cfg && cfg.economyCatalog) || [];
    const kw = ecoSearch.toLowerCase();
    const list = all.filter(function (it) {
      return !kw || it.name.toLowerCase().indexOf(kw) >= 0 || it.id.toLowerCase().indexOf(kw) >= 0;
    });
    const cnt = $('eco-count');
    if (cnt) cnt.textContent = '匹配 ' + list.length + ' / ' + all.length + ' 项（覆盖后立即影响收购价与自动售出阈值）';
    if (!list.length) { box.innerHTML = '<div class="hint">无匹配物品。</div>'; return; }
    const TIER_NAME = { common: '普通', big: '大鱼', rare: '稀有', material: '材料' };
    box.innerHTML = '<div style="max-height:520px;overflow:auto">' + list.map(function (it) {
      const cls = it.kind === 'fish' && it.tier !== 'common' ? ' ' + RARITY_TAG[it.tier === 'big' ? 'big' : 'rare'] : '';
      // 单品干预标签。注意：不能在初始化式里引用它自己（原写法 `const ov = it.ov ? ... ov.until ...`
      // 会在「该物品确实有覆盖」时抛 TDZ「Cannot access 'ov' before initialization」——
      // 即设了干预再打开/重绘经济参数页，整段列表直接崩掉；没设过干预时三元短路才看不出来）。
      const o = it.ov;
      const ovTag = o ? ('<span class="tag' + (o.until ? '' : ' big') + '" title="' + (o.until ? '到期 ' + fmtTime(o.until) : '永久') + '">' + (o.base ? '基准 ' + o.base : '') + (o.base && o.m ? ' · ' : '') + (o.m ? '锁 ×' + o.m : '') + (o.until ? ' · 限时' : '') + '</span>') : '';
      return '<div class="inv-row" style="display:flex;align-items:center;gap:8px;padding:4px 0;border-bottom:1px solid var(--line)">' +
        '<span style="width:120px" class="' + cls.trim() + '">' + esc(it.name) + '</span>' +
        '<span class="hint" style="width:48px">' + (TIER_NAME[it.tier] || it.tier) + '</span>' +
        '<span style="width:110px">基准 <b>' + it.base + '</b> · 现价 <b>' + it.price + '</b> 💰</span>' +
        '<span style="width:70px">' + it.m + '%</span>' +
        '<span class="hint" style="width:100px">今日 ' + it.soldToday + '</span>' +
        '<span style="width:150px">' + ovTag + '</span>' +
        '<input class="ipt mk-num eco-ov-base" data-id="' + esc(it.id) + '" type="number" min="1" placeholder="基准价" style="width:90px" value="' + (it.ov && it.ov.base ? it.ov.base : '') + '">' +
        '<input class="ipt mk-num eco-ov-m" data-id="' + esc(it.id) + '" type="number" min="0.05" max="10" step="0.05" placeholder="锁价×" style="width:80px" value="' + (it.ov && it.ov.m ? it.ov.m : '') + '">' +
        '<input class="ipt mk-num eco-ov-min" data-id="' + esc(it.id) + '" type="number" min="0" placeholder="分钟" style="width:70px">' +
        '<button class="btn mini primary eco-ov-set" data-id="' + esc(it.id) + '">设置</button>' +
        '<button class="btn mini eco-ov-clear" data-id="' + esc(it.id) + '">清除</button>' +
        '</div>';
    }).join('') + '</div>';

    const apply = function (id, body) {
      adminApi('POST', '/api/admin/settings', Object.assign({ token: token, priceOv: Object.assign({ id: id }, body) }, {})).then(function (r) {
        if (!r.ok) { toast((r.data && r.data.error) || '操作失败', true); return; }
        toast(body.clear ? '已清除干预' : '干预已生效');
        worldCfg = null;
        loadWorldCfg(true).then(function (c2) { if (c2 && view === 'economy') drawEconomy(c2); });
      });
    };
    box.querySelectorAll('.eco-ov-set').forEach(function (b) {
      b.onclick = function () {
        const id = b.getAttribute('data-id');
        const baseEl = box.querySelector('.eco-ov-base[data-id="' + id + '"]');
        const mEl = box.querySelector('.eco-ov-m[data-id="' + id + '"]');
        const minEl = box.querySelector('.eco-ov-min[data-id="' + id + '"]');
        const payload = { id: id };
        if (baseEl.value !== '') payload.base = Number(baseEl.value);
        if (mEl.value !== '') payload.m = Number(mEl.value);
        if (minEl.value !== '') payload.untilMin = Number(minEl.value);
        if (payload.base == null && payload.m == null) { toast('至少填写覆盖基准价或锁定乘数之一', true); return; }
        apply(id, payload);
      };
    });
    box.querySelectorAll('.eco-ov-clear').forEach(function (b) {
      b.onclick = function () { apply(b.getAttribute('data-id'), { clear: true }); };
    });
  }

  // ================================
  // 横幅管理（内容 + 时长，队列播放，图标闪烁）
  // ================================
  function renderBanner() {
    const main = $('main');
    main.innerHTML = '<h2>📢 横幅管理</h2>' +
      '<div class="hint" style="margin-bottom:12px">发布滚动公告（内容 + 时长），玩家端按队列顺序依次播放。</div>' +
      '<div class="panel"><h3 style="margin-top:0">📡 当前滚播</h3>' +
      '<div id="bn-live" class="bn-live">加载中…</div></div>' +
      // 闪烁独立设置：与是否发布横幅无关，开启即让玩家端浏览器图标/标题闪烁提示
      '<div class="panel"><h3 style="margin-top:0">🔔 浏览器图标闪烁</h3>' +
      '<div class="hint" style="margin-bottom:8px">独立开关：<b>与是否发布横幅无关</b>。开启后所有在线玩家的浏览器图标与标签标题会交替闪烁，直到关闭或玩家登出。</div>' +
      '<div class="mgr-row"><label>闪烁</label><label class="switch"><input type="checkbox" id="bn-blink"><span class="sl"></span></label>' +
      '<label class="hint">闪烁时的标题</label><input id="bn-blink-title" class="ipt bn-title" placeholder="如：有新活动 ⚡" maxlength="40" />' +
      '<button class="btn primary" id="bn-cfg-save">保存闪烁设置</button>' +
      '<span id="bn-blink-state" class="hint"></span>' +
      '<label class="hint" style="margin-left:12px">公告默认颜色</label>' +
      '<input id="bn-notice-color" class="ipt bn-color-input" type="color" value="#38bdf8" title="未单独设置颜色的公告使用该颜色" />' +
      '<button class="btn mini" id="bn-notice-color-clear">用默认渐变</button></div></div>' +
      '<div class="panel"><div class="mgr-row"><label>内容</label><input id="bn-content" class="ipt" maxlength="200" placeholder="公告内容（最多 200 字）" />' +
      '<label class="hint">时长</label><input id="bn-dur" class="ipt mk-num" type="number" min="1" max="3600" step="0.5" value="10" />' +
      '<span class="hint">秒</span>' +
      '<label class="hint">颜色</label><span id="bn-colors" class="bn-colors"></span>' +
      '<button class="btn primary" id="bn-add">发布</button>' +
      '<span style="flex:1"></span><button class="btn mini danger" id="bn-clear">清空队列</button></div>' +
      '<div id="bn-list" style="margin-top:12px">加载中…</div></div>';
    // 颜色选择：预设色块 + 自定义（公告醒目度）
    let pubColor = '';
    const BN_COLORS = [['', '默认渐变'], ['#fbbf24', '金'], ['#ef4444', '红'], ['#22c55e', '绿'], ['#38bdf8', '蓝'], ['#a855f7', '紫']];
    function drawColorChips() {
      const wrap = $('bn-colors');
      if (!wrap) return;
      wrap.innerHTML = '';
      BN_COLORS.forEach(function (kv) {
        const b = document.createElement('button');
        b.className = 'bn-color-chip' + (pubColor === kv[0] ? ' on' : '');
        b.title = kv[1];
        b.style.background = kv[0] || 'linear-gradient(90deg, #fbbf24, #2dd4bf)';
        b.textContent = kv[0] ? '' : '默认';
        b.onclick = function () { pubColor = kv[0]; drawColorChips(); };
        wrap.appendChild(b);
      });
      const inp = document.createElement('input');
      inp.type = 'color';
      inp.className = 'bn-color-custom';
      inp.title = '自定义颜色';
      inp.value = /^#[0-9a-f]{6}$/.test(pubColor) ? pubColor : '#fbbf24';
      inp.oninput = function () { pubColor = inp.value; drawColorChips(); };
      wrap.appendChild(inp);
    }
    drawColorChips();
    $('bn-add').onclick = function () {
      const content = $('bn-content').value.trim();
      const duration = Number($('bn-dur').value) || 10;
      if (!content) { toast('请填写横幅内容', true); return; }
      adminApi('POST', '/api/admin/banner/add', { token: token, content: content, duration: duration, color: pubColor }).then(function (r) {
        if (!r.ok) { toast(r.data.error || '发布失败', true); return; }
        $('bn-content').value = '';
        toast('已发布'); loadBanners();
      });
    };
    $('bn-cfg-save').onclick = function () {
      const ncVal = ($('bn-notice-color-clear') && $('bn-notice-color-clear').dataset.clear === '1') ? '' : ($('bn-notice-color') ? $('bn-notice-color').value : '');
      adminApi('POST', '/api/admin/banner/cfg', { token: token, blink: $('bn-blink').checked, blinkTitle: $('bn-blink-title').value, noticeColor: ncVal }).then(function (r) {
        if (!r.ok) { toast(r.data.error || '保存失败', true); return; }
        toast($('bn-blink').checked ? '已开启图标闪烁（与横幅无关，立即对在线玩家生效）' : '已关闭图标闪烁');
        const stEl = $('bn-blink-state');
        if (stEl) stEl.innerHTML = '<span style="color:var(--ok)">已保存，立即生效</span>';
      });
    };
    $('bn-clear').onclick = function () {
      confirmModalLocal('确定清空整个横幅队列？正在滚播的横幅也会立即停止。').then(function (ok) {
        if (!ok) return;
        adminApi('POST', '/api/admin/banner/clear', { token: token }).then(function (r) {
          if (!r.ok) { toast(r.data.error || '清空失败', true); return; }
          toast('已清空 ' + (r.data.cleared || 0) + ' 条横幅');
          loadBanners();
        });
      });
    };
    loadBanners();
    stopBannerTimer();
    // 自动刷新只拉「当前滚播」数据（不重绘表单/队列，否则正在输入的内容会被重置）
    bannerTimer = setInterval(function () { if (view === 'banner') refreshBannerLive(); else stopBannerTimer(); }, 5000);
  }
  // 仅刷新「当前滚播」面板（自动刷新走这里，不碰表单）
  function refreshBannerLive() {
    adminApi('GET', '/api/admin/banner?token=' + encodeURIComponent(token)).then(function (r) {
      if (!r.ok || view !== 'banner') return;
      drawBannerLive(r.data);
    });
  }
  // 当前滚播面板：队列条数 + 每条横幅的实时观看人数（客户端播放时上报，15s 无心跳视为播完）
  function drawBannerLive(d) {
    const box = $('bn-live');
    if (!box) return;
    const playing = d.playing || [];
    const total = (d.banners || []).length;
    const watching = playing.filter(function (p) { return p.count > 0; });
    let html = '<div class="bn-live-sum">' +
      '<span class="bn-chip">队列 <b>' + total + '</b> 条</span>' +
      '<span class="bn-chip">滚播中 <b>' + watching.length + '</b> 条</span>' +
      '<span class="bn-chip">在线 <b>' + (d.online || 0) + '</b> 人</span></div>';
    if (!watching.length) {
      html += '<div class="hint">当前没有横幅正在玩家端滚播（队列为空或玩家端已播完）。</div>';
    } else {
      html += '<table class="tbl"><thead><tr><th>正在滚播</th><th class="num">观看人数</th><th>最后心跳</th><th>操作</th></tr></thead><tbody>' +
        watching.map(function (p) {
          const dt = new Date(p.lastAt);
          const ts = ('0' + dt.getHours()).slice(-2) + ':' + ('0' + dt.getMinutes()).slice(-2) + ':' + ('0' + dt.getSeconds()).slice(-2);
          return '<tr><td>' + esc(p.content) + '</td><td class="num">' + p.count + '</td><td class="hint">' + ts + '</td>' +
            '<td class="mgr-acts"><button class="btn mini danger" data-stop="' + esc(p.id) + '">停止滚播</button></td></tr>';
        }).join('') + '</tbody></table>';
    }
    box.innerHTML = html;
    box.querySelectorAll('[data-stop]').forEach(function (b) {
      b.onclick = function () { stopBanner(b.getAttribute('data-stop')); };
    });
  }
  // 换色：在「默认 + 预设色」之间循环，立即广播给在线玩家
  function changeBannerColor(id) {
    const presets = ['', '#fbbf24', '#ef4444', '#22c55e', '#38bdf8', '#a855f7'];
    let cur = '';
    adminApi('GET', '/api/admin/banner?token=' + encodeURIComponent(token)).then(function (r) {
      const bn = (r.ok && (r.data.banners || []).find(function (x) { return x.id === id; }));
      cur = (bn && bn.color) || '';
      const next = presets[(presets.indexOf(cur) + 1) % presets.length];
      adminApi('POST', '/api/admin/banner/update', { token: token, id: id, color: next }).then(function (r2) {
        if (!r2.ok) { toast(r2.data.error || '换色失败', true); return; }
        toast(next ? ('公告颜色已改为 ' + next) : '公告已恢复默认渐变');
        loadBanners();
      });
    });
  }
  function stopBanner(id) {
    adminApi('POST', '/api/admin/banner/stop', { token: token, id: id }).then(function (r) {
      if (!r.ok) { toast(r.data.error || '停止失败', true); return; }
      toast('已通知所有玩家停止该横幅');
      loadBanners();
    });
  }
  function loadBanners() {
    adminApi('GET', '/api/admin/banner?token=' + encodeURIComponent(token)).then(function (r) {
      if (!r.ok || view !== 'banner') return;
      const bs = r.data.banners || [];
      // 正在编辑闪烁设置时不覆盖输入（避免打字被冲掉）
      const editingBlink = document.activeElement === $('bn-blink-title');
      if (!editingBlink) $('bn-blink').checked = !!(r.data.cfg && r.data.cfg.blink);
      if (!editingBlink) $('bn-blink-title').value = (r.data.cfg && r.data.cfg.blinkTitle) || '📢 有新公告';
      const ncInp = $('bn-notice-color'), ncClr = $('bn-notice-color-clear');
      if (ncInp && ncClr && !editingBlink) {
        const nc = (r.data.cfg && r.data.cfg.noticeColor) || '';
        ncClr.dataset.clear = nc ? '0' : '1';
        if (nc) ncInp.value = nc;
      }
      const stEl = $('bn-blink-state');
      if (stEl) stEl.textContent = (r.data.cfg && r.data.cfg.blink) ? '当前：已开启' : '当前：已关闭';
      drawBannerLive(r.data);
      const box = $('bn-list');
      if (!bs.length) { box.innerHTML = '<div class="hint">队列为空。</div>'; return; }
      box.innerHTML = '<table class="tbl"><thead><tr><th>#</th><th>内容</th><th class="num">时长</th><th>发布</th><th>操作</th></tr></thead><tbody>' +
        bs.map(function (b, i) {
          return '<tr><td>' + (i + 1) + '</td><td>' + esc(b.content) + '</td>' +
            '<td><span class="bn-swatch" style="background:' + (b.color ? esc(b.color) : 'linear-gradient(90deg,#fbbf24,#2dd4bf)') + '"></span>' +
            '<button class="btn mini" data-color="' + esc(b.id) + '">换色</button></td>' +
            '<td class="num">' + b.duration + 's</td>' +
            '<td class="hint">' + esc(b.by || '') + '</td>' +
            '<td class="mgr-acts"><button class="btn mini" data-up="' + esc(b.id) + '"' + (i === 0 ? ' disabled' : '') + '>↑</button>' +
            '<button class="btn mini" data-down="' + esc(b.id) + '"' + (i === bs.length - 1 ? ' disabled' : '') + '>↓</button>' +
            '<button class="btn mini" data-stop2="' + esc(b.id) + '">停止</button>' +
            '<button class="btn mini danger" data-rm="' + esc(b.id) + '">删除</button></td></tr>';
        }).join('') + '</tbody></table>';
      box.querySelectorAll('[data-up]').forEach(function (b) { b.onclick = function () { moveBanner(b.getAttribute('data-up'), 'up'); }; });
      box.querySelectorAll('[data-down]').forEach(function (b) { b.onclick = function () { moveBanner(b.getAttribute('data-down'), 'down'); }; });
      box.querySelectorAll('[data-rm]').forEach(function (b) { b.onclick = function () { removeBanner(b.getAttribute('data-rm')); }; });
      box.querySelectorAll('[data-stop2]').forEach(function (b) { b.onclick = function () { stopBanner(b.getAttribute('data-stop2')); }; });
      box.querySelectorAll('[data-color]').forEach(function (b) {
        b.onclick = function () { changeBannerColor(b.getAttribute('data-color')); };
      });
    });
  }
  function moveBanner(id, dir) {
    adminApi('POST', '/api/admin/banner/move', { token: token, id: id, dir: dir }).then(function (r) {
      if (!r.ok) { toast(r.data.error || '移动失败', true); return; }
      loadBanners();
    });
  }
  function removeBanner(id) {
    confirmModalLocal('确定从队列删除这条横幅？').then(function (ok) {
      if (!ok) return;
      adminApi('POST', '/api/admin/banner/remove', { token: token, id: id }).then(function (r) {
        if (!r.ok) { toast(r.data.error || '删除失败', true); return; }
        toast('已删除'); loadBanners();
      });
    });
  }

  // ================================
  // 初始化
  // ================================
  function init() {
    $('login-btn').onclick = doLogin;
    $('login-pass').addEventListener('keydown', function (e) { if (e.key === 'Enter') doLogin(); });
    $('login-user').addEventListener('keydown', function (e) { if (e.key === 'Enter') doLogin(); });
    $('logout-btn').onclick = function () { logout(); };
    let saved = null;
    try { saved = localStorage.getItem('fishing_admin_token'); } catch (e) {}
    if (saved) {
      api('GET', '/api/admin/session?token=' + encodeURIComponent(saved)).then(function (r) {
        if (r.ok) { token = saved; me = { username: r.data.username, name: r.data.name }; enter(); }
        else showLogin();
      });
    } else {
      showLogin();
    }
  }

  return { init: init };
})();

window.Admin.init();

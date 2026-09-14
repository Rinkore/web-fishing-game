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
  function api(method, path, body) {
    return detectBase().then(function () {
      const opts = { method: method, headers: { 'Content-Type': 'application/json' } };
      if (body) opts.body = JSON.stringify(body);
      return fetch(API_BASE + path, opts).then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (j) { return { ok: r.ok, status: r.status, data: j }; });
      }).catch(function () { return { ok: false, status: 0, data: { error: '网络错误' } }; });
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
    { id: 'formula', name: '🧮 公式管理' },
    { id: 'notify', name: '🔔 通知等级' },
    { id: 'banner', name: '📢 横幅管理' },
    { id: 'feedback', name: '📮 反馈意见' },
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
    renderNav();
    if (v === 'overview') return renderOverview();
    if (v === 'accounts') return renderAccounts();
    if (v === 'accountmgr') return renderAccountMgr();
    if (v === 'grounds') return renderGrounds();
    if (v === 'market') return renderMarket();
    if (v === 'component') return renderComponent();
    if (v === 'fishsize') return renderFishSize();
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
        $('ov-body').innerHTML =
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
  function renderAccountMgr() {
    const main = $('main');
    main.innerHTML = '<h2>🔑 账号管理</h2>' +
      '<div class="hint" style="margin-bottom:12px">与「账号授权」同款列表；可改密码 / 显示名 / 金币，查看并编辑玩家快照（金币与背包），或删除账号（需二次确认）。修改密码会使其所有登录会话失效。</div>' +
      '<div id="mgr-list" class="panel">加载中…</div>';
    loadMgrList();
  }
  function loadMgrList() {
    adminApi('GET', '/api/admin/users?token=' + encodeURIComponent(token)).then(function (r) {
      if (!r.ok || view !== 'accountmgr') return;
      const meKey = r.data.me;
      const rows = r.data.users.map(function (u) {
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
      $('mgr-list').innerHTML = '<table class="tbl"><thead><tr>' +
        '<th>账号</th><th class="num">金币</th><th class="num">捕获数</th><th>状态</th><th>注册时间</th><th>操作</th>' +
        '</tr></thead><tbody>' + rows + '</tbody></table>';
      $('mgr-list').querySelectorAll('[data-edit]').forEach(function (b) { b.onclick = function () { openMgrEdit(b.getAttribute('data-edit')); }; });
      $('mgr-list').querySelectorAll('[data-snap]').forEach(function (b) { b.onclick = function () { openMgrSnapshot(b.getAttribute('data-snap')); }; });
      $('mgr-list').querySelectorAll('[data-del]').forEach(function (b) { b.onclick = function () { confirmDeleteUser(b.getAttribute('data-del')); }; });
    });
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
      document.querySelectorAll('.modal-overlay').forEach(function (m) { m.remove(); });
      const ov = document.createElement('div');
      ov.className = 'modal-overlay';
      ov.innerHTML = '<div class="modal-box confirm-modal snap-modal"><div class="modal-head"><span class="modal-title">资产快照 · ' + esc(d.name) + '（' + esc(key) + '）</span></div>' +
        '<div class="modal-body">' +
        '<div class="mgr-row"><label>金币</label><input id="snap-coins" class="ipt" type="number" min="0" value="' + d.coins + '" /></div>' +
        '<div class="hint" style="margin:10px 0 6px">背包（直接编辑每行的数量，0 或留空 = 移除）</div>' +
        '<div id="snap-inv" class="snap-inv"></div>' +
        '<div class="mgr-row" style="margin-top:8px"><label>新增物品</label>' +
        '<input id="snap-add-id" class="ipt" placeholder="物品 ID（如 crucian / rod_bamboo#common#spd+10）" />' +
        '<input id="snap-add-qty" class="ipt mk-num" type="number" min="1" value="1" />' +
        '<button class="btn mini" id="snap-add">添加</button></div>' +
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
      ov.querySelector('#snap-add').onclick = function () {
        const id = ov.querySelector('#snap-add-id').value.trim();
        const qty = Math.max(1, Number(ov.querySelector('#snap-add-qty').value) || 1);
        if (!id) return;
        const inputs = ov.querySelectorAll('[data-inv]');
        for (const inp of inputs) { if (inp.getAttribute('data-inv') === id) { inp.value = (Number(inp.value) || 0) + qty; return; } }
        const cur = {};
        inputs.forEach(function (inp) { cur[inp.getAttribute('data-inv')] = Number(inp.value) || 0; });
        cur[id] = qty;
        drawInv(cur);
      };
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
      '<div id="ed-body"></div>' +
      '</div>';
    void presets;

    body.querySelectorAll('.gcard').forEach(function (c) {
      c.onclick = function (ev) {
        if (ev.target && ev.target.getAttribute && (ev.target.getAttribute('data-lock') || ev.target.getAttribute('data-rmg'))) return;
        selGround = c.getAttribute('data-g'); selSpot = null;
        poolDirty = buffsDirty = false;
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
        poolDirty = buffsDirty = false;
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
        token: token, groundId: g.id,
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
        token: token, groundId: g.id,
        openFrom: $('gi-from').value || null, openTo: $('gi-to').value || null,
      }).then(function (r) {
        if (!r.ok) { $('gi-state').innerHTML = '<span class="err">' + esc(r.data.error || '保存失败') + '</span>'; return; }
        toast('限时窗口已保存，到点自动开/关');
        loadWorldCfg(true).then(function (c2) { if (view === 'grounds' && c2) drawGrounds(c2); });
      });
    };
    $('gi-clearwin').onclick = function () {
      adminApi('POST', '/api/admin/ground/update', { token: token, groundId: g.id, clearWindow: true }).then(function (r) {
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
      adminApi('POST', '/api/admin/spot/add', { token: token, groundId: g.id, id: autoId, name: name, preset: $('ns-preset').value, fill: true }).then(function (r) {
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

    const sp = g.spots.find(function (x) { return x.id === selSpot; });
    if (!sp) { $('ed-body').innerHTML = '<div class="hint">该渔场暂无钓点，可用上方「＋ 新建钓点」添加（自动填充掉落池）。</div>'; return; }
    // 草稿：首次进入或切换钓点时从服务器数据拷贝
    if (!poolDirty && !buffsDirty) {
      poolDraft = (sp.pool || []).map(function (e) { return poolToRow(e.pick, e.weight); });
      buffsDraft = (sp.buffs || []).map(function (b) { return { type: b.type, value: b.value }; });
    }
    drawEditors(cfg, g, sp);
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
      '<div id="buff-rows"></div>' +
      '<div class="editor-foot">' +
      '<button id="buff-add" class="btn mini">＋ 添加增益</button>' +
      '<span id="buff-state" class="hint"></span>' +
      '<span style="flex:1"></span>' +
      '<button id="buff-save" class="btn primary">保存增益</button>' +
      '</div>';

    const affixes = cfg.affixTypes;
    const buffNote = {
      speed: '钓速：该钓点抛竿速率的最终乘算（× (1-数值/100)），不与钓竿词缀/全服加成相加', big: '大鱼概率：放大「大鱼」条目权重',
      rare: '稀有概率：放大「稀有」条目权重', material: '材料概率：放大材料条目权重',
      size: '体型：放大捕获体型（最高基准上限 1.3 倍）', double: '双钓概率：触发后立即再结算一竿',
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
          '<input class="ipt c-v" type="number" step="1" value="' + esc(b.value) + '" data-idx="' + idx + '" data-f="value">' +
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
  const BITE_VARS_DOC = [
    ['speed', '钓速加成 %（钓竿词缀 + 钓点增益）'], ['big', '大鱼概率加成 %'], ['rare', '稀有概率加成 %'],
    ['material', '材料概率加成 %'], ['size', '体型加成 %'], ['double', '双钓叠加值 A（概率按 A/(A+100) 换算）'], ['interval', '当前抛竿间隔 ms'],
  ];
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
      '<div class="panel"><h3>可用变量</h3><div class="kv">' +
      BITE_VARS_DOC.map(function (v) { return '<code>' + v[0] + '</code> — ' + v[1] + '<br>'; }).join('') +
      '</div><h3>可用函数</h3><div class="kv"><code>min</code> <code>max</code> <code>floor</code> <code>ceil</code> <code>round</code> <code>abs</code> <code>clamp(x, lo, hi)</code><br>' +
      '示例：<code>90</code>（默认：平值 90% 上钩） ／ <code>min(98, 90 + speed * 0.15)</code>（旧版：上钩率随钓速提升） ／ <code>clamp(85 + rare, 50, 100)</code></div></div>' +
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

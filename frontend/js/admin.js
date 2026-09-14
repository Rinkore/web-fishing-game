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
    renderNav();
    if (v === 'overview') return renderOverview();
    if (v === 'accounts') return renderAccounts();
    if (v === 'accountmgr') return renderAccountMgr();
    if (v === 'grounds') return renderGrounds();
    if (v === 'market') return renderMarket();
    if (v === 'component') return renderComponent();
    if (v === 'formula') return renderFormula();
    if (v === 'notify') return renderNotify();
    if (v === 'banner') return renderBanner();
    if (v === 'feedback') return renderFeedback();
  }

  // ================================
  // 反馈意见（只读列表）
  // ================================
  function renderFeedback() {
    const main = $('main');
    main.innerHTML = '<h2>📮 玩家反馈</h2><div class="hint" style="margin-bottom:12px">玩家提交的 Bug / 建议 / 平衡反馈，按时间倒序。</div>' +
      '<div id="fb-body" class="panel">加载中…</div>';
    adminApi('GET', '/api/admin/feedback?token=' + encodeURIComponent(token)).then(function (r) {
      if (view !== 'feedback') return;
      const box = $('fb-body');
      if (!r.ok) { box.textContent = (r.data && r.data.error) || '加载失败'; return; }
      const list = r.data.feedback || [];
      if (!list.length) { box.innerHTML = '<div class="hint">暂无反馈。</div>'; return; }
      const KIND = { bug: '🐛 Bug', idea: '💡 建议', balance: '⚖️ 平衡', other: '💬 其他' };
      const STATUSES = r.data.statuses || { submitted: '已提交', accepted: '已受理', done: '已完成' };
      box.innerHTML = '<div class="hint" style="margin-bottom:10px">共 ' + list.length + ' 条</div>' +
        list.map(function (f) {
          const dt = new Date(f.t);
          const ts = dt.getFullYear() + '-' + ('0' + (dt.getMonth() + 1)).slice(-2) + '-' + ('0' + dt.getDate()).slice(-2) + ' ' +
            ('0' + dt.getHours()).slice(-2) + ':' + ('0' + dt.getMinutes()).slice(-2);
          const cur = f.status || 'submitted';
          const opts = Object.keys(STATUSES).map(function (k) {
            return '<option value="' + k + '"' + (k === cur ? ' selected' : '') + '>' + esc(STATUSES[k]) + '</option>';
          }).join('');
          return '<div class="fb-admin-item">' +
            '<div class="fb-admin-head"><span class="fb-tag">' + esc(KIND[f.kind] || f.kind || '其他') + '</span>' +
            '<span class="fb-admin-who">' + esc(f.name || f.key) + '</span>' +
            '<span class="fb-status ' + cur + '">' + esc(STATUSES[cur] || cur) + '</span>' +
            '<span class="fb-admin-time">' + ts + (f.version ? ' · ' + esc(f.version) : '') + '</span></div>' +
            '<div class="fb-admin-text">' + esc(f.text) + '</div>' +
            '<div class="fb-admin-foot"><label class="hint">状态</label>' +
            '<select class="ipt fb-status-sel" data-id="' + esc(f.id) + '" style="width:auto">' + opts + '</select>' +
            (f.statusBy ? '<span class="hint">由 ' + esc(f.statusBy) + ' 更新</span>' : '') + '</div></div>';
        }).join('');
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
    body.innerHTML =
      '<div class="ground-tabs">' + cfg.grounds.map(function (gr) {
        return '<div class="gcard' + (gr.id === selGround ? ' sel' : '') + (gr.locked ? ' locked' : '') + '" data-g="' + esc(gr.id) + '">' +
          '<b>' + esc(gr.name) + (gr.locked ? ' 🔒' : '') + '</b>' +
          '<span class="gi">' + esc(gr.desc) + '</span>' +
          '<div style="margin-top:6px"><button class="btn mini" data-lock="' + esc(gr.id) + '">' + (gr.locked ? '解锁钓场' : '锁定钓场') + '</button></div>' +
          '</div>';
      }).join('') + '</div>' +
      '<div class="panel">' +
      '<div class="spot-tabs">' + g.spots.map(function (s) {
        return '<button class="spot-tab' + (s.id === selSpot ? ' on' : '') + '" data-s="' + esc(s.id) + '">' + esc(s.name) + '</button>';
      }).join('') + '</div>' +
      '<div id="ed-body"></div>' +
      '</div>';

    body.querySelectorAll('.gcard').forEach(function (c) {
      c.onclick = function (ev) {
        if (ev.target && ev.target.getAttribute && ev.target.getAttribute('data-lock')) return;
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
    body.querySelectorAll('.spot-tab').forEach(function (t) {
      t.onclick = function () {
        selSpot = t.getAttribute('data-s');
        poolDirty = buffsDirty = false;
        drawGrounds(cfg);
      };
    });

    const sp = g.spots.find(function (x) { return x.id === selSpot; });
    if (!sp) { $('ed-body').innerHTML = '<div class="hint">该钓场暂无钓点。</div>'; return; }
    // 草稿：首次进入或切换钓点时从服务器数据拷贝
    if (!poolDirty && !buffsDirty) {
      poolDraft = (sp.pool || []).map(function (e) { return poolToRow(e.pick, e.weight); });
      buffsDraft = (sp.buffs || []).map(function (b) { return { type: b.type, value: b.value }; });
    }
    drawEditors(cfg, g, sp);
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
    ed.innerHTML = '<h3>🎣 掉落池 — ' + esc(g.name) + ' · ' + esc(sp.name) + '</h3>' +
      '<div id="pool-rows"></div>' +
      '<div class="editor-foot">' +
      '<button id="pool-add" class="btn mini">＋ 添加条目</button>' +
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
      speed: '钓速：缩短抛竿间隔（上限 60%）', big: '大鱼概率：放大「大鱼」条目权重',
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

    $('pool-add').onclick = function () { poolDraft.push({ type: 'fish', id: '', weight: 10 }); poolDirty = true; drawPool(); };
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
      '示例：<code>min(98, 90 + speed * 0.15)</code> ／ <code>clamp(85 + rare, 50, 100)</code> ／ <code>interval &lt; 2000 ? 0 : 90</code> ❌（不支持三元）</div></div>' +
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
  // 横幅管理（内容 + 时长，队列播放，图标闪烁）
  // ================================
  function renderBanner() {
    const main = $('main');
    main.innerHTML = '<h2>📢 横幅管理</h2>' +
      '<div class="hint" style="margin-bottom:12px">发布滚动公告（内容 + 时长），玩家端按队列顺序依次播放；有内容时可按配置让浏览器图标闪烁提示。</div>' +
      '<div class="panel"><div class="mgr-row"><label>内容</label><input id="bn-content" class="ipt" maxlength="200" placeholder="公告内容（最多 200 字）" />' +
      '<label class="hint">时长</label><input id="bn-dur" class="ipt mk-num" type="number" min="1" max="3600" step="0.5" value="10" />' +
      '<span class="hint">秒</span><button class="btn primary" id="bn-add">发布</button></div>' +
      '<div class="mgr-row"><label>图标闪烁</label><label class="switch"><input type="checkbox" id="bn-blink"><span class="sl"></span></label>' +
      '<input id="bn-blink-title" class="ipt" placeholder="闪烁时浏览器标题" style="max-width:280px" />' +
      '<button class="btn" id="bn-cfg-save">保存闪烁设置</button></div>' +
      '<div id="bn-list" style="margin-top:12px">加载中…</div></div>';
    $('bn-add').onclick = function () {
      const content = $('bn-content').value.trim();
      const duration = Number($('bn-dur').value) || 10;
      if (!content) { toast('请填写横幅内容', true); return; }
      adminApi('POST', '/api/admin/banner/add', { token: token, content: content, duration: duration }).then(function (r) {
        if (!r.ok) { toast(r.data.error || '发布失败', true); return; }
        $('bn-content').value = '';
        toast('已发布'); loadBanners();
      });
    };
    $('bn-cfg-save').onclick = function () {
      adminApi('POST', '/api/admin/banner/cfg', { token: token, blink: $('bn-blink').checked, blinkTitle: $('bn-blink-title').value }).then(function (r) {
        if (!r.ok) { toast(r.data.error || '保存失败', true); return; }
        toast('闪烁设置已保存');
      });
    };
    loadBanners();
  }
  function loadBanners() {
    adminApi('GET', '/api/admin/banner?token=' + encodeURIComponent(token)).then(function (r) {
      if (!r.ok || view !== 'banner') return;
      const bs = r.data.banners || [];
      $('bn-blink').checked = !!(r.data.cfg && r.data.cfg.blink);
      $('bn-blink-title').value = (r.data.cfg && r.data.cfg.blinkTitle) || '📢 有新公告';
      const box = $('bn-list');
      if (!bs.length) { box.innerHTML = '<div class="hint">队列为空。</div>'; return; }
      box.innerHTML = '<table class="tbl"><thead><tr><th>#</th><th>内容</th><th class="num">时长</th><th>发布</th><th>操作</th></tr></thead><tbody>' +
        bs.map(function (b, i) {
          return '<tr><td>' + (i + 1) + '</td><td>' + esc(b.content) + '</td>' +
            '<td class="num">' + b.duration + 's</td>' +
            '<td class="hint">' + esc(b.by || '') + '</td>' +
            '<td class="mgr-acts"><button class="btn mini" data-up="' + esc(b.id) + '"' + (i === 0 ? ' disabled' : '') + '>↑</button>' +
            '<button class="btn mini" data-down="' + esc(b.id) + '"' + (i === bs.length - 1 ? ' disabled' : '') + '>↓</button>' +
            '<button class="btn mini danger" data-rm="' + esc(b.id) + '">删除</button></td></tr>';
        }).join('') + '</tbody></table>';
      box.querySelectorAll('[data-up]').forEach(function (b) { b.onclick = function () { moveBanner(b.getAttribute('data-up'), 'up'); }; });
      box.querySelectorAll('[data-down]').forEach(function (b) { b.onclick = function () { moveBanner(b.getAttribute('data-down'), 'down'); }; });
      box.querySelectorAll('[data-rm]').forEach(function (b) { b.onclick = function () { removeBanner(b.getAttribute('data-rm')); }; });
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

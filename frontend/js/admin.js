/*
 * 钓鱼后台管理 - 页面逻辑（零依赖，与游戏前端共用后端 /api/admin/*）
 * 登录：管理员账号 + 验证器动态验证码（仅本机控制台可初始化）。
 * 功能页：概览 / 账号管理（含管理员授权）/ 钓点管理（掉落池权重实时百分比 + 增益）/ 市集退回 / 上钩公式 / 通知等级。
 */
window.Admin = (function () {
  'use strict';

  // ---- 状态 ----
  let token = null;
  let me = null;
  let view = 'overview';
  let worldCfg = null;          // /api/admin/world 结果（grounds + catalog + 设置）
  let mkPage = 1, mkInfo = null, mkSequence = 0, mkFilterTimer;
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
  let lgDraft = null, lgEditing = '';   // 战利品组草稿（{id,name,weight,items:[{type,id,weight}]}）与它对应的组 id
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
    const requestUrl = new URL(path, location.href);
    requestUrl.searchParams.delete('token');
    path = requestUrl.pathname + requestUrl.search;
    if (body) { body = Object.assign({}, body); delete body.token; }
    const opts = { method: method, credentials: 'include', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'FishGame', 'X-Session-Mode': 'cookie' } };
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
    api('POST', '/api/admin/logout', {}).catch(function () {});
    token = null; me = null; worldCfg = null;
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
    if ($('login-btn').disabled) return;
    const user = $('login-user').value.trim();
    const pass = $('login-pass').value;
    if (!user || !pass) { $('login-msg').textContent = '请填写用户名和密码'; return; }
    const btn = $('login-btn');
    btn.disabled = true; btn.textContent = '登录中…';
    api('POST', '/api/admin/login', { username: user, password: pass, otp: $('login-otp').value.trim() }).then(function (r) {
      btn.disabled = false; btn.textContent = '登录管理后台';
      if (!r.ok) {
        $('login-msg').textContent = (r.data && r.data.error) || '登录失败';
        return;
      }
      token = r.data.token; me = { username: r.data.username, name: r.data.name };
      try { localStorage.removeItem('fishing_admin_token'); } catch (e) {}
      enter();
    });
  }

  // ================================
  // 导航 / 视图切换
  // ================================
  const NAV = [
    { id: 'overview', name: '📊 概览' },
    { id: 'features', name: '🔒 功能开关' },
    { id: 'accountmgr', name: '👥 账号管理' },
    { id: 'security', name: '🛡 安全' },   // v0.16.0：封禁名单 + 管理操作审计 + 异常登录
    { id: 'grounds', name: '🎣 钓点管理' },
    { id: 'market', name: '💱 市集管理' },
    { id: 'gear', name: '🧩 装备与套装' },
    { id: 'fishsize', name: '🐟 鱼类体型' },
    { id: 'economy', name: '💰 经济参数' },
    { id: 'chest', name: '🎁 宝匣配置' },
    { id: 'sea', name: '⛵ 远洋配置' },
    { id: 'expedition', name: '🧭 远航与套装' },
    { id: 'mail', name: '✉️ 邮件管理' },
    { id: 'party', name: '⚓ 编队管理' },
    { id: 'mall', name: '🛒 商城配置' },
    { id: 'formula', name: '🧮 公式管理' },
    { id: 'notify', name: '🔔 通知等级' },
    { id: 'banner', name: '📢 横幅管理' },
    { id: 'wiki', name: '📚 Wiki攻略' },
    { id: 'feedback', name: '📮 反馈' },
    { id: 'records', name: '🏆 纪录贴图' },
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
  function renderFeatures() {
    const main = $('main');
    main.innerHTML = '<h2>🔒 玩家功能开关</h2>' +
      '<div class="hint" style="margin-bottom:10px">勾选为开放。关闭主页面会同时停用下属操作，子项设置会保留。' +
      '出售开关适用于所有入口；关闭出售也暂停自动售出。停止钓鱼、取消交易、撤回挂单始终允许。' +
      '拖动左侧把手调整菜单；拖动子功能标签调整子功能，保存后客户端菜单、页签和同组操作同步排序。</div>' +
      '<div class="feat-bar">' +
      '<label class="chk feat-bypass" title="开启后，带管理员身份的操作不受这些开关限制（玩家端照常受限），便于维护期自测">' +
      '<input type="checkbox" id="feat-admin-bypass"> 允许管理员进入已关闭功能</label>' +
      '<span class="feat-sum" id="feat-sum"></span>' +
      '<input class="ipt feat-search" id="feat-search" placeholder="搜索功能 / 页面…" />' +
      '<button class="btn mini" id="feat-open-all">全部开启</button>' +
      '<button class="btn mini" id="feat-close-all">全部关闭</button>' +
      '<button class="btn primary" id="features-save">保存功能开关</button>' +
      '<span id="features-result" role="status"></span>' +
      '</div>' +
      '<div id="feature-editor" class="feat-grid">加载中…</div>';
    adminApi('GET', '/api/admin/features?token=' + encodeURIComponent(token)).then(function (r) {
      if (view !== 'features') return;
      const host = $('feature-editor');
      if (!r || !r.ok) { host.textContent = '加载失败，请重新进入本页'; return; }
      const draft = Object.assign({}, r.data.features);
      const groupNameOf = {};
      r.data.groups.forEach(function (g) { groupNameOf[g.id] = g.name; });
      const order = { menu: GameFeatures.orderedMenu((r.data.featureOrder || {}).menu) };
      r.data.groups.forEach(function (g) {
        if (!g.children.length) return;
        const ids = g.children.map(function (c) { return c.id; });
        const saved = ((r.data.featureOrder || {})[g.id] || []).filter(function (id) { return ids.indexOf(id) >= 0; });
        order[g.id] = saved.concat(ids.filter(function (id) { return saved.indexOf(id) < 0; }));
      });
      const bypassBox = $('feat-admin-bypass');
      if (bypassBox) bypassBox.checked = r.data.features.adminBypass === true;
      // 卡片式布局：一个页面一张卡；子项可单独开关并用上下箭头调整顺序。
      const sortedGroups = [];
      order.menu.forEach(function (id) {
        sortedGroups.push(r.data.groups.find(function (g) { return g.id === id; }));
        if (id === 'fishing') sortedGroups.push(r.data.groups.find(function (g) { return g.id === 'bd'; }));
        if (id === 'codex') sortedGroups.push(r.data.groups.find(function (g) { return g.id === 'records'; }));
      });
      host.innerHTML = sortedGroups.filter(Boolean).map(function (g) {
        const on = draft[g.id] !== false;
        const kids = g.children.length ? order[g.id].map(function (id) { return g.children.find(function (c) { return c.id === id; }); }).filter(Boolean) : [];
        return '<section class="panel feature-group' + (on ? '' : ' off') + '"' +
          (g.parent ? ' data-parent="' + g.parent + '"' : '') + ' data-name="' + esc(g.name) + '" data-order-group="' + esc(g.id) + '">' +
          '<h3>' + (order.menu.indexOf(g.id) >= 0 ? '<button type="button" class="feat-drag" draggable="true" title="拖动调整菜单顺序" aria-label="拖动调整菜单顺序">⠿</button>' : '') + '<label class="feat-page"><input type="checkbox" data-feature-key="' + g.id + '"' + (on ? ' checked' : '') + '>' +
          '<span>' + esc(g.name) + '</span><i class="feat-state">' + (on ? '开放' : '已关闭') + '</i></label></h3>' +
          (kids.length
            ? '<div class="feature-children">' + kids.map(function (a, idx) {
              const con = draft[a.id] !== false;
              return '<span class="feat-chip' + (con ? '' : ' off') + '" draggable="true" data-child-id="' + esc(a.id) + '">' +
                '<label><input type="checkbox" data-feature-key="' + a.id + '"' + (con ? ' checked' : '') + '><span>' + esc(a.name) + '</span></label>' +
                '<button class="feat-move" type="button" data-move="-1" title="上移"' + (idx === 0 ? ' disabled' : '') + '>↑</button>' +
                '<button class="feat-move" type="button" data-move="1" title="下移"' + (idx === kids.length - 1 ? ' disabled' : '') + '>↓</button></span>';
            }).join('') + '</div>'
            : '<div class="hint">无独立子项</div>') +
          '<div class="hint feature-inherited"></div></section>';
      }).join('');
      let dragged = null;
      host.addEventListener('dragstart', function (ev) {
        dragged = ev.target.closest('.feat-chip') || (ev.target.closest('.feat-drag') && ev.target.closest('.feature-group'));
        if (!dragged) { ev.preventDefault(); return; }
        ev.dataTransfer.setData('text/plain', dragged.dataset.childId || dragged.dataset.orderGroup);
        ev.dataTransfer.effectAllowed = 'move';
      });
      host.addEventListener('dragover', function (ev) { if (dragged) ev.preventDefault(); });
      host.addEventListener('drop', function (ev) {
        if (!dragged) return;
        ev.preventDefault();
        const child = dragged.matches('.feat-chip');
        const target = ev.target.closest(child ? '.feat-chip' : '.feature-group');
        if (!target || target === dragged || (child && target.parentNode !== dragged.parentNode)) return;
        if (!child && !order.menu.includes(target.dataset.orderGroup)) return;
        target.parentNode.insertBefore(dragged, target);
        if (child) {
          const group = dragged.closest('.feature-group');
          order[group.dataset.orderGroup] = Array.from(group.querySelectorAll('.feat-chip')).map(function (n, i, all) {
            n.querySelector('[data-move="-1"]').disabled = i === 0;
            n.querySelector('[data-move="1"]').disabled = i === all.length - 1;
            return n.dataset.childId;
          });
        } else {
          order.menu = Array.from(host.querySelectorAll('.feature-group')).map(function (n) { return n.dataset.orderGroup; }).filter(function (id) { return GameFeatures.menuIds.includes(id); });
          [['fishing', 'bd'], ['codex', 'records']].forEach(function (pair) {
            const parent = host.querySelector('[data-order-group="' + pair[0] + '"]');
            const tab = host.querySelector('[data-order-group="' + pair[1] + '"]');
            if (parent && tab) parent.after(tab);
          });
        }
        dragged = null; $('features-result').textContent = ' 有未保存的排序修改';
      });
      host.addEventListener('dragend', function () { dragged = null; });
      function sync() {
        let on = 0, total = 0;
        host.querySelectorAll('.feature-group').forEach(function (group) {
          const parent = group.querySelector('h3 input');
          total++; if (parent.checked) on++;
          const lines = [];
          if (!parent.checked) lines.push('整页已关闭，下属操作当前均不可用（保留各项设置）');
          // 页签页（钓竿 / 记录）跟着主页面走：主页面一关，页签同样进不去
          const pId = group.getAttribute('data-parent');
          const pBox = pId ? host.querySelector('[data-feature-key="' + pId + '"]') : null;
          if (pBox && !pBox.checked) lines.push('主页面「' + (groupNameOf[pId] || pId) + '」已关闭，本页签当前不可用');
          group.querySelector('.feature-inherited').textContent = lines.join(' ');
          group.classList.toggle('off', !parent.checked);
          const tag = group.querySelector('.feat-state');
          if (tag) tag.textContent = parent.checked ? '开放' : '已关闭';
          group.querySelectorAll('.feat-chip').forEach(function (chip) {
            const cb = chip.querySelector('input');
            chip.classList.toggle('off', !cb.checked);
          });
        });
        const sum = $('feat-sum');
        if (sum) sum.textContent = '已开放 ' + on + ' / ' + total + ' 个页面';
      }
      host.querySelectorAll('.feature-group[data-order-group]').forEach(function (group) {
        const gid = group.getAttribute('data-order-group');
        group.querySelectorAll('.feat-chip .feat-move').forEach(function (btn) {
          btn.addEventListener('click', function (ev) {
            ev.preventDefault(); ev.stopPropagation();
            const chip = btn.closest('.feat-chip');
            const ids = order[gid];
            const idx = ids.indexOf(chip.getAttribute('data-child-id'));
            const to = idx + Number(btn.getAttribute('data-move'));
            if (idx < 0 || to < 0 || to >= ids.length) return;
            const t = ids[idx]; ids[idx] = ids[to]; ids[to] = t;
            const wrap = group.querySelector('.feature-children');
            ids.forEach(function (id) { const n = wrap.querySelector('[data-child-id="' + id + '"]'); if (n) wrap.appendChild(n); });
            wrap.querySelectorAll('.feat-chip').forEach(function (c, i) {
              const up = c.querySelector('[data-move="-1"]'), down = c.querySelector('[data-move="1"]');
              if (up) up.disabled = i === 0;
              if (down) down.disabled = i === ids.length - 1;
            });
            $('features-result').textContent = ' 有未保存的修改';
          });
        });
      });
      host.querySelectorAll('[data-feature-key]').forEach(function (input) {
        input.addEventListener('change', function () { draft[input.dataset.featureKey] = input.checked; $('features-result').textContent = ' 有未保存的修改'; sync(); });
      });
      if (bypassBox) bypassBox.addEventListener('change', function () { $('features-result').textContent = ' 有未保存的修改'; });
      // 搜索：按页面名 / 子项名过滤卡片
      const search = $('feat-search');
      if (search) {
        search.addEventListener('input', function () {
          const q = search.value.trim().toLowerCase();
          host.querySelectorAll('.feature-group').forEach(function (group) {
            const txt = group.textContent.toLowerCase();
            group.style.display = (!q || txt.indexOf(q) >= 0) ? '' : 'none';
          });
        });
      }
      const setAll = function (v) {
        host.querySelectorAll('[data-feature-key]').forEach(function (input) { input.checked = v; draft[input.dataset.featureKey] = v; });
        $('features-result').textContent = ' 有未保存的修改';
        sync();
      };
      if ($('feat-open-all')) $('feat-open-all').addEventListener('click', function () { setAll(true); });
      if ($('feat-close-all')) {
        $('feat-close-all').addEventListener('click', function () {
          confirmModalLocal('确定把「所有页面与单项操作」都设为关闭吗？保存后所有玩家将无法钓鱼、交易与买卖。' +
            '（已开启管理员穿透时，管理员本人仍可操作。）').then(function (ok) { if (ok) setAll(false); });
        });
      }
      sync();
      $('features-save').onclick = function () {
        const button = this; button.disabled = true;
        const changes = {};
        Object.keys(draft).forEach(function (key) { if (draft[key] !== r.data.features[key]) changes[key] = draft[key]; });
        if (bypassBox) changes.adminBypass = bypassBox.checked;
        if (!Object.keys(changes).length && JSON.stringify(order) === JSON.stringify(r.data.featureOrder || {})) { button.disabled = false; $('features-result').textContent = ' 没有修改'; return; }
        adminApi('POST', '/api/admin/features', { token: token, features: changes, featureOrder: order }).then(function (saved) {
          button.disabled = false;
          if (view !== 'features') return;
          if (!saved || !saved.ok) { $('features-result').textContent = ' 保存失败：' + ((saved && saved.data && saved.data.error) || '请重试'); return; }
          toast('功能开关已保存，在线玩家已同步'); renderFeatures();
        });
      };
    });
  }
  // ⛵ 远洋配置（v0.19.0）：船级表 / 海图 / 临时海域 / 海上事件概率。
  // 保存走通用 settings 通道（world.seaCfg），立即生效并落盘；玩家端随 /api/sea 轮询（≤8 秒）同步。
  // ---- v0.21.0 编队管理：全服队伍一览 + 解散 ----
  function renderPartyMgr() {
    const main = $('main');
    main.innerHTML = '<h2>⚓ 编队管理</h2>' +
      '<div class="hint" style="margin-bottom:12px">全服编队运行期状态（不落盘，服务器重启后清空）。' +
      '编队上限 4 人、邀请限互为好友；解散即时生效并通知全部成员。</div>' +
      '<div id="party-body" class="panel">加载中…</div>';
    function load() {
      adminApi('GET', '/api/admin/parties?token=' + encodeURIComponent(token)).then(function (r) {
        const body = $('party-body');
        if (!body || view !== 'party') return;
        if (!r.ok || !r.data || !r.data.ok) { body.innerHTML = '<div class="hint">' + ((r.data && r.data.error) || '加载失败') + '</div>'; return; }
        const list = r.data.parties || [];
        if (!list.length) { body.innerHTML = '<div class="hint">当前没有编队。玩家在「社交 · 编队」创建队伍后这里会出现。</div>'; return; }
        body.innerHTML = '<table class="tbl"><thead><tr><th>队长</th><th>成员</th><th>人数</th><th>操作</th></tr></thead><tbody>' +
          list.map(function (pt) {
            return '<tr><td><b>' + esc(pt.leaderName || pt.leader) + '</b></td>' +
              '<td>' + esc(pt.members.map(function (m) { return m.name; }).join('、')) + '</td>' +
              '<td class="num">' + pt.members.length + '/' + pt.max + '</td>' +
              '<td><button class="btn mini danger" data-pid="' + esc(pt.id) + '">解散</button></td></tr>';
          }).join('') + '</tbody></table>';
        body.querySelectorAll('[data-pid]').forEach(function (b) {
          b.onclick = function () {
            b.disabled = true;
            adminApi('POST', '/api/admin/party/disband', { token: token, id: b.getAttribute('data-pid') }).then(function (rr) {
              if (!rr.ok) { toast((rr.data && rr.data.error) || '解散失败', true); b.disabled = false; return; }
              toast('已解散该编队'); load();
            });
          };
        });
      });
    }
    load();
  }
  function renderSeaCfg() {
    const main = $('main');
    main.innerHTML = '<h2>⛵ 远洋配置</h2>' +
      '<div class="hint" style="margin-bottom:12px">远洋玩法（船升级 / 海图 / 临时海域 / 海上事件）的运行期参数，保存即生效并落盘；' +
      '玩家端 ≤8 秒内同步。钓点掉落池在「🎣 钓点管理」里按钓点单独编辑（远洋 3 钓点也在其中）。</div>' +
      '<div id="sea-body" class="panel">加载中…</div>';
    loadWorldCfg(true).then(function (cfg) {
      if (!cfg || view !== 'sea') return;
      drawSeaCfg(cfg);
    });
  }
  function seaNum(id, min, max, dflt) {
    let v = Math.floor(Number(($(id) || {}).value));
    if (!isFinite(v)) v = dflt;
    return Math.min(max, Math.max(min, v));
  }
  function seaFloat(id, min, max, dflt) { // v0.21.0：漩涡/沉船概率支持 0.5 步进
    let v = Number(($(id) || {}).value);
    if (!isFinite(v)) v = dflt;
    return Math.min(max, Math.max(min, v));
  }
  function drawSeaCfg(cfg) {
    const body = $('sea-body');
    if (!body) return;
    const ship = cfg.ship || { levels: [{ name: '' }, { name: '' }, { name: '' }, { name: '' }, { name: '' }], xpNeed: [0, 0, 0, 0, 0], upCoins: [0, 0, 0, 0, 0], upScale: [0, 0, 0, 0, 0] };
    const sea = cfg.sea || { chartCost: 3, zoneTtlMin: 120, zoneMax: 3, events: { storm: 5, bounty: 6, school: 6, whirlpool: 3, wreck: 1.5, bountyDouble: 30 }, anchor: { coins: 50000, scales: 3, maxTimes: 3, extendMin: 1440 }, nightglow: { on: true, from: 20, to: 23, rare: 15 } };
    const lv = ship.levels, XN = ship.xpNeed, UC = ship.upCoins, US = ship.upScale;
    const ev = sea.events || {};
    // 出厂兜底表：只在服务端没给 quests 时使用（正常都走 /api/admin/world 的当前生效值）
    const quests = Array.isArray(sea.quests) && sea.quests.length ? sea.quests : [
      { id: 'q_ocean_catch', title: '远洋渔汛：在远洋钓上 15 条渔获', kind: 'catch_ocean', need: 15, reward: { coins: 50000, items: { deepscale: 3, relic: 5 } } },
      { id: 'q_zone_catch', title: '探索未知：在临时海域钓上 10 条渔获', kind: 'catch_zone', need: 10, reward: { coins: 80000, items: { dragonpearl: 1 } } },
      { id: 'q_deadly_catch', title: '直面凶险：在凶险海域钓上 3 条渔获', kind: 'catch_deadly', need: 3, reward: { coins: 100000, items: { deepscale: 4 } } },
      { id: 'q_big_catch', title: '大物猎人：钓上 2 条大型或巨型海鱼', kind: 'catch_big_ocean', need: 2, reward: { coins: 200000, items: { chest_deep: 1 } } },
      { id: 'q_tide_hunter', title: '潮汐寻宝：撞上 3 次漂流宝箱或沉船残骸', kind: 'sea_event', need: 3, reward: { coins: 60000, items: { tide_sand: 5, relic: 8 } } },
      { id: 'q_voyage', title: '整装出航：发现 2 片新的临时海域', kind: 'voyage', need: 2, reward: { coins: 30000, chartfrag: 4 } },
      { id: 'q_submit_scale', title: '上贡鳞片：上交 8 片深海鳞片', kind: 'submit_deepscale', need: 1, submitNeed: 8, reward: { coins: 150000, items: { dragonpearl: 2 } } },
    ];
    const rows = [];
    for (let i = 0; i < 5; i++) {
      const nextName = i < 4 ? '<input id="sea-name-' + (i + 1) + '" class="ipt mk-num" type="text" maxlength="12" value="' + esc(lv[i + 1] ? lv[i + 1].name : '') + '" title="升到 ' + (i + 2) + ' 级后的船名（留空 = 保持默认）">' : '<span class="hint">满级</span>';
      const cost = i < 4 ? '<td class="num"><input id="sea-coins-' + i + '" class="ipt mk-num" type="number" min="0" step="1" value="' + UC[i] + '"></td>' +
        '<td class="num"><input id="sea-scale-' + i + '" class="ipt mk-num" type="number" min="0" step="1" value="' + US[i] + '"></td>'
        : '<td class="num hint">—</td><td class="num hint">—</td>';
      rows.push('<tr><td><b>' + (i + 1) + ' 级</b></td>' +
        '<td><input id="sea-name-' + i + '" class="ipt" type="text" maxlength="12" value="' + esc(lv[i] ? lv[i].name : '') + '" title="当前级船名（留空 = 保持默认）"></td>' +
        '<td class="num">' + (i < 4 ? '<input id="sea-xp-' + i + '" class="ipt mk-num" type="number" min="0" step="1" value="' + XN[i] + '">' : '<span class="hint">—</span>') + '</td>' +
        cost + '</tr>');
    }
    body.innerHTML =
      '<h3 style="margin-top:0">🚤 船级表（1~5 级）</h3>' +
      '<div class="hint" style="margin-bottom:8px">升级需「远洋经验 ≥ 目标值 + 金币 + 深海鳞片」三条件同时满足；经验只在远洋/临时海域钓到东西时 +1，只升不降。</div>' +
      '<table class="tbl"><thead><tr><th>级</th><th>船名</th><th class="num">升到下一级所需经验</th><th class="num">升级金币</th><th class="num">升级鳞片</th></tr></thead><tbody>' +
      rows.join('') + '</tbody></table>' +
      '<h3>🗺 海图与临时海域</h3>' +
      '<div class="mgr-row"><span class="ch-fix"><label>海图成本（碎片/张）</label>' +
      '<input id="sea-chartcost" class="ipt mk-num" type="number" min="1" max="999" step="1" value="' + sea.chartCost + '"></span>' +
      '<span class="ch-fix"><label>海域存续（分钟）</label>' +
      '<input id="sea-ttl" class="ipt mk-num" type="number" min="5" max="1440" step="1" value="' + sea.zoneTtlMin + '"></span>' +
      '<span class="ch-fix"><label>同时存在上限</label>' +
      '<input id="sea-zonemax" class="ipt mk-num" type="number" min="1" max="10" step="1" value="' + sea.zoneMax + '"></span></div>' +
      '<h3>🎲 海上随机事件（每竿掷骰，%）</h3>' +
      '<div class="hint" style="margin-bottom:8px">三项之和建议 ≤ 30：超出会明显侵蚀正常产出。风暴 = 渔获脱钩；漂流宝箱 = 掉海图碎片；鱼群 = 同款渔获再 +1。</div>' +
      '<div class="mgr-row">' +
      '<span class="ch-fix"><label>⛈ 风暴（脱钩）</label><input id="sea-ev-storm" class="ipt mk-num" type="number" min="0" max="50" step="1" value="' + (ev.storm || 0) + '"></span>' +
      '<span class="ch-fix"><label>📦 漂流宝箱</label><input id="sea-ev-bounty" class="ipt mk-num" type="number" min="0" max="50" step="1" value="' + (ev.bounty || 0) + '"></span>' +
      '<span class="ch-fix"><label>🐟 鱼群</label><input id="sea-ev-school" class="ipt mk-num" type="number" min="0" max="50" step="1" value="' + (ev.school || 0) + '"></span>' +
      '<span class="ch-fix"><label>📦 宝箱双倍碎片</label><input id="sea-ev-double" class="ipt mk-num" type="number" min="0" max="100" step="1" value="' + (ev.bountyDouble || 0) + '"></span>' +
      '<span class="ch-fix"><label>🌀 漩涡</label><input id="sea-ev-whirl" class="ipt mk-num" type="number" min="0" max="50" step="0.5" value="' + (ev.whirlpool != null ? ev.whirlpool : 3) + '"></span>' +
      '<span class="ch-fix"><label>🚢 沉船残骸</label><input id="sea-ev-wreck" class="ipt mk-num" type="number" min="0" max="50" step="0.5" value="' + (ev.wreck != null ? ev.wreck : 1.5) + '"></span></div>' +
      '<h3>⚓ 锚地与夜光潮（v0.21.0）</h3>' +
      '<div class="hint" style="margin-bottom:8px">锚地 = 临时海域付费续期并附加增益（每片海域限次数）；夜光潮 = 每日固定时段给全部临时海域附加稀有度加成。</div>' +
      '<div class="mgr-row">' +
      '<span class="ch-fix"><label>锚地金币</label><input id="sea-anc-coins" class="ipt mk-num" type="number" min="0" max="1000000000" step="1" value="' + ((sea.anchor || {}).coins != null ? sea.anchor.coins : 50000) + '"></span>' +
      '<span class="ch-fix"><label>锚地鳞片</label><input id="sea-anc-scales" class="ipt mk-num" type="number" min="0" max="999" step="1" value="' + ((sea.anchor || {}).scales != null ? sea.anchor.scales : 3) + '"></span>' +
      '<span class="ch-fix"><label>每片限次</label><input id="sea-anc-times" class="ipt mk-num" type="number" min="0" max="30" step="1" value="' + ((sea.anchor || {}).maxTimes != null ? sea.anchor.maxTimes : 3) + '"></span>' +
      '<span class="ch-fix"><label>续期（分钟）</label><input id="sea-anc-extend" class="ipt mk-num" type="number" min="5" max="10080" step="1" value="' + ((sea.anchor || {}).extendMin != null ? sea.anchor.extendMin : 1440) + '"></span>' +
      '<span class="ch-fix"><label>🌌 夜光潮开</label><select id="sea-ng-on" class="ipt mk-num"><option value="1"' + ((sea.nightglow || {}).on !== false ? ' selected' : '') + '>开</option><option value="0"' + ((sea.nightglow || {}).on === false ? ' selected' : '') + '>关</option></select></span>' +
      '<span class="ch-fix"><label>夜光潮稀有%</label><input id="sea-ng-rare" class="ipt mk-num" type="number" min="0" max="100" step="1" value="' + ((sea.nightglow || {}).rare != null ? sea.nightglow.rare : 15) + '"></span></div>' +
      '<h3>🏅 每日悬赏（按条编辑，不能增删条目）</h3>' +
      '<div class="hint" style="margin-bottom:8px">每天从奖池随机 3 条。<b>需求类型</b>决定这条悬赏怎么计数（选「上交指定物品」时另填要交的物品与数量，' +
      '该条进度按持有量实时判定）；<b>奖励</b> = 金币 + 任意材料/宝匣（可加多行）。标题 ≤40 字。<br>' +
      '<label>悬赏刷新时刻（本地小时 0-23）</label><input id="sea-q-reset" class="ipt mk-num" type="number" min="0" max="23" step="1" value="' + ((sea.questResetHour != null) ? sea.questResetHour : 0) + '"></div>' +
      '<div id="sea-quests"></div>' +

      '<div class="mgr-row" style="margin-top:10px"><button class="btn primary" id="sea-save">保存远洋配置</button>' +
      '<button class="btn" id="sea-reset" style="margin-left:8px">恢复出厂</button>' +
      '<span id="sea-state" class="hint" style="margin-left:10px"></span></div>';
    // ---- 悬赏逐条编辑器（v0.21.2）----
    // 草稿在 questDraft（模块作用域内）：增删奖励行、切需求类型都会重绘这一块，
    // 重绘前先 syncQuestDraft() 把输入框里的值收回草稿，否则正在编辑的标题会被刷掉。
    let questDraft = (sea.quests || []).map(questToDraft);
    function questToDraft(q) {
      const rw = q.reward || {};
      const sub = GameData.seaQuestSubmitOf(q) || { id: 'deepscale', count: 8 };
      const items = [];
      ['chartfrag', 'deepscale'].forEach(function (id) {   // 旧字段（模板里 q_voyage 有 chartfrag）也并到奖励行里
        const n = Math.floor(Number(rw[id]) || 0);
        if (n > 0) items.push({ id: id, qty: n });
      });
      Object.keys(rw.items || {}).forEach(function (id) {
        const n = Math.floor(Number(rw.items[id]) || 0);
        if (n > 0 && GameData.isSeaQuestRewardId(id)) items.push({ id: GameData.normalizeItemId(id), qty: n });
      });
      return { id: q.id, title: q.title || '', kind: q.kind || 'catch_ocean', need: q.need != null ? q.need : 1,
        submitId: sub.id, submitCount: sub.count, coins: rw.coins != null ? rw.coins : 0, items: items };
    }
    const rewardOpts = GameData.rewardItemChoices();
    function itemOptsHtml(sel) {
      const groups = [['material', '材料'], ['chest', '宝匣']];
      return groups.map(function (gr) {
        const opts = rewardOpts.filter(function (c) { return c.kind === gr[0]; })
          .map(function (c) { return '<option value="' + esc(c.id) + '"' + (c.id === sel ? ' selected' : '') + '>' + esc(c.name) + '</option>'; });
        return opts.length ? '<optgroup label="' + gr[1] + '">' + opts.join('') + '</optgroup>' : '';
      }).join('');
    }
    function syncQuestDraft() {
      questDraft.forEach(function (q, qi) {
        const g = function (cls) { const el = $('sea-q-' + cls + '-' + qi); return el ? el.value : null; };
        if (g('title') != null) q.title = g('title').slice(0, 40);
        if (g('kind') != null) q.kind = g('kind');
        if (g('need') != null) q.need = Number(g('need')) || 1;
        if (g('coins') != null) q.coins = Number(g('coins')) || 0;
        if (g('subitem') != null) q.submitId = g('subitem');
        if (g('subcount') != null) q.submitCount = Number(g('subcount')) || 1;
        q.items.forEach(function (it, ii) {
          const s = $('sea-q-item-' + qi + '-' + ii), n = $('sea-q-qty-' + qi + '-' + ii);
          if (s) it.id = s.value;
          if (n) it.qty = Number(n.value) || 0;
        });
      });
    }
    function drawQuestTable() {
      const host = $('sea-quests');
      if (!host) return;
      host.innerHTML = questDraft.map(function (q, qi) {
        return '<div class="q-card">' +
          '<div class="q-head">' +
          '<input id="sea-q-title-' + qi + '" class="ipt q-title" type="text" maxlength="40" value="' + esc(q.title) + '" title="玩家端显示的悬赏标题">' +
          '<span class="ch-fix"><label>需求类型</label><select id="sea-q-kind-' + qi + '" class="ipt q-kind">' +
          GameData.SEA_QUEST_KINDS.map(function (k) {
            return '<option value="' + k.id + '"' + (k.id === q.kind ? ' selected' : '') + '>' + esc(k.name) + '</option>';
          }).join('') + '</select></span>' +
          '<span class="ch-fix"><label>' + esc((GameData.SEA_QUEST_KINDS.find(function (k) { return k.id === q.kind; }) || {}).unit ? '需求（' + GameData.SEA_QUEST_KINDS.find(function (k) { return k.id === q.kind; }).unit + '）' : '需求') + '</label>' +
          // 上交类只交一次（服务端也会强制 need=1）：需求次数对上交类没有意义
          (q.kind === 'submit'
            ? '<input id="sea-q-need-' + qi + '" class="ipt mk-num" type="number" value="1" disabled title="上交类固定为交一次">'
            : '<input id="sea-q-need-' + qi + '" class="ipt mk-num" type="number" min="1" max="999" step="1" value="' + esc(q.need) + '">') + '</span>' +
          (q.kind === 'submit'
            ? '<span class="ch-fix"><label>上交物品</label><select id="sea-q-subitem-' + qi + '" class="ipt q-sub-item">' + itemOptsHtml(q.submitId) + '</select></span>' +
              '<span class="ch-fix"><label>上交数量</label><input id="sea-q-subcount-' + qi + '" class="ipt mk-num" type="number" min="1" max="999" step="1" value="' + esc(q.submitCount) + '"></span>'
            : '') +
          '<span class="ch-fix"><label>金币</label><input id="sea-q-coins-' + qi + '" class="ipt mk-num" type="number" min="0" step="1" value="' + esc(q.coins) + '"></span>' +
          '</div>' +
          '<div class="q-rewards"><span class="hint">奖励物品</span>' +
          q.items.map(function (it, ii) {
            return '<span class="ch-fix q-item-row"><select id="sea-q-item-' + qi + '-' + ii + '" class="ipt q-item">' + itemOptsHtml(it.id) + '</select>' +
              '<input id="sea-q-qty-' + qi + '-' + ii + '" class="ipt mk-num" type="number" min="0" max="999" step="1" value="' + esc(it.qty) + '" title="数量（0 = 不发）">' +
              '<button class="btn mini" data-qdel="' + qi + ':' + ii + '" title="删掉这条奖励">✕</button></span>';
          }).join('') +
          '<button class="btn mini" data-qadd="' + qi + '">＋ 加奖励物品</button>' +
          '<span class="hint">物品限材料 / 宝匣；数量 0 表示不发</span></div>' +
          '</div>';
      }).join('');

      host.querySelectorAll('select[id^="sea-q-kind-"]').forEach(function (sel) {
        sel.onchange = function () { syncQuestDraft(); drawQuestTable(); };   // 切成上交类要立刻显示「上交物品」两个框
      });
      host.querySelectorAll('[data-qadd]').forEach(function (b) {
        b.onclick = function () {
          syncQuestDraft();
          const q = questDraft[+b.getAttribute('data-qadd')];
          q.items.push({ id: 'deepscale', qty: 1 });
          drawQuestTable();
        };
      });
      host.querySelectorAll('[data-qdel]').forEach(function (b) {
        b.onclick = function () {
          syncQuestDraft();
          const parts = b.getAttribute('data-qdel').split(':');
          questDraft[+parts[0]].items.splice(+parts[1], 1);
          drawQuestTable();
        };
      });
    }
    drawQuestTable();
    $('sea-save').onclick = function () { saveSeaCfg(false); };
    $('sea-reset').onclick = function () { saveSeaCfg(true); };
    function seaName(id) { const el = $(id); return el && el.value.trim() ? el.value.trim() : null; }
    function saveSeaCfg(reset) {
      if (!reset) syncQuestDraft();   // 悬赏那一块的输入框值先收回草稿再提交
      const payload = reset ? {} : {
        ship: {
          names: [0, 1, 2, 3, 4].map(function (i) { return seaName('sea-name-' + i); }),
          xpNeed: [0, 1, 2, 3].map(function (i) { return seaNum('sea-xp-' + i, 0, 1e10, XN[i]); }).concat([560]),
          upCoins: [0, 1, 2, 3].map(function (i) { return seaNum('sea-coins-' + i, 0, 1e10, UC[i]); }).concat([500000]),
          upScale: [0, 1, 2, 3].map(function (i) { return seaNum('sea-scale-' + i, 0, 1e10, US[i]); }).concat([90]),
        },
        sea: {
          chartCost: seaNum('sea-chartcost', 1, 999, 3),
          zoneTtlMin: seaNum('sea-ttl', 5, 1440, 120),
          zoneMax: seaNum('sea-zonemax', 1, 10, 3),
          events: {
            storm: seaNum('sea-ev-storm', 0, 50, 5),
            bounty: seaNum('sea-ev-bounty', 0, 50, 6),
            school: seaNum('sea-ev-school', 0, 50, 6),
            whirlpool: seaNum('sea-ev-whirl', 0, 50, 3),
            wreck: seaFloat('sea-ev-wreck', 0, 50, 1.5),
            bountyDouble: seaNum('sea-ev-double', 0, 100, 30),
          },
          anchor: {
            coins: seaNum('sea-anc-coins', 0, 1e9, 50000),
            scales: seaNum('sea-anc-scales', 0, 999, 3),
            maxTimes: seaNum('sea-anc-times', 0, 30, 3),
            extendMin: seaNum('sea-anc-extend', 5, 10080, 1440),
          },
          nightglow: {
            on: ($('sea-ng-on') || {}).value !== '0',
            rare: seaNum('sea-ng-rare', 0, 100, 15),
          },
          questResetHour: seaNum('sea-q-reset', 0, 23, 0),
          quests: questDraft.map(function (q) {
            const items = {};
            (q.items || []).forEach(function (it) {
              const id = GameData.normalizeItemId(it.id);
              const n = Math.max(0, Math.min(999, Math.floor(Number(it.qty) || 0)));
              if (GameData.isSeaQuestRewardId(id) && n > 0) items[id] = (items[id] || 0) + n;
            });
            const out = { id: q.id, title: (String(q.title || '').trim().slice(0, 40)) || q.id,
              kind: q.kind, need: Math.max(1, Math.min(999, Math.floor(Number(q.need) || 1))),
              // chartfrag / deepscale 显式写 0：奖励物品一律走 items，避免与模板里的旧值叠加
              reward: { coins: Math.max(0, Math.floor(Number(q.coins) || 0)), chartfrag: 0, deepscale: 0 } };
            if (Object.keys(items).length) out.reward.items = items;
            if (q.kind === 'submit') {
              out.submit = { id: GameData.normalizeItemId(q.submitId), count: Math.max(1, Math.min(999, Math.floor(Number(q.submitCount) || 1))) };
            }
            return out;
          }),
        },
      };
      adminApi('POST', '/api/admin/settings', { token: token, seaCfg: payload }).then(function (r) {
        if (!r.ok) { toast((r.data && r.data.error) || '保存失败', true); return; }
        worldCfg = null;
        setHint('sea-state', '<span style="color:var(--ok)">已保存，立即生效（玩家端 ≤8 秒同步）</span>');
        toast('⛵ 远洋配置已保存');
      });
    }
  }

  // ================================
  // Wiki 攻略热更新与用户投稿审核
  // ================================
  let wikiOfficialRevision = 1;
  let wikiReviewStatus = 'pending';
  function renderWiki() {
    const main = $('main');
    main.innerHTML = '<h2>📚 Wiki 攻略管理</h2>' +
      '<div class="hint" style="margin-bottom:12px">官方攻略可热更新；用户投稿当前为自动通过（提交后立即公开，可在“全部”里删除）。如需人工审核，用 WIKI_GUIDE_AUTO_APPROVE=0 重启服务端。两者互不覆盖。</div>' +
      '<div class="panel wiki-panel">' +
      '<div class="mgr-row"><label>官方内容</label><span id="wiki-meta" class="hint">加载中…</span>' +
      '<span style="flex:1"></span><button class="btn mini" id="wiki-refresh">刷新</button>' +
      '<button class="btn mini" id="wiki-format">格式化</button>' +
      '<button class="btn mini danger" id="wiki-reset">恢复内置</button>' +
      '<button class="btn primary" id="wiki-save">保存并发布</button></div>' +
      '<div id="wiki-list" class="wiki-list">加载中…</div>' +
      '<textarea id="wiki-json" class="ipt wiki-json" spellcheck="false" aria-label="官方 Wiki 内容 JSON"></textarea>' +
      '<div id="wiki-msg" class="hint"></div></div>' +
      '<div class="panel wiki-panel" style="margin-top:16px">' +
      '<div class="mgr-row"><label>用户投稿</label><span id="wiki-review-meta" class="hint">加载中…</span>' +
      '<span style="flex:1"></span><select id="wiki-review-status" class="ipt" aria-label="审核状态">' +
      '<option value="pending">待审核</option><option value="approved">已通过</option><option value="rejected">已拒绝</option><option value="all">全部</option></select>' +
      '<button class="btn mini" id="wiki-review-refresh">刷新</button></div>' +
      '<div id="wiki-review-list">加载中…</div></div>';
    function drawOfficial(data) {
      if (view !== 'wiki') return;
      const meta = $('wiki-meta'), list = $('wiki-list'), editor = $('wiki-json');
      if (!meta || !list || !editor) return;
      wikiOfficialRevision = data.officialRevision || data.revision || 1;
      const guides = data.guides || [], updates = data.updates || [];
      meta.textContent = '官方版本 ' + wikiOfficialRevision + ' · 攻略 ' + guides.length + ' 篇 · 更新记录 ' + updates.length + ' 条' +
        (data.updatedAt ? ' · 保存于 ' + new Date(data.updatedAt).toLocaleString('zh-CN') : ' · 内置内容');
      list.innerHTML = guides.map(function (g) {
        return '<div class="wiki-card"><b>' + esc(g.title) + '</b><span>' + esc(g.category || '-') + '</span>' +
          '<span>' + esc((g.sections || []).length) + ' 段</span><span>' + esc(g.updatedAt || '-') + '</span></div>';
      }).join('') || '<div class="hint">暂无官方攻略。</div>';
      editor.value = JSON.stringify({ guides: guides, updates: updates }, null, 2);
      setHint('wiki-msg', '');
    }
    function loadOfficial() {
      adminApi('GET', '/api/admin/wiki/content').then(function (r) {
        if (view !== 'wiki') return;
        if (!r.ok) { setHint('wiki-list', '官方内容加载失败：' + ((r.data && r.data.error) || 'HTTP ' + r.status)); return; }
        drawOfficial(r.data);
      });
    }
    function parseOfficialEditor() {
      const value = JSON.parse($('wiki-json').value);
      if (!value || !Array.isArray(value.guides) || !Array.isArray(value.updates)) throw new Error('顶层必须包含 guides 和 updates 数组');
      return value;
    }
    function saveOfficial(payload) {
      adminApi('POST', '/api/admin/wiki/content', Object.assign({ target: 'official-content' }, payload)).then(function (r) {
        if (view !== 'wiki') return;
        if (!r.ok) { setHint('wiki-msg', '保存失败：' + ((r.data && r.data.error) || 'HTTP ' + r.status)); return; }
        drawOfficial(r.data);
        toast('官方 Wiki 内容已发布');
      });
    }
    $('wiki-refresh').onclick = loadOfficial;
    $('wiki-format').onclick = function () {
      try { $('wiki-json').value = JSON.stringify(parseOfficialEditor(), null, 2); setHint('wiki-msg', '已格式化；尚未保存。'); }
      catch (e) { setHint('wiki-msg', 'JSON 格式错误：' + e.message); }
    };
    $('wiki-save').onclick = function () {
      const button = this;
      let content;
      try { content = parseOfficialEditor(); }
      catch (e) { setHint('wiki-msg', 'JSON 格式错误：' + e.message); return; }
      button.disabled = true; button.textContent = '保存中…';
      adminApi('POST', '/api/admin/wiki/content', { target: 'official-content', content: content, baseRevision: wikiOfficialRevision }).then(function (r) {
        button.disabled = false; button.textContent = '保存并发布';
        if (view !== 'wiki') return;
        if (!r.ok) { setHint('wiki-msg', '保存失败：' + ((r.data && r.data.error) || 'HTTP ' + r.status)); return; }
        drawOfficial(r.data);
        toast('官方 Wiki 内容已发布');
      });
    };
    $('wiki-reset').onclick = function () {
      confirmModalLocal('恢复内置官方攻略？当前线上官方攻略和更新记录会被替换，用户投稿不会受影响。').then(function (ok) {
        if (!ok) return;
        saveOfficial({ reset: true, baseRevision: wikiOfficialRevision });
      });
    };
    function drawReview(data) {
      if (view !== 'wiki') return;
      const meta = $('wiki-review-meta'), box = $('wiki-review-list');
      if (!meta || !box) return;
      const counts = data.counts || {};
      if (data.autoApprove && wikiReviewStatus === 'pending' && !(counts.pending || 0)) {
        wikiReviewStatus = 'approved';
        const sel = $('wiki-review-status'); if (sel) sel.value = 'approved';
        loadReview(); return;
      }
      meta.textContent = (data.autoApprove ? '自动审核已开启（投稿直接公开） · ' : '') +
        '投稿版本 ' + (data.revision || 1) + ' · 待审核 ' + (counts.pending || 0) +
        ' · 已通过 ' + (counts.approved || 0) + ' · 已拒绝 ' + (counts.rejected || 0);
      if (!(data.guides || []).length) { box.innerHTML = '<div class="hint">当前状态下暂无投稿。</div>'; return; }
      box.innerHTML = data.guides.map(function (g) {
        return '<article class="wiki-review-card"><header><b>' + esc(g.title) + '</b>' +
          '<span class="wiki-status ' + esc(g.status) + '">' + esc(g.status === 'pending' ? '待审核' : g.status === 'approved' ? (g.autoApproved ? '已通过（自动）' : '已通过') : '已拒绝') + '</span></header>' +
          '<div class="wiki-review-meta"><span>' + esc(g.authorName || '未知作者') + '</span><span>' + esc(g.category || '-') + '</span>' +
          '<span>' + new Date(g.submittedAt).toLocaleString('zh-CN') + '</span></div>' +
          '<p>' + esc(g.summary) + '</p>' +
          '<div class="wiki-review-body">' + (g.sections || []).map(function (s) {
            return '<section><h4>' + esc(s.h) + '</h4><div>' +
              (s.type === 'ol' || s.type === 'ul' ? '<' + s.type + '>' + (s.items || []).map(x => '<li>' + esc(x) + '</li>').join('') + '</' + s.type + '>' : esc(s.text)) +
              '</div></section>';
          }).join('') + '</div>' +
          ((g.reviewNote && g.status !== 'pending') ? '<div class="hint">审核备注：' + esc(g.reviewNote) + '</div>' : '') +
          '<div class="wiki-review-acts">' +
          (g.status === 'pending' ? '<button class="btn mini primary" data-wiki-approve="' + esc(g.id) + '">通过</button>' : '') +
          (g.status === 'pending' ? '<button class="btn mini" data-wiki-reject="' + esc(g.id) + '">拒绝</button>' : '') +
          '<button class="btn mini danger" data-wiki-delete="' + esc(g.id) + '">删除</button></div></article>';
      }).join('');
      box.querySelectorAll('[data-wiki-approve]').forEach(function (b) {
        b.onclick = function () {
          adminApi('POST', '/api/admin/wiki/guides/review', { target: b.getAttribute('data-wiki-approve'), action: 'approve', expectedStatus: 'pending', note: '' }).then(function (r) {
            if (!r.ok) { toast((r.data && r.data.error) || '审核失败', true); return; }
            toast('已通过该投稿'); loadReview();
          });
        };
      });
      box.querySelectorAll('[data-wiki-reject]').forEach(function (b) {
        b.onclick = function () {
          promptModalLocal({ title: '拒绝攻略', label: '拒绝原因', value: '', hint: '作者会在“我的攻略”看到这个原因。' }).then(function (note) {
            if (note == null) return null;
            if (!note.trim()) { toast('拒绝原因不能为空', true); return null; }
            return adminApi('POST', '/api/admin/wiki/guides/review', { target: b.getAttribute('data-wiki-reject'), action: 'reject', expectedStatus: 'pending', note: note }).then(function (r) {
              if (!r.ok) { toast((r.data && r.data.error) || '审核失败', true); return null; }
              toast('已拒绝该投稿'); loadReview();
            });
          });
        };
      });
      box.querySelectorAll('[data-wiki-delete]').forEach(function (b) {
        b.onclick = function () {
          promptModalLocal({ title: '删除投稿', label: '删除原因', value: '', hint: '删除为软删除，历史会保留。' }).then(function (reason) {
            if (reason == null) return null;
            if (!reason.trim()) { toast('删除原因不能为空', true); return null; }
            return adminApi('POST', '/api/admin/wiki/guides/delete', { target: b.getAttribute('data-wiki-delete'), reason: reason }).then(function (r) {
              if (!r.ok) { toast((r.data && r.data.error) || '删除失败', true); return null; }
              toast('已删除该投稿'); loadReview();
            });
          });
        };
      });
    }
    function loadReview() {
      adminApi('GET', '/api/admin/wiki/guides?status=' + encodeURIComponent(wikiReviewStatus)).then(function (r) {
        if (view !== 'wiki') return;
        if (!r.ok) { setHint('wiki-review-list', '投稿加载失败：' + ((r.data && r.data.error) || 'HTTP ' + r.status)); return; }
        drawReview(r.data);
      });
    }
    $('wiki-review-status').onchange = function () { wikiReviewStatus = this.value; loadReview(); };
    $('wiki-review-refresh').onclick = loadReview;
    loadOfficial();
    loadReview();
  }
  function switchView(v) {
    view = v;
    stopOverviewTimer();
    stopBannerTimer();
    renderNav();
    if (v === 'overview') return renderOverview();
    if (v === 'features') return renderFeatures();
    if (v === 'accountmgr') return renderAccountMgr();
    if (v === 'security') return renderSecurity();
    if (v === 'grounds') return renderGrounds();
    if (v === 'market') return renderMarket();
    if (v === 'gear'||v === 'component'||v === 'workshop') return window.AdminGear.render($('main'),adminApi,confirmModalLocal);
    if (v === 'fishsize') return renderFishSize();
    if (v === 'economy') return renderEconomy();
    if (v === 'chest') return renderChest();
    if (v === 'sea') return renderSeaCfg();
    if(v==='expedition'||v==='mail')return window.AdminOperations[v]($('main'),adminApi,confirmModalLocal);
    if (v === 'party') return renderPartyMgr();
    if (v === 'workshop') return renderWorkshop();
    if (v === 'mall') return renderMall();
    if (v === 'records') return renderRecords();
    if (v === 'formula') return renderFormula();
    if (v === 'notify') return renderNotify();
    if (v === 'banner') return renderBanner();
    if (v === 'wiki') return renderWiki();
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
    // 反馈规则折进 <details>：它是低频设置，常驻会白占半屏、把真正要看的反馈挤到下面。
    main.innerHTML = '<h2>📮 玩家反馈</h2>' +
      '<div class="hint" style="margin-bottom:10px">玩家提交的 Bug / 建议 / 平衡反馈，按时间倒序。改状态直接点下选框，奖励点 🎁。</div>' +
      '<details class="fb-rules"><summary>⚙ 反馈规则<span class="hint" id="fbc-now"></span></summary>' +
      '<div class="mgr-row" style="margin:10px 0 2px"><label>CD 时长</label><input id="fbc-cd" class="ipt mk-num" type="number" min="0" max="8760" step="0.5" />' +
      '<span class="hint">小时（0 = 不限制）</span>' +
      '<label class="hint" style="margin-left:12px">清空 CD 费用</label><input id="fbc-cost" class="ipt mk-num" type="number" min="0" step="1" />' +
      '<span class="hint">金币</span>' +
      '<button class="btn primary" id="fbc-save">保存</button><span id="fbc-state" class="hint"></span></div></details>' +
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
      if (r.data.cfg) {
        $('fbc-cd').value = r.data.cfg.cdHours; $('fbc-cost').value = r.data.cfg.skipCost;
        const now = $('fbc-now');
        if (now) now.textContent = '当前：CD ' + (Number(r.data.cfg.cdHours) > 0 ? r.data.cfg.cdHours + ' 小时' : '不限') +
          ' · 清空费用 ' + r.data.cfg.skipCost + ' 金币';
      }
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
      const countBy = function (fn) { return all.filter(fn).length; };
      const statusOf = function (f) { return f.status || 'submitted'; };
      const isRewarded = function (f) { return !!(f.reward && f.reward.coins); };
      const statHtml = '<div class="fb-stat">共 <b>' + all.length + '</b> 条' +
        Object.keys(STATUSES).map(function (k) {
          return '<span class="fb-stat-item"><i class="fb-dot ' + k + '"></i>' + esc(STATUSES[k]) + ' <b data-fb-count="' + k + '">' +
            countBy(function (f) { return statusOf(f) === k; }) + '</b></span>';
        }).join('') +
        '<span class="fb-stat-item">🎁 已奖励 <b>' + countBy(isRewarded) + '</b></span>' +
        (list.length === all.length ? '' : '<span class="fb-stat-item">筛选后 <b>' + list.length + '</b></span>') + '</div>';
      // 筛选改 chips：状态 / 类型各一键，顺带把条数写在上面（原来两个下拉要点两下才知道剩几条）
      const chip = function (key, active, label, n) {
        return '<button class="fb-chip' + (active ? ' on' : '') + '" data-fbf="' + esc(key) + '">' + esc(label) +
          (n == null ? '' : ' <span class="fb-chip-n">' + n + '</span>') + '</button>';
      };
      const barHtml = '<div class="fb-chips">' +
        chip('kind:all', fbFilterKind === 'all', '全部类型', null) +
        Object.keys(KIND).map(function (k) {
          return chip('kind:' + k, fbFilterKind === k, KIND[k], countBy(function (f) { return (f.kind || 'other') === k; }));
        }).join('') +
        '<span class="fb-sep"></span>' +
        chip('st:all', fbFilterStatus === 'all', '全部状态', null) +
        Object.keys(STATUSES).map(function (k) {
          return chip('st:' + k, fbFilterStatus === k, STATUSES[k], countBy(function (f) { return statusOf(f) === k; }));
        }).join('') +
        '<span class="fb-sep"></span>' +
        chip('reward:no', fbFilterReward, '🎁 仅未奖励', countBy(function (f) { return !isRewarded(f); })) +
        '</div>';
      if (!all.length) { box.innerHTML = '<div class="hint">暂无反馈。</div>'; return; }
      box.innerHTML = statHtml + barHtml + (list.length ? list.map(function (f) {
        const dt = new Date(f.t);
        const ts = dt.getFullYear() + '-' + ('0' + (dt.getMonth() + 1)).slice(-2) + '-' + ('0' + dt.getDate()).slice(-2) + ' ' +
          ('0' + dt.getHours()).slice(-2) + ':' + ('0' + dt.getMinutes()).slice(-2);
        const cur = statusOf(f);
        const opts = Object.keys(STATUSES).map(function (k) {
          return '<option value="' + k + '"' + (k === cur ? ' selected' : '') + '>' + esc(STATUSES[k]) + '</option>';
        }).join('');
        const rw = f.reward;
        return '<div class="fb-card">' +
          '<div class="fb-card-head"><span class="fb-kind ' + esc(f.kind || 'other') + '">' + esc(KIND[f.kind] || f.kind || '其他') + '</span>' +
          '<span class="fb-who">' + esc(f.name || f.key) + '</span>' +
          '<span class="fb-time">' + ts + (f.version ? ' · ' + esc(f.version) : '') + '</span>' +
          '<span class="fb-tail"><span class="fb-status ' + cur + '">' + esc(STATUSES[cur] || cur) + '</span>' +
          (rw && rw.coins ? '<span class="fb-reward">🎁 +' + rw.coins + '💰' + (rw.note ? '（' + esc(rw.note) + '）' : '') + '</span>' : '') +
          '</span></div>' +
          '<div class="fb-text">' + esc(f.text) + '</div>' +
          '<div class="fb-acts"><select class="ipt fb-status-sel" data-id="' + esc(f.id) + '" title="改处理状态">' + opts + '</select>' +
          '<button class="btn mini primary" data-reward="' + esc(f.id) + '" data-who="' + esc(f.name || f.key) + '">🪙 奖励金币</button>' +
          '<button class="btn mini danger" data-fbdel="' + esc(f.id) + '">🗑 删除</button>' +
          (f.statusBy ? '<span class="hint">由 ' + esc(f.statusBy) + ' 更新</span>' : '') + '</div></div>';
      }).join('') : '<div class="hint">没有符合筛选条件的反馈。</div>');
      box.querySelectorAll('[data-fbf]').forEach(function (b) {
        b.onclick = function () {
          const k = b.getAttribute('data-fbf');
          if (k === 'reward:no') fbFilterReward = !fbFilterReward;
          else if (k.indexOf('kind:') === 0) fbFilterKind = k.slice(5);
          else if (k.indexOf('st:') === 0) fbFilterStatus = k.slice(3);
          renderFeedback();
        };
      });
      box.querySelectorAll('[data-reward]').forEach(function (b) {
        b.onclick = function () { rewardFeedback(b.getAttribute('data-reward'), b.getAttribute('data-who')); };
      });
      // 删除单条反馈（v0.16.0）：二次确认 → 服务端删除 → 提交者在线时同步移除
      box.querySelectorAll('[data-fbdel]').forEach(function (b) {
        b.onclick = function () {
          const id = b.getAttribute('data-fbdel');
          const row = all.find(function (f) { return f.id === id; }) || {};
          confirmModalLocal('删除这条反馈？\n\n' + String(row.text || '').slice(0, 80) +
            '\n\n删除后不可恢复；提交者的历史列表里也会消失。').then(function (ok) {
            if (!ok) return;
            adminApi('POST', '/api/admin/feedback/del', { token: token, id: id }).then(function (rr) {
              if (!rr.ok) { toast((rr.data && rr.data.error) || '删除失败', true); return; }
              toast('已删除该条反馈'); renderFeedback();
            });
          });
        };
      });
      box.querySelectorAll('.fb-status-sel').forEach(function (sel) {
        sel.onchange = function () {
          const row = all.find(function (f) { return f.id === sel.getAttribute('data-id'); });
          const previous = row ? statusOf(row) : 'submitted';
          const next = sel.value;
          sel.disabled = true;
          adminApi('POST', '/api/admin/feedback/status', { token: token, id: sel.getAttribute('data-id'), status: next }).then(function (rr) {
            sel.disabled = false;
            if (!rr.ok) { sel.value = previous; toast((rr.data && rr.data.error) || '更新失败', true); return; }
            if (row) row.status = next;
            const card = sel.closest('.fb-card');
            const badge = card && card.querySelector('.fb-status');
            if (badge) { badge.className = 'fb-status ' + next; badge.textContent = STATUSES[next] || next; }
            let author = card && card.querySelector('.fb-acts > .hint');
            if (card && !author) { author = document.createElement('span'); author.className = 'hint'; card.querySelector('.fb-acts').appendChild(author); }
            if (author) author.textContent = '由 ' + me.name + ' 更新';
            Object.keys(STATUSES).forEach(function (k) {
              const count = countBy(function (f) { return statusOf(f) === k; });
              const stat = box.querySelector('[data-fb-count="' + k + '"]');
              const chipCount = box.querySelector('[data-fbf="st:' + k + '"] .fb-chip-n');
              if (stat) stat.textContent = count;
              if (chipCount) chipCount.textContent = count;
            });
            toast('反馈状态已更新为：' + (STATUSES[next] || next));
          }).catch(function () {
            sel.disabled = false; sel.value = previous; toast('更新失败，请重试', true);
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
  // ---- 概览·服务器热力图 ----
  // 曲线/热力格的区间、显隐开关放模块级：切页往返、5 秒轮询都不会把用户的开关重置。
  const HEAT_SERIES = [
    { id: 'online', name: '在线玩家', color: '#4da3ff' },
    { id: 'onlineMax', name: '在线峰值', color: '#ffb454', dash: [4, 3] },
    { id: 'fishing', name: '正在钓鱼', color: '#3ecf8e' },
    { id: 'listings', name: '市集挂单', color: '#b07cff' },
    { id: 'trades', name: '进行中交易', color: '#ff9d5c' },
    { id: 'users', name: '注册账号', color: '#8a94aa' },
  ];
  const HEAT_RANGES = [['1h', '1 小时'], ['6h', '6 小时'], ['24h', '24 小时'], ['7d', '7 天'], ['30d', '30 天']];
  const HL = { h: 240, padL: 42, padR: 14, padT: 12, padB: 26 };   // 曲线画布几何
  const HG = { h: 252, padL: 34, padR: 14, padT: 22, padB: 20 };   // 热力格画布几何
  const HEAT_REFRESH_MS = 20000;   // 概览每 5 秒轮询，曲线按 20 秒节流重拉（服务端 60 秒才多一个点）
  let heatRange = '24h';
  let heatMode = 'line';           // line | heat
  let heatOn = { online: true, onlineMax: true, fishing: true, listings: true, trades: true, users: false };
  let heatData = null;             // /api/admin/stats 最近一次结果
  let heatAt = 0;                  // 上次拉取时间
  let heatHover = -1;              // 曲线：悬停的数据点下标（-1 = 无）
  let heatCell = null;             // 热力格：悬停的 [星期, 小时]
  let heatFilter = { ground: '', spot: '' };   // v0.16.0：按钓场 / 钓点筛选（空 = 全服）
  let heatDraws = 0;               // 绘制计数（写到 canvas.dataset.draw，测试与排查用）
  // 画布按容器宽度与 DPR 重建，返回绘图上下文
  function heatCanvas(hh) {
    const cv = $('ov-chart');
    if (!cv) return null;
    const wrap = cv.parentNode;
    const w = Math.max(300, (wrap && wrap.clientWidth ? wrap.clientWidth : 600) - 2);
    const dpr = window.devicePixelRatio || 1;
    cv.style.width = w + 'px';
    cv.style.height = hh + 'px';
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(hh * dpr)) {
      cv.width = Math.round(w * dpr);
      cv.height = Math.round(hh * dpr);
    }
    const ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, hh);
    ctx.font = '11px "Microsoft YaHei", "PingFang SC", sans-serif';
    return { cv: cv, ctx: ctx, w: w, h: hh };
  }
  function heatP2(n) { return (n < 10 ? '0' : '') + n; }
  function heatTimeLabel(t, span) {
    const d = new Date(t);
    if (span <= 24 * 3600000) return heatP2(d.getHours()) + ':' + heatP2(d.getMinutes());
    return (d.getMonth() + 1) + '-' + d.getDate() + ' ' + heatP2(d.getHours()) + ':00';
  }
  // 曲线几何：X(t) / 绘图区，绘制与悬停命中都用它，保证坐标一致
  function heatLineGeo(w, data) {
    const plotW = Math.max(10, w - HL.padL - HL.padR);
    const plotH = Math.max(10, HL.h - HL.padT - HL.padB);
    const pts = (data && data.points) || [];
    const t0 = pts.length ? pts[0].t : 0;
    const t1 = pts.length ? Math.max(pts[pts.length - 1].t, t0 + 60000) : 1;
    return {
      pts: pts, t0: t0, t1: t1, plotW: plotW, plotH: plotH,
      X: function (t) { return HL.padL + (t - t0) / (t1 - t0) * plotW; },
    };
  }
  function drawHeatLine() {
    const c = heatCanvas(HL.h);
    if (!c) return;
    const ctx = c.ctx;
    const data = heatData;
    const geo = heatLineGeo(c.w, data);
    const pts = geo.pts;
    if (!pts.length) {
      ctx.fillStyle = 'rgba(216,224,238,0.55)';
      ctx.fillText('暂无样本——服务端每 60 秒记一条，稍后回来自动出现', HL.padL, HL.padT + 18);
      heatDraws++; c.cv.dataset.draw = String(heatDraws);
      return;
    }
    // 筛选口径（选了钓场 / 钓点）：只画一条「该钓点钓鱼人数」曲线，其余全局曲线不再混淆视听
    const filtered = !!(data.filter && (data.filter.ground || data.filter.spot));
    const vis = filtered
      ? [{ id: 'area', name: data.filter.areaLabel || '该区域钓鱼人数', color: '#3ecf8e' }]
      : HEAT_SERIES.filter(function (s) { return heatOn[s.id]; });
    let vmax = 1;
    pts.forEach(function (p) {
      vis.forEach(function (s) { const v = Number(p[s.id]) || 0; if (v > vmax) vmax = v; });
    });
    vmax = Math.max(1, vmax * 1.15);
    const Y = function (v) { return HL.padT + geo.plotH - v / vmax * geo.plotH; };
    // Y 轴刻度 + 横向网格
    ctx.textAlign = 'right';
    for (let i = 0; i <= 4; i++) {
      const v = vmax * i / 4;
      const y = Math.round(Y(v)) + 0.5;
      ctx.strokeStyle = 'rgba(255,255,255,0.07)';
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(HL.padL, y); ctx.lineTo(HL.padL + geo.plotW, y); ctx.stroke();
      ctx.fillStyle = 'rgba(216,224,238,0.5)';
      ctx.fillText(String(Math.round(v)), HL.padL - 6, y + 4);
    }
    // X 轴时间刻度
    ctx.textAlign = 'center';
    for (let i = 0; i <= 4; i++) {
      const t = geo.t0 + (geo.t1 - geo.t0) * i / 4;
      ctx.fillStyle = 'rgba(216,224,238,0.5)';
      ctx.fillText(heatTimeLabel(t, data.span), HL.padL + geo.plotW * i / 4, HL.h - HL.padB + 16);
    }
    // 折线：样本间隔超过 2.5 个桶就断线，避免把停机的空白连成一条假直线
    const gap = (data.step || 60000) * 2.5;
    vis.forEach(function (s) {
      ctx.strokeStyle = s.color;
      ctx.lineWidth = 1.6;
      ctx.setLineDash(s.dash || []);
      ctx.beginPath();
      let started = false, prevT = 0;
      pts.forEach(function (p) {
        const x = geo.X(p.t), y = Y(Number(p[s.id]) || 0);
        if (started && (p.t - prevT) > gap) { ctx.stroke(); ctx.beginPath(); started = false; }
        if (started) ctx.lineTo(x, y); else { ctx.moveTo(x, y); started = true; }
        prevT = p.t;
      });
      ctx.stroke();
      ctx.setLineDash([]);
      // 样本太少（新服刚开只有一两条）时折线没有长度，补个点让「有数据」看得见
      if (pts.length <= 2) {
        ctx.fillStyle = s.color;
        pts.forEach(function (p) {
          ctx.beginPath();
          ctx.arc(geo.X(p.t), Y(Number(p[s.id]) || 0), 2.6, 0, Math.PI * 2);
          ctx.fill();
        });
      }
    });
    // 悬停：竖线 + 各曲线上的点
    if (heatHover >= 0 && heatHover < pts.length) {
      const p = pts[heatHover];
      const x = geo.X(p.t);
      ctx.strokeStyle = 'rgba(255,255,255,0.28)';
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x, HL.padT); ctx.lineTo(x, HL.padT + geo.plotH); ctx.stroke();
      vis.forEach(function (s) {
        ctx.fillStyle = s.color;
        ctx.beginPath(); ctx.arc(x, Y(Number(p[s.id]) || 0), 3, 0, Math.PI * 2); ctx.fill();
      });
    }
    heatDraws++; c.cv.dataset.draw = String(heatDraws);
  }
  function drawHeatGrid() {
    const c = heatCanvas(HG.h);
    if (!c) return;
    const ctx = c.ctx;
    const data = heatData;
    const hasCell = !!(data && data.heat && data.heat.some(function (r) { return r.some(function (v) { return v != null; }); }));
    if (!hasCell) {
      ctx.fillStyle = 'rgba(216,224,238,0.55)';
      ctx.fillText('暂无样本——服务端每 60 秒记一条，稍后回来自动出现', HG.padL, HG.padT + 14);
      heatDraws++; c.cv.dataset.draw = String(heatDraws);
      return;
    }
    const heatMax = Math.max(1, data.heatMax);
    const cellW = Math.max(8, (c.w - HG.padL - HG.padR) / 24);
    const cellH = Math.max(8, (HG.h - HG.padT - HG.padB) / 7);
    const days = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
    ctx.textAlign = 'right';
    for (let wd = 0; wd < 7; wd++) {
      ctx.fillStyle = 'rgba(216,224,238,0.55)';
      ctx.fillText(days[wd], HG.padL - 6, HG.padT + cellH * wd + cellH / 2 + 4);
    }
    ctx.textAlign = 'center';
    for (let hh = 0; hh < 24; hh += 2) {
      ctx.fillStyle = 'rgba(216,224,238,0.55)';
      ctx.fillText(hh + '时', HG.padL + cellW * (hh + 0.5), HG.h - HG.padB + 15);
    }
    for (let wd = 0; wd < 7; wd++) {
      for (let hh = 0; hh < 24; hh++) {
        const v = data.heat[wd][hh];
        const x = HG.padL + cellW * hh, y = HG.padT + cellH * wd;
        if (v == null) ctx.fillStyle = 'rgba(255,255,255,0.03)';
        else ctx.fillStyle = 'rgba(77,163,255,' + (0.12 + 0.78 * Math.min(1, v / heatMax)).toFixed(3) + ')';
        ctx.fillRect(x + 1, y + 1, Math.max(1, cellW - 2), Math.max(1, cellH - 2));
        if (heatCell && heatCell[0] === wd && heatCell[1] === hh) {
          ctx.strokeStyle = '#fff';
          ctx.lineWidth = 1.5;
          ctx.strokeRect(x + 1.5, y + 1.5, Math.max(1, cellW - 3), Math.max(1, cellH - 3));
        }
      }
    }
    heatDraws++; c.cv.dataset.draw = String(heatDraws);
  }
  function heatDraw() { if (heatMode === 'heat') drawHeatGrid(); else drawHeatLine(); }
  // 悬停命中：曲线取最近的数据点，热力格取所在单元格
  function heatHit(x, y) {
    if (heatMode === 'heat') {
      const cv = $('ov-chart');
      if (!cv) return;
      const cellW = Math.max(8, (cv.clientWidth - HG.padL - HG.padR) / 24);
      const cellH = Math.max(8, (HG.h - HG.padT - HG.padB) / 7);
      const hh = Math.floor((x - HG.padL) / cellW), wd = Math.floor((y - HG.padT) / cellH);
      heatCell = (hh >= 0 && hh < 24 && wd >= 0 && wd < 7) ? [wd, hh] : null;
      heatHover = -1;
      return;
    }
    const cv = $('ov-chart');
    const data = heatData;
    if (!cv || !data || !data.points.length) { heatHover = -1; return; }
    const geo = heatLineGeo(cv.clientWidth, data);
    let best = -1, bestD = Infinity;
    geo.pts.forEach(function (p, i) { const d = Math.abs(geo.X(p.t) - x); if (d < bestD) { bestD = d; best = i; } });
    heatHover = best;
    heatCell = null;
  }
  function heatTipUpdate(x, y) {
    const tip = $('ov-tip');
    if (!tip) return;
    let html = '';
    if (heatMode === 'heat' && heatCell) {
      const wd = heatCell[0], hh = heatCell[1];
      const v = (heatData && heatData.heat[wd][hh]);
      const n = (heatData && heatData.heatN && heatData.heatN[wd][hh]) || 0;
      const days = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
      html = '<div class="hm-tip-t">' + days[wd] + ' ' + heatP2(hh) + ':00 - ' + heatP2(hh) + ':59</div>' +
        (v == null ? '无样本' : '平均在线 <b>' + v + '</b> 人<span style="color:var(--txt-dim)"> · ' + n + ' 个样本</span>');
    } else if (heatMode === 'line' && heatData && heatHover >= 0 && heatData.points[heatHover]) {
      const p = heatData.points[heatHover];
      html = '<div class="hm-tip-t">' + new Date(p.t).toLocaleString() + '</div>' +
        HEAT_SERIES.filter(function (s) { return heatOn[s.id]; }).map(function (s) {
          return '<div><i style="background:' + s.color + '"></i>' + s.name + '：<b>' + (Number(p[s.id]) || 0) + '</b></div>';
        }).join('');
    }
    if (!html) { tip.classList.remove('show'); return; }
    tip.innerHTML = html;
    tip.classList.add('show');
    const wrap = tip.parentNode;
    const w = wrap ? wrap.clientWidth : 0;
    const tw = tip.offsetWidth;
    tip.style.left = Math.max(0, Math.min(w - tw, x + 12)) + 'px';
    tip.style.top = Math.max(0, y + 12) + 'px';
  }
  function heatHint() {
    const hint = $('ov-chart-hint');
    if (!hint) return;
    const d = heatData;
    if (!d) { hint.textContent = '加载中…'; return; }
    const peak = (d.peak && d.peak.online) || 0;
    const peakAt = (d.peak && d.peak.t) ? '（' + new Date(d.peak.t).toLocaleString() + '）' : '';
    const rangeName = (HEAT_RANGES.filter(function (kv) { return kv[0] === d.range; })[0] || [null, d.range])[1];
    if (heatMode === 'heat') {
      hint.textContent = '色深 = 该时段平均在线人数（最深 ' + d.heatMax + ' 人，空样本为浅灰）· 覆盖最近 ' + d.heatDays +
        ' 天 · 悬停查看具体数值 · 历史峰值 ' + peak + ' 人' + peakAt;
      return;
    }
    const stepTxt = d.step >= 3600000 ? (d.step / 3600000) + ' 小时' : (d.step / 60000) + ' 分钟';
    const fTxt = (d.filter && (d.filter.ground || d.filter.spot))
      ? ' · 筛选口径：' + (d.filter.spot ? '钓点 ' + d.filter.spot.replace(':', '·') : '钓场 ' + d.filter.ground) + '（只统计该区域的钓鱼人数）'
      : '';
    hint.textContent = rangeName + '区间：' + d.points.length + ' 个采样桶（每桶 ' + stepTxt + '，桶内取均值；峰值线取桶内最高）' +
      ' · 采样 分钟 ' + d.samples.min + ' / 小时 ' + d.samples.hour + ' 条 · 历史峰值 ' + peak + ' 人' + peakAt +
      fTxt + ' · 每 ' + Math.round(HEAT_REFRESH_MS / 1000) + ' 秒刷新';
  }
  function heatLoad() {
    if (view !== 'overview') return;
    const q = '&ground=' + encodeURIComponent(heatFilter.ground || '') + '&spot=' + encodeURIComponent(heatFilter.spot || '');
    return adminApi('GET', '/api/admin/stats?range=' + heatRange + q + '&token=' + encodeURIComponent(token)).then(function (r) {
      if (!r.ok || view !== 'overview') return;
      heatData = r.data;
      heatAt = Date.now();
      heatFillFilters(r.data);
      const peakEl = document.querySelector('[data-stat="peak"]');
      if (peakEl) {
        peakEl.textContent = (r.data.peak && r.data.peak.online) || 0;
        peakEl.title = (r.data.peak && r.data.peak.t) ? '历史峰值时间：' + new Date(r.data.peak.t).toLocaleString() : '';
      }
      heatDraw();
      heatHint();
    });
  }
  // 填充钓场 / 钓点筛选下拉（保持已选值；钓点列表跟随钓场变化）
  function heatFillFilters(d) {
    const gSel = $('ov-filter-ground'), sSel = $('ov-filter-spot');
    if (!gSel || !sSel || !d || !d.grounds) return;
    if (gSel.options.length <= 1) {
      d.grounds.forEach(function (g) {
        const o = document.createElement('option'); o.textContent = g.name; o.value = g.id; gSel.appendChild(o);
      });
    }
    gSel.value = heatFilter.ground || '';
    // 钓点下拉：按当前钓场过滤（未选钓场 = 全部钓点）
    const cur = heatFilter.spot;
    sSel.innerHTML = '<option value="">全部钓点</option>';
    d.grounds.forEach(function (g) {
      if (heatFilter.ground && g.id !== heatFilter.ground) return;
      g.spots.forEach(function (sp) {
        const o = document.createElement('option');
        o.textContent = (heatFilter.ground ? '' : g.name + '·') + sp.name;
        o.value = sp.key;
        sSel.appendChild(o);
      });
    });
    if (cur && !Array.from(sSel.options).some(function (o) { return o.value === cur; })) heatFilter.spot = '';
    sSel.value = heatFilter.spot || '';
  }
  function heatPanelHtml() {
    return '<div class="panel">' +
      '<h3>🔥 服务器热力图 <span class="hint">在线 / 钓鱼 / 挂单 / 交易随时间的变化，曲线可逐条开关</span></h3>' +
      '<div class="hm-bar">' +
      '<span class="hm-group" id="ov-range">' + HEAT_RANGES.map(function (kv) {
        return '<button class="btn mini hm-rng' + (heatRange === kv[0] ? ' on' : '') + '" data-range="' + kv[0] + '">' + kv[1] + '</button>';
      }).join('') + '</span>' +
      '<span class="hm-group" id="ov-mode">' +
      '<button class="btn mini hm-md' + (heatMode === 'line' ? ' on' : '') + '" data-mode="line">📈 曲线</button>' +
      '<button class="btn mini hm-md' + (heatMode === 'heat' ? ' on' : '') + '" data-mode="heat">🌡️ 星期 × 小时热力格</button>' +
      '</span>' +
      // v0.16.0：按钓场 / 钓点筛选（只看某个钓点在同一时段的拥挤程度）
      '<span class="hm-group"><label class="hm-filter-label">钓场</label><select id="ov-filter-ground" class="ipt hm-sel"><option value="">全服</option></select>' +
      '<label class="hm-filter-label">钓点</label><select id="ov-filter-spot" class="ipt hm-sel"><option value="">全部钓点</option></select></span>' +
      '</div>' +
      '<div class="hm-legend" id="ov-legend">' + HEAT_SERIES.map(function (s) {
        return '<label class="hm-item' + (heatOn[s.id] ? '' : ' off') + '" data-series="' + s.id + '">' +
          '<input type="checkbox"' + (heatOn[s.id] ? ' checked' : '') + ' />' +
          '<i class="hm-chip" style="background:' + s.color + '"></i>' + s.name + '</label>';
      }).join('') + '</div>' +
      '<div class="hm-wrap" id="ov-wrap"><canvas id="ov-chart"></canvas><div class="hm-tip" id="ov-tip"></div></div>' +
      '<div class="hint" id="ov-chart-hint" style="margin-top:8px">加载中…</div>' +
      '</div>';
  }
  // 只在首次渲染时调用一次：之后 5 秒轮询只改数字，绝不重建（否则用户的曲线开关会被重置）
  function wireHeatPanel() {
    document.querySelectorAll('#ov-range .hm-rng').forEach(function (b) {
      b.addEventListener('click', function () {
        heatRange = b.getAttribute('data-range');
        document.querySelectorAll('#ov-range .hm-rng').forEach(function (x) { x.classList.toggle('on', x === b); });
        heatLoad();
      });
    });
    document.querySelectorAll('#ov-mode .hm-md').forEach(function (b) {
      b.addEventListener('click', function () {
        heatMode = b.getAttribute('data-mode');
        document.querySelectorAll('#ov-mode .hm-md').forEach(function (x) { x.classList.toggle('on', x === b); });
        heatHover = -1; heatCell = null;
        const tip = $('ov-tip'); if (tip) tip.classList.remove('show');
        heatDraw();
        heatHint();
      });
    });
    document.querySelectorAll('#ov-legend .hm-item').forEach(function (lab) {
      const cb = lab.querySelector('input');
      cb.addEventListener('change', function () {
        heatOn[lab.getAttribute('data-series')] = cb.checked;
        lab.classList.toggle('off', !cb.checked);
        heatDraw();
      });
    });
    const cv = $('ov-chart');
    if (cv) {
      cv.addEventListener('mousemove', function (e) {
        const box = cv.getBoundingClientRect();
        const x = e.clientX - box.left, y = e.clientY - box.top;
        heatHit(x, y);
        heatDraw();
        heatTipUpdate(x, y);
      });
      cv.addEventListener('mouseleave', function () {
        heatHover = -1; heatCell = null;
        const tip = $('ov-tip'); if (tip) tip.classList.remove('show');
        heatDraw();
      });
    }
  }
  // 窗口变宽变窄时重画（画布尺寸跟着容器走）
  window.addEventListener('resize', function () { if (view === 'overview' && $('ov-chart')) heatDraw(); });
  function renderOverview() {
    const main = $('main');
    main.innerHTML = '<h2>📊 服务器概览</h2><div id="ov-body">' +
      '<div class="stat-grid">' +
      '<div class="stat"><div class="v" data-stat="online">–</div><div class="k">在线玩家</div></div>' +
      '<div class="stat"><div class="v" data-stat="fishingCount">–</div><div class="k">正在钓鱼</div></div>' +
      '<div class="stat"><div class="v" data-stat="userCount">–</div><div class="k">注册账号</div></div>' +
      '<div class="stat"><div class="v" data-stat="listings">–</div><div class="k">市集挂单</div></div>' +
      '<div class="stat"><div class="v" data-stat="activeTrades">–</div><div class="k">进行中交易</div></div>' +
      '<div class="stat"><div class="v" data-stat="spots">–</div><div class="k">钓场 / 钓点</div></div>' +
      '<div class="stat"><div class="v" data-stat="peak">–</div><div class="k">历史峰值在线</div></div>' +
      '</div>' +
      heatPanelHtml() +
      '<div class="panel"><h3>当前生效配置</h3>' +
      '<div class="kv" id="ov-cfg">–</div>' +
      '<div class="hint" style="margin-top:8px">统计每 5 秒自动刷新；配置修改即时生效并广播给在线玩家。</div></div>' +
      '</div>';
    // 5 秒轮询只就地改数字：整块 innerHTML 重建会把曲线开关、区间选择与画布一起冲掉
    const load = function () {
      if (view !== 'overview') return;
      adminApi('GET', '/api/admin/overview?token=' + encodeURIComponent(token)).then(function (r) {
        if (!r.ok || view !== 'overview') return;
        const d = r.data;
        const set = function (k, v) {
          const el = document.querySelector('#ov-body [data-stat="' + k + '"]');
          if (el && String(el.textContent) !== String(v)) el.textContent = v;
        };
        set('online', d.online);
        set('fishingCount', d.fishingCount);
        set('userCount', d.userCount);
        set('listings', d.listings);
        set('activeTrades', d.activeTrades);
        set('spots', d.groundCount + ' / ' + d.spotCount);
        const lvName = (worldCfg && worldCfg.notifyLevels && worldCfg.notifyLevels[d.notifyLevel]) || d.notifyLevel;
        const cfg = $('ov-cfg');
        if (cfg) {
          cfg.innerHTML = '通知等级：<code>' + esc(d.notifyLevel) + '</code> — ' + esc(lvName) + '<br>' +
            '上钩公式：<code>' + esc(d.biteFormula) + '</code>';
        }
      });
      if (Date.now() - heatAt > HEAT_REFRESH_MS) heatLoad();   // 曲线按 20 秒节流刷新
    };
    wireHeatPanel();
    load();
    heatLoad();
    stopOverviewTimer();
    timer = setInterval(load, 5000);
  }

  // ================================
  // 账号管理（列表形式：改密码 / 改显示名 / 调整金币 / 管理员授权 / 删除 / 快照编辑背包）
  // 管理员授权原来是独立一页（「账号授权」），v0.11.6 起并入本页开关列，两页列表本就读同一份数据。
  // ================================
  // 账号管理：搜索与排序状态（模块级，切页/重绘间保留）
  let mgrQuery = '';
  let mgrSort = { key: 'createdAt', dir: 'desc' };
  let mgrRows = [];
  // v0.16.2：账号列表分页——账号多了以后一页铺到看不完（实测 127 个），改成每页 n 条、可翻页。
  // 每页条数在搜索框旁调（0 或留空 = 全部），并按本地记忆保存，下次打开还是你习惯的页长。
  let mgrPage = 1;
  const MGR_PS_DEFAULT = 50;
  let mgrPageSize = (function () {
    try {
      const raw = localStorage.getItem('fishing_admin_mgr_pagesize');
      // ⚠️ 必须先判 null/''：Number(null) === 0，会把「没存过」误当成「0 = 全部」，默认分页就失效了
      if (raw == null || raw === '') return MGR_PS_DEFAULT;
      const v = Number(raw);
      return (isFinite(v) && v >= 0) ? Math.min(1000, Math.floor(v)) : MGR_PS_DEFAULT;
    } catch (e) { return MGR_PS_DEFAULT; }
  })();
  function saveMgrPageSize() { try { localStorage.setItem('fishing_admin_mgr_pagesize', String(mgrPageSize)); } catch (e) {} }
  // 翻页统一入口：改页 → 重画 → 把列表滚回可视区（表格很长，不滚会以为「点了没反应」）
  function gotoMgrPage(n) {
    mgrPage = Math.max(1, Math.floor(Number(n) || 1));
    drawMgrList();
    const box = $('mgr-list');
    if (box && box.scrollIntoView) box.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }
  let mgrMeKey = '';
  function renderAccountMgr() {
    const main = $('main');
    main.innerHTML = '<h2>👥 账号管理</h2>' +
      '<div class="hint" style="margin-bottom:12px">可改密码 / 显示名 / 金币，开关「管理员」授权（开启后该账号即可打开 admin.html，<b>不能撤销自己的权限</b>），查看并编辑玩家快照（金币与背包），或删除账号（需二次确认）。修改密码会使其所有登录会话失效。点击表头可排序。</div>' +
      '<div class="mgr-row" style="margin-bottom:10px">' +
      '<label>🔍 搜索</label>' +
      '<span style="position:relative;display:inline-block;vertical-align:middle">' +
      '<input id="mgr-q" class="ipt" style="width:300px" placeholder="账号 ID / 显示名 / QQ 号" value="' + esc(mgrQuery) + '" autocomplete="off" />' +
      '<div id="mgr-sug" class="mgr-sug"></div></span>' +
      '<button class="btn mini" id="mgr-q-clear">清空</button>' +
      '<label>每页</label>' +
      '<input id="mgr-ps" class="ipt mk-num" type="number" min="0" max="1000" step="10" title="每页显示多少个账号；留空或 0 = 全部" value="' +
      (mgrPageSize > 0 ? mgrPageSize : '') + '" />' +
      '<span class="hint">个（0 或留空 = 全部；按浏览器记住）</span>' +
      '<span class="hint">输入即过滤；点联想项直接定位到该账号</span></div>' +
      '<div id="snap-cfg-row" class="mgr-row snap-cfg-row">' +
      '<label>🗄 存档快照</label>' +
      '<label class="switch"><input type="checkbox" id="snap-cfg-on" title="关闭后不再自动备份（仍可手动备份）"><span class="sl"></span></label>' +
      '<span class="hint">每</span>' +
      '<input id="snap-cfg-min" class="ipt mk-num" type="number" min="1" max="1440" title="自动备份间隔（分钟）" />' +
      '<span class="hint">分钟存一份 · 每人保留最近</span>' +
      '<input id="snap-cfg-keep" class="ipt mk-num" type="number" min="1" max="50" title="每人保留最近几份" />' +
      '<span class="hint">份</span>' +
      '<button class="btn mini primary" id="snap-cfg-save">保存策略</button>' +
      '<button class="btn mini" id="snap-cfg-now">立即备份全部</button>' +
      '<span class="hint" id="snap-cfg-state">读取中…</span></div>' +
      '<div id="mgr-list" class="panel">加载中…</div>';
    const q = $('mgr-q');
    // 搜索是「全量过滤后再分页」：改关键词一律回到第 1 页，否则可能停在一个空页上
    q.oninput = function () { mgrQuery = q.value; mgrPage = 1; drawMgrList(); drawMgrSug(); };
    q.onfocus = function () { drawMgrSug(); };
    // 延迟隐藏，让「点联想项」的 click 先于 blur 生效
    q.onblur = function () { setTimeout(function () { const b = $('mgr-sug'); if (b) b.style.display = 'none'; }, 180); };
    $('mgr-q-clear').onclick = function () { mgrQuery = ''; q.value = ''; mgrPage = 1; drawMgrList(); drawMgrSug(); };
    const ps = $('mgr-ps');
    if (ps) ps.onchange = function () {
      const v = Math.floor(Number(ps.value));
      mgrPageSize = (isFinite(v) && v > 0) ? Math.min(1000, v) : 0;   // 0 / 留空 / 非法 = 全部
      ps.value = mgrPageSize > 0 ? mgrPageSize : '';
      saveMgrPageSize();
      mgrPage = 1;
      drawMgrList();
    };
    wireSnapCfg();
    loadSnapCfg();
    loadMgrList();
  }
  // ---- 存档快照策略（全局）：间隔分钟 / 保留份数 / 是否启用 ----
  // 服务端按这套参数定时给每个账号留一份存档副本，超出份数丢最旧的；改完立即重挂定时器。
  function loadSnapCfg() {
    loadWorldCfg().then(function (cfg) {
      const c = (cfg && cfg.snapshotCfg) || { enabled: true, intervalMin: 30, keep: 5 };
      const on = $('snap-cfg-on'), min = $('snap-cfg-min'), keep = $('snap-cfg-keep'), st = $('snap-cfg-state');
      if (!on) return;   // 已切走页面
      on.checked = !!c.enabled; min.value = c.intervalMin; keep.value = c.keep;
      st.innerHTML = c.enabled
        ? ('当前：每 <b>' + c.intervalMin + '</b> 分钟存一份，每人保留最近 <b>' + c.keep + '</b> 份')
        : '当前：<b class="err">自动存档已关闭</b>（仍可手动备份 / 回档）';
    });
  }
  function wireSnapCfg() {
    const save = $('snap-cfg-save'), now = $('snap-cfg-now');
    if (save) save.onclick = function () {
      adminApi('POST', '/api/admin/snapshot/config', {
        token: token,
        cfg: { enabled: $('snap-cfg-on').checked, intervalMin: Number($('snap-cfg-min').value) || 30, keep: Number($('snap-cfg-keep').value) || 5 },
      }).then(function (r) {
        if (!r.ok) { toast(r.data.error || '保存失败', true); return; }
        worldCfg = null;   // 其它页面下次重新拉
        toast('存档策略已保存：每 ' + r.data.cfg.intervalMin + ' 分钟 / 保留最近 ' + r.data.cfg.keep + ' 份');
        loadSnapCfg();
      });
    };
    if (now) now.onclick = function () {
      now.disabled = true;
      adminApi('POST', '/api/admin/users/snapshot-now', { token: token }).then(function (r) {
        now.disabled = false;
        if (!r.ok) { toast(r.data.error || '备份失败', true); return; }
        toast('已为 ' + r.data.count + ' 个账号各存一份快照');
      });
    };
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
      admin: function (a, b) { return (a.admin ? 1 : 0) - (b.admin ? 1 : 0); },
    };
    const fn = cmp[mgrSort.key] || cmp.createdAt;
    rows = rows.slice().sort(fn);
    if (mgrSort.dir < 0) rows.reverse();
    const meKey = mgrMeKey;
    const arrow = function (k) { return mgrSort.key === k ? (mgrSort.dir < 0 ? ' ▼' : ' ▲') : ''; };
    // v0.16.2：分页。过滤 + 排序始终作用在**整个账号集**上，再切出当前页
    // （所以翻页不会改变匹配结果，搜索与排序照旧在全量上生效）。
    const matched = rows.length;
    const size = mgrPageSize > 0 ? mgrPageSize : Math.max(1, matched);
    const pages = Math.max(1, Math.ceil(matched / size));
    if (mgrPage > pages) mgrPage = pages;
    if (mgrPage < 1) mgrPage = 1;
    const from = (mgrPage - 1) * size;
    const pageRows = rows.slice(from, from + size);
    const body = pageRows.map(function (u) {
      const self = u.key === meKey;
      return '<tr>' +
        '<td><b>' + esc(u.name) + '</b> <span class="hint">' + esc(u.username) + (self ? '（你）' : '') + '</span>' +
        (u.qq ? '<div class="hint">QQ：' + esc(u.qq) + '</div>' : '') + '</td>' +
        '<td class="num">' + u.coins + '</td>' +
        '<td class="num">' + u.catchCount + '</td>' +
        '<td>' + (u.online ? '<span class="tag on">在线' + (u.fishing ? ' · 钓鱼中' : '') + '</span>' : '<span class="tag">离线</span>') +
        (u.banned ? '<div><span class="tag banned" title="' + esc((u.banReason ? '原因：' + u.banReason + ' · ' : '') + (u.banBy ? '操作人：' + u.banBy : '')) + '">' +
          (u.banPermanent ? '已封禁 · 永久' : '已封禁 · 剩 ' + Math.max(1, Math.ceil((u.banRemainMs || 0) / 3600000)) + ' 小时') + '</span></div>' : '') + '</td>' +
        '<td>' + fmtTime(u.createdAt) + '</td>' +
        '<td><label class="switch"><input type="checkbox" data-admin="' + esc(u.key) + '"' + (u.admin ? ' checked' : '') + (self ? ' disabled title="不能撤销自己的权限"' : '') + '><span class="sl"></span></label></td>' +
        '<td class="mgr-cap">' +
        // 留空 = 用默认 40；0 = 不限。改完立刻生效（玩家再上架时按这个数卡）
        '<input class="ipt mk-num" type="number" min="0" max="100000" data-cap="' + esc(u.key) + '" value="' +
        (u.capSet ? u.listingCap : '') + '" placeholder="40" title="同时挂单上限；0 = 不限；留空 = 默认 40" />' +
        '<div class="hint">在用 ' + (u.listings || 0) + (u.listingCap > 0 ? ' / ' + u.listingCap : ' / 不限') + '</div></td>' +
        '<td class="mgr-acts">' +
        '<button class="btn mini" data-edit="' + esc(u.key) + '">编辑</button>' +
        '<button class="btn mini" data-snap="' + esc(u.key) + '">快照</button>' +
        '<button class="btn mini" data-snaps="' + esc(u.key) + '" title="查看这个账号的历史存档，可回档到任意一份">存档/回档</button>' +
        (u.banned
          ? '<button class="btn mini" data-unban="' + esc(u.key) + '"' + (self ? ' disabled title="不能操作自己"' : '') + '>解封</button>'
          : '<button class="btn mini danger" data-ban="' + esc(u.key) + '"' + (self ? ' disabled title="不能封禁自己"' : '') + '>封禁</button>') +
        '<button class="btn mini danger" data-del="' + esc(u.key) + '"' + (self ? ' disabled title="不能删除自己"' : '') + '>删除</button>' +
        '</td></tr>';
    }).join('');
    $('mgr-list').innerHTML =
      '<div class="hint" style="margin-bottom:8px">共 ' + mgrRows.length + ' 个账号' + (q ? '，匹配 ' + matched + ' 个' : '') +
      ' · 第 <b>' + mgrPage + '</b> / ' + pages + ' 页' + (mgrPageSize > 0 ? '（每页 ' + size + ' 条）' : '（全部一页）') +
      (matched ? '，本页 ' + (from + 1) + '–' + (from + pageRows.length) + ' 条' : '') +
      '；当前排序：' + ({ name: '显示名', coins: '金币', catchCount: '捕获数', online: '状态', createdAt: '注册时间', admin: '管理员' }[mgrSort.key] || mgrSort.key) + (mgrSort.dir < 0 ? ' ↓' : ' ↑') + '</div>' +
      '<table class="tbl"><thead><tr>' +
      '<th class="sortable" data-sort="name">账号' + arrow('name') + '</th>' +
      '<th class="num sortable" data-sort="coins">金币' + arrow('coins') + '</th>' +
      '<th class="num sortable" data-sort="catchCount">捕获数' + arrow('catchCount') + '</th>' +
      '<th class="sortable" data-sort="online">状态' + arrow('online') + '</th>' +
      '<th class="sortable" data-sort="createdAt">注册时间' + arrow('createdAt') + '</th>' +
      '<th class="sortable" data-sort="admin">管理员' + arrow('admin') + '</th>' +
      '<th>挂单上限</th>' +
      '<th>操作</th>' +
      '</tr></thead><tbody>' + body + '</tbody></table>' +
      '<div class="mgr-pager">' +
      '<button class="btn mini" data-mgrpage="1"' + (mgrPage <= 1 ? ' disabled' : '') + '>« 首页</button>' +
      '<button class="btn mini" data-mgrpage="' + (mgrPage - 1) + '"' + (mgrPage <= 1 ? ' disabled' : '') + '>‹ 上一页</button>' +
      '<span class="hint">第 <b>' + mgrPage + '</b> / ' + pages + ' 页 · 匹配 ' + matched + ' 条</span>' +
      '<button class="btn mini" data-mgrpage="' + (mgrPage + 1) + '"' + (mgrPage >= pages ? ' disabled' : '') + '>下一页 ›</button>' +
      '<button class="btn mini" data-mgrpage="' + pages + '"' + (mgrPage >= pages ? ' disabled' : '') + '>末页 »</button>' +
      '<input id="mgr-jump" class="ipt mk-num" type="number" min="1" max="' + pages + '" placeholder="页" title="跳到第几页" />' +
      '<button class="btn mini" id="mgr-jump-go">跳转</button>' +
      '</div>';
    $('mgr-list').querySelectorAll('th.sortable').forEach(function (th) {
      th.style.cursor = 'pointer';
      th.onclick = function () {
        const k = th.getAttribute('data-sort');
        if (mgrSort.key === k) mgrSort.dir = -mgrSort.dir;
        else mgrSort = { key: k, dir: (k === 'name' ? 1 : -1) };
        drawMgrList();
      };
    });
    $('mgr-list').querySelectorAll('[data-mgrpage]').forEach(function (b) {
      b.onclick = function () { gotoMgrPage(Number(b.getAttribute('data-mgrpage'))); };
    });
    const jumpGo = $('mgr-jump-go'), jumpInp = $('mgr-jump');
    if (jumpGo && jumpInp) {
      const doJump = function () { gotoMgrPage(Number(jumpInp.value) || 1); };
      jumpGo.onclick = doJump;
      jumpInp.onkeydown = function (e) { if (e.key === 'Enter') doJump(); };
    }
    $('mgr-list').querySelectorAll('[data-edit]').forEach(function (b) { b.onclick = function () { openMgrEdit(b.getAttribute('data-edit')); }; });
    $('mgr-list').querySelectorAll('[data-snap]').forEach(function (b) { b.onclick = function () { openMgrSnapshot(b.getAttribute('data-snap')); }; });
    $('mgr-list').querySelectorAll('[data-snaps]').forEach(function (b) { b.onclick = function () { openMgrSnapshots(b.getAttribute('data-snaps')); }; });
    $('mgr-list').querySelectorAll('[data-ban]').forEach(function (b) { b.onclick = function () { openBanDialog(b.getAttribute('data-ban')); }; });
    $('mgr-list').querySelectorAll('[data-unban]').forEach(function (b) {
      b.onclick = function () {
        const key = b.getAttribute('data-unban');
        confirmModalLocal('解除「' + key + '」的封禁？对方即可重新登录。').then(function (ok) {
          if (!ok) return;
          adminApi('POST', '/api/admin/users/ban', { token: token, target: key, hours: 0, confirm: true }).then(function (r) {
            if (!r.ok) { toast((r.data && r.data.error) || '解封失败', true); return; }
            toast('已解封「' + key + '」'); loadMgrList();
          });
        });
      };
    });
    $('mgr-list').querySelectorAll('[data-del]').forEach(function (b) { b.onclick = function () { confirmDeleteUser(b.getAttribute('data-del')); }; });
    // 挂单上限：改完即存（留空 = 清掉自定义值、回默认 40；0 = 不限）
    $('mgr-list').querySelectorAll('input[data-cap]').forEach(function (inp) {
      inp.onchange = function () {
        const key = inp.getAttribute('data-cap');
        const raw = String(inp.value || '').trim();
        let cap = null;   // null = 恢复默认
        if (raw !== '') {
          cap = Math.floor(Number(raw));
          if (!isFinite(cap) || cap < 0 || cap > 100000) { toast('挂单上限需为 0~100000 的整数（0 = 不限，留空 = 默认 40）', true); return; }
        }
        inp.disabled = true;
        adminApi('POST', '/api/admin/users/update', { token: token, target: key, listingCap: cap }).then(function (r) {
          inp.disabled = false;
          if (!r.ok) { toast((r.data && r.data.error) || '保存失败', true); return; }
          const row = mgrRows.find(function (u) { return u.key === key; });
          if (row) { row.listingCap = r.data.listingCap; row.capSet = r.data.capSet; }
          inp.value = r.data.capSet ? r.data.listingCap : '';
          toast('「' + key + '」挂单上限已设为 ' + (r.data.listingCap === 0 ? '不限' : r.data.listingCap) + (r.data.capSet ? '' : '（默认）'));
          drawMgrList();   // 让「在用 x / y」跟着刷新
        });
      };
    });
    // 管理员授权开关（原「账号授权」页的功能，v0.11.6 并入本页）
    $('mgr-list').querySelectorAll('input[type=checkbox][data-admin]').forEach(function (cb) {
      cb.onchange = function () {
        const key = cb.getAttribute('data-admin');
        const want = cb.checked;
        cb.disabled = true;
        adminApi('POST', '/api/admin/users/setadmin', { token: token, target: key, admin: want }).then(function (r) {
          cb.disabled = (key === meKey); // 自己那一行保持禁用：不能撤销自己的管理员权限
          if (!r.ok) { cb.checked = !want; toast(r.data.error || '操作失败', true); return; }
          const row = mgrRows.find(function (u) { return u.key === key; });
          if (row) row.admin = want;
          toast(want ? '已授予管理员权限' : '已收回管理员权限');
          if (want) loadWorldCfg(); // 目录可能变化，预取
        });
      };
    });
  }
  // 编辑密码 / 显示名 / 金币
  // ================================
  // 后台安全（v0.16.0）：封禁名单 / 异常登录锁定 / 管理操作审计
  // ================================
  function renderSecurity() {
    const main = $('main');
    main.innerHTML = '<h2>🛡 后台安全</h2>' +
      '<div class="hint" style="margin-bottom:12px">这一页把「谁被封了、谁在被爆破、管理员都改过什么」放一起。' +
      '封禁与解封在「👥 账号管理」那一行也能操作；本页只做查看与解封。' +
      '<b>敏感操作（删除账号 / 封禁 / 关闭全部功能 / 批量上架 / 退回挂单）都需要二次确认</b>，' +
      '每次后台写操作都会记进下面的审计日志（落盘 admin.json）。</div>' +
      '<div id="sec-registration" class="panel">注册防护统计加载中…</div>' +
      '<div id="sec-body" class="panel">加载中…</div>';
    loadSecurity();
  }
  function loadSecurity() {
    adminApi('GET', '/api/admin/registration/stats').then(function (r) {
      if (view !== 'security' || !$('sec-registration')) return;
      if (!r.ok) { $('sec-registration').textContent = '注册防护统计读取失败'; return; }
      const c = r.data.counters, limits = r.data.limits;
      $('sec-registration').innerHTML = '<h3>注册防滥用' + (r.data.attention ? ' · 已发现异常请求' : '') + '</h3>' +
        '<div>注册尝试 ' + c.attempts + ' · 成功 ' + c.created + ' · 触发验证 ' + c.challenged +
        ' · 账号冲突 ' + c.duplicate + ' · 配额拦截 ' + c.limited + '</div>' +
        '<div class="hint">统计自本次服务启动（' + esc(new Date(r.data.startedAt).toLocaleString()) + '）。每小时全站最多 ' + limits.globalHourly +
        ' 次、每来源 ' + limits.ipHourly + ' 次、每用户名 ' + limits.usernameHourly + ' 次有效格式注册尝试；验证重试也计数。</div>' +
        '<button id="sec-reg-refresh" class="btn">刷新安全统计</button>';
      $('sec-reg-refresh').onclick = loadSecurity;
    });
    adminApi('GET', '/api/admin/security?token=' + encodeURIComponent(token)).then(function (r) {
      if (view !== 'security') return;
      const host = $('sec-body');
      if (!host) return;
      if (!r.ok) { host.textContent = '读取失败：' + ((r.data && r.data.error) || '请重试'); return; }
      const d = r.data || {};
      const banned = d.banned || [];
      const locks = d.lockouts || [];
      const log = d.log || [];
      const fmtRemain = function (ms) {
        const m = Math.ceil(ms / 60000);
        return m >= 60 ? (Math.round(m / 6) / 10) + ' 小时' : m + ' 分钟';
      };
      host.innerHTML =
        '<h3>🚫 封禁名单（' + banned.length + '）</h3>' +
        (banned.length
          ? '<table class="tbl"><thead><tr><th>账号</th><th>时长</th><th>原因</th><th>操作人</th><th>操作</th></tr></thead><tbody>' +
            banned.map(function (b) {
              return '<tr><td><b>' + esc(b.name) + '</b> <span class="hint">' + esc(b.username) + '</span></td>' +
                '<td>' + (b.permanent ? '永久' : '剩 ' + fmtRemain(b.remainMs)) + '</td>' +
                '<td>' + esc(b.reason || '—') + '</td>' +
                '<td>' + esc(b.banBy || '—') + '<div class="hint">' + (b.banAt ? new Date(b.banAt).toLocaleString() : '') + '</div></td>' +
                '<td><button class="btn mini" data-sec-unban="' + esc(b.key) + '">解封</button></td></tr>';
            }).join('') + '</tbody></table>'
          : '<div class="hint">当前没有封禁中的账号。</div>') +
        '<h3 style="margin-top:16px">⏳ 异常登录锁定（' + locks.length + '）</h3>' +
        '<div class="hint" style="margin-bottom:6px">同一「账号 + IP」在 ' + (d.rules ? d.rules.windowMin : 10) + ' 分钟内连续失败 ' +
        (d.rules ? d.rules.maxFails : 5) + ' 次即锁定 ' + (d.rules ? d.rules.lockMin : 5) + ' 分钟（只挡登录，不影响在线玩家）。</div>' +
        (locks.length
          ? '<table class="tbl"><thead><tr><th>账号</th><th>来源 IP</th><th>剩余锁定</th></tr></thead><tbody>' +
            locks.map(function (l) {
              return '<tr><td>' + esc(l.user) + '</td><td>' + esc(l.ip) + '</td><td>' + fmtRemain(l.remainMs) + '</td></tr>';
            }).join('') + '</tbody></table>'
          : '<div class="hint">当前没有被锁定的登录来源。</div>') +
        '<h3 style="margin-top:16px">📜 管理操作审计（最近 ' + log.length + ' 条）</h3>' +
        (log.length
          ? '<div class="sec-log">' + log.map(function (x) {
              return '<div class="sec-log-row"><span class="sl-time">' + new Date(x.t).toLocaleString() + '</span>' +
                '<span class="sl-who">' + esc(x.name || x.key) + '</span>' +
                '<span class="sl-act">' + esc(x.action) + '</span>' +
                '<span class="sl-target">' + esc(x.target || '—') + '</span>' +
                '<span class="sl-detail hint">' + esc(x.detail || '') + '</span></div>';
            }).join('') + '</div>'
          : '<div class="hint">还没有记录。任意后台写操作（改配置 / 发奖励 / 封禁…）都会出现在这里。</div>');
      host.querySelectorAll('[data-sec-unban]').forEach(function (b) {
        b.onclick = function () {
          const key = b.getAttribute('data-sec-unban');
          confirmModalLocal('解除「' + key + '」的封禁？').then(function (ok) {
            if (!ok) return;
            adminApi('POST', '/api/admin/users/ban', { token: token, target: key, hours: 0, confirm: true }).then(function (res) {
              if (!res.ok) { toast((res.data && res.data.error) || '解封失败', true); return; }
              toast('已解封「' + key + '」'); loadSecurity();
            });
          });
        };
      });
    });
  }
  // 封禁对话框（v0.16.0）：时长可选常用档位，也可自己填任意小时数；负数 = 永久
  function openBanDialog(key) {
    document.querySelectorAll('.modal-overlay').forEach(function (m) { m.remove(); });
    const ov = document.createElement('div');
    ov.className = 'modal-overlay';
    ov.innerHTML = '<div class="modal-box confirm-modal"><div class="modal-head"><span class="modal-title">封禁账号 ' + esc(key) + '</span></div>' +
      '<div class="modal-body mgr-form">' +
      '<div class="hint" style="margin-bottom:8px">封禁会立即踢掉该账号的全部会话与实时连接；封禁期间无法登录、无法连接。' +
      '时长可填任意小时数（支持小数），<b>负数 = 永久封禁</b>。</div>' +
      '<div class="mgr-row"><label>常用时长</label><span>' +
      [['1', '1 小时'], ['6', '6 小时'], ['24', '1 天'], ['72', '3 天'], ['720', '30 天'], ['-1', '永久']].map(function (kv) {
        return '<button class="btn mini ban-preset" data-h="' + kv[0] + '" style="margin-right:6px">' + kv[1] + '</button>';
      }).join('') + '</span></div>' +
      '<div class="mgr-row"><label>时长（小时）</label><input id="ban-hours" class="ipt" type="number" step="0.5" value="24" style="width:160px" /></div>' +
      '<div class="mgr-row"><label>原因（可选）</label><input id="ban-reason" class="ipt" maxlength="60" placeholder="会显示给对方看" style="width:320px" /></div>' +
      '<div class="cf-actions"><button class="btn mini cf-no">取消</button><button class="btn danger" id="ban-go">确认封禁</button></div>' +
      '<span id="ban-msg" class="hint"></span>' +
      '</div></div>';
    document.body.appendChild(ov);
    ov.addEventListener('click', function (e) { if (e.target === ov) ov.remove(); });
    ov.querySelector('.cf-no').onclick = function () { ov.remove(); };
    ov.querySelectorAll('.ban-preset').forEach(function (b) {
      b.onclick = function () { ov.querySelector('#ban-hours').value = b.getAttribute('data-h'); };
    });
    ov.querySelector('#ban-go').onclick = function () {
      const hours = Number(ov.querySelector('#ban-hours').value);
      const reason = ov.querySelector('#ban-reason').value.trim();
      if (!isFinite(hours) || hours === 0) { ov.querySelector('#ban-msg').textContent = '请填写非 0 的时长（小时）；负数表示永久'; return; }
      const human = hours < 0 ? '永久封禁' : ('封禁 ' + hours + ' 小时');
      confirmModalLocal('确认对「' + key + '」执行 ' + human + '？' + (reason ? '\n原因：' + reason : '') +
        '\n封禁后该账号会立刻掉线，且无法登录。').then(function (ok) {
        if (!ok) return;
        adminApi('POST', '/api/admin/users/ban', { token: token, target: key, hours: hours, reason: reason, confirm: true }).then(function (r) {
          if (!r.ok) { ov.querySelector('#ban-msg').textContent = (r.data && r.data.error) || '封禁失败'; return; }
          toast('已' + human + '「' + key + '」'); ov.remove(); loadMgrList();
        });
      });
    };
  }
  function openMgrEdit(key) {
    document.querySelectorAll('.modal-overlay').forEach(function (m) { m.remove(); });
    const ov = document.createElement('div');
    ov.className = 'modal-overlay';
    ov.innerHTML = '<div class="modal-box confirm-modal"><div class="modal-head"><span class="modal-title">编辑账号 ' + esc(key) + '</span></div>' +
      '<div class="modal-body mgr-form">' +
      '<div class="mgr-row"><label>新密码</label><input id="mgr-pass" class="ipt" type="text" placeholder="留空则不修改（新密码至少 12 位）" /></div>' +
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
      // 物品目录覆盖**全部物品**（鱼 / 材料 / 宝匣 / 组件底材）；组件实例走「定制配件」或物品行的「改词条」
      const byKind = { fish: [], material: [], chest: [], component: [] };
      (hasData ? GameData.allItems() : []).forEach(function (it) { (byKind[it.kind] || (byKind[it.kind] = [])).push(it); });
      const opt = function (it) { return '<option value="' + esc(it.id) + '">' + esc(it.name) + '（' + esc(it.id) + '）</option>'; };
      const grp = function (label, arr) { return arr.length ? '<optgroup label="' + label + '">' + arr.map(opt).join('') + '</optgroup>' : ''; };
      // 新增物品按关键词过滤（名称 / ID，不区分大小写），命中的按分类分组列出
      const addOptionsHtml = function (kw) {
        if (!hasData) return '<option value="">（数据目录未加载，请手动输入 ID）</option>';
        const k = String(kw || '').trim().toLowerCase();
        const hit = function (it) { return !k || String(it.id).toLowerCase().indexOf(k) >= 0 || String(it.name).toLowerCase().indexOf(k) >= 0; };
        return grp('鱼', byKind.fish.filter(hit)) + grp('材料', byKind.material.filter(hit)) +
          grp('宝匣', byKind.chest.filter(hit)) + grp('组件（底材）', byKind.component.filter(hit));
      };
      const itemOptions = addOptionsHtml('');
      document.querySelectorAll('.modal-overlay').forEach(function (m) { m.remove(); });
      const ov = document.createElement('div');
      ov.className = 'modal-overlay';
      ov.innerHTML = '<div class="modal-box confirm-modal snap-modal"><div class="modal-head"><span class="modal-title">资产快照 · ' + esc(d.name) + '（' + esc(key) + '）</span></div>' +
        '<div class="modal-body">' +
        '<div class="snap-cols">' +
        '<div class="snap-col">' +
        '<div class="mgr-row"><label>金币</label><input id="snap-coins" class="ipt" type="number" min="0" value="' + d.coins + '" /></div>' +
        '<div class="hint" style="margin:10px 0 6px">背包（直接编辑每行的数量，0 或留空 = 移除；组件可点「改词条」）</div>' +
        '<div class="mgr-row snap-search-row"><input id="snap-search" class="ipt" type="text" placeholder="搜索背包物品（名称 / 物品ID，不区分大小写）" /></div>' +
        '<div id="snap-inv" class="snap-inv"></div>' +
        '</div>' +
        '<div class="snap-col">' +
        '<div class="mgr-row" style="margin-top:10px"><label>新增物品</label>' +
        '<input id="snap-add-search" class="ipt" type="text" placeholder="搜索物品（名称 / ID）" style="max-width:190px" />' +
        '<select id="snap-add-id" class="ipt" style="min-width:240px">' + itemOptions + '</select>' +
        '<input id="snap-add-qty" class="ipt mk-num" type="number" min="1" value="1" />' +
        '<button class="btn mini" id="snap-add">添加</button></div>' +
        '<div class="hint" style="margin:14px 0 6px">🎣 钓竿装配（每个部位现在装的是哪件；换件不必先进背包，「卸下」= 换回标准件）</div>' +
        '<div id="snap-bd"></div>' +
        '<div class="hint" style="margin:14px 0 6px">🔧 定制配件（自选底材 / 品质 / 词条数值，生成后直接放进背包）</div>' +
        '<div class="mgr-row"><label>底材</label><select id="cus-base" class="ipt" style="min-width:240px"></select>' +
        '<label>品质</label><select id="cus-quality" class="ipt"></select></div>' +
        '<div id="cus-affixes" style="margin:6px 0"></div>' +
        '<div class="mgr-row"><button class="btn mini" id="cus-aff-add">＋ 添加词条</button>' +
        '<span class="hint">6 类词条都能选（★池外＝该底材原来没有的，按池外区间取值）；数值可超出自然区间（越界标 ⚠，不拦）</span></div>' +
        '<div class="hint" id="cus-preview" style="margin-top:6px"></div>' +
        '<div class="mgr-row" style="margin-top:6px"><label>数量</label>' +
        '<input id="cus-qty" class="ipt mk-num" type="number" min="1" value="1" />' +
        '<button class="btn mini primary" id="cus-add">添加到背包</button>' +
        '<button class="btn mini" id="cus-edit-cancel" style="display:none" title="放弃对原件的修改">取消修改</button>' +
        '<span class="hint" id="cus-edit-hint"></span></div>' +
        '</div>' +   // /snap-col（右栏：新增物品 + 定制配件）
        '</div>' +   // /snap-cols
        '<div class="cf-actions snap-actions"><button class="btn mini cf-no">取消</button><button class="btn primary" id="snap-save">保存快照</button></div>' +
        '</div></div>';
      document.body.appendChild(ov);
      ov.addEventListener('click', function (e) { if (e.target === ov) ov.remove(); });
      ov.querySelector('.cf-no').onclick = function () { ov.remove(); };
      const invBox = ov.querySelector('#snap-inv');
      const searchBox = ov.querySelector('#snap-search');
      function drawInv(inv) {
        const keys = Object.keys(inv);
        if (!keys.length) { invBox.innerHTML = '<div class="hint">背包为空</div>'; return; }
        invBox.innerHTML = keys.map(function (id) {
          const meta = (typeof GameData !== 'undefined' && GameData.itemOf) ? GameData.itemOf(id) : null;
          const nm = meta ? meta.name : id;
          // 组件实例（带品质 / 词条）可以改词条与属性：载入下方「定制配件」区改完替换原件
          const isInst = !!(window.GameData && GameData.instanceOf && GameData.instanceOf(id));
          return '<div class="mgr-row snap-line" data-sid="' + esc(id) + '"><label title="' + esc(id) + '">' + esc(nm) + '<div class="hint">' + esc(id) + '</div></label>' +
            '<input class="ipt mk-num" type="number" min="0" data-inv="' + esc(id) + '" value="' + inv[id] + '" />' +
            (isInst ? '<button class="btn mini" data-itemedit="' + esc(id) + '" title="改这件组件的品质 / 词条（数量直接改左边的框）">改词条</button>' : '') +
            '</div>';
        }).join('');
        filterInv();
      }
      // 实时过滤背包条目：按物品名 / 物品ID 不区分大小写匹配（仅影响显示，不改动数据）
      function filterInv() {
        const kw = (searchBox.value || '').trim().toLowerCase();
        invBox.querySelectorAll('.snap-line').forEach(function (row) {
          const id = (row.getAttribute('data-sid') || '').toLowerCase();
          const meta = (window.GameData && GameData.itemOf) ? GameData.itemOf(id) : null;
          const nm = (meta ? meta.name : id).toLowerCase();
          const hit = !kw || id.indexOf(kw) >= 0 || nm.indexOf(kw) >= 0;
          row.style.display = hit ? '' : 'none';
        });
      }
      searchBox.addEventListener('input', filterInv);
      // 「改词条」：把该组件实例载入下方「定制配件」区，改完点「应用修改」替换原件（数量也可直接改）
      invBox.addEventListener('click', function (e) {
        const b = (e.target && e.target.closest) ? e.target.closest('[data-itemedit]') : null;
        if (b) loadInstanceIntoCustom(b.getAttribute('data-itemedit'));
      });
      drawInv(d.inventory || {});
      // 统一的「往背包草稿加一件」：已有同 id 就叠加数量，否则追加一行
      function invAddDraft(id, qty) {
        if (!id) return false;
        const inputs = ov.querySelectorAll('[data-inv]');
        for (const inp of inputs) { if (inp.getAttribute('data-inv') === id) { inp.value = (Number(inp.value) || 0) + qty; if (bdBox) drawBd(); return true; } }
        const cur = {};
        inputs.forEach(function (inp) { cur[inp.getAttribute('data-inv')] = Number(inp.value) || 0; });
        cur[id] = qty;
        drawInv(cur);
        if (bdBox) drawBd();   // v0.16.3：背包草稿变了 → 钓竿装配的候选列表跟着重算
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
      // 新增物品的搜索框：过滤下拉里的可选项（保留原选中项，避免过滤时把目标改掉）
      const addSearch = ov.querySelector('#snap-add-search');
      const addSel = ov.querySelector('#snap-add-id');
      if (addSearch && addSel) addSearch.addEventListener('input', function () {
        const keep = addSel.value;
        addSel.innerHTML = addOptionsHtml(addSearch.value);
        for (const o of addSel.options) { if (o.value === keep) { addSel.value = keep; break; } }
      });
      // —— 定制配件：底材 × 品质 × 词条 → 组件实例。id 用 GameData.instanceId 生成（与游戏同一套编码），
      // 服务端按实例规则校验后入包。
      // 定制件刻意**不受底材词缀池与自然区间限制**：6 类词条都能选（不在该底材池里的按池外区间显示、
      // 入包后与宝匣突破件一样带「池外」标记），数值也能超出自然区间（越界处标 ⚠ 提示，不拦）。——
      const bases = (window.GameData && GameData.COMPONENT_BASES) || [];
      const affLabel = (window.GameData && GameData.AFFIX_LABEL) || {};
      const affTypes = (window.GameData && GameData.AFFIX_TYPES) || [];
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
      let cusEditFrom = '';   // 非空 = 正在改背包里这件实例（「应用修改」会替换它）
      let cusEditPart = '';   // v0.16.3：非空 = 正在改「钓竿某部位」上装的那件（应用后装回该部位）
      let bdBox = null;       // v0.16.3：钓竿装配区容器（装配区建好后由 drawBd 填充）
      let bdDraft = {};       // v0.16.3：钓竿装配草稿 { 部位: { compId } }（初始值来自 rec.bd）
      function cusBase() { return bases.find(function (b) { return b.id === bSel.value; }) || null; }
      // 某类词条对当前底材的「自然区间」：底材池内 → 该底材区间（含后台覆盖）；池外 → 池外（突破）区间
      function cusRange(b, type) {
        const pr = (b && b.pool || []).find(function (p) { return p.type === type; });
        if (pr) {
          const r = (GameData.affixRangeOf ? GameData.affixRangeOf(b.id, pr) : null) || [pr.min, pr.max];
          return { min: r[0], max: r[1], extra: false };
        }
        const e = (GameData.extraAffixRangeOf ? GameData.extraAffixRangeOf(type) : null) || [1, 3];
        return { min: e[0], max: e[1], extra: true };
      }
      function drawCus() {
        const b = cusBase();
        const box = ov.querySelector('#cus-affixes');
        if (!b) return;
        // 换底材不再清空已加词条：定制件本来就能带池外词条，只是「自然区间」按新底材重算
        box.innerHTML = cusList.length ? cusList.map(function (a, i) {
          const nr = cusRange(b, a.type);
          const over = a.value < nr.min || a.value > nr.max;
          return '<div class="cus-aff">' +
            '<select class="ipt" data-cus-t="' + i + '">' + affTypes.map(function (t) {
              return '<option value="' + esc(t) + '"' + (t === a.type ? ' selected' : '') + '>' +
                esc(affLabel[t] || t) + (cusRange(b, t).extra ? ' ★池外' : '') + '</option>';
            }).join('') + '</select>' +
            '<input class="ipt mk-num" type="number" data-cus-v="' + i + '" value="' + a.value + '" />' +
            '<span class="hint' + (over ? ' cus-over' : '') + '">' + (nr.extra ? '池外 ' : '自然 ') + nr.min + '~' + nr.max +
            (over ? ' ⚠越界' : '') + '</span>' +
            '<button class="btn mini danger" data-cus-del="' + i + '" title="移除词条">✕</button></div>';
        }).join('') : '<div class="hint">暂无词条（0 条 = 无词条配件）</div>';
        box.querySelectorAll('[data-cus-t]').forEach(function (sel) {
          sel.onchange = function () {
            const i = +sel.getAttribute('data-cus-t'), t = sel.value;
            if (cusList.some(function (a, j) { return j !== i && a.type === t; })) {
              toast('「' + (affLabel[t] || t) + '」已经加过一条了（同类词条只能一条）', true);
              drawCus();
              return;
            }
            cusList[i].type = t;
            drawCus();
          };
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
        if (!meta) { el.innerHTML = '<span class="err">无法生成该配件（底材 / 品质 / 词条编码非法）</span>'; return; }
        const aff = meta.affixes.length
          ? meta.affixes.map(function (a) {
            return esc((affLabel[a.type] || a.type) + (a.value > 0 ? '+' : '') + a.value) +
              (a.extra ? '<span class="cus-extra">池外</span>' : '');
          }).join(' / ')
          : '无词条';
        const cap = qDef[ov.querySelector('#cus-quality').value] ? qDef[ov.querySelector('#cus-quality').value].cap : '?';
        el.innerHTML = '预览：<b>' + esc(meta.name) + '</b> · ' + esc(meta.qualityName) + ' · ' + aff +
          ' <span class="hint">（' + esc(id) + '；该品质常规最多 ' + cap + ' 条，定制件可超出，当前 ' + meta.affixes.length + ' 条）</span>';
      }
      bSel.onchange = function () { drawCus(); };   // 换底材不清空词条：只重算自然区间与池外标记
      ov.querySelector('#cus-quality').onchange = function () { updateCusPreview(); };
      ov.querySelector('#cus-aff-add').onclick = function () {
        const b = cusBase(); if (!b) return;
        const used = cusList.map(function (a) { return a.type; });
        const next = affTypes.find(function (t) { return used.indexOf(t) < 0; });
        if (!next) { toast('6 类词条都已添加', true); return; }
        cusList.push({ type: next, value: cusRange(b, next).min });
        drawCus();
      };
      // 改词条模式：把「添加到背包」切成「应用修改（替换原件）」，并在旁边给出正在改哪一件
      function setCusEditMode(id, partKey) {
        cusEditFrom = id || '';
        cusEditPart = (id && partKey) ? partKey : '';
        const btn = ov.querySelector('#cus-add');
        const cancel = ov.querySelector('#cus-edit-cancel');
        const hint = ov.querySelector('#cus-edit-hint');
        if (btn) btn.textContent = cusEditFrom ? (cusEditPart ? '✅ 应用修改（装到该部位）' : '✅ 应用修改（替换原件）') : '添加到背包';
        if (cancel) cancel.style.display = cusEditFrom ? '' : 'none';
        if (hint) hint.innerHTML = cusEditFrom
          ? (cusEditPart
            ? '正在修改：<b>' + esc(cusEditFrom) + '</b>（装在「' + esc(bdPartName(cusEditPart)) + '」上；改完点左边按钮装回该部位）'
            : '正在修改：<b>' + esc(cusEditFrom) + '</b>（底材 / 品质 / 词条 / 数量都可改；改完点左边按钮替换，同 id 就只改数量）')
          : '';
      }
      function bdPartName(key) {
        const p = ((window.GameData && GameData.ROD_PARTS) || []).find(function (x) { return x.key === key; });
        return (p && p.name) || key;
      }
      // 把背包里的一件组件实例载入定制配件区（品质、词条与数值都是它的现值）
      // v0.16.3：partKey 非空 = 这件是「钓竿某部位」上装着的，应用后装回该部位（不写进背包）
      function loadInstanceIntoCustom(id, partKey) {
        const inst = (window.GameData && GameData.instanceOf) ? GameData.instanceOf(id) : null;
        if (!inst) { toast('只有组件（带品质与词条）能改词条', true); return; }
        bSel.value = inst.baseId;
        ov.querySelector('#cus-quality').value = inst.quality;
        cusList = (inst.affixes || []).map(function (a) { return { type: a.type, value: a.value, src: a.src }; });
        drawCus();
        const inp = ov.querySelector('[data-inv="' + id + '"]');
        ov.querySelector('#cus-qty').value = inp ? (Number(inp.value) || 1) : 1;
        setCusEditMode(id, partKey);
        toast('已载入「' + (GameData.itemOf(id).name || id) + '」：改完点「应用修改」' + (partKey ? '装回该部位' : '替换原件'));
      }
      if (ov.querySelector('#cus-edit-cancel')) {
        ov.querySelector('#cus-edit-cancel').onclick = function () { setCusEditMode(''); toast('已取消修改（原件未变）'); };
      }
      ov.querySelector('#cus-add').onclick = function () {
        const id = cusId();
        const meta = (window.GameData && GameData.instanceMeta) ? GameData.instanceMeta(id) : null;
        if (!meta) { toast('无法生成该配件：词条类型与底材不匹配', true); return; }
        const qty = Math.max(1, Number(ov.querySelector('#cus-qty').value) || 1);
        if (cusEditPart) {
          // v0.16.3：改的是「钓竿某部位」上的那件 → 直接把新实例装回该部位（不写背包草稿）
          const partKey = cusEditPart;
          bdDraft[partKey] = { compId: id };
          drawBd();
          setCusEditMode('');
          toast('已把「' + meta.name + '」装到' + bdPartName(partKey) + '（点「保存快照」后生效）');
          return;
        }
        if (cusEditFrom) {
          const from = cusEditFrom;
          const inp = ov.querySelector('[data-inv="' + from + '"]');
          if (id === from) {
            if (inp) inp.value = qty;
            toast('已更新数量：' + meta.name + ' × ' + qty);
          } else {
            if (inp) inp.value = 0;   // 原件记 0 件 = 保存时移除
            invAddDraft(id, qty);
            toast('已替换为：' + meta.name + ' × ' + qty);
          }
          setCusEditMode('');
          return;
        }
        invAddDraft(id, qty);
        toast('已加入草稿：' + meta.name + ' × ' + qty);
      };
      drawCus();

      // ---- v0.16.3：钓竿装配编辑 ----
      // 每个部位一行：当前件（名字 · 品质 · 词条）+「换成」下拉（背包草稿里该部位的组件 / 标准件）+「改词条」。
      // 「改词条」把该件载入下面的定制配件区，应用后直接把新实例装到这个部位上（不写进背包草稿）。
      const bdParts = (window.GameData && GameData.ROD_PARTS) || [];
      bdBox = ov.querySelector('#snap-bd');
      // 装配草稿：{ 部位: { compId } }，初始值来自服务端返回的 rec.bd
      bdParts.forEach(function (p) {
        const cur = (d.bd && d.bd[p.key]) ? d.bd[p.key] : null;
        bdDraft[p.key] = { compId: (cur && cur.compId) || null };
      });
      function bdDraftInv() {
        const inv = {};
        ov.querySelectorAll('[data-inv]').forEach(function (inp) {
          const q = Math.floor(Number(inp.value) || 0);
          if (q > 0) inv[inp.getAttribute('data-inv')] = q;
        });
        return inv;
      }
      function bdOptionsFor(partKey, selected) {
        const inv = bdDraftInv();
        const opts = ['<option value=""' + (selected ? '' : ' selected') + '>标准件（卸下）</option>'];
        Object.keys(inv).forEach(function (id) {
          const c = (window.GameData && GameData.componentOf) ? GameData.componentOf(id) : null;
          if (!c || c.part !== partKey) return;
          opts.push('<option value="' + esc(id) + '"' + (id === selected ? ' selected' : '') + '>' +
            esc(GameData.itemOf(id).name || id) + ' ×' + inv[id] + '</option>');
        });
        // 当前装着、但背包草稿里没有的那件（例如刚用定制配件换上）也要留在列表里，否则一保存就被卸掉
        if (selected && !inv[selected] && window.GameData && GameData.componentOf(selected)) {
          opts.push('<option value="' + esc(selected) + '" selected>【当前】' + esc(GameData.itemOf(selected).name || selected) + '</option>');
        }
        return opts.join('');
      }
      function bdRowText(partKey) {
        const id = (bdDraft[partKey] || {}).compId;
        if (!id) return '<span class="muted">标准' + esc(bdPartName(partKey)) + ' · 无加成</span>';
        const c = (window.GameData && GameData.componentOf) ? GameData.componentOf(id) : null;
        if (!c) return esc(id);
        const aff = (c.affixes || []).map(function (a) {
          return esc((affLabel[a.type] || a.type) + (a.value > 0 ? '+' : '') + a.value);
        }).join(' / ');
        return esc(c.name) + ' · ' + esc(c.qualityName || '') +
          (aff ? ' <span class="hint">（' + aff + '）</span>' : '') +
          ' <span class="hint">' + esc(id) + '</span>';
      }
      function drawBd() {
        if (!bdBox) return;
        bdBox.innerHTML = bdParts.map(function (p) {
          const sel = (bdDraft[p.key] || {}).compId || '';
          return '<div class="mgr-row snap-bd-row" data-part="' + esc(p.key) + '">' +
            '<label>' + esc(p.name) + '<div class="hint" data-bdcur="' + esc(p.key) + '">' + bdRowText(p.key) + '</div></label>' +
            '<select class="ipt" data-bdsel="' + esc(p.key) + '">' + bdOptionsFor(p.key, sel) + '</select>' +
            '<button class="btn mini" data-bdedit="' + esc(p.key) + '" title="把该件载入下方定制配件区，改完装回这个部位">改词条</button>' +
            '</div>';
        }).join('');
        bdBox.querySelectorAll('[data-bdsel]').forEach(function (s) {
          s.onchange = function () {
            const partKey = s.getAttribute('data-bdsel');
            bdDraft[partKey] = { compId: s.value || null };
            const cur = bdBox.querySelector('[data-bdcur="' + partKey + '"]');
            if (cur) cur.innerHTML = bdRowText(partKey);
          };
        });
        bdBox.querySelectorAll('[data-bdedit]').forEach(function (b) {
          b.onclick = function () {
            const partKey = b.getAttribute('data-bdedit');
            const id = (bdDraft[partKey] || {}).compId;
            if (!id) { toast('这个部位现在是标准件：先挑一件装上，再改它的词条', true); return; }
            loadInstanceIntoCustom(id, partKey);
          };
        });
      }
      drawBd();
      ov.querySelector('#snap-save').onclick = function () {
        const inv = {};
        ov.querySelectorAll('[data-inv]').forEach(function (inp) {
          const q = Math.floor(Number(inp.value) || 0);
          if (q > 0) inv[inp.getAttribute('data-inv')] = q;
        });
        // 钓竿装配：只提交「当前装的是哪件」（compId 或 null = 标准件）
        const bd = {};
        bdParts.forEach(function (p) { bd[p.key] = { compId: (bdDraft[p.key] || {}).compId || null }; });
        adminApi('POST', '/api/admin/users/snapshot', { token: token, target: key, coins: Number(ov.querySelector('#snap-coins').value) || 0, inventory: inv, bd: bd }).then(function (rr) {
          if (!rr.ok) { toast(rr.data.error || '保存失败', true); return; }
          toast('快照已保存（含钓竿装配）'); ov.remove(); loadMgrList();
        });
      };
    });
  }
  // 存档回档：列出某个账号的历史快照（新→旧），可回档到任意一份，也可立即补一份。
  // 回档是破坏性操作：行内两步确认（点「回档到这份」→ 再点「确认回档」），服务端另有 confirm 校验。
  function openMgrSnapshots(key) {
    adminApi('GET', '/api/admin/users/snapshots?token=' + encodeURIComponent(token) + '&key=' + encodeURIComponent(key)).then(function (r) {
      if (!r.ok) { toast(r.data.error || '读取存档列表失败', true); return; }
      const d = r.data;
      document.querySelectorAll('.modal-overlay').forEach(function (m) { m.remove(); });
      const ov = document.createElement('div');
      ov.className = 'modal-overlay';
      const rows = d.snapshots.length ? d.snapshots.map(function (s, i) {
        const when = new Date(s.ts).toLocaleString('zh-CN');
        return '<div class="mgr-row snap-line" data-snapname="' + esc(s.name) + '">' +
          '<label>' + esc(when) + '<div class="hint">' + esc(s.name) + ' · ' + Math.max(1, Math.round(s.size / 1024)) + ' KB</div></label>' +
          '<span class="hint">💰 ' + s.coins + ' · ' + s.kinds + ' 种 / ' + s.total + ' 件' +
          (s.rodSlots ? ' · 钓竿槽位 ' + s.rodSlots : '') + ' · 捕获 ' + s.catchCount + '</span>' +
          '<button class="btn mini' + (i === 0 ? ' primary' : '') + '" data-roll="' + esc(s.name) + '">回档到这份</button>' +
          '</div>';
      }).join('') : '<div class="hint">还没有存档快照。点上面的「立即备份」或等定时任务跑一次。</div>';
      ov.innerHTML = '<div class="modal-box confirm-modal snap-modal"><div class="modal-head"><span class="modal-title">存档回档 · ' + esc(key) + '</span></div>' +
        '<div class="modal-body">' +
        '<div class="hint" style="margin-bottom:8px">策略：' +
        (d.cfg.enabled ? '每 ' + d.cfg.intervalMin + ' 分钟自动存一份，每人保留最近 ' + d.cfg.keep + ' 份' : '自动存档已关闭（仍可手动备份）') +
        '；该账号现有 <b>' + d.count + '</b> 份。<br/>回档只覆盖<b>资产</b>（金币 / 背包 / 图鉴 / 钓竿槽位 / 捕获数），' +
        '密码、管理员权限、封禁状态与挂单上限保持不变；回档前会自动留一份「回档前」的快照，点错了能退回来。</div>' +
        '<div class="mgr-row"><button class="btn mini" id="roll-now">立即为这个账号存一份</button>' +
        '<span class="hint">存放在数据目录的 snapshots / ' + esc(key) + ' 下</span></div>' +
        '<div id="roll-list">' + rows + '</div>' +
        '<div class="cf-actions"><button class="btn mini cf-no">关闭</button></div>' +
        '</div></div>';
      document.body.appendChild(ov);
      ov.addEventListener('click', function (e) { if (e.target === ov) ov.remove(); });
      ov.querySelector('.cf-no').onclick = function () { ov.remove(); };
      ov.querySelector('#roll-now').onclick = function () {
        ov.querySelector('#roll-now').disabled = true;
        adminApi('POST', '/api/admin/users/snapshot-now', { token: token, target: key }).then(function (rr) {
          if (!rr.ok) { toast(rr.data.error || '备份失败', true); return; }
          toast('已为 ' + key + ' 存一份快照');
          ov.remove(); openMgrSnapshots(key);
        });
      };
      ov.querySelectorAll('[data-roll]').forEach(function (b) {
        b.onclick = function () {
          const name = b.getAttribute('data-roll');
          const line = b.parentNode;
          line.querySelectorAll('.roll-armed').forEach(function (x) { x.remove(); });
          b.style.display = 'none';
          const act = document.createElement('span');
          act.className = 'roll-armed';
          act.innerHTML = '<button class="btn mini danger" data-roll-go>确认回档</button>' +
            '<button class="btn mini" data-roll-no>取消</button>';
          line.appendChild(act);
          act.querySelector('[data-roll-no]').onclick = function () { act.remove(); b.style.display = ''; };
          act.querySelector('[data-roll-go]').onclick = function () {
            const go = act.querySelector('[data-roll-go]');
            go.disabled = true;
            adminApi('POST', '/api/admin/users/rollback', { token: token, target: key, snap: name, confirm: true }).then(function (rr) {
              if (!rr.ok) { go.disabled = false; toast(rr.data.error || '回档失败', true); return; }
              toast('已回档：金币 ' + rr.data.coins + ' · 物品种类 ' + Object.keys(rr.data.inventory || {}).length);
              ov.remove(); loadMgrList();
            });
          };
        };
      });
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
  // ================================
  // 钓点管理（v0.19.0：取消「钓场」分层，钓点直接铺在世界地图上）
  // ================================
  // 服务端仍以「钓场」为内部容器：全部钓点挂在唯一隐式钓场 'map' 下（出海临时海域 sea:* 不在这里管理）。
  const MAP_GID = 'map';
  // v0.21.2：近岸图 / 远洋图分开管理（与玩家端「🎣 钓鱼」页的两个地图页签同口径）。
  // 以前两张图的钓点混在同一张近岸底图上拖动，远洋点的坐标看着毫无意义。
  let spotMapTab = 'nearshore';
  const mapTabOf = function (sp) { return sp && sp.map === 'voyage' ? 'voyage' : 'nearshore'; };
  function renderGrounds() {
    const main = $('main');
    main.innerHTML = '<h2>🎣 钓点管理</h2>' +
      '<div class="hint" style="margin-bottom:12px">钓点直接铺在世界地图上：列表选中钓点后编辑上鱼率/速率、掉落池（权重实时换算百分比）与增益，或在地图上拖动定位。保存后全服即时生效，正在钓鱼的玩家下一竿即按新配置掷骰。</div>' +
      '<div id="gd-body">加载中…</div>';
    loadWorldCfg(true).then(function (cfg) {
      if (cfg && view === 'grounds') drawGrounds(cfg);
    });
  }
  function drawGrounds(cfg) {
    const g = cfg.grounds.find(function (x) { return x.id === MAP_GID; }) || cfg.grounds[0];
    if (!g) return;
    // 当前页签（近岸/远洋）下的钓点；切换页签时选中项也跟着换到该图的第一个点
    const mapSpots = function (tab) {
      return (g.spots || []).filter(function (s) { return mapTabOf(s) === tab; });
    };
    const curSpots = mapSpots(spotMapTab);
    if (!selSpot || !curSpots.some(function (s) { return s.id === selSpot; })) selSpot = curSpots.length ? curSpots[0].id : null;
    const body = $('gd-body');
    // 拉数据期间页面可能已被切走或重绘（例如快速来回切页签）：容器不在就什么都不做
    if (!body) return;
    const presets = cfg.poolPresets || {};
    const presetOpts = Object.keys(presets).map(function (k) {
      return '<option value="' + k + '">' + esc(presets[k].name) + '</option>';
    }).join('');
    const removedS = cfg.removedSpots || [];
    body.innerHTML =
      '<div class="gd-recovery">' +
      ((removedS.length)
        ? '<div class="gd-removed"><b>已删除钓点（可恢复）</b>：' +
          removedS.map(function (key) {
            const parts = key.split(':');
            return '<span class="gd-chip">🎣 ' + esc(parts[1]) + ' <button class="btn mini" data-rsts="' + esc(key) + '">恢复</button></span>';
          }).join('') + '</div>'
        : '') +
      '</div>' +
      // —— 钓点列表 + 新建 ——
      '<div class="panel">' +
      '<h3 style="margin-top:0">🎣 钓点列表（近岸 ' + mapSpots('nearshore').length + ' / 远洋 ' + mapSpots('voyage').length + '）</h3>' +
      '<div class="gd-tabs">' +
      [['nearshore', '🏞 近岸图'], ['voyage', '⛵ 远洋图']].map(function (kv) {
        return '<button class="btn mini gd-tab' + (spotMapTab === kv[0] ? ' on' : '') + '" data-mtab="' + kv[0] + '">' + kv[1] +
          '<span class="hint">（' + mapSpots(kv[0]).length + '）</span></button>';
      }).join('') +
      '<span class="hint">两张图分别定位：下面的地图与列表只显示当前这张图的钓点</span></div>' +
      '<div class="spot-rows">' + (curSpots.length ? curSpots.map(function (s) {
        const pos = Array.isArray(s.pos) ? s.pos : null;
        return '<div class="spot-row' + (s.id === selSpot ? ' sel' : '') + (s.locked ? ' locked' : '') + '" data-s="' + esc(s.id) + '">' +
          '<b>' + esc(s.name) + '</b>' + (s.locked ? ' 🔒' : '') +
          (s.minShip ? ' <span class="gd-badge limited" title="船级门槛">⛵ ' + s.minShip + ' 级船</span>' : '') +
          '<span class="gi">' + (pos ? '坐标 ' + pos[0] + ', ' + pos[1] : '未定位（在下方地图上拖一下）') +
          ' · 池 ' + (s.pool || []).length + ' 条' +
          ((s.buffs || []).length ? ' · 增益 ' + s.buffs.length + ' 条' : '') +
          (s.biteRate != null && s.biteRate !== '' ? ' · 上鱼率 ' + s.biteRate + '%' : '') +
          (s.intervalMs != null && s.intervalMs !== '' ? ' · 间隔 ' + s.intervalMs + 'ms' : '') + '</span>' +
          '<button class="btn mini" data-lock="' + esc(s.id) + '">' + (s.locked ? '解锁' : '锁定') + '</button>' +
          '</div>';
      }).join('') : '<div class="hint">这张图上还没有钓点，用下面的「＋ 新建钓点」添加（所属图已按当前页签预选）。</div>') + '</div>' +
      '<div class="mgr-row" style="margin-top:10px"><input id="ns-name" class="ipt gi-name" placeholder="新钓点名称" maxlength="20" />' +
      '<select id="ns-preset" class="ipt gi-type">' + presetOpts + '</select>' +
      '<label class="hint">所属图</label><select id="ns-map" class="ipt gi-type"><option value=""' + (spotMapTab === 'nearshore' ? ' selected' : '') + '>近岸图</option><option value="voyage"' + (spotMapTab === 'voyage' ? ' selected' : '') + '>远洋图</option></select>' +
      '<label class="hint">船级门槛</label><input id="ns-ship" class="ipt mk-num" type="number" min="0" max="5" step="1" placeholder="0=不限" style="width:70px" />' +
      '<button class="btn mini" id="ns-add">＋ 新建钓点（一键填充）</button>' +
      (curSpots.length ? '<button class="btn mini danger" id="ns-del">🗑 删除当前钓点</button>' : '') +
      '</div></div>' +
      '<div class="panel gd-location"><div id="gd-map"></div><div id="ed-body"></div></div>' +
      // —— 战利品组（可整组放进掉落池） ——
      '<div class="panel gd-loot-groups">' +
      '<h3 style="margin-top:0">🧺 战利品组（' + ((cfg.lootGroups || []).length) + '）</h3>' +
      '<div class="hint" style="margin-bottom:8px">战利品组可以<b>整组</b>放进钓点掉落池：先按池内权重选中整组，再按组内权重抽到具体条目。' +
      '「默认权重」只是新建/加入钓点时的建议值，真正生效的是它在各钓点池子里的条目权重（可以逐点微调）。</div>' +
      '<div id="lg-list"></div>' +
      '<div class="mgr-row" style="margin-top:10px">' +
      '<input id="lg-name" class="ipt gi-name" placeholder="新战利品组名称" maxlength="20" />' +
      '<input id="lg-weight" class="ipt mk-num" type="number" min="0" max="1000000" step="1" value="10" style="width:96px" title="组在掉落池里的默认权重" />' +
      '<button class="btn mini" id="lg-add">＋ 新建战利品组</button>' +
      '<span id="lg-state" class="hint"></span></div>' +
      '<div id="lg-edit"></div></div>';

    // —— 钓点列表：切图 / 选中 / 锁定 / 恢复 ——
    body.querySelectorAll('[data-mtab]').forEach(function (b) {
      b.onclick = function () {
        const tab = b.getAttribute('data-mtab');
        if (tab === spotMapTab) return;
        spotMapTab = tab;
        selSpot = null;            // 交给 drawGrounds 在新图里重新选（选到该图第一个钓点）
        poolDirty = buffsDirty = false; posDraft = {};
        drawGrounds(cfg);
      };
    });
    body.querySelectorAll('.spot-row').forEach(function (row) {
      row.onclick = function (ev) {
        if (ev.target && ev.target.getAttribute && ev.target.getAttribute('data-lock')) return;
        selSpot = row.getAttribute('data-s');
        poolDirty = buffsDirty = false; posDraft = {};
        drawGrounds(cfg);
      };
    });
    body.querySelectorAll('[data-lock]').forEach(function (b) {
      b.onclick = function (ev) {
        ev.stopPropagation();
        const sid = b.getAttribute('data-lock');
        const spNow = g.spots.find(function (x) { return x.id === sid; });
        adminApi('POST', '/api/admin/spot/lock', { token: token, groundId: MAP_GID, spotId: sid, locked: !(spNow && spNow.locked) }).then(function (r) {
          if (!r.ok) { toast(r.data.error || '操作失败', true); return; }
          toast(r.data.locked ? '钓点已锁定（该点钓鱼已停止）' : '钓点已解锁');
          loadWorldCfg(true).then(function (c2) { if (view === 'grounds' && c2) drawGrounds(c2); });
        });
      };
    });
    body.querySelectorAll('[data-rsts]').forEach(function (b) {
      b.onclick = function () {
        const parts = b.getAttribute('data-rsts').split(':');
        adminApi('POST', '/api/admin/ground/restore', { token: token, groundId: parts[0], spotId: parts[1] }).then(function (r) {
          if (!r.ok) { toast(r.data.error || '恢复失败', true); return; }
          toast('钓点已恢复');
          loadWorldCfg(true).then(function (c2) { if (view === 'grounds' && c2) drawGrounds(c2); });
        });
      };
    });
    // —— 新建 / 删除钓点 ——
    $('ns-add').onclick = function () {
      const name = $('ns-name').value.trim();
      if (!name) { toast('请填写新钓点名称', true); return; }
      const autoId = 'spot_' + Date.now().toString(36);
      adminApi('POST', '/api/admin/spot/add', {
        token: token, groundId: MAP_GID, id: autoId, name: name,
        preset: $('ns-preset').value, fill: true,
        map: $('ns-map').value || null, minShip: Number($('ns-ship').value) || 0,
      }).then(function (r) {
        if (!r.ok) { toast(r.data.error || '创建失败', true); return; }
        toast('钓点「' + name + '」已创建（掉落池已按预设填充）');
        selSpot = r.data.spot.id;
        spotMapTab = mapTabOf(r.data.spot);   // 新点建在另一张图上时自动切过去，否则看不到它
        poolDirty = buffsDirty = false; posDraft = {};
        loadWorldCfg(true).then(function (c2) { if (view === 'grounds' && c2) drawGrounds(c2); });
      });
    };
    if ($('ns-del')) {
      $('ns-del').onclick = function () {
        const spNow = curSpots.find(function (x) { return x.id === selSpot; });
        if (!spNow) return;
        confirmModalLocal('删除钓点「' + spNow.name + '」？在该点钓鱼的玩家会被停止（内置钓点可在「已删除钓点」中恢复）。').then(function (ok) {
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

    drawLootGroupManager(cfg);
    drawSpotMap(g, curSpots, g.spots);
    const sp = curSpots.find(function (x) { return x.id === selSpot; });
    if (!sp) { $('ed-body').innerHTML = '<div class="hint">这张图上还没有钓点，可用上方「＋ 新建钓点」添加（自动填充掉落池）。</div>'; return; }
    // 草稿：首次进入或切换钓点时从服务器数据拷贝
    if (!poolDirty && !buffsDirty) {
      poolDraft = (sp.pool || []).map(function (e) { return poolToRow(e.pick, e.weight); });
      buffsDraft = (sp.buffs || []).map(function (b) { return { type: b.type, value: b.value }; });
    }
    drawEditors(cfg, g, sp);
  }
  // ---- 钓点地图定位（拖动设置）----
  // 玩家端「钓鱼」页的两张图各有一套坐标：近岸图 = assets/worldmap.png，远洋图 = voyage-map.js 的 CSS 像素海图
  // （与玩家端「⛵ 远洋」页签同一份底图，坐标口径一致，后台看到的pos 就是玩家看到的pos）。
  // 拖动节点 = 改坐标，坐标以地图宽高的百分比保存（2~98，防止拖出视野）。
  // 草稿存在 posDraft（模块级），因此上鱼广播/切页重绘都不会丢掉尚未保存的拖动结果。
  function drawSpotMap(g, spots, allSpots) {
    const host = $('gd-map');
    if (!host) return;
    spots = spots || [];
    host.innerHTML = '<h3>🗺 地图定位 — ' + (spotMapTab === 'voyage' ? '远洋图' : '近岸图') + ' · ' + esc(g.name) + '</h3>';
    if (!spots.length) {
      host.innerHTML += '<div class="hint">这张图上还没有钓点。切到「' + (spotMapTab === 'voyage' ? '🏞 近岸图' : '⛵ 远洋图') +
        '」可编辑另一张图的钓点；新建时「所属图」记得选对。</div>';
      return;
    }
    const posOf = function (sp) { return posDraft[sp.id] || (Array.isArray(sp.pos) ? sp.pos : null) || [50, 50]; };
    host.innerHTML +=
      '<div class="hint" style="margin-bottom:8px">直接拖动节点调整钓点在玩家端世界地图上的位置（坐标 = 地图宽高的百分比）。' +
      '「恢复出厂」把该钓点退回 data.js 的默认坐标。改完点「保存坐标」立即对全服生效。</div>' +
      '<div class="gd-map' + (spotMapTab === 'voyage' ? ' gd-map-voyage' : '') + '" id="gd-map-canvas">' +
      (spotMapTab === 'voyage' ? '' : '<img class="gd-map-img" src="assets/worldmap.png" alt="" draggable="false">') +
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
    // 远洋底图：与玩家端同一份 CSS 像素海图（节点百分比坐标口径一致），垫在所有节点下面
    if (spotMapTab === 'voyage') {
      const wrap = document.createElement('div');
      wrap.className = 'px-map-voyage';
      if (window.VoyageMap) wrap.appendChild(window.VoyageMap.create());
      else wrap.innerHTML = '<img class="gd-map-img" src="assets/voyagemap.png" alt="" draggable="false">';
      canvas.insertBefore(wrap, canvas.firstChild);
    }
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
      // 两张图的钓点一起保存：切页签之前的拖动也在这个 posDraft 里，别只存当前这张图
      const list = (allSpots || spots).map(function (sp) {
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
      confirmModalLocal('把「近岸图 + 远洋图」的钓点坐标全部恢复为出厂值？').then(function (ok) {
        if (!ok) return;
        adminApi('POST', '/api/admin/spot/pos', {
          token: token, groundId: g.id,
          list: (allSpots || spots).map(function (sp) { return { spotId: sp.id, pos: null }; }),
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
  function poolToRow(pick, weight) {
    const i = pick.indexOf(':');
    const type = pick.slice(0, i);
    const id = pick.slice(i + 1);
    return { type: type, id: id, weight: weight };
  }
  function rowToPick(r) { return r.type + ':' + (r.id || ''); }

  function drawEditors(cfg, g, sp) {
    const ed = $('ed-body');
    const presetOpts2 = Object.keys(cfg.poolPresets || {}).map(function (k) {
      return '<option value="' + k + '">' + esc(cfg.poolPresets[k].name) + '</option>';
    }).join('');
    const rateBite = sp.biteRate != null && sp.biteRate !== '' ? sp.biteRate : '';
    const rateMs = sp.intervalMs != null && sp.intervalMs !== '' ? sp.intervalMs : '';
    ed.innerHTML = '<h3>🎯 钓点独立上鱼率 / 速率 — ' + esc(g.name) + ' · ' + esc(sp.name) + '</h3>' +
      '<div class="hint" style="margin-bottom:8px">留空 = 使用全服默认：上鱼率走「公式管理」的上钩公式，抛竿间隔按「基础间隔 + 钓速」计算。' +
      '上鱼率填 100 表示该钓点必上钩；间隔填写后仅替换该钓点的基础值，玩家钓速仍通过抛竿公式影响最终间隔（受最短间隔限制）。</div>' +
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

    // 钓点增益可选的类别 = 组件词缀表 affixTypes（v0.13.3 起两者同一套：不再多一类「大鱼概率」）
    const affixes = cfg.affixTypes || {};
    const buffNote = {
      speed: '钓速：独立修正钓点基础间隔（× (1-数值/100)），不计入上钩公式 speed',
      rare: '稀有度：降低普通品质物品的权重（普通品质权重 × K/(K+R)，K 见「🧮 公式管理」）', material: '材料概率：钓点所有材料最终权重 = 初始权重 × (1 + 材料概率/100)，包含战利品组内材料',
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
          '<option value="group"' + (r.type === 'group' ? ' selected' : '') + '>战利品组</option>' +
          '</select>' +
          itemSelectHtml(cfg, r, idx) +
          '<input class="ipt c-w" type="number" min="0" step="1" value="' + esc(r.weight) + '" data-idx="' + idx + '" data-f="weight">' +
          '<div class="c-pct"><div class="pct-bar"><i data-bar="' + idx + '"></i></div><span class="pct-val" data-pct="' + idx + '"></span></div>' +
          '<button class="row-del" data-del="' + idx + '" title="删除">✕</button>' +
          '</div>';
      }).join('');
      wrap.querySelectorAll('select').forEach(function (sel) {
        sel.onchange = function () { const r = poolDraft[+sel.getAttribute('data-idx')]; r[sel.getAttribute('data-f')] = sel.value; if (sel.getAttribute('data-f') === 'type') r.id = ''; if (r.type === 'group' && sel.getAttribute('data-f') === 'id') { const group = (cfg.lootGroups || []).find(function (g) { return g.id === r.id; }); if (group) r.weight = group.weight; } poolDirty = true; drawPool(); };
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
        loadWorldCfg(true).then(function (c) { if (view === 'grounds' && c) drawGrounds(c); });
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

    function itemSelectHtml(cfg, r, idx) {
      if (r.type === 'component') {
        const options = [{ id: '', name: '全部组件随机' }].concat(
          GameData.ROD_PARTS.filter(function (p) { return !p.isCharm; }).map(function (p) { return { id: 'part/' + p.key, name: '类型 · ' + p.name }; }),
          GameData.COMPONENT_BASES.map(function (b) { return { id: 'base/' + b.id, name: '底材 · ' + b.name }; }));
        return '<select class="ipt c-item" data-idx="' + idx + '" data-f="id">' + options.map(function (o) {
          return '<option value="' + esc(o.id) + '"' + (r.id === o.id ? ' selected' : '') + '>' + esc(o.name) + '</option>';
        }).join('') + '</select>';
      }
      if (r.type === 'group') {
        const groups = cfg.lootGroups || [];
        if (!groups.length) return '<select class="ipt c-item" disabled><option>先去下面新建战利品组</option></select>';
        return '<select class="ipt c-item" data-idx="' + idx + '" data-f="id">' +
          '<option value=""' + (!r.id ? ' selected' : '') + '>— 选择战利品组 —</option>' +
          groups.map(function (o) {
            return '<option value="' + esc(o.id) + '"' + (r.id === o.id ? ' selected' : '') + '>' + esc(o.name) +
              '（' + (o.items || []).length + ' 项 · 权重 ' + esc(o.weight) + '）</option>';
          }).join('') + '</select>';
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

  function drawLootGroupManager(cfg) {
    // ---- 战利品组：列表 / 新建 / 编辑 / 删除（整组可当作一条战利品放进掉落池） ----
    function lgItemLabel(pick) {
      const i = pick.indexOf(':');
      const type = pick.slice(0, i), id = pick.slice(i + 1);
      if (type === 'component') {
        const base = GameData.COMPONENT_BASES.find(function (b) { return 'base/' + b.id === id; });
        const part = GameData.ROD_PARTS.find(function (p) { return 'part/' + p.key === id; });
        return base ? base.name : part ? part.name + '（随机底材）' : '随机组件';
      }
      const opts = type === 'fish' ? cfg.catalog.fish : cfg.catalog.materials;
      const f = (opts || []).find(function (o) { return o.id === id; });
      return f ? f.name : id;
    }
    function lgNewId() {
      const used = {};
      (cfg.lootGroups || []).forEach(function (g) { used[g.id] = 1; });
      let id = '';
      do { id = 'lg' + Math.random().toString(36).slice(2, 8); } while (used[id]);
      return id;
    }
    function lgPayload() {
      return {
        token: token,
        group: {
          id: lgEditing || lgNewId(), name: (lgDraft.name || '').trim(),
          weight: Number(lgDraft.weight) || 0,
          items: (lgDraft.items || []).map(function (r) { return { pick: rowToPick(r), weight: Number(r.weight) || 0 }; }),
        },
      };
    }
    function lgAfterSave(msg) {
      lgDraft = null; lgEditing = '';
      toast(msg);
      loadWorldCfg(true).then(function (c) { if (view === 'grounds' && c) drawGrounds(c); });
    }
    function lgPost(payload, okMsg) {
      return adminApi('POST', '/api/admin/loot/group', payload).then(function (r) {
        if (!r.ok) { toast(r.data.error || '保存失败', true); return; }
        if ($('lg-state')) $('lg-state').textContent = '';
        lgAfterSave(okMsg);
      });
    }
    function openLgEditor(id) {
      const g = (cfg.lootGroups || []).find(function (x) { return x.id === id; });
      if (!g) return;
      lgEditing = g.id;
      lgDraft = {
        name: g.name, weight: Number(g.weight) || 0,
        items: (g.items || []).map(function (e) { return poolToRow(e.pick, e.weight); }),
      };
      drawLootGroups();
    }
    function deleteLg(id) {
      const g = (cfg.lootGroups || []).find(function (x) { return x.id === id; });
      confirmModalLocal('删除战利品组「' + (g ? g.name : id) + '」？各钓点掉落池里指向它的条目会一并移除。').then(function (ok) {
        if (!ok) return;
        if (lgEditing === id) { lgDraft = null; lgEditing = ''; }
        lgPost({ token: token, action: 'delete', id: id }, '战利品组已删除');
      });
    }
    function drawLgRows() {
      const wrap = $('lge-rows');
      if (!wrap || !lgDraft) return;
      if (!lgDraft.items.length) {
        wrap.innerHTML = '<div class="hint" style="margin-bottom:8px">组内还没有条目，点下面「＋ 添加条目」。</div>';
        return;
      }
      wrap.innerHTML = lgDraft.items.map(function (r, idx) {
        return '<div class="pool-row">' +
          '<select class="ipt c-type" data-idx="' + idx + '" data-f="type">' +
          '<option value="fish"' + (r.type === 'fish' ? ' selected' : '') + '>鱼</option>' +
          '<option value="material"' + (r.type === 'material' ? ' selected' : '') + '>材料</option>' +
          '<option value="component"' + (r.type === 'component' ? ' selected' : '') + '>组件</option>' +
          '</select>' +
          itemSelectHtml(cfg, r, idx) +
          '<input class="ipt c-w" type="number" min="0" step="1" value="' + esc(r.weight) + '" data-idx="' + idx + '" data-f="weight" title="组内权重（只决定这一项在本组里的占比）">' +
          '<div class="c-pct"><div class="pct-bar"><i data-bar="' + idx + '"></i></div><span class="pct-val" data-pct="' + idx + '"></span></div>' +
          '<button class="row-del" data-del="' + idx + '" title="删除">✕</button></div>';
      }).join('');
      wrap.querySelectorAll('select').forEach(function (sel) {
        sel.onchange = function () {
          const r = lgDraft.items[+sel.getAttribute('data-idx')];
          r[sel.getAttribute('data-f')] = sel.value;
          if (sel.getAttribute('data-f') === 'type') r.id = '';
          drawLgRows();
        };
      });
      wrap.querySelectorAll('input').forEach(function (inp) {
        inp.oninput = function () { lgDraft.items[+inp.getAttribute('data-idx')].weight = Number(inp.value) || 0; updateLgPcts(); };
      });
      wrap.querySelectorAll('[data-del]').forEach(function (b) {
        b.onclick = function () { lgDraft.items.splice(+b.getAttribute('data-del'), 1); drawLgRows(); };
      });
      updateLgPcts();
      function updateLgPcts() {
        const total = lgDraft.items.reduce(function (n, r) { return n + (Number(r.weight) || 0); }, 0);
        const st = $('lge-state');
        if (st) st.innerHTML = total > 0 ? '组内总权重 ' + (Math.round(total * 100) / 100) + ' · 下面是组内占比' : '<span class="err">组内总权重为 0</span>';
        lgDraft.items.forEach(function (r, i) {
          const pct = total > 0 ? (Number(r.weight) || 0) / total * 100 : 0;
          const bar = wrap.querySelector('[data-bar="' + i + '"]'); if (bar) bar.style.width = Math.min(100, pct) + '%';
          const pv = wrap.querySelector('[data-pct="' + i + '"]'); if (pv) pv.textContent = (Math.round(pct * 100) / 100) + '%';
        });
      }
    }
    function drawLgEdit() {
      const wrap = $('lg-edit');
      if (!wrap) return;
      if (!lgDraft) { wrap.innerHTML = ''; return; }
      wrap.innerHTML = '<div class="panel lg-edit"><h3 style="margin-top:0">🧺 编辑战利品组' + (lgEditing ? '' : '（新建）') + '</h3>' +
        '<div class="mgr-row"><label>名称</label>' +
        '<input id="lge-name" class="ipt gi-name" maxlength="20" placeholder="组名称" value="' + esc(lgDraft.name) + '" />' +
        '<label class="hint">默认权重</label>' +
        '<input id="lge-weight" class="ipt mk-num" type="number" min="0" max="1000000" step="1" style="width:96px" value="' + esc(lgDraft.weight) + '" />' +
        '<span class="hint">加进钓点掉落池时的建议权重（可在池子里逐条改）</span></div>' +
        '<div class="hint" style="margin:10px 0 6px">组内条目（只允许 鱼 / 材料 / 组件；权重只决定组内占比）：</div>' +
        '<div id="lge-rows"></div>' +
        '<div class="editor-foot"><button class="btn mini" id="lge-add">＋ 添加条目</button>' +
        '<span id="lge-state" class="hint"></span><span style="flex:1"></span>' +
        '<button class="btn mini" id="lge-cancel">取消</button>' +
        '<button class="btn primary" id="lge-save">保存战利品组</button></div></div>';
      const name = $('lge-name'), weight = $('lge-weight');
      name.oninput = function () { lgDraft.name = name.value; };
      weight.oninput = function () { lgDraft.weight = Number(weight.value) || 0; };
      $('lge-add').onclick = function () { lgDraft.items.push({ type: 'fish', id: '', weight: 10 }); drawLgRows(); };
      $('lge-cancel').onclick = function () { lgDraft = null; lgEditing = ''; drawLootGroups(); };
      $('lge-save').onclick = function () {
        const nm = (lgDraft.name || '').trim();
        if (!nm) { toast('请先填组名称', true); name.focus(); return; }
        if (!lgDraft.items.length) { toast('至少添加 1 个组内条目', true); return; }
        const bad = lgDraft.items.find(function (r) { return r.type !== 'component' && !r.id; });
        if (bad) { toast('有条目还没选具体物品', true); return; }
        lgPost(lgPayload(), '战利品组已保存，全服即时生效');
      };
      drawLgRows();
    }
    function drawLootGroups() {
      const list = $('lg-list');
      if (!list) return;
      const groups = cfg.lootGroups || [];
      list.innerHTML = groups.length
        ? groups.map(function (g) {
          const items = g.items || [];
          return '<div class="lg-row' + (lgDraft && lgEditing === g.id ? ' sel' : '') + '">' +
            '<b>' + esc(g.name) + '</b>' +
            '<span class="gi">' + items.length + ' 项产出 · 默认权重 ' + esc(g.weight) + ' · ' +
            esc(items.slice(0, 6).map(function (it) { return lgItemLabel(it.pick); }).join('、')) + (items.length > 6 ? '…' : '') + '</span>' +
            '<button class="btn mini" data-lge="' + esc(g.id) + '">' + (lgDraft && lgEditing === g.id ? '编辑中' : '编辑') + '</button>' +
            '<button class="btn mini danger" data-lgd="' + esc(g.id) + '">删除</button></div>';
        }).join('')
        : '<div class="hint" style="margin-bottom:8px">还没有战利品组：先填名字与默认权重，点「＋ 新建战利品组」，再往里添加鱼 / 材料 / 组件。</div>';
      list.querySelectorAll('[data-lge]').forEach(function (b) { b.onclick = function () { openLgEditor(b.getAttribute('data-lge')); }; });
      list.querySelectorAll('[data-lgd]').forEach(function (b) { b.onclick = function () { deleteLg(b.getAttribute('data-lgd')); }; });
      drawLgEdit();
    }
    $('lg-add').onclick = function () {
      const nm = ($('lg-name').value || '').trim();
      const w = Number($('lg-weight').value) || 0;
      if (!nm) { toast('请先填战利品组名称', true); $('lg-name').focus(); return; }
      if ((cfg.lootGroups || []).some(function (g) { return g.name === nm; })) { toast('已有同名战利品组', true); return; }
      lgEditing = '';
      lgDraft = { name: nm, weight: w, items: [{ type: 'fish', id: '', weight: 10 }] };
      drawLootGroups();
      if ($('lge-name')) $('lge-name').focus();
    };
    drawLootGroups();
  }

  // ================================
  // 市集管理
  // ================================
  // ---- 后台批量上架（活跃市场）----
  // 以某个账号的「名头」一次挂出一批现造的鱼 / 材料 / 宝匣 / 组件实例，用来把空市集填活。
  // 组件走 data.js 的 genComponent（与钓鱼掉落同一条路径）→ 池内底材 + 自然区间数值，即「正常配件」。
  // 面板参数存 localStorage：管理员会反复用同一套参数补货，不必每次重填。
  // 物品清单统一走 GameData.allItems()（带 kind 标签）：GameData.FISH 是**按 id 索引的对象**、
  // MATERIALS / CHESTS 才是数组，直接 .map 会抛「不是函数」把面板整块打空。
  const BULK_KINDS = [
    { id: 'fish', label: '🐟 鱼类' },
    { id: 'material', label: '🧵 材料' },
    { id: 'chest', label: '🎁 宝匣' },
    { id: 'component', label: '🔧 组件底材' },
  ];
  function bulkItemsOf(kind) {
    if (kind === 'component') {
      return (typeof GameData !== 'undefined' ? GameData.COMPONENT_BASES : []).map(function (b) { return { id: b.id, name: b.name }; });
    }
    if (typeof GameData === 'undefined' || !GameData.allItems) return [];
    return GameData.allItems().filter(function (i) { return i.kind === kind; }).map(function (i) { return { id: i.id, name: i.name }; });
  }
  const BULK_QUALITIES = [['common', '普通'], ['rare', '稀有'], ['epic', '史诗'], ['mythic', '神话']];
  let blCfg = null;
  function bulkCfg() {
    if (blCfg) return blCfg;
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem('fishing_admin_bulk') || 'null'); } catch (e) {}
    blCfg = Object.assign({
      sellers: [], mode: 'immediate', batch: 10, intervalSeconds: 60, threshold: 10, target: 50,
      seller: '', hours: 24, mulMin: 1, mulMax: 1, qtyMin: 1, qtyMax: 1,
      counts: { fish: 0, material: 0, chest: 0, component: 200 },
      picks: { fish: [], material: [], chest: [], component: [] },
      part: '', quality: { common: 3, rare: 2, epic: 1, mythic: 0 }, affixMin: 1, affixMax: 0,
    }, saved || {});
    return blCfg;
  }
  function bulkSave() { try { localStorage.setItem('fishing_admin_bulk', JSON.stringify(bulkCfg())); } catch (e) {} }
  function bulkPanelHtml() {
    const c = bulkCfg();
    const nums = function (id, val, min, max, step) {
      return '<input id="' + id + '" class="ipt mk-num" type="number" min="' + min + '" max="' + max + '"' +
        (step ? ' step="' + step + '"' : '') + ' value="' + esc(val) + '" />';
    };
    return '<div class="panel mk-bulk">' +
      '<h3>🎪 后台批量上架 <span class="hint">以某个账号的名头挂出一批服务器现造的物品（不扣背包、不收上架费、不受挂单上限限制；上限在「账号管理」页按账号调）</span></h3>' +
      '<div class="bl-row">' +
      '<label>添加卖家</label><select id="bl-seller" class="ipt"><option value="">加载账号…</option></select><button type="button" class="btn mini" id="bl-seller-add">加入随机名单</button><div id="bl-sellers" class="bl-sellers"></div>' +
      '<label>时长</label><select id="bl-hours" class="ipt">' +
      [6, 12, 24].map(function (h) { return '<option value="' + h + '"' + (c.hours === h ? ' selected' : '') + '>' + h + ' 小时</option>'; }).join('') +
      '</select>' +
      '<label>价格倍率</label>' + nums('bl-mulmin', c.mulMin, 0.1, 10, 0.05) + '<span class="hint">~</span>' + nums('bl-mulmax', c.mulMax, 0.1, 10, 0.05) +
      '<span class="hint">（现价的倍数，1 = 原价；组件按品质固定价）</span>' +
      '</div>' +
      '<div class="bl-row"><label>上架模式</label><select id="bl-mode" class="ipt">' +
      [['immediate', '立即上架'], ['gradual', '按间隔分批上架'], ['restock', '条件补货']].map(function (kv) { return '<option value="' + kv[0] + '"' + (c.mode === kv[0] ? ' selected' : '') + '>' + kv[1] + '</option>'; }).join('') + '</select>' +
      '<label>每批条数</label>' + nums('bl-batch', c.batch, 1, 500) + '<label>间隔秒数</label>' + nums('bl-interval', c.intervalSeconds, 1, 86400) +
      '<label>低于多少条补货</label>' + nums('bl-threshold', c.threshold, 1, 5000) + '<label>补到多少条</label>' + nums('bl-target', c.target, 1, 5000) + '</div>' +
      '<p class="hint">分批上架按各类条数完成后停止；条件补货以各类条数为抽取权重，仅统计本计划尚未售罄、未过期的挂单条数。达到阈值后分批补至目标。新计划会替换旧计划。</p>' +
      '<div class="bl-row"><span id="bl-supply-status" role="status">读取计划…</span><button class="btn mini" id="bl-supply-refresh">刷新计划</button><button class="btn mini danger" id="bl-supply-pause">暂停计划</button><button class="btn mini" id="bl-supply-load">载入计划设置</button></div>' +
      '<div class="bl-grid">' +
      BULK_KINDS.map(function (k) {
        const items = bulkItemsOf(k.id);
        const picked = (c.picks && c.picks[k.id]) || [];
        // 勾选列表而非原生多选：原生 multiple 里单击是「选择」、取消要按 Ctrl，选错了没法清掉
        return '<div class="bl-card"><div class="bl-head"><span>' + k.label + '</span>' +
          nums('bl-c-' + k.id, (c.counts && c.counts[k.id]) || 0, 0, 500) + '<span class="hint">条</span></div>' +
          '<input class="ipt bl-search" data-search-kind="' + k.id + '" placeholder="搜索' + k.label + '" aria-label="搜索物品" />' +
          '<div class="bl-pick" id="bl-p-' + k.id + '">' +
          items.map(function (it) {
            return '<label class="bl-opt"><input type="checkbox" value="' + esc(it.id) + '"' +
              (picked.indexOf(it.id) >= 0 ? ' checked' : '') + ' /><span>' + esc(it.name) + '</span></label>';
          }).join('') +
          '</div>' +
          '<div class="bl-pickbar"><span class="hint">不选 = 该类全部随机</span>' +
          '<span class="bl-picked" id="bl-pn-' + k.id + '"></span>' +
          '<button type="button" class="btn mini bl-clr" data-clr="' + k.id + '" title="取消该类全部已勾选项">清空选择</button>' +
          '</div></div>';
      }).join('') +
      '</div>' +
      '<div class="bl-row">' +
      '<label>组件部位</label><select id="bl-part" class="ipt"><option value="">全部部位</option>' +
      (typeof GameData !== 'undefined' ? GameData.ROD_PARTS.filter(function (p) { return !p.isCharm; }) : []).map(function (p) {
        return '<option value="' + p.key + '"' + (c.part === p.key ? ' selected' : '') + '>' + esc(p.name) + '</option>';
      }).join('') + '</select>' +
      '<label>品质权重</label>' +
      BULK_QUALITIES.map(function (kv) { return '<span class="bl-q"><span>' + kv[1] + '</span>' + nums('bl-q-' + kv[0], (c.quality && c.quality[kv[0]] != null) ? c.quality[kv[0]] : 0, 0, 99) + '</span>'; }).join('') +
      '<label>词条数</label>' + nums('bl-affmin', c.affixMin, 1, 4) + '<span class="hint">~</span>' + nums('bl-affmax', c.affixMax, 0, 4) +
      '<span class="hint">（0 = 该品质上限，1~4）</span>' +
      '<label>每单数量</label>' + nums('bl-qmin', c.qtyMin, 1, 999) + '<span class="hint">~</span>' + nums('bl-qmax', c.qtyMax, 1, 999) +
      '<span class="hint">（组件每单固定 1 件）</span>' +
      '</div>' +
      '<div class="bl-row bl-foot">' +
      '<button id="bl-preview" class="btn mini">预览 8 条</button>' +
      '<button id="bl-go" class="btn primary">上架 / 启动计划</button>' +
      '<span id="bl-state" class="hint">先点「预览」看看生成结果，再上架。单次最多 500 条（条数越多玩家端市集列表越长，建议单次 ≤ 200）；过期或被退回时直接清除，不退回背包。</span>' +
      '</div>' +
      '<div id="bl-prev" class="hint"></div>' +
      '</div>';
  }
  function bulkReadForm() {
    const c = bulkCfg();
    const val = function (id) { const el = $(id); return el ? el.value : ''; };
    const num = function (id, def) { const n = Number(val(id)); return isFinite(n) ? n : def; };
    c.hours = Number(val('bl-hours')) || 24;
    c.mulMin = num('bl-mulmin', 1); c.mulMax = num('bl-mulmax', 1);
    c.qtyMin = num('bl-qmin', 1); c.qtyMax = num('bl-qmax', 1);
    c.affixMin = num('bl-affmin', 1); c.affixMax = num('bl-affmax', 0);
    c.part = val('bl-part');
    c.seller = val('bl-seller');
    c.mode = val('bl-mode'); c.batch = num('bl-batch', 10); c.intervalSeconds = num('bl-interval', 60);
    c.threshold = num('bl-threshold', 10); c.target = num('bl-target', 50);
    c.sellerName = '';
    const sel = $('bl-seller');
    if (sel && sel.selectedIndex >= 0 && sel.options[sel.selectedIndex]) c.sellerName = sel.options[sel.selectedIndex].getAttribute('data-name') || '';
    c.counts = {}; c.picks = {}; c.quality = {};
    BULK_KINDS.forEach(function (k) {
      c.counts[k.id] = Math.max(0, num('bl-c-' + k.id, 0));
      const ps = $('bl-p-' + k.id);
      c.picks[k.id] = ps ? Array.prototype.filter.call(ps.querySelectorAll('input[type=checkbox]'), function (o) { return o.checked; }).map(function (o) { return o.value; }) : [];
    });
    BULK_QUALITIES.forEach(function (kv) { c.quality[kv[0]] = Math.max(0, num('bl-q-' + kv[0], 0)); });
    bulkSave();
    return c;
  }
  function bulkPayload(dryRun) {
    const c = bulkReadForm();
    return {
      token: token, seller: c.seller, sellers: c.sellers.length ? c.sellers.slice() : [c.seller], hours: c.hours, dryRun: !!dryRun,
      mode: c.mode, batch: c.batch, intervalSeconds: c.intervalSeconds, threshold: c.threshold, target: c.target,
      counts: c.counts, picks: c.picks, part: c.part, quality: c.quality,
      affixMin: c.affixMin, affixMax: c.affixMax, qtyMin: c.qtyMin, qtyMax: c.qtyMax,
      mulMin: c.mulMin, mulMax: c.mulMax,
    };
  }
  // 预览与上架共用一段渲染：样例 + 各类条数 + 总价值
  function bulkReport(d) {
    const kindName = { fish: '鱼类', material: '材料', chest: '宝匣', component: '组件' };
    const by = d.byKind || {};
    return '共 <b>' + d.count + '</b> 条（' + Object.keys(by).map(function (k) { return kindName[k] + ' ' + by[k] + ' 条'; }).join(' · ') +
      '）· 时长 ' + d.hours + ' 小时 · 价格倍率 ' + esc(String(d.mul)) + ' · 定价总额约 <b>' + d.totalValue + '</b>💰<br>' +
      (d.samples || []).map(function (s) {
        return '· ' + esc(s.name) + ' ×' + s.qty + ' @ ' + s.price + '💰' + (s.quality ? '（' + s.quality + (s.affixN ? ' · ' + s.affixN + ' 词条' : '') + '）' : '');
      }).join('<br>');
  }
  function bulkSetState(msg, err) {
    const el = $('bl-state');
    if (el) { el.innerHTML = msg; el.style.color = err ? 'var(--bad)' : ''; }
  }
  // 勾选列表：已选件数就地刷新（不动 DOM 结构，避免滚动位置跳动）
  function bulkSyncPick(kind) {
    const box = $('bl-p-' + kind);
    const n = box ? box.querySelectorAll('input[type=checkbox]:checked').length : 0;
    const badge = $('bl-pn-' + kind);
    if (badge) badge.textContent = n ? '已选 ' + n + ' 项' : '';
  }
  // 清空该类全部勾选：取消勾选 + 立即写回 localStorage（选错了不用挨个点掉）
  function bulkClearPick(kind) {
    const box = $('bl-p-' + kind);
    if (box) Array.prototype.forEach.call(box.querySelectorAll('input[type=checkbox]'), function (cb) { cb.checked = false; });
    bulkSyncPick(kind);
    bulkReadForm();
  }
  function wireBulkPanel() {
    let savedRule = null;
    function drawSellers() {
      const c = bulkCfg();
      $('bl-sellers').innerHTML = c.sellers.length ? c.sellers.map(function (key, i) { return '<button type="button" class="btn mini" data-remove-seller="' + i + '" title="移出随机名单">' + esc(key) + ' ×</button>'; }).join('') : '<span class="hint">名单为空时使用当前下拉账号；加入多人后每单随机选择。</span>';
      $('bl-sellers').querySelectorAll('[data-remove-seller]').forEach(function (b) { b.onclick = function () { c.sellers.splice(Number(b.dataset.removeSeller), 1); bulkSave(); drawSellers(); }; });
    }
    drawSellers();
    $('bl-seller-add').onclick = function () { const key = $('bl-seller').value, c = bulkCfg(); if (key && !c.sellers.includes(key)) c.sellers.push(key); bulkSave(); drawSellers(); };
    function refreshSupply() {
      adminApi('GET', '/api/admin/market/supply').then(function (r) {
        if (view !== 'market' || !$('bl-supply-status')) return;
        if (!r.ok) { $('bl-supply-status').textContent = '读取失败'; return; }
        savedRule = r.data.rule;
        $('bl-supply-status').textContent = !savedRule ? '没有上架计划' : (savedRule.enabled ? '运行中' : '已停止') + ' · 已上架 ' + savedRule.created + ' 条 · 当前库存 ' + savedRule.stock + ' 条' +
          (savedRule.mode === 'gradual' ? ' · 待上架 ' + savedRule.remaining + ' 条' : ' · 低于 ' + savedRule.threshold + ' 补到 ' + savedRule.target) + (savedRule.error ? ' · ' + savedRule.error : '');
      });
    }
    $('bl-supply-refresh').onclick = refreshSupply;
    $('bl-supply-pause').onclick = function () { adminApi('POST', '/api/admin/market/supply', { action: 'pause' }).then(function (r) { if (!r.ok) toast('暂停失败', true); refreshSupply(); }); };
    $('bl-supply-load').onclick = function () { if (!savedRule) return; blCfg = Object.assign({}, bulkCfg(), savedRule.recipe, { mode: savedRule.mode, batch: savedRule.batch, intervalSeconds: savedRule.intervalSeconds, threshold: savedRule.threshold, target: savedRule.target }); bulkSave(); renderMarket(); };
    refreshSupply();
    function filterItems() {
      document.querySelectorAll('[data-search-kind]').forEach(function (input) {
        const kind = input.dataset.searchKind, q = input.value.trim().toLowerCase(), part = $('bl-part').value;
        $('bl-p-' + kind).querySelectorAll('.bl-opt').forEach(function (label) {
          const cb = label.querySelector('input'), base = kind === 'component' && GameData.COMPONENT_BASES.find(function (b) { return b.id === cb.value; });
          const match = !base || !part || base.part === part;
          label.hidden = !match || !label.textContent.toLowerCase().includes(q);
          if (!match) cb.checked = false;
        });
        bulkSyncPick(kind);
      });
    }
    document.querySelectorAll('[data-search-kind]').forEach(function (input) { input.oninput = filterItems; });
    $('bl-part').onchange = function () { filterItems(); bulkReadForm(); };
    filterItems();

    // 账号名头下拉：管理员排前面（会显示成市集里的「卖家」名）
    adminApi('GET', '/api/admin/users?token=' + encodeURIComponent(token)).then(function (r) {
      if (!r.ok || view !== 'market') return;
      const sel = $('bl-seller');
      if (!sel) return;
      const c = bulkCfg();
      const rows = (r.data.users || []).slice().sort(function (x, y) {
        return (y.admin ? 1 : 0) - (x.admin ? 1 : 0) || (y.coins || 0) - (x.coins || 0);
      });
      sel.innerHTML = rows.map(function (u) {
        // 名头下拉顺带显示该账号的挂单占用：后台批量上架会把「已用」顶上去，而它自己上架受这个上限约束
        const capTxt = (u.listingCap > 0 ? (u.listings || 0) + '/' + u.listingCap : (u.listings || 0) + '/不限');
        return '<option value="' + esc(u.key) + '" data-name="' + esc(u.name || u.key) + '"' +
          ((c.seller === u.key || (!c.seller && u.key === r.data.me)) ? ' selected' : '') + '>' +
          esc(u.name || u.key) + '（' + esc(u.key) + '）' + (u.admin ? ' · 管理员' : '') + ' · 挂单 ' + capTxt + '</option>';
      }).join('') || '<option value="">没有账号</option>';
    });
    // 四类勾选列表：勾/取消即时更新「已选 N 项」，清空按钮一次取消该类全部勾选
    BULK_KINDS.forEach(function (k) {
      const box = $('bl-p-' + k.id);
      if (box) {
        box.addEventListener('change', function () { bulkSyncPick(k.id); });
        bulkSyncPick(k.id);
      }
      const clr = document.querySelector('.bl-clr[data-clr="' + k.id + '"]');
      if (clr) clr.addEventListener('click', function () { bulkClearPick(k.id); });
    });
    const prev = $('bl-preview');
    if (prev) prev.addEventListener('click', function () {
      bulkSetState('生成中…');
      const box = $('bl-prev');
      adminApi('POST', '/api/admin/market/bulk', bulkPayload(true)).then(function (r) {
        if (!r.ok) { bulkSetState('预览失败：' + esc((r.data && r.data.error) || '未知错误'), true); if (box) box.innerHTML = ''; return; }
        bulkSetState('预览（未写入）：' + bulkReport(r.data));
        if (box) box.innerHTML = '';
      });
    });
    const go = $('bl-go');
    if (go) go.addEventListener('click', function () {
      const c = bulkReadForm();
      const total = Object.keys(c.counts).reduce(function (s, k) { return s + c.counts[k]; }, 0);
      if (!c.seller && !c.sellers.length) { bulkSetState('请先选择卖家账号', true); return; }
      if (total <= 0) { bulkSetState('请至少给一类物品设置条数', true); return; }
      // 注意：confirmModalLocal 会对文案做 esc()，这里只传纯文本（不能带标签）
      confirmModalLocal((c.mode === 'immediate' ? '立即上架' : '启动' + (c.mode === 'restock' ? '条件补货' : '分批上架') + '计划（替换旧计划）') + '：以「' + (c.sellers.length ? c.sellers.join('、') + ' 随机卖家' : c.sellerName || c.seller) + '」的名头生成 ' + total + ' 条物品？\n' +
        '时长 ' + c.hours + ' 小时 · 价格倍率 ' + c.mulMin + '~' + c.mulMax + '\n' +
        '不收上架费；过期或被退回时直接清除（物品是现造的，不退回背包）。').then(function (ok) {
        if (!ok) return;
        bulkSetState('上架中…');
        go.disabled = true;
        adminApi('POST', c.mode === 'immediate' ? '/api/admin/market/bulk' : '/api/admin/market/supply', bulkPayload(false)).then(function (r) {
          go.disabled = false;
          if (r.ok && r.data.rule) { bulkSetState('计划已启动，关闭页面后仍会按间隔执行'); refreshSupply(); return; }
          if (!r.ok) { bulkSetState('上架失败：' + esc((r.data && r.data.error) || '未知错误'), true); return; }
          toast('已挂出 ' + r.data.created + ' 条（卖家：' + (r.data.seller && r.data.seller.name) + '）');
          bulkSetState('上架完成：' + bulkReport(r.data));
          refreshMarket();
        });
      });
    });
  }
  function renderMarket() {
    const main = $('main');
    main.innerHTML = '<h2>💱 开放市集管理</h2>' +
      '<div class="hint" style="margin-bottom:12px">「退回」将挂单物品退回卖家背包（上架费不退，与过期规则一致），卖家在线时会收到通知。</div>' +
      bulkPanelHtml() +
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
      '<div id="mk-pages" class="hint"></div><div id="mk-body" class="panel">加载中…</div>';
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
    $('mk-search').addEventListener('input', function () { mkSearch = this.value; scheduleMarket(); });
    $('mk-kind').addEventListener('change', function () { mkKind = this.value; scheduleMarket(); });
    affSel.addEventListener('change', function () { mkAffix = this.value; scheduleMarket(); });
    $('mk-amin').addEventListener('input', function () { mkAffixMin = this.value; scheduleMarket(); });
    $('mk-amax').addEventListener('input', function () { mkAffixMax = this.value; scheduleMarket(); });
    $('mk-sort').addEventListener('change', function () { mkSort.key = this.value; scheduleMarket(); });
    $('mk-dir').addEventListener('change', function () { mkSort.dir = this.value; scheduleMarket(); });
    wireBulkPanel();
    return refreshMarket();
  }
  function filteredListings() { return listings; }
  function drawMarket() {
    const body = $('mk-body');
    if (!body) return;
    const cnt = $('mk-count');
    const shown = filteredListings();
    if (cnt) cnt.textContent = '显示 ' + shown.length + ' / ' + ((mkInfo || {}).total || 0) + ' 条挂单';
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
  function scheduleMarket() {
    mkPage = 1; clearTimeout(mkFilterTimer);
    mkFilterTimer = setTimeout(refreshMarket, 250);
  }
  function refreshMarket() {
    const seq = ++mkSequence;
    const params = { page: mkPage, size: 30, scope: 'all', q: mkSearch, kind: mkKind, affix: mkAffix,
      min: mkAffixMin, max: mkAffixMax, sort: mkSort.key, dir: mkSort.dir };
    return api('GET', '/api/market?' + new URLSearchParams(params)).then(function (r) {
      if (view !== 'market' || seq !== mkSequence) return;
      if (!r.ok) { setHint('mk-body', esc((r.data && r.data.error) || '加载失败')); return; }
      listings = r.data.listings || []; mkInfo = r.data; mkPage = r.data.page;
      const pager = $('mk-pages');
      if (pager) {
        pager.innerHTML = '<button id="mk-prev" class="btn">上一页</button> 第 ' + mkInfo.page + ' / ' + mkInfo.pages + ' 页 <button id="mk-next" class="btn">下一页</button>';
        $('mk-prev').disabled = mkPage <= 1; $('mk-next').disabled = mkPage >= mkInfo.pages;
        $('mk-prev').onclick = function () { mkPage--; refreshMarket(); };
        $('mk-next').onclick = function () { mkPage++; refreshMarket(); };
      }
      drawMarket();
    });
  }

  // ================================
  // 上钩公式
  // ================================
  // 上钩公式的可用变量（顺序与服务器 BITE_VAR_NAMES 一致，供文档与试算表单共用）
  // skill = v0.11 起由「技巧」词缀提供的变量，是新版提升上钩率的主参数；big 是旧版遗留变量（恒为 0）。
  const BITE_VARS_DOC = [
    ['speed', '钓竿词缀钓速 %（不含钓点增益和全服加成）'],
    ['skill', '技巧加成 %（钓竿「技巧」词缀合计，按上钩公式修正概率）'],
    ['rare', '稀有度（原「稀有概率」）：生成战利品时按 K/(K+R) 降低普通品质物品权重，见下方「💎 稀有度」面板'],
    ['material', '材料概率加成 %'],
    ['size', '体型加成 %'],
    ['double', '双钓叠加值 A（概率按 A/(A+100) 换算）'],
    ['interval', '当前抛竿间隔 ms'],
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
          : (c.id === 'chest_abyss' ? '史诗 · 满词条（填满该底材词缀池）' : '稀有 / 史诗')) + '</td></tr>';
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
      '<div class="hint" style="margin-bottom:8px">突破件在底材词缀池之外补足的词缀所用的数值区间。<b>应当明显弱于池内区间</b>，否则 2 条池的弱底材补上强池外后会反超 4 条池底材。留空 = 用默认值。' +
      '工坊熔炼的<b>补缀词缀</b>也按这套区间取值，所以这里改动会同时影响熔炼（已开启「补缀按池外区间取值」时，改动经广播即时同步到玩家端预览）。</div>' +
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
  // 残片保留概率公式：唯一可用变量是 breakthrough（主件上的突破词缀数量），
  // 可用函数与上钩公式一致。这里只做本地预检（空 / 未知变量），最终由服务器权威校验。
  const RETAIN_FORMULA_FN = ['min', 'max', 'floor', 'ceil', 'round', 'abs', 'clamp'];
  function retainFormulaDefault() {
    return (GameData.SMELT_DEFAULTS && GameData.SMELT_DEFAULTS.retainFormula) || '10 - breakthrough * 0.5';
  }
  function retainFormulaError(src) {
    const s = String(src == null ? '' : src).trim();
    if (!s) return '残片保留概率公式不能为空（默认 ' + retainFormulaDefault() + '）';
    const ids = s.match(/[A-Za-z_$][A-Za-z0-9_$]*/g) || [];
    const bad = [];
    ids.forEach(function (id) {
      if (id === 'breakthrough') return;
      if (RETAIN_FORMULA_FN.indexOf(id) >= 0) return;
      if (bad.indexOf(id) < 0) bad.push(id);
    });
    if (bad.length) {
      return '残片保留概率公式含未知变量：' + bad.join('、') + '（可用变量只有 breakthrough；可用函数 ' + RETAIN_FORMULA_FN.join(' / ') + '）';
    }
    return null;
  }
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
    // 催化词缀范围表格的公共数据：部位列 / 词缀行 / 每格允许范围（表格渲染与保存校验共用）
    const catParts = [];
    (GameData.COMPONENT_BASES || []).forEach(function (b) { if (catParts.indexOf(b.part) < 0) catParts.push(b.part); });
    const catAffTypes = GameData.AFFIX_TYPES || [];
    const catAffLabel = GameData.AFFIX_LABEL || {};
    const catPartName = function (k) {
      const p = (GameData.ROD_PARTS || []).find(function (x) { return x.key === k; });
      return p ? p.name : k;
    };
    // 兜底：data.js 尚未提供 catalystEnvelopeOf 时，直接从底材池推导
    // （取该部位所有带该词缀的底材区间的外包络：下限取最小、上限取最大）。
    // 共享助手到位后一律以它为准，这里只保证旧版 data.js 下页面仍可用。
    const catEnvelopeFallback = function (part, t) {
      let lo = null, hi = null;
      (GameData.COMPONENT_BASES || []).forEach(function (b) {
        if (b.part !== part) return;
        (b.pool || []).forEach(function (e) {
          if (!e || e.type !== t) return;
          const mn = Number(e.min), mx = Number(e.max);
          if (!isFinite(mn) || !isFinite(mx)) return;
          lo = lo == null ? mn : Math.min(lo, mn);
          hi = hi == null ? mx : Math.max(hi, mx);
        });
      });
      return lo != null && hi != null ? [lo, hi] : null;
    };
    // 允许范围（硬约束）：GameData.catalystEnvelopeOf(part,type) → [min,max] | null
    // null = 该部位没有带该词缀的底材 → 该格恒回退池外（突破）区间，不允许填值。
    const catEnvelope = function (part, t) {
      try {
        const e = GameData.catalystEnvelopeOf ? GameData.catalystEnvelopeOf(part, t) : null;
        if (Array.isArray(e) && e.length === 2 && isFinite(Number(e[0])) && isFinite(Number(e[1]))) {
          return [Number(e[0]), Number(e[1])];
        }
        if (typeof GameData.catalystEnvelopeOf !== 'function') return catEnvelopeFallback(part, t);
        return null;
      } catch (err) { return null; }
    };
    // 单元格的 id 前缀（保存校验里也用同一套拼法）
    const catId = function (part, t, which) { return 'cat-' + part + '-' + t + '-' + which; };
    const F = function (k, label, hint, step) {
      return '<span class="ch-fix"><label>' + esc(label) + '</label>' +
        '<input id="ws-cfg-' + k + '" class="ipt mk-num" type="number" step="' + (step || '1') + '" value="' + (SC[k] != null ? SC[k] : '') + '"></span>' +
        '<span class="hint">' + esc(hint || ('默认 ' + DEF[k])) + '</span>';
    };
    body.innerHTML =
      '<h3 style="margin-top:0">🎯 熔炼成功率</h3>' +
      '<div class="mgr-row" style="flex-wrap:wrap;gap:8px">' +
      F('catalystRatio', '催化区间宽度比例 %', '相对池内包络或手填区间，保持中心不变；0~200，默认90', '0.1') +
      '<label class="chk"><input id="ws-cfg-forgeAnyAffix" type="checkbox"' + (SC.forgeAnyAffix !== false ? ' checked' : '') + '> 锻造允许新增底材池外词条</label>' +
      F('baseRate', '基础成功率 %', '默认 50') +
      F('failPerMaterial', '每份材料对失败率的影响', '负数 = 催化剂越多越不易失败（默认 -2）', '0.1') +
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
      '<h3>📦 催化剂上限</h3>' +
      '<div class="mgr-row" style="flex-wrap:wrap;gap:8px">' +
      F('maxMaterials', '单次最多催化剂份数', '默认 20') +
      F('maxTypes', '单次最多催化剂种类', '默认 4') +
      '<span class="ch-fix"><label>龙宫宝珠边界取值</label><input type="checkbox" id="ws-cfg-pearlRollTwice"' +
      (SC.pearlRollTwice !== false ? ' checked' : '') + '></span>' +
      '<span class="hint">勾选 = 投入龙宫宝珠时每个词条 roll 两次、取靠近区间边界的那次</span>' +
      '</div>' +
      '<h3>♻ 重铸（宝匣神话件重 roll 词条数值 · v0.16.0 改用龙宫宝珠）</h3>' +
      '<div class="mgr-row" style="flex-wrap:wrap;gap:8px">' +
      F('recastPearl', '基础消耗（龙宫宝珠）', '默认 1 颗 = 重 roll 全部词条') +
      F('recastGold', '每颗宝珠的金币', '按消耗的宝珠数计：4 颗 × 10000 = 40000；默认 0（只收宝珠）') +
      '<span class="ch-fix"><label>至少不比原来差</label><input type="checkbox" id="ws-cfg-recastMinValue"' +
      (SC.recastMinValue ? ' checked' : '') + '></span>' +
      '<span class="hint">勾选 = 重铸时每条词条取新旧里更好的那个（不会把好数值洗坏）<br>' +
      '额外投入宝珠可把重铸<b>指定到某一条词条</b>：第 n 条额外消耗 n 颗（第 1 条 +1、第 2 条 +2…），' +
      '此时只有那一条的数值会变，其余原样保留。</span>' +
      '</div>' +
      '<h3>🛡 熔炼 · 残片保留（海王遗匣产出的神话主件专享）</h3>' +
      '<div class="mgr-row" style="flex-wrap:wrap;gap:8px">' +
      '<span class="ch-fix"><label>每片残片保留概率 %（公式）</label>' +
      '<input id="ws-cfg-retainFormula" class="ipt" spellcheck="false" type="text" style="width:220px" value="' +
      esc(SC.retainFormula != null ? SC.retainFormula : retainFormulaDefault()) + '"></span>' +
      '<span class="hint">默认 <code>' + esc(retainFormulaDefault()) + '</code>' +
      '<button class="btn mini" id="ws-cfg-retainFormula-reset" style="margin-left:6px">恢复默认</button></span>' +
      F('retainMaxRelic', '单次最多投入残片', '默认 10') +
      '</div>' +
      '<div class="hint" style="margin-top:4px">公式按<b>每片投入的残片</b>求值，变量 <code>breakthrough</code> = 主件上的<b>突破词缀数量</b>；' +
      '结果即该片残片的保留概率（%）。总保留概率 = 投入片数 × 单片概率，<b>上限 100%</b>。' +
      '默认公式 <code>10 - breakthrough * 0.5</code>（每多一个突破词缀少 0.5 个百分点）。' +
      '可用函数：<code>' + RETAIN_FORMULA_FN.join('</code> <code>') + '</code>。</div>' +
      '<div class="hint">投入残片不计入催化剂：不改变熔炼成功率 / 补缀率 / 金币花费，只消耗残片本身</div>' +
      '<h3>🧬 词缀搬移与补缀（v0.11.5）</h3>' +
      '<div class="mgr-row" style="flex-wrap:wrap;gap:8px">' +
      '<span class="ch-fix"><label>副件连区间一起提供</label><input type="checkbox" id="ws-cfg-subRangeFromSub"' +
      (SC.subRangeFromSub !== false ? ' checked' : '') + '></span>' +
      '<span class="hint">勾选 = 副件搬来的词缀按<b>副件自己的底材区间</b>取值（副件池外用池外区间）；取消 = 旧规则（主件池内按主件区间）</span>' +
      '</div>' +
      '<div class="mgr-row" style="flex-wrap:wrap;gap:8px">' +
      '<span class="ch-fix"><label>补缀不受底材池限制</label><input type="checkbox" id="ws-cfg-addAnyAffix"' +
      (SC.addAnyAffix !== false ? ' checked' : '') + '></span>' +
      F('addAffixCap', '补缀后词条数上限', '默认 3（主 + 副 + 补缀，可越过品质上限与底材池长）；1 = 禁止补缀，最大 6') +
      '</div>' +
      '<div class="mgr-row" style="flex-wrap:wrap;gap:8px">' +
      '<span class="ch-fix"><label>补缀按池外区间取值</label><input type="checkbox" id="ws-cfg-addAffixExtraRange"' +
      (SC.addAffixExtraRange !== false ? ' checked' : '') + '></span>' +
      '<span class="hint">勾选 = 催化剂补出的词缀按<b>池外（突破）区间</b>取值，与宝匣突破件同一套区间' +
      '（改「🎁 宝匣配置 → 🎲 池外词缀数值区间」即时生效）；取消 = 该词缀在主件池内时按主件区间</span>' +
      '</div>' +
      '<div class="mgr-row" style="margin-top:10px"><button class="btn primary" id="ws-cfg-save">保存熔炼参数</button>' +
      '<button class="btn" id="ws-cfg-reset">恢复默认</button><span id="ws-cfg-state" class="hint" style="margin-left:10px"></span></div>' +
      '<h3>🧵 材料 → 词缀对照</h3>' +
      '<div class="hint" style="margin-bottom:6px">投入催化剂份数最多的那种材料决定熔炼后补的词缀；龙宫宝珠是通用催化剂（不指向词缀）。补上的词条数值范围在下方按部位设置。</div>' +
      '<div class="ch-ar-wrap">' + mats.map(function (m) {
        return '<span class="ch-fix"><label class="hint">' + esc(m.name) + '</label><span class="tag">' + esc(m.affixName) + '</span>' +
          '<span class="hint">(' + esc(m.rarity) + ')</span></span>';
      }).join('') +
      '<span class="ch-fix"><label class="hint">' + esc((cfg.smeltPearl || {}).name || '龙宫宝珠') + '</label><span class="tag">催化剂</span></span></div>' +
      (function () {
        // v0.12.2：材料催化词缀范围（分组件部位设置）。表格：行 = 词缀类型，列 = 组件部位；
        // 留空 = 该组合回退突破区间（🎁 宝匣配置 → 🎲 池外词缀数值区间）。
        const partsList = catParts;
        const partName = catPartName;
        const affTypes = catAffTypes;
        const affLabel = catAffLabel;
        const catr = SC.catalystRanges || {};
        const vOf = function (part, t, i) {
          const r = catr[part] && catr[part][t];
          return (Array.isArray(r) && r[i] != null) ? r[i] : '';
        };
        const cellHtml = function (pt, t) {
          const env = catEnvelope(pt, t);
          const mn = vOf(pt, t, 0), mx = vOf(pt, t, 1);
          const label = partName(pt) + ' × ' + (affLabel[t] || t);
          if (!env) {
            // 该部位 × 该词缀无底材：整格禁用，提示回退池外（突破）区间
            const fbTip = partName(pt) + ' 没有带「' + (affLabel[t] || t) + '」的底材：该格固定回退池外（突破）区间，不能填值';
            return '<td style="padding:2px 4px;white-space:nowrap" class="cat-fallback" ' +
              'title="' + esc(fbTip) + '">' +
              '<span class="hint" style="font-size:11px">回退突破</span></td>';
          }
          const tip = label + '：允许范围 ' + env[0] + ' ~ ' + env[1] +
            '（下限不得低于 ' + env[0] + '，上限不得超过 ' + env[1] + '）';
          return '<td style="padding:2px 4px;white-space:nowrap" title="' + esc(tip) + '">' +
            '<input id="' + catId(pt, t, 'min') + '" class="ipt mk-num cat-cell" type="number" step="0.1" style="width:60px" ' +
            'min="' + env[0] + '" max="' + env[1] + '" placeholder="min" value="' + esc(mn) + '"> ~ ' +
            '<input id="' + catId(pt, t, 'max') + '" class="ipt mk-num cat-cell" type="number" step="0.1" style="width:60px" ' +
            'min="' + env[0] + '" max="' + env[1] + '" placeholder="max" value="' + esc(mx) + '">' +
            '<span class="hint" style="font-size:11px">' + env[0] + '~' + env[1] + '</span></td>';
        };
        return '<h3>🧪 材料催化词缀范围（分部位）' +
          '<button class="btn mini" id="cat-preset" style="margin-left:8px" ' +
          'title="按推荐预设（GameData.catalystPreset）填充所有格子；不会自动保存，确认后再点保存">⚡ 一键预设</button></h3>' +
          '<div class="hint" style="margin-bottom:6px">材料催化成功赋予主件的词条（催化词缀）按<b>主件部位 + 词缀类型</b>取下表范围。' +
          '留空 = 使用该部位池内包络，没有池内范围时回退突破区间；最终按上方比例缩放宽度。每格标注的 <b>允许范围</b> 是该部位底材的硬边界（下限 ≥、上限 ≤），超出会被拒绝；' +
          '标「回退突破」的格子表示该部位没有这种底材，不能填值。保存后全服即时生效（玩家端熔炼预览同步）。</div>' +
          '<div style="overflow-x:auto"><table style="border-collapse:collapse;font-size:12px">' +
          '<tr><th style="text-align:left;padding:4px 8px">词缀 \\ 部位</th>' +
          partsList.map(function (pt) { return '<th style="padding:4px 8px;white-space:nowrap">' + esc(partName(pt)) + '</th>'; }).join('') + '</tr>' +
          affTypes.map(function (t) {
            return '<tr><td style="padding:4px 8px;white-space:nowrap">' + esc(affLabel[t] || t) + '</td>' +
              partsList.map(function (pt) { return cellHtml(pt, t); }).join('') + '</tr>';
          }).join('') + '</table></div>';
      })();

    // ⚡ 一键预设：按 GameData.catalystPreset() 填满所有格子（不保存，仍需手动点保存）
    $('cat-preset').onclick = function () {
      let preset = null;
      try { preset = GameData.catalystPreset ? GameData.catalystPreset() : null; } catch (e) { preset = null; }
      if (!preset || typeof preset !== 'object') { toast('预设不可用（GameData.catalystPreset 未就绪），请手动填写', true); return; }
      let filled = 0, cleared = 0;
      catAffTypes.forEach(function (t) {
        catParts.forEach(function (pt) {
          const mnEl = $(catId(pt, t, 'min')), mxEl = $(catId(pt, t, 'max'));
          if (!mnEl || !mxEl) return;   // 回退突破的格子没有输入框
          const r = preset[pt] && preset[pt][t];
          if (Array.isArray(r) && r.length >= 2 && r[0] != null && r[1] != null) {
            mnEl.value = String(r[0]); mxEl.value = String(r[1]); filled++;
          } else {
            mnEl.value = ''; mxEl.value = ''; cleared++;
          }
        });
      });
      toast('已按推荐预设填入 ' + filled + ' 组范围' + (cleared ? '，清空 ' + cleared + ' 组' : '') + '（尚未保存，确认后点「保存熔炼参数」）');
    };
    // 残片保留概率公式「恢复默认」：只改输入框，仍需点保存
    $('ws-cfg-retainFormula-reset').onclick = function () { $('ws-cfg-retainFormula').value = retainFormulaDefault(); };
    $('ws-cfg-save').onclick = function () {
      // 残片保留概率公式：本地预检（空 / 未知变量），服务器另有权威校验
      const retainFormula = $('ws-cfg-retainFormula').value.trim();
      const fxErr = retainFormulaError(retainFormula);
      if (fxErr) { toast(fxErr, true); return; }
      // 材料催化词缀范围：从表格收集 { [part]: { [type]: [min, max] } }；min/max 任一留空 = 该组合清除（回退突破区间）
      const catalystRanges = {};
      let catErr = null;
      catAffTypes.forEach(function (t) {
        if (catErr) return;
        catParts.forEach(function (pt) {
          if (catErr) return;
          const mnEl = $(catId(pt, t, 'min')), mxEl = $(catId(pt, t, 'max'));
          if (!mnEl || !mxEl) return;   // 无底材的格子（回退突破区间）没有输入框，跳过
          const env = catEnvelope(pt, t);
          if (!env) return;
          const label = catPartName(pt) + ' × ' + (catAffLabel[t] || t);
          const mnV = mnEl.value.trim(), mxV = mxEl.value.trim();
          if (mnV === '' && mxV === '') return;
          const mn = Number(mnV), mx = Number(mxV);
          if (mnV === '' || mxV === '' || !isFinite(mn) || !isFinite(mx)) {
            catErr = '催化词缀范围「' + label + '」填写不完整：两个值都要填，不用请清空';
            return;
          }
          if (mx < mn) {
            catErr = '催化词缀范围「' + label + '」上下限颠倒：下限 ' + mn + ' 不能大于上限 ' + mx;
            return;
          }
          if (mn < env[0] || mx > env[1]) {
            catErr = '催化词缀范围「' + label + '」超出该部位允许范围 ' + env[0] + ' ~ ' + env[1] +
              '（下限不得低于 ' + env[0] + '，上限不得超过 ' + env[1] + '），当前 ' + mn + ' ~ ' + mx;
            return;
          }
          catalystRanges[pt] = catalystRanges[pt] || {};
          catalystRanges[pt][t] = [mn, mx];
        });
      });
      if (catErr) { toast(catErr, true); return; }
      adminApi('POST', '/api/admin/smelt/config', {
        token: token,
        catalystRatio: $('ws-cfg-catalystRatio').value,
        forgeAnyAffix: $('ws-cfg-forgeAnyAffix').checked,
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
        recastPearl: $('ws-cfg-recastPearl').value,
        recastGold: $('ws-cfg-recastGold').value,
        recastMinValue: $('ws-cfg-recastMinValue').checked,
        retainFormula: retainFormula,
        retainMaxRelic: $('ws-cfg-retainMaxRelic').value,
        subRangeFromSub: $('ws-cfg-subRangeFromSub').checked,
        addAnyAffix: $('ws-cfg-addAnyAffix').checked,
        addAffixCap: $('ws-cfg-addAffixCap').value,
        addAffixExtraRange: $('ws-cfg-addAffixExtraRange').checked,
        catalystRanges: catalystRanges,
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
    const main = $('main');
    main.innerHTML = '<h2>🏆 纪录贴图</h2>' +
      '<div class="hint" style="margin-bottom:12px">玩家端「图鉴 · 记录」页顶部「全场最大」那张大贴图：可调缩放（50 ~ 500%）与 xy 偏移（像素）。' +
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
      '<div class="hint" id="rc-preview-txt"></div></div>' +
      '<h3 style="margin-top:18px">🗑 纪录管理</h3>' +
      '<div class="hint" style="margin-bottom:6px">点鱼名展开该鱼种的 <b>日 / 周 / 总榜</b>，按名次单独删掉某一条；' +
      '「删除该鱼种全部」才会连它的最大 / 最小纪录一起清。只动纪录，不动玩家背包与图鉴；删除后玩家端记录页即时刷新。</div>' +
      '<div class="mgr-row"><label class="hint">搜索</label><input id="rc-del-search" class="ipt" placeholder="鱼名 / ID" style="width:200px">' +
      '<span class="hint" id="rc-del-count"></span>' +
      '<button class="btn danger" id="rc-del-all" style="margin-left:auto">清空全部纪录</button></div>' +
      '<div id="rc-del-list">…</div>';

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

    // ---- 纪录管理（v0.14.1）：点鱼名展开日 / 周 / 总榜，按名次单独删 ----
    // 单条删除只摘掉该榜上的这一条（服务端还会核对 who/size/t —— 期间被别人的渔获挤走就 409，
    // 免得「列表看着是 A、实际删掉 B」）；要连「最大 / 最小纪录」一起清才走每行的「删除该鱼种全部」。
    let recDelFilter = '';
    let recDelRows = [];
    let recOpenId = null;            // 当前展开的鱼种（手风琴：一次只展开一个，省得列表被撑散）
    let recRange = 'day', recKind = 'big';
    const RANGE_LABEL = { day: '日榜', week: '周榜', all: '总榜' };
    // 该鱼的基准体型区间（data.js 的 size = [min,max]）：和玩家端记录页显示的是同一个口径
    const recBaseOf = function (id) {
      const fish = (worldCfg && worldCfg.catalog && worldCfg.catalog.fish) || [];
      const f = fish.find(function (x) { return x.id === id; });
      return (f && f.size) ? f.size : null;
    };
    const pctText = function (size, base) {
      if (!base || !(size > 0)) return null;
      const p = Math.round((size - base[1]) / base[1] * 1000) / 10;
      return (p >= 0 ? '+' : '') + p + '%';
    };
    const drawDelList = function () {
      const box = $('rc-del-list');
      if (!box) return;
      const q = (recDelFilter || '').trim().toLowerCase();
      const all = recDelRows
        .filter(function (r) { return !q || r.name.toLowerCase().indexOf(q) >= 0 || r.id.indexOf(q) >= 0; })
        .sort(function (a, b) { return (b.big || 0) - (a.big || 0); });
      if (!all.length) {
        box.innerHTML = '<div class="hint">' + (recDelRows.length ? '没有匹配的纪录。' : '当前没有任何渔获纪录。') + '</div>';
        return;
      }
      box.innerHTML = all.map(function (r) {
        const open = recOpenId === r.id;
        const base = recBaseOf(r.id);
        return '<div class="rcm-item' + (open ? ' open' : '') + '">' +
          '<div class="rcm-head" data-rcopen="' + esc(r.id) + '">' +
          '<span class="rcm-caret">' + (open ? '▾' : '▸') + '</span>' +
          '<span class="rcm-name">' + esc(r.name) + '</span>' +
          (base ? '<span class="rcm-base">基准 ' + base[0] + '~' + base[1] + 'cm</span>' : '') +
          '<span class="rcm-meta">最大 ' + (r.big != null ? r.big + 'cm' : '—') +
          ' · 最小 ' + (r.small != null ? r.small + 'cm' : '—') + '</span>' +
          '<span class="rcm-act"><button class="btn mini danger" data-rcdel="' + esc(r.id) + '">删除该鱼种全部</button></span>' +
          '</div>' +
          (open ? '<div class="rcm-board" data-rcboard="' + esc(r.id) + '">加载中…</div>' : '') +
          '</div>';
      }).join('');
      box.querySelectorAll('[data-rcopen]').forEach(function (h) {
        h.onclick = function (ev) {
          if (ev.target && ev.target.closest && ev.target.closest('[data-rcdel]')) return;   // 点「全部删除」不该折叠
          const id = h.getAttribute('data-rcopen');
          recOpenId = (recOpenId === id) ? null : id;
          drawDelList();
          if (recOpenId) loadBoard(recOpenId);
        };
      });
      box.querySelectorAll('[data-rcdel]').forEach(function (b) {
        b.onclick = function () { confirmDelRecord(b.getAttribute('data-rcdel'), false); };
      });
    };
    // 展开区：范围（日/周/总）× 榜单（最大/最小）两排切换 + 名次行（带「超出基准 %」）
    const boardBox = function () { return document.querySelector('[data-rcboard]'); };
    const loadBoard = function (id) {
      const box = boardBox();
      if (!box) return;
      box.innerHTML = '<div class="hint">加载中…</div>';
      api('GET', '/api/records/top?id=' + encodeURIComponent(id) + '&range=' + recRange + (recKind === 'small' ? '&kind=small' : ''))
        .then(function (r) {
          if (recOpenId !== id) return;                       // 期间折叠了 / 换鱼种了
          const b = boardBox();
          if (!b) return;
          const d = (r && r.data) || {};
          const top = d.top || [];
          const base = recBaseOf(id);
          const tabs = '<div class="rcm-tabs">' +
            '<span class="hint">范围</span>' +
            ['day', 'week', 'all'].map(function (k) {
              return '<button class="fb-chip' + (recRange === k ? ' on' : '') + '" data-rcrange="' + k + '">' + RANGE_LABEL[k] + '</button>';
            }).join('') +
            '<span class="rcm-label">' + esc(d.label || '') + '</span>' +
            '<span class="fb-sep"></span><span class="hint">榜单</span>' +
            [['big', '🐟 最大'], ['small', '🐠 最小']].map(function (kv) {
              return '<button class="fb-chip' + (recKind === kv[0] ? ' on' : '') + '" data-rckind="' + kv[0] + '">' + kv[1] + '</button>';
            }).join('') +
            (base ? '<span class="rcm-base rcm-base-r">基准 ' + base[0] + '~' + base[1] + 'cm</span>' : '') +
            '</div>';
          const rowsHtml = top.length ? top.map(function (t, i) {
            const pct = pctText(t.size, base);
            return '<div class="rcm-row">' +
              '<span class="rcm-rank">#' + (i + 1) + '</span>' +
              '<span class="rcm-size">' + t.size + '<span class="rcm-u">cm</span></span>' +
              (pct == null ? '' : '<span class="rcm-pct' + (pct.charAt(0) === '+' ? ' over' : '') + '">' + pct + '</span>') +
              '<span class="rcm-who">' + esc(t.who) + '</span>' +
              '<span class="rcm-time">' + fmtTime(t.t) + '</span>' +
              '<button class="btn mini danger" data-rcmdel="' + i + '">删除</button></div>';
          }).join('') : '<div class="hint">该榜暂无条目' + (recRange === 'day' ? '（今天还没有该鱼种的入榜渔获）' : '') + '。</div>';
          b.innerHTML = tabs + rowsHtml;
          b.querySelectorAll('[data-rcrange]').forEach(function (x) {
            x.onclick = function () { recRange = x.getAttribute('data-rcrange'); loadBoard(id); };
          });
          b.querySelectorAll('[data-rckind]').forEach(function (x) {
            x.onclick = function () { recKind = x.getAttribute('data-rckind'); loadBoard(id); };
          });
          b.querySelectorAll('[data-rcmdel]').forEach(function (x) {
            x.onclick = function () { confirmDelEntry(id, parseInt(x.getAttribute('data-rcmdel'), 10), top); };
          });
        });
    };
    const loadRecList = function () {
      return api('GET', '/api/records').then(function (r) {
        const recs = (r && r.data && r.data.records) || {};
        const smalls = (r && r.data && r.data.small) || {};
        const ids = {};
        Object.keys(recs).forEach(function (id) { ids[id] = 1; });
        Object.keys(smalls).forEach(function (id) { ids[id] = 1; });
        recDelRows = Object.keys(ids).map(function (id) {
          return {
            id: id,
            name: (recs[id] && recs[id].name) || (smalls[id] && smalls[id].name) || id,
            big: recs[id] ? recs[id].size : null,
            small: smalls[id] ? smalls[id].size : null,
          };
        });
        if (recOpenId && !ids[recOpenId]) recOpenId = null;   // 展开的鱼种被清空了
        drawDelList();
        if (recOpenId) loadBoard(recOpenId);
        const cnt = $('rc-del-count');
        if (cnt) cnt.textContent = recDelRows.length ? ('共 ' + recDelRows.length + ' 个鱼种有纪录') : '当前没有纪录';
      });
    };
    const confirmModal = function (title, bodyHtml, okText) {
      document.querySelectorAll('.modal-overlay').forEach(function (m) { m.remove(); });
      const ov = document.createElement('div');
      ov.className = 'modal-overlay';
      ov.innerHTML = '<div class="modal-box confirm-modal"><div class="modal-head"><span class="modal-title">' + title + '</span></div>' +
        '<div class="modal-body"><div class="cf-text">' + bodyHtml + '</div>' +
        '<div class="cf-actions"><button class="btn mini cf-no">取消</button>' +
        '<button class="btn danger" id="rc-del-ok">' + okText + '</button></div></div></div>';
      document.body.appendChild(ov);
      ov.addEventListener('click', function (e) { if (e.target === ov) ov.remove(); });
      ov.querySelector('.cf-no').onclick = function () { ov.remove(); };
      return ov;
    };
    // 单条删除：勾选可顺带清掉这条（同钓者 + 同尺寸）在其它榜单 / 纪录头衔里的影子
    const confirmDelEntry = function (id, index, list) {
      const t = (list || [])[index];
      if (!t) return;
      const name = (recDelRows.find(function (r) { return r.id === id; }) || {}).name || id;
      const ov = confirmModal('删除这一条纪录',
        '删除 <b>' + esc(name) + '</b> ' + RANGE_LABEL[recRange] + (recKind === 'small' ? ' · 最小' : ' · 最大') +
        ' 第 <b>' + (index + 1) + '</b> 名：<b>' + esc(t.who) + ' ' + t.size + 'cm</b>（' + fmtTime(t.t) + '）' +
        '<label class="rcm-chk"><input type="checkbox" id="rcm-purge" checked> 同时把这条（同钓者 + 同尺寸）从该鱼的其它榜单与「最大 / 最小纪录」里一并移除</label>' +
        '<div class="hint">不勾 = 只摘掉这个榜上的这一条。玩家背包与图鉴不受影响。</div>',
        '确认删除');
      ov.querySelector('#rc-del-ok').onclick = function () {
        const btn = ov.querySelector('#rc-del-ok');
        const purge = ov.querySelector('#rcm-purge').checked;
        btn.disabled = true; btn.textContent = '删除中…';
        adminApi('POST', '/api/admin/records/delone', {
          token: token, id: id, range: recRange, kind: recKind, index: index, purge: purge,
          who: t.who, size: t.size, t: t.t,
        }).then(function (r) {
          ov.remove();
          if (!r.ok) {
            toast((r.data && r.data.error) || '删除失败', true);
            loadBoard(id);                                   // 多半是名次变了：刷新给最新名次
            return;
          }
          const pg = r.data.purge || {};
          toast('已删除第 ' + (index + 1) + ' 名 ' + t.who + ' ' + t.size + 'cm' +
            (purge ? '（另清 ' + (pg.boards || 0) + ' 处榜单条目' + ((pg.big || pg.small) ? ' + 纪录头衔' : '') + '）' : ''));
          loadRecList();
        });
      };
    };
    const confirmDelRecord = function (id, all) {
      const name = (recDelRows.find(function (r) { return r.id === id; }) || {}).name || id;
      const ov = confirmModal(all ? '清空全部渔获纪录' : '删除该鱼种全部纪录',
        (all ? '确定清空<b>全部</b>鱼种的捕获纪录？' : '确定删除 <b>' + esc(name) + '</b> 的<b>全部</b>捕获纪录？') +
        '<br>最大 / 最小 / 前十大 / 前十小 / 日榜周榜都会一起清掉，玩家背包与图鉴不受影响。' +
        '<div class="hint">只想删榜上的某一条，请展开该鱼种后逐条删。</div>',
        '确认删除');
      ov.querySelector('#rc-del-ok').onclick = function () {
        const btn = ov.querySelector('#rc-del-ok');
        btn.disabled = true; btn.textContent = '删除中…';
        adminApi('POST', '/api/admin/records/delete', { token: token, id: all ? '' : id }).then(function (r) {
          ov.remove();
          if (!r.ok) { toast((r.data && r.data.error) || '删除失败', true); return; }
          const rm = r.data.removed || {};
          toast('已删除：最大 ' + (rm.big || 0) + ' / 最小 ' + (rm.small || 0) + ' / 榜单 ' +
            ((rm.top || 0) + (rm.topSmall || 0)) + ' 条');
          loadRecList();
        });
      };
    };
    $('rc-del-all').onclick = function () { confirmDelRecord('', true); };
    const delSearch = $('rc-del-search');
    if (delSearch) delSearch.oninput = function () { recDelFilter = this.value; drawDelList(); };
    loadRecList();
  }

  // ---- 模拟钓竿（公式管理页中心，v0.16.0）----
  // 滑杆 ↔ 数字框联动、预设、选钓点、POST /api/admin/simulate 试算并渲染结果与产出分布。
  const SIM_AFFIXES = ['speed', 'skill', 'rare', 'material', 'size', 'double'];
  const SIM_PRESETS = {
    none: { speed: 0, skill: 0, rare: 0, material: 0, size: 0, double: 0 },
    mid: { speed: 40, skill: 10, rare: 0, material: 0, size: 0, double: 30 },
    max: { speed: 80, skill: 20, rare: 0, material: 0, size: 0, double: 100 },
    record: { speed: 0, skill: 0, rare: 20, material: 0, size: 100, double: 0 },
  };
  function simTotals() {
    const out = {};
    SIM_AFFIXES.forEach(function (t) { out[t] = Number(($('sim-' + t) || {}).value) || 0; });
    return out;
  }
  function simSetTotals(v) {
    SIM_AFFIXES.forEach(function (t) {
      const n = Number(v && v[t]) || 0;
      if ($('sim-' + t)) $('sim-' + t).value = String(n);
      if ($('sim-r-' + t)) $('sim-r-' + t).value = String(n);
    });
    // 钓场 / 钓点筛选（v0.16.0）：切换即按新口径重拉数据
    const gSel = $('ov-filter-ground'), sSel = $('ov-filter-spot');
    if (gSel) {
      gSel.addEventListener('change', function () {
        heatFilter.ground = gSel.value || '';
        heatFilter.spot = '';        // 换钓场后原钓点可能不属于它，直接清空
        heatHover = -1; heatCell = null;
        heatLoad();
      });
    }
    if (sSel) {
      sSel.addEventListener('change', function () {
        heatFilter.spot = sSel.value || '';
        heatHover = -1; heatCell = null;
        heatLoad();
      });
    }
  }
  function wireSimulator() {
    if (!$('sim-go')) return;
    SIM_AFFIXES.forEach(function (t) {
      const num = $('sim-' + t), rng = $('sim-r-' + t);
      if (!num || !rng) return;
      rng.addEventListener('input', function () { num.value = rng.value; });
      num.addEventListener('input', function () {
        const v = Math.max(Number(num.min) || -999, Math.min(Number(num.max) || 999, Number(num.value) || 0));
        rng.value = String(v);
      });
    });
    document.querySelectorAll('[data-sim-preset]').forEach(function (b) {
      b.addEventListener('click', function () {
        simSetTotals(SIM_PRESETS[b.getAttribute('data-sim-preset')] || SIM_PRESETS.none);
        simRun();
      });
    });
    adminApi('GET', '/api/admin/loot/spots?token=' + encodeURIComponent(token)).then(function (r) {
      const sel = $('sim-spot');
      if (!sel || view !== 'formula') return;
      const list = (r && r.ok && r.data && r.data.spots) || [];
      sel.innerHTML = '<option value="">（不选钓点：只看公式本身）</option>' + list.map(function (s) {
        return '<option value="' + esc(s.key) + '">' + esc(s.name) + '（' + s.pool + ' 项产出）</option>';
      }).join('');
      if (list.length) sel.value = list[0].key;
    });
    $('sim-go').addEventListener('click', simRun);
    $('sim-vars').addEventListener('click', function () {
      const t = simTotals();
      SIM_AFFIXES.forEach(function (k) { if ($('fxv-' + k)) $('fxv-' + k).value = String(t[k]); });
      toast('已把模拟钓竿的词条值填入下方「试算（用下面的变量值求概率）」');
    });
    simRun();
  }
  function simRun() {
    const out = $('sim-out');
    if (!out) return;
    out.innerHTML = '试算中…';
    const sel = $('sim-spot');
    adminApi('POST', '/api/admin/simulate', { token: token, totals: simTotals(), spotKey: sel ? sel.value : '' }).then(function (r) {
      if (view !== 'formula' || !$('sim-out')) return;
      if (!r || !r.ok) { $('sim-out').innerHTML = '<span class="err">' + esc((r && r.data && r.data.error) || '试算失败') + '</span>'; return; }
      const d = r.data || {};
      const L = d.affixLabel || {};
      const cell = function (label, value, hint) {
        return '<div class="sim-cell"><span class="sc-label">' + label + '</span><b>' + value + '</b>' +
          (hint ? '<span class="sc-hint">' + hint + '</span>' : '') + '</div>';
      };
      const chips = SIM_AFFIXES.filter(function (t) { return (d.merged && d.merged[t]); }).map(function (t) {
        const v = d.merged[t];
        return '<span class="eff-chip' + (v < 0 ? ' eff-neg' : '') + '">' + (L[t] || t) + ' ' + (v > 0 ? '+' : '') + v + '%</span>';
      }).join('') || '<span class="eff-chip none">无词条加成</span>';
      $('sim-out').innerHTML =
        '<div class="sim-cells">' +
        cell('抛竿间隔', (d.cast.interval / 1000).toFixed(2) + ' 秒', '基础 ' + d.cast.baseMs + 'ms · 最短 ' + d.cast.minMs + 'ms') +
        cell('每小时抛竿', d.expect.castsPerHour, '有效钓速 ' + d.cast.effSpeed + '%（上限 ' + d.cast.cap + '%）') +
        cell('上鱼率', Number(d.bite.rate).toFixed(1) + '%', d.bite.override ? '钓点独立配置' : '全服公式') +
        cell('双钓概率', d.double.p.toFixed(1) + '%', '叠加 A=' + d.double.A + ' · 基础 B=' + Math.round(d.double.base * 100) + '%') +
        cell('每竿期望', d.expect.fishPerCast + ' 条', '1 + P + P²（最多 3 条）') +
        cell('每小时期望', d.expect.fishPerHour + ' 条', '上鱼率 × 抛竿数 × 每竿期望') +
        '</div>' +
        '<div class="eff-strip" style="margin:8px 0 0">' + chips + '</div>' +
        (d.spot ? '<div class="hint" style="margin-top:6px">钓点：<b>' + esc(d.spot.groundName + '·' + d.spot.spotName) + '</b>' +
          ((d.spot.buffs || []).length ? ' · 钓点增益 ' + d.spot.buffs.map(function (b) { return esc((L[b.type] || b.type) + ' ' + (b.value > 0 ? '+' : '') + b.value + '%'); }).join('、') : '') +
          (d.spot.biteRateOverride != null ? ' · 独立上鱼率 ' + d.spot.biteRateOverride + '%' : '') +
          (d.spot.intervalOverride != null ? ' · 钓点基础间隔 ' + d.spot.intervalOverride + 'ms' : '') + '</div>'
          : '<div class="hint" style="margin-top:6px">未选钓点：只按公式与钓竿词缀计算（不含钓点增益与钓点独立配置）。</div>');
      const loot = d.loot || [];
      $('sim-loot').innerHTML = loot.length
        ? '<h4 style="margin:10px 0 4px">📦 该钓点产出分布（稀有度 ' + Math.round(Number(d.merged && d.merged.rare) || 0) + ' 生效后）</h4>' +
          '<div class="sim-loot-grid">' + loot.slice(0, 16).map(function (x) {
            const up = x.afterPct - x.beforePct;
            return '<div class="sim-loot-row"><span class="sl-name">' + esc(x.name) +
              '<span class="hint"> ' + esc(x.quality) + '</span></span>' +
              '<span class="sl-before">' + x.beforePct.toFixed(2) + '%</span>' +
              '<span class="sl-arrow">→</span>' +
              '<span class="sl-after' + (up > 0.001 ? ' up' : (up < -0.001 ? ' down' : '')) + '">' + x.afterPct.toFixed(2) + '%</span></div>';
          }).join('') + '</div>'
        : '';
    });
  }
  function renderFormula() {
    const main = $('main');
    main.innerHTML = '<h2>🧮 公式管理</h2>' +
      '<div class="hint" style="margin-bottom:12px">以<b>模拟钓竿</b>为中心：先在这里把任意词条组合与钓点试算一遍，' +
      '再看下方各项参数。本页所有修改保存后对全服立即生效。</div>' +
      // ---- v0.16.0：模拟钓竿（页面中心）----
      '<div class="panel sim-panel">' +
      '<h3>🎣 模拟钓竿 <span class="hint">把任意词条组合装到一根虚拟钓竿上，选一个钓点即可看到真实结果（不写存档、不影响线上玩家）</span></h3>' +
      '<div class="sim-grid">' +
      '<div class="sim-rods">' +
      [['speed', '⚡ 钓速', -100, 200], ['skill', '🎯 技巧', -100, 200], ['rare', '✨ 稀有度', -50, 100],
        ['material', '🧵 材料概率', -50, 200], ['size', '📏 体型', -100, 300], ['double', '🎣 双钓', 0, 200]]
        .map(function (a) {
          return '<div class="sim-aff"><label for="sim-' + a[0] + '">' + a[1] + '</label>' +
            '<input type="range" id="sim-r-' + a[0] + '" min="' + a[2] + '" max="' + a[3] + '" step="1" value="0">' +
            '<input type="number" id="sim-' + a[0] + '" class="ipt mk-num" min="' + a[2] + '" max="' + a[3] + '" step="1" value="0"><span class="hint">%</span></div>';
        }).join('') +
      '<div class="sim-presets">' +
      '<button class="btn mini" data-sim-preset="none">空竿</button>' +
      '<button class="btn mini" data-sim-preset="mid">中档（钓速 40 / 技巧 10 / 双钓 30）</button>' +
      '<button class="btn mini" data-sim-preset="max">满配（钓速 80 / 技巧 20 / 双钓 100）</button>' +
      '<button class="btn mini" data-sim-preset="record">冲纪录（体型 100 / 稀有度 20）</button>' +
      '</div>' +
      '</div>' +
      '<div class="sim-side">' +
      '<div class="pool-row"><label for="sim-spot" style="width:56px;color:var(--txt-dim);font-size:13px">钓点</label>' +
      '<select id="sim-spot" class="ipt" style="min-width:240px"></select>' +
      '<button id="sim-go" class="btn primary" style="margin-left:8px">试算</button>' +
      '<button id="sim-vars" class="btn mini" style="margin-left:6px">填入变量试算</button></div>' +
      '<div id="sim-out" class="sim-out hint">选好词条与钓点后点「试算」。</div>' +
      '</div>' +
      '</div>' +
      '<div id="sim-loot" class="sim-loot"></div>' +
      '</div>' +
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
      '<div class="hint" style="margin-bottom:8px">变量值 = 该玩家当前生效的加成（钓竿词缀 + 钓点增益；speed 仅取钓竿词缀）。' +
      '<b><code>skill</code> 是 v0.11 新增的「技巧」词缀变量</b>——钓竿上的「技巧」词缀全部计入它，' +
      '默认公式随钓速降低单竿上钩率，技巧提高上钩率；默认 10 秒基础间隔下，60/30 约 394 次、90/60 约 445 次成功上钩/小时。0–30 的期望边际收益递增，50 以上递减；上限 600 次/小时，不含双钓追加，钓点独立上鱼率与自定义公式可覆盖此限制。</div>' +
      '<div class="kv">' +
      BITE_VARS_DOC.map(function (v) { return '<code>' + v[0] + '</code> — ' + v[1] + '<br>'; }).join('') +
      '</div><h3>可用函数</h3><div class="kv"><code>min</code> <code>max</code> <code>floor</code> <code>ceil</code> <code>round</code> <code>abs</code> <code>clamp(x, lo, hi)</code><br>' +
      '示例：<code>clamp(90 + skill, 0, 100)</code>（自定义示例） ／ <code>90</code>（平值 90% 上钩） ／ ' +
      '<code>clamp(85 + rare + skill * 0.5, 50, 100)</code>（稀有度与技巧各占一部分）</div></div>' +
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
      '<div class="hint" style="margin-bottom:10px">服务端每隔该间隔自动抛一竿。默认间隔 = 钓点基础 × (1 − 钓点钓速/100) / (1 + 有效钓速/100)，不低于最短间隔；' +
      '有效钓速 = 钓竿词缀 + <b>全服钓速加成</b>，并按<b>钓速上限</b>截断。上钩率由上方公式决定，默认随钓速下降、技巧上升。' +
      '保存后正在钓鱼的玩家循环会立即按新间隔重启。</div>' +
      '<div class="pool-row"><label style="width:150px;color:var(--txt-dim);font-size:13px">基础间隔</label>' +
      '<input id="cast-base" class="ipt" type="number" min="200" max="60000" step="100" style="width:110px" />' +
      '<span class="hint">ms（默认 10000）</span>' +
      '<label style="width:110px;color:var(--txt-dim);font-size:13px;margin-left:12px">最短间隔</label>' +
      '<input id="cast-min" class="ipt" type="number" min="100" max="60000" step="100" style="width:110px" />' +
      '<span class="hint">ms（默认 800）</span></div>' +
      '<div class="pool-row"><label style="width:150px;color:var(--txt-dim);font-size:13px">全服钓速加成</label>' +
      '<input id="cast-bonus" class="ipt" type="number" min="-100" max="500" step="5" style="width:110px" />' +
      '<span class="hint">%（加到每位玩家的有效钓速上，默认 0）</span>' +
      '<label style="width:110px;color:var(--txt-dim);font-size:13px;margin-left:12px">钓速上限</label>' +
      '<input id="cast-cap" class="ipt" type="number" min="0" max="100" step="5" style="width:110px" />' +
      '<span class="hint">%（默认 100）</span>' +
      '<button id="cast-save" class="btn primary" style="margin-left:12px">保存</button><span id="cast-state" class="hint"></span>' +
      '<button id="cast-reset" class="btn mini" style="margin-left:8px">恢复默认</button></div>' +
      '<label for="cast-formula">抛竿间隔公式（结果为 ms）</label><textarea id="cast-formula" class="ipt" spellcheck="false"></textarea>' +
      '<div class="hint">interval = 当前钓点基础间隔（独立值优先，再计入钓点速率增益）；speed = 钓竿 + 全服加成，经上限截断。其余变量与上钩公式相同。默认 interval / (1 + speed / 100)，无效计算值回退默认公式，最终间隔最长 1 小时。</div>' +
      '<div id="cast-preview" class="hint"></div></div>' +
      '<div class="panel" style="flex:1 1 100%;min-width:0">' +
      '<h3>💎 稀有度（<code>rare</code>）</h3>' +
      '<div class="hint" style="margin-bottom:10px">「稀有度」词缀（原名「稀有概率」，内部 id 仍为 <code>rare</code>）已改为' +
      '<b>降低普通品质物品的权重</b>：生成战利品时，<b>普通品质</b>条目的权重 × <code>K/(K+R)</code>，' +
      '其中 R 是该玩家的稀有度值、K 是下方的全局常数。非普通品质条目的权重不变。</div>' +
      '<div class="pool-row"><label style="width:150px;color:var(--txt-dim);font-size:13px">K（默认 2）</label>' +
      '<input id="rk-k" class="ipt mk-num" type="number" min="0.01" step="0.1" style="width:110px" value="2" />' +
      '<span class="hint">必须 &gt; 0；K 越大 = 稀有度的效果越弱</span>' +
      '<button id="rk-save" class="btn primary" style="margin-left:12px">保存</button><span id="rk-state" class="hint"></span></div>' +
      '<h4 style="margin-bottom:4px">试算（本地换算，不发请求）</h4>' +
      '<div class="pool-row"><label style="width:150px;color:var(--txt-dim);font-size:13px">稀有度 R</label>' +
      '<input id="rk-r" class="ipt mk-num" type="number" step="0.5" style="width:110px" value="3" />' +
      '<button id="rk-eval" class="btn" style="margin-left:12px">试算</button><span id="rk-out" class="hint"></span></div>' +
      '<h4 style="margin-bottom:4px">钓点战利品表测试（服务器实际生效值）</h4>' +
      '<div class="pool-row"><label style="width:150px;color:var(--txt-dim);font-size:13px">钓点</label>' +
      '<select id="rk-spot" class="ipt" style="min-width:280px"></select>' +
      '<button id="rk-test" class="btn primary" style="margin-left:12px">测试</button>' +
      '<span class="hint">用上方「稀有度 R」的值</span></div>' +
      '<div id="rk-table" class="hint"></div></div>' +
      '</div>';
    loadWorldCfg().then(function (cfg) {
      if (!cfg || view !== 'formula') return;
      wireSimulator();   // 模拟钓竿（v0.16.0 页面中心）：控件已在 DOM 里，这里做联动与试算
      $('fx-src').value = cfg.biteFormula || '';
      if ($('rk-k')) $('rk-k').value = cfg.rareK != null ? cfg.rareK : 2;
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
          const st = $('db-state');
          if (!st) return; // 回包晚于切页：面板已不在，跳过 DOM 写入
          if (!r.ok) { st.innerHTML = '<span class="err">' + esc(r.data.error || '保存失败') + '</span>'; return; }
          if (worldCfg) worldCfg.doubleBase = r.data.doubleBase;
          st.innerHTML = '<span style="color:var(--ok)">已保存，立即生效</span>';
          toast('基础双钓率已保存');
        });
      };
      // 抛竿间隔 + 全服钓速（基础值 / 最短值 / 全服加成 / 上限）；保存后服务器广播并重启在线循环
      const cbInp = $('cast-base'), cmInp = $('cast-min'), cboInp = $('cast-bonus'), ccpInp = $('cast-cap');
      const cdft = cfg.castDefaults || { baseMs: 10000, minMs: 800, speedBonus: 0, speedCap: 100, formula: GameData.CAST_FORMULA_DEFAULT };
      const cfInp = $('cast-formula');
      cfInp.value = cfg.castFormula || cdft.formula || GameData.CAST_FORMULA_DEFAULT;
      cbInp.value = cfg.castBaseMs != null ? cfg.castBaseMs : cdft.baseMs;
      cmInp.value = cfg.castMinMs != null ? cfg.castMinMs : cdft.minMs;
      cboInp.value = cfg.castSpeedBonus != null ? cfg.castSpeedBonus : cdft.speedBonus;
      ccpInp.value = cfg.castSpeedCap != null ? cfg.castSpeedCap : cdft.speedCap;
      function castPreview() {
        const base = Number(cbInp.value) || 0, min = Number(cmInp.value) || 0;
        const bonus = Number(cboInp.value) || 0, cap = Number(ccpInp.value) || 0;
        const samples = [0, 20, 45, 60, 90].map(function (sp) {
          const eff = Math.max(0, Math.min(cap, sp + bonus));
          const ms = GameData.castIntervalOf({}, null, { cast: { baseMs: base, minMs: min, speedBonus: sp + bonus, speedCap: cap, formula: cfInp.value } });
          return '玩家钓速 ' + sp + '%→有效 ' + Math.round(eff) + '%→' + (ms / 1000).toFixed(2) + 's';
        }).join('　');
        const pv = $('cast-preview');
        if (pv) pv.innerHTML = '实际间隔预览：' + samples;
      }
      [cbInp, cmInp, cboInp, ccpInp, cfInp].forEach(function (n) { n.addEventListener('input', castPreview); });
      castPreview();
      $('cast-save').onclick = function () {
        const body = {
          token: token,
          castBaseMs: Number(cbInp.value), castMinMs: Number(cmInp.value),
          castSpeedBonus: Number(cboInp.value), castSpeedCap: Number(ccpInp.value), castFormula: cfInp.value,
        };
        adminApi('POST', '/api/admin/settings', body).then(function (r) {
          // 异步回包可能晚于「管理员切走本页」：面板已被重建/移除时不能再写 DOM，
          // 否则 $('cast-*') 取到 null 直接抛错（会污染后台全程无页面错误的断言）。
          const st = $('cast-state');
          if (!st) return;
          if (!r.ok) { st.innerHTML = '<span class="err">' + esc(r.data.error || '保存失败') + '</span>'; return; }
          cbInp.value = r.data.castBaseMs; cmInp.value = r.data.castMinMs;
          cboInp.value = r.data.castSpeedBonus; ccpInp.value = r.data.castSpeedCap; cfInp.value = r.data.castFormula;
          castPreview();
          st.innerHTML = '<span style="color:var(--ok)">已保存，在线玩家循环已按新间隔重启</span>';
          toast('抛竿间隔与钓速已保存');
        });
      };
      $('cast-reset').onclick = function () {
        adminApi('POST', '/api/admin/settings', { token: token, castBaseMs: cdft.baseMs, castMinMs: cdft.minMs, resetCastSpeed: true }).then(function (r) {
          const st = $('cast-state');
          if (!st) return;
          if (!r.ok) { st.innerHTML = '<span class="err">' + esc(r.data.error || '重置失败') + '</span>'; return; }
          cbInp.value = r.data.castBaseMs; cmInp.value = r.data.castMinMs;
          cboInp.value = r.data.castSpeedBonus; ccpInp.value = r.data.castSpeedCap; cfInp.value = r.data.castFormula;
          castPreview();
          st.innerHTML = '<span style="color:var(--ok)">已恢复默认</span>';
          toast('已恢复默认抛竿间隔与钓速');
        });
      };

    });
    // ---- 💎 稀有度（K 值 + 本地试算 + 钓点战利品表实测）----
    // 注意：这段放在 loadWorldCfg 之外，世界配置读取失败时本面板依然可用（K 输入框 HTML 里已默认 2）。
    (function () {
      const rkInp = $('rk-k');
      if (!rkInp) return;
      // 百分比格式化：最多 1 位小数，整数去掉尾随 .0（40.0% → 40%，37.5% 保留）
      function pct1(v) {
        const s = (Number(v) * 100).toFixed(1);
        return (s.slice(-2) === '.0' ? s.slice(0, -2) : s) + '%';
      }
      // 本地乘数：mult = K/(K+R)；K 必须 > 0，且 K+R 必须 > 0（否则除零/负权重无意义）
      function rkMult() {
        const k = Number(rkInp.value);
        const r = Number($('rk-r').value);
        if (!isFinite(k) || k <= 0) return { err: 'K 必须是大于 0 的数字' };
        if (!isFinite(r)) return { err: '稀有度 R 必须是数字' };
        if (k + r <= 0) return { err: 'K + R 必须大于 0（当前 K=' + k + '，R=' + r + '）' };
        return { k: k, r: r, mult: k / (k + r) };
      }
      $('rk-eval').onclick = function () {
        const m = rkMult();
        if (m.err) { $('rk-out').innerHTML = '<span class="err">' + esc(m.err) + '</span>'; return; }
        $('rk-out').innerHTML = '普通品质物品权重 × <b>' + pct1(m.mult) + '</b>' +
          '（K=' + m.k + '，R=' + m.r + '）';
      };
      $('rk-save').onclick = function () {
        const k = Number(rkInp.value);
        if (!isFinite(k) || k <= 0) {
          $('rk-state').innerHTML = '<span class="err">K 必须是大于 0 的数字</span>';
          toast('稀有度 K 值必须是大于 0 的数字', true);
          return;
        }
        adminApi('POST', '/api/admin/settings', { token: token, rareK: k }).then(function (r) {
          if (!r.ok) {
            setHint('rk-state', '<span class="err">' + esc((r.data && r.data.error) || '保存失败') + '</span>');
            toast((r.data && r.data.error) || '保存失败', true);
            return;
          }
          const nk = r.data.rareK != null ? r.data.rareK : k;
          rkInp.value = nk;
          if (worldCfg) worldCfg.rareK = nk;
          setHint('rk-state', '<span style="color:var(--ok)">已保存，立即生效</span>');
          toast('稀有度 K 值已保存');
        });
      };
      // 钓点列表：GET /api/admin/loot/spots（真实生效的钓点，灌进下拉）
      $('rk-spot').innerHTML = '<option value="">加载中…</option>';
      adminApi('GET', '/api/admin/loot/spots?token=' + encodeURIComponent(token)).then(function (r) {
        if (view !== 'formula') return;
        const sel = $('rk-spot');
        if (!sel) return;
        if (!r.ok) {
          sel.innerHTML = '<option value="">（钓点列表读取失败）</option>';
          setHint('rk-table', '<span class="err">' + esc((r.data && r.data.error) || '钓点列表读取失败') + '</span>');
          return;
        }
        const spots = (r.data && r.data.spots) || [];
        if (!spots.length) {
          sel.innerHTML = '<option value="">（暂无可用钓点）</option>';
          setHint('rk-table', '当前没有可用钓点，无法做战利品表测试。');
          return;
        }
        sel.innerHTML = spots.map(function (s) {
          return '<option value="' + esc(s.key) + '">' + esc(s.name || s.key) + '</option>';
        }).join('');
      });
      // 实测：POST /api/admin/loot/test → 渲染前后权重对比表
      $('rk-test').onclick = function () {
        const sel = $('rk-spot');
        const spotKey = sel ? sel.value : '';
        if (!spotKey) { toast('请先选择钓点（列表为空或读取失败）', true); return; }
        const m = rkMult();
        if (m.err) { setHint('rk-table', '<span class="err">' + esc(m.err) + '</span>'); toast(m.err, true); return; }
        setHint('rk-table', '测试中…');
        adminApi('POST', '/api/admin/loot/test', { token: token, spotKey: spotKey, rare: m.r }).then(function (res) {
          const host = $('rk-table');
          if (!host) return;
          if (!res.ok) {
            host.innerHTML = '<span class="err">' + esc((res.data && res.data.error) || '测试失败') + '</span>';
            return;
          }
          const d = res.data || {};
          const rows = d.rows || [];
          // 服务器可能下发小数（0.42）也可能下发已换算的百分数（42）：按最大值自适应，
          // 全部 ≤ 1 才当作小数乘 100（真·百分比数据不可能整份都 ≤ 1，除非全部不足 1%）。
          const rawPcts = [d.commonBefore, d.commonAfter].concat(rows.map(function (r) { return r.beforePct; }),
            rows.map(function (r) { return r.afterPct; })).map(Number).filter(isFinite);
          const pctScale = rawPcts.length && rawPcts.every(function (v) { return Math.abs(v) <= 1.0001; }) ? 100 : 1;
          const pct = function (v) { return isFinite(Number(v)) ? (Number(v) * pctScale).toFixed(2) + '%' : '—'; };
          const mult = Number(d.mult);
          host.innerHTML =
            '<div style="margin:6px 0">钓点：<b>' + esc((d.spot && d.spot.name) || spotKey) + '</b>　' +
            'K=<b>' + esc(d.k) + '</b>　R=<b>' + esc(d.rare) + '</b>　' +
            '普通品质权重乘数 <b>×' + (isFinite(mult) ? pct1(mult) : '—') + '</b>　' +
            '普通品质总占比：<b>' + pct(d.commonBefore) + '</b> → <b>' + pct(d.commonAfter) + '</b></div>' +
            (rows.length
              ? '<div style="overflow-x:auto"><table class="tbl" style="font-size:12px"><thead><tr>' +
                '<th>条目</th><th>品质</th><th class="num">权重</th><th class="num">前占比</th><th class="num">后占比</th>' +
                '</tr></thead><tbody>' +
                rows.map(function (r) {
                  return '<tr><td>' + esc(r.name || r.pick || '—') + '</td>' +
                    '<td>' + esc(r.quality || '—') + '</td>' +
                    '<td class="num">' + esc(r.weight) + '</td>' +
                    '<td class="num">' + pct(r.beforePct) + '</td>' +
                    '<td class="num">' + pct(r.afterPct) + '</td></tr>';
                }).join('') + '</tbody></table></div>'
              : '<div class="hint">该钓点的战利品表为空。</div>');
        });
      };
    })();
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
    // fix：这里必须取 renderNotify 创建的 #nt-body 容器——
    // 之前直接引用了不存在的 body 变量，drawNotify 一执行就抛 ReferenceError，
    // promise 静默失败，页面永远停在「加载中…」。
    const body = $('nt-body');
    const an = cfg.autoNotify || { on: false, rules: [], hysteresisPct: 10, holdCount: 2 };
    const rulesRows = (an.rules || []).map(function (r, i) {
      return '<div class="mgr-row an-rule" data-i="' + i + '"><label>人数 ≥</label>' +
        '<input class="ipt an-min" type="number" min="0" step="50" value="' + (r.min || 0) + '" />' +
        '<select class="ipt an-level">' +
        Object.keys(cfg.notifyLevels).map(function (k) { return '<option value="' + k + '"' + (r.level === k ? ' selected' : '') + '>' + k + '</option>'; }).join('') +
        '</select><button class="btn mini danger an-del">删除</button></div>';
    }).join('') || '<div class="hint">暂无规则——人数低于最低门槛时使用最宽松档。</div>';
    body.innerHTML = Object.keys(cfg.notifyLevels).map(function (k) {
      return '<label class="radio-card' + (cfg.notifyLevel === k ? ' sel' : '') + '" data-lv="' + k + '">' +
        '<input type="radio" name="ntlv" value="' + k + '"' + (cfg.notifyLevel === k ? ' checked' : '') + '>' +
        '<div><b>' + esc(k) + ' — ' + esc(cfg.notifyLevels[k]) + '</b><span>' + esc(NOTIFY_HINT[k] || '') + '</span></div>' +
        '</label>';
    }).join('') +
      '<div class="editor-foot"><button id="nt-save" class="btn primary">保存通知等级</button><span id="nt-state" class="hint"></span></div>' +
      // perf-9：按人数自动调节（预设 + 迟滞 + 防抖）
      '<div class="panel" style="margin-top:16px"><h3 style="margin-top:0">🤖 按在线人数自动调节</h3>' +
      '<div class="hint" style="margin-bottom:8px">开启后服务器每 5 秒按在线人数自动切换上面的通知等级。防抖：切换需跨越带迟滞余量的门槛（默认 ±10%）并连续 ' + esc(an.holdCount || 2) + ' 次评估（每 5s 一次）保持一致，人数在门槛附近波动不会反复横跳。手动保存通知等级会自动关闭自动调节。</div>' +
      '<div class="mgr-row"><label>启用</label><label class="switch"><input type="checkbox" id="an-on"' + (an.on ? ' checked' : '') + '><span class="sl"></span></label>' +
      '<label class="hint">预设</label><select id="an-preset" class="ipt">' +
      '<option value="">— 选择预设 —</option><option value="default">标准（800 uncommon / 2000 records / 4000 none）</option>' +
      '<option value="relaxed">宽松（1500 records / 4000 none）</option></select>' +
      '<label class="hint">迟滞 %</label><input id="an-hyst" class="ipt" type="number" min="0" max="90" value="' + (an.hysteresisPct != null ? an.hysteresisPct : 10) + '" />' +
      '<label class="hint">保持次数</label><input id="an-hold" class="ipt" type="number" min="1" max="12" value="' + (an.holdCount || 2) + '" />' +
      '</div>' +
      '<div id="an-rules">' + rulesRows + '</div>' +
      '<div class="editor-foot"><button id="an-add" class="btn mini">＋ 加一条规则</button>' +
      '<button id="an-save" class="btn primary">保存自动调节</button><span id="an-state" class="hint"></span></div></div>';
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
      // perf-9：手动指定通知等级时自动关闭「按人数自动调节」，否则 5s 内会被自动档覆盖
      adminApi('POST', '/api/admin/settings', { token: token, notifyLevel: sel.value, autoNotify: { on: false } }).then(function (r) {
        if (!r.ok) { $('nt-state').innerHTML = '<span class="err">' + esc(r.data.error || '保存失败') + '</span>'; return; }
        if (worldCfg) worldCfg.notifyLevel = r.data.notifyLevel;
        $('nt-state').innerHTML = '<span style="color:var(--ok)">已保存，立即生效</span>';
        toast('通知等级已保存：' + sel.value);
      });
    };
    // ---- 自动调节面板逻辑 ----
    const anState = { on: an.on };
    const anOn = $('an-on');
    if (anOn) anOn.addEventListener('change', function () { anState.on = anOn.checked; });
    const rulesWrap = $('an-rules');
    $('an-add').onclick = function () {
      const row = document.createElement('div');
      row.className = 'mgr-row an-rule';
      row.innerHTML = '<label>人数 ≥</label><input class="ipt an-min" type="number" min="0" step="50" value="1000" />' +
        '<select class="ipt an-level">' +
        Object.keys(cfg.notifyLevels).map(function (k) { return '<option value="' + k + '">' + k + '</option>'; }).join('') +
        '</select><button class="btn mini danger an-del">删除</button>';
      row.querySelector('.an-del').onclick = function () { row.remove(); };
      rulesWrap.querySelector('div.hint') && rulesWrap.querySelector('div.hint').remove();
      rulesWrap.appendChild(row);
    };
    rulesWrap.querySelectorAll('.an-del').forEach(function (b) { b.onclick = function () { b.closest('.an-rule').remove(); }; });
    $('an-save').onclick = function () {
      const rules = Array.prototype.map.call(rulesWrap.querySelectorAll('.an-rule'), function (row) {
        return { min: Number(row.querySelector('.an-min').value) || 0, level: row.querySelector('.an-level').value };
      });
      const presetSel = $('an-preset');
      const payload = {
        token: token,
        autoNotify: {
          on: $('an-on').checked,
          hysteresisPct: Number($('an-hyst').value) || 0,
          holdCount: Number($('an-hold').value) || 2,
          rules: rules,
        },
      };
      if (presetSel && presetSel.value) payload.autoNotify.preset = presetSel.value;
      adminApi('POST', '/api/admin/settings', payload).then(function (r) {
        if (!r.ok) { $('an-state').innerHTML = '<span class="err">' + esc(r.data.error || '保存失败') + '</span>'; return; }
        if (worldCfg) worldCfg.autoNotify = r.data.autoNotify;
        $('an-state').innerHTML = '<span style="color:var(--ok)">已保存（当前在线 ' + esc(String(worldCfg && worldCfg.onlineCount || '—')) + ' 人，每 5s 评估一次）</span>';
        toast('自动调节已保存');
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
      '<h3>修饰词规则 <span class="hint">自上而下取第一条命中 —— 顺序就是优先级</span></h3>' +
      '<div class="hint" style="margin-bottom:8px">' +
      '「满词条」= <b>该底材的词缀池全中</b>（显示成「n/池长 词条」的分子达到分母）。' +
      '池外补出的额外词条（工坊补缀 / 宝匣突破件）会让分子超过分母，读作「越过词缀池边界」。<br>' +
      '每个条件都留空 = 不限制；一行里填多个条件 = 同时满足（并且）。示例：勾「满词条」+ 勾「无负词条」→ 完美的。' +
      '</div>' +
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
    function bindAdjRows() {
      const rows = Array.prototype.slice.call(body.querySelectorAll('#adj-rows .adj-row'));
      rows.forEach(function (row, i) {
        const idx = row.querySelector('.adj-idx');
        if (idx) idx.textContent = String(i + 1);
        const up = row.querySelector('.adj-up'), down = row.querySelector('.adj-down'), del = row.querySelector('.adj-del');
        if (up) up.disabled = i === 0;
        if (down) down.disabled = i === rows.length - 1;
        if (up) up.onclick = function () { const p = row.previousElementSibling; if (p) { p.before(row); bindAdjRows(); } };
        if (down) down.onclick = function () { const nx = row.nextElementSibling; if (nx) { nx.after(row); bindAdjRows(); } };
        if (del) del.onclick = function () { row.remove(); bindAdjRows(); };
        row.querySelectorAll('input').forEach(function (inp) { inp.oninput = function () { adjPreview(row); }; inp.onchange = function () { adjPreview(row); }; });
        adjPreview(row);
      });
    }
    // 每行右侧的「自然语言」摘要：填了什么条件、会显示成什么词，改一个字段立刻跟着变
    function adjPreview(row) {
      const box = row.querySelector('.adj-preview');
      if (!box) return;
      const name = (row.querySelector('.adj-name').value || '').trim() || '（未命名）';
      const conds = [];
      const f = function (k) { const e2 = row.querySelector('input[data-f="' + k + '"]'); return e2 ? e2 : null; };
      if (f('full') && f('full').checked) conds.push('满词条（池内全满）');
      if (f('noNeg') && f('noNeg').checked) conds.push('无负词条');
      const rng = function (a, b, lab, unit) {
        const va = f(a) ? f(a).value : '', vb = f(b) ? f(b).value : '';
        if (va === '' && vb === '') return;
        conds.push(lab + ' ' + (va === '' ? '不限' : va) + ' ~ ' + (vb === '' ? '不限' : vb) + (unit || ''));
      };
      rng('netMin', 'netMax', '词条净收益');
      rng('minAffixes', 'maxAffixes', '词条数');
      box.textContent = (conds.length ? '当 ' + conds.join(' 且 ') : '无条件（兜底）') + ' → 显示「' + name + '」';
    }
    body.querySelector('#adj-add').onclick = function () {
      const box = $('adj-rows'); const wrap = document.createElement('div'); wrap.innerHTML = adjRuleRow({ name: '' }); box.appendChild(wrap.firstChild); bindAdjRows();
    };
    bindAdjRows();
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
        const pct = function (c) { return (c / d.n * 100).toFixed(1) + '%'; };
        const qp = Object.keys(d.quality).map(function (k) { return k + ' ' + pct(d.quality[k]); }).join(' / ');
        // 修饰词规则的命中分布：一眼看出哪条规则从来轮不到（被上面的规则盖住），以及命名是否泛滥
        const ruleNames = Object.keys(d.rules || {});
        const maxHit = ruleNames.reduce(function (m, k) { return Math.max(m, d.rules[k].count); }, 1);
        const ruleHtml = ruleNames.length
          ? '<div style="margin-top:6px"><b>修饰词命中分布</b>（按已保存的规则试算）：<table class="tbl" style="margin-top:4px"><thead><tr><th>修饰词</th><th>占比</th><th>示例组件</th></tr></thead><tbody>' +
            ruleNames.sort(function (a, b) { return d.rules[b].count - d.rules[a].count; }).map(function (k) {
              const hit = d.rules[k];
              const bar = Math.round(hit.count / maxHit * 100);
              return '<tr><td>' + esc(k) + '</td><td class="num">' + pct(hit.count) +
                ' <span class="adj-bar" style="width:' + bar + '%"></span></td><td class="hint">' + esc(hit.samples.join('　/　')) + '</td></tr>';
            }).join('') + '</tbody></table>' +
            '<div class="hint" style="margin-top:4px">满词条（池内全满）' + pct(d.fullCount) + '　·　含池外词条件 ' + pct(d.extraCount) +
            '　·　「（无修饰词）」= 一条规则都没命中，组件只显示底材名</div></div>'
          : '';
        $('cmp-sim-out').innerHTML = '品质分布：' + qp + '　|　' + Object.keys(d.affix).map(function (t) { return t + ' 均值 ' + d.affix[t].mean; }).join('，') +
          ruleHtml;
      });
    };
  }
  function adjRuleRow(r) {
    r = r || {};
    function chk(k, lab, tip) { return '<label class="adj-chk"' + (tip ? ' title="' + esc(tip) + '"' : '') + '><input type="checkbox" data-f="' + k + '"' + (r[k] ? ' checked' : '') + '> ' + lab + '</label>'; }
    function num(k, ph) { return '<input class="ipt cmp-num" type="number" data-f="' + k + '" value="' + (r[k] != null ? r[k] : '') + '" placeholder="' + ph + '">'; }
    return '<div class="adj-row">' +
      '<div class="adj-head">' +
      '<span class="adj-idx">1</span>' +
      '<input class="ipt adj-name" data-f="name" value="' + esc(r.name || '') + '" placeholder="修饰词（如 完美的）">' +
      '<span class="adj-acts">' +
      '<button class="btn mini adj-up" title="上移（提高优先级）">↑</button>' +
      '<button class="btn mini adj-down" title="下移（降低优先级）">↓</button>' +
      '<button class="btn mini danger adj-del">删除</button></span>' +
      '</div>' +
      '<div class="adj-cond">' +
      chk('full', '满词条', '该底材的词缀池全中：界面显示的「n/池长 词条」分子到达分母')
      + chk('noNeg', '无负词条', '词条里没有负数值（-x%）') +
      '<span class="adj-num">词条净收益 ' + num('netMin', '不限') + ' ~ ' + num('netMax', '不限') + '</span>' +
      '<span class="adj-num">词条数 ' + num('minAffixes', '不限') + ' ~ ' + num('maxAffixes', '不限') + '</span>' +
      '<span class="adj-preview"></span>' +
      '</div>' +
      '</div>';
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
    { k: 'custom', name: '自定义分布', desc: '拖动或输入每个体型分组的权重' },
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
    function presetWeights(model) {
      if (model === 'normal') return [0.82, 2.77, 7.92, 15.92, 22.57, 22.57, 15.92, 7.92, 2.77, 0.82];
      if (model === 'skew') return new Array(10).fill(0).map(function (_, i) { return Math.round((Math.sqrt((i + 1) / 10) - Math.sqrt(i / 10)) * 10000) / 100; });
      return new Array(10).fill(10);
    }
    const weights = saved === 'custom' && GameData.validSizeWeights(cfg.sizeWeights) ? cfg.sizeWeights.slice() : presetWeights(saved);
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
      '<div class="fish-distribution"><p class="hint">按基准体型区间每10%分组。滑条以25为满格，更高权重可直接输入。拖动滑块或修改权重后切换为自定义分布；发生概率按总权重归一化。</p><div class="fish-weight-grid">' +
      weights.map(function (v, i) {
        return '<label class="fish-weight"><strong>' + (i * 10) + '–' + ((i + 1) * 10) + '%体型</strong>' +
          '<input type="range" min="0" max="25" step="0.1" data-fish-range="' + i + '" value="' + v + '" aria-label="分组' + (i + 1) + '权重滑块">' +
          '<input class="ipt" type="number" min="0" max="100" step="0.1" data-fish-weight="' + i + '" value="' + v + '" aria-label="分组' + (i + 1) + '权重"><span data-fish-pct="' + i + '"></span></label>';
      }).join('') + '</div></div>' +
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
      const total = bs.reduce(function (a, b) { return a + b; }, 0) || 1;
      const grouped = new Array(10).fill(0).map(function (_, i) { return '<span>' + (i * 10) + '–' + ((i + 1) * 10) + '%体型：<b>' + (((bs[i * 2] || 0) + (bs[i * 2 + 1] || 0)) / total * 100).toFixed(2) + '%</b></span>'; }).join('');
      chart.innerHTML = '<div style="margin-bottom:6px">' + head + '</div>' +
        '<div style="display:flex;align-items:flex-end;gap:1px">' + bars + '</div>' + axis + '<div class="fish-percent-preview">' + grouped + '</div>';
    }
    let previewSequence = 0;
    function runSim() {
      const sequence = ++previewSequence;
      const chart = $('fish-chart');
      if (chart) chart.textContent = '采样中…';
      const sel = $('fish-pick');
      adminApi('POST', '/api/admin/fish/simulate', {
        token: token, n: 20000, model: pick, sizeWeights: weights,
        fishId: (sel && sel.value) || undefined,
        sizeBonus: Number(($('fish-bonus') || {}).value) || 0,
      }).then(function (r) {
        if (view !== 'fishsize' || !body.isConnected || sequence !== previewSequence || !$('fish-chart')) return;
        if (!r.ok) { $('fish-chart').innerHTML = '<span class="err">' + esc(r.data.error || '试算失败') + '</span>'; return; }
        drawChart(r.data);
      });
    }
    body.querySelectorAll('.radio-card[data-fm]').forEach(function (c) {
      c.onclick = function () {
        body.querySelectorAll('.radio-card[data-fm]').forEach(function (x) { x.classList.remove('sel'); });
        c.classList.add('sel'); c.querySelector('input').checked = true;
        pick = c.getAttribute('data-fm');
        if (pick !== 'custom') presetWeights(pick).forEach(function (v, i) { weights[i] = v; body.querySelector('[data-fish-range="' + i + '"]').value = v; body.querySelector('[data-fish-weight="' + i + '"]').value = v; });
        syncWeights(); runSim();
      };
    });
    function syncWeights() {
      const total = weights.reduce(function (a, b) { return a + b; }, 0);
      body.querySelectorAll('[data-fish-pct]').forEach(function (n) { n.textContent = total ? (weights[Number(n.dataset.fishPct)] / total * 100).toFixed(2) + '%概率' : '总权重不能为0'; });
    }
    let previewTimer;
    body.querySelectorAll('[data-fish-range], [data-fish-weight]').forEach(function (input) {
      input.oninput = function () {
        const i = Number(input.dataset.fishRange == null ? input.dataset.fishWeight : input.dataset.fishRange);
        weights[i] = Math.max(0, Math.min(100, Number(input.value) || 0));
        body.querySelector('[data-fish-range="' + i + '"]').value = weights[i];
        body.querySelector('[data-fish-weight="' + i + '"]').value = weights[i];
        pick = 'custom';
        body.querySelectorAll('[data-fm]').forEach(function (n) { const on = n.dataset.fm === pick; n.classList.toggle('sel', on); n.querySelector('input').checked = on; });
        syncWeights(); clearTimeout(previewTimer);
        if (weights.some(function (v) { return v > 0; })) previewTimer = setTimeout(function () { if (view === 'fishsize') runSim(); }, 250);
      };
    });
    syncWeights();
    $('fish-sim').onclick = runSim;
    $('fish-pick').onchange = runSim;
    $('fish-save').onclick = function () {
      adminApi('POST', '/api/admin/fish/config', { token: token, sizeModel: pick, sizeWeights: weights }).then(function (r) {
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
    const ASC = cfg.autoSellCfg || {};
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
      '<div class="mgr-row" style="margin-top:14px;border-top:1px solid var(--line);padding-top:12px">' +
      '<h3 style="margin:0">🤖 自动出售打包阈值</h3></div>' +
      '<div class="hint" style="margin-bottom:6px">玩家的自动售出规则现在是「攒够一包才成交一次」：可卖余量（持有 − 保留数量）≥ 此值且价格达标时整批卖出，一次推送结算全部物品。设 1 = 退回「钓到即逐条卖」。</div>' +
      '<div class="mgr-row"><label style="width:110px">打包阈值</label><input id="as-batch" class="ipt mk-num" type="number" min="1" max="10000" step="10" value="' + (ASC.batch != null ? ASC.batch : 100) + '" style="width:100px">' +
      '<span class="hint">条（1-10000，默认 ' + (ASC.def != null ? ASC.def : 100) + '）</span>' +
      '<button class="btn primary" id="as-batch-save" style="margin-left:10px">保存打包阈值</button><span id="as-batch-state" class="hint"></span></div>' +
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
    // 自动出售打包阈值：全服生效，改小之后在线玩家可能立刻够一包（服务端保存时就地跑一遍）
    $('as-batch-save').onclick = function () {
      const b = Number($('as-batch').value);
      adminApi('POST', '/api/admin/settings', { token: token, autoSellCfg: { batch: b } }).then(function (r) {
        if (!r.ok) { $('as-batch-state').innerHTML = '<span class="err">' + esc(r.data.error || '保存失败') + '</span>'; return; }
        toast('打包阈值已设为 ' + ((r.data.autoSellCfg || {}).batch || b) + ' 条，立即生效');
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
      '<div class="panel"><h3 style="margin-top:0">🎣 上鱼通告横幅等级</h3>' +
      '<div class="hint" style="margin-bottom:8px">控制哪些「破纪录」事件会触发全服滚动横幅。等级从宽到严：gmax（仅全场最大）→ gmax10（全场最大 + 前十榜）→ fish（所有鱼类的全服最大/最小）→ fish10（所有鱼类的最大/最小 + 前十榜，默认）。</div>' +
      '<div class="mgr-row"><label>通告等级</label>' +
      '<select id="bn-catch-level" class="ipt">' +
      '<option value="gmax">gmax — 仅全服最大最小</option>' +
      '<option value="gmax10">gmax10 — 全服最大最小前十</option>' +
      '<option value="fish">fish — 全服所有鱼类最大最小</option>' +
      '<option value="fish10">fish10 — 全服所有鱼类最大最小前十</option>' +
      '</select>' +
      '<button class="btn primary" id="bn-catch-save">保存通告等级</button>' +
      '<span id="bn-catch-state" class="hint"></span></div></div>' +
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
    // perf-9：保存上鱼通告横幅等级
    const clSelEl = $('bn-catch-level');
    if (clSelEl) clSelEl.addEventListener('change', function () { clSelEl.dataset.dirty = '1'; });
    const clSave = $('bn-catch-save');
    if (clSave) clSave.onclick = function () {
      adminApi('POST', '/api/admin/banner/cfg', { token: token, catchLevel: $('bn-catch-level').value }).then(function (r) {
        if (!r.ok) { toast(r.data.error || '保存失败', true); return; }
        const s = $('bn-catch-state');
        if (s) s.innerHTML = '<span style="color:var(--ok)">已保存，立即生效</span>';
        toast('上鱼通告横幅等级已保存：' + $('bn-catch-level').value);
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
      // perf-9：上鱼通告横幅等级回显
      const clSel = $('bn-catch-level');
      if (clSel && !clSel.dataset.dirty) clSel.value = (r.data.cfg && r.data.cfg.catchLevel) || 'fish10';
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
    $('login-otp').addEventListener('keydown', function (e) { if (e.key === 'Enter') doLogin(); });
    $('login-otp').addEventListener('input', function () {
      if (/^\d{6}$/.test(this.value.trim()) && $('login-user').value.trim() && $('login-pass').value) doLogin();
    });
    $('login-user').addEventListener('keydown', function (e) { if (e.key === 'Enter') doLogin(); });
    $('logout-btn').onclick = function () { logout(); };
    let saved = 'cookie';
    try { localStorage.removeItem('fishing_admin_token'); } catch (e) {}
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

/*
 * 渔屋（v0.25.0）玩家端：🏠 晒架 / 🐶 宠物 / 🧍 角色 三个页签的面板与请求。
 *
 * 设计变更（v0.25.0）：
 *   - 收益来源改为「晒架投鱼 → 离线计时 → 收取完成批次」，无被动金币。
 *   - 宠物有三种职能：守卫（拦截偷取）、生产（加速晒干 + 精品概率）、采集（自动收取）。
 *   - 角色厨师方向提升批次收益，腌制师解锁腌制前处理阶段，商人提升偷取次数。
 *
 * 分工：页签外壳、展示台在 ui.js 的 renderCharacter；本文件只负责服务端权威数据的面板与写操作。
 * 样式全部复用既有类，不新增 CSS / 不引入依赖。
 *
 * 写操作全部走 assets.Run 幂等命令（同 expedition.js 的 requestKey 机制）。
 */
(function () {
  'use strict';
  const D = window.GameData;

  // 8 只宠物定义（id 与 assets/ui/char/dog_<id>.png 对应）
  const PETS = [
    ['golden',    '金毛',     'production'],
    ['corgi',     '柯基',     'guard'],
    ['malamute',  '阿拉斯加', 'guard'],
    ['basset',    '巴吉度',   'collect'],
    ['shepherd',  '德牧',     'guard'],
    ['dachshund', '腊肠',     'production'],
    ['bernese',   '伯恩山',   'collect'],
    ['mainecoon', '缅因猫',   'production'],
  ];

  const PET_ROLE_LABELS = {
    guard:      ['🛡 守卫', '宠物驻守后拦截好友偷取，亲和越高拦截概率越大'],
    production: ['⚡ 生产', '宠物驻守后缩短晒干时间、提高精品批次概率'],
    collect:    ['📦 采集', '宠物驻守后自动收取完成的批次（扣 5% 碎损）'],
  };

  const TRACKS = [
    ['cook',   '🍳 厨师',   '提高所有批次的收益（×倍率），腌制 / 晒干 / 后处理均受益'],
    ['brine',  '🧂 腌制师', '解锁并强化「腌制前处理」阶段（需要 Lv.1 才能使用盐腌）'],
    ['trader', '🤝 商人',   '提高每日偷取次数上限'],
  ];

  const PHASE_LABELS = { pre: '腌制', dry: '晒干', post: '后处理' };
  const PHASE_ICONS  = { pre: '🧂', dry: '☀️', post: '🔨' };

  // 拒绝码 → 中文
  const errors = {
    house_level_max:          '渔屋已经满级，继续投入请用「无尽翻新」。',
    house_fish_unknown:           '背包里没有这种鱼，或者该物品不是鱼类。',
    house_material_insufficient: '材料不足。',
    house_coin_insufficient:  '金币不足。',
    house_pet_max:            '这只宠物的亲和已经到顶了。',
    house_pet_slot:           '驻守栏位已满，先收起一只宠物。',
    house_role_max:           '该方向或总点数已经到上限。',
    house_not_friend:         '只能偷好友的溢出晒场，且需要好友关系满 24 小时。',
    house_friend_too_new:     '好友关系还不到 24 小时，暂时偷不了。',
    house_steal_limit:        '今天的偷取次数用完了（商人方向可以提升上限）。',
    house_steal_pair_limit:   '今天已经偷过这位好友了，明天再来。',
    house_steal_daily_cap:    '今天的偷取金币已达上限。',
    house_steal_empty:        '对方的溢出晒场是空的。',
    house_steal_intercepted:  '被对方的守卫宠物拦截了！',
    house_target_missing:     '找不到这位玩家。',
    house_rack_locked:        '渔屋等级不足，晒架还未解锁。',
    house_rack_slot_invalid:  '无效的晒架位。',
    house_rack_slot_occupied: '该晒架位已有鱼在晒，等完成后再放。',
    house_rack_chain_invalid: '加工链必须包含「晒干」阶段。',
    house_stage_locked_cook:  '需要厨师方向点数才能使用后处理阶段。',
    house_stage_locked_brine: '需要腌制师方向点数才能使用腌制阶段。',
    request_key_conflict:     '这次操作已经受理，请刷新后再试。',
    retry_same_request:       '服务端繁忙，请稍后重试（同一操作不会重复扣除资源）。',
  };

  function S() { return window.Engine.state; }
  function cfg() { return D.HUT || {}; }
  function house() { const st = S(); return (st && st.house) || null; }
  function num(v, d) { const n = Number(v); return isFinite(n) ? n : (d || 0); }
  function money(n) { return num(n, 0).toLocaleString('zh-CN'); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]; }); }
  function pct(v) { return Math.round(num(v, 0) * 1000) / 10 + '%'; }
  function itemName(id) { return (D.itemName && D.itemName(id)) || id; }
  function el(tag, cls, html) { const n = document.createElement(tag); if (cls) n.className = cls; if (html != null) n.innerHTML = html; return n; }
  function toast(msg) { if (window.UI && window.UI.toast) window.UI.toast(msg); }
  function refresh() { if (window.UI && window.UI.refreshAll) window.UI.refreshAll('house'); }
  function held(id) { const st = S(); return num(st && st.inventory && st.inventory[id], 0); }

  // 结构签名：只包含会改变 DOM 结构的量
  // picksLeft / coinUsed / heat 是纯数字，由 fill() 就地更新，不进签名——
  // 否则每竿一次的 assets 广播都会让 sigOf 返回新值，触发整页重建。
  function sigOf(h) {
    if (!h) return 'none';
    const st = h.steal || {};
    return JSON.stringify([h.level, h.endless, h.prestige, h.pets || {}, h.roles || {}, h.stationed || [],
      h.nextCost || null, h.renovateCost || null, h.rackCapacity,
      (h.rackSlots || []).map(function (s) { return [s.slotIdx, s.done, s.fishId, s.phaseIdx]; }),
      [st.picksMax, st.coinCap]]);
  }

  // ---- 幂等请求键 ----
  let busy = false, pending = null;
  try { pending = JSON.parse(sessionStorage.getItem('fishing-house-pending') || 'null'); } catch (_) { pending = null; }
  function keyFor(signature) {
    if (!pending || pending.signature !== signature) {
      const rand = (window.crypto && window.crypto.randomUUID)
        ? window.crypto.randomUUID()
        : Date.now() + '-' + Math.random().toString(36).slice(2);
      pending = { signature: signature, key: 'house-' + rand };
    }
    try { sessionStorage.setItem('fishing-house-pending', JSON.stringify(pending)); } catch (_) { }
    return pending.key;
  }
  function dropKey() { pending = null; try { sessionStorage.removeItem('fishing-house-pending'); } catch (_) { } }

  function setMessage(host, text) { const n = host && host.querySelector('[data-house-message]'); if (n) n.textContent = text || ''; }
  function setBusy(host, on) {
    if (!host) return;
    host.querySelectorAll('[data-house-action]').forEach(function (b) {
      if (on) b.setAttribute('aria-busy', 'true'); else b.removeAttribute('aria-busy');
    });
  }

  function send(host, action, body, okText, signature) {
    if (busy) return Promise.resolve(false);
    if (!window.Net || !window.Net.houseAction) return Promise.resolve(false);
    busy = true;
    setBusy(host, true);
    const key = keyFor(action + '|' + (signature || JSON.stringify(body || {})));
    return Promise.resolve(window.Net.houseAction(action, Object.assign({ requestKey: key }, body || {})))
      .then(function (r) {
        const data = (r && r.data) || {};
        if (r && r.ok && data.house) {
          dropKey();
          const st = S();
          st.house = data.house;
          if (data.coins != null && st.player) st.player.coins = data.coins;
          const text = okText || '已生效';
          setMessage(host, text);
          toast(text);
          refresh();
        } else {
          if (r && r.status >= 400 && r.status < 500) dropKey();
          const code = data.error || data.code;
          const text = errors[code] || code || '连接未完成，请重试；同一操作不会重复扣除资源。';
          setMessage(host, text);
          toast(text);
        }
        return r;
      })
      .catch(function () {
        setMessage(host, '连接未完成，请重试；同一操作不会重复扣除资源。');
        return false;
      })
      .then(function (v) { busy = false; setBusy(host, false); return v; });
  }

  // ---- 好友列表（偷取目标）----
  let friends = null, friendsAt = 0, friendsLoading = false;
  function loadFriends(host) {
    if (friendsLoading || !window.Net || !window.Net.fetchFriends) return;
    friendsLoading = true;
    Promise.resolve(window.Net.fetchFriends('', 1)).then(function (r) {
      friendsLoading = false;
      if (r && r.ok && r.data) { friends = r.data.friends || []; friendsAt = Date.now(); }
      else if (!friends) friends = [];
      drawFriends(host);
    }).catch(function () { friendsLoading = false; if (!friends) friends = []; drawFriends(host); });
  }
  function friendsHtml(h, c) {
    if (!friends) return '<p class="hint">正在载入好友…</p>';
    if (!friends.length) return '<p class="hint">还没有好友。加好友后就能互相偷「溢出晒场」。</p>';
    const pick = Math.min(num(c.stealPerLevel, 0) * num(h.level, 1), num(c.stealPerPickCap, 0));
    return '<div class="exp-routes">' + friends.map(function (f) {
      const name = f.username || f.name || f.id || '';
      return '<article class="exp-route"><h4>' + esc(f.name || name) + ' <small>' + (f.online ? '在线' : '离线') + '</small></h4>' +
        '<p class="hint">可偷 ' + money(pick) + ' 金币 + 1 个普通鱼饵材料</p>' +
        '<button class="btn primary" data-house-action="steal" data-feature="character.steal" data-house-target="' + esc(name) + '">偷取</button></article>';
    }).join('') + '</div>';
  }
  function drawFriends(host) {
    const box = host && host.querySelector('[data-house-friends]');
    if (!box) return;
    box.innerHTML = friendsHtml(house() || {}, cfg());
    if (!friends) loadFriends(host);
  }

  // ---- 晒架面板 ----
  function formatTimeLeft(readyAt) {
    if (!readyAt) return '';
    const ms = new Date(readyAt).getTime() - Date.now();
    if (ms <= 0) return '即将完成';
    const h = Math.floor(ms / 3600000);
    const m = Math.floor((ms % 3600000) / 60000);
    return h > 0 ? h + ' 小时 ' + m + ' 分钟' : m + ' 分钟';
  }

  // 背包里可投放的鱼：Engine.state.inventory 中数量 > 0 且 kind === 'fish'，按基准价从高到低。
  // 价格与品质仅用于展示，服务端会按 catalog 重新查询，不信任客户端。
  function inventoryFish() {
    const st = (window.Engine && window.Engine.state) || {};
    const inv = st.inventory || {};
    const meta = function (id) { return D && D.itemOf ? D.itemOf(id) : null; };
    return Object.keys(inv).filter(function (id) {
      const m = meta(id);
      return inv[id] > 0 && m && m.kind === 'fish';
    }).map(function (id) {
      const m = meta(id);
      return { id: id, name: m.name || id, price: num(m.price, 0), count: inv[id] };
    }).sort(function (a, b) { return b.price - a.price; });
  }

  function fishPickerHtml(idx) {
    const list = inventoryFish();
    if (!list.length) {
      return '<p class="hint note">背包里没有鱼。先去钓几条，高价值的鱼晒干收益更高。</p>';
    }
    const opts = list.map(function (f) {
      return '<option value="' + esc(f.id) + '">' + esc(f.name) + ' ×' + f.count + ' · 基准 ' + money(f.price) + '</option>';
    }).join('');
    return '<label class="note">选择鱼 <select data-rack-fish="' + idx + '" aria-label="晒架位 #' + (idx + 1) + ' 投放的鱼">' + opts + '</select></label> ' +
      '<button class="btn mini go" data-house-action="place_fish" data-rack-slot="' + idx + '" data-feature="character.place_fish">投入晒架</button>';
  }

  function rackSlotHtml(slot, idx, rackCapacity, roles) {
    const c = cfg();
    const stages = c.rackStages || [];
    const cookPts = num((roles || {}).cook, 0);
    const brinePts = num((roles || {}).brine, 0);

    if (!slot) {
      // Empty slot: show chain selector placeholder
      const chainOpts = stages.map(function (s) {
        const locked = (s.minCookLevel && cookPts < s.minCookLevel) || (s.minBrineLevel && brinePts < s.minBrineLevel);
        const label = (PHASE_ICONS[s.id] || '') + ' ' + (PHASE_LABELS[s.id] || s.id) + ' ×' + Math.round((s.multiplier || 1) * 10) / 10;
        return '<label class="rack-phase-opt' + (locked ? ' locked' : '') + '">' +
          '<input type="checkbox" data-rack-phase="' + esc(s.id) + '"' + (s.id === 'dry' ? ' checked disabled' : '') + (locked ? ' disabled' : '') + '> ' +
          label + (locked ? ' <small>（未解锁）</small>' : '') + '</label>';
      }).join('');
      return '<article class="rack-slot rack-slot-empty" data-rack-slot="' + idx + '">' +
        '<h5>晒架位 #' + (idx + 1) + ' <small class="hint">空</small></h5>' +
        '<div class="rack-phase-picker">' + chainOpts + '</div>' +
        fishPickerHtml(idx) +
        '</article>';
    }

    // Occupied slot
    const phaseLine = slot.phases.map(function (p, i) {
      const active = !slot.done && i === slot.phaseIdx;
      return '<span class="rack-phase' + (active ? ' active' : '') + (i < slot.phaseIdx ? ' done' : '') + '">' +
        (PHASE_ICONS[p] || '') + (PHASE_LABELS[p] || p) + '</span>';
    }).join(' → ');

    const status = slot.done
      ? '<b class="tag success">' + (slot.premium ? '✨ 精品完成' : '✅ 完成') + '</b>'
      : '<span class="hint">剩余 ' + formatTimeLeft(slot.readyAt) + '</span>';

    return '<article class="rack-slot rack-slot-active" data-rack-slot="' + idx + '">' +
      '<h5>晒架位 #' + (idx + 1) + '</h5>' +
      '<p class="note">' + esc(slot.fishId || '鱼') + ' · ' + (slot.fishTier || '') + '</p>' +
      '<div class="rack-phase-chain">' + phaseLine + '</div>' +
      '<p>' + status + '</p>' +
      '</article>';
  }

  function renderYard(host, h) {
    const c = cfg();
    const rackCap = num(h.rackCapacity, 0);
    const rackSlots = h.rackSlots || [];
    const roles = h.roles || {};
    const many = num(h.level, 1) >= ((c.levels && c.levels.length) || 10);
    const cost = many ? (h.renovateCost || null) : (h.nextCost || null);
    const msg = (host.querySelector('[data-house-message]') || {}).textContent || '';
    const steal = h.steal || {};

    // Build slot map from server's rackSlots array
    const slotMap = {};
    rackSlots.forEach(function (s) { slotMap[s.slotIdx] = s; });

    const slotsHtml = rackCap > 0
      ? Array.from({ length: rackCap }, function (_, i) { return rackSlotHtml(slotMap[i] || null, i, rackCap, roles); }).join('')
      : '<p class="hint">晒架在渔屋 Lv3 解锁（第一个晒架位）。升级渔屋即可开放更多位置。</p>';

    const hasDone = rackSlots.some(function (s) { return s.done; });

    const costHtml = function (cost) {
      if (!cost) return '<span class="hint">已经满级</span>';
      const parts = ['<span data-house-cost="coins">💰 ' + money(cost.coins) + ' <small>（持有 ' + money(num(S().player && S().player.coins, 0)) + '）</small></span>'];
      Object.keys(cost.items || {}).forEach(function (id) {
        parts.push('<span>' + esc(itemName(id)) + ' ×' + money(cost.items[id]) + ' <small>（持有 ' + money(held(id)) + '）</small></span>');
      });
      return parts.join('');
    };

    const box = el('div', 'hut-panel');
    box.innerHTML =
      '<div class="room2 hut-top">' +
        '<section class="box"><h5>🏠 晒架</h5>' +
          '<p class="note">投入鱼干原料，选择加工链（腌制 → 晒干 → 后处理），离线和在线都计时。完成后收取即可兑换金币。</p>' +
          '<div class="rack-slots">' + slotsHtml + '</div>' +
          (rackCap > 0 && hasDone
            ? '<div class="row"><button class="mini gold" data-house-action="collect_rack" data-feature="character.collect_rack">收取全部完成批次</button></div>'
            : '') +
        '</section>' +
        '<section class="box"><h5>下一级</h5>' +
          '<div class="exp-metrics hut-cost">' + costHtml(cost) + '</div>' +
          '<p class="note">' + (many
            ? '无尽层逐级提升晒架每批收益加成，边际递减。'
            : '升级解锁更多晒架位、解锁更高阶加工链。') + '</p>' +
          '<div class="row"><button class="mini go" data-house-action="' + (many ? 'renovate' : 'upgrade') +
            '" data-feature="character.upgrade">' + (many ? '投入 1 级无尽翻新' : '升级到 Lv' + (num(h.level, 1) + 1)) + '</button></div>' +
        '</section>' +
      '</div>' +
      '<section class="box"><h5>🕵 好友偷取</h5>' +
        '<p class="note">偷好友的「溢出晒场」（不扣原主收益）。守卫宠物可以拦截偷取。' +
        '每对好友每天 1 次、每天最多 ' + num(c.stealPicksPerDay, 0) + ' 次（商人方向可提升）。</p>' +
        (steal.picksMax != null ? '<div class="exp-metrics"><b data-house-steal-count>今日剩余 ' + num(steal.picksLeft, 0) + ' / ' + num(steal.picksMax, 0) + ' 次</b>' +
          '<span>偷取金币 ' + money(steal.coinUsed) + ' / ' + money(steal.coinCap) + '</span>' +
          (steal.heat != null ? '<span>晒场热度 ' + num(steal.heat, 0) + '</span>' : '') + '</div>' : '') +
        '<div data-house-friends></div></section>' +
      '<p role="status" class="hint" data-house-message>' + esc(msg) + '</p>';
    host.appendChild(box);
    drawFriends(host);
  }

  // ---- 宠物面板 ----
  function renderPet(host, h) {
    const c = cfg();
    const pets = h.pets || {};
    const stationed = (h.stationed || []).slice();
    const slots = Math.max(num(h.slots, 0), stationed.length);
    const max = affinityMax(c);
    const msg = (host.querySelector('[data-house-message]') || {}).textContent || '';

    const box = el('div', 'hut-panel');
    box.innerHTML =
      '<h3>🐶 宠物驻守</h3>' +
      '<p class="hint">喂「普通鱼饵材料」提升亲和；亲和决定宠物职能的强度。驻守中的宠物才会发挥效果。' +
      '驻守栏位 Lv' + num(c.bonusUnlockLevel, 5) + ' 开放第 1 个、Lv8 开放第 2 个，最多 ' + num(c.petSlots, 2) + ' 只。</p>' +
      '<div class="exp-metrics"><b>驻守 ' + stationed.length + ' / ' + slots + '</b>' +
      '<span>渔屋 Lv' + num(h.level, 1) + '</span></div>' +
      '<div class="exp-routes">' + PETS.map(function (p) {
        const id = p[0], affinity = num(pets[id], 0), on = stationed.indexOf(id) >= 0;
        const progress = max > 0 ? Math.max(0, Math.min(100, Math.round(affinity / max * 100))) : 0;
        const roleLabel = PET_ROLE_LABELS[p[2]] || ['', ''];
        return '<article class="exp-route hut-pet-card' + (on ? ' stationed' : '') + '" data-pet-card="' + id + '">' +
          '<h4>' + esc(p[1]) + ' <small>亲和 ' + affinity + ' / ' + max + (on ? ' · 驻守中' : '') + '</small></h4>' +
          '<div class="hut-pet-art"><img src="assets/ui/char/dog_' + id + '.png" alt="" draggable="false" onerror="__imgFail(this)"></div>' +
          '<div class="hut-pet-meter" role="meter" aria-label="' + esc(p[1]) + '亲和" aria-valuemin="0" aria-valuemax="' + max + '" aria-valuenow="' + affinity + '"><i style="width:' + progress + '%"></i></div>' +
          '<p class="hint">' + esc(roleLabel[0]) + ' · ' + esc(roleLabel[1]) + '</p>' +
          '<div class="exp-actions">' +
          '<button class="btn mini" data-house-action="pet" data-pet-id="' + id + '" data-pet-op="feed" data-feature="character.pet">喂养</button>' +
          '<button class="btn mini" data-house-action="pet" data-pet-id="' + id + '" data-pet-op="' + (on ? 'unstow' : 'station') + '" data-feature="character.pet">' +
          (on ? '收起' : '驻守') + '</button></div></article>';
      }).join('') + '</div>' +
      '<p class="hint">喂养消耗：普通鱼饵材料 ×1（同一操作重放不会重复扣除）。</p>' +
      '<p role="status" class="hint" data-house-message>' + esc(msg) + '</p>';
    host.appendChild(box);
  }

  function affinityMax(c) { return num(c.petPerLevel, 0) > 0 ? Math.round(num(c.petBonusCap, 0) / num(c.petPerLevel, 0)) : 10; }

  // ---- 角色面板 ----
  function renderRole(host, h) {
    const c = cfg();
    const roles = h.roles || {};
    const max = trackCap(c);
    const totalMax = num(c.rolePointsMax, 0);
    let used = 0;
    Object.keys(roles).forEach(function (k) { used += num(roles[k], 0); });
    const msg = (host.querySelector('[data-house-message]') || {}).textContent || '';
    const box = el('div', 'hut-panel');
    box.innerHTML =
      '<h3>🧍 角色养成</h3>' +
      '<p class="hint">三个方向共用 ' + totalMax + ' 点（每方向上限 ' + max + ' 点）。' +
      '厨师直接提高每批次收益倍率；腌制师解锁腌制前处理阶段（让批次价值 ×1.4）；商人增加偷取次数。</p>' +
      '<div class="exp-metrics"><b>已分配 ' + used + ' / ' + totalMax + ' 点</b>' +
      '<span>厨师 +' + pct(Math.min(num(roles.cook, 0) * num(c.rolePerPoint, 0), num(c.roleBonusCap, 0))) + '</span>' +
      '<span>腌制师 ' + num(roles.brine, 0) + ' 点（Lv1 解锁腌制阶段）</span>' +
      '<span>商人 ' + num(roles.trader, 0) + ' 点</span></div>' +
      '<div class="exp-routes">' + TRACKS.map(function (t) {
        const id = t[0], points = num(roles[id], 0);
        return '<article class="exp-route"><h4>' + t[1] + ' <small>' + points + ' / ' + max + ' 点</small></h4>' +
          '<p class="hint">' + t[2] + '</p>' +
          '<div class="exp-actions"><button class="btn primary" data-house-action="role" data-track="' + id + '" data-feature="character.role"' +
          (points >= max || used >= totalMax ? ' disabled' : '') + '>投入 1 点</button></div></article>';
      }).join('') + '</div>' +
      '<p role="status" class="hint" data-house-message>' + esc(msg) + '</p>';
    host.appendChild(box);
  }

  function trackCap(c) { return num(c.rolePerPoint, 0) > 0 ? Math.round(num(c.roleBonusCap, 0) / num(c.rolePerPoint, 0)) : 3; }

  // ---- 事件处理 ----
  function onAction(host, btn) {
    const action = btn.getAttribute('data-house-action');
    if (action === 'collect_rack') {
      send(host, 'collect_rack', {}, '已收取完成批次');
    } else if (action === 'place_fish') {
      // 读取用户在该槽选择的阶段
      const slotIdx = num(btn.getAttribute('data-rack-slot'), 0);
      const slotEl = host.querySelector('[data-rack-slot="' + slotIdx + '"]');
      const phases = [];
      if (slotEl) {
        slotEl.querySelectorAll('[data-rack-phase]:checked').forEach(function (cb) {
          phases.push(cb.getAttribute('data-rack-phase'));
        });
      }
      if (!phases.includes('dry')) phases.push('dry');
      // 加工链顺序固定为 pre → dry → post，与勾选顺序无关。
      const order = { pre: 0, dry: 1, post: 2 };
      phases.sort(function (a, b) { return order[a] - order[b]; });
      const sel = host.querySelector('[data-rack-fish="' + slotIdx + '"]');
      const fishId = sel ? sel.value : '';
      if (!fishId) { setMessage(host, '请先选择要投放的鱼。'); return; }
      send(host, 'place_fish', { fishId: fishId, slotIdx: slotIdx, phases: phases },
        '已投入晒架位 #' + (slotIdx + 1), 'place_fish|' + slotIdx + '|' + fishId + '|' + phases.join(','));
    } else if (action === 'upgrade') {
      send(host, 'upgrade', {}, '渔屋升级完成');
    } else if (action === 'renovate') {
      send(host, 'renovate', {}, '无尽翻新完成');
    } else if (action === 'pet') {
      const id = btn.getAttribute('data-pet-id'), op = btn.getAttribute('data-pet-op');
      send(host, 'pet', { petId: id, petAction: op }, op === 'feed' ? '亲和提升' : (op === 'station' ? '已驻守' : '已收起'));
    } else if (action === 'role') {
      send(host, 'role', { track: btn.getAttribute('data-track'), points: 1 }, '方向点数已投入');
    } else if (action === 'steal') {
      send(host, 'steal', { target: btn.getAttribute('data-house-target') }, '偷取成功');
    }
  }

  function wire(host) {
    if (host._houseWired) return;
    host._houseWired = true;
    host.addEventListener('click', function (ev) {
      const btn = ev.target && ev.target.closest ? ev.target.closest('[data-house-action]') : null;
      if (!btn || !host.contains(btn) || btn.disabled) return;
      onAction(host, btn);
    });
  }

  let loading = false, loadedAt = 0;
  function ensureLoad() {
    if (loading || (loadedAt && Date.now() - loadedAt < 3000) || !window.Net || !window.Net.fetchHouse) return;
    loading = true;
    Promise.resolve(window.Net.fetchHouse()).then(function () { loading = false; loadedAt = Date.now(); },
      function () { loading = false; });
  }

  function render(host, tab) {
    if (!host) return;
    wire(host);
    const h = house();
    if (!h) {
      host.appendChild(el('div', 'hint ld-state', '正在读取渔屋状态…'));
      ensureLoad();
      return;
    }
    if (tab === 'pet') renderPet(host, h);
    else if (tab === 'role') renderRole(host, h);
    else renderYard(host, h);
  }

  // 就地更新：只更新纯数据（steal count 等）
  function fill(host, tab) {
    const h = house();
    if (!host || !h || tab !== 'yard') return false;
    if (friends && Date.now() - friendsAt > 60000) { friends = null; drawFriends(host); }
    if (h.steal && h.steal.picksMax != null) {
      const m = host.querySelector('[data-house-steal-count]');
      if (m) m.textContent = '今日剩余 ' + num(h.steal.picksLeft, 0) + ' / ' + num(h.steal.picksMax, 0) + ' 次';
    }
    return true;
  }

  window.HouseUI = { render: render, fill: fill, sig: sigOf, PETS: PETS, errors: errors };
})();

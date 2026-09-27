/*
 * 渔屋（v0.24.0）玩家端：🏠 晒场 / 🐶 宠物 / 🧍 角色 三个页签的面板与请求。
 *
 * 分工（与远洋页同款）：页签外壳、容器、展示台与本地装饰留在 ui.js 的 renderCharacter，
 * 本文件只负责服务端权威数据的面板与写操作。不新增 CSS / 不引入依赖，样式全部复用既有类
 * （.exp-metrics / .exp-routes / .exp-route / .exp-actions / .char-cards / .cc-card / .hint / .btn / .tag）。
 *
 * 数值配置的唯一来源是 data.js 的 D.HUT（与服务端 catalog 常量段 HUT 同源，见 IMPLEMENTATION-CONTRACT §1），
 * 前端不写死数字；服务端 View 带了 rate / pending / nextCost / renovateCost / steal 时一律以服务端为准。
 *
 * 写操作全部走 assets.Run 幂等命令：客户端生成并持久化 requestKey（照抄 expedition.js:14-41），
 * 重试复用同一个 key、收到 4xx 立刻作废未决 key；成功直接用响应里的 house 重绘，不再额外请求。
 */
(function () {
  'use strict';
  const D = window.GameData;
  // 8 只宠物：id 与 assets/ui/char/dog_<id>.png、服务端 HUT 的宠物 id 一一对应（原「同伴」贴图全保留）
  const PETS = [
    ['golden', '金毛'], ['corgi', '柯基'], ['malamute', '阿拉斯加'], ['basset', '巴吉度'],
    ['shepherd', '德牧'], ['dachshund', '腊肠'], ['bernese', '伯恩山'], ['mainecoon', '缅因猫'],
  ];
  const TRACKS = [
    ['cook', '🍳 厨师', '提高鱼干售价（直接进渔屋速率）'],
    ['brine', '🧂 腌制师', '提高「晒场腌制」的材料 → 声望兑换效率'],
    ['trader', '🤝 商人', '提高偷取次数上限与晒场热度收益'],
  ];
  // 拒绝码 → 中文（IMPLEMENTATION-CONTRACT §3 的 13 个码；未命中时原样显示码，见 §4）
  const errors = {
    house_level_max: '渔屋已经满级，继续投入请用「无尽翻新」。',
    house_material_insufficient: '材料不足：升级需要风暴遗物 / 强化合金 / 普通鱼饵材料。',
    house_coin_insufficient: '金币不足。',
    house_pet_max: '这只宠物的亲和已经到顶了。',
    house_pet_slot: '驻守栏位已满，先收起一只宠物。',
    house_role_max: '该方向或总点数已经到上限。',
    house_not_friend: '只能偷好友的溢出晒场，且需要好友关系满 24 小时。',
    house_friend_too_new: '好友关系还不到 24 小时，暂时偷不了。',
    house_steal_limit: '今天的偷取次数用完了（商人方向 / 声望可以提升上限）。',
    house_steal_pair_limit: '今天已经偷过这位好友了，明天再来。',
    house_steal_daily_cap: '今天的偷取金币已达上限（材料不受影响）。',
    house_steal_empty: '对方的溢出晒场是空的，等对方离线攒一会儿。',
    house_target_missing: '找不到这位玩家。',
    request_key_conflict: '这次操作已经受理，请刷新后再试。',
    retry_same_request: '服务端繁忙，请稍后重试（同一操作不会重复扣除资源）。',
  };

  function S() { return window.Engine.state; }
  function cfg() { return D.HUT || {}; }
  function house() { const st = S(); return (st && st.house) || null; }
  function num(v, d) { const n = Number(v); return isFinite(n) ? n : (d || 0); }
  function money(n) { return num(n, 0).toLocaleString('zh-CN'); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]; }); }
  function pct(v) { return Math.round(num(v, 0) * 1000) / 10 + '%'; }
  function itemName(id) { return (D.itemName && D.itemName(id)) || id; }
  // 体量很小的建节点工具：ui.js 的同名助手是私有的，这里只做「建节点 + 填 html」这一件事
  function el(tag, cls, html) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (html != null) n.innerHTML = html;
    return n;
  }
  function toast(msg) { if (window.UI && window.UI.toast) window.UI.toast(msg); }
  function refresh() { if (window.UI && window.UI.refreshAll) window.UI.refreshAll('house'); }
  function held(id) { const st = S(); return num(st && st.inventory && st.inventory[id], 0); }

  // ---- 结构签名：只包含「会改变 DOM 结构」的量 --------------------------------------------------
  // 绝不包含 hours / pending 这类纯数据 —— 每竿一次的 assets 广播必须原地更新，不能重建渔屋页。
  function sigOf(h) {
    if (!h) return 'none';
    const st = h.steal || {};
    return JSON.stringify([h.level, h.endless, h.prestige, h.pets || {}, h.roles || {}, h.stationed || [],
      h.nextCost || null, h.renovateCost || null, h.capacityHours, [st.picksLeft, st.picksMax, st.coinUsed, st.heat]]);
  }

  // ---- 三条养成线的加成（与服务端同一条公式：宠物 + 厨师，Lv5 解锁、Lv5~7 只生效 50%）----
  function bonusOf(h, c) {
    const pets = h.pets || {}, roles = h.roles || {};
    let affinity = 0;
    Object.keys(pets).forEach(function (k) { affinity += num(pets[k], 0); });
    const level = num(h.level, 1);
    const pet = Math.min(affinity * num(c.petPerLevel, 0), num(c.petBonusCap, 0));
    const role = Math.min(num(roles.cook, 0) * num(c.rolePerPoint, 0), num(c.roleBonusCap, 0));
    const unlocked = level >= num(c.bonusUnlockLevel, 5);
    const half = unlocked && level <= num(c.bonusHalfUntilLevel, 7);
    const scale = !unlocked ? 0 : (half ? 0.5 : 1);
    return { level: level, pet: pet, role: role, scale: scale, unlocked: unlocked, half: half, total: (pet + role) * scale };
  }
  // 每只宠物的亲和上限 / 每个方向的上限都能从 HUT 推导，不另写死数字
  function affinityMax(c) { return num(c.petPerLevel, 0) > 0 ? Math.round(num(c.petBonusCap, 0) / num(c.petPerLevel, 0)) : 0; }
  function trackMax(c) { return num(c.rolePerPoint, 0) > 0 ? Math.round(num(c.roleBonusCap, 0) / num(c.rolePerPoint, 0)) : 0; }
  // 驻守栏位：Lv5 开放第 1 个、Lv8 开放第 2 个（数值成长曲线重做方案 §3）。
  // 这里只做展示，真实上限由服务端 house_pet_slot 拒绝码裁决；服务端 View 带 slots 时以它为准。
  function petSlots(h, c) {
    if (h.slots != null) return num(h.slots, 0);
    const level = num(h.level, 1), max = num(c.petSlots, 2);
    return Math.min(max, level >= 8 ? 2 : level >= 5 ? 1 : 0);
  }
  // 升级/翻新价格：优先用服务端 View（含无尽层随 R 变化的部分），缺失时按 D.HUT 现算
  function nextCostOf(h, c) {
    const level = num(h.level, 1), costs = c.upgradeCosts || [];
    if (level >= costs.length) return null;
    return costs[level - 1] || null;
  }
  function renovateCostOf(h, c) {
    const r = c.renovateCost || {};
    const n = Math.max(1, num(h.endless, 0) + 1);
    return {
      coins: Math.round(num(r.coins, 0) * Math.pow(num(r.coinsGrowth, 1), n - 1)),
      items: Object.assign({}, r.stormRelic ? { storm_relic: num(r.stormRelic, 0) } : {},
        r.alloyPerLevel ? { gear_alloy: num(r.alloyPerLevel, 0) * n } : {}),
    };
  }
  function costHtml(cost) {
    if (!cost) return '<span class="hint">已经满级</span>';
    const parts = ['<span data-house-cost="coins">💰 ' + money(cost.coins) + ' <small>（持有 ' + money(num(S().player && S().player.coins, 0)) + '）</small></span>'];
    Object.keys(cost.items || {}).forEach(function (id) {
      parts.push('<span>' + esc(itemName(id)) + ' ×' + money(cost.items[id]) + ' <small>（持有 ' + money(held(id)) + '）</small></span>');
    });
    return parts.join('');
  }

  // ---- 幂等请求键（照抄 expedition.js:14-41 的约定：客户端生成并持久化，重试复用同一个 key）----
  let busy = false, pending = null;
  try { pending = JSON.parse(sessionStorage.getItem('fishing-house-pending') || 'null'); } catch (_) { pending = null; }
  function keyFor(signature) {
    if (!pending || pending.signature !== signature) {
      const rand = (window.crypto && window.crypto.randomUUID)
        ? window.crypto.randomUUID()
        : Date.now() + '-' + Math.random().toString(36).slice(2);
      pending = { signature: signature, key: 'house-' + rand };
    }
    try { sessionStorage.setItem('fishing-house-pending', JSON.stringify(pending)); } catch (_) { /* 忽略 */ }
    return pending.key;
  }
  function dropKey() { pending = null; try { sessionStorage.removeItem('fishing-house-pending'); } catch (_) { /* 忽略 */ } }

  function setMessage(host, text) {
    const n = host && host.querySelector('[data-house-message]');
    if (n) n.textContent = text || '';
  }
  function setBusy(host, on) {
    if (!host) return;
    host.querySelectorAll('[data-house-action]').forEach(function (b) {
      if (on) b.setAttribute('aria-busy', 'true');
      else b.removeAttribute('aria-busy');
    });
  }
  // 一次写操作：action ∈ collect|upgrade|renovate|pet|role|steal；signature 相同则复用同一个 requestKey
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
          // 成功：直接用响应里的权威视图重绘（result 里的 status/resourceId 由服务端负责，前端不解析）
          const text = okText || '已生效';
          setMessage(host, text);
          toast(text);
          refresh();
        } else {
          // 4xx：这次操作没有被受理，未决键立刻作废（否则网络抖动后的重试会被 request_key_conflict 挡住）
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

  // ---- 好友列表（偷取目标）：复用既有 /api/friends，不新建好友系统 ----
  let friends = null, friendsAt = 0, friendsLoading = false;
  function loadFriends(host) {
    if (friendsLoading || !window.Net || !window.Net.fetchFriends) return;
    friendsLoading = true;
    Promise.resolve(window.Net.fetchFriends('', 1)).then(function (r) {
      friendsLoading = false;
      if (r && r.ok && r.data) { friends = r.data.friends || []; friendsAt = Date.now(); }
      drawFriends(host);
    }).catch(function () { friendsLoading = false; drawFriends(host); });
  }
  function friendsHtml(h, c) {
    if (!friends) return '<p class="hint">正在载入好友…</p>';
    if (!friends.length) return '<p class="hint">还没有好友。加好友后就能互相偷「溢出晒场」，被偷的一方也不会掉收益。</p>';
    const pick = Math.min(num(c.stealPerLevel, 0) * num(h.level, 1), num(c.stealPerPickCap, 0));
    return '<div class="exp-routes">' + friends.map(function (f) {
      const name = f.username || f.name || f.id || '';
      return '<article class="exp-route"><h4>' + esc(f.name || name) + ' <small>' + (f.online ? '在线' : '离线') + '</small></h4>' +
        '<p class="hint">可偷 ' + money(pick) + ' 金币 + 1 个普通鱼饵材料（按对方渔屋 Lv' + num(h.level, 1) + ' 计算）</p>' +
        '<button class="btn primary" data-house-action="steal" data-feature="character.steal" data-house-target="' + esc(name) + '">偷取</button></article>';
    }).join('') + '</div>';
  }
  function drawFriends(host) {
    const box = host && host.querySelector('[data-house-friends]');
    if (!box) return;
    box.innerHTML = friendsHtml(house() || {}, cfg());
    if (!friends) loadFriends(host);
  }

  function bonusHtml(b, c) {
    const state = !b.unlocked
      ? '渔屋 Lv' + num(c.bonusUnlockLevel, 5) + ' 才解锁加成（现在投入只影响渔屋本身的速率）'
      : (b.half ? 'Lv5~Lv7 期间加成只生效 50%' : '加成已全额生效');
    return '<h3>🧬 养成加成</h3>' +
      '<div class="exp-metrics"><b>合计 +' + pct(b.total) + '</b>' +
      '<span>宠物 +' + pct(b.pet) + '（上限 ' + pct(c.petBonusCap) + '）</span>' +
      '<span>厨师 +' + pct(b.role) + '（上限 ' + pct(c.roleBonusCap) + '）</span></div>' +
      '<p class="hint">三条养成线（渔屋 / 宠物 / 角色）只作用于渔屋自己的产出，不进入钓速、上鱼率、掉落与词缀。' + state + '。</p>';
  }

  function renderYard(host, h) {
    const c = cfg();
    const capacity = num(h.capacityHours, num(c.capacityHours, 0));
    const hours = Math.max(0, num(h.hours, 0));
    const pendingCoins = Math.max(0, num(h.pending, 0));
    const many = num(h.level, 1) >= ((c.levels && c.levels.length) || 10);
    const cost = many ? (h.renovateCost || renovateCostOf(h, c)) : (h.nextCost || nextCostOf(h, c));
    const b = bonusOf(h, c);
    const msg = (host.querySelector('[data-house-message]') || {}).textContent || '';
    const steal = h.steal || {};
    const box = el('div', 'hut-panel');
    box.innerHTML =
      '<h3>🏠 晒场</h3>' +
      '<p class="hint">离线时晒场自动攒金币：<b>单次最多结算 ' + capacity + ' 小时</b>、<b>领取次数不限</b>' +
      '（一天只有 24 小时，这就是天然上限；金币本身没有硬锁，投入多少就按速率产出多少）。</p>' +
      '<div class="exp-metrics"><b>Lv' + num(h.level, 1) + ' 渔屋</b>' +
      '<span data-house-rate>' + money(num(h.rate, 0)) + ' 金币/小时</span>' +
      '<span>晒场容量 ' + capacity + ' 小时</span>' +
      '<span data-house-hours>已积累 ' + hours.toFixed(1) + ' 小时</span>' +
      '<span data-house-pending>待领取 ' + money(pendingCoins) + ' 金币</span>' +
      (num(h.endless, 0) ? '<span>无尽翻新 R' + num(h.endless, 0) + '</span>' : '') +
      (num(h.prestige, 0) ? '<span>声望 ' + num(h.prestige, 0) + '</span>' : '') + '</div>' +
      '<div class="exp-actions">' +
      '<button class="btn primary" data-house-action="collect" data-feature="character.collect"' + (pendingCoins > 0 ? '' : ' disabled') + '>' +
      (pendingCoins > 0 ? '领取 ' + money(pendingCoins) + ' 金币' : '还没有可领取的鱼干') + '</button>' +
      '<span class="hint">' + (hours >= capacity ? '晒场已满，再离线也不会多攒。' : '距晒场满池还有 ' + Math.max(0, capacity - hours).toFixed(1) + ' 小时。') + '</span></div>' +
      bonusHtml(b, c) +
      '<h3>' + (many ? '♾ 无尽翻新' : '⬆ 渔屋升级') + '</h3>' +
      '<p class="hint">' + (many
        ? '无尽层用指数渐近线逼近 ' + money(num(c.asymptoteRate, 0)) + '/小时：每级都有正收益，但数学上永远追不到上限（边际收益递减）。'
        : '升级只提高每小时产出，晒场容量与领取次数不变；消耗以「当前没有配方消耗」的风暴遗物为主。') + '</p>' +
      '<div class="exp-metrics">' + costHtml(cost) + '</div>' +
      '<div class="exp-actions"><button class="btn primary" data-house-action="' + (many ? 'renovate' : 'upgrade') +
      '" data-feature="character.upgrade">' + (many ? '投入 1 级无尽翻新' : '升级到 Lv' + (num(h.level, 1) + 1)) + '</button></div>' +
      '<h3>🕵 好友偷取</h3>' +
      '<p class="hint">偷的是好友的「溢出晒场」：<b>不扣原主收益</b>。每对好友每天 1 次、每天最多 ' + num(c.stealPicksPerDay, 0) +
      ' 次（商人方向 / 声望可提升）；单次 min(对方渔屋 Lv × ' + num(c.stealPerLevel, 0) + ', ' + num(c.stealPerPickCap, 0) +
      ') 金币 + 1 个普通鱼饵材料；偷取金币另有 ' + money(c.stealDailyCoinCap) + '/天 的独立上限。需要好友关系满 ' +
      num(c.relationshipMinHours, 24) + ' 小时。</p>' +
      (steal.picksMax != null ? '<div class="exp-metrics"><b data-house-steal-count>今日剩余 ' + num(steal.picksLeft, 0) + ' / ' + num(steal.picksMax, 0) + ' 次</b>' +
        '<span>偷取金币 ' + money(steal.coinUsed) + ' / ' + money(steal.coinCap) + '</span>' +
        (steal.heat != null ? '<span>晒场热度 ' + num(steal.heat, 0) + '</span>' : '') + '</div>' : '') +
      '<div data-house-friends></div>' +
      '<p role="status" class="hint" data-house-message>' + esc(msg) + '</p>';
    host.appendChild(box);
    drawFriends(host);
  }

  function renderPet(host, h) {
    const c = cfg();
    const pets = h.pets || {};
    const stationed = (h.stationed || []).slice();
    // 展示用栏位数：服务端还没上报 slots 时按 Lv5 / Lv8 推算，至少不低于「已经在驻守的宠物数」
    const slots = Math.max(petSlots(h, c), stationed.length);
    const max = affinityMax(c);
    const bonus = bonusOf(h, c);
    const msg = (host.querySelector('[data-house-message]') || {}).textContent || '';
    const box = el('div', 'hut-panel');
    box.innerHTML =
      '<h3>🐶 宠物驻守</h3>' +
      '<p class="hint">喂「普通鱼饵材料」提升亲和：每级 +' + pct(c.petPerLevel) + ' 渔屋速率，每只上限 ' + max +
      ' 级（满亲和 ' + pct(c.petBonusCap) + '）。驻守栏位：Lv' + num(c.bonusUnlockLevel, 5) + ' 开放第 1 个、Lv8 开放第 2 个，' +
      '最多同时驻守 ' + num(c.petSlots, 2) + ' 只；驻守只决定「溢出晒场」掉落的材料倾向，不影响原主收益。</p>' +
      '<div class="exp-metrics"><b>驻守 ' + stationed.length + ' / ' + slots + '</b>' +
      '<span>宠物加成 +' + pct(bonus.pet) + '</span><span>渔屋 Lv' + num(h.level, 1) + '</span></div>' +
      '<div class="exp-routes">' + PETS.map(function (p) {
        const id = p[0], affinity = num(pets[id], 0), on = stationed.indexOf(id) >= 0;
        return '<article class="exp-route" data-pet-card="' + id + '">' +
          '<h4>' + esc(p[1]) + ' <small>亲和 ' + affinity + ' / ' + max + (on ? ' · 驻守中' : '') + '</small></h4>' +
          '<img src="assets/ui/char/dog_' + id + '.png" alt="" draggable="false" style="width:72px;height:56px;object-fit:contain;image-rendering:pixelated" onerror="__imgFail(this)">' +
          '<div class="exp-actions">' +
          '<button class="btn mini" data-house-action="pet" data-pet-id="' + id + '" data-pet-op="feed" data-feature="character.pet">喂养</button>' +
          '<button class="btn mini" data-house-action="pet" data-pet-id="' + id + '" data-pet-op="' + (on ? 'unstow' : 'station') + '" data-feature="character.pet">' +
          (on ? '收起' : '驻守') + '</button></div></article>';
      }).join('') + '</div>' +
      '<p class="hint">喂养消耗按服务端 HUT 材料白名单扣除（' +
      esc((c.materialWhitelist || []).map(itemName).join(' / ') || '普通鱼饵材料') + '），同一操作重放不会重复扣除。</p>' +
      '<p role="status" class="hint" data-house-message>' + esc(msg) + '</p>';
    host.appendChild(box);
  }

  function renderRole(host, h) {
    const c = cfg();
    const roles = h.roles || {};
    const max = trackMax(c);
    const totalMax = num(c.rolePointsMax, 0);
    let used = 0;
    Object.keys(roles).forEach(function (k) { used += num(roles[k], 0); });
    const msg = (host.querySelector('[data-house-message]') || {}).textContent || '';
    const box = el('div', 'hut-panel');
    box.innerHTML =
      '<h3>🧍 角色养成</h3>' +
      '<p class="hint">三个方向共用 ' + totalMax + ' 点（每方向上限 ' + max + ' 点）。只有<b>厨师</b>直接提高鱼干售价（渔屋速率），' +
      '腌制师与商人作用于声望兑换与社交额度 —— 所以渔屋速率的总加成最多是宠物 ' + pct(c.petBonusCap) + ' + 厨师 ' + pct(c.roleBonusCap) + '。</p>' +
      '<div class="exp-metrics"><b>已分配 ' + used + ' / ' + totalMax + ' 点</b>' +
      '<span>厨师 +' + pct(Math.min(num(roles.cook, 0) * num(c.rolePerPoint, 0), num(c.roleBonusCap, 0))) + '</span>' +
      '<span>腌制师 ' + num(roles.brine, 0) + ' 点</span><span>商人 ' + num(roles.trader, 0) + ' 点</span></div>' +
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

  // ---- 事件：一个委托监听器挂在宿主上（宿主在 fill 路径下不会被替换）----
  function onAction(host, btn) {
    const action = btn.getAttribute('data-house-action');
    // 功能开关的拦截由 ui.js 在 document 捕获阶段按 [data-feature] 统一完成（同其他页面），这里不再重复判一次
    if (action === 'collect') send(host, 'collect', {}, '晒场入账 ' + money((house() || {}).pending) + ' 金币');
    else if (action === 'upgrade') send(host, 'upgrade', {}, '渔屋升级完成');
    else if (action === 'renovate') send(host, 'renovate', {}, '无尽翻新完成');
    else if (action === 'pet') {
      const id = btn.getAttribute('data-pet-id'), op = btn.getAttribute('data-pet-op');
      // 字段名跟当前 Go 侧一致（legacy_house.go 的 petAction）；契约 §4 写的是 action，两边只认一个，改动要成对
      send(host, 'pet', { petId: id, petAction: op }, op === 'feed' ? '亲和提升' : (op === 'station' ? '已驻守' : '已收起'));
    } else if (action === 'role') send(host, 'role', { track: btn.getAttribute('data-track'), points: 1 }, '方向点数已投入');
    else if (action === 'steal') send(host, 'steal', { target: btn.getAttribute('data-house-target') }, '偷取成功');
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
      host.appendChild(el('div', 'hint', '正在读取渔屋状态…'));
      ensureLoad();
      return;
    }
    if (tab === 'pet') renderPet(host, h);
    else if (tab === 'role') renderRole(host, h);
    else renderYard(host, h);
  }
  // 就地更新（ui.js 的签名没变时不重建 DOM）：只改纯数据的文本，按钮可用态随之刷新
  function fill(host, tab) {
    const h = house();
    if (!host || !h || tab !== 'yard' || !host.querySelector('[data-house-pending]')) return false;
    const capacity = num(h.capacityHours, num(cfg().capacityHours, 0));
    const hours = Math.max(0, num(h.hours, 0));
    const pendingCoins = Math.max(0, num(h.pending, 0));
    const set = function (sel, text) { const n = host.querySelector(sel); if (n) n.textContent = text; };
    set('[data-house-rate]', money(num(h.rate, 0)) + ' 金币/小时');
    set('[data-house-hours]', '已积累 ' + hours.toFixed(1) + ' 小时');
    set('[data-house-pending]', '待领取 ' + money(pendingCoins) + ' 金币');
    const btn = host.querySelector('[data-house-action="collect"]');
    if (btn) {
      btn.textContent = pendingCoins > 0 ? '领取 ' + money(pendingCoins) + ' 金币' : '还没有可领取的鱼干';
      if (pendingCoins > 0) btn.removeAttribute('disabled'); else btn.setAttribute('disabled', 'disabled');
    }
    if (friends && Date.now() - friendsAt > 60000) { friends = null; drawFriends(host); }
    if (h.steal && h.steal.picksMax != null) {
      const m = host.querySelector('[data-house-steal-count]');
      if (m) m.textContent = '今日剩余 ' + num(h.steal.picksLeft, 0) + ' / ' + num(h.steal.picksMax, 0) + ' 次';
    }
    return true;
  }

  window.HouseUI = { render: render, fill: fill, sig: sigOf, PETS: PETS, errors: errors };
})();

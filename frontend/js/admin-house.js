/*
 * 后台「渔屋配置」页。
 *
 * 为什么是独立文件：渔屋是「全量配置 + 玩家进度」混合页，形态与 admin-gear.js 完全同构，
 * 单开一个 IIFE（而不是往 admin.js 里再塞几百行）才能让运营页和主控制器各自保持可读。
 *
 * 三条与其它配置页共享的纪律：
 *  1. 数值只走 catalog 发布链：POST /api/admin/house/config 带 expectedRevision，
 *     服务端在同一事务里改 Constants.HUT、跑 ValidateHut、写 admin_audit，冲突回 409。
 *  2. 本地校验只是预检，镜像是服务端 ValidateHut 的九条断言；最终以服务端为准。
 *  3. 变更摘要复用 window.AdminEdit（缺少该文件时面板照常可保存，只是不显示摘要）。
 */
(function () {
  'use strict';
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const D = window.GameData;
  const E = window.AdminEdit;
  // crypto.randomUUID 只在安全上下文可用；HTTP 打开的运营后台里会直接抛异常
  const key = () => 'house-admin-' + (crypto.randomUUID ? crypto.randomUUID() : Date.now() + '-' + Math.random().toString(36).slice(2));
  const itemName = id => (D && D.itemName ? D.itemName(id) : id);
  const materials = () => { try { return D ? D.allItems().filter(i => i.kind === 'material') : []; } catch (_) { return []; } };
  const round = v => String(Math.round(v * 100) / 100);
  // 服务端拒绝码 → 中文（与 admin-operations.js / admin-mail.js 同风格；未命中就显示原始码，绝不吞掉）
  const LOG = {
    catalog_revision_changed: '渔屋配置已被其他人修改，请重新进入本页后再编辑。',
    invalid_input: '输入不符合要求，请检查速率、容量、次数与材料数量。',
    request_key_conflict: '该操作已经提交过，请重新发起（不会重复结算）。',
    retry_same_request: '连接未完成，请用相同操作重试；同一请求不会重复发放。',
    admin_required: '当前账号没有管理员权限，请重新登录。',
    unknown_op: '不支持的操作。',
    feature_disabled: '渔屋功能已关闭，结算与偷取都会被拒绝。',
    house_level_max: '渔屋已满级，请改用无尽翻新。',
    house_material_insufficient: '升级材料不足。',
    house_coin_insufficient: '金币不足。',
    house_not_friend: '只能偷取好友的晒场。',
    house_friend_too_new: '好友关系满 24 小时后才能偷取。',
    house_steal_limit: '今日偷取次数已用完。',
    house_steal_pair_limit: '今天已经偷过这位好友了。',
    house_steal_daily_cap: '今日偷取金币已达上限。',
    house_steal_empty: '对方的晒场还没攒下可以偷的收益。',
    house_target_missing: '找不到这位玩家。',
  };
  const error = r => LOG[(r && r.data && r.data.error)] || ((r && r.data && r.data.error) || '请求未完成，请重试');
  // 字段名 → 中文（变更摘要与预检提示共用）
  const title = {
    levels: '等级曲线', capacityHours: '晒场容量（小时）', asymptoteRate: '无尽渐近线（金/小时）', endlessTau: '渐近速度',
    petPerLevel: '宠物每级亲和加成', petBonusCap: '宠物加成上限', petSlots: '驻守栏位',
    rolePerPoint: '角色每点加成', roleBonusCap: '角色加成上限', rolePointsMax: '角色点数上限',
    bonusUnlockLevel: '加成解锁等级', bonusHalfUntilLevel: '半效截止等级',
    stealPerLevel: '偷取每级基数', stealPerPickCap: '偷取单次上限', stealDailyCoinCap: '偷取每日金币上限',
    stealPicksPerDay: '偷取每日次数', relationshipMinHours: '好友关系门槛（小时）',
    upgradeCosts: '升级阶梯', renovateCost: '无尽翻新消耗', materialWhitelist: '材料白名单',
    coins: '金币', items: '材料', coinsGrowth: '金币增长率', stormRelic: '风暴遗物', alloyPerLevel: '强化合金/级',
  };
  // [路径, 名称, 最小值, 步长]；顺序即表单顺序。
  // 后台不设上限：这里不渲染 max，只保留下限与步长；服务端 ValidateHut 同样只校验下限
  // 与结构（容量 ≥ 1 小时、曲线单调、渐近线不低于满级、偷取参数自洽、材料白名单）。
  const BASIC = [
    // endlessTau 用 step="any"：min 一旦设成非 0 值，HTML 的 step 基准就变成 min，
    // 会把这类的正常取值（如 0.001 + 0.5k）之外的默认值 10 判成「步长不匹配」，整张表单提交不了。
    ['capacityHours', 1, '0.5'], ['asymptoteRate', 1, '1'], ['endlessTau', 0.001, 'any'],
    ['bonusUnlockLevel', 1, '1'], ['bonusHalfUntilLevel', 0, '1'],
    ['petPerLevel', 0, '0.005'], ['petBonusCap', 0, '0.01'], ['petSlots', 1, '1'],
    ['rolePerPoint', 0, '0.005'], ['roleBonusCap', 0, '0.01'], ['rolePointsMax', 0, '1'],
    ['stealPerLevel', 0, '1'], ['stealPerPickCap', 0, '1'], ['stealDailyCoinCap', 0, '1'],
    ['stealPicksPerDay', 0, '1'], ['relationshipMinHours', 24, '1'],
  ];
  const RENOVATE = [['coins', 0, '1'], ['coinsGrowth', 1, '0.01'], ['stormRelic', 0, '1'], ['alloyPerLevel', 0, '1']];

  function input(path, n, step) { return '<input aria-label="' + esc(path) + '" type="number" step="' + step + '" data-path="' + esc(path) + '" value="' + n + '" required>'; }
  // 只写 min / step：后台不设上限，浏览器不再按 max 拦人，服务端也不再按上限拒绝发布。
  function numField(path, name, n, min, step) { return '<label>' + esc(name) + '<input aria-label="' + esc(path) + '" type="number" min="' + min + '" step="' + step + '" data-path="' + esc(path) + '" value="' + n + '" required></label>'; }
  function matOptions(id) {
    const list = materials(), seen = list.some(m => m.id === id);
    return (seen || !id ? list : list.concat([{ id: id, name: itemName(id) }]))
      .map(m => '<option value="' + esc(m.id) + '"' + (m.id === id ? ' selected' : '') + '>' + esc(m.name) + '</option>').join('');
  }
  function itemRow(id, n) { return '<div class="ops-row" data-material><select data-material-id>' + matOptions(id) + '</select><input aria-label="材料数量" type="number" min="0" step="1" data-amount value="' + n + '" required><button type="button" data-remove>移除</button></div>'; }
  function itemRows(path, items) { return '<div class="gear-cost-items" data-items="' + esc(path) + '">' + Object.entries(items || {}).map(([id, n]) => itemRow(id, n)).join('') + '</div><button type="button" data-add-item="' + esc(path) + '">添加材料</button>'; }
  function setAt(obj, path, value) { const bits = path.split('.'), last = bits.pop(); let at = obj; for (const b of bits) at = at[b]; at[last] = value; }

  /** 本地预检：逐条镜像服务端 ValidateHut 的九条断言，把最常见的越线在提交前拦住 */
  function validate(h) {
    const p = [], add = (path, msg) => p.push({ path, msg });
    const L = h.levels || [];
    if (L.length !== 10) add('levels', '等级曲线必须正好 10 级（当前 ' + L.length + '）');
    else L.forEach((v, i) => {
      if (!(v > 0)) add('levels.' + i, 'Lv' + (i + 1) + ' 速率必须大于 0');
      else if (i && v < L[i - 1]) add('levels.' + i, '不能低于上一级（必须单调不减）');
    });
    // 后台不设上限：容量只保留下限，速率与加成也不再按 3,190 / 5% 线预检拦截；
    // 越线只会在「试算占比」里提示，不再阻止保存。
    if (!(h.capacityHours >= 1)) add('capacityHours', '需不小于 1 小时');
    if (!(h.endlessTau > 0)) add('endlessTau', '必须大于 0');
    if (!(h.asymptoteRate >= L[9])) add('asymptoteRate', '不能低于满级速率 ' + round(L[9] || 0) + '（否则翻新会降速）');
    if (!(h.stealPerPickCap * h.stealPicksPerDay >= h.stealDailyCoinCap)) add('stealDailyCoinCap', '「单次上限 × 每日次数」必须不小于每日上限，否则参数自相矛盾');
    if (!(h.relationshipMinHours >= 24)) add('relationshipMinHours', '好友关系门槛不得低于 24 小时（防小号互刷）');
    const costs = h.upgradeCosts || [];
    if (costs.length !== 9) add('upgradeCosts', '升级阶梯必须正好 9 级（当前 ' + costs.length + '）');
    else costs.forEach((c, i) => Object.keys((c && c.items) || {}).forEach(id => {
      if (!(h.materialWhitelist || []).includes(id)) add('upgradeCosts.' + i + '.items', '「' + itemName(id) + '」不在材料白名单内，服务端会拒绝发布');
    }));
    if (!(h.petSlots >= 1)) add('petSlots', '至少 1 个驻守栏位');
    if (!(h.rolePointsMax >= 0)) add('rolePointsMax', '不能为负');
    return p;
  }

  function invariantsHTML(list) {
    if (!Array.isArray(list) || !list.length) return '';
    return '<div class="gear-metrics" data-invariants>' + list.map(x =>
      '<span class="tag" title="' + esc(x.detail || '') + '">' + (x.ok ? '✅ ' : '⛔ ') + esc(x.name) + '</span>').join('') + '</div>';
  }
  function simHTML(data) {
    const phases = data.phases || [];
    // 参考线不再是写死的 3,400：它是「后期基准日收入的 5%」，随目录与材料售价一起变。
    const late = phases.find(p => p.stage === 'late');
    const limit = late && late.baseline ? Math.round(late.baseline / 20) : null;
    const rows = phases.map(p => '<tr><td>' + esc(p.stage) + '</td><td>' + p.daily + '</td><td>' + p.baseline + '</td>'
      + '<td>' + round(p.perCast || 0) + '（材料 ' + round(p.materialPerCast || 0) + '）</td>'
      + '<td>' + round(p.pct) + '%</td><td>' + (p.ok ? '✅ 通过' : '⛔ 越线') + '</td></tr>').join('');
    const bad = (data.violations || []);
    return '<div class="gear-card"><h4>试算结果（不会写入）</h4>'
      + '<p class="hint">基准日收入 = 该阶段每日可卖物期望（<strong>鱼 + 可售材料</strong>，按当前目录的池权重与售价折算）× 竿数：前期 400 竿（tier1 钓点）、中期 800 竿（tier3）、后期 800 竿（tier5）；'
      + '材料售价或掉落权重变化会同步抬高基准。后期满无尽 + 偷取合计 ' + (data.endlessTotal != null ? data.endlessTotal : '—') + ' 金币/天'
      + (limit != null ? '（参考线 ' + limit + ' = 后期基准日收入的 5%）。' : '。') + '</p>'
      + '<div class="scroll"><table class="tbl"><thead><tr><th>阶段</th><th>渔屋日收益</th><th>基准日收入</th><th>每竿期望（材料）</th><th>占比</th><th>结论</th></tr></thead><tbody>' + rows + '</tbody></table></div>'
      + (bad.length ? '<p class="gear-warning">' + bad.map(esc).join('；') + '（仅提示，不阻止保存）</p>' : '<p class="gear-notice">三条占比验收全部通过。</p>')
      + invariantsHTML(data.invariants) + '</div>';
  }
  function playerHTML(name, v) {
    const pets = Object.entries(v.pets || {}).map(([id, lv]) => esc(id) + ' 亲和 ' + lv).join('、') || '无';
    const roles = Object.entries(v.roles || {}).map(([id, n]) => esc(id) + ' ' + n + ' 点').join('、') || '无';
    const rackSlots = (v.rackSlots || []);
    const rackSummary = rackSlots.length === 0
      ? '空'
      : rackSlots.map(function (s) {
          return '位' + s.slotIdx + ':' + esc(s.fishId || '?') + (s.done ? '✅' : '⏳');
        }).join(' / ');
    return '<div class="gear-card"><h3>' + esc(name) + ' · 渔屋进度</h3>'
      + '<div class="gear-metrics"><span>等级<b>' + v.level + '</b></span><span>无尽<b>' + v.endless + '</b></span><span>声望<b>' + (v.prestige || 0) + '</b></span>'
      + '<span>晒架位<b>' + (v.rackCapacity || 0) + '</b></span><span>晒架状态<b>' + rackSummary + '</b></span></div>'
      + '<p class="hint">驻守：' + esc((v.stationed || []).join('、') || '无') + ' · 宠物：' + pets + ' · 角色：' + roles
      + ' · 偷取 ' + (v.steal ? (v.steal.picksLeft + '/' + v.steal.picksMax + ' 次，金币 ' + v.steal.coinUsed + '/' + v.steal.coinCap) : '—') + '</p>'
      + '<div class="ops-row"><input data-house-target hidden value="' + esc(name) + '">'
      + '<button data-house-op="reset">清空晒架计时</button>'
      + '<button data-house-op="freeze">冻结结算</button>'
      + '<button data-house-op="unfreeze">恢复结算</button>'
      + '<span role="status" data-player-status></span></div>'
      + '<p class="hint">清空只把结算时刻前推到「现在」（绝不提前发奖）；冻结期间晒架不再推进，恢复后从恢复时刻重新计时。</p></div>';
  }

  async function render(host, api, confirm) {
    host.innerHTML = '<section class="panel gear-system gear-admin house-admin"><h2>🏠 渔屋配置</h2><p>读取权威配置…</p></section>';
    const panel = host.firstElementChild;
    const r = await api('GET', '/api/admin/house');
    if (!panel.isConnected) return;
    if (!r.ok) { panel.textContent = error(r); return; }
    let cfg = r.data.config, revision = r.data.revision, inv = r.data.invariants;
    const form$ = () => panel.querySelector('[data-config]');
    const setStatus = (msg, bad) => panel.querySelectorAll('[data-status]').forEach(n => { n.textContent = msg; n.classList.toggle('err', !!bad); });
    let changed = [];

    function formHTML() {
      const h = cfg;
      return '<div class="gear-header"><div><span class="gear-eyebrow">全量配置 · 版本 ' + revision + '</span><h2>🏠 渔屋配置</h2></div></div>'
        + '<p class="hint">渔屋只有<strong>时间</strong>这一把锁：单次最多结算「晒场容量」小时，一天只有 24 小时，所以日上限 = 速率 × 24 × 加成；'
        + '金币没有硬上限、领取次数也不限。无尽翻新用渐近线逼近「渐近线速率」——每级都有正收益，但永远追不到。'
        + '后台配置<strong>不设数值上限</strong>：容量、速率、加成都能填任意大，5% 线只在「试算占比」里提示，不会阻止保存。</p>'
        + invariantsHTML(inv)
        + '<div class="gear-save"><button class="primary" type="submit" form="house-config" data-save>保存全部渔屋配置</button>'
        + '<button type="button" data-revert>撤销全部修改</button><button type="button" data-simulate>试算占比</button><span role="status" data-status></span></div>'
        + '<details class="gear-diff" data-diff-wrap><summary>待保存变更 <b data-diff-count>0</b> 项</summary>'
        + '<div class="scroll"><table class="tbl"><thead><tr><th>字段</th><th>当前</th><th>改为</th></tr></thead><tbody data-diff-list></tbody></table></div>'
        + '<p class="hint" data-diff-warn></p><p class="hint">只有点「保存」后才会生效；服务端会再跑一次 ValidateHut 并写审计。</p></details>'
        + '<form data-config id="house-config">'
        + '<details open><summary>成长通则 · 容量、渐近线与养成/偷取参数</summary><div class="gear-grid">'
        + BASIC.map(([k, lo, step]) => numField(k, title[k], h[k], lo, step)).join('') + '</div></details>'
        + '<details open><summary>等级曲线 · Lv1~Lv10 金币/小时</summary><div class="scroll gear-compact-table"><table><thead><tr><th>等级</th><th>金币/小时</th><th>满额度日收益（24h，不含加成）</th></tr></thead><tbody>'
        + (h.levels || []).map((v, i) => '<tr><td>Lv' + (i + 1) + '</td><td>' + input('levels.' + i, v, '0.01') + '</td><td>' + round(v * 24) + '</td></tr>').join('')
        + '</tbody></table></div><p class="hint">累计投入：每一级都只能提高速率，服务端要求单调不减。</p></details>'
        + '<details><summary>升级阶梯 · Lv1→Lv10 的金币与材料</summary><div class="gear-grid">'
        + (h.upgradeCosts || []).map((c, i) => '<section class="gear-card"><h4>Lv' + (i + 1) + ' → Lv' + (i + 2) + '</h4>'
          + '<div class="gear-grid">' + numField('upgradeCosts.' + i + '.coins', '金币', c.coins, 0, '1') + '</div>'
          + itemRows('upgradeCosts.' + i + '.items', c.items) + '</section>').join('') + '</div></details>'
        + '<details><summary>无尽翻新 · 每级金币按增长率递增</summary><div class="gear-grid">'
        + RENOVATE.map(([k, lo, step]) => numField('renovateCost.' + k, title[k], h.renovateCost[k], lo, step)).join('')
        + '</div><p class="hint">翻新只提高速率并抬高渐近线逼近速度，不改变 24 小时这条硬边界。</p></details>'
        + '<details><summary>材料白名单 · 升级消耗只允许出现在这里的材料</summary><div class="ops-grid">'
        + materials().map(m => '<label><input type="checkbox" data-whitelist="' + esc(m.id) + '"' + ((h.materialWhitelist || []).includes(m.id) ? ' checked' : '') + '>' + esc(m.name) + '</label>').join('')
        + '</div></details>'
        + '<div class="gear-save"><button class="primary" type="submit" data-save>保存全部渔屋配置</button><span role="status" data-status></span></div></form>'
        + '<div data-sim-box></div>'
        + '<hr><h3>玩家渔屋进度</h3><div class="ops-row"><input data-player-name placeholder="玩家登录名"><button type="button" data-player-load>查询玩家</button></div><div data-player-box></div>';
    }
    /** 从表单读回一份完整配置；格式问题走 problems 而不抛异常，避免摘要刷新被一个坏行打断 */
    function collect() {
      const form = form$(), next = structuredClone(cfg), problems = [];
      if (!form) return { next, problems };
      form.querySelectorAll('[data-path]').forEach(n => setAt(next, n.dataset.path, Number(n.value)));
      form.querySelectorAll('[data-items]').forEach(n => {
        const items = {};
        n.querySelectorAll('[data-material]').forEach(row => {
          const id = row.querySelector('[data-material-id]').value;
          if (id in items) problems.push({ path: n.dataset.items, msg: '同一项消耗里材料重复：' + itemName(id) });
          items[id] = Number(row.querySelector('[data-amount]').value);
        });
        setAt(next, n.dataset.items, items);
      });
      next.materialWhitelist = Array.from(form.querySelectorAll('[data-whitelist]:checked')).map(x => x.dataset.whitelist);
      return { next, problems };
    }
    function refresh() {
      const { next, problems } = collect();
      changed = E ? E.diff(cfg, next) : [];
      const cnt = panel.querySelector('[data-diff-count]'); if (cnt) cnt.textContent = String(changed.length);
      const list = panel.querySelector('[data-diff-list]');
      if (list) list.innerHTML = E ? E.rowsHTML(changed, title) : '<tr><td class="hint">未加载变更摘要组件</td></tr>';
      const warn = panel.querySelector('[data-diff-warn]');
      if (warn) warn.textContent = problems.map(p => p.msg).join('；');
      panel.querySelectorAll('[data-save]').forEach(n => { n.textContent = '保存全部渔屋配置' + (changed.length ? '（' + changed.length + ' 项变更）' : ''); });
      if (E) { E.clearMarks(form$()); E.markChanged(form$(), changed); }
      panel.querySelectorAll('[data-status].err').forEach(n => { n.textContent = ''; n.classList.remove('err'); });
    }
    const refreshSoon = E ? E.debounce(refresh, 150) : refresh;
    async function save(next) {
      panel.querySelectorAll('[data-save]').forEach(n => { n.disabled = true; });
      try {
        const res = await api('POST', '/api/admin/house/config', { config: next, expectedRevision: revision, requestKey: key() });
        if (!res.ok) { setStatus(error(res), true); return false; }
        const fresh = await api('GET', '/api/admin/house');
        if (fresh.ok) { cfg = fresh.data.config; revision = fresh.data.revision; inv = fresh.data.invariants; }
        return true;
      } finally { panel.querySelectorAll('[data-save]').forEach(n => { n.disabled = false; }); }
    }
    async function submit() {
      const { next, problems } = collect(), bad = [...problems, ...validate(next)];
      if (bad.length) {
        if (E) { E.clearMarks(form$()); const first = E.markInvalid(form$(), bad); if (first && first.scrollIntoView) first.scrollIntoView({ block: 'center' }); }
        setStatus('有 ' + bad.length + ' 项需要先修正：' + bad[0].msg, true);
        return;
      }
      if (await save(next)) { paint(); setStatus('已保存，版本 ' + revision + '。玩家端会拿到新的渔屋数值。'); }
    }
    async function simulate() {
      const { next } = collect(), box = panel.querySelector('[data-sim-box]');
      box.textContent = '试算中…';
      const res = await api('POST', '/api/admin/house/simulate', { config: next });
      if (!box.isConnected) return;
      box.innerHTML = res.ok ? simHTML(res.data) : '<p class="gear-warning">' + esc(error(res)) + '</p>';
    }
    async function loadPlayer() {
      const name = panel.querySelector('[data-player-name]').value.trim(), box = panel.querySelector('[data-player-box]');
      if (!name) { box.textContent = '请输入玩家登录名。'; return; }
      box.textContent = '查询中…';
      const res = await api('GET', '/api/admin/house?target=' + encodeURIComponent(name));
      if (!box.isConnected) return;
      if (!res.ok || !res.data.player) { box.textContent = error(res); return; }
      box.innerHTML = playerHTML(name, res.data.player);
      const status = box.querySelector('[data-player-status]'), v = res.data.player;
      const snapshot = { level: v.level, endless: v.endless, pets: v.pets || {}, roles: v.roles || {} };
      box.querySelectorAll('[data-house-op]').forEach(btn => {
        btn.onclick = async () => {
          const op = btn.dataset.houseOp;
          const label = op === 'reset' ? '清空该玩家已攒的晒场时长' : op === 'freeze' ? '冻结该玩家的渔屋结算' : '恢复该玩家的渔屋结算';
          if (!await confirm(label + '？')) return;
          status.textContent = '提交中…';
          const rr = await api('POST', '/api/admin/house/player?op=' + op, { target: name, requestKey: key(), before: snapshot, after: snapshot });
          status.textContent = rr.ok ? '已执行：' + (rr.data.result && rr.data.result.status || op) : error(rr);
          if (rr.ok) loadPlayer();
        };
      });
    }
    function paint() {
      panel.innerHTML = formHTML();
      const form = form$();
      panel.onclick = e => {
        const remove = e.target.closest('[data-remove]');
        if (remove) { remove.closest('[data-material]').remove(); refresh(); return; }
        const add = e.target.closest('[data-add-item]');
        if (add) {
          const box = Array.from(form.querySelectorAll('[data-items]')).find(x => x.dataset.items === add.dataset.addItem);
          const list = materials();
          box.insertAdjacentHTML('beforeend', itemRow(list.length ? list[0].id : '', 1));
          refresh();
        }
      };
      form.addEventListener('input', refreshSoon);
      form.addEventListener('change', refreshSoon);
      form.onsubmit = e => { e.preventDefault(); submit(); };
      panel.querySelector('[data-revert]').onclick = async () => {
        const { next } = collect(), n = E ? E.diff(cfg, next).length : 0;
        if (!n) { setStatus('当前没有未保存的修改。'); return; }
        if (!await confirm('放弃全部未保存的修改，恢复到已保存的版本 ' + revision + '？')) return;
        paint();
      };
      panel.querySelector('[data-simulate]').onclick = simulate;
      panel.querySelector('[data-player-load]').onclick = loadPlayer;
      refresh();
    }
    paint();
  }
  window.AdminHouse = { render };
})();

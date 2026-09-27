/* Browser preferences only; no account or gameplay mutations. */
window.PlayerSettings = (function () {
  'use strict';
  const KEY = 'fishing_preferences_v1';
  // v0.20：字号由「标准/大号」两档改为可拖动的百分比滑杆（90 ~ 140，步长 5）
  const defaults = { textScale: 100, font: 'pixel', motion: 'system', records: true, tips: 'all', theme: 'harbor',
    timeMode: 'clock', periods: { dawn: '05:00', day: '07:30', dusk: '17:30', night: '19:30' }, blend: 45, mobile: 'auto', signs: 'always', catchFlash: 'on' };
  const choices = { font: ['pixel', 'clear'], motion: ['system', 'full', 'reduced', 'off'], tips: ['all', 'brief'], theme: ['harbor'],
    timeMode: ['clock', 'dawn', 'day', 'dusk', 'night'], mobile: ['auto', 'panorama', 'compass'], signs: ['always', 'hover'], catchFlash: ['on', 'off'] };
  // 港湾时段验证：四段起始时间必须顺序排列，相邻间距 >= blend 分钟（与 harbor-art.js validPeriods 逻辑一致）。
  function toMinHhmm(s) { const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || '')); return m ? Math.min(23, +m[1]) * 60 + Math.min(59, +m[2]) : -1; }
  function validatePeriodOrder(p, blend) {
    const order = ['dawn', 'day', 'dusk', 'night'], n = ['清晨', '白天', '黄昏', '夜晚'];
    const m = order.map(function (k) { return toMinHhmm(p[k]); });
    if (m.some(function (v) { return v < 0; })) return '请输入有效的时间（HH:MM）';
    for (var i = 0; i < 3; i++) if (m[i + 1] - m[i] < blend) return '「' + n[i] + '」到「' + n[i + 1] + '」至少要隔 ' + blend + ' 分钟，且按清晨 → 白天 → 黄昏 → 夜晚排列';
    if (m[0] + 1440 - m[3] < blend) return '夜晚到次日清晨至少要隔 ' + blend + ' 分钟';
    return '';
  }
  const SCALE_MIN = 90, SCALE_MAX = 140, SCALE_STEP = 5;
  // 拖动条上的建议值：rec = 推荐档位（金色高亮 + 「建议」字样）
  const SCALE_MARKS = [
    { v: 90, label: '紧凑' },
    { v: 100, label: '标准', rec: true },
    { v: 115, label: '大号', rec: true },
    { v: 130, label: '特大' },
  ];
  const media = window.matchMedia('(prefers-reduced-motion: reduce)');
  let settings, dialog, status, resetBox, opener, scaleOut;
  function clampScale(value) {
    const n = Math.round(Number(value) / SCALE_STEP) * SCALE_STEP;
    if (!isFinite(n) || n === 0) return defaults.textScale;
    return Math.max(SCALE_MIN, Math.min(SCALE_MAX, n));
  }
  function validate(value) {
    const result = Object.assign({}, defaults);
    if (!value || typeof value !== 'object') return result;
    Object.keys(choices).forEach(function (key) { if (choices[key].includes(value[key])) result[key] = value[key]; });
    if (typeof value.records === 'boolean') result.records = value.records;
    if (value.textScale != null) result.textScale = clampScale(value.textScale);
    else if (value.textSize === 'large') result.textScale = 115;   // 旧存档迁移：大号 → 115%
    const BLEND_OK = [0, 30, 45, 60];
    if (value.blend != null && BLEND_OK.indexOf(+value.blend) >= 0) result.blend = +value.blend;
    if (value.periods && typeof value.periods === 'object') {
      const p = Object.assign({}, defaults.periods);
      ['dawn', 'day', 'dusk', 'night'].forEach(function (k) { if (/^\d{1,2}:\d{2}$/.test(String(value.periods[k] || ''))) p[k] = value.periods[k]; });
      if (!validatePeriodOrder(p, result.blend)) result.periods = p;
    }
    return result;
  }
  function read() {
    try { return validate(JSON.parse(localStorage.getItem(KEY))); } catch (_) { return validate(null); }
  }
  function motion() { return settings.motion === 'system' ? (media.matches ? 'reduced' : 'full') : settings.motion; }
  // 字号用等效浏览器缩放实现：整页文字与界面元素同比放大，100% 时完全不介入
  function paintScale(scale) {
    const root = document.documentElement;
    root.dataset.textScale = String(scale);
    root.style.setProperty('--text-scale', String(scale / 100));
    if (scaleOut) scaleOut.textContent = scale + '%';
  }
  function apply() {
    const root = document.documentElement;
    paintScale(settings.textScale);
    root.dataset.font = settings.font;
    root.dataset.motion = motion();
    root.dataset.records = String(settings.records);
    window.dispatchEvent(new CustomEvent('playersettingschange'));
    if (dialog) {
      dialog.querySelectorAll('[data-setting]').forEach(function (input) {
        const value = settings[input.dataset.setting];
        if (input.type === 'radio') input.checked = (input.value === value);
        else if (input.type === 'checkbox') input.checked = value;
        else input.value = value;
      });
      // 时段开始时间输入框（data-period，不走 data-setting 通道）
      dialog.querySelectorAll('[data-period]').forEach(function (input) {
        input.value = settings.periods[input.dataset.period] || '';
      });
      // 港湾时间区块仅在港湾主题下展示
      var htEl = dialog.querySelector('#settings-harbor-time');
      if (htEl) htEl.hidden = (settings.theme !== 'harbor');
      // 时段编辑区仅在「跟随本地时间」下可用
      var perEl = dialog.querySelector('#settings-periods');
      if (perEl) {
        var clockMode = settings.timeMode === 'clock';
        perEl.querySelectorAll('input[type=time]').forEach(function (i) { i.disabled = !clockMode; });
        perEl.querySelectorAll('select').forEach(function (i) { i.disabled = !clockMode; });
        perEl.querySelector('#settings-reset-periods').disabled = !clockMode;
      }
      var errEl = dialog.querySelector('#settings-harbor-err');
      if (errEl) errEl.textContent = '';
    }
  }
  function save() {
    apply();
    try {
      localStorage.setItem(KEY, JSON.stringify(settings));
      status.textContent = '已自动保存 · 仅对当前浏览器生效';
    } catch (_) { status.textContent = '已生效，但浏览器无法保存设置；刷新后可能恢复默认。'; }
  }
  function open() {
    if (dialog.open) return;
    opener = document.activeElement;
    resetBox.hidden = true;
    status.textContent = '修改立即生效，自动保存在当前浏览器。';
    dialog.showModal();
    dialog.querySelector('.settings-close').focus();
  }
  function scaleMarksHtml() {
    const span = SCALE_MAX - SCALE_MIN;
    return SCALE_MARKS.map(function (m, i) {
      const left = (m.v - SCALE_MIN) / span * 100;
      const edge = i === 0 ? ' first' : (m.v === SCALE_MAX ? ' last' : '');
      return '<span class="scale-mark' + (m.rec ? ' rec' : '') + edge + '" style="left:' + left + '%">' +
        '<b>' + m.v + '%</b><i>' + m.label + (m.rec ? ' · 建议' : '') + '</i></span>';
    }).join('');
  }
  function init() {
    dialog = document.createElement('dialog');
    dialog.id = 'settings-dialog';
    dialog.setAttribute('aria-labelledby', 'settings-title');
    dialog.innerHTML = '<div class="settings-head"><h2 id="settings-title">⚙ 基础设置</h2><button type="button" class="settings-close" aria-label="关闭设置">✕ 关闭</button></div>' +
      '<div class="settings-body"><p class="hint">按你的习惯调整阅读与显示效果。</p>' +
      '<div class="settings-row settings-row-scale"><span>字号大小<small>拖动即时预览，松手自动保存；整页文字与界面元素同比缩放，金色刻度是建议档位</small></span>' +
      '<div class="settings-scale"><output id="settings-scale-out" for="settings-scale" aria-live="polite">100%</output>' +
      '<input id="settings-scale" type="range" min="' + SCALE_MIN + '" max="' + SCALE_MAX + '" step="' + SCALE_STEP + '" value="' + defaults.textScale + '" data-setting="textScale" aria-label="字号大小（百分比）" />' +
      '<div class="settings-scale-marks" aria-hidden="true">' + scaleMarksHtml() + '</div></div></div>' +
      '<label class="settings-row"><span>界面字体<small>像素风格或清晰易读的系统字体</small></span><select data-setting="font"><option value="pixel">像素字体</option><option value="clear">清晰字体</option></select></label>' +
      '<div id="settings-harbor-time" class="settings-row settings-harbor-time"><span>港湾时间<small>场景色调随本地时钟变化，也可以固定在某个时段</small></span>' +
      '<div class="settings-harbor-time-body">' +
      '<div class="settings-harbor-modes">' +
      '<label><input type="radio" name="timeMode" value="clock" data-setting="timeMode"> 跟随本地时间</label>' +
      '<label><input type="radio" name="timeMode" value="dawn" data-setting="timeMode"> 🌅 固定清晨</label>' +
      '<label><input type="radio" name="timeMode" value="day" data-setting="timeMode"> ☀️ 固定白天</label>' +
      '<label><input type="radio" name="timeMode" value="dusk" data-setting="timeMode"> 🌇 固定黄昏</label>' +
      '<label><input type="radio" name="timeMode" value="night" data-setting="timeMode"> 🌙 固定夜晚</label>' +
      '</div>' +
      '<div id="settings-periods" class="settings-harbor-periods">' +
      '<label>🌅 清晨<input type="time" data-period="dawn"></label>' +
      '<label>☀️ 白天<input type="time" data-period="day"></label>' +
      '<label>🌇 黄昏<input type="time" data-period="dusk"></label>' +
      '<label>🌙 夜晚<input type="time" data-period="night"></label>' +
      '<label>过渡<select data-setting="blend"><option value="0">立即</option><option value="30">30 分钟</option><option value="45">45 分钟</option><option value="60">60 分钟</option></select></label>' +
      '<button type="button" class="btn-link" id="settings-reset-periods">恢复默认</button>' +
      '</div>' +
      '<p id="settings-harbor-err" role="alert" style="color:var(--danger,#f87171);font-size:12px;margin:4px 0 0;min-height:1em"></p>' +
      '</div></div>' +
      '<div class="sgrp"><b>手机布局<small>港湾在手机上的显示方式</small></b>' +
      '<label><input type="radio" name="mobile" value="auto" data-setting="mobile"> 自动（推荐）<small>横向全景；减少动效时改用罗盘首页</small></label>' +
      '<label><input type="radio" name="mobile" value="panorama" data-setting="mobile"> 横向全景</label>' +
      '<label><input type="radio" name="mobile" value="compass" data-setting="mobile"> 罗盘首页<small>条带 + 格子，省电</small></label>' +
      '</div>' +
      '<label class="settings-row"><span>场景动效<small>减少动效时保留钓鱼状态和进度</small></span><select data-setting="motion"><option value="system">跟随系统</option><option value="full">完整</option><option value="reduced">减少</option><option value="off">关闭装饰动画</option></select></label>' +
      '<label class="settings-row"><span>建筑招牌<small>场景里建筑上方的招牌文字何时显示</small></span><select data-setting="signs"><option value="always">始终显示</option><option value="hover">悬停 / 聚焦时显示</option></select></label>' +
      '<label class="settings-row"><span>钓获特效<small>钓到稀有 / 史诗 / 神话鱼时的全屏庆祝动画</small></span><select data-setting="catchFlash"><option value="on">开启</option><option value="off">关闭</option></select></label>' +
      '<label class="settings-row"><span>全服纪录播报<small>管理员公告仍会正常显示</small></span><input type="checkbox" data-setting="records" aria-label="显示全服纪录播报"></label>' +
      '<label class="settings-row"><span>普通操作提示<small>精简钓点切换、装备和列表刷新提示；保留错误和交易结果</small></span><select data-setting="tips"><option value="all">显示</option><option value="brief">精简</option></select></label>' +
      '<div class="settings-row settings-account"><span>账号<small>退出后回到登录页；钓鱼进度保存在服务器</small></span><button type="button" id="settings-logout">退出登录</button></div>' +
      '<p id="settings-status" role="status" aria-live="polite"></p>' +
      '<button type="button" id="settings-reset">恢复默认设置</button>' +
      '<div id="settings-reset-confirm" hidden><p>恢复以上设置为默认值？游戏进度和角色外观不受影响。</p><button type="button" id="settings-reset-yes">确认恢复</button> <button type="button" id="settings-reset-no">取消</button></div></div>';
    document.body.appendChild(dialog);
    status = dialog.querySelector('#settings-status');
    resetBox = dialog.querySelector('#settings-reset-confirm');
    scaleOut = dialog.querySelector('#settings-scale-out');
    document.getElementById('settings-btn').addEventListener('click', open);
    dialog.querySelector('.settings-close').addEventListener('click', function () { dialog.close(); });
    dialog.addEventListener('close', function () { if (opener && opener.isConnected) opener.focus(); });
    // 拖动过程中先只改缩放（不写存档、不广播），松手后的 change 再走统一保存
    dialog.addEventListener('input', function (event) {
      const input = event.target;
      if (!input.dataset || input.dataset.setting !== 'textScale') return;
      const scale = clampScale(input.value);
      input.value = scale;
      paintScale(scale);
    });
    dialog.addEventListener('change', function (event) {
      const input = event.target;
      // 时段开始时间（data-period）：独立验证，不通过 data-setting 通道
      if (input.dataset.period) {
        const period = input.dataset.period;
        const newPeriods = Object.assign({}, settings.periods, { [period]: input.value });
        const err = validatePeriodOrder(newPeriods, settings.blend);
        var errEl = dialog.querySelector('#settings-harbor-err');
        if (err) { if (errEl) errEl.textContent = err; input.value = settings.periods[period]; return; }
        if (errEl) errEl.textContent = '';
        settings = validate(Object.assign({}, settings, { periods: newPeriods }));
        save(); return;
      }
      const key = input.dataset.setting;
      if (!key) return;
      const rawVal = input.type === 'checkbox' ? input.checked : input.value;
      // blend 变化时也重新验证时段顺序
      if (key === 'blend') {
        const err = validatePeriodOrder(settings.periods, +rawVal);
        var errEl2 = dialog.querySelector('#settings-harbor-err');
        if (err) { if (errEl2) errEl2.textContent = err; input.value = settings.blend; return; }
        if (errEl2) errEl2.textContent = '';
      }
      settings = validate(Object.assign({}, settings, { [key]: rawVal }));
      save();
    });
    // 退出登录从顶栏收进设置：先关掉对话框（顶层 dialog 会盖住确认框），再走顶栏按钮上的原有登出流程
    dialog.querySelector('#settings-logout').addEventListener('click', function () {
      const logout = document.getElementById('logout-btn');
      opener = null;
      dialog.close();
      if (logout) logout.click();
    });
    dialog.querySelector('#settings-reset-periods').addEventListener('click', function () {
      settings = validate(Object.assign({}, settings, { periods: Object.assign({}, defaults.periods), blend: defaults.blend }));
      save();
    });
    dialog.querySelector('#settings-reset').addEventListener('click', function () { resetBox.hidden = false; dialog.querySelector('#settings-reset-no').focus(); });
    dialog.querySelector('#settings-reset-no').addEventListener('click', function () { resetBox.hidden = true; dialog.querySelector('#settings-reset').focus(); });
    dialog.querySelector('#settings-reset-yes').addEventListener('click', function () {
      settings = validate(null); save(); resetBox.hidden = true; dialog.querySelector('#settings-reset').focus();
    });
    apply();
  }
  settings = read();
  apply();
  media.addEventListener('change', apply);
  window.addEventListener('storage', function (event) { if (event.key === KEY || event.key === null) { settings = read(); apply(); } });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
  return {
    get: function () { return Object.assign({}, settings); },
    motion: motion, open: open,
    // 程序化改一项（港湾外壳切换界面风格、测试用）；不传值时沿用校验后的默认值
    set: function (key, value) { settings = validate(Object.assign({}, settings, { [key]: value })); if (status) save(); else apply(); },
  };
})();

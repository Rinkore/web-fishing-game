/* Browser preferences only; no account or gameplay mutations. */
window.PlayerSettings = (function () {
  'use strict';
  const KEY = 'fishing_preferences_v1';
  // v0.20：字号由「标准/大号」两档改为可拖动的百分比滑杆（90 ~ 140，步长 5）
  const defaults = { textScale: 100, font: 'pixel', motion: 'system', records: true, tips: 'all' };
  const choices = { font: ['pixel', 'clear'], motion: ['system', 'full', 'reduced', 'off'], tips: ['all', 'brief'] };
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
    if (dialog) dialog.querySelectorAll('[data-setting]').forEach(function (input) {
      const value = settings[input.dataset.setting];
      if (input.type === 'checkbox') input.checked = value; else input.value = value;
    });
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
      '<label class="settings-row"><span>场景动效<small>减少动效时保留钓鱼状态和进度</small></span><select data-setting="motion"><option value="system">跟随系统</option><option value="full">完整</option><option value="reduced">减少</option><option value="off">关闭装饰动画</option></select></label>' +
      '<label class="settings-row"><span>全服纪录播报<small>管理员公告仍会正常显示</small></span><input type="checkbox" data-setting="records" aria-label="显示全服纪录播报"></label>' +
      '<label class="settings-row"><span>普通操作提示<small>精简钓点切换、装备和列表刷新提示；保留错误和交易结果</small></span><select data-setting="tips"><option value="all">显示</option><option value="brief">精简</option></select></label>' +
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
      const input = event.target, key = input.dataset.setting;
      if (!key) return;
      settings = validate(Object.assign({}, settings, { [key]: input.type === 'checkbox' ? input.checked : input.value }));
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
  return { get: function () { return Object.assign({}, settings); }, motion: motion, open: open };
})();

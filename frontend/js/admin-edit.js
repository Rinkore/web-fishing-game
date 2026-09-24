/*
 * 后台「变更摘要」共用件。
 *
 * 为什么单独一个文件：装备与远航两个面板都是几百个输入框的巨型表单，
 * 运营最需要的不是更多字段，而是「我刚改了什么 / 会不会被服务端拒」。
 * 两个面板的校验规则各自不同（分别镜像 ValidateGear 与远征配置校验），
 * 所以这里只放**展示层**的共用逻辑：求差异、渲染差异、定位出错字段。
 * 缺少本文件时两个面板仍可正常保存，只是不显示变更摘要。
 */
(function () {
  'use strict';
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = v => (typeof v === 'number' ? String(Math.round(v * 1000) / 1000) : (v === undefined ? '（无）' : String(v)));

  /** 递归求差异。数组按下标逐项比较，好让「+4 从 7.6 变 8」这种改动能被看见。 */
  function diff(before, after, path, out) {
    out = out || []; path = path || '';
    const isPlain = v => v && typeof v === 'object' && !Array.isArray(v);
    const same = JSON.stringify(before) === JSON.stringify(after);
    if (same) return out;
    if (isPlain(before) && isPlain(after)) {
      const keys = Array.from(new Set([...Object.keys(before), ...Object.keys(after)]));
      const numeric = keys.every(k => /^\d+$/.test(k));
      if (numeric) keys.sort((a, b) => Number(a) - Number(b));
      for (const k of keys) diff(before[k], after[k], path ? path + '.' + k : k, out);
      return out;
    }
    if (Array.isArray(before) && Array.isArray(after)) {
      if (before.length !== after.length) {
        out.push({ path, a: before.length + ' 项', b: after.length + ' 项', structural: true });
        return out;
      }
      for (let i = 0; i < before.length; i++) diff(before[i], after[i], path + '.' + i, out);
      return out;
    }
    out.push({ path, a: before, b: after });
    return out;
  }

  /**
   * 把配置路径翻成人话。names 是「路径片段 → 中文」的映射（含部位/套装/专精/航线 id），
   * 数组下标的语义由 tail 决定：强化等级、阶段、或纯序号。
   */
  function describe(path, names) {
    const bits = String(path).split('.');
    const last = bits.pop();
    const prev = bits[bits.length - 1];
    const human = b => (/^\d+$/.test(b) ? null : (names && names[b]) || b);
    const head = bits.map(human).filter(Boolean).join(' · ');
    let leaf = (names && names[last]) || last;
    if (/^\d+$/.test(last)) {
      if (prev === 'upgrade') leaf = '强化至 +' + (Number(last) + 1);
      else if (prev === 'stage') leaf = '进阶至 ' + (Number(last) + 1) + ' 阶';
      else if (prev === 'stages') leaf = (Number(last) || 0) + ' 阶';
      else leaf = '+' + last;
    }
    return head ? head + ' · ' + leaf : leaf;
  }

  function rowsHTML(items, names) {
    if (!items.length) return '<tr><td class="hint">尚未修改任何字段</td></tr>';
    return items.map(it => '<tr><td>' + esc(describe(it.path, names)) + '</td><td>' + esc(fmt(it.a)) + '</td><td>' + esc(fmt(it.b)) + '</td></tr>').join('');
  }

  /** 把「路径 → 元素」的对应关系找出来；找不到精确元素就退到最近的容器，保证一定能定位。 */
  function nodeFor(root, path) {
    const exact = root.querySelector('[data-path="' + CSS.escape(path) + '"],[data-text-path="' + CSS.escape(path) + '"]');
    if (exact) return exact;
    let bits = String(path).split('.');
    while (bits.length) {
      const id = bits.join('.');
      const hit = root.querySelector('[data-items="' + CSS.escape(id) + '"]') || root.querySelector('[data-text-path="' + CSS.escape(id) + '"]');
      if (hit) return hit;
      bits = bits.slice(0, -1);
    }
    return null;
  }

  function clearMarks(root) {
    root.querySelectorAll('.admin-invalid').forEach(n => n.classList.remove('admin-invalid'));
    root.querySelectorAll('.admin-changed').forEach(n => n.classList.remove('admin-changed'));
  }

  /** 标红出错字段并返回第一个，调用方负责滚动过去。 */
  function markInvalid(root, problems) {
    let first = null;
    for (const p of problems) {
      const node = p.node || nodeFor(root, p.path);
      if (node) { node.classList.add('admin-invalid'); if (!first) first = node; }
    }
    return first;
  }

  /** 标出「相对打开页面时的值已改动」的输入框，方便在几百个框里找自己刚动过的那个。 */
  function markChanged(root, items) {
    if (!items.length) return;
    const paths = items.map(i => i.path);
    root.querySelectorAll('[data-path]').forEach(n => {
      const p = n.dataset.path;
      if (paths.some(x => x === p || x.startsWith(p + '.'))) n.classList.add('admin-changed');
    });
  }

  function debounce(fn, ms) {
    let t = null;
    return function () { clearTimeout(t); t = setTimeout(fn, ms); };
  }

  window.AdminEdit = { esc, fmt, diff, describe, rowsHTML, nodeFor, clearMarks, markInvalid, markChanged, debounce };
})();

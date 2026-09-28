/* ============================================================
   内景功能页公共构件（设计稿 v2 · output/design-review/redesign/v2/harbor-rooms.js）
   ------------------------------------------------------------
   设计稿里每个内景都是「.box 分区 + .slot 格子 + .chip 资源 + .meter 进度条 +
   .mini 小按钮 + .note 说明」这套零件的组合。这里把这套零件做成纯字符串函数，
   页面渲染函数直接拼装即可；样式在 css/harbor.css 的「内景功能页」段。

   只依赖 GameData 的物品索引，不持有状态，因此不存在「谁先加载谁后加载」的问题。
   ============================================================ */
(function (root) {
  'use strict';

  const RARITY_NAME = { common: '普通', rare: '稀有', epic: '史诗', mythic: '神话' };

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  function itemOf(id) {
    const D = root.GameData;
    if (D && D.itemOf) return D.itemOf(id);
    return { id: id, name: String(id), rarity: 'common', kind: 'unknown', price: 0 };
  }

  // 图标地址口径与 ui.js 的 itemIconSrc 保持一致：渔获在 assets/fish，其余走 D.itemIcon
  function iconOf(id) {
    const D = root.GameData, it = itemOf(id);
    if (it.kind === 'fish') return 'assets/fish/' + it.id + '.png';
    return D && D.itemIcon ? D.itemIcon(id) : 'assets/item/' + id + '.png';
  }

  function img(src, cls) {
    return '<img' + (cls ? ' class="' + cls + '"' : '') + ' src="' + esc(src) + '" alt="" loading="lazy" draggable="false" onerror="__imgFail(this)">';
  }

  function iconImg(id, cls) { return img(iconOf(id), cls); }

  function rarityOf(id) { return itemOf(id).rarity || 'common'; }
  function rc(rarity) { return 'rc-' + (rarity || 'common'); }
  function rarityName(rarity) { return RARITY_NAME[rarity] || RARITY_NAME.common; }

  // .slot 格子：id 为物品 id（取图标与稀有度描边），n 为右下角数量
  function slot(id, n, opts) {
    opts = opts || {};
    const r = opts.rarity || rarityOf(id);
    const cls = ['slot', r, opts.sel ? 'sel' : '', opts.cls || ''].filter(Boolean).join(' ');
    const label = opts.title || (itemOf(id).name || id) + (n != null ? ' ×' + n : '');
    return '<button type="button" class="' + cls + '" title="' + esc(label) + '" aria-label="' + esc(label) + '"' +
      (opts.data ? ' ' + opts.data : '') + (opts.disabled ? ' disabled' : '') + '>' +
      iconImg(id) + (n != null ? '<span class="q">' + n + '</span>' : '') + '</button>';
  }

  // 空槽位：补齐整行，避免最后一行缺角（设计稿 §8 背包 8 列铺满）
  function emptySlot(n) {
    let out = '';
    for (let i = 0; i < (n || 1); i++) out += '<span class="slot empty" aria-hidden="true"></span>';
    return out;
  }

  function slots(items, opts) {
    opts = opts || {};
    return '<div class="slots' + (opts.cls ? ' ' + opts.cls : '') + '">' + items.join('') + '</div>';
  }

  // .chip 资源芯片：have < n 时标红（设计稿里缺材料的那一项）
  function chip(id, n, have) {
    const short = have != null && have < n;
    return '<span class="chip' + (short ? ' short' : '') + '" title="' + esc(itemOf(id).name) + '">' +
      iconImg(id) + (have != null ? have + '/' : '×') + n + '</span>';
  }

  function coinChip(n) { return '<span class="chip">💰 ' + n + '</span>'; }
  function chipText(icon, text) { return '<span class="chip">' + icon + ' ' + esc(text) + '</span>'; }

  function meter(pct, gold) {
    const w = Math.max(0, Math.min(100, Number(pct) || 0));
    return '<div class="meter' + (gold ? ' gold' : '') + '"><i style="width:' + w.toFixed(1) + '%"></i></div>';
  }

  // .box 分区（标题用 h5，与设计稿 .box > h5 同规格）
  function box(title, body, cls) {
    return '<section class="box' + (cls ? ' ' + cls : '') + '">' +
      (title ? '<h5>' + title + '</h5>' : '') + body + '</section>';
  }

  function secH(title, extra) {
    return '<div class="sec-h">' + title + (extra ? '<small>' + extra + '</small>' : '') + '</div>';
  }

  function kv(pairs) {
    return '<dl class="kv">' + pairs.map(function (p) {
      return '<dt>' + p[0] + '</dt><dd>' + p[1] + '</dd>';
    }).join('') + '</dl>';
  }

  function mini(label, opts) {
    opts = opts || {};
    const cls = ['mini', opts.cls || ''].filter(Boolean).join(' ');
    return '<button type="button" class="' + cls + '"' + (opts.data ? ' ' + opts.data : '') +
      (opts.title ? ' title="' + esc(opts.title) + '"' : '') + (opts.disabled ? ' disabled' : '') + '>' + label + '</button>';
  }

  function toolbar(inner) { return '<div class="toolbar">' + inner + '</div>'; }
  function note(text) { return '<p class="note">ⓘ ' + esc(text) + '</p>'; }

  function pct(n, d) { return d > 0 ? Math.round(n / d * 100) : 0; }

  // 卡片（设计稿 .pcard：图标 + 名称 + 副行 + 操作）
  function card(opts) {
    const cls = ['pcard', opts.cls || ''].filter(Boolean).join(' ');
    return '<article class="' + cls + '"' + (opts.data ? ' ' + opts.data : '') + '>' +
      (opts.icon ? (opts.iconSrc ? img(opts.icon, 'ic') : iconImg(opts.icon, 'ic')) : '') +
      (opts.title ? '<b class="' + (opts.titleCls || '') + '">' + opts.title + '</b>' : '') +
      (opts.sub ? '<span class="sub">' + opts.sub + '</span>' : '') +
      (opts.body || '') + '</article>';
  }

  function empty(title, text) {
    return '<div class="box"><div class="sec-h">' + esc(title) + '</div>' +
      (text ? '<p class="note">' + esc(text) + '</p>' : '') + '</div>';
  }

  root.RoomUI = {
    esc: esc, img: img, iconOf: iconOf, iconImg: iconImg, itemOf: itemOf,
    rc: rc, rarityOf: rarityOf, rarityName: rarityName,
    slot: slot, emptySlot: emptySlot, slots: slots,
    chip: chip, coinChip: coinChip, chipText: chipText, meter: meter, pct: pct,
    box: box, secH: secH, kv: kv, mini: mini, toolbar: toolbar, note: note,
    card: card, empty: empty,
  };
})(window);

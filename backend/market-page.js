'use strict';
const D = require('../frontend/js/data');
const { ValidationError } = require('./security');
function page(listings, query, viewer, revision) {
  const keys = new Set(['page', 'size', 'scope', 'kind', 'part', 'q', 'affix', 'sort', 'dir', 'min', 'max', 'token']);
  if (Object.keys(query).some(k => !keys.has(k))) throw new ValidationError('未知市集查询参数');
  function str(k, fallback = '') {
    const v = query[k];
    if (v === undefined) return fallback;
    if (typeof v !== 'string' || v.length > 100) throw new ValidationError('市集查询参数无效');
    return v;
  }
  function integer(k, fallback, max) {
    const v = str(k, String(fallback));
    if (!/^[1-9]\d*$/.test(v) || !Number.isSafeInteger(Number(v)) || Number(v) > max) throw new ValidationError('市集分页参数无效');
    return Number(v);
  }
  const requested = integer('page', 1, 10000000), size = integer('size', 30, 100);
  const scope = str('scope', 'all'), kind = str('kind', 'all'), part = str('part', 'all');
  const q = str('q').trim().toLowerCase(), affix = str('affix', 'all');
  const sort = str('sort', 'time'), dir = str('dir', 'desc');
  if (!['all', 'mine', 'others'].includes(scope) || !['time', 'price', 'qty', 'affix'].includes(sort) || !['asc', 'desc'].includes(dir)) throw new ValidationError('市集筛选参数无效');
  if (!['all', 'fish', 'material', 'component', 'rod', 'chest'].includes(kind) ||
      (part !== 'all' && !D.ROD_PARTS.some(p => p.key === part)) ||
      (affix !== 'all' && !Object.prototype.hasOwnProperty.call(D.AFFIX_LABEL, affix))) throw new ValidationError('市集分类或词条无效');
  if (scope === 'mine' && !viewer) throw new ValidationError('查看我的挂单需登录');
  const min = str('min'), max = str('max');
  if ((min !== '' && !Number.isFinite(Number(min))) || (max !== '' && !Number.isFinite(Number(max))) || (min !== '' && max !== '' && Number(min) > Number(max))) throw new ValidationError('词条范围无效');
  const mineCount = listings.filter(l => l.seller === viewer).length;
  let selected = listings.filter(l => scope === 'mine' ? l.seller === viewer : scope === 'others' ? l.seller !== viewer : true);
  const counts = { all: selected.length }, parts = {};
  const meta = new Map();
  for (const l of selected) {
    let m = meta.get(l.id); if (!m) { m = D.itemOf(l.id); meta.set(l.id, m); }
    counts[m.kind] = (counts[m.kind] || 0) + 1;
    if (m.kind === 'component') parts[m.part] = (parts[m.part] || 0) + 1;
  }
  selected = selected.filter(l => {
    const m = meta.get(l.id);
    if (kind !== 'all' && m.kind !== kind) return false;
    if (kind === 'component' && part !== 'all' && m.part !== part) return false;
    if (q && !(l.name + ' ' + l.sellerName + ' ' + l.seller).toLowerCase().includes(q)) return false;
    if (affix !== 'all' || min !== '' || max !== '') return (m.affixes || []).some(a => (affix === 'all' || a.type === affix) && (min === '' || a.value >= Number(min)) && (max === '' || a.value <= Number(max)));
    return true;
  });
  function value(l) {
    if (sort !== 'affix') return sort === 'time' ? l.t : l[sort];
    const a = meta.get(l.id).affixes || [];
    if (affix !== 'all') { const hit = a.find(x => x.type === affix); return hit ? hit.value : -1e9; }
    return a.length ? a.reduce((n, x) => n + x.value, 0) : -1e9;
  }
  selected.sort((a, b) => (value(a) - value(b)) * (dir === 'asc' ? 1 : -1) || b.t - a.t || b.lid - a.lid);
  const total = selected.length, pages = Math.max(1, Math.ceil(total / size)), current = Math.min(requested, pages);
  return { listings: selected.slice((current - 1) * size, current * size).map(publicListing), page: current, pages, size, total, mineCount, marketTotal: listings.length, counts, parts, revision };
}
function publicListing(l) {
  const out = {};
  for (const k of ['lid', 'seller', 'sellerName', 'id', 'name', 'qty', 'price', 't', 'expireAt', 'hours']) out[k] = l[k];
  return out;
}
module.exports = { page, publicListing };

'use strict';
(function () {
  // This module has one network operation: a fixed, authenticated GET. Never send drafts back.
  let snapshot = null, busy = false;
  const listeners = [];
  const clone = value => JSON.parse(JSON.stringify(value));
  function notify() { listeners.forEach(fn => fn()); }
  function items(part) {
    if (!snapshot) return [];
    const rows = new Map();
    function add(id, count, source) {
      const meta = GameData.componentOf(id);
      if (!meta || !GameData.isInstance(id) || (part && meta.part !== part) || !(count > 0)) return;
      if (!rows.has(id)) rows.set(id, { id: id, item: clone(meta), sources: [] });
      rows.get(id).sources.push(source + ' ×' + count);
    }
    Object.entries(snapshot.inventory).forEach(([id, count]) => add(id, count, '背包'));
    Object.values(snapshot.bd).forEach(slot => { if (slot && slot.compId) add(slot.compId, 1, '当前装备'); });
    snapshot.rodSlots.forEach(slot => {
      if (!slot || slot.active) return;
      Object.values(slot.parts || {}).forEach(id => add(id, 1, slot.name || '已存钓竿'));
    });
    return Array.from(rows.values());
  }
  function label(row) {
    const m = row.item;
    return m.baseName + ' · ' + m.qualityName + ' · ' + m.affixes.map(a => GameData.AFFIX_LABEL[a.type] + ' ' + a.value).join(' / ') + ' · ' + row.sources.join('、');
  }
  function picker(part, onPick) {
    const wrapper = document.createElement('label'); wrapper.className = 'inventory-picker field';
    const title = document.createElement('span'); title.textContent = '从我的装备复制';
    const select = document.createElement('select'); select.setAttribute('aria-label', '从我的装备复制');
    const list = items(part);
    const placeholder = document.createElement('option'); placeholder.value = '';
    placeholder.textContent = !snapshot ? '先读取背包，也可手动编辑' : !list.length ? '此部位暂无组件，可手动编辑' : '选择组件（保留实际词条）';
    select.append(placeholder);
    list.forEach(row => { const o = document.createElement('option'); o.value = row.id; o.textContent = label(row); select.append(o); });
    select.disabled = !list.length;
    select.addEventListener('change', () => {
      const row = list.find(row => row.id === select.value);
      if (row) onPick(clone(row.item));
    });
    wrapper.append(title, select); return wrapper;
  }
  function mount(root, onLoad) {
    root.classList.add('wiki-inventory');
    const bar = document.createElement('div'); bar.className = 'toolbar';
    const button = document.createElement('button'); button.type = 'button'; button.id = 'inventory-refresh'; button.textContent = '读取我的背包';
    const status = document.createElement('span'); status.id = 'inventory-status'; status.setAttribute('role', 'status'); status.textContent = '可从游戏背包复制装备，也可从空白方案开始。';
    const note = document.createElement('p'); note.className = 'muted'; note.textContent = '这里只修改模拟副本，不消耗库存或金币，不改变真实装备。背包数量仅供参考，可自由试算。';
    bar.append(button, status); root.append(bar, note);
    button.addEventListener('click', async () => {
      if (busy) return; busy = true; button.disabled = true; status.textContent = '正在读取背包…';
      try {
        const res = await fetch('/api/wiki/simulator/inventory', { method: 'GET', credentials: 'same-origin', cache: 'no-store' });
        if (!res.ok) throw new Error(res.status === 401 ? '请先在游戏中登录，再点击读取背包。' : '背包读取失败，请稍后重试。');
        const data = await res.json();
        if (data.schemaVersion !== 1 || data.readOnly !== true || !data.inventory || !data.bd || !Array.isArray(data.rodSlots)) throw new Error('背包数据格式异常。');
        snapshot = clone(data);
        status.textContent = data.name + ' · 金币 ' + Wiki.fmt(data.coins, 0) + ' · 已读取 ' + new Date(data.fetchedAt).toLocaleTimeString('zh-CN') + ' 的背包';
        button.textContent = '刷新背包副本';
      } catch (e) { snapshot = null; status.textContent = e.message; }
      finally { busy = false; button.disabled = false; notify(); if (onLoad) onLoad(); }
    });
  }
  window.WikiInventory = {
    mount: mount, picker: picker, items: items,
    get snapshot() { return snapshot ? clone(snapshot) : null; },
    quantity: id => snapshot ? Number(snapshot.inventory[id]) || 0 : null,
    onChange: fn => listeners.push(fn)
  };
})();

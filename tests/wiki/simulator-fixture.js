'use strict';
// Disposable offline accounts. Only call before starting the isolated test server.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const D = require('../../frontend/js/data');
module.exports = function seedSimulator(dir) {
  const mainId = D.instanceId('line_nylon', 'mythic', [
    { type: 'material', value: 18 }, { type: 'size', value: 18, src: 'line_titan', srcExplicit: true },
    { type: 'skill', value: 6, src: 'bt', srcExplicit: true }, { type: 'rare', value: 4, src: 'bt', srcExplicit: true }
  ]);
  const subBase = D.COMPONENT_BASES.find(b => b.part === 'line' && b.pool.some(a => a.type === 'size' && a.max >= 18));
  const subId = D.instanceId(subBase.id, 'common', [{ type: 'size', value: 18 }]);
  const rodId = D.instanceId('rod_bamboo', 'common', [{ type: 'speed', value: 9 }]);
  const equipped = id => { const m = D.componentOf(id); return { compId: id, name: m.name, affixes: m.affixes, rare: m.quality }; };
  const account = {
    username: 'simulatorfixture', name: '模拟器测试装备', pwHash: 'test-only-no-password', qq: 'private-fixture',
    coins: 987654, inventory: { [mainId]: 1, [subId]: 2, lure: 25, bait_pack: 26, dragon_scale: 27, tide_sand: 28, relic: 40, dragonpearl: 3, crucian: 1000000 },
    bd: { rod: equipped(rodId) }, rodSlots: [{ name: '已存测试钓竿', bd: { line: equipped(mainId) } }], rodActiveSlot: -1,
    autoSell: { items: { crucian: { on: true, minPrice: 1, keep: 0 } } },
    bigfish: {}, codex: {}, catchCount: 0
  };
  const file = path.join(dir, 'accounts', account.username + '.json');
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(account));
  const token = crypto.randomBytes(32).toString('hex');
  const bannedToken = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(path.join(dir, 'accounts', 'simulatorbanned.json'), JSON.stringify(Object.assign({}, account, { username: 'simulatorbanned', banUntil: -1 })));
  const tokens = {};
  [[token, account.username], [bannedToken, 'simulatorbanned']].forEach(([t, k]) => { tokens[crypto.createHash('sha256').update(t).digest('hex')] = { k, e: Date.now() + 3600000, m: false, v: 2 }; });
  fs.writeFileSync(path.join(dir, 'sessions.json'), JSON.stringify({ tokens }));
  return { file, token, bannedToken, mainId, subId, rodId };
};

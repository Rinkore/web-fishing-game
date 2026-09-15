// 冒烟测试：加载 data.js（UMD），校验每条鱼都有贴图文件，并模拟图鉴卡片模板
const fs = require('fs');
const path = require('path');
const D = require('../frontend/js/data.js');
const DIR = path.join(__dirname, '..', 'frontend', 'assets', 'fish');
const items = D.allItems().filter(i => i.kind !== 'chest');
const fish = items.filter(i => i.kind === 'fish');
let fail = 0;
fish.forEach(it => {
  const p = path.join(DIR, it.id + '.png');
  if (!fs.existsSync(p)) { console.error('缺贴图:', it.id); fail++; }
});
// 模拟 ui.js 卡片模板里的 iconHtml 生成逻辑
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
const sample = fish.slice(0, 3).map(it => '<img class="cx-icon" src="assets/fish/' + esc(it.id) + '.png" alt="" draggable="false">');
console.log('鱼类总数:', fish.length, '| 缺图:', fail);
console.log('卡片 img 样例:', sample[0]);
// 校验所有 id 转义后无异常字符
const bad = fish.filter(it => /[^a-z0-9_]/.test(it.id));
console.log('异常 id:', bad.length ? bad.map(b => b.id) : '无');
process.exit(fail || bad.length ? 1 : 0);

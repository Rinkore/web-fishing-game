/*
 * 侧栏入口导航的测试适配层（零依赖，供各 UI 套件共享）。
 *
 * v0.15.0 起侧栏按「一个入口承载一族功能」重组：原来各占一个入口的
 * 钓竿配置 / 渔获记录 / 系统商店 / 开放市集，现在是「钓鱼」「图鉴」「商城」页里的页签。
 * 测试用例里的旧名字不必逐个改——统一经这里折算成「入口 + 页签」两步点击，
 * 老用例照旧按旧名字调用，新增用例用新名字即可。
 */
'use strict';

// 名字（新或旧） → { nav: 侧栏入口文案, tab: 页内页签 key 或 null }
const TARGETS = [
  [/钓竿配置|钓竿/, '钓鱼', 'rod'],
  [/钓鱼/, '钓鱼', 'fishing'],
  [/鱼类图鉴|图鉴/, '图鉴', 'codex'],
  [/渔获记录|记录/, '图鉴', 'records'],
  [/渔场动态|社交/, '社交', null],
  [/反馈意见|反馈/, '反馈', 'submit'],
  [/系统商店|收购/, '商城', 'shop'],
  [/开放市集|市集/, '商城', 'market'],
  [/商城/, '商城', 'mall'],
  [/工坊/, '工坊', 'open'],
  [/角色/, '角色', 'companion'],
  [/背包/, '背包', null],
  [/日志/, '日志', null],
];

function navTarget(name) {
  for (let i = 0; i < TARGETS.length; i++) {
    if (TARGETS[i][0].test(name)) return { nav: TARGETS[i][1], tab: TARGETS[i][2] };
  }
  return { nav: name, tab: null };
}

// 页内页签选择器：合并页的页签（section-tabs）与各页自有的页签属性
function tabSelector(tab) {
  return '#main [data-sectiontab="' + tab + '"], #main [data-malltab="' + tab + '"], ' +
    '#main [data-wstab="' + tab + '"], #main [data-invtab="' + tab + '"]';
}

// 在 playwright 页面里点侧栏入口（必要时再点页内页签）；返回 {nav, tab}
async function clickAppNav(page, name) {
  const target = navTarget(name);
  // 注意：playwright 的 page.evaluate 只接受一个参数，多个值必须打包成对象
  await page.evaluate(function (cfg) {
    const items = Array.from(document.querySelectorAll('#nav .nav-item'));
    const b = items.find(function (x) { return x.textContent.includes(cfg.nav); });
    if (b) b.click();
    if (cfg.tab) {
      const t = document.querySelector(cfg.sel);
      if (t && !t.classList.contains('on')) t.click();
    }
  }, { nav: target.nav, tab: target.tab, sel: target.tab ? tabSelector(target.tab) : '' });
  return target;
}

module.exports = { navTarget, tabSelector, clickAppNav, TARGETS };

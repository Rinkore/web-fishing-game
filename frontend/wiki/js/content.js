'use strict';
/*
 * Wiki 正文兜底容器。
 * 生产环境由 /api/wiki/content 返回管理员可热更新的内容；
 * 静态开发环境回退读取 /wiki/content/content.json。
 * 这里不再手写正文，避免同一份攻略出现两份会漂移的来源。
 */
window.WikiContent = { guides: [], updates: [] };

// 两种来源只在展示层合并，不改动可热更新的原始记录。
window.WikiContentTools = {
  mergeUpdates: function (updates, versions) {
    const wiki = (updates || []).map(function (x, i) {
      return { date: x.date, title: x.title, summary: x.summary, source: 'Wiki 内容', order: i, priority: 0 };
    });
    const game = (versions || []).slice().reverse().map(function (x, i) {
      return { date: x.date, title: x.version + ' 版本更新', summary: x.summary, source: '游戏版本', order: i, priority: 1 };
    });
    function time(x) {
      // 使用来源中的完整日期；不能用浏览器当前年份猜测旧记录。
      return /^\d{4}-\d{2}-\d{2}$/.test(x.date || '') ? (Date.parse(x.date + 'T00:00:00Z') || 0) : 0;
    }
    return wiki.concat(game).sort(function (a, b) {
      return time(b) - time(a) || a.priority - b.priority || a.order - b.order;
    });
  }
};

'use strict';
/*
 * Wiki 正文兜底容器。
 * 生产环境由 /api/wiki/content 返回管理员可热更新的内容；
 * 静态开发环境回退读取 /wiki/content/content.json。
 * 这里不再手写正文，避免同一份攻略出现两份会漂移的来源。
 */
window.WikiContent = { guides: [], updates: [] };

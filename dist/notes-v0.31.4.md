v0.31.4 · 修复老玩家卡在旧版本（资源缓存不失效）

现象

正式服已上线 v0.31.3，`/api/version` 返回 v0.31.3，但访问
`https://ipv4.rinkore.com:9000/#/` 页面仍显示 v0.31.2。

根因

`frontend/index.html` 中 37 处资源引用写死了同一个缓存串：

```html
<script src="js/data.js?v=v0.31.0"></script>
```

该串自 v0.31.0 起从未更新，而静态资源响应头为
`Cache-Control: public, max-age=31536000, immutable`。

于是浏览器在 `?v=v0.31.0` 这个 URL 下一直复用首次缓存的 `data.js`
（内含 `const VERSION = 'v0.31.2'`），一年内不会回源校验。
服务器实际返回的是 v0.31.3，浏览器用的是自己缓存里的 v0.31.2。

为什么自愈机制没生效

`frontend/js/net.js` 的 `reloadForVersion()` 设计了版本比对强刷
（`data.js` 顶部注释也说明了该意图），但：

- 它只刷新**页面 URL**（`loc.replace(pathname + '?v=…&t=…' + hash)`）；
- `index.html` 内部的 `<script src="js/data.js?v=v0.31.0">` 是写死的，
  页面 query 影响不到子资源请求；
- 强刷后仍从 `immutable` 缓存取回同一份旧 `data.js`；
- `net.js` 随即判定「该版本已刷过」（sessionStorage 标记），放弃重试。

即：比对逻辑本身跑在**那份过期的 data.js 里**，永远看不到新版本。

修复

把 `index.html` 中 37 处 `?v=v0.31.0` 更新为 `?v=v0.31.4`。
URL 变化即绕过旧缓存条目，页面会重新拉取当前版本的 `data.js`。

影响与限制

- 老玩家**不会自动恢复**：其浏览器内已缓存的旧 `data.js` 不受服务端
  任何改动影响，新代码改不到它。需要一次强制刷新
  （Windows `Ctrl+Shift+R`）才能脱离旧缓存条目。
- 本版只是让 URL 随之变化；**下次发版若忘记同步这 37 处仍会复发**。
  根治办法是让缓存串随版本自动生成（构建期注入，或服务端在返回
  `index.html` 时写入当前版本），或改用带内容哈希的文件名。
  该根治未包含在本版中。

上线与回退

- **不含 SQL 迁移**，迁移摘要与 v0.31.3 一致，可直接热更新。
- 失败时可切回 v0.31.3；数据库未变更，无需整库恢复。

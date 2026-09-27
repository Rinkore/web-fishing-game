v0.27.5 · 告示板五页签 / 钓获特效开关 / 经典界面移除

- 告示板页签修复：`harbor.js` 的 `BOARD_VIEWS` 补回 `records`。此前数组只有 4 项而标签有 5 项，`buildPanelTabs` 按索引取标签，于是从第 2 个页签起「记录 → 打开日志、日志 → 打开反馈、反馈 → 打开 WIKI」，`WIKI ↗` 从不渲染；现在 图鉴 · 记录 · 日志 · 反馈 · WIKI ↗ 与子视图一一对应，WIKI 仍开新标签、不切页签，徽标与 `#/codex`·`#/logs`·`#/feedback` 深链行为不变。
- 钓获庆祝动画接线：`ui.js` 的钓获日志在稀有 / 史诗 / 神话时调用 `harborHook('catchReward', { img, name, rarity, text })`，`HarborShell.catchReward → reward()` 播放内景上方的全屏庆祝动画（白闪 → 暗幕、稀有度配色光芒环、140px 贴图、鱼名与「稀有 / 史诗 / 神话 · 已放入仓库」档位行），1.8 秒自动消失，点击立即关闭。此前动画已实现但没有任何调用方，在生产里是死代码。
- 钓获特效开关：`settings.js` 新增 `catchFlash: 'on' | 'off'`（默认 `on`）与设置行「钓获特效」；关闭后不再触发庆祝动画，普通钓获始终不弹。
- 内景润色（F4）：`harbor.css` 新增邮件信封样式 `.h-pbody .message-item`（折角三角、蜡封圆点、read / claimed / expired 状态与次要文字配色）和渔屋场景条带 `.h-pbody .h-house-strip`，与罗盘首页 `.h-strip` 同规格。
- 经典界面移除（F5 + Phase G）：`choices.theme` 只剩 `harbor`；`harbor.js` 删除 `enabled()`、`originNav` 与「切回经典」时把 `#nav` 搬回侧栏、还原 `#main` 的整段分支，`apply()` 直接看 `authed()`；`index.html` 删除 `.layout` / `.sidebar` / `#nav`（顶栏 `.topbar` 保留，由 `body.harbor-on .topbar { display: none }` 收起）；`harbor.css` 不再隐藏 `.layout`；徽标与「暂未开放」锁定状态由 `ui.js renderNav()` 写入 `window._navMeta` 共享给外壳，目录列表由 `renderNav()` 直接渲染进 `#h-dir-body`，不再搬移 DOM 节点。既有 `harbor-phase-*` 测试中针对经典界面的断言同步删除。
- 版本号升至 v0.27.5：前端 `data.js`、内嵌 Go catalog（`version` 与 `constants.VERSION`，保留已复核的 gearmerge 快照与 `sourceSHA256`）和 `?v=` 缓存参数同源，客户端在版本比对后自动强制刷新，不必手动清缓存。

验收：按操作要求不跑测试。改动集中在港湾前端（`frontend/js/harbor.js`、`frontend/js/ui.js`、`frontend/js/settings.js`、`frontend/css/harbor.css`、`frontend/index.html`）与随发布同步的规则 / 测试夹具（`server-go/testdata` 四个 oracle 由 `tools/go-rewrite/{chest,mall,native-rules,workshop}-fixture.js --write` 重新生成，chest 的 `sourceSHA256` 随 `data.js` 更新）。发布走本地：`output/build-linux-local.ps1` 构建、公钥 `scp -O` 上传、服务器固定入口 `fishing-release-deploy` 部署，再做公网探针。

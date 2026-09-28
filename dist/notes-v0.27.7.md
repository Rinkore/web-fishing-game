v0.27.7 · 告示板统一内景面板 / 白纸卡片 / 页签深链

- 告示板由「四个独立子视图」改为「一块内景面板 + 四个页签」：`harbor.js` 的 `openPlace('board', tab)` 不再把页签折算成 `codex / records / logs / feedback` 子视图去 `UI.openView`，而是把页签序号交给统一视图（`UI.openView('board', tabIndex)`）；外壳仍用 `showPlace('board', tab)` 记录当前地点与页签，建筑高亮、返回与关闭行为不变。
- `ui.js` 新增 `renderBoard()` 外壳：一块 `.panel.wide.board-panel` 承载 `.board-tabs`（四个 `data-board-tab` 按钮，`role="tablist"`、`aria-selected` 跟随当前页签）与 `.board-content` 内容区，图鉴 / 记录 / 日志 / 反馈四个子渲染函数复用既有数据与交互（`openSpotDetail`、`openRecordsModal`、`confirmModal`、清空日志、反馈冷却与跳过等），状态由 `boardTab`、`codexCategory`、`codexSortRarity` 持有，切页签只重绘内容区。
- 页签深链补齐：`applyTabDeepLink` 的选择器加入 `[data-board-tab]`，`#/place/N` 可直接选中告示板第 N 个页签；`pageIdOf()` 把 board 折算回当前页签对应的页面 id（图鉴 → codex、记录 → records、日志 → logs、反馈 → feedback），功能锁定、广播重绘范围与红点徽标沿用原口径。
- 卡片样式收敛为纸卡：软木板背景上的选择器从 `.panel.wide` 改为 `.board-card` / `.board-paper`（白底 `#fff`、`1px #ddd` 描边、`0 4px 8px rgba(0,0,0,.15)` 阴影、`16px 20px` 内边距），`.board-content` 改 flex 列 + `20px` 间隔，告示板内景的 `#main.content` 补 `16px` 内边距；同时删掉此前叠在 `.codex-grid` / `.record-list` / `.feedback-panel` / `.logs-panel` 上的第二层白底、圆角与阴影，四个页签现在共用同一套纸卡外观。
- 版本号升至 v0.27.7：前端 `data.js` 的 `VERSION`、`index.html` / `admin.html` 的 `?v=` 缓存参数、内嵌 Go catalog 的 `version` 与 `constants.VERSION` 同源（catalog.json 只改这两处，已复核的 gearmerge 快照与 `sourceSHA256` 保持不动）；四个规则 oracle 由 `tools/go-rewrite/{chest,mall,native-rules,workshop}-fixture.js --write` 随版本号重新生成。

验收：按操作要求本轮不跑测试。发布走本地：`output/build-linux-local.ps1` 构建、公钥 `scp -O` 上传、服务器固定入口 `fishing-release-deploy` 部署，再做公网探针；不走 GitHub Action。

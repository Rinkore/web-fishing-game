v0.30.1 · 远端补齐 0.30.0 源码后的版本对齐

本版本以 0.30.0 的真实 `main` 为基线，只做版本与发布对齐，不改变玩法数值：

- 将 `main` 对齐到远端 0.30.0（`b977ea9b`）：该提交此前未进入仓库，导致本地无法构建与正式服一致的产物；现仓库已包含港湾场景、渔屋、鱼类繁育（`breeding.js` / `internal/modules/breeding`）与房间 UI（`room-ui.js`）的完整源码，以及迁移 0035 / 0036。
- 规则目录与前端版本统一为 `v0.30.1`；内嵌目录 `catalog.json` 的 `version` 与 `constants.VERSION` 同步更新，`sourceSHA256` 按 0.30.0 起的约定保持不变（该线已不再用摘要校验前端快照）。
- `server-go/testdata` 中随目录版本比对的三个夹具（chest / mall / native）同步更新；`catch` / `economy` / `legacy` / `sea` 保留 v0.21.4 的历史口径不变。
- 静态资源缓存串统一刷新为 `?v=v0.30.1`。
- 迁移集合未变，`tools/release/migration-hash.js` 仍为 `0d4b8bd1…`，与线上数据库已应用的 0036 基线一致，可走本地 Linux 构建 + 受限部署入口直接更新。

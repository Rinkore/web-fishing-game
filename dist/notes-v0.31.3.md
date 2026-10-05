v0.31.3 · 渔屋场景化内景 / 恢复标准发版流水线

渔屋改成可点击的场景内景

渔屋不再用页签切换功能，改为 480×240 的场景画面
（`frontend/js/house-art.js`，与 `harbor-art.js` 同结构：状态传入、只负责画）。
进入渔屋即绘制屋内；点物件打开右侧抽屉（复用现有 `#main`），不再切页签。
数字键 1–5 可直接打开对应物件，Esc 回到屋里。

- 晒架、宠物、角色、升级等原页签内容全部保留，只是入口从挂签改为屋内物件。
- 目录面板补上焦点返回：打开抽屉前记录焦点，关闭后归还，键盘操作不再丢位置。

背包：移除已废弃的体型档筛选

大型 / 巨型鱼的体型档筛选行与预留行渲染一并删除。该功能在 v0.25.0
随晒场改造停用后已不再生效，仅剩空壳 UI。

登录 / 注册弹窗无障碍修复

`#auth` 补上 `role="dialog"`、`aria-modal`、`aria-labelledby` /
`aria-describedby` 与 `aria-hidden`；页签改为 `role="tablist"` +
`aria-selected` + `aria-controls`；注册字段用 `hidden` 属性切换，
不再用内联 `style="display:none"`。

恢复标准发版流水线并补齐 v0.31.x 标签

本版把 v0.31.x 重新接回标准发版路径：标签 → GitHub Release → 自动部署。

背景：v0.31.2 是绕过标签流水线直接上线生产的

`docs/go-rewrite/DEPLOY_0037_RECORD.md` 记录，v0.31.1 → v0.31.2 的升级
（含迁移 `0037_house_rack_kinds.sql`）没有走标准流水线，原因是迁移摘要
与当时发行记录的基线不一致，`deploy.py` 在停服前拒绝了自动部署：

- 迁移已按维护窗口由人工显式执行并验证；
- 随后把当前发行的 `MIGRATIONS_SHA256.txt` 与
  `.release.json.migrationsSha256` 更正为数据库实际所处的 `43375757…`；
- 再经固定入口 `/usr/local/sbin/fishing-release-deploy` 完成部署。

该记录同时指出：**远端至今没有任何 v0.31.x 标签**。本次发布即为此项。

CI 修复

- `tools/go-rewrite/workshop-fixture.js` 已在 `a5126b3` 随停用的工坊规则
  一起删除，但工作流仍在调用它，导致生成物校验步骤必然 MODULE_NOT_FOUND。
  现删除该行；其比对目标 `workshop-rules.json` 与 `TestNodeOracles` 列表
  中的对应项均已不存在，不恢复已移除功能的夹具。
- 有 5 个 Go 文件存在格式漂移（纯空白 / 对齐），已 `gofmt` 对齐，
  以通过工作流中的 `test -z "$(gofmt -l .)"` 闸门。

上线与回退

- **不含 SQL 迁移**，迁移集合与 v0.31.2 完全一致，可直接热更新。
- 更新器摘要闸门通过，属普通同 schema 更新。
- 失败时可切回旧发行；数据库未变更，无需整库恢复。

与 0037 上线的差别（重要）

v0.31.2 那次不可按此方式回退：数据库已由 37 条迁移升至 38 条，旧二进制
（内嵌 37 条）会因 `app.Ping` 的 `migrations.Check(..., requireAll=true)`
校验失败而 readiness 不可用，只能整库恢复。本版不含迁移，不受此边界约束。

遗留项（本版未处理）

1. `internal/platform/postgres/pool.go` 给每条连接固定设
   `lock_timeout = 1000ms`，而 `cmd/migrate` 复用同一 pool，且该值写在
   `RuntimeParams` 中，优先级高于 DSN 的 `options=-c lock_timeout=...`，
   无法覆盖。0037 上线时实测 `DROP CONSTRAINT` 抢锁耗时 2237ms，超过预算，
   首次迁移失败；同一预算下重复 6 次仅 4 次成功。建议让 `cmd/migrate`
   使用独立的 pool 配置。**下次包含迁移的发布前应先处理此项。**
2. 迁移必须与同版本二进制同时上线；单独执行迁移会让在线的旧程序
   readiness 失败（0037 上线时已实际发生）。

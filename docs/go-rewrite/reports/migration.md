# Go 迁移工具与隔离演练

核对对象：`codex/go-migration` worktree。本文只记录合成数据和隔离 PostgreSQL 的工具结果，不授权访问生产、不执行 push/deploy/停服/切服。最终集成窗口必须在冻结候选 SHA 上重跑受影响命令；本文中的 SHA 是执行当时的工作树指纹，不能替代最终候选 SHA。

## 交付物

- `server-go/internal/legacy/scan.go` 保持只读扫描边界：清单、原始字节 SHA-256、重复 JSON 键、精度、账号/挂单引用和跨文件变化检查。扫描结果固定 `importReady=false`，扫描成功不代表可以导入。
- `server-go/internal/migration/importer.go` 提供 `Import` 和 `Reconcile`。导入要求 schema 已由 `cmd/migrate` 应用到 head，运行期不执行 DDL；源实体先原样写入 `migration_entities`，旧新账号映射写入 `legacy_id_map`，异常写入 `migration_gaps`。
- `server-go/migrations/0028_legacy_import.sql` 创建迁移账本、实体暂存和阻断缺口表。schema owner/migration role 才能写这些表，runtime role 不获得写权限。
- `server-go/cmd/import-legacy`：`--mode scan` 只读；`--mode import` 才连接 DSN 并写入隔离库；`--mode reconcile` 只读迁移账本。数据库 URL 不能指向生产，执行前必须由现场策略阻止生产网段。
- `tools/go-rewrite/migration-fixture.js` 生成固定时间、固定旧 ID 的合成存档（valid 14 文件、blocked 16 文件），同时生成脱敏 manifest/oracle；其中包含 JSON Wiki 和 WAL 模式 SQLite 的对应内容。
- `tools/go-rewrite/migration-fixture-preflight.ps1` 只执行 fixture + Go scanner，明确不执行数据库导入和切换。
- `tools/go-rewrite/postgres-roles-bootstrap.sql`、`postgres-runtime-grants.sql`、`postgres-ops-rehearsal.ps1` 实现隔离角色、最小权限、备份/WAL/PITR 和故障演练。
- `docs/go-rewrite/reports/MIGRATION_DOMAIN_AUDIT_2026-09-22.md` 是持久化域和 schema 的独立审计清单，包含本轮 importer 的后续审阅项。

## 一致快照规范

正式快照只能来自停写窗口，运行中复制的参考目录只能用于扫描演练，不能称为一致快照。

1. 记录 Node 源版本、数据格式版本、Go 候选 SHA、Wiki schema 版本、主机时区和数据库时区。进入维护后拒绝所有业务写入，等待正在进行的钓鱼结算、交易、市场撮合和管理员写入落账或明确终止；在线连接和会话不作为可恢复资产。
2. 停写后记录写入计数/最后 operation 水位，冻结文件集合。清单必须包含 `accounts/*.json`、`market.json`、`records.json`、`economy.json`、`config.json`、`feedback.json`、`stats.json`、`admin.json`、`sessions.json`、Wiki JSON、Wiki SQLite 主库及同一时刻的 `-wal`/`-shm`（如存在）、历史快照和任何新增文件。未知文件阻断。
3. 对每个文件记录相对路径、字节数、SHA-256；清单自身再做规范化 SHA-256。复制到受控目录后重新读全量文件并比较字节数和摘要，复制失败或复制期间任一文件改变即废弃目录。禁止把 `users.json/world.json` 这类未分代单体文件直接导入。
4. JSON 必须以 UTF-8、无重复键、精确整数解析；金币、库存、预留、价格和序号的上限为目标 schema 的 `9007199254740991`。大鱼 `L/G` 是总库存的互斥预留，不是额外数量。任何非法数值、孤立引用、重复 ID 或未知字段必须形成阻断缺口。
5. SQLite 必须在停写后完成 `PRAGMA integrity_check`、`foreign_key_check` 和 WAL checkpoint/复制核验；主库、WAL、SHM 作为同一组保存。逐条比较 JSON 官方/用户攻略、段落、更新、revision 与 SQLite `guides/guide_sections/updates/guide_revisions/wiki_meta`。JSON 与 SQLite 不一致时不选择“优先某一份”，而是阻断并人工决定来源。
6. 快照报告中只放 file ref、摘要、数量和缺口代码。账号名、旧 ID、密码哈希、MFA、QQ、token 和数据库凭据只留在受控迁移库/受控日志，不进入普通验收报告或 Git。

## 导入边界和映射

导入事务先建立 `migration_runs`，再暂存原始 payload。相同 `sourceVersion + manifestSha256` 产生稳定 run ID；已 `reconciled` 的 run 再执行只返回结果，不增加账号、opening operation 或挂单。故障回滚事务，失败 run 状态在独立连接写成 `failed`，之后可用相同 run ID 重试。

当前已实现的目标写入：

| 旧域 | 当前目标 | 规则 |
| --- | --- | --- |
| 账号、用户名、QQ、密码哈希、封禁/管理员 | `accounts`、`identities`、`player_state`、`wallets` | 新账号 ID 由 PostgreSQL 生成；`legacy_id_map` 同时保留文件键和 payload 旧 ID；不带明文密码，保留兼容哈希供登录路径验证。 |
| 金币 | opening `asset_operations`/`asset_entries`/`outbox_events` + `wallets` | 以 opening 余额记账，不能把历史流水再次累加；精确整数，资产操作使用稳定 request key。 |
| 鱼、材料、分类预留 | `item_definitions`、`inventory_stacks`、`player_codex` | catalog 必须先提供定义；鱼的 normal/large/giant 分行，`bigfish` 只能是预留子集；没有定义不猜 kind。 |
| 装备和钓竿 | `equipment_instances`、`equipment_entries`、`rod_loadouts`、`rod_components` | 组件旧 ID 映射为新 identity；槽位引用必须存在且不重复。 |
| 玩家挂单/托管 | `market_orders` + 可用库存扣减 | `escrowed` 映射为 open + remaining；卖家、数量、单价、到期和可用/托管守恒逐项检查。交易、部分成交、税费历史仍需专门 mapper。 |
| Wiki JSON | `wiki_guides`、`wiki_sections` | 官方/用户 owner、状态和段落可导入；SQLite 组必须先完成外部 integrity/WAL/JSON 一致性门禁。 |

以下域会原样暂存并形成阻断缺口，绝不静默丢弃：records/catch immutable history、economy/shop/trade logs、friends、sea/voyage/quests、party、feedback/admin/stats、feature/banner/operator config、历史快照，以及含 MFA secret 的账号。`sessions.json` 只记录“全部失效、必须重新登录”的非阻断策略；旧 token 不复制。补齐这些 mapper、字段级对账和权限审批之前，不能宣称全域导入通过或进入切服窗口。

## 对账口径

总数只作摘要。放行前必须逐实体比较：账号归属和引用、wallet balance、每个 item/tier 数值、预留、装备属性/来源、钓竿槽位、挂单 seller/item/qty/remaining/price/expiry/state、托管 owner、Wiki guide/section/revision，以及历史 operation 的来源关系。资产守恒至少满足：

`源金币 = 目标 opening 余额 + 已明确托管/交易中的金币`；

`源库存 = 目标可用库存 + 市场托管 + 明确交易托管 + 已记录历史扣减`；

装备实例和旧 ID 必须一一映射，不能用全服总数掩盖归属差异。任何无法解释的差异、目标外键失败、源异常资产或未知字段都是切服阻断项；工具不自动修复。

## 合成演练证据

以下命令均在本 worktree、合成数据和隔离资源中运行：

```powershell
node --test tests/migration-fixture.test.js
pwsh -NoProfile -File tools/go-rewrite/migration-fixture-preflight.ps1 `
  -OutputRoot output/go-rewrite/migration-preflight-final
```

结果：Wiki JSON/SQLite guide、section、updates、revision 元数据逐项一致，Node 测试 2/2；valid scanner 为 14 files/0 findings/exit 0，blocked scanner 为 16 files/2 findings/exit 1（单体 users 与 unclassified 文件）。预检成功路径显式 exit 0；结果 JSON 标明 database/import/cutover 未执行。受控证据目录为 `output/go-rewrite/migration-preflight2/`（目录不入 Git）。

Go 迁移包的隔离 PostgreSQL 测试：

```powershell
$env:FISHING_GO_TEST_DATABASE_URL = 'postgres://fishing_test_admin:local-test-only@127.0.0.1:<isolated-port>/fishing_test?sslmode=disable'
& "$env:LOCALAPPDATA\FishingGoToolchains\go1.27.1\go\bin\go.exe" test -count=1 -v ./internal/migration
Remove-Item Env:FISHING_GO_TEST_DATABASE_URL
```

`TestImportFailureRecoveryAndIdempotency` 和 `TestImportPersistsBlockingGapAfterRollback` 已在真实隔离 PostgreSQL 实测：注入 staging 失败后无部分账号；failed 状态可读；恢复导入为 reconciled；第三次执行不增加账号或 opening/market operation；市场托管 2 件从可用库存精确扣除；阻断缺口在回滚后仍可查询。受控日志为 `server-go/output/go-rewrite/migration-import-final2/windows-migration.log`，exit 0。该测试仅使用临时 `fishing_test_<random>` 数据库。

权限、备份、恢复演练：

```powershell
pwsh -NoProfile -File tools/go-rewrite/postgres-ops-rehearsal.ps1 `
  -OutputRoot output/go-rewrite/migration-ops-final
```

最终候选结果位于 `output/go-rewrite/migration-ops-final-candidate/<run-id>/result.json`，具体 `sourceCommit`、`dirty` 和 run ID 以该 JSON 为准。关键检查点：PostgreSQL 18.6 固定镜像摘要；空库 migration + schema owner 所有权；runtime 账号可完成最小注册写入；runtime `CREATE TABLE`、`CREATE ROLE`、删除 `operator_audit` 和 backup 写入均拒绝；ops 可读 `pg_stat_activity`；backup 角色只读 dump；logical dump 可恢复并核对钱包基线；物理 base backup + 5 个归档 WAL；SIGKILL 后提交基线保留；PITR 恢复到 marker 前，marker 行为 0。实测 RPO 取决于最后归档 WAL，RTO 以结果 JSON 为准。该单机 Docker 卷没有覆盖整机/磁盘损坏，不能宣传整机 RPO=0；结果字段明确 `hostFailure=untested`。最终候选 SHA 改变后必须重跑并记录新的 result.json。

## 生产执行手册（后续阶段）

现场需要在受控目录提供：旧服务准确 commit/版本、快照根目录、Wiki SQLite 主库/WAL/SHM、目标 DSN、目标 migration/schema/runtime/backup/ops 角色、备份归档位置、维护窗口、入口 DNS/LB、监测地址、恢复目标时间、旧服最后 operation 水位和人工审批人。真实密码/MFA/连接密钥不得写入命令行历史或报告。

执行顺序固定为：

1. 冻结候选 SHA、规则/catalog、导入器和配置摘要；验证目标为空库或已核验历史 schema，先由 migration role 执行 `cmd/migrate up`，再撤销其运行时连接。
2. 旧服进入维护并确认所有写请求返回维护状态；安全结束或持久化未完成钓鱼/交易，保存最后 operation 水位。旧服保留只读，不与 Go 同时接受写入。
3. 按一致快照规范复制并复核 manifest、JSON 数值、SQLite integrity/WAL/JSON 对账。快照变化、摘要不符、未知文件或缺口立即中止。
4. 在候选库用 `--mode import` 导入；只接受 `reconciled` 且 blocking gaps 为零的结果。再运行 `--mode reconcile` 和全域逐实体对账，保存脱敏摘要与受控详细映射。
5. 由 DBA 应用最小权限并验证：schema/migration、runtime、backup、ops 不能互相越权；runtime 无 DDL、无 role 管理、不能删 immutable audit/records/revisions；backup 无写入。
6. 启动候选 Go 服务但保持入口隔离，执行登录、资产读取、市场挂单/撤单、交易状态、图鉴/Wiki、管理员审计和 SSE 冒烟。任何资产差异、鉴权失败、重复写入、读写错误、WAL/备份异常或第二写端出现都中止。
7. 切换入口到 Go，确认旧服端口/队列已 fencing，监测唯一写入端、operation 水位、资产对账、错误率、连接池、锁等待、WAL 归档延迟和磁盘余量。观察窗口内保留旧快照和 Go 恢复点。

中止条件包括：manifest/版本/schema 不一致；任一 blocking gap；逐实体/资产守恒差异；导入事务非原子；权限越权；旧服仍可写；Go 产生重复 operation；备份或 WAL 恢复验证失败；PITR 目标越过预期；监测无法确认唯一权威写入端。

## 回退边界

**Go 尚未开放写入：** 保持旧服停写状态，丢弃候选库或将其只读封存，恢复旧入口和旧服务；重新开放前再次确认旧服仍是唯一 writer。此阶段可以直接使用旧快照，因为 Go 没有新资产。

**Go 已产生新资产：** 禁止直接把旧 Node 快照覆盖回去，否则会丢掉新金币、库存、装备、挂单成交和社交状态。优先修复 Go；若必须回旧程序，必须先停 Go、导出 Go 期间的 operation/asset ledger 和所有新实体，执行已验证的反向 mapper/补偿脚本并逐实体对账。当前仓库没有经过验证的全域反向恢复工具，因此该路径只允许“保留 Go 增量后人工业务处置”或恢复到明确时间点并接受 RPO/资产处置审批，不能作为已完成能力宣传。

## 仍需现场确认

1. 正式源版本与快照 manifest；当前 fixture 的 v0.21.4 只是假数据。
2. Wiki 的真实 SQLite schema、备份工具、WAL 归档保留窗口和 JSON/SQLite 权威关系。
3. records/economy/trade/friends/sea/party/feedback/admin/stats/config 的逐字段 mapper、历史 operation 来源和异常资产处理规则。
4. 密码哈希算法/盐格式、MFA 密钥托管与轮换、QQ/隐私字段的受控迁移流程。
5. 目标 PostgreSQL 主机、独立备份故障域、归档延迟目标、RPO/RTO 和 fencing/入口切换方案。
6. 现场审批人、维护窗口、冒烟账号集合和监测阈值。

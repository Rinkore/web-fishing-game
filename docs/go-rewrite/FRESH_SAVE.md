# 正式服全新存档（清空数据、保留字段）

日期：2026-09-26。适用对象：`/opt/fishing-go` 上的正式 Go 实例及其 PostgreSQL 数据库。入口为 `server-go/cmd/reset`。

## 目标与边界

目标是把正式服恢复成“全新存档”：玩家账号、资产、图鉴、渔获纪录、市集、交易、邮件、好友与编队、海域与远航、反馈、Wiki 投稿、会话与在线租约、后台审计与登录失败记录等运行时数据全部清空；表、字段、索引、约束、序列、权限和迁移账本原样保留。运营配置 `operator_settings`、公告串行头 `banner_state` 等迁移期单例行保留。

不包含：不 DROP 数据库或 `fishing` schema，不重建角色与授权，不修改 `public.fishing_schema_migrations`，不自动部署，不代替备份。玩家必须重新注册，管理员必须重新初始化；玩家资产快照（`admin/users/snapshot`）是资产级回滚，不是全服存档回滚，清档后同样不存在。

## 为什么不新建库或重建 schema

`tools/go-rewrite/postgres-runtime-grants.sql` 的权限逐表授予，DROP 或重建 `fishing` schema 会一并丢掉这些对象级授权；部署门禁又要求数据库 schema 与发行包内嵌迁移逐条一致（见 [Linux 自动更新](../../deploy/linux/README.md)）。就地 `TRUNCATE` 保留字段、序列、权限与迁移账本，因此是本仓库支持的全新存档方式。如果确实要改用新库，必须重新执行角色与授权脚本，并为发行流程重新建立已验证的迁移基线。

## 操作步骤

1. 备份并确认可恢复：沿用现有 PostgreSQL 备份流程，保留切换前的完整备份。
2. 停服：按 [Linux 自动更新](../../deploy/linux/README.md) 的顺序停止 game 与网页代理服务。
3. 预演（只读）：用 schema 管理连接执行 `./bin/reset fresh`，核对输出中的 `preserved`、`cleared` 与各表 `rows`；这一步不写库。
4. 执行：同一个连接上执行 `./bin/reset fresh --confirm`。命令在有其他 `fishing-go` 连接时会拒绝执行，避免带着运行中的进程清档。
5. 重新初始化管理员：按 [server-go/README.md](../../server-go/README.md) 的管理员初始化流程执行 `./bin/admin provision`（用户名/密钥/OTP 只经标准输入与环境变量传入）。
6. 启动 game 与网页代理，检查 `/healthz`、`/readyz`、公网版本、管理员登录，并做一次注册与钓鱼冒烟。

清档不可逆；如果第 6 步需要回到旧数据，只能恢复第 1 步的备份。

环境变量沿用既有运维方式，不写入仓库：

```bash
export FISHING_GO_MIGRATION_DATABASE_URL='postgres://schema_owner:REPLACE_ME@127.0.0.1:5432/fishing?sslmode=verify-full'
./bin/reset fresh               # 只读预演，打印将保留与将清空的表
./bin/reset fresh --confirm     # 实际清档
```

## 保留与清空的判定

清空范围按数据库实际目录动态计算：`fishing` schema 中除下表外的所有基表都会被清空，因此后续迁移新增的玩家表自动纳入，不需要手工维护清单。

| 处理 | 表 | 原因 |
|---|---|---|
| 保留 | `item_definitions` | 物品定义属于目录配置，不是玩家存档 |
| 保留 | `operator_settings` | 运营参数（商城、熔炼、纪录、掉落等覆盖值） |
| 保留 | `banner_state` | 公告队列与串行修订，运营配置 |
| 保留 | `mail_tracking` | 邮件 worker 的迁移期起点单例行 |
| 保留 | `party_guard`、`catch_record_moderation_guard` | 迁移期创建的串行修订单例行 |
| 保留 | `wiki_state` | 官方 Wiki 修订水位单例行 |
| 清空后重建空头 | `catalog_head`、`feature_head` | 发布头引用的 release 行随 `accounts`/`asset_operations` 一起清空，必须恢复成空白头 |

清空后命令会在同一批步骤中重建可启动状态：重播物品定义（`workshop.SeedDefinitions`）、重建发布空头、按内置内容恢复官方 Wiki 指南。被清空的运营规则发布（`catalog_releases`、`feature_releases`）不会恢复，生效目录回落到二进制内置默认值；管理员、运营设置与公告需要按第 5 步及后台流程重新配置。

## 安全边界

- 执行前先做 `migrations.Check`，schema 与二进制不一致时拒绝运行。
- 使用共享的 `application_name='fishing-go'`（见 `server-go/internal/platform/postgres/pool.go`）检测其他进程连接，运行中的 game 即使空闲也会被识别。
- 清空在单个事务里完成，失败整体回滚；`RESTART IDENTITY` 让新账号从 1 开始编号。
- 命令只使用 schema 管理连接，不需要也不应使用超级用户；运行角色权限不受影响。

## 新增迁移时的维护

若后续迁移引入新的“启动必需单例行”，必须同时把它加入 `server-go/internal/app/reset.go` 的 `freshSavePreserved` 或 `freshSaveRebuildRows`，并在下一次预演输出里确认；否则清档后可能缺少必要行，`/readyz` 会明确拒绝就绪。

## 本仓库验收

- 合成真库（`deploy/go-test` 的隔离 PostgreSQL 18.6）：`go build ./...`、`go vet ./...`、`go test -count=1 ./...` 均退出 0。`internal/app` 的 `TestIntegrationFreshSave*` 覆盖清空与保留判定、`catalog_head`/`feature_head` 空头重建、官方 Wiki 恢复、迁移账本不变、序列重新从 1 开始、清档后运行角色就绪，以及存在 `fishing-go` 连接时拒绝执行。
- CLI 冒烟（临时库 `reset_smoke`）：`cmd/migrate up` 与 `cmd/catalog defaults` 之后执行 `reset fresh`（只读预演）与 `reset fresh --confirm`。清档后 `fishing` schema 的 91 张表全部保留：玩家表为 0 行，`item_definitions` 146 行、官方指南 13 条、`catalog_head` 与 `feature_head` 各 1 行、`public.fishing_schema_migrations` 仍为 34 条；非法参数按 usage 报错并以非零状态退出。
- `tests/linux-deploy.test.py` 20/20 通过，覆盖发行包允许且必须包含 `bin/reset`。
- 以上均针对合成数据，未连接也未修改正式服数据库；正式执行前仍须按“操作步骤”备份并在维护窗口停服。

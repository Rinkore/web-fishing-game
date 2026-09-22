# 双 0027 migration 基线验收（2026-09-22）

## 验证对象与边界

- 审阅起点：`codex/go-rewrite`，HEAD `603c945d6181de83aec00a077e3af0a90ebe7483`。
- 本次定向验收对象：上述 HEAD 的工作树，加本报告列出的三个 migration Go 文件。此处不是对旧 HEAD 二进制的通过声明；最终冻结的 `BASE_SHA` 及全套/Linux race 结论由基线总报告记录。
- 验证时间：2026-09-22，宿主时区 Asia/Shanghai；数据库时区 `Etc/UTC`。测试时间戳均写明 `Z`。
- 实际嵌入迁移文件：28 份。两份 `0027` 为不同完整文件名，不按数字前缀去重。
- 全程仅合成数据，未访问正式数据库、旧服存档或正式服务，未执行 push、发布或部署。

## 审核结论与修复

`steps()` 对完整文件名执行升序排序。新空库和从 0026 升级时，顺序为 `0027_admin_market.sql`、`0027_record_hides.sql`。两者互不依赖：前者修改 0007 建立的订单表与守卫函数；后者使用 0018 的渔获记录和既有不可变审计触发器。

原 `compatible()` 要求账本必须是当前完整排序的连续前缀，因而拒绝记录分支的既有历史：`0001..0026 + 0027_record_hides.sql`。新增的受限兼容逻辑只在执行 `Apply` 时接受这一明确形态，补应用缺失的 `0027_admin_market.sql`，不改写已应用行。运行服务的 `Check` 仍要求全部迁移已应用。

受限例外不会容忍其他历史空洞：0026 或更早缺失、未知名称、名称替换、既有摘要不符，以及已应用后续迁移却仍缺 admin migration，均拒绝。事务锁、失败回滚和正常前缀升级逻辑不变。

两份已经提交的 SQL 名称、内容和 SHA-256 **均未修改**。`history_test.go` 固定校验以下摘要，防止将来的格式化或换行修改悄悄改变历史：

| 文件 | SHA-256 |
| --- | --- |
| `0027_admin_market.sql` | `049cc5f42a795a0aa4db2aff59ba0cd9d3cbb70eac7e01b150115e77281fe241` |
| `0027_record_hides.sql` | `7796ef29efd46af97622cd2b25b9bfcc5f92271ca0e9c112dff1b27c84ab8b84` |

## 真实 PostgreSQL 验证

验证命令在 `server-go` 中运行，`FISHING_GO_TEST_DATABASE_URL` 显式指向本窗口独立测试 bootstrap 库。每个测试再创建随机独立数据库，结束时清理。

```powershell
& "$env:LOCALAPPDATA\FishingGoToolchains\go1.27.1\go\bin\go.exe" test -count=1 -v -timeout=5m ./migrations
```

| 环境项 | 实际值 |
| --- | --- |
| Go | `go1.27.1 windows/amd64` |
| PostgreSQL | `18.6 (Debian 18.6-1.pgdg12+2)` |
| PostgreSQL 镜像摘要 | `sha256:3725f4e2499eef5134592b3b4ab79a543ed7f8e533b05b5b637af926630f6650` |
| Compose project | `fishing-go-baseline-0d418737ed` |
| 动态 loopback 地址 | `127.0.0.1:63354` |
| bootstrap 库 | `fishing_test` |
| package 用时 / 退出码 | `5.275s` / `0` |
| 顶层测试 / 含子测试 | `9/9` / `21/21` |
| 跳过 / 失败 | `0` / `0` |

| 路径 | 检查点 | 结果 |
| --- | --- | --- |
| 新空库 | 完整 28 份账本；双 0027 按完整文件名顺序应用；重新 Apply 不改账本 | 通过 |
| 已应用到 0026 | 追加两份 0027；保留历史账本摘要/应用时间、钱包、市集订单、渔获数据 | 通过 |
| 已应用 admin 0027 分支 | 追加 record_hides；既有多订单共用一次资产操作、admin `source/supply_id` 保留 | 通过 |
| 已应用 records 0027 分支 | 受限兼容例外补 admin_market；既有隐藏记录、moderation revision、账本时间不变 | 通过 |

四路径均确认升级后能写入新 admin 供给和新 record hide。市集 `source/supply_id` 身份字段不可修改，`catch_records` 不可改写，`catch_record_hides` 不可删除。篡改 record migration 摘要的历史被拒绝，失败后未写入 admin schema，也未重写账本。

同次运行还通过既有迁移并发应用、DDL 失败整体回滚、图鉴升级保留、金币幂等历史保留、装备和库存升级保留测试。Go 文件已执行 gofmt，专项 `git diff --check` 退出码为 0。

## 证据位置与内容指纹

完整日志位于已忽略目录：`output/go-rewrite/baseline-20260922/migration-focused.log`；终端仅显示末 40 行及退出码。退出码单独保存为同目录 `migration-focused.exit.txt`。定向验证源文件指纹如下，供冻结基线时核对代码没有在验收后变化：

| 对象 | SHA-256 |
| --- | --- |
| `server-go/migrations/migrate.go` | `8a8315cbd93afab16051f29047acf8f6736a6e2a243dc9e76b896ab36f95898a` |
| `server-go/migrations/history_test.go` | `fee169e80d9303725f2bdba2ec4aafd4ddcfd5f00dba7d9d34aa2981cfef9255` |
| `server-go/migrations/merged_0027_test.go` | `f29d23624b01488fb4470f47345705f098698d17d3802dd031754be909bd005d` |
| `migration-focused.log` | `c5af97ef147977315a885069d430b326d0a61ff086baa376eaae09424772f438` |

## 剩余验收边界

- 本报告证明真实 PostgreSQL 合成数据上的 schema 升级和历史保留，不证明旧服数据导入、停服迁移、生产角色授权、容量、持久磁盘、备份恢复或正式切换。
- 本报告不计路由注册、契约或浏览器 A/B 通过数；这些证据单独统计。
- 全项目 build/vet/真实 PostgreSQL 全套及 Linux race 由集成窗口统一运行，不能用本专项通过替代。
- 本次历史专项之后，集成窗口已在最终源码上重新纳入完整验收；最新提交、Windows/Linux 证据与时区以 [共同基线验收报告](BASELINE_ACCEPTANCE_2026-09-22.md) 为准，不覆盖本报告原 UTC 数据库批次。
- 若上述 Go 实现、嵌入 SQL 或测试夹具在验收后改变，须对新候选重新运行受影响验收。新 migration 的编号和顺序统一协调，禁止沿用分支各自任意编号的方式。

# Go 后端重构起点

架构基线见 [go-architecture.md](../docs/go-architecture.md)，最新实施状态见 [DELIVERY.md](../docs/go-rewrite/DELIVERY.md)，剩余优先级与契约缺口见 [REMAINING.md](../docs/go-rewrite/REMAINING.md)。当前已有身份认证、多个玩法的 v1 API/SSE、资产/交易/经济/海域事务、普通地图和远洋正式周期、递归分段恢复和运行时 catalog 发布。截至 2026-09-22，非开发旧 HTTP/SSE 路由按 method + path 静态覆盖 **152/152**；这不等于全部契约或浏览器通过，旧前端全流程和完整后台行为仍未验收。用户已确认业务版本 v0.21.4，正式数据迁移留到后续停服阶段。

Go **1.27.1**（下载档案需核对官方 SHA-256），Node **24.14.0**。直接依赖为 chi **v5.3.2**、pgx **v5.11.0**、x/crypto **v0.43.0**，全部版本及校验见 go.mod/go.sum；运行时依赖清单见 dependencies.json，许可见 THIRD_PARTY_NOTICES.md。

本次 Windows 工具链独立安装于 `%LOCALAPPDATA%\FishingGoToolchains\go1.27.1\go`，未修改系统 PATH。新开 PowerShell 可先执行：

```powershell
$env:Path = "$env:LOCALAPPDATA\FishingGoToolchains\go1.27.1\go\bin;$env:Path"
```

安装包为 [官方 go1.27.1.windows-amd64.zip](https://go.dev/dl/go1.27.1.windows-amd64.zip)，已核对官方 SHA-256：`a3911b5e0e1b1053f25ed0675f4c1c6aad1e2bfcf253df2b9be4caabd2edd95d`。

## 本地验证

在仓库根运行：

```powershell
npm run go:inventory
npm run go:coverage
npm run go:baseline:test 2>&1 | Select-Object -Last 40
```

`go:coverage` 按非开发 inventory 的唯一 method + path 检查 Go 静态注册；`node tools/go-rewrite/route-coverage.js --ref <SHA> --json` 可复现指定提交的逐路由报告及源码摘要。该结果不执行 HTTP/SSE 契约或浏览器场景。正式验收的测试完整输出须另存忽略目录，显示末 40 行并保留原退出码，不能将管道末端的成功状态当成测试成功；并行规范见 [PARALLEL_ACCEPTANCE.md](../docs/go-rewrite/PARALLEL_ACCEPTANCE.md)。

在 server-go 中运行：

```powershell
gofmt -l .
go build ./...
go vet ./...
go test -count=1 ./... 2>&1 | Select-Object -Last 40
```

CI 配置在 Windows 和 Linux 上执行以上检查，并设置独立 PostgreSQL 集成/race 任务。流水线配置不代表远程已执行成功。本机已经通过 Docker PostgreSQL 集成测试以及 Linux 容器 race 检测。

在仓库根执行独立数据库测试：

```powershell
# Windows Go + Docker PostgreSQL
./tools/go-rewrite/test-postgres.ps1 -GoExe "$env:LOCALAPPDATA\FishingGoToolchains\go1.27.1\go\bin\go.exe"
# Linux Go + PostgreSQL 均在 Docker 中，包含 race 与 vet
./tools/go-rewrite/test-postgres.ps1 -Linux
```

脚本每次生成唯一 Compose 项目，动态分配 loopback 端口，使用 tmpfs 测试数据，完成后清理自己的容器/网络。默认超时 15m，可用 `-Timeout` 调整；完整 JSONL、工具链、数据库版本/时区、退出码、跳过清单及摘要保存 `output/go-postgres/<唯一项目>/`，可用 `-LogRoot` 改日志根目录。摘要拒绝未完成运行和缺少真库环境的跳过；浏览器默认跳过，需显式启用。测试数据库必须名为 `fishing_test`；测试内部再创建随机独立数据库和受限登录角色，清理时仅删除这些测试资源。未连接正式数据库，未挂载任何旧服存档。tmpfs 测试只证明事务/并发行为，不证明磁盘持久性、WAL 空间或灾难恢复能力。

测试镜像版本与摘要已固定到 [compose.yml](../deploy/go-test/compose.yml)。本机直连 Docker Hub 失败，本轮使用以下镜像站引用；其他环境可直接使用默认官方地址：

```powershell
$env:FISHING_GO_POSTGRES_IMAGE = 'm.daocloud.io/docker.io/library/postgres:18.6-bookworm@sha256:3725f4e2499eef5134592b3b4ab79a543ed7f8e533b05b5b637af926630f6650'
$env:FISHING_GO_TEST_IMAGE = 'm.daocloud.io/docker.io/library/golang:1.27.1-bookworm@sha256:69a7b9788769bec032d238959b61854e9ae87f57be9029ec04e9885fabf99195'
$env:FISHING_GO_TEST_GOPROXY = 'https://goproxy.cn'
```

也可自行设置 `FISHING_GO_TEST_DATABASE_URL` 后执行 go test；它必须指向隔离 PostgreSQL 的 `fishing_test` bootstrap 库，账号需要创建测试库/角色的权限。未设置时集成测试会明确跳过；不可把这样的运行当成集成验收。

本机另有一份便携 PostgreSQL 18（非 Docker、非系统服务）在 `%LOCALAPPDATA%\FishingGoTestPg`，监听 `127.0.0.1:5433`，凭据与 [compose.yml](../deploy/go-test/compose.yml) 相同，可直接用于真库套件：

```powershell
$env:FISHING_GO_TEST_DATABASE_URL = 'postgres://fishing_test_admin:local-test-only@127.0.0.1:5433/fishing_test?sslmode=disable'
& "$env:LOCALAPPDATA\FishingGoToolchains\go1.27.1\go\bin\go.exe" test -count=1 -timeout=15m ./...
```

## 原前端浏览器回归

`TestIntegrationLegacyBrowserConfigBannerParty` 使用真实 PostgreSQL、原后台和玩家页面，验证公告发布/停止、catalog/功能更新、管理员解散编队、玩家 SSE，以及原注册表单/挑战 Worker/重新登录。默认 Go 测试跳过浏览器；显式提供安装了 `playwright-core` 的 Node 环境和本机 Chrome 后执行：

```powershell
# 保留上文隔离测试数据库的 FISHING_GO_TEST_DATABASE_URL。
$env:FISHING_GO_BROWSER_NODE = 'C:\path\to\node.exe'
$env:NODE_PATH = 'C:\path\to\node_modules'
go test ./internal/gateway -run TestIntegrationLegacyBrowserConfigBannerParty -v -count=1 -timeout=4m
```

浏览器中的测试账号与服务只存在于临时夹具，凭据通过标准输入传递。此项是定向浏览器回归，完整 Node/Go 浏览器 A/B 仍见 REMAINING 清单。

## 启动基础服务

在 server-go 中设置隔离开发数据库连接（下列凭据仅为占位符）：

```powershell
# 由独立 schema 管理账号执行新库结构升级；不导入旧服存档。
$env:FISHING_GO_MIGRATION_DATABASE_URL = 'postgres://schema_owner:REPLACE_ME@127.0.0.1:5432/fishing_dev?sslmode=disable'
go run ./cmd/migrate up
# 新建数据库还必须初始化物品定义。只建表也能展示内置钓点，
# 但无法入账鱼获；此命令使用上面的 schema 管理连接，已有定义须完全一致。
go run ./cmd/catalog defaults
# 应用账号需要结构账本及业务表的适当权限，不能使用超级用户。
$env:FISHING_GO_DATABASE_URL = 'postgres://fishing_app:REPLACE_ME@127.0.0.1:5432/fishing_dev?sslmode=disable'
go run ./cmd/game --role=all
```

`sslmode=disable` 仅用于本机隔离开发连接；跨主机部署应显式启用并验证 TLS。game 不会创建数据库、表或运行存档迁移。未设置连接、连接不可用、schema 版本不匹配或监听失败时以非零状态退出，日志不输出连接串/底层驱动错误。

正式服需要“全新存档”（清空玩家数据、保留字段、权限与已发布运营配置）时使用 `cmd/reset`：`reset fresh` 只读预演并打印将保留、只留配置行与清空的表，`reset fresh --confirm` 才实际执行；已发布的目录/规则快照、功能开关、物品定义、运营设置与公告都保留，清档后服务器按同一份配置运行。执行前必须停服并完成备份，执行后需要重新初始化管理员。范围、判定与验收步骤见 [全新存档说明](../docs/go-rewrite/FRESH_SAVE.md)。

默认监听 `127.0.0.1:9000`，并从 `FISHING_GO_FRONTEND_DIR` 托管浏览器静态文件；`GET /healthz` 返回进程存活；`GET /readyz` 在数据库可达、schema 兼容、生效 catalog 的物品定义完整且分类/装备部位一致、并且未关闭时返回 200，否则 503。启动监听前执行相同检查；漏做物品初始化会明确拒绝启动，运行中缺失定义会使就绪检查失败。此检查只读，不自动写入或覆盖管理员配置。就绪响应包含 `scope: infrastructure`，尚不表示完整游戏业务可用。DB 故障不会让存活探针失败，避免应用因数据库短暂故障无限重启；探针最多一个在途、独立超时。新玩法路由见 [GAMEPLAY_API.md](../docs/go-rewrite/GAMEPLAY_API.md)，其余 URL 返回 404，非 GET 探针返回 405。

all 服务启动原型和默认正式钓鱼调度器（各 25ms 扫描、最多 100 候选/8 执行者）、市集/交易到期和独立自动出售任务。普通启动不会自动生成账号、资产或钓鱼会话。收到 Ctrl+C/Linux SIGTERM 后转为未就绪，停止后台任务并等待在途请求和任务退出，再关闭连接池；HTTP 超时会关闭连接并报告错误。v1 SSE 已有资产修订及重拉通知；旧 `/events` 已接个人 catch/资产快照、公共动态、交易/市集/好友/编队、配置/公告和海域驱逐，并接入多标签页租约与重连续钓。正常停服发送 maintenance；完整通知历史、全流程浏览器与容量仍待验收。

| 环境变量 | 默认值 | 约束 |
|---|---|---|
| FISHING_GO_DATABASE_URL | 必填 | 通过环境注入；不写入仓库/日志 |
| FISHING_GO_LISTEN | 127.0.0.1:9000 | host:port，端口 1～65535 |
| FISHING_GO_FRONTEND_DIR | empty | `run.bat`/发行包自动设置为 `frontend`；留空时仅提供 API |
| FISHING_GO_NODE_ID | local | 1～64 位字母/数字/点/下划线/连字符 |
| FISHING_GO_ROLE | all | 仅支持 all；命令行 --role 优先 |
| FISHING_GO_DB_MAX_CONNS | 16 | 1～64；实际预算需按数据库容量再定 |
| FISHING_GO_STARTUP_TIMEOUT | 5s | 100ms～1m |
| FISHING_GO_PROBE_TIMEOUT | 1s | 100ms～5s |
| FISHING_GO_SHUTDOWN_TIMEOUT | 10s | 100ms～1m |
| REGISTER_GLOBAL_HOURLY | 200 | 正整数；有效注册尝试的全局小时配额 |
| REGISTER_IP_HOURLY | 10 | 正整数；按实际 TCP 来源的小时配额；非法配置沿用默认 |

连接层固定连接超时 3s、SQL 超时 5s、锁等待 1s、事务空闲 10s，并强制 `synchronous_commit=on`；这些设置不替代耐久性测试。身份认证、管理员 MFA 和管理接口已经接入；schema 运维角色与受限应用角色分离，应用运行形态当前仍为单一 all 角色。生产权限配置须独立审阅。资产事务、锁序、幂等、装备/钓竿语义与故障边界见 [ASSETS.md](../docs/go-rewrite/ASSETS.md)。

当前 schema 包含 `0025_registration_guard.sql`、`0026_wiki_store.sql`，以及两份不同的 `0027_admin_market.sql`、`0027_record_hides.sql`。迁移器按完整文件名排序并以完整文件名记账，两个 0027 不是互相替代的版本；不得为了编号整齐改名、重写内容或摘要。新空库与已有历史的升级必须分别验证。已有迁移摘要保持不变，升级保留金币历史、分类库存、装备、钓竿和图鉴。ApplyChange、ExchangeAssets、ChangeRod 和模块 Run 共用命令事务，钓鱼进度和挂单状态与资产共同提交；不接受客户端直接提交奖励或费用计划。合成原型的历史边界见 [PROTOTYPE.md](../docs/go-rewrite/PROTOTYPE.md)，默认正式周期及剩余兼容工作见 [NATIVE_FISHING.md](../docs/go-rewrite/NATIVE_FISHING.md)。新增表的运行期权限及协议范围见 [DELIVERY.md](../docs/go-rewrite/DELIVERY.md)。

依赖升级后在仓库根执行 `tools/go-rewrite/dependencies.ps1 -GoExe <go.exe路径>` 更新版本清单和许可。网络无法直达默认代理时，可仅为当前 PowerShell 设置 `$env:GOPROXY = 'https://goproxy.cn'`，保持默认 sumdb 校验。

## 只读扫描离线存档

2026-09-22 起迁移工具、权限、备份恢复及合成切换演练由 migration 专项线并行推进。以下扫描器只是现有实现；正式快照获取、正式数据库写入与真实切服不在本次授权内。

先由运营方正常保存并停写，取得完整、一致的离线副本；不要直接指向运行中的数据目录。目录应包含 accounts/ 及对应世界域文件；Wiki SQLite 副本应采用正确的数据库备份方式，不能随意丢弃 WAL 文件。扫描器不证明复制过程一致性。

```powershell
# 在 server-go 目录；下面均为示例路径，需替换成实际离线目录。
go run ./cmd/import-legacy --snapshot E:\offline\fishing-save --source-version v0.21.4 --output E:\offline\scan-report.json
```

源版本是操作者声明，必须独立核实。输出父目录须事先存在，报告必须在快照外，已有报告不覆盖。退出码：0＝本轮已实现检查无异常；1＝报告发现问题；2＝参数/访问/输出失败。`go run` 会包装非零退出码，自动化需要精确区分 1/2 时先 `go build -o bin/import-legacy.exe ./cmd/import-legacy` 再直接执行。

报告中的 `importReady` 始终为 false，`pending` 列出尚未完成的核查。文件以字典序编号，避免输出账号文件名；SHA-256 基于原始文件字节，manifest 摘要覆盖相对路径、长度和摘要。报告虽然脱敏，仍应按运维资料受控保存。`migration-private/` 和 `output/` 已被 Git 忽略，勿把真实快照复制到 testdata/。

目前检查 JSON 格式/重复键、数值安全范围、账号重名、金币/库存/鱼类预留、挂单 ID/数量/价格/卖家引用、缺失世界域与未识别文件。历史单文件存档和未知文件保留为问题，不静默忽略。单个 JSON 限制 64 MiB、嵌套 128 层；超限必须人工评估，不能直接视为丢弃数据的依据。

尚未验证全部字段、装备编码与引用、管理员/MFA 兼容、会话、远洋/编队、世界配置语义、Wiki 数据库内容，也没有写入 PostgreSQL。不可凭本报告放行导入。

## 基线更新

```powershell
node tools/go-rewrite/inventory.js --write
node tools/go-rewrite/rules-fixture.js --write
```

在仓库根运行，仅在业务变更已核对后更新。API 清单记录源码定位、开发环境接口标记、持久化域键、40 个客户端事件分支，以及服务端 type 字面量候选（包括非 SSE 用途）；权限、负载、错误和幂等契约仍需逐项复核。源码摘要归一化换行以兼容 Windows/Linux，存档摘要不归一化。

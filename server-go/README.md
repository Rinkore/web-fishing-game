# Go 后端重构起点

架构基线见 [go-architecture.md](../docs/go-architecture.md)，实施状态见 [IMPLEMENTATION.md](../docs/go-rewrite/IMPLEMENTATION.md)。当前提供基础 HTTP 服务、数据库结构版本管理、金币转账事务和 M0 工具；玩法 API/SSE、认证及完整资产系统尚未实现。用户已确认业务版本 v0.21.4，正式数据迁移留到后续停服阶段。

Go **1.27.1**（官方稳定版，下载档案需核对官方 SHA-256），Node **24.14.0**。直接依赖为 chi **v5.3.2**、pgx **v5.11.0**，全部版本及校验见 go.mod/go.sum；运行时依赖清单见 dependencies.json，许可见 THIRD_PARTY_NOTICES.md。

本次 Windows 工具链独立安装于 `%LOCALAPPDATA%\FishingGoToolchains\go1.27.1\go`，未修改系统 PATH。新开 PowerShell 可先执行：

```powershell
$env:Path = "$env:LOCALAPPDATA\FishingGoToolchains\go1.27.1\go\bin;$env:Path"
```

安装包为 [官方 go1.27.1.windows-amd64.zip](https://go.dev/dl/go1.27.1.windows-amd64.zip)，已核对官方 SHA-256：`a3911b5e0e1b1053f25ed0675f4c1c6aad1e2bfcf253df2b9be4caabd2edd95d`。

## 本地验证

在仓库根运行：

```powershell
npm run go:inventory
npm run go:baseline:test 2>&1 | Select-Object -Last 40
```

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

脚本每次生成唯一 Compose 项目，动态分配 loopback 端口，使用 tmpfs 测试数据，完成后清理自己的容器/网络。测试数据库必须名为 `fishing_test`；测试内部再创建随机独立数据库和受限登录角色，清理时仅删除这些测试资源。未连接正式数据库，未挂载任何旧服存档。tmpfs 测试只证明事务/并发行为，不证明磁盘持久性、WAL 空间或灾难恢复能力。

测试镜像版本与摘要已固定到 [compose.yml](../deploy/go-test/compose.yml)。本机直连 Docker Hub 失败，本轮使用以下镜像站引用；其他环境可直接使用默认官方地址：

```powershell
$env:FISHING_GO_POSTGRES_IMAGE = 'm.daocloud.io/docker.io/library/postgres:18.6-bookworm@sha256:3725f4e2499eef5134592b3b4ab79a543ed7f8e533b05b5b637af926630f6650'
$env:FISHING_GO_TEST_IMAGE = 'm.daocloud.io/docker.io/library/golang:1.27.1-bookworm@sha256:69a7b9788769bec032d238959b61854e9ae87f57be9029ec04e9885fabf99195'
$env:FISHING_GO_TEST_GOPROXY = 'https://goproxy.cn'
```

也可自行设置 `FISHING_GO_TEST_DATABASE_URL` 后执行 go test；它必须指向隔离 PostgreSQL 的 `fishing_test` bootstrap 库，账号需要创建测试库/角色的权限。未设置时集成测试会明确跳过；不可把这样的运行当成集成验收。

## 启动基础服务

在 server-go 中设置隔离开发数据库连接（下列凭据仅为占位符）：

```powershell
# 由独立 schema 管理账号执行新库结构升级；不导入旧服存档。
$env:FISHING_GO_MIGRATION_DATABASE_URL = 'postgres://schema_owner:REPLACE_ME@127.0.0.1:5432/fishing_dev?sslmode=disable'
go run ./cmd/migrate up
# 应用账号需要结构账本及业务表的适当权限，不能使用超级用户。
$env:FISHING_GO_DATABASE_URL = 'postgres://fishing_app:REPLACE_ME@127.0.0.1:5432/fishing_dev?sslmode=disable'
go run ./cmd/game --role=all
```

`sslmode=disable` 仅用于本机隔离开发连接；跨主机部署应显式启用并验证 TLS。game 不会创建数据库、表或运行存档迁移。未设置连接、连接不可用、schema 版本不匹配或监听失败时以非零状态退出，日志不输出连接串/底层驱动错误。

默认监听 `127.0.0.1:19001`。`GET /healthz` 返回进程存活；`GET /readyz` 在数据库可达、schema 兼容且未关闭时返回 200，否则 503。就绪响应包含 `scope: infrastructure`，尚不表示完整游戏业务可用。DB 故障不会让存活探针失败，避免应用因数据库短暂故障无限重启；探针最多一个在途、独立超时。其他 URL 返回 404，非 GET 探针返回 405。

收到 Ctrl+C/Linux SIGTERM 后先转为未就绪，再等待在途请求；超时会关闭连接并报告错误。尚未接入 SSE，其连接排空与写超时将在实时模块中单独实现。

| 环境变量 | 默认值 | 约束 |
|---|---|---|
| FISHING_GO_DATABASE_URL | 必填 | 通过环境注入；不写入仓库/日志 |
| FISHING_GO_LISTEN | 127.0.0.1:19001 | host:port，端口 1～65535 |
| FISHING_GO_NODE_ID | local | 1～64 位字母/数字/点/下划线/连字符 |
| FISHING_GO_ROLE | all | 仅支持 all；命令行 --role 优先 |
| FISHING_GO_DB_MAX_CONNS | 16 | 1～64；实际预算需按数据库容量再定 |
| FISHING_GO_STARTUP_TIMEOUT | 5s | 100ms～1m |
| FISHING_GO_PROBE_TIMEOUT | 1s | 100ms～5s |
| FISHING_GO_SHUTDOWN_TIMEOUT | 10s | 100ms～1m |

连接层固定连接超时 3s、SQL 超时 5s、锁等待 1s、事务空闲 10s，并强制 `synchronous_commit=on`；这些设置不替代耐久性测试。角色拆分、认证和管理接口尚未开放。金币资产事务、锁序、幂等与故障边界见 [ASSETS.md](../docs/go-rewrite/ASSETS.md)。

依赖升级后在仓库根执行 `tools/go-rewrite/dependencies.ps1 -GoExe <go.exe路径>` 更新版本清单和许可。网络无法直达默认代理时，可仅为当前 PowerShell 设置 `$env:GOPROXY = 'https://goproxy.cn'`，保持默认 sumdb 校验。

## 只读扫描离线存档

当前按用户要求暂停此项；以下命令留作未来停服迁移阶段参考。

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

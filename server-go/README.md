# Go 游戏服务

`server-go` 是仓库唯一的服务端实现，使用 Go 和 PostgreSQL。服务进程同时托管 `frontend/` 静态文件、游戏 API、SSE、管理 API 和数据库迁移。

## 构建与验证

```powershell
gofmt -w .
go build ./...
go vet ./...
go test -count=1 ./...
```

真实 PostgreSQL 集成测试必须连接隔离数据库 `fishing_test`，不能指向生产库。CI 会执行格式、构建、vet、单元测试和 Linux race 检查。

## 启动

先用 schema 管理账号执行：

```powershell
$env:FISHING_GO_MIGRATION_DATABASE_URL = 'postgres://schema_owner:REPLACE_ME@127.0.0.1:5432/fishing_dev?sslmode=disable'
go run ./cmd/migrate up
go run ./cmd/catalog defaults
```

再用业务账号启动：

```powershell
$env:FISHING_GO_DATABASE_URL = 'postgres://fishing_app:REPLACE_ME@127.0.0.1:5432/fishing_dev?sslmode=disable'
$env:FISHING_GO_FRONTEND_DIR = '../frontend'
$env:FISHING_GO_LISTEN = '127.0.0.1:9000'
go run ./cmd/game --role=all
```

`cmd/migrate` 只维护 PostgreSQL schema；它不导入旧离线存档。`cmd/repo-tool` 负责 Go 快照校验、版本读取、SQL 迁移摘要和发行清单生成。

## 数据与安全边界

正式服需要“全新存档”（清空玩家数据、保留字段、权限与已发布运营配置）时使用 `cmd/reset`：`reset fresh` 只读预演并打印将保留、只留配置行与清空的表，`reset fresh --confirm` 才实际执行；已发布的目录/规则快照、功能开关、物品定义、运营设置与公告都保留（玩家投稿仍会被清掉），清档后服务器按同一份配置运行。执行前必须停服并完成备份，执行后需要重新初始化管理员。范围、判定与验收步骤见 [全新存档说明](../docs/go-rewrite/FRESH_SAVE.md)。

默认监听 `127.0.0.1:9000`，并从 `FISHING_GO_FRONTEND_DIR` 托管浏览器静态文件；`GET /healthz` 返回进程存活；`GET /readyz` 在数据库可达、schema 兼容、生效 catalog 的物品定义完整且分类/装备部位一致、并且未关闭时返回 200，否则 503。启动监听前执行相同检查；漏做物品初始化会明确拒绝启动，运行中缺失定义会使就绪检查失败。此检查只读，不自动写入或覆盖管理员配置。就绪响应包含 `scope: infrastructure`，尚不表示完整游戏业务可用。DB 故障不会让存活探针失败，避免应用因数据库短暂故障无限重启；探针最多一个在途、独立超时。其余 URL 返回 404，非 GET 探针返回 405。

应用启动只检查数据库连接、schema 和 catalog，不会自动创建数据库、覆盖运营配置或迁移旧数据。普通业务账号不应拥有 schema 变更权限。正式部署前单独完成备份恢复、权限和故障演练。

`GET /healthz` 只表示进程存活；`GET /readyz` 检查数据库、schema 和 catalog 是否可用。生产配置通过环境变量注入，连接串不写入仓库或日志。

## 目录

- `cmd/game`：游戏服务入口
- `cmd/migrate`：PostgreSQL schema 升级入口
- `cmd/catalog`：默认规则目录发布入口
- `cmd/admin`：管理员 MFA 配置入口
- `cmd/repo-tool`：仓库快照、版本和发行元数据工具
- `internal/gateway`：HTTP/SSE 兼容网关
- `internal/modules`：身份、资产、钓鱼、远航、交易、市场和工坊等业务模块
- `migrations`：按完整文件名记录的 SQL 迁移
- `internal/rules/catalog.json`：审阅后的内置规则快照

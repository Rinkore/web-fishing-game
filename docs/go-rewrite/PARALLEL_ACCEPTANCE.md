# Go 重写并行验收协议

核对日：2026-09-22。本文固定共同基线和四条专项线的边界；所有结论必须引用同一个候选 SHA，不能把不同提交的通过结果拼接成一次验收。本文只约束本地合成测试，不授权 push、发布、生产数据库写入或切服。

## 固定输入

- 业务玩法版本：`v0.21.4`。
- Node 源码提交固定为 `13694a7038438ac0b3dd7df07db8c05ea239141f`，运行时固定 `24.14.0`。本次核对该提交与收口工作树的 `backend/`、`frontend/js/data.js`、`frontend/js/net.js` 无差异；这是玩法对照源，不跟随移动的 main。
- Go toolchain: `go1.27.1`; PostgreSQL: `18.6`. Image, module, and direct dependency digests come from `deploy/go-test/compose.yml`, `server-go/go.mod`, `server-go/go.sum`, and `server-go/dependencies.json`.
- 时区：Node、Go、PostgreSQL（`TZ`/`PGTZ`）和浏览器 context 统一 `Asia/Shanghai`，Windows 对应 `China Standard Time`。此前迁移专项数据库 UTC 的证据仅保留为历史批次；跨日/夏令时专项单独写明覆盖时区。
- Go 直接依赖固定 chi `v5.3.2`、pgx `v5.11.0`、x/crypto `v0.43.0`；间接依赖及校验以共同提交的 go.mod/go.sum 为准，不在专项线自行升级。Node 服务无 npm 运行依赖。本机定向浏览器固定 Playwright Core `1.62.1`、Chrome `153.0.8010.53`，Chrome SHA-256 为 `e8bce39747ea63c9c7d4306f7635d2916c9ecb0cf913fbcf5e7acc4539b5b8a0`；ab 线将此版本变成可安装的测试锁定，跨平台替代或升级必须记录精确版本、摘要，并在同一组合下重跑 Node/Go 双方。
- 旧路由分母：`server-go/api/legacy-inventory.json` 的 157 个候选减去 5 个开发接口；覆盖只按唯一完整 `method + path` 计算。

## Common baseline and evidence

1. 主窗口核对分支为 `codex/go-rewrite`，审阅已有改动后提交干净的 `BASE_SHA`。
2. 在 `BASE_SHA` 上依次保存 `gofmt -l`、`go build ./...`、`go vet ./...`、`go mod verify`、`npm run go:inventory`、`npm run go:coverage` 和 `npm run go:baseline:test` 的完整日志及退出码；终端只显示摘要和失败尾部。
3. 另存 `node tools/go-rewrite/route-coverage.js --ref BASE_SHA --json`。它只证明静态路由注册；HTTP/SSE 契约和浏览器通过必须在报告中独立列出。
4. Windows 真库和 Linux Docker race 必须设置 `FISHING_GO_TEST_DATABASE_URL` 或使用隔离 compose 脚本；没有数据库时的 Go `skip` 不能计为通过。
5. 代码再次改变后冻结新候选 SHA，所有受影响验收从新 SHA 重跑。

## 四线所有权与合并顺序

| 线 | 分支与 worktree（根 E:/AAAworktrees/web-fishing-game/） | 负责范围 | 专属报告前缀 |
|---|---|---|---|
| compat | `codex/go-compat` / `go-compat` | 业务兼容实现、旧接口后端修复 | `COMPAT_` |
| ab | `codex/go-ab` / `go-ab` | API/SSE/浏览器测试框架、覆盖矩阵 | `AB_` |
| resilience | `codex/go-resilience` / `go-resilience` | 完整玩法负载、故障注入、容量、对账 | `RESILIENCE_` |
| migration | `codex/go-migration` / `go-migration` | 导入、权限、备份恢复、切换演练工具 | `MIGRATION_` |

合并顺序固定为 compat → ab → resilience → migration。每次合并后重新构建并运行受影响验收；最后从干净提交构建候选产物。总览 `DELIVERY.md`、`REMAINING.md` 和本文由主窗口维护；专项报告只写入 `docs/go-rewrite/reports/`。

公共 `internal/gateway/http.go`、handler、`internal/testdb/testdb.go`、schema、权限、go.mod/go.sum、compose 和共享工具入口的修改，先在专属报告登记文件、目的、负责人和依赖提交，由主窗口分配唯一负责人。ab/resilience/migration 报告兼容缺陷交 compat 修复，不同时另写一份 handler。数据库权限建议必须区分 schema owner、migration role、runtime role，不能用测试管理员作为正式应用角色。迁移编号由主窗口统一分配；下一号从 0028 起，先登记再实现，禁止重命名已应用 SQL。

## 隔离资源

每条线使用独立数据库名/角色、独立 Docker Compose project、独立 PostgreSQL volume 或 tmpfs、独立输出目录和独立浏览器 profile。连接串、账号和 profile 不得跨线复用。建议目录：

```text
output/go-rewrite/<line>-<candidate>/
FISHING_GO_TEST_DATABASE_URL=...:<unique-port>/fishing_test
FISHING_GO_TEST_LOG_DIR=.../output/go-rewrite/<line>-<candidate>
Node data: <worktree>/output/go-rewrite/<line>-<candidate>/node-data
Browser profile: <worktree>/output/go-rewrite/<line>-<candidate>/profile
```

现有 testdb 明确要求 bootstrap 名为 `fishing_test`：以每次唯一 Compose project/实例/端口隔离，同一实例内每个用例再创建随机独立数据库和角色，不能直接把 bootstrap 改成 line_test。持久负载卷用 `<line>-<candidate>-<run-id>` 命名并记录归属，清理只限本次资源。浏览器独立临时 context 已隔离 Cookie；未实现的 profile 参数不视为已支持。Node 数据目录使用 `FISHING_DATA_DIR`，不得挂载主工作树或正式存档。

Go 默认监听 `127.0.0.1:19001`；并行服务必须显式分配不重叠 loopback 端口（例如 19101–19104），并把端口写入报告。旧测试中仍写死固定端口、固定数据目录或固定 profile 的套件，在完成参数化前必须串行执行；不得用端口复用掩盖冲突。

容量正式测量期间暂停同机其他重负载、浏览器回归和并行 Docker 构建，记录宿主 CPU、内存、磁盘与网络基线。容量结果必须包含 SQL/锁等待、延迟分位数、WAL/空间、在线口径和对账结果；tmpfs 或停止负载后的恢复测试不能替代持久磁盘故障验收。

## Migration 顺序与回滚

迁移器按完整文件名排序并记录完整文件名；两份 `0027_admin_market.sql` 与 `0027_record_hides.sql` 都必须保留。新空库、`0026` 历史库、admin-first 历史和 record-first 历史分别验证；历史摘要、业务数据、权限和失败回滚均须有证据。任何新增 schema 必须先在 migration 线说明，再由主窗口冻结候选后合并，禁止各线自行复用编号。

## 通过口径

- 路由注册：静态 `method + path` 全覆盖、无重复、无未解析表达式。
- HTTP/SSE contract: record status, authentication, errors, idempotency, event order, and real PostgreSQL results per route; registration counts and package tests are not substitutes.
- 浏览器：Node 与 Go 使用同依赖、同夹具、隔离 profile，分别记录通过/失败/跳过；定向 Chrome 通过不能宣称完整 A/B。
- 报告必须写明候选 SHA、固定输入、命令、退出码、跳过/超时/失败及证据路径。

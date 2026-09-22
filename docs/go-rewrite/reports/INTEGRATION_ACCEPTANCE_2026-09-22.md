# Go 重写集成候选验收

核对日期：2026-09-22，分支：`codex/go-rewrite`。本报告由主窗口维护；最终候选 SHA 是包含本报告和总览更新的最后一个干净提交。未 push、未部署、未连接正式数据库、未执行切服。

## 合并对象

- 共同基线：`4e4466e034f4e8ce6b30a109ce3b1bebe8a1cd3b`。
- compat merge：`f5a9c20592f3864e773e5e9e45751e188b649cde`。
- ab merge：`dd6239625f8d0d99585228a629360372651436d4`。
- resilience merge：`02b9b1fcf49808bd0edfe69e8238b4f85819533`。
- migration merge：`f936b73f4ef688c9aaca1dc1e340ea8b3cdec469`。
- 四个 worktree 均从共同基线分叉且合并前干净；保护 tag 为 `codex/go-rewrite-before-integration-20260922`。

## 最终树检查

| 检查 | 结果 | 证据 |
|---|---|---|
| `npm run go:inventory` | 0；157 路由、41 类型候选、0 unresolved | 终端日志/最终工作树 |
| `npm run go:coverage` | 0；152/152、192 注册、0 duplicate/unresolved | `output/go-rewrite/final-route-coverage-20260922-r2.json` |
| API/SSE 静态矩阵 | API 152 routes；SSE 40 types，Node 缺 3、Go 缺 7 | `docs/go-rewrite/reports/AB_API_MATRIX.md`、`output/go-rewrite/ab-sse-contract.json` |
| rule/Wiki/dependency drift | 0；602 oracle cases，Wiki 12 guides/6 updates，8 modules | 终端日志、`server-go/dependencies.json` |
| `gofmt -l .` | 0 | 最终树命令日志 |
| `go build ./...` / `go vet ./...` / `go mod verify` | 均 0 | 最终树命令日志 |

## 同一候选上的验收

- Windows 隔离 PostgreSQL：2816 pass、0 fail、2 skip；skip 为 symlink 不可用和真实浏览器依赖缺失。完整日志：`output/go-rewrite/final-windows-20260922-final/fishing-go-test-dc144a8766/`。
- Linux Docker PostgreSQL race：2817 pass、0 fail、1 skip；`go vet`、`go mod verify`、race 均退出 0。完整日志：`output/go-rewrite/final-linux-20260922-final/fishing-go-test-387854a77b/`。
- migration importer/legacy scanner 定向 PostgreSQL：通过；导入失败回滚、幂等、库存不足、非法到期时间、无关闭账本挂单反例均通过。日志：`output/go-rewrite/final-migration-20260922/migration-tests.log`。
- Node API/SSE smoke：5 pass、0 fail、2 skip（Go A/B 环境变量和独立数据库未提供）；浏览器 A/B：36 skip，未启动真实 Chrome。日志在 `output/go-rewrite/ab/`。
- resilience 专项此前只有 1 人、5/8 秒短测，且通知 p95 超阈值；最终候选尚未完成 100 人 2 小时、1000/5000 阶梯或精确 response-drop/commit-ack 网络注入。

## 判定

不能写“候选通过”或“Go 重写完成”。静态路由、构建、真库包测试和 race 已有同树证据，但 HTTP/SSE 全量语义、浏览器 A/B、容量/故障、迁移全域字段对账和生产放行门槛仍未满足。迁移报告中 records/trade/sea/operator/Wiki WAL 一致性等阻断项继续有效；专项报告中的旧 SHA 和短测只作为历史证据。

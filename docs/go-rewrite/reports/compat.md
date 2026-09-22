# Go Rewrite Compatibility Report

核对输入：Node 固定源码 `13694a7038438ac0b3dd7df07db8c05ea239141f`、Go 1.27.1、PostgreSQL 18.6、Asia/Shanghai。当前 worktree `codex/go-compat` 的业务提交为 `c9ce3df`、`9bed038`、`9f10bd5`，纪录删除回归测试为 `a589cc2`；集成窗口仍需在合并候选 SHA 上复验。本报告不代表已 push 或部署。

## 具体缺口

- 纪录通知只从当前极值重建，丢失后来被超越的历史播报；HTTP `/api/records.last` 重启后为空；删除纪录没有清理最新播报水位。
- 运营配置写入 `operator_settings` 后，部分结算路径仍读取 immutable catalog，形成“保存并回显但玩法未采用”；SSE 也会把旧配置重新投影。
- 旧 rod/sea 写路由没有执行子功能开关；活动渔场的 `openFrom/openTo` 只显示不拦截结算；杆切换把 asset rejection 的 nil error 当成功。

## 运营配置权威链

- 旧行为依据：Node 将商城、熔炼、宝匣保底、经济、产出倍率、自动出售和抛竿参数写入运行期 world，并在 `/api/version`、SSE 与结算路径读取同一份状态。
- 实现：Go 将 gameplay 配置合并进待发布 immutable catalog release；`catalog.Effective` 只读 catalog head，不再在读时覆盖 `operator_settings`。旧配置接口保存/重置均发布新的 catalog；`notifyLevel` 和纪录贴图保留为展示元数据。SSE catalog projection 从有效 release 生成完整 `mallCfg`、`smeltCfg`、`chestCfg`、`priceCfg`、`dropCfg`、`autoSellCfg`，避免重连或旧 operator row 覆盖玩法状态。`ValidateCatalog` 接受并约束 runtime 的价格、自动出售批量、保底和稀有倍率字段。
- 验证命令：
  `docker compose -p fishing-go-compat-target6 -f deploy/go-test/compose.yml up -d --wait --wait-timeout 60 postgres`；
  `docker compose ... --profile linux run --rm -e FISHING_GO_TEST_DATABASE_URL=postgres://fishing_test_admin:local-test-only@postgres:5432/fishing_test?sslmode=disable -e GOPROXY=https://goproxy.cn,direct go-tests ...`。
- 结果：`go test -count=1 -timeout=8m ./internal/modules/catalog ./internal/gateway -run "TestIntegration(EffectiveCatalogUsesOneImmutableSource|LegacyAdminConfigResetPublishesDefaults|LegacySettingsConcurrentMergeAndRollback|LegacyMallSettingChangesSettlement)$"` 通过；上述容器和网络已清理。`gofmt -l` 对受影响文件无输出。

### 兼容差异与影响

- Node 的每日榜 `upsertTopRanked` 只有“入榜前已经满十”才产生 3/4 级播报；Go 按该规则保留未满榜不播报。
- Node 纪录删除命中鱼种时清理 `lastRec`，不回补被删头衔的次佳纪录；Go 的 moderation hide 投影保持相同语义，并在事务内清理持久水位。
- Go 没有为旧 world 增加新 migration；`legacy:records_runtime` 复用已有 `operator_settings` 保存 `lastRec`。它保存的是最近一次 Go settlement 的通知元数据，无法恢复切换到 Go 前仅存在于 Node 内存且未导入的旧 `lastRec`。
- 首次 SSE 历史按提交顺序重放 feed，并保留曾经产生过的纪录等级；同一 poll 对外只发一条最高优先级/最新同级的 `globalRecord`，以避免重连重复刷屏。既有 paging 测试仍期待旧的“前 100 条无 global”抑制，该断言与冻结 Node 的逐事件纪录历史不一致，待 A/B 窗口更新。
- 初始配置帧新增 `autosellcfg`、`chestcfg`，因此旧测试中 8/9 帧的数量断言应分别更新为 10/11；内容和结算验证已通过。

## 纪录与 SSE

- `3c01b85` 的实际内容是 `legacy_catch_push.go` / `legacy_read.go` 的纪录历史、播报等级、榜单刷新和 moderation revision 兼容实现；提交标题与内容不一致，集成时按 diff 审查。
- 该实现已通过先前 gateway 包编译测试；完整真库 race 在源码 SHA `47359da7f1e3a3112f2622e3bf68e303410b5709` 上为 2804 pass、3 fail（旧配置测试断言/overlay 链问题），不作为当前修复后的全套通过结论。失败证据保留在 `output/go-rewrite/compat-3c01b85/` 忽略目录。

## 剩余差异

- 完整 Node/Go HTTP、SSE、浏览器 A/B 仍需集成窗口在冻结候选 SHA 上复验。
- 验证：固定 Docker Go 1.27.1 镜像执行 `gofmt`、`go build ./...`、`go vet ./...` 通过；真实 PostgreSQL 定向配置 4 项、`internal/modules/fishing` 全套和纪录删除/权限回归通过。隔离 Linux race 首轮 `output/go-rewrite/compat-current/fishing-go-test-10d79553f8/` 在 2779 pass / 29 fail / 7 skip 下失败：业务失败集中在并行运行期间的旧测试与早期 runtime SQL 占位符错误；占位符已修复，后续单包真实库复验通过，待在最终候选上重跑全量 race。
- 本窗口没有 push、部署或写正式数据；宿主没有 Go 工具链，验证通过固定 Docker Go 1.27.1 镜像完成。

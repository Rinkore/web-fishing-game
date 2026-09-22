# 共同基线收口验收（2026-09-22）

> 历史基线报告：验证对象是 603c945/401a3f8 批次，不是当前集成候选。当前候选和最终判定见 `INTEGRATION_ACCEPTANCE_2026-09-22.md`。

## 验证对象

起点分支确认 `codex/go-rewrite`，起点 HEAD 为 `603c945d6181de83aec00a077e3af0a90ebe7483`（当时领先本地 origin 引用 12 个提交，未执行 fetch/push）。该提交已包含 world、market、records 三条分支的合并，以及 Wiki 读写。既有工作树中的后台配置、快照、功能开关、路由统计、迁移兼容和报告均审阅后保留并提交，没有重置或丢弃源码。

最终受测代码提交：`401a3f8f7a95d2c567e6a917fb587cbb14cdc4b2`。`server-go` Git tree 为 `d7f47f12f1da5ca5fdbc32a83590daf2cd29f68c`。Windows 和 Linux 正式运行开始时均为干净工作树，run.json 保存此 SHA；后续收口提交只更新文档。最终 `BASE_SHA` 是包含本报告和总览的共同提交，在四个 worktree 创建记录及本轮交付中输出；所有受测源码必须与上述提交完全一致。

Node 对照源码固定 `13694a7038438ac0b3dd7df07db8c05ea239141f`、玩法 v0.21.4、Node 24.14.0、Go 1.27.1、PostgreSQL 18.6。Node backend/data/net 与固定源码无差异。依赖、镜像摘要、时区和四线规则见 [PARALLEL_ACCEPTANCE](../PARALLEL_ACCEPTANCE.md)。正式运行 Node/Go/数据库/浏览器统一 Asia/Shanghai；本机 Chrome 153.0.8010.53、Playwright Core 1.62.1，依赖指纹已保存。

## 本轮修复

- 接续已有 12 条后台注册、配置/功能开关/快照和相应测试；更新运行依赖清单中的 x/crypto 与 x/text 实际版本。
- 世界只读入口复用已合入的权威编辑投影，保留内置默认值、预设、自定义组名/权重、公式和原始掉落组引用。修复 pool、buffs、spot/add 三个 handler 修改临时 grounds 后没有写回 catalog 的问题；真实 HTTP 回归检查保存响应及后续读取。
- 快照先恢复所有保存/活动钓竿，再恢复散件；仍持有的组件复用，确实缺失的组件重新生成并记账，多余部位精确移除。保留旧快照格式兼容，避免组件在保存槽与活动槽重复；装配变化记录 rod_entries 并递增 loadout_rev。覆盖 loose、saved、legacy-saved、consumed 四路径。修复解码复用 map 造成新增部位残留。
- 两份 0027 保持原文件名、字节和摘要；仅允许确切 records-only 历史补 admin_market，服务启动仍要求完整 schema。没有修改已应用 SQL，也没有新建迁移编号。
- 沿用现有 route-coverage、test-postgres 和 summarize 工具，保存完整 JSONL、退出码、缺库/跳过/未完成检测、工具链与清理结果；测试每次使用独立 project、端口、数据库和日志目录。修复 PowerShell 日志捕获的原生命令退出码作用域。

## 验证结果

| 项目 | 对象与结果 |
|---|---|
| Go 格式、构建、vet | 最终代码 gofmt 无文件列表；Windows `go build ./...`、`go vet ./...` 退出 0 |
| 依赖 | `go mod verify` 通过；8 个 runtime modules 与 dependencies.json 一致 |
| inventory / coverage | 157 候选，排除 5 开发路由；最终提交与工作树均 152/152，192 个 Go 注册，0 缺失/重复/未解析 |
| Node 基线 | 7/7，0 失败/跳过；这些是静态工具/基线检查，不是 7 条 HTTP 契约 |
| 规则与内容漂移 | 94 catalog definitions；原始 14 与新增 2537，共 2551 规则 oracle；Wiki 12 攻略/6 更新无漂移 |
| Windows 真库全套 | `fishing-go-test-80c48b9c86`；22 个测试包通过，8 个包无测试；2803 pass、0 fail、1 skip（含父/子测试事件）；gateway 105.322s；test/summary/cleanup exit 均 0 |
| 定向 Chrome | 同次 Windows 真库执行 `TestIntegrationLegacyBrowserConfigBannerParty` 通过，11.77s；包括公告、配置、编队、玩家 SSE、注册挑战/重登；非完整 Node/Go A/B |
| Linux 真库 race/vet | `fishing-go-test-33a5ebfb44`；verify/vet/全套 race 退出 0，22 个测试包通过，8 个包无测试；2803 pass、0 fail、1 skip（可选浏览器），gateway 230.681s；test/summary/cleanup exit 均 0，无 data race |
| schema 历史 | Windows 与 Linux migrations 各 9 顶层、21 含子测试通过，0 skip/fail；新空库、0026、admin-only、records-only 都覆盖，并检查历史时间/数据/约束保留、重复 Apply、篡改拒绝与失败回滚 |

路由原提交 `603c945d6181de83aec00a077e3af0a90ebe7483` 为 140/152，180 个 Go 注册，缺 12 条；它只是历史已提交状态，不与最终工作树数字混用。`coverage-before.json`、`final-coverage-commit.json` 和最终 BASE_SHA 的 `coverage-base.json` 分别保存验证对象及输入摘要。

## 跳过、失败、未执行

- Windows 仅 `internal/legacy/TestSymlinkNotFollowed` 因宿主不支持创建测试符号链接而跳过；浏览器实际执行，真实数据库未跳过。包级 8 个 skip 是 `[no test files]`，不表示 8 个集成用例跳过。
- Linux 仅跳过可选浏览器（未设置 FISHING_GO_BROWSER_NODE，容器未装浏览器）；同提交的 Windows Chrome 已通过该用例。Windows 跳过的符号链接测试在 Linux 已通过。最终两轮均无超时、未完成 JSON 或缺数据库导致的 skip；本轮创建的测试容器和网络已清理，保留运行前已有容器。
- 首次脚本在 Node 版本探测处错误退出（project `e1c384907f`），没有启动真库测试；修复退出码作用域后重跑。
- `b2c04367fd43ea88b93d5dd0ffe25d46b1db0ed4` 真库运行 `a6351b55a0` 失败：2797 pass、6 fail（快照 4 子用例+父用例、world 1）、1 skip。证据保留；修复 map 合并残留、测试 SQL 运算符歧义及掉落池未持久化后重跑。
- `9a9748bf3779cb3b9515682bbf1e6d21f49a2658` 运行 `894a671162` 曾通过，随后修复 buffs/add，因此最终采用 `401a3f8...` 的重新验收，不拼接前一版本结果。
- 一次 `rules-fixture.js --check` 调用退出 1，因为该旧脚本仅支持 `--write`；没有改写 fixture。原始 14 样例由 7 项 Node 基线测试和 Go oracle 检查覆盖，其余支持 --check 的脚本全部通过。
- 审阅助手曾误启动旧 helper，仅留下尾部输出；该次运行不作为正式证据，其测试资源已清理。正式验收仅采用本报告列明的完整日志。
- 完整 152 路由 HTTP/SSE Node/Go 契约矩阵、完整浏览器 A/B、100 人完整玩法持久长测/写入中故障、1000/5000 容量、导入/权限/备份恢复/切换演练均未执行。两项已知实现缺口见 [兼容缺口报告](BASELINE_COMPAT_GAPS_2026-09-22.md)，由 compat 修复、ab 复验。
- 没有 push、Release、生产部署、正式数据库修改或真实切服。

## 完整证据与复现

证据根目录（Git 忽略，留在主 worktree）：`E:/AAAworktrees/web-fishing-game/go/output/go-rewrite/closeout-20260922/`。

- `final-*.log` / `*.exit.txt`：格式、构建、vet、inventory、coverage、Node 基线。
- `*-fixture.log`、`catalog.log`、`wiki-content.log`：规则/内容漂移；`browser-dependencies.json` / `browser-dependency-hashes.json`：浏览器依赖。
- `fishing-go-test-80c48b9c86/`：Windows 完整 JSONL、摘要、run.json、启动/清理及退出码。
- `fishing-go-test-33a5ebfb44/`：Linux 完整 JSONL、verify/vet、摘要、run.json、启动/清理及退出码。
- `fishing-go-test-a6351b55a0/`：保留失败证据；`fishing-go-test-894a671162/`：保留前一提交的通过证据。
- `evidence-manifest.json` / `final-baseline.json`：最终文件 SHA-256 清单、BASE_SHA、受测代码 SHA、源码一致性及四个 worktree 核对。
- 早期迁移定向日志仍保留 `output/go-rewrite/baseline-20260922/migration-focused.log`；历史对象、指纹和范围见 [迁移专项报告](BASELINE_MIGRATIONS_2026-09-22.md)，本轮另以最终全套重新验证。

在根目录设置镜像摘要与代理后使用现有 `tools/go-rewrite/test-postgres.ps1 -GoExe <go.exe> -LogRoot <独立目录> -Timeout 15m`（Windows 开启 FISHING_GO_BROWSER_NODE/NODE_PATH）和 `-Linux`。实际命令分别执行 `go test -json -count=1 -timeout=15m ./...` 与 `go test -race -json -count=1 -timeout=15m ./...`；Linux 先 go mod verify、go vet。每次内部创建独立数据库，禁止使用正式 DSN。全量 stdout/stderr 在证据目录，不能用终端尾部代替。

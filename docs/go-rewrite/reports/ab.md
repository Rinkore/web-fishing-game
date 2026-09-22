# Go 重写旧协议 A/B 初始验收

本报告是 `codex/go-ab` 的框架交付和初始差异记录，不是兼容实现放行单。工作树为 `E:\AAAworktrees\web-fishing-game\go-ab`；本地分支为 `codex/go-ab`。固定共同基线来自 [PARALLEL_ACCEPTANCE.md](../PARALLEL_ACCEPTANCE.md)：玩法 `v0.21.4`，Node 对照提交 `13694a7038438ac0b3dd7df07db8c05ea239141f`，Node `24.14.0`，Go `1.27.1`，PostgreSQL `18.6`，Node/Go/PostgreSQL/浏览器时区均为 `Asia/Shanghai`。没有跟踪移动的 `main`，没有 push、部署或生产数据操作。

本轮代码验收基点为本地提交链 `4e4466e -> 1469931 -> 28f87ce -> f4345f1`；候选代码 SHA 固定为 `f4345f11d3a5c48b7a77dba2774eca22e6d49a8a`。本报告的追加提交只修正报告指针，不改变候选代码；兼容实现合入后必须重新冻结 SHA 并重跑受影响套件。路由清单的 Node SHA、玩法版本和 `sharedRulesSha256` 已由生成器锁定，不因工作树后续移动而改变。

## 当前结果

| 套件 | Node | Go | 退出码/口径 |
|---|---:|---:|---|
| 静态路由注册 | 152/152 | 152/152 | `route-coverage --ref f4345f1`：0 缺失、0 重复、0 未解析；这不是行为通过 |
| 旧协议 API 门禁及 SSE 首帧 smoke | 5 pass / 0 fail / 2 skip | 0 pass / 0 fail / 2 skip | `npm run go:ab:api` 退出 0；Go 缺 `FISHING_GO_AB_COMMAND` 与隔离 `FISHING_GO_DATABASE_URL` |
| Node Go-rewrite 基线测试 | 7 pass / 0 fail | - | `npm run go:baseline:test` 退出 0 |
| Go 包测试 | - | 包测试退出 0 | 使用协议指定 Go；没有 `FISHING_GO_TEST_DATABASE_URL`，真库集成不能计为通过 |
| 独立浏览器 A/B | 0 pass / 0 fail / 36 skip | 0 pass / 0 fail / 36 skip | `npm run go:ab:browser` 退出 0；未设置 `FISHING_AB_BROWSER=1`，每项均明确 skip |

Node smoke 实际注册了隔离账号、验证无认证 `/api/me` 被拒绝、验证有认证 `/api/me`，并读取 `/events` 首帧 `init`。逐路由无认证门禁覆盖 152 条路由；兼容旧协议的合法 `200/400/404` 行为按路由矩阵记录，未统一放宽为 `401/403`。浏览器 36 个 skip 和 Go 两个 skip 都不计通过。

完整原始日志位于 Git 忽略目录 `output/go-rewrite/`：`ab-api-rerun.log`、`ab-browser-rerun.log`、`ab-go-test.log`、`ab-route-coverage-f4345f1.json`、`ab-sse-contract.json` 及每次夹具运行的 `ab/<run>/logs/`。报告不把旧 `tests/run-all.js` 的历史失败数当作本次基线；旧套件仍需在完成参数化前跨窗口串行。

## HTTP/API 矩阵

冻结的逐路由审计由 [api-contract-matrix.js](../../../tools/go-rewrite/api-contract-matrix.js) 生成，完整表在 [AB_API_MATRIX.md](AB_API_MATRIX.md)。该表来自当前源码清单，分母为 `server-go/api/legacy-inventory.json` 的 157 个候选减 5 个开发接口，即 152 个唯一非开发 `method + path`。每一行都有：

- method/path、Node 源码行和 Go 注册处理器；
- 认证、管理员权限和 MFA 前置；
- body/query 字段、未知字段和范围校验；
- 成功 status/响应投影和业务错误；
- 事务、资产/金币/库存、事件、审计或只读副作用；
- 必须同时检查的用户可见结果与 PostgreSQL/事件权威结果。

契约类覆盖身份注册/登录/MFA、SSE、钓鱼/钓竿、海域/编队、交易、市集/商城/售出、工坊/宝匣、社交、通知反馈、Wiki，以及后台配置、世界、用户快照、横幅、纪录和市场操作。`node tools/go-rewrite/api-contract-matrix.js --check` 已通过（152 行无漂移）。JSON 夹具矩阵由 `npm run go:ab:matrix` 生成到忽略目录，供 A/B runner 使用。

共同安全前置会单独记录：POST 非 JSON=415、跨源=403、cookie 模式缺 `X-Requested-With` 的 CSRF=403、未知路由=404。成功写操作必须读回权威资产 revision、余额/库存、业务表、outbox/审计和后续 SSE；随机或时间敏感场景只比较固定 seed/时钟下的不变量、事务和事件顺序，不比较两次失控随机值。

## SSE 消费矩阵

前端真实消费点是 `frontend/js/net.js:516-883`，不是服务端 `type` 字面量列表。脚本 `tools/go-rewrite/sse-contract.js` 从 `m.type` 分支、Node sender 和 Go gateway sender 联立生成 40 个客户端消费类型及 9 个生命周期断言（init、分页尾页、重连、租约、慢连接、读失败、重复事件、资产 revision、过期状态）。

| 对照 | 消费类型 | 客户端分支存在但当前 sender 缺失 | 含义 |
|---|---:|---|---|
| Node | 40 | `codex`, `players`, `playersDelta` | 兼容分支仍在前端，当前 Node 不发送这些旧类型；不能把分支存在当作发送通过 |
| Go legacy `/events` | 40 | `batch`, `codex`, `codexAdd`, `feed`, `grounds`, `players`, `playersDelta`, `records` | 部分由 `feedBatch`、`assets`、`recordsDirty` 或 HTTP 拉取承接，`grounds` 后续广播和完整旧语义仍是差异 |

已确认的 Go/Node 差异：

1. Go legacy `init` 的 `feed` 为空、`recordsVersion` 固定为 0，`resumedFishing` 缺 Node 的 `castInfo` 和实际 interval；Node init 带当前 feed、纪录版本和钓速明细。
2. Node presence flush 会持续广播 `grounds`；Go legacy 只在 init/playersPage 提供投影，换钓点或第二账号上线后的 `onlineTotal`/钓场计数不能按 Node 语义接受。
3. Go 旧 `/events` 没有 Node 旧协议可用的 `Last-Event-ID`/event id 恢复；Go `/api/v1/events` 的 `snapshot_required`/`assets_changed` 是另一套 v1 消费者，旧前端不消费。
4. Node 使用 batch envelope；Go legacy 发送单帧。Go 个人 catch 主要以 `catch`+`assets` 补图鉴，缺 `codexAdd`；records 以 `recordsDirty`/HTTP 拉取承接，不能只比较 type 名。
5. Go `assets.invRev` JSON 类型为字符串，Node 为数字；前端可 `Number()` 兼容，但 API/SSE 契约必须记录类型差异。Go 资产快照也缺部分 Node 场景下的 `bd`/`rodLocked`。
6. Node 市集到期会发卖家 `assets` 和过期 `notice`；Go 结算会退回资产并可由 GET 观察终态，但旧协议过期通知/日志需要真实 A/B 复验。

现有 Go 真库单测已覆盖 catch 分页 100+5、读失败游标不前进后重试、市集 16+4、好友/配置重连投影、租约与 maintenance；这些是服务端证据，不能替代浏览器中的消费和可见结果。

## 浏览器覆盖矩阵

独立套件是 [ab-browser.test.js](../../../tests/go-rewrite/ab-browser.test.js)，场景分母在 [ab-scenarios.js](../../../tests/go-rewrite/ab-scenarios.js)。Node 与 Go 使用同一原前端、同一场景名称、同一 `Asia/Shanghai` context；浏览器 context 使用持久 profile，支持同 profile 多标签。当前初始运行未设置 `FISHING_AB_BROWSER=1`，因此下表每格均为 `skip`，不是通过：

| 场景 | Node | Go | 需要的权威复核 |
|---|---|---|---|
| 注册/登录/退出 | skip | skip | session、cookie/token、账号/会话持久状态 |
| 钓鱼、换装、收竿重开、重连 | skip | skip | fishing session、rod/assets、SSE init/catch/assets |
| 多标签租约 | skip | skip | `gateway_streams` 每流开/续/关、最后一流状态 |
| 双人交易：取消/超时/重复确认 | skip | skip | trade 状态、双方资产和 `tradeDone` 次数 |
| 市集：上架/部分成交/撤回/到期 | skip | skip |托管、fill、税、退回库存、market revision/notice |
| 工坊、重铸、锻造、宝匣 | skip | skip | 随机受控、pity、词条、金币/库存 revision |
| 远洋、编队、好友、活动、自动配装 | skip | skip | sea/party/friend 持久行和驱逐/事件 |
| 后台 MFA、权限、配置、快照、纪录 | skip | skip | MFA/权限拒绝、revision、快照/审计、配置 SSE |
| Wiki 投稿、配额、审核、删除、官方更新 | skip | skip | quota/status/revision、ETag、审核和官方内容 |
| SSE init/尾页/重连/读失败/重复/过期 | skip | skip | UI 状态、事件顺序、游标不前进和恢复补发 |
| HTTP 结果与权威库对账 | skip | skip | response、DB、outbox、资产 revision 三方一致 |

启用真实浏览器需要明确提供固定 Chrome `153.0.8010.53`（或记录精确替代版本及摘要）、`FISHING_AB_BROWSER=1`；Go 端还需要已构建的 `FISHING_GO_AB_COMMAND`、隔离 `FISHING_GO_DATABASE_URL`，并由同一夹具创建等价账号和数据。仅定向 Chrome 回归、静态 baseline 或环境缺失后的 skip 都不能宣称完整 A/B。

## 夹具与启动清理审计

旧套件审计结果：42 个套件会启动服务或工具，38 个写死端口，9 个通过 `Get-NetTCPConnection`/`Stop-Process` 扫描并杀端口占用者；多数 UI 套件使用临时 `browser.newContext`，没有持久 profile。`tests/run-all.js` 的并行调度不能作为这条 A/B 的进程隔离证明。

新夹具 [ab-harness.js](../../../tests/go-rewrite/ab-harness.js) 已把资源所有权收拢：

- `reservePort()` 只申请 `127.0.0.1:0`，每次运行隔离 Node `FISHING_DATA_DIR`、日志和 profile；
- Node/Go 都注入 `TZ`/`PGTZ=Asia/Shanghai`，Go 监听地址由夹具写入动态端口；
- 终止只使用夹具保存的 child PID，先 SIGTERM，超时才对该 PID 的进程树处理，不扫描端口；
- Playwright 使用每角色持久 profile，同一个 context 可开多个 tab 验收租约；
- `finally` 关闭浏览器、服务和日志流。旧固定端口套件在参数化前保持串行。

## 重跑条件

兼容实现合入后先冻结新的候选 SHA，再用相同版本组合运行：

```powershell
$env:PATH = "$env:LOCALAPPDATA\FishingGoToolchains\go1.27.1\go\bin;$env:PATH"
$env:FISHING_AB_BROWSER = '1'
$env:FISHING_GO_AB_COMMAND = 'E:\AAAworktrees\web-fishing-game\go-ab\server-go\bin\game.exe'
$env:FISHING_GO_DATABASE_URL = '<isolated fishing_test bootstrap URL>'
npm run go:ab:api
npm run go:ab:browser
```

真库、浏览器、超时和中断都要把结果写成 `pass/fail/skip/timeout/diff`；缺少依赖时保留 skip，不改断言制造通过。代码再次改变后必须重新冻结 SHA，不能拼接不同提交的 Node/Go 结果。

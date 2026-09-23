# Go 首竿无鱼排查与修复（2026-09-23）

排查对象：从 main 拉取的 `f0f6cf4`。用户反馈是“从开始就不上鱼”，部署为新数据库，未执行或不确定是否执行过物品定义初始化。结论来自代码核查、独立 PostgreSQL 18.4 的合成数据复现及前后对照；没有读取或修改正式数据库。

## 最符合本次反馈的根因：新库漏初始化物品定义

Go 把建表与物品初始化分成 `cmd/migrate up` 和 `cmd/catalog defaults` 两步。旧启动流程只检查 schema；`catalog.Current` 在未发布规则时仍返回内置地图和掉落表，所以注册、显示钓点、开始钓鱼均可成功。`item_definitions` 若为空或缺少目标物品，首次实际发奖会失败：

- 鱼在 `internal/modules/fishing/catches.go` 写入 `catch_records` 时违反物品定义外键，整个事务回滚。
- 材料进入资产库存校验后返回 `unknown_item`，钓鱼结算转为 `ErrDeferred`。
- 两条路径均不推进本竿序号与随机游标。调度器随后重试同一竿，持续无入账；重新抛竿或提高上钩率无法补齐缺失定义。

`TestIntegrationMissingDefinitionsBlockFirstCatchUntilRestored` 已在真实 PostgreSQL 上覆盖鱼与材料：删除一项定义后仍能开钓，同一竿连续两次失败，无部分库存/纪录/结算提交；补齐定义后原候选成功结算并得到一份鱼获。现有测试夹具主动调用 `SeedDefinitions`，因而此前没有覆盖部署遗漏初始化的路径。

这与用户提供的部署情况高度吻合，但尚未获取正式库的定义数量，不能把正式库缺失状态当作已实测事实。

### 部署核对与处理

先由部署方用已有数据库工具运行 `tools/go-rewrite/diagnose-fishing.sql`（全部只读，无账号标识或凭据输出）。若 `item_definition_count=0`，即可确认未初始化；若定义非空，继续核对生效 catalog 的完整性、应用角色权限和结算失败，不能仅凭“数量非零”排除缺项。

对使用默认规则的新库，配置已有的 `FISHING_GO_MIGRATION_DATABASE_URL`（schema 管理角色）后，在仓库根执行：

```powershell
go -C server-go run ./cmd/catalog defaults
```

此命令事务性补入默认物品定义，已有定义必须分类/部位一致，不删除账号或库存，不修改上钩概率，也不执行旧存档导入。若数据库使用自定义发布规则，应按该发布目录核对和修复，不能把重新填入默认定义当成覆盖自定义规则的方案。完成后由部署方按既有流程启动服务。本轮没有运行上述命令指向正式库，也没有重启正式服。

修复新增 `internal/app/catalog.go`：监听前与 `/readyz` 均在同一只读快照中，对照实际生效目录与物品定义的 ID、分类、装备部位。未初始化或不一致时拒绝启动/返回不就绪；不会自动覆盖配置。允许未发布 release 而使用完整默认目录，也允许数据库保留额外历史定义。

## 第二个已确认缺陷：在线租约过期后无法自行恢复

`NativeService.Stream` 遇到已过期或消失的推送租约时返回业务拒绝。资产事务层将其转换成 `Status="connection_expired", err=nil`；原 `/events` 心跳只判断 `err`，因此漏掉恢复分支。实际钓鱼被暂停或持续延后，而 SSE 仍发 ping，页面看似在线。

新增真实 HTTP/SSE 回归保持同一连接、强制租约过期，再调用真实结算使钓鱼暂停。原代码等待下一轮心跳后仍不恢复，测试失败；修复后恢复有效租约与活动钓鱼。另覆盖租约记录消失和最初 `resume_enabled=false` 的会话。

修复同时检查初次 open、heartbeat 和 reopen 的 `Status=="connected"`；超过连接数上限时返回 409/`stream_limit`，避免建立没有租约的假在线连接。此问题可解释挂一段时间后不再上鱼；它不是本次“第一竿即失败”的唯一解释。

收尾同步时发现远端新增 `bd62bc6` 已独立修复相同租约问题，另有 `aa0c447` 的 Linux 发布配置变更。本地已整合两者，保留远端 409 响应契约；本次额外保留过期/记录消失及首竿等独立回归。首次推送因远端领先被拒，本次改动未推送；用户随后明确要求先不推送，结果仅保留本地。

## 全盘检查与边界

- 静态路由：旧非开发接口 152/152 注册，无重复或未解析注册；扫描器自身 4 项测试通过。此结果只证明路由存在。
- 原始提交真实 PostgreSQL 全套：默认包并行时出现 8 个测试资源清理超时；降低包并发至 `-p 2`、同一工具链和数据库重跑后为 **2856 pass / 0 fail / 2 skip**。跳过项为 Windows 符号链接测试和需显式启用的浏览器集成测试。
- 修复后的同环境全套：**2869 pass / 0 fail / 2 skip**（24 个包通过，新增 13 个测试/子测试结果）；相对原始提交无新增失败。全套中的浏览器 skip 已随后显式启用并单独运行通过；Windows 符号链接测试仍跳过。
- 前端原 8 套中 3 套夹具剥离页面脚本后漏载 `features.js`，在业务断言前报 `orderedMenu` 错误。已修复三处测试加载列表；最终可确认 **548 项通过**，`mobile-layout` 在 `compact header`（顶部栏高度不超过 120px）处失败并中断，后续断言未执行。这是已有布局基线问题，未在本轮修改页面样式。
- 默认裸竿上钩概率约 83.33%，未发现默认概率为零；正式钓鱼 worker 已启动。最初怀疑的纪录显示名 SQL 参数问题已执行 PostgreSQL prepare/execute 排除。
- 另有独立静态发现：市集自动补货 worker 固定使用内置目录，可能忽略后续发布的新物品/组件规则；真实 Node 装备 `{compId,affixes,...}` 与迁移工具期待 `{part,...}` 的格式不匹配。这两项未混入本次钓鱼修复，也未作为线上已发生事实。
- 未完成 Linux/race、完整原 Node/Go 浏览器 A/B、容量与生产验收。本机 race 尝试因未配置 C 编译工具链（CGO 关闭）而未运行。

## 最终验证记录

Go 1.27.1 / Windows，独立 PostgreSQL 18.4，数据库包并发固定为 2：原始提交 2856/0/2，修复后 2869/0/2；整合远端 `aa0c447` 及其新增测试后最终为 **2874/0/2**（pass/fail/skip）。真实浏览器专项 `TestIntegrationLegacyBrowserConfigBannerParty` 在最终整合版本上再次通过（Node 22.18、Edge），覆盖旧后台公告/配置/编队、玩家 SSE、注册证明 Worker；它仍不等于全部玩法浏览器验收。`gofmt`、`go build ./...`、`go vet ./...` 和 `git diff --check` 通过。race 未执行成功的工具链限制与移动布局剩余失败如上。

日志保存在本地忽略目录 `output/fishing-audit/`：`fishing-before.log`、`fishing-after.log`、`go-baseline-p2.jsonl`、`go-after-p2.jsonl`、`go-final-p2.jsonl`、`go-browser-final.log`、`frontend-ready.log`、`frontend-harness-fixed.log`、`build-final.log`、`vet-final.log`、`race.log`。修复前后定向首竿/租约/启动检查已通过预期 A/B。

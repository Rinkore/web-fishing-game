# Go 重写剩余任务与执行顺序

核对日期：2026-09-22。范围为当前 `codex/go-rewrite`，使用合成测试数据；生产迁移、切服与部署仍单独验收。

## 当前基线

`server-go/api/legacy-inventory.json` 当前包含 157 个静态候选，其中 5 个开发专用接口不计入分母。2026-09-22 用 `tools/go-rewrite/route-coverage.js` 按唯一且完全相同的 **method + path** 重算：提交 `603c945d6181de83aec00a077e3af0a90ebe7483` 为 **140/152**，本轮收口工作树为 **152/152，未注册 0 条**；Go 共注册 192 个唯一 method + path，另 40 条为新协议。`inventory --check` 通过，未发现重复或未解析注册表达式。

| 验证层次 | 当前结论 |
|---|---|
| 路由存在 | 152/152；只证明静态注册存在，未执行接口行为 |
| HTTP/SSE 契约 | 已有分域真实 PostgreSQL 回归；尚无 152 条逐项全通过的验收结论，仍需 Node/Go 同输入对照、权限、错误与结算语义复验 |
| 浏览器 | 已有原 Chrome 定向回归；完整 Node/Go A/B 未完成，不由路由数或 Go 包级测试通过替代 |

复现：仓库根执行 `npm run go:inventory`、`npm run go:coverage`；历史比较执行 `node tools/go-rewrite/route-coverage.js --ref 603c945d6181de83aec00a077e3af0a90ebe7483`。`--json` 输出逐路由结果、源码摘要和验证对象；`--check` 在缺失路由时退出非零。当前基线的完整日志在忽略目录 `output/go-baseline-20260922/`，最终提交、真库与 Linux race 验证以 DELIVERY 最新批次为准。不得把历史批次的 124/152、28 条或 35 条未注册继续作为当前总览。

已具备的核心包括身份/MFA、资产事务、交易/市集、工坊/宝匣、商城、好友/编队、供需/自动出售，以及普通地图和远洋结算。`0019` 已持久化递归段与随机游标，`0020` 已提供不可变 catalog 发布，`0021` 已提供多标签页租约；不要再按早期文档把这些列为未开发。旧 HTTP 接口的已知偏差继续以 DELIVERY 日志及实际测试为准。

## 推进顺序与完成条件

| 顺序 | 工作 | 状态与完成条件 |
|---|---|---|
| P0 | 个人渔获/资产同步、组件订阅、SSE 分页与重试 | 已实现鱼/材料/组件完整操作投影、同快照资产修订、订阅筛选/关闭、市集尾页、好友初始化窗口、反复开钓收竿；2026-09-21 批次真库/race 证据见 DELIVERY，最新候选须单独复验 |
| P1 | 其余实时协议与后台配置 | 已接 catalog/原生功能开关到旧 SSE、持久公告队列和停止事件、海域主动驱逐、维护通知、实时商店价格及材料/组件公共动态，运营配置已持久化并接入部分旧推送；仍需完整纪录通知和历史动态、宝匣保底/经济/自动售出等配置的权威结算生效核验，旧浏览器完整更新流程待 P4 |
| P2 | 后台契约与配置语义 | 静态后台路由已全部注册，重点已转为兼容与行为验收；每组须包含 MFA/越权拒绝、事务与审计、输入/错误契约、并发编辑冲突、失败回滚和旧后台浏览器流程；保存并回显配置不等于实际结算已采用配置 |
| P3 | 注册挑战、Wiki 投稿/审核 | 注册表单/登录 profile、来源绑定的一次性 proof 和持久配额已接，真库与原浏览器注册验证通过；Wiki 投稿/审核、24h 3 篇、待审 3 篇、自动通过、官方热保存已接入 0026 PostgreSQL 存储，需补真实浏览器 A/B。生产反向代理的可信来源策略需在 P6 单独配置验收 |
| P4 | 全部已注册接口与原前端 A/B | 真实 Chrome 已验证公告发布/停止、配置与功能更新、管理员解散编队；海域用户名转换已通过 HTTP/SSE 真库验证。完整钓鱼/换装/重连、多标签页、交易和市集、工坊/宝匣、后台与 Wiki A/B 仍未完成；须同依赖/同夹具对比 Node 和 Go 的套件级失败，不套用 v0.13.9 的旧失败数 |
| P5 | 容量与故障验收 | 未完成：先固定 100 人完整玩法持久磁盘长测，记录 SQL/锁等待/周期延迟/WAL/空间/对账；写入中杀库/杀进程、提交回包丢失、去重恢复；通过后再测 1000/5000 |
| P6 | 迁移工具与切换演练 | migration 线并行实现导入/对账、最小权限、备份恢复、回滚与合成切换演练；正式快照获取、正式数据库修改和真实切服不在本次授权内，测试容器健康和短测不作为生产放行 |

P1/P2 的兼容实现与 P4/P5 工具可按 [PARALLEL_ACCEPTANCE.md](PARALLEL_ACCEPTANCE.md) 分工并行；整合后必须冻结同一候选 SHA 再复验，代码改变后重跑受影响验收。当前个人 SSE 使用权威全量快照保证一致性，每 250ms 最多一份（有新修订时）；其吞吐、带宽、前端重绘与社交公共流每连接扫描成本必须在 P5 实测，不能据此宣称已支持 5000 人。

本次审阅另登记两项明确缺口，交 compat 实现、ab 验收，见 [基线兼容缺口报告](reports/BASELINE_COMPAT_GAPS_2026-09-22.md)：功能关闭与其他玩家新开钓/发起交易之间的并发窗口；商城/工坊配置保存与回显尚未完整进入实际扣费/随机结算。两项是代码审阅发现，未执行专门的受控竞态或经济对照用例；全套 Go 测试通过也不消除这些覆盖缺口。

## 后台与 Wiki 契约重点

当前未注册清单为空。下表是已经注册、仍需逐项兼容验收的重点域，不代表仅剩这些接口，也不表示它们已完成完整契约或浏览器验收。

| 分组 | method + path（均位于 `/api/`） |
|---|---|
| 功能开关 | GET/POST `admin/features`；层级、排序、adminBypass 与服务端实际权限门禁 |
| 世界/掉落 | GET `admin/world`、`admin/loot/groups`、`admin/loot/spots`；POST `admin/component/config|reset|simulate`、`admin/fish/config|reset|simulate`、`admin/loot/group`、`admin/pool/preset`、`admin/ground/add|remove|restore|update`、`admin/spot/add|buffs|pool|remove|rate|pos` |
| 锁定/模拟 | POST `admin/ground/lock`、`admin/spot/lock`、`admin/simulate`、`admin/loot/test` |
| 经济/玩法/纪录 | POST `admin/market/return`；GET/POST `admin/market/supply`；POST `admin/market/bulk`、`admin/records/delete`、`admin/records/delone`、`admin/settings`、`admin/mall/config`、`admin/smelt/config`、`admin/records/config` |
| 快照/回滚 | GET/POST `admin/users/snapshot`；GET `admin/users/snapshots`；POST `admin/users/snapshot-now`、`admin/users/rollback`、`admin/snapshot/config` |
| Wiki 后台 | GET/POST `admin/wiki/content`；GET `admin/wiki/guides`；POST `admin/wiki/guides/review`、`admin/wiki/guides/delete` |
| 玩家 Wiki | POST `wiki/guides/submit`；GET `wiki/guides/my`；POST `wiki/guides/delete` |

## 本轮回归范围

- `legacy_personal_push_test.go`：原生递归鱼/材料/组件分段、订阅/配置回读、售后库存/图鉴对账、18 × 105 条分页、init 发送竞态、失败重试、重连基线、在线发奖；数据库锁控制唤醒查询与事件页之间新提交的时序，验证不漏快照。
- `legacy_push_recovery_test.go`：20 笔真实部分成交、16+4 尾页、失败后重试、不重复发送、好友首轮窗口。
- `legacy_fishing_test.go`：实际 `/events` 生命周期、真实资产事务的 catch + 快照、反复开钓/收竿。
- 保留并复验上轮未提交的 `legacy_catch_push*` 公共鱼类动态与排行榜刷新实现。
- `legacy_config_push_test.go`：catalog 发布到 HTTP/SSE 的一致投影、掉落组权重展开、配置名称映射、相同内容去重、初始化发布窗口、读取失败重试及真实连接；`native_test.go` 追加同钓点刷新与递归段并发时保留随机进度。
- `legacy_banner_test.go`：公告 8 个后台接口、观看人数 15 秒 TTL、真实 SSE、越权拒绝、可选修订冲突、审计失败全量回滚、18 次停止事件的 16+2 分页及失败重试、历史事件不可变。
- `legacy_admin_party_test.go`、`sea_eviction_test.go`：后台列举与解散、审计失败回滚、并发解散、共享权限收回、用户名海域进入与续钓、小时级长竿主动停止、真实 SSE notice/seaEvict、权限恢复竞态、双 worker 去重及账本对账。
- `legacy_browser_test.go` 与 `tests/go-rewrite-browser.test.js`：可选真实 Chrome 验证原后台表单与玩家 SSE，使用隔离合成账号；不是完整 Node/Go 浏览器 A/B。
- `maintenance_test.go`：使用实际 HTTP server 关闭信号验证旧/v1 SSE 的最后维护帧、无错误踢线、正常退出与租约清理。
- `legacy_shop_push_test.go`：初始商店、其他玩家出售后的即时更新、HTTP/SSE 一致、缓存去重、失败重试及 catalog 价格变更；原生递归专项同时覆盖公共鱼/材料/组件混合分页和历史鱼记录回退去重。
- `identity/registration_test.go` 与网关 `registration_test.go`：注册配额持久化、最后名额并发争用、挑战来源/期限/错误答案/重放、SQL 失败回滚、旧表单字段与登录 profile；真实 Chrome 通过原注册 Worker 完成挑战并进入游戏，随后退出并从原表单重新登录。

没有执行生产操作；完整浏览器 A/B 和容量/故障放行仍未完成。

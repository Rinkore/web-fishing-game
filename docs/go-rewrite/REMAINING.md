# Go 重写剩余任务与执行顺序

核对日期：2026-09-21。范围为当前 `codex/go-rewrite`，使用合成测试数据；生产迁移、切服与部署仍单独验收。

## 当前基线

`server-go/api/legacy-inventory.json` 的 152 个非开发接口，对照 `internal/gateway/http.go` 的 method + path，101 个已注册、51 个未注册，其中 48 个是后台接口。这个数字仅表示路由存在，不能代替权限、输入/输出、错误和旧浏览器的兼容测试。开发专用接口不计入分母。

已具备的核心包括身份/MFA、资产事务、交易/市集、工坊/宝匣、商城、好友/编队、供需/自动出售，以及普通地图和远洋结算。`0019` 已持久化递归段与随机游标，`0020` 已提供不可变 catalog 发布，`0021` 已提供多标签页租约；不要再按早期文档把这些列为未开发。旧 HTTP 接口的已知偏差继续以 DELIVERY 日志及实际测试为准。

## 推进顺序与完成条件

| 顺序 | 工作 | 状态与完成条件 |
|---|---|---|
| P0 | 个人渔获/资产同步、组件订阅、SSE 分页与重试 | 已完成本轮代码与真库验收：鱼/材料/组件完整操作投影、同快照资产修订、订阅筛选/关闭、市集尾页、好友初始化窗口、反复开钓收竿；Windows 全套及 Linux race/vet 全套通过，验证记录见 DELIVERY |
| P1 | 其余实时协议与后台配置 | 已接 catalog/原生功能开关到旧 SSE、持久公告队列和停止事件、海域主动驱逐、正常停服维护通知、实时商店价格及材料/组件公共动态；仍缺完整纪录通知和历史动态，以及尚无权威配置源的宝匣保底/经济/自动售出等配置推送；旧浏览器完整更新流程待 P4 |
| P2 | 剩余 48 个后台接口 | 公告 8 条、编队管理 2 条已接并完成真库验证；其余按下表分组实现；每组须包含 MFA/越权拒绝、事务与审计、输入/错误契约、并发编辑冲突、失败回滚和旧后台浏览器流程 |
| P3 | 注册挑战、Wiki 投稿/审核 | 注册表单/登录 profile、来源绑定的一次性 proof 和持久配额已接，真库与原浏览器注册验证通过；Wiki 投稿/审核、24h 3 篇、待审 3 篇、自动通过、官方热保存已接入 0026 PostgreSQL 存储，需补真实浏览器 A/B。生产反向代理的可信来源策略需在 P6 单独配置验收 |
| P4 | 全部已注册接口与原前端 A/B | 真实 Chrome 已验证公告发布/停止、配置与功能更新、管理员解散编队；海域用户名转换已通过 HTTP/SSE 真库验证。完整钓鱼/换装/重连、多标签页、交易和市集、工坊/宝匣、后台与 Wiki A/B 仍未完成；须同依赖/同夹具对比 Node 和 Go 的套件级失败，不套用 v0.13.9 的旧失败数 |
| P5 | 容量与故障验收 | 未完成：先固定 100 人完整玩法持久磁盘长测，记录 SQL/锁等待/周期延迟/WAL/空间/对账；写入中杀库/杀进程、提交回包丢失、去重恢复；通过后再测 1000/5000 |
| P6 | 生产迁移与切服 | 仍延期：停服一致快照、可复现导入/对账、生产权限、备份恢复、回滚及切服；测试容器健康和短测不作为生产放行 |

P1/P2 完成后再冻结 P4/P5 的验收场景。当前个人 SSE 使用权威全量快照保证一致性，每 250ms 最多一份（有新修订时）；其吞吐、带宽、前端重绘与社交公共流每连接扫描成本必须在 P5 实测，不能据此宣称已支持 5000 人。

## 未注册接口的完整清单

| 分组 | method + path（均位于 `/api/`） |
|---|---|
| 功能开关（2） | GET/POST `admin/features` |
| 世界/掉落（20） | GET `admin/world`；POST `admin/component/config`、`admin/component/reset`、`admin/component/simulate`、`admin/fish/config`、`admin/fish/reset`、`admin/fish/simulate`、`admin/spot/pool`；GET `admin/loot/groups`；POST `admin/loot/group`、`admin/spot/buffs`、`admin/pool/preset`、`admin/ground/add`、`admin/spot/add`、`admin/ground/remove`、`admin/spot/remove`、`admin/ground/restore`、`admin/ground/update`、`admin/spot/rate`、`admin/spot/pos` |
| 锁定/模拟（5） | POST `admin/ground/lock`、`admin/spot/lock`；GET `admin/loot/spots`；POST `admin/simulate`、`admin/loot/test` |
| 经济/玩法/纪录（10） | POST `admin/market/return`；GET/POST `admin/market/supply`；POST `admin/market/bulk`、`admin/mall/config`、`admin/smelt/config`、`admin/records/config`、`admin/records/delete`、`admin/records/delone`、`admin/settings` |
| 快照/回滚（6） | GET/POST `admin/users/snapshot`；GET `admin/users/snapshots`；POST `admin/users/snapshot-now`、`admin/users/rollback`、`admin/snapshot/config` |
| Wiki 后台（5） | **已接入** GET/POST `admin/wiki/content`；GET `admin/wiki/guides`；POST `admin/wiki/guides/review`、`admin/wiki/guides/delete` |
| 玩家 Wiki（3） | **已接入** POST `wiki/guides/submit`；GET `wiki/guides/my`；POST `wiki/guides/delete` |

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

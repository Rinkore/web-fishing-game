# 基线兼容缺口审阅（2026-09-22）

## 审阅对象与证据边界

- 分支：`codex/go-rewrite`；审阅起点 HEAD：`603c945d6181de83aec00a077e3af0a90ebe7483`。
- 对象是该 HEAD 上的本轮未提交工作树，包含 `legacy_admin_config.go` 和 feature 发布收口修改；不是对原 HEAD 二进制的验证。最终共同 `BASE_SHA` 和统一测试结果由集成窗口记录。
- 以下两项来自实现及现有测试的代码审阅。本报告没有启动服务、执行资产动作或运行针对这些缺口的调度时序用例，没有 HTTP/SSE 全契约或完整 Node/Go A/B 通过结论。
- 静态路由注册完整、配置保存返回 200、数据库事务整体回滚测试通过，均不能替代下述行为验收。两项交由 `compat` 专项实现并由 `ab` 复验；本轮不扩大公共锁序或权威规则发布改造。

## B：功能关闭与尚未插入状态的命令缺少共同串行边界

`internal/modules/operations/features.go:86` 的发布命令只将管理员本人加入 player guard 集合，随后在第 88 行锁 `feature_head`，第 106–114 行将当时可见的活动钓鱼会话及交易批量改成终态。另一方面，`internal/modules/assets/features.go:51–59` 的 `requireFeature` 使用普通 SELECT 读取当前开关，没有参与发布侧的行锁。

`internal/modules/fishing/native.go:111–151` 在 `RequireFeature("fishing")` 通过后才插入或重启会话；`internal/modules/trade/service.go:69–85` 的邀请也在 assets 命令公共 feature 校验之后插入新交易。公共执行器的玩家锁及 feature 校验位于 `internal/modules/assets/command.go:83–120`。

可构造的触发顺序：

1. 使用与发布管理员不同的玩家账号（交易使用两个不同于管理员的账号），在开关为 true 时开始 Start 或 Invite 事务。
2. 该事务读到开关允许，但暂停在新会话或交易 INSERT 之前。选用尚无会话、尚无交易的账号，避免被发布侧 UPDATE 的已有行锁意外串行化。
3. 管理员发布 false。批量 UPDATE 看不到未来才插入的行，发布事务提交成功。
4. 原玩家事务继续 INSERT 并提交，留下开关关闭后的 `active` 会话或 `invited` 交易。

由此不能声明“功能关闭会原子终止所有在途状态”。关闭期间 native settle 会被 gate 推迟，但残留状态没有获得关闭时应有的 generation/终态变更；短时间再次开启后可能继续使用残留会话或邀请。现有 `operations/features_test.go` 验证的是先创建会话/交易、再发布关闭及失败整体回滚，没有覆盖上述普通玩家事务在 gate 与 INSERT 之间暂停的交错。

专项验收要求：

- 用真实 PostgreSQL 的可控制同步点稳定制造上述两种时序，断言关闭提交后没有漏过关闭的活动会话或有效邀请；重新开启也不复活已关闭的旧状态。
- 让命令 feature 校验与发布关闭使用可证明一致的串行边界，并覆盖跨玩家、多个 worker 和失败回滚。不能只补第二次无锁读取。
- 公共锁序变更须单独评审；当前命令先持有玩家 guard，发布再锁 feature head 并更新其他玩家状态，局部添加共享锁可能引入反向等待，必须与完整锁序一并验证。
- 在同一候选 SHA 运行受影响真库测试与 Linux race；race 通过本身不能证明数据库交错正确。

## C：运营配置可保存和展示，但商城/工坊权威执行仍读取 catalog

`internal/gateway/legacy_admin_config.go:19–22` 将旧配置分为 `legacy:mall`、`legacy:smelt` 等 operator setting。第 120–149 行的公共写入事务更新 `operator_settings` 并记录审计，第 152–214 行和第 217–294 行分别提供商城和熔炼保存接口。

读取与执行仍分为两条来源：

| 路径 | 当前来源与位置 |
| --- | --- |
| `/api/me`、后台 world 及旧配置 SSE | `applyLegacyStoredConfig`、`legacyStoredConfigFrames`，`legacy_admin_config.go:46–84`，使用 operator setting 覆写展示 |
| 工坊读取/预览配置 | `legacy_workshop.go:146–154` 合并 profile 中的 `smeltCfg` |
| 商城列表、刷新周期、购买限制与扣费 | `legacy_mall.go:28,101` 使用 catalog 构造 mall service；`internal/modules/mall/service.go:46,92` 直接取 `s.catalog.MallConfig()` |
| 熔炼、重铸、锻造执行 | `legacy_workshop.go:248,351,439` 使用 catalog 构造 workshop service；`internal/modules/workshop/service.go:94` 直接取 `s.catalog.WorkshopConfig()`，后续计划和消耗均来自该值 |
| 工坊执行结果的计划回显 | `legacy_workshop.go:268,373,461` 仍直接读取 catalog 配置 |

具体触发：

1. 管理员通过 `/api/admin/mall/config` 改变某个在售商品的价格、限额或刷新时间。保存返回 200，world/profile/SSE 能读到新配置，但 `/api/mall` 与购买的价格、限额和周期继续使用未更新的 catalog。
2. 管理员通过 `/api/admin/smelt/config` 改变 `goldBase`、`baseRate`、重铸费用等参数。保存返回 200，旧配置帧及工坊读取配置已变化，实际 `workshop.Apply` 的成功率、扣款和材料规则仍使用 catalog，结果回显也重新使用旧 catalog 计算。

因此目前只可声明这些路由已有注册、鉴权、持久保存和部分投影；不能声明配置已影响权威结算，更不能将配置 SSE 推送用例计为交易或工坊行为兼容通过。

专项验收要求：

- 沿用已有 catalog 权威发布模型，统一旧配置入口、HTTP/SSE 投影与玩法结算的规则版本；不要保留两个能独立改变同一参数的权威来源。
- 用合成数据对照保存前后商城实际扣费、限额和跨周期行为，以及工坊计划、确定性随机输出、材料/金币台账。保存失败、并发发布和重启后的生效版本也须验证。
- 逐项审阅 `/api/admin/settings` 的其他玩法配置是否也只影响投影，不从本报告的商城/工坊定位外推其余参数已验证。
- 在同一候选 SHA 重新运行受影响真库 HTTP/SSE 契约及前端 A/B，并明确未执行项；本报告没有提供上述执行证据。

## 交付约束

本报告仅登记剩余兼容缺口，不变更其实现，不构成生产放行、正式数据库迁移或切服授权。基线总览应链接本报告，将 B/C 保留在 compat 待验收范围；后续修复须以新的候选 SHA 和实际日志关闭缺口，不能拼接本轮静态注册数字、旧批次测试与未来运行结果。

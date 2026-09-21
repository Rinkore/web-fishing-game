# 第 1–5 项实施与验收

用户已授权连续推进以下五项；正式数据迁移、正式部署和推送不在本轮范围。每项只有实现、对照和相应验证都通过后才标记完成。原型通过不等于正式玩法或容量验收通过。

**2026-09-21 现状校正**：当前优先级、未注册接口的完整清单与验收条件见 [REMAINING.md](REMAINING.md)。以下日志按实施批次保留，早期的“尚未实现”描述可能已被后续提交覆盖，不能单独作为当前待办。`40e1855` 已接入递归分段持久化、catalog 发布、远洋结算及多连接租约；当前仍缺完整旧协议、后台和生产验收。

## 1. v0.21.4 正式规则

- [ ] 从当前业务源码生成带摘要的完整默认 catalog，保留公开 ID 和覆盖入口。
- [x] Go 受限公式解释器：语法/函数白名单、JS 数值和舍入语义、复杂度限制。
- [ ] 钓竿效果、抛竿间隔、上钩、多钓规则及 Node/Go 对照。
- [ ] 权重池、鱼体型、装备生成、宝匣和工坊随机顺序对照。
- [ ] 供需、价格覆盖、自动出售保留/体型/合计阈值与原子结算。
- [x] 正式规则接入持久周期，原型规则明确隔离；完整旧服等价与容量验收仍独立保留。
- [x] 默认普通地图内部周期：装备效果、渔获、递归双钓、图鉴/纪录原子结算及真库回归；范围和限制见 [NATIVE_FISHING.md](NATIVE_FISHING.md)。

## 2. 身份、HTTP 和前端

- [ ] 注册/登录/退出、密码算法、会话、封禁、管理员及 MFA。
- [ ] 原接口的权限、输入、响应和错误契约清单逐项验收。
- [ ] 资产分页、装备/钓竿、钓场、钓鱼和交易 HTTP 接口。
- [ ] SSE 身份绑定、outbox 消费、资产修订、限流/慢客户端、重连恢复。
- [ ] 原前端接入和独立浏览器回归；旧 Node 同套件 A/B。

## 3. 完整交易

- [ ] 双人邀请、回应、报价版本、双方确认、取消/到期及持久结算。
- [ ] 市集部分成交、挂牌费/税费、整竿资产/容量、历史及分页。
- [ ] 买卖/撤回/到期/换装竞争和故障回滚，对账无差异。

## 4. 其余玩法及后台

- [ ] 熔炼、重铸、锻造、宝匣：词条来源、消耗、失败/保留语义。
- [ ] 商店、限购、兑换、自动配装、图鉴、个人/全服纪录。
- [ ] 活动、远洋、海图、船升级、悬赏、编队及好友。
- [ ] 管理后台、配置版本发布、权限、运营审计与功能开关。
- [ ] 每个领域对应旧版回归与浏览器流程通过。

## 5. 性能和故障

- [ ] 明确并记录验收负载、在线口径、间隔与宿主资源。
- [ ] Docker 持久磁盘隔离环境及可复现混合负载。
- [ ] SQL/事务数、周期延迟、锁等待、WAL/空间、长测和对账。
- [ ] 提交回包丢失、数据库中止/重启、任务恢复、恢复后的去重。
- [ ] 根据实测修复瓶颈并出具通过/未通过项；不把 tmpfs 当耐久性证明。

## 用户已确认的实施决定（2026-09-20）

- 容量：先验收 100 人，再阶梯测试 1000/5000 人。人数口径为同时在线并持续钓鱼；已有 100 人、60 秒原型短测不替代完整玩法验收。先冻结正式玩法、间隔/装备/库存与交易组合及宿主资源，再执行长测；1000/5000 人是否通过以实测为准。
- 双钓：**保留 v0.21.4 旧版递归追加行为**。`noDouble` 未生效属于本次明确保留的行为；每次成功渔获都可以再生成 0–2 条追加渔获，追加渔获继续相同判定，不能改成整竿最多 3 条。0018 已接入默认普通地图的内部递归结算；完整远洋与旧协议仍待接入。
- 递归兼容验收必须覆盖超过 3 条、追加分支中的掉落/远洋提前返回、深度优先随机消耗顺序和子分支结束后的自动出售顺序；长链没有固定总量上限，需独立验证执行资源及故障恢复，不能通过静默截断改变收益。
- 后续用户选择：先做内部正式核心与真库回归，再接旧 HTTP/SSE；自动出售本批沿用独立扫描。因此本批不承诺递归分支返回时立即出售的旧时机，整竿超时回滚后使用同一随机序列重试。

## 本轮实施记录（持续更新，不代表 1–5 全部完成）

- 新增 `internal/rules`：94 个物品默认定义、源码摘要检查、公式、抛竿/上钩/双钓概率、权重组、鱼体型、词条/装备/突破生成、供需、自动出售计划、熔炼及重铸纯规则。旧 14 样例保持不变，新增 602 + 84 + 435 个 Node oracle 对照已通过。正式周期仍使用原型规则，配置覆盖发布和剩余规则还未全部接通。
- 新增 migration 0004–0005：账号/会话/MFA、按玩家资产修订编号的事件。注册赠币原子入账；会话摘要存储；密码 scrypt 与 Node 测试向量一致；管理员 MFA 密文绑定账号且拒绝验证码重放。`/api/v1` 已接分页、修订游标 SSE、身份绑定与慢客户端写超时。旧 `/api/me` 与原前端尚未迁完。
- 新增 migration 0006–0007：双人邀请/回应/报价/确认/改价冷却/失效回收，单位价格市集/部分成交/1%-3%-5% 上架费/10% 税/整竿托管及满槽返还。真实 PostgreSQL 测试通过并发成交、重复请求、容量回滚及净额流水。Linux race 全套最终复验仍待完成。
- migration 0008：工坊、宝匣、图鉴登记，随机命令先持久化私有 seed，技术失败重试不换结果。真实 PostgreSQL 测试通过随机结果重试一致、技术失败回滚、装备竞争、合成/开箱去重。
- migration 0009–0010：默认商城、每日限购和好友关系。购买扣款/入包/额度在同一事务；好友申请上限 50、接受好友上限 200，双向关系使用唯一有序玩家对。已通过并发限购、跨周期重置、交叉好友申请、幂等与注入失败回滚测试。新增商城周期 Node 对照 75 项，总计 1210 项规则对照。新增 `/api/v1/mall`、`/api/v1/mall/buy`、`/api/v1/friends`，尚未宣称旧前端兼容。
- 商店周期支持 `FISHING_GO_TIMEZONE=Asia/Shanghai`；未设置则沿用操作系统本地时区。Docker 运行时须显式设置与原服一致的时区，不能默认把 UTC 当作原服时区。
- 新增持久卷脚本 `tools/go-rewrite/test-persistent.ps1`：100 人 × 30 秒、800ms 原型钓鱼 + 正式市集，3315 次结算、110.47 次/秒、0 意外失败、流水对账 0 差异；混合命令批次 p95 122.532ms；调度 p95 183.296ms、p99 558.108ms；WAL 13,639,016 字节；数据库 17,061,567 字节。数据库 SIGKILL 后恢复指纹一致。**调度 p95 未达建议 100ms 门槛；非全玩法长测，不宣称容量验收通过。**
- 第一轮 Linux race 测试失败，定位到交易测试夹具误用 reward 执行负数消耗，已改为 consume；随后 Windows 真库测试中的市集成交失败定位到 SQL CASE 参数类型，已添加 bigint 类型。对应测试分别已通过，需最终全套验证。
- 第二轮持久卷短测：100 人 × 60 秒，7167 次结算（119.44 次/秒），0 意外失败、对账 0 差异；调度 p95 66.648ms、p99 123.864ms；混合命令批次 p95 119.112ms；WAL 29,110,008 字节；数据库 24,286,911 字节；11598 次数据库提交。改为 25ms / 批次 100 / 8 worker，同时修正夹具初始到期时间以排除构造开销，故两次数据并非纯调度参数 A/B。fsync、synchronous_commit、full_page_writes 均开启；停止负载后 SIGKILL/重启，指纹一致。调度 p95 达到初始建议门槛，长测、写入中故障及全玩法容量仍未完成。
- 最终 Linux Docker 真库全套 `go test -race` 与 `go vet` 已通过（覆盖 0001–0010）；Windows 全套真库通过至 0009，好友模块随后在 Linux 真库通过。修复市集到期扫描错误被后续成功覆盖、原型/正式到期请求键互相占用，以及双人交易拿锁后重新检查期限。
- 后续 migration 0011–0013：共享供需、渔获/材料收购、装备固定价收购、个人自动出售规则和在线扫描任务；管理员 MFA 运维授权/撤销与追加审计；八项已实现功能开关的不可变版本发布及事务内检查。价格锁在玩家锁之后按物品排序获取；供需、库存、金币和销售流水原子提交。当前自动出售独立于原型钓鱼事务，正式周期的一体结算未接入；价格覆盖和历史采样仍待实现。
- 含功能开关检查的第三轮持久卷复测：100 人 × 60 秒，7166 次结算（119.41 次/秒），调度 p95 70.550ms、p99 151.179ms；混合命令批次 p95 127.676ms；0 意外失败、对账 0 差异；WAL 29,096,992 字节，数据库 24,295,103 字节，11765 次提交。负载停止后的数据库 SIGKILL/恢复指纹一致。Docker Hub 直连失败后使用已验证固定摘要镜像站完成测试。
- 新增宝匣随机顺序 Node oracle 285 项，累计 1495 项规则对照通过。Linux 真库 race/vet 全套通过至 0013，包含共享供需并发、大小鱼加成、普通鱼优先/保留、自动任务去重/离线排除、装备重复出售、管理员验证码重放/权限撤销/审计权限、并发发布版本冲突及发布失败回滚。修复接入 worker 时的启动失败路径 context 释放（vet 捕获），复验通过。Node 原始基线仍为 3/3，14 个原始规则样例未修改。
- 后续增加商城夏令时缺失/重复时刻的 30 组对照：Go 的 time.Date 歧义选择与 JS Date 不同，现使用“重复时刻选较早、缺失时刻向前归一化”保持一致。商城 oracle 扩至 105 项，总规则对照 1525 项通过；并非修改旧 14 项期望。新增市集到期失败中止/同键重试/返还去重回归。
- 新增 migration 0014–0016：海图合成、船升级、持久随机海域、下锚续期和每日悬赏。合成/升级/出航/下锚/领取均通过共享资产事务；船经验只做门槛不扣除；出航推进 voyage 悬赏，钓鱼类悬赏及正常经验获取等待正式周期。海域和悬赏抽选新增 202 组 Node oracle，累计对照 1727 项（含未修改的原始 14 项）。
- migration 0017：4 人编队、好友邀请、原子换队、队长继任、离队/踢出/解散、独立修订事件及共享海域投影。**用户已确认兼容修正：目标满员时保留原队和邀请。** 测试覆盖末席抢占、事件写失败整笔回滚、队长按实际入队顺序继任、共享权限撤销和事件受众隔离。编队低频拓扑写入使用全局守卫行，容量影响仍需后续长测。
- 2026-09-20 中断续作：Linux 真库暴露编队测试错误地比较 JSONB 原始字节；已改为比较完整解析结果，保留幂等语义断言。补充海域 HTTP 的匿名/伪造身份/越权拒绝、幂等回放、升级、下锚及悬赏防重复奖励。功能发布扩展可选 sea/party 开关，旧八项发布继续有效；关闭后允许领取达成奖励、离队等退出动作。Linux Docker PostgreSQL 全套 race/vet 通过至 0017；Node 清单和全部 oracle 漂移检查、基线 3/3 通过。
- 续作最终 Windows + Docker PostgreSQL 全套通过至 0017，Windows build/vet、gofmt、go mod verify、git diff --check 通过；本批测试容器和网络已清理。该结果验证新 Go 接口与事务，未执行旧前端浏览器 A/B，也不作为完整玩法或容量通过的证明。
- 旧市集契约接入：`GET /api/market`（分页 / scope / kind / part / q / 词条区间 / 排序 / counts / parts / mineCount / marketTotal / revision）、`POST /api/market/list|buy|cancel`、`GET /api/market/history` 已桥接到正式市集事务。整竿标识 `rodset:part=sig;...` 由托管件 `market_order_equipment` 按 data.js 部位顺序还原；组件实例按签名还原并回写旧版中文拒绝文案。**已知偏差**：同一签名挂 N 件按「一件一单」落库（正式模型限制），每单各自 ceil 上架费，合计可能比旧版整单多 0～N-1 金币；部分成交/下架/历史（60 条）语义与旧版一致。
- 修正旧档案投影：`/api/me` 的 inventory 现在按签名汇总「未装竿、未托管的可用组件实例」，与旧版 `rec.inventory`（装备时移出背包）口径一致；此前组件在旧前端背包中不可见，市集/宝匣/钓竿相关流程都受影响。
- 旧工坊契约接入：`GET /api/workshop`（合并后的熔炼配置、六种催化剂材料与词缀对照、重铸与残片保留参数）、`POST /api/workshop/smelt|recast|forge` 已桥接到 `workshop.Apply`。随机结果仍由「请求号 + 持久随机意图」决定，回包按 data.js `instanceMeta` 形状还原产物/主件余件，并回写旧版中文拒绝文案。**已知偏差**：主副件同一签名会被正式模块拒绝（旧前端选择器本身也排除了这种情况）；单次投料种类上限 8（正式模块限制，旧版为 100 项校验）；`perRelic`/`breakthrough` 由等价公式现算。
- `internal/rules` 补充 `SmeltMaterialIDs()` 与 `WorkshopConfig.RetainPerRelic()`（后者与 data.js `retainChancePerRelic` 同式，并替换 `SmeltPlan` 内的重复实现，行为不变）。
- 本地提交 `4bda2dd` 保存前一批规则、身份、交易、市集、工坊、商城、好友和持久卷验收工程；后续经济/运营批次持续整理。远程 CI 增加所有规则 oracle 漂移检查，尚未推送触发。
- 全部操作只涉及隔离合成数据库。未读取参考旧存档、未做迁移、未推送或部署。
- 旧交易契约接入：`POST /api/trade/invite|respond|set|confirm|cancel` 桥接到正式双人交易事务；`/events` 的 init 带 `trade` 快照，交易修订/状态变化时推送 `{"type":"trade","trade":{...}}`、结算推 `{"type":"tradeDone"}`（含双方 inventory/coins/invRev）。参与者按小写用户名投影，交易号暴露为 `T<数字>`，物品沿用旧背包口径（渔获/材料/宝匣按数量、组件按实例签名）。**同时修掉旧流租约两处真实缺陷**：`/events` 每 10 秒续期自己的在线租约（旧前端从不给游戏 API 发心跳，否则 15 秒后所有邀请都会以「对方不在线」失败）；关闭连接改用独立请求号（原先复用 open 请求号被命令幂等层回放，`close` 从不执行）。**已知偏差**：正式模块要求双方持有在线租约、邀请 10 分钟后自动失效（旧版仅邀请时校验在线且不自动失效）；推送为 1 秒轮询并由 watcher 自比 revision/state 去重（不是即时广播）；组件报价按实例逐个下发；`reason` 恒为 null（旧版会带「物品已变更/物品不足」文案，前端不读该字段）。
- 旧好友与玩家列表契约接入：`GET /api/friends/relations`、`GET|POST /api/friends`、`GET /api/players/page`、`POST /api/players/view|rod`。身份一律用**小写用户名**；在线=持有流租约，钓鱼状态与位置来自正式钓鱼会话；`locationName` 复刻旧口径（世界地图取钓点名、共享海域取 `sea_zones.data->>'name'`），并把内部的 `sea:<账号ID>:<zoneId>` 换算回旧版 `sea:<账号名>:<zoneId>`（ground 过滤时反向换算）。**已知降级**：`POST /api/players/view` 只做参数校验并确认，返回 `pushed:0`，尚未实现按 SSE 连接登记视口与 `playersPage` 推送。
- 旧订阅与反馈契约接入：`GET|POST /api/subscribe`（玩家级组件订阅配置 + bases/qualities/affixes 目录）、`GET /api/feedback`、`POST /api/feedback/submit|skip`（默认 24h 冷却 / 1 万金币跳过；冷却与费用在原版属运营配置，本批先固定为默认值）。新增 migration `0022_legacy_notify.sql`：`fishing.subscription_settings`（每账号一条 jsonb 配置）、`fishing.feedback_entries`（按账号与时间倒序索引）、`fishing.feedback_cooldowns`（每人一条冷却），并把 `feedback_skip` 加入 `asset_operations.kind` 白名单与 `assets` 命令类型白名单；`migrations.Count()` 取代 `migrate_test.go` 里硬编码的迁移条数，新增迁移不再需要改测试。
- 订阅/反馈的**已知偏差**：管理后台的 `feedbackCfg`（CD 时长与跳过费用）和「提交后给在线管理员推 notice」未接入，本批用固定默认值、只落库；`mine` 仅返回最近 20 条、全局保留 500 条与原版一致；提交与跳过共用一条事务（跳过扣费与清冷却原子提交，业务拒绝以 `Result.Status` 形式回写旧版中文）。
- 本批（trade / friends+players / notify 与上述基础设施修复）在**本机便携 PostgreSQL 18.6（127.0.0.1:5433，`FishingGoTestPg`）**上 `go test -count=1 -timeout=12m ./...` 全绿。注意：不设置 `FISHING_GO_TEST_DATABASE_URL` 时集成用例会静默 skip，满屏 ok 不代表通过；Docker Desktop 引擎本次不可用，改用上述便携实例。
- 本批的独立验证（HEAD `e6963de`，验证者不参与实现）：Windows 便携 PostgreSQL 18.6 真库全量 `go test -count=1 -timeout=10m ./...` 24 个包全 ok；Linux 容器 race 走 `tools/go-rewrite/test-postgres.ps1 -Linux`（含 `go mod verify` + `go vet` + `go test -race`）24 个包全 ok、退出码 0，容器与网络自动清理。Docker Hub 直连不可达时按 README 的镜像覆盖变量（`FISHING_GO_POSTGRES_IMAGE` / `FISHING_GO_TEST_IMAGE` / `FISHING_GO_TEST_GOPROXY=https://goproxy.cn,direct`）即可复现。**注意：不设置 `FISHING_GO_TEST_DATABASE_URL` 时集成用例静默 skip，无库跑批的"全 ok"不是通过。**
- 旧运营后台契约接入（slice 1，15 条）：`GET /api/admin/overview|stats|netstats|security|registration/stats|users|feedback`、`POST /api/admin/users/update|ban|setadmin|delete`、`POST /api/admin/feedback/status|del|reward|cfg`。新增 migration `0023_admin_console.sql`：`identities` 增 `ban_until/ban_reason/ban_by/ban_at/retired`，`auth_attempts` 增 `realm/username`，`feedback_entries` 增 `status_at/status_by/reward`，新增 `operator_settings`（反馈 CD/跳过费用，保存后玩家端立即生效）、`activity_samples`（分钟采样）与控制台审计表 `admin_audit`；`admin_grant` 加入资产命令白名单。**审计不复用 `operator_audit`**：运行期角色必须无法写 MFA 运维审计（这是阻止被攻陷进程自我授权的边界），控制台审计单列一张表并复用同一 append-only 触发器。生产部署需为应用角色补：`admin_audit` SELECT/INSERT、`activity_samples` SELECT/INSERT/DELETE、`operator_settings` SELECT/INSERT/UPDATE、`feedback_entries` 追加 UPDATE（测试夹具已在 `testdb.go` 同步）。
- 封禁模型：`banned` 仍是唯一的「当前是否封禁」标志（既有 `NOT i.banned` 判断一处未改），限时封禁写 `ban_until`，由 `identity.RunBanExpiry`（30 秒清扫，`app.Run` 启动）到点自动解封，`ban_until IS NULL` = 永久；封禁/改密/注销统一走「删除全部会话 + 过期实时连接租约 + 钓鱼会话置 paused」，在线流最迟 25 秒心跳时收到 `kicked`（旧版即时）。热力图由 `operations.RunStatsSampler` 每 60 秒采样（在线/钓鱼/挂单/交易/账号 + 按钓场、钓点钓鱼人数），`/api/admin/stats` 在 SQL 聚合（1h/60s、6h/5min、24h/10min、7d/1h、30d/6h）+ 28 天「星期×小时」热力格，尾部始终补 live 点；`netstats` 的 apiReqs/apiBytes 来自网关中间件计数，SSE 三计数来自 `/events` 与 `/api/v1/events` 写路径。
- 运营后台**已知偏差**：①`/api/admin/users/delete` 是「注销」不是真删——持久层把账号挂在 append-only 资产账本、渔获纪录与审计上，真删要拆账本；注销 = 用户名改 `retired_<id>`（原用户名可再次注册）、清空全部会话/连接、永久封禁、从账号列表隐藏，账面与历史保留，账号在编队或有进行中交易时拒绝注销。②`capSet` 恒 false（`listing_capacity NOT NULL DEFAULT 40`，持久层没有「未设置」态），挂单上限上限 10000（旧版 100000）。③限时封禁由 30 秒清扫解封；封禁/撤销管理员不再给玩家推 notice，改金币/奖励不推实时 `assets`（下次快照刷新可见）。④`lockouts` 只有账号名、没有来源 IP（Go 登录防护按 realm+账号，不按 IP）。⑤`registration/stats` 的 `challenged` 恒 0（Go 注册无挑战轮），`limits` 回旧版常量 200/10/5（Go 实际为每 IP 30 次/分钟、每账号 30 次/分钟）。⑥`notifyLevel` 固定 `all`、`biteFormula` 取 catalog `BITE_FORMULA_DEFAULT`（`/api/admin/settings` 未接入）。⑦users/snapshot*、`/api/admin/world`、横幅与 Wiki 内容编辑器仍不注册（保持 404）。
- slice 1 的集成用例：`internal/gateway/legacy_admin_test.go`（越权拒绝、只读投影、账号编辑/封禁-解封-到期/管理员授权/注销与用户名释放、反馈审核-奖励-删除-配置立即生效、审计 append-only）、`internal/modules/operations/stats_test.go`（采样、分钟去重、30 天清理、钓场/钓点筛选口径）。
- 旧 `/events` 推送补齐（第一批）：新增 `internal/gateway/legacy_push.go`，把每个域的**持久水位**投影成旧协议帧——`mktTrade`（买卖双方各一条，含 `role/other/qty/price/total/tax/sellerGain`）+ 卖家侧的权威 `assets` 快照、`marketDelta`（revision/total）、`friends` + 好友申请/同意 `notice`、以及登记视口后的 `playersPage`。`POST /api/players/view` 不再返回假的 `pushed:0`，而是返回该账号的在线流数并把视口登记进进程内 registry（`API.views`，单进程部署；多进程需共享状态）。每个投影各自持有游标（market 用 `market_fills.operation_id`、friends 用 `friend_relations.updated_operation`、trade 用 watcher 自比 revision/state/confirm），漏拍不会丢事件；`init` 现在带 `marketRevision`/`marketTotal`。
- `/events` 鱼类动态补齐：新增 `legacy_catch_push.go`，通过 `player_events` 的每玩家修订号 + 渔获 ordinal 投影 `feedBatch`（当前活动钓场过滤、每秒最多 10 条）与 `recordsDirty`，以及当前跨鱼种最大值的 `globalRecord`。不使用全局 operation ID 作为提交水位，避免跨玩家晚提交漏读；一竿超过 100 条可继续读取尾页；读失败不推进游标，重连从新基线开始，不重放历史社交播报。`recordsDirty.v` 为连接内递增的刷新标记。范围限 `catch_records` 中的鱼类：材料/组件动态、单鱼种/日榜横幅、通知等级过滤、初始 feed 历史与 records.last 仍未实现；单次轮询只播当前最大纪录，期间被超过的中间纪录不补播。本段为前一批社交流记录；个人 catch/资产路径随后已在本页“实时主链收尾”中修复。每连接保存玩家游标并轮询共享历史的成本仍需容量验收。
- `/events` 仍未覆盖：配置类推送（`bitecfg`/`castcfg`/`chestcfg`/`componentcfg`/`smeltcfg`/`mallcfg`/`pricecfg`/`groundcfg`/`grounds`/`autosellcfg`）、`banner`/`bannerStop`/`maintenance`、`records` 全量帧、`shop`、`seaEvict`、`batch`/`big`。推送为轮询各域水位（非即时广播），容量口径需在长测里复核。
- `internal/gateway/legacy_push_test.go`：真库覆盖市集成交双向帧 + 卖家 assets、好友申请/同意 notice、视口登记后的 playersPage 与 `pushed` 计数。
- 2026-09-21 鱼类动态验证：`legacy_push_test.go` 验证实际 `/events` 的地点、动态、榜单刷新与横幅；`legacy_catch_push_test.go` 验证 105 条递归分页、跨玩家反序提交、钓场隔离、相同最大值不重播、断线重连不回放历史，以及中途数据库读取失败后重试。最终 Linux Docker 隔离 PostgreSQL 全套 `go mod verify`、`go vet ./...`、`go test -race -count=1 -timeout=3m ./...` 退出码 0（gateway 129.379 秒），Windows `go build ./...`、gofmt 通过。默认镜像/模块源网络失败后使用 README 已记录的固定镜像站和 goproxy.cn；本机 5433 便携库不可用导致另一次 Windows 真库尝试失败，该次不计通过。测试容器与网络已清理；没有执行浏览器 A/B、生产迁移或部署。
- 旧 Wiki 契约接入（只读 5 条）：`GET /api/wiki/content`（元数据 + 更新记录 + `officialRevision`/`userRevision` + `ETag` 与 `If-None-Match` 304）、`/api/wiki/guides`（分页/`q`/`kind`/`category`，pageSize 默认 20 上限 50）、`/api/wiki/guides/{id}`（含正文段落，未知/不合法 id 回 404 中文文案）、`/api/wiki/guides/session`、`/api/wiki/simulator/inventory`（私有只读投影，不触发结算）。官方正文来自新增 `internal/wiki` 内嵌快照（生成器 `tools/go-rewrite/wiki-content.js` 带 `sourceSHA256`，CI 增加 `--check` 与 `frontend/wiki/content/content.json` 触发路径）。**已知偏差**：用户投稿与运营热保存未接入（`userRevision` 固定 0、列表不含投稿、更新内容需重建二进制）；revision 由快照摘要推导；`updatedAt` 取快照内最新日期；搜索按 Unicode 折叠大小写（旧版 SQLite LIKE 只折 ASCII）；未登录/封禁的 simulator 读取统一 401 `invalid_credentials`。
- **仍属剩余范围**：`/api/admin/*` 剩余约 58 条（世界/掉落/玩法配置编辑器、用户快照与回滚、公告横幅、市集运营、编队、Wiki 运营等）；用户攻略存储（含 24h 3 篇、待审 3 篇、自动通过规则）与运营注册策略（`/api/register/challenge`）仍待用户确认方案；其余配置类 SSE 推送（见上；钓鱼组件 subalert 已接入）；容量/故障/迁移/浏览器 A/B 仍按既定计划延期。

## 2026-09-21 实时主链收尾

- 个人渔获改用 `player_events.revision` 按完整操作分页，一页 16 个操作；同操作不按 100 条鱼截断。读取已提交 outbox 的 `catches`，因此鱼、材料、组件均有个人 catch 帧。旧 payload 缺失时按操作读取完整鱼纪录作兼容；不从当前钓点反推历史地点。
- 正式结算结果追加捕获时的钓场/钓点 ID、名称和时间；普通地图、远洋和共享海域均从结算时已校验的访问结果取名称。额外奖励不伪造为新的 primary catch，库存/图鉴快照包含已提交的全部奖励。
- `assets` 的金币、库存、大鱼、图鉴、累计渔获和 `invRev` 由同一只读 Repeatable Read 事务获取。初始化先确定快照水位再发送；轮询失败不推进游标。每个有新资产修订的轮询最多一份快照，取代不带修订号的逐鱼加一，覆盖自动出售、管理员奖励、工坊/宝匣和其他标签页修改；分页 catch 只写日志，不再重复加库存/图鉴。全量快照的带宽与 UI 重绘成本仍需容量/浏览器验收。
- 钓鱼获得组件时接通 `subalert`，包含递归追加；按底材、品质、同一词条的类型与闭区间筛选，关闭订阅立即影响后续轮询。`/api/me.subNotify` 读取真实配置，保留 badge/blink；订阅采用投影时的配置。当前功能发布模型还不支持旧版 `inventory.subscribe` 细粒度开关；宝匣/工坊获得组件不新增订阅提醒，与旧版触发点一致。
- 市集 16 笔分页保持待发送标志，无新 revision 也继续发尾页；读取组件或卖家快照失败时不提前确认 cursor/revision。好友在 init 之前播种水位，修复首轮轮询吞掉新申请。
- 修复旧 `/api/fishing/start|stop` 复用固定命令号，导致收竿后再次开钓只回放第一次成功结果的问题；每次旧 HTTP 动作使用新命令号。旧 SSE 心跳改为前端能够接收到的 `type:ping`。连接关闭清理提前登记，初始写入失败也释放自己的租约。
- 新增 `legacy_personal_push_test.go`、`legacy_push_recovery_test.go`：真实原生递归分段超过 100 条并保持鱼/材料/组件顺序、订阅开关/筛选、渔获后出售的权威对账、18 个操作 × 105 条的分页、初始化发送窗口、断线基线、读失败重试、在线发奖；20 次实际市集部分成交翻页和快照失败重试、好友初始窗口；生命周期测试追加连续开钓/收竿。沿用工作树已有的社交渔获推送和对应测试。
- 快照水位同时检查廉价唤醒读数与事件页末修订，修复两次读取之间新提交导致“游标已确认、快照未刷新”的竞态；`TestIntegrationPersonalPushCommitBetweenWakeupAndPage` 通过真实数据库锁精确制造该时序。
- **最终验证**：Windows 连接本轮隔离 Docker PostgreSQL，全量 `go test -count=1 -timeout=8m ./...` 退出 0（gateway 51.407 秒）；Linux 同一代码最终全量 `go mod verify`、`go vet ./...`、`go test -race -count=1 -timeout=3m ./...` 退出 0（gateway 105.381 秒）。Windows 构建、gofmt、diff 检查通过；Node 基线 3/3；默认 catalog 94 项、全部 2551 项规则 oracle、Wiki 内容快照漂移检查通过。未运行原前端完整浏览器 A/B、持久磁盘容量或故障放行测试，不能把此结果用于宣称整项重写或生产验收已完成。

## 2026-09-21 配置发布与公告

- `legacy_config_push.go` 从不可变 catalog/feature 发布头读取修订，只在改变时加载完整配置；投影 `componentcfg`、`smeltcfg`、`castcfg`、`bitecfg`、`groundcfg`、掉落部分的 `pricecfg` 和 `mallcfg`。初始化补发全套配置，相同内容不重复推送；读取失败保留旧游标。连接内个人/公共渔获、市集、玩家目录同步替换 catalog 指针。`/api/me` 也返回当前预览配置。
- `/api/grounds` 与 SSE 共用掉落投影，保留坐标/说明并展开嵌套掉落组和全服倍率。功能开关将 Go 的领域名转换为旧前端动作名，如 `mall` → `mall.buy`、`market` → `mall.list`/`mall.marketbuy`；关闭 `sell` 同时关闭自动售出显示。原生 `friends` 没有独立旧前端开关，仍由服务端拒绝；完整层级开关、排序和管理员穿透仍在剩余范围。
- 旧前端用开钓接口刷新配置时，同一钓点的活动会话只重算明细，不重置 generation/seq、随机种子、到期时间及未完成递归段；换钓点和收竿后重开仍创建新代。真库用例覆盖刷新与下一段结算并发，台账对账通过。
- 新增 `0024_banner_publications.sql`：`banner_state` 串行头、`banner_events` 不可变发布记录、`banner_watchers` 观看上报。新增公告后台 8 条路由，队列/事件/审计同事务提交；支持颜色/内容/时长校验、排序、配置、停止及清空，单队列上限 500。可选数字 `expectedRevision` 防止同版本覆盖；旧后台未传时按原有增量编辑语义串行执行。请求返回不确定提交错误时先重读队列，旧公告新增没有跨请求幂等号。
- `/api/banner` 不再固定空队列；`banner/playing` 使用实际条目和 15 秒观看 TTL。SSE 初始化发当前队列，之后按发布修订每页 16 条读取，尾页不依赖新事件，读失败不确认；重连不回放过去的停止操作。`catchLevel` 配置已持久化，但当前渔获横幅只实现总最大值 level 1（任何等级均允许），其余等级的实际播报仍待完整纪录通知。
- 运行期角色需额外授权：`banner_state` SELECT/UPDATE、`banner_events` SELECT/INSERT、`banner_watchers` SELECT/INSERT/UPDATE/DELETE；合成测试最小权限已同步，未自动变更任何正式角色。公告事件历史目前不自动清理，须计入持久磁盘空间验收。
- 静态路由覆盖更新为 98/152；未注册 54 条，其中后台 50 条。旧的 90/152 与 58 条后台数字属于上一批记录。
- Windows 本轮真库全套 build/vet/test 通过（gateway 51.978 秒），Node 原始接口/规则基线 3/3。Linux Docker 隔离真库全套 `go mod verify`、`go vet ./...`、`go test -race -count=1 -timeout=3m ./...` 退出 0（gateway 122.406 秒）；gofmt 和 diff 检查通过。完整旧浏览器 A/B、持久容量与生产迁移未执行。

## 2026-09-21 编队管理、海域驱逐与浏览器回归

- 新增旧后台编队列表与解散接口；使用现有拓扑守卫，成员、邀请、持久事件与追加审计同事务提交，支持可选修订冲突校验。失败审计回滚、双管理员并发解散、受众隔离及真实 SSE 通知已验证；不新增 schema。
- 修正旧编队与共享海域的账号标识，统一用小写用户名；进入海域、续钓、地图人数均完成双向转换，内部和 v1 仍用账号数字。新请求号消除编队快速操作的毫秒碰撞。
- 原生 worker 每秒轮转检查最多 100 个失去权限或过期的海域会话，并在玩家、钓鱼会话、编队拓扑、海域的固定锁序下重查权限。主动停止不再等待长竿到期；停止、代次与禁止续钓原子提交，旧 SSE 下发 `seaEvict`。恢复权限后的候选不停止、不缓存拒绝；双 worker 使用保留请求号防止重复提交；单候选失败继续处理本批其余候选。
- 新增原前端真实 Chrome 回归，使用隔离合成数据库与标准输入传递的测试会话，覆盖旧后台公告表单/停止/闪烁、catalog/功能更新、解散编队和玩家实时界面。单项通过（8.66 秒），随后 Windows 全量开启浏览器复验也通过。该覆盖不替代完整 Node/Go 浏览器 A/B。
- 静态路由覆盖为 100/152，剩余 52 条，其中后台 48 条；完整清单见 REMAINING。Windows gofmt/build/vet/真库全套通过（gateway 70.812 秒），Node 基线 3/3；Linux 真库 go mod verify/vet/race 全套退出 0（gateway 138.099 秒，默认跳过可选浏览器）。

## 2026-09-21 维护通知、价格与公共渔获

- HTTP 正常停服先转为未就绪，再以可识别的取消原因结束在途请求；旧 `/events` 和 v1 流在连接关闭前刷新最后一条 `maintenance`，旧流携带版本号。普通客户端断开不触发维护提示，停服也不误报会话被撤销。实际监听器与合成数据库回归覆盖两个协议、退出等待和旧流租约清理；不承诺断网或强杀进程时能够发送通知。
- 商店初始快照与增量 `shop` 帧连接权威供需报价，同一进程/不可变 catalog 版本每秒共用一次读取，内容未变不发送。出售者之外的在线玩家也收到变更；失败不清空价格表、不确认新快照。HTTP 即时报价及交易不走展示缓存，catalog 发布使缓存失效。
- 公共动态从原生持久渔获负载读取鱼、材料、组件，保留捕获时的海域和钓点名称，使用原版显示字段裁剪；旧操作无原生负载时才回退 catch_records，避免鱼重复出现。继续使用玩家修订/渔获序号分页和同钓场分发，每页最多展示末 10 条；全材料页面不会因没有鱼类纪录而失败。递归超过 100 条及原有逆序提交/失败重试测试通过。
- 本批 Windows build/vet/真库全套通过（gateway 70.309 秒，包含 Chrome），Linux 真库 verify/vet/race 全套退出 0（gateway 141.731 秒），Node 原始基线 3/3。完整纪录播报等级、历史动态和全套浏览器 A/B 仍在 REMAINING 中。

## 明确剩余范围

1. 正式钓鱼规则的完整旧版对照、活动与配置编辑器、长链长期积压/公平性验收。运行时 catalog 发布、远洋经验/悬赏/共享权限、递归分段恢复已实现；不能再次列为“未开发”。自动出售按最新选择独立扫描，供需在出售事务更新。
2. 原前端与全部旧 API/SSE 契约、注册挑战/运营注册策略、浏览器 A/B。新 v1 接口不能替代该项验收。
3. 已实现交易的旧契约逐项对照、到期/换装边界补充故障矩阵。
4. 活动、自动配装和完整通知契约、48 个尚未注册的后台接口、注册挑战、Wiki 投稿。旧版去重总榜/日榜/周榜查询已注册；纪录播报等级、历史动态、未接权威源的运营配置仍有缺口。公告队列、已有 catalog/feature 推送及海域主动驱逐已接。远洋和共享权限已接内部核心，旧 `sea:<用户名>:<zone>` 转换已经 HTTP/SSE 验证，完整浏览器 A/B 仍待验收。功能开关覆盖原八类及 sea/party/fishing。
5. 先完成 100 人长时间和完整玩法负载、写入中的数据库故障/进程重启、锁等待/SQL 次数，再阶梯测试 1000/5000 人；已有 SIGKILL 恢复是在停止负载之后进行。

接口、限购时区、管理员运维入口和功能发布语义详见 [GAMEPLAY_API.md](GAMEPLAY_API.md)。本清单不把阶段实现标记为五项整体交付完成。

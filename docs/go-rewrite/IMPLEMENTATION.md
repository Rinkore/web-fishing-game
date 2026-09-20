# Go 重构实施记录

更新：2026-09-20。依据：[架构方案 1.0](../go-architecture.md)。

## 当前状态

**基础工程、原型周期及多项正式规则/事务模块已实现，完整玩法与生产验收尚未完成。** 最新逐项状态见 [DELIVERY.md](DELIVERY.md)，新接口与运维边界见 [GAMEPLAY_API.md](GAMEPLAY_API.md)；下文保留前几批的实施证据。用户已确认正式服版本为 **v0.21.4**，并明确：当前不开展数据迁移，后续迁移时可以停服；运行中复制的存档仅供参考。基础工程和使用合成数据的原型可以先行，迁移核查不作为当前编码的前置阻塞。

本次从 `codex/go-rewrite` 的 `00614d2` 开始，玩法源码最近提交为 `026da976147053aa876e539b57581e7862a612bf`，版本标记 `v0.21.3`。原架构文档引用 `f98077d`，属于较早的方案核查依据；本次实现不修改其历史证据。后续基线变更以清单中的源码摘要和提交为准。

随后已合入本地 main 的 v0.21.4 发布基线（`13694a7`，main 当时为 `c163e46`）；两者 backend 代码一致，data.js 只更新版本标记。API 清单与 14 组规则样例已同步到 v0.21.4，规则输出未变。正式服实际部署文件摘要尚未独立比对，用户声明的版本不能替代该项验证。

## 本批交付

| 产物 | 已实现 | 边界 |
|---|---|---|
| [源码清单](../../server-go/api/legacy-inventory.json) | 157 个路由（其中 5 个开发接口）、40 个客户端事件分支、持久化域键及源码摘要 | 静态识别，非完整 OpenAPI；服务端 41 个 type 字面量含非 SSE 候选 |
| [规则样例](../../server-go/testdata/legacy-rules.json) | 14 个固定输入/输出，覆盖抛竿间隔、上下限、舍入、上钩覆盖、多钓组合及 JS 数值字符串 | 只验证现有 JS 基线；尚无 Go 玩法实现可比对 |
| [只读扫描器](../../server-go/internal/legacy/scan.go) | 原字节摘要、目录清单、重复 JSON 键/非法编码、数值精度、账号重名、资产数量和挂单引用检查 | 不修改源数据、不试导入，所有报告 importReady=false |
| [命令入口](../../server-go/cmd/import-legacy/main.go) | 必填离线目录/版本/报告路径；禁止写入快照或覆盖报告；固定错误码 | 版本由操作者声明，不自动探测正式服 |
| [CI](../../.github/workflows/go-rewrite.yml) | Windows/Linux 编译、格式、vet、测试；Linux race；基线漂移检查 | 配置已落地，远程执行结果另行确认 |
| [服务入口](../../server-go/cmd/game/main.go) | 配置校验、all 角色、SIGINT/SIGTERM、结构化日志与有界关闭 | 尚未注册玩法 API/SSE；其他角色明确拒绝 |
| [基础 HTTP](../../server-go/internal/platform/httpserver/server.go) | healthz/readyz、DB/schema 检查、探针超时及单探针并发、排空在途请求、超时强制关闭 | readiness 表示基础设施及当前 schema 可用，不宣称完整玩法就绪 |
| [PostgreSQL 连接池](../../server-go/internal/platform/postgres/pool.go) | 启动连通性检查、连接预算、语句/锁/事务闲置超时、同步提交、脱敏错误 | 已通过真实 DB 集成；连接层本身不执行 DDL |
| [依赖清单](../../server-go/dependencies.json) | 7 个运行时模块版本与 Go 校验摘要；配套完整许可声明 | 正式发布时另生成产物级 SBOM 并附 Go 工具链许可 |
| [结构版本管理](../../server-go/migrations/migrate.go) | 嵌入 SQL、事务级升级锁、历史摘要校验、失败回滚；独立 migrate 命令 | 新 Go 数据库结构；不导入旧服存档 |
| [金币资产核心](../../server-go/internal/modules/assets/transfer.go) | 玩家锁、余额边界、幂等及原结果查询、流水/outbox 同事务、有限重试 | 内部用例，尚未接入认证、市场/双人交易或公开 API |
| [库存/装备核心](../../server-go/internal/modules/assets/inventory.go) | 分类堆叠、独立实例、奖励/制作/消耗及资产包交换；金币/物品/装备共同提交或回滚 | 可信服务端计划；配方、词条、随机结果与权限需玩法层提供 |
| [钓竿归属](../../server-go/internal/modules/assets/rods.go) | 装卸、保存、切换、收起、删除、改名；绑定唯一性、归属外键和容量检查 | 内部命令，尚未接旧协议、扩容购买及整竿交易 |
| [共享资产事务](../../server-go/internal/modules/assets/transaction.go) | 钓鱼周期/市集状态与资产共用事务；稳定拒绝及可重试推迟、流水/outbox 原子提交 | 可信内部调用；子模块不持有提交权 |
| [钓鱼周期原型](../../server-go/internal/modules/fishing/service.go) | 持久代次/序号、连接有效期、HMAC 稳定随机、空竿推进、换装重排、固定价自动出售 | 合成且不可变的最小规则；非 v0.21.4 完整公式/在线语义 |
| [市集交易原型](../../server-go/internal/modules/market/service.go) | 单份库存/装备托管、整份购买、撤回/到期、价格重验、分页 | 无税费/部分成交/整竿/双人报价确认，未接旧 HTTP 协议 |
| [服务任务运行](../../server-go/internal/app/app.go) | all 启动有界钓鱼调度/到期扫描，游标轮转、失败重试、关闭等待任务退出 | 数据库扫描原型；未做正式容量/WAL/耐久性验收 |
| [Docker 测试](../../deploy/go-test/compose.yml) | PostgreSQL 18.6、Linux Go 1.27.1、唯一项目/动态端口、tmpfs、自动清理 | 镜像摘要固定；合成测试数据，非磁盘耐久性/性能验收 |

Go 工具链锁定 1.27.1，Node 本地验证版本 24.14.0；直接依赖锁定 chi v5.3.2、pgx v5.11.0。Go 默认模块代理在本机连接超时，本次进程使用 goproxy.cn 拉取，保留 Go 校验机制，未关闭 sumdb 或修改全局代理。

## 行为核对矩阵

“已有测试入口”仅表示仓库中存在该套件，不表示本批执行通过。

| 领域 | 已核对的迁移要求/证据 | 已有测试入口 | 待完成 |
|---|---|---|---|
| 账号/身份 | 账号名按小写归并；凭据及 MFA 不得进入报告 | security、transport-security、auth-ui | 正式哈希分布、MFA、管理员权限与会话策略 |
| 金币/背包 | 金币及数量需保留精度；异常负值不得静默归零 | bugfix、inventory-pagination | 逐字段字典、逐账号精确核对 |
| 大型/巨型鱼 | bigfish[item].L/G 是库存总量的预留子集，不是额外资产（server.js bigReservedOf/invAvailOf） | v0138、v0139 | 体型档出售/交易全路径等价 |
| 装备/钓竿 | rodUsageOf 跳过活动槽位，当前装备与活动槽位不能重复计数；编码不能直接当全局实例 ID | workshop-market-regression、v0212 | 复杂编码解析、装备归属与全部引用 |
| 市集 | 上架执行 invAdd(-qty)，整竿从槽位移除；挂单是托管资产，导入不得重复扣除 | abuse-market、workshop-market-regression | 购买/撤回/过期事务及成交流水 |
| 双人交易 | 独立归档现有 invite/respond/set/confirm/cancel 接口 | e2e、mobile-trade-regression | 报价版本、旧确认失效、断线/超时 |
| 钓鱼/公式 | 第一批纯计算固定样例；100ms 与默认 800ms 下限分别保留 | fishing-formulas、fishing-interaction | 受控随机、掉落、多钓、调度与恢复原型 |
| 商店/自动售出 | `/shop` 是现有读接口；`/api/me` 会触发 autoSellCheck，不能当无副作用的只读盘点入口 | v0138、v0139 | 供需、税费、配额与时区边界 |
| 工坊/宝匣 | 保留 forge/smelt/recast 和开匣入口 | smelt-workbench、chest、v0200-loot | 随机流、词条来源、失败及保留语义 |
| 远洋/编队/好友 | 当前代码比方案早期基线多，须纳入迁移与行为矩阵 | v0210、v0212、v0213、social-friends | 队伍状态、临时海域、任务与好友字段 |
| SSE | GET /events；JSON data.type 分发；batch.list 解包；init/ping/assets 等由 net.js 消费 | scene-performance、fishing-interaction | 各事件 payload、订阅范围、慢客户端、断线恢复 |
| Wiki | 当前分支已有 wiki.db；同时可能保留旧 JSON；存档扫描仅清点 SQLite/WAL/SHM | wiki/wiki、wiki/browser | 正式存储版本、SQLite 一致备份与独立核对 |

禁止从上述局部观察推导“旧协议全部兼容”。权限、输入/输出、业务错误、事务/幂等、SSE payload 需逐接口补充并验证。

## 验证记录

本地已运行：Node 基线测试 3/3，通过清单重建和 14 组规则断言；Go Windows 编译、vet 与单元测试通过。测试使用人工临时目录，覆盖原文不变、摘要变化、凭据/身份脱敏、重复键、超安全整数、极端指数、非法 JSON/UTF-8、孤立卖家、重复挂单及输出不可覆盖等场景。

新增服务测试覆盖：非法配置与角色拒绝、DB 连接超时、连接池预算、探针超时/并发、DB 故障时存活与就绪分离、关闭等待在途请求、关闭超时取消请求、日志不泄漏连接信息。Windows 构建、vet 和单元测试通过。

扫描器及 game 服务的 Linux/amd64 交叉编译通过；gofmt、go mod verify、git diff --check 通过。Windows 可执行文件的缺失数据库配置/不支持角色启动拒绝冒烟通过。Windows 符号链接测试因权限限制跳过，后续 Linux 容器全套测试通过该项。本批未运行旧游戏完整测试，也不引用 AGENTS.md 中旧版失败数作为当前基线；后续业务替换必须按套件做 A/B 对照。

用户要求 Docker 测试后已启动本机 Docker Desktop（引擎 29.8.0）。Docker Hub 直连失败，使用镜像站拉取固定摘要的 PostgreSQL 18.6 和 Go 1.27.1。Windows Go + Docker DB 集成通过；Linux Go + Docker DB 全套测试/race/vet 通过。测试用随机非超级用户登录账号验证实际权限，覆盖并发重放、双向转账、超支、持久拒绝、余额上限、outbox 故障回滚、锁等待取消重试、数据库中止重试及三次上限、逐账号流水对账、并发结构升级/篡改/失败回滚及 schema 就绪检查。

远程 CI 已补充独立 PostgreSQL 集成/race job，尚未推送触发。COMMIT 回包丢失、数据库崩溃、磁盘耐久性、长时间性能和恢复演练尚未完成；tmpfs 测试不作为这些能力的证据。资产边界与复核要点见 [ASSETS.md](ASSETS.md)。

2026-09-20 库存/装备批次：gofmt、Windows build/vet、Windows Go + Docker PostgreSQL 全套测试，以及 Linux 容器全套 race/vet 均通过；Node 清单检查及基线测试 3/3 通过，14 组规则输出保持一致。新增用例验证分类库存并发消耗、奖励去重、制作/付款/装备原子交换、装配与转移竞争、占用装备外键保护、装备创建及钓竿覆盖保存故障回滚，以及 0001 带历史升级后旧命令/事件兼容。未触及参考存档；0002 仅升级新 Go schema。

2026-09-20 周期/交易原型：Windows build/vet 和 Docker PostgreSQL 全套测试通过，Linux Docker 全套 race/vet 通过。新增覆盖重复周期、空竿、HMAC 固定向量、随机重试、停钓竞争、连接代次/失效、换装重排、公平扫描及固定价自动出售；市场最后一份抢购、装备托管、买入/撤回/到期和故障回滚；钓鱼收益与购买竞争、受限账号启动完整 all 服务并执行/关闭后台任务；0002 升级保留库存/装备/活动槽位。系统请求号前缀防占用纳入回归。Node 基线仍为 3/3，14 组既有规则输出未改。细节与尚未覆盖的正式玩法边界见 [PROTOTYPE.md](PROTOTYPE.md)。

参考存档初扫发生在用户明确延期迁移之前：175 个账号、353 条挂单、5,679 份历史快照，已有基础检查无异常。来源是运行中复制，不能据此证明一致性；报告以 unverified 来源版本保存在 Git 忽略目录，此后已停止存档/Wiki 核查。

## 2026-09-20 中断续作：海域、悬赏与编队

实现与 schema 推进至 0017，新增海图/船升级、出航/下锚、每日悬赏、四人编队与队友海域投影；HTTP 新契约详见 [GAMEPLAY_API.md](GAMEPLAY_API.md)。已落实用户确认的“换队失败保留原队”。双钓追加次数继续待确认，不在本批改变。

续作中修正编队幂等测试对 JSONB 字节顺序的误判，补充海域 HTTP 回放/归属/奖励防重和海域/编队开关。Linux Docker 真库全套 race/vet、Windows + Docker PostgreSQL 全套均已通过至 0017，累计 1727 项规则对照（含原始 14 项）通过，Node 基线 3/3；Windows build/vet、gofmt 和模块校验通过。下述早期“下一步”保留历史上下文，当前剩余范围以 DELIVERY.md 为准。

## 下一步及待确认

1. 钓鱼周期和市集交易已接入同事务原型，见 [PROTOTYPE.md](PROTOTYPE.md)。下一步接入 v0.21.4 正式 catalog/掉落/自动出售规则和对照样例，以及身份权限与 HTTP/SSE；完整交易还需双人报价确认、税费/部分成交/整竿等。WAL/空间和长测使用持久磁盘卷另行验收。
2. 按 v0.21.4 冻结关键 API/SSE payload、身份权限和错误契约；扩展工坊、供需、掉落及 JS 舍入规则对照样例。
3. 正式数据迁移按用户要求延期；到迁移阶段再停写获取一致快照、试导入并逐字段核对，当前不继续要求迁移资料。
4. 性能验收前明确同时在线口径、钓鱼比例/间隔、库存规模与磁盘条件；部署和整机故障数据承诺按架构方案在上线前确认。

尚未提交到 main、未推送、未启动/重启正式服务、未发布或部署。本批工作保留在当前 Go 工作树供审阅。

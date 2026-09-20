# Go 重构实施记录

更新：2026-09-20。依据：[架构方案 1.0](../go-architecture.md)。

## 当前状态

**当前已完成基础工程及首条金币资产事务，完整玩法与生产验收尚未完成。** 用户已确认正式服版本为 **v0.21.4**，并明确：当前不开展数据迁移，后续迁移时可以停服；运行中复制的存档仅供参考。基础工程和使用合成数据的原型可以先行，迁移核查不作为当前编码的前置阻塞。

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

远程 CI 已补充独立 PostgreSQL 集成/race job，尚未推送触发。COMMIT 回包丢失、数据库崩溃、磁盘耐久性、长时间性能和恢复演练尚未完成；tmpfs 测试不作为这些能力的证据。第一批资产边界与复核要点见 [ASSETS.md](ASSETS.md)。

参考存档初扫发生在用户明确延期迁移之前：175 个账号、353 条挂单、5,679 份历史快照，已有基础检查无异常。来源是运行中复制，不能据此证明一致性；报告以 unverified 来源版本保存在 Git 忽略目录，此后已停止存档/Wiki 核查。

## 下一步及待确认

1. 在已验证的金币事务之上推进库存/装备及可组合事务接口，然后实现钓鱼周期和交易原型；WAL/空间测量使用磁盘持久卷另行测试。
2. 按 v0.21.4 冻结关键 API/SSE payload、身份权限和错误契约；扩展工坊、供需、掉落及 JS 舍入规则对照样例。
3. 正式数据迁移按用户要求延期；到迁移阶段再停写获取一致快照、试导入并逐字段核对，当前不继续要求迁移资料。
4. 性能验收前明确同时在线口径、钓鱼比例/间隔、库存规模与磁盘条件；部署和整机故障数据承诺按架构方案在上线前确认。

尚未提交到 main、未推送、未启动/重启正式服务、未发布或部署。本批工作保留在当前 Go 工作树供审阅。

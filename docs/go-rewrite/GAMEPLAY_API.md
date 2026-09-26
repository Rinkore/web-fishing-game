# Go 已实现玩法接口与运维边界

本页描述新 `/api/v1` 契约，并补充已接入的旧接口边界，不是旧前端的完整兼容声明。整体任务进度见 [DELIVERY.md](DELIVERY.md)，最新待办见 [REMAINING.md](REMAINING.md)。截至 2026-09-22，正式钓鱼、远洋渔获/经验/悬赏、catalog 发布和递归分段恢复已接入，非开发旧接口已静态注册 152/152；逐项契约、完整浏览器 A/B、活动与后台实际行为以及生产验收仍未完成。静态注册不等于契约或浏览器通过。

## 隔离环境启动

旧协议补充（2026-09-22）：catalog/原生功能开关已连接旧 SSE，公告队列提供 8 条后台接口及持久发布/观看统计。`GET/POST /api/admin/features` 已支持旧层级、排序、局部布尔更新及 `adminBypass` 的保存/读取；根开关映射原生门禁，子开关与管理员旁路的逐动作权限等价仍需兼容验收。公告更新支持可选数字 `expectedRevision`，冲突返回 409；队列、发布记录和审计原子提交。详见 DELIVERY 的相应批次。

商城、熔炼、纪录和运营配置已有管理员持久化与审计，部分配置接入旧 HTTP/SSE 投影。必须分别验证“写入/回显”“实时推送”“权威结算采用”三个环节，不能因编辑器保存成功即认为全部配置生效。

编队后台 `GET /api/admin/parties` 与 `POST /api/admin/party/disband` 已接入管理员会话，支持可选数字 `expectedRevision`；成员/邀请移除、事件及审计同事务提交。旧接口的成员与海域所有者使用小写用户名，v1 保持数字账号字符串。正式 worker 每秒检查最多 100 个失去共享权限或过期的海域会话，按游标轮转并在事务内重新核验，停止后由旧 SSE 下发 `seaEvict`；不依赖长竿到期。编队权限复核和主动驱逐均已有真库并发回归。

旧 SSE 初始化包含实际商店价格，并在报价/销量变化后推送 `shop`；展示最多复用一秒快照，交易仍使用即时权威报价。公共动态覆盖鱼、材料和组件，以持久原生负载保留捕获时的位置。正常关闭 Go HTTP 服务时，旧/v1 SSE 最后发送 `maintenance` 后退出；强杀进程和网络故障无此承诺。

注册兼容：`POST /api/register` 接受原表单的 `confirmPassword`，同时保留 `passwordConfirm`；两者提供时都须匹配。注册与登录成功包含旧前端必需的 `profile`。默认每小时全局 200 次、来源 10 次、用户名 5 次有效注册尝试；同来源第 4 次起需要 `proof`，挑战返回 403 / `REGISTRATION_CHALLENGE`。`GET /api/register/challenge` 提供 120 秒、来源绑定、单次使用的 SHA-256 工作量证明；每分钟全局 600 次、来源 20 次，最多保留 5000 个有效挑战。配额与挑战存 PostgreSQL，重启或多实例不重置；错误答案、来源错误和过期答案消耗已存在的挑战，技术失败回滚。来源取实际 TCP 对端，忽略客户端自行传入的转发头；生产代理部署必须单独落实可信来源边界。

使用独立 PostgreSQL 数据库，先运行 `cmd/migrate`，再以管理数据库连接运行 `go run ./cmd/catalog defaults` 发布默认物品定义。运行应用的数据库角色不需要物品定义写权限；参考 `internal/testdb/testdb.go` 中各模块授权，生产角色仍须独立部署审阅。

`FISHING_GO_DATABASE_URL` 是应用连接，`FISHING_GO_MIGRATION_DATABASE_URL` 是运维连接。连接值不得写进文档、命令参数或提交。`FISHING_GO_TIMEZONE=Asia/Shanghai` 指定每日商城刷新时区；省略时沿用操作系统本地时区。需与原服匹配，不能把 Docker 的 UTC 默认当作已确认的业务时区。

## 身份与请求

- 注册、玩家登录/退出：`/api/register`、`/api/login`、`/api/logout`。管理员有独立 `/api/admin/login`、`/api/admin/logout`、`/api/admin/session`。
- 支持 Bearer 会话；Cookie 模式使用 HttpOnly / SameSite=Strict。Cookie 写请求必须带 `X-Requested-With: FishGame`，JSON Content-Type；跨 Origin 拒绝。
- 资产写操作使用稳定 `requestKey`，限 1–128 个 ASCII 字母、数字或 `-_.:`。超时或丢失回复后先查 `/api/v1/operation?key=...`，或用同一输入与同一 key 重试；同一 key 改输入报冲突。系统自动命令前缀禁止客户端占用。
- 玩家、装备、交易、订单及操作 ID 按 JSON 字符串传输。身份由服务端会话决定，客户端不能指定操作者。
- 新命令在玩家锁内再次校验会话。旧请求成功结果也不会对已撤销会话返回；业务拒绝可作为同一请求的稳定结果。

## 玩法入口

| 路由 | 当前支持 |
|---|---|
| GET `/api/v1/me` | 身份、金币、资产修订、钓竿容量 |
| GET `/api/v1/assets` | 库存/装备分页；修订变化使旧游标失效 |
| GET `/api/v1/codex` | 已登记图鉴数量和首次时间按物品 ID 分页；由开箱和正式内部钓鱼登记，体型详情尚未映射到该接口 |
| GET `/api/v1/events` | 玩家修订失效通知，支持 Last-Event-ID；不是旧版 SSE 全量消息 |
| POST `/api/v1/presence` | connect / heartbeat / disconnect，代次防旧连接续租 |
| POST `/api/v1/rod/change` | 已实现的钓竿配置操作 |
| POST `/api/v1/trade/invite`、`/api/v1/trade/change` | 双人报价、版本、确认和取消；GET `/api/v1/trade` 查看 |
| POST `/api/v1/market/list`、`buy`、`cancel` | 材料/宝匣、独立装备与整竿挂牌，部分成交，费用与托管返还 |
| GET `/api/v1/market`、`/api/v1/market/history` | 订单和成交历史分页 |
| POST `/api/v1/workshop` | smelt / recast / forge；随机意图持久化，技术重试不重新抽签 |
| POST `/api/v1/chest` | craft / open；合成数量 1–99，默认保底关闭 |
| GET `/api/v1/mall`、POST `/api/v1/mall/buy` | 默认商城，按时区每日限购，数量 1–99 |
| GET/POST `/api/v1/friends` | 分页关系；request / accept / reject / cancel / remove |
| GET `/api/v1/sea` | 船级/经验/海图、自有有效海域、当前队友共享海域 |
| POST `/api/v1/sea` | `action: chart` 合成一张海图；`action: upgrade` 携带 `expectedLevel` 升级 |
| POST `/api/v1/sea/voyage` | 消耗一张海图生成海域，持久化随机意图、并发上限与重试去重 |
| POST `/api/v1/sea/anchor` | `zoneId` 指定自有有效海域，扣费/材料、续期与增益共同提交 |
| POST `/api/v1/sea/quests` | 刷新当日悬赏，写请求需 `requestKey`；同日换 key 不会重抽 |
| POST `/api/v1/sea/quest/claim` | `id` 指定悬赏；上交物品、奖励与领取标记同事务 |
| GET/POST `/api/v1/party` | 查看编队/邀请/队友海域；create / invite / accept / decline / leave / kick / disband |
| GET `/api/v1/party/events` | 按 `after` 修订游标读取本人相关编队变更；`limit` 为 1–100 |
| GET `/api/v1/shop` | 默认规则下的共享供需收购价 |
| POST `/api/v1/sell` | 渔获/材料的 normal / large / giant 数量出售 |
| POST `/api/v1/sell/equipment` | 独立装备固定收购价；不能消耗占用或托管装备 |
| GET/POST `/api/v1/autosell` | 读取/完整替换个人规则；`settings.rules` 按物品 ID，`includeTiers` 控制大型/巨型 |
| POST `/api/v1/autosell/run` | 手动执行自动出售检查；合计批量门槛默认 100 |

在线自动出售每 2 秒扫描，单批最多 64 人，游标轮转；离线和封禁账号不执行，重复 worker 不重复出售。它作为独立任务按最新配置与权威库存再次检查候选资产；出售与供需变化在同一事务提交，不能将独立扫描误写成“正式钓鱼未实现”。默认供需公式已使用原生规则；经济服务当前仍使用默认 `PriceOverride` / `PriceDynamics`，运营 `priceCfg` 的保存/回显不等于价格结算已采用覆盖值。`/api/shop/history` 的历史点和成交流仍为空数组，完整运营配置与历史采样待验收。

## 海域、悬赏和编队边界

普通地图和远洋正式钓鱼周期已接入，递归剩余队列及随机游标由 `0019` 持久化并支持分段恢复。双钓已获用户确认保留旧版递归追加：每次成功渔获判定 0–2 条追加，追加渔获再次判定，因此整竿渔获可超过 3 条。该行为与旧源码注释的整竿上限不一致，实现和验收以用户确认的实际行为为准；长期积压、公平性与完整 Node/Go 规则对照仍需专项验收。

海图合成默认消耗 3 张碎片。船升级同时检查预期等级、经验门槛、金币和鳞片；经验只作为门槛，不扣除。出航最多保留 3 片有效海域，过期海域不占额度。下锚沿用旧版的“当前时间加续期时长”，并非在原到期时间上叠加；到期海域和其他玩家的海域拒绝下锚。持久随机意图确保技术失败重试不更换鱼池，海域 ID 使用操作号保证唯一。

每日悬赏采用配置时区及旧版的时间平移刷新规则。玩家私有随机种子持久化，同一天不同请求号得到同一组悬赏；出航进度已接入，上交类按当前普通库存检查并扣除，远洋钓鱼类悬赏进度与出海经验已接入正式渔获事务。悬赏刷新会创建或替换当日任务板，因此使用 POST；相同请求号回放当时结果，获取最新进度应使用新的请求号。

编队上限 4 人，仅队长向好友发邀请；`invite` / `kick` 带字符串 `targetId`，`accept` 带字符串 `partyId`。离队时按实际入队顺序继任队长。**已获用户确认的兼容修正：目标队伍满员时保留原队与邀请；容量检查和换队在同一事务完成。** 同一玩家最多保留一份当前邀请，旧邀请不再接受。

共享海域只投影当前队友的有效海域，隐藏队友鱼池；换队、踢出、离队、解散或过期后重新读取即撤销可见性。编队变更使用独立串行修订和受众列表持久化事件；客户端轮询 `/api/v1/party/events` 后重读编队视图，不能把资产 SSE 游标当作编队游标。正式钓鱼在开钓、结算和主动驱逐时都复核成员及海域期限。

## 管理员 MFA 运维

`go run ./cmd/admin provision` 只从标准输入读取包含 `username`、Base32 `secret` 和当前 `otp` 的 JSON。账号需已存在；运维数据库连接和 32 字节加密密钥分别由上述运维环境变量和 `FISHING_GO_MFA_KEY`（Base64）提供。输入应来自受保护的凭据管理流程，不应把真实 secret/OTP 写入终端历史或普通文件。

工具先验证验证码，再同时保存账号绑定的 AES-GCM 密文、启用管理员、消耗验证码、撤销原管理员会话并写追加式审计。该验证码不能再用于登录。`go run ./cmd/admin revoke` 从标准输入读取仅含 `username` 的 JSON，撤销管理员权限和管理员会话，保留独立玩家会话。应用角色没有运维审计插入权限；该入口不暴露为 HTTP。旧服十六进制 MFA 密钥迁移仍属后续停服迁移工作。

已授权的管理员也可以在后台「账号管理」页为管理员生成 / 轮换 TOTP 密钥：`POST /api/admin/users/totp`，body 为 `{"target":"<用户名>","confirm":true}`，需要管理员会话与二次确认，只接受已授权且未封禁的账号（未授权返回「该账号不是管理员，请先打开「管理员」开关」）。服务端用 `crypto/rand` 生成 20 字节 Base32 密钥，落库的是与运维入口相同的 AES-GCM 密文，同时把 `mfa_last_step` 重置为 -1、注销该账号的后台会话（给发起方自己轮换时保留当前会话）、写 `admin_audit` 的 `users/totp`。Base32 `secret` 与 `otpauth://`（SHA-1 / 6 位 / 30 秒）只在这一次 200 响应里返回，审计、日志与账号列表投影都不含密钥。

## 功能开关发布

GET `/api/v1/features` 读取当前修订。管理员 POST `/api/admin/v1/features`，必须包含 `requestKey`、字符串 `expectedRevision` 和完整八项 `flags`：`market`、`trade`、`workshop`、`chest`、`mall`、`sell`、`autosell`、`friends`。另支持 `sea`、`party`、`fishing` 三项；旧八项发布仍合法，省略的可选项按开启处理。每次发布完整替换配置，要保持关闭必须显式带 `false`。

发布内容、摘要、操作者、操作号和时间存为不可变版本，原子替换发布指针；过期预期版本拒绝，避免覆盖另一位管理员的更改。资产事务取得玩家锁后读取当前开关；发布前已通过检查的事务允许完成。关闭出售也阻止自动出售。取消/到期返还不被关闭操作阻断。`sea=false` 阻止合成海图、升级、出航和下锚，仍可刷新悬赏及领取已达成奖励；`party=false` 阻止创建、邀请和加入，仍可拒绝邀请、离队、踢出和解散。`fishing=false` 阻止新正式周期开钓，并在发布事务内将活动正式及原型会话停止、递增 generation、关闭正式会话自动恢复；`trade=false` 在同一事务取消 invited/accepted 交易。发布失败时这些状态变更一并回滚。此机制不等同紧急维护排空，原前端全部层级门禁与旁路行为仍需逐项对照。

## 验证命令

在 `server-go` 执行 `gofmt -l .`、`go build ./...`、`go vet ./...`，设置隔离真库的 `FISHING_GO_TEST_DATABASE_URL` 后执行 `go test -count=1 ./...` 并核查 skip。从仓库根目录运行 `tools/go-rewrite/test-postgres.ps1 -Linux` 验证真实 PostgreSQL 与 race；`test-persistent.ps1` 的默认入口是 100 人、7200 秒正式 HTTP/SSE 玩法负载，专项短测和故障证据仍须标明未达容量门槛。Node oracle 脚本统一使用 `--check` 检测漂移，不应无说明更新输出。`npm run go:coverage` 只验证路由存在；同 SHA 的契约与浏览器结果须另外记录。完整日志保存忽略目录，终端仅显示末 40 行并保留原退出码；并行隔离及固定端口串行要求见 [PARALLEL_ACCEPTANCE.md](PARALLEL_ACCEPTANCE.md)。

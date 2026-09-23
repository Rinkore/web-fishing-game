# 旧协议 HTTP 契约矩阵（生成稿）

核对基线：Node 1d48dbf4bd6a265d188d0234f55636bd31a42191，玩法 v0.21.4；清单 SHA256 3c40596ad27da3b329b2dfb7318b5f113bc6915d9f2f8f38a76630fc3faabf2f；shared rules SHA256 d1df3621a0599c39293df4de00ee54e95d595dadf20fe75650194b02bb24f2c0；client.js SHA256 e287ed3663ada0142552ee38ab6024a487730c617977774a19f50623c43c5582。分母为 157 个候选减 5 个开发接口 = 152 条唯一非开发 method + path。

本表由 `node tools/go-rewrite/api-contract-matrix.js` 从 `server-go/api/legacy-inventory.json` 生成。契约类定义行为断言；路由表逐项列出 method/path、认证、输入、成功、业务错误和持久副作用。HTTP 通过必须在 Node/Go 适配夹具中分别执行并比对，静态注册不计作通过。

## 契约类

| 类 | 认证/权限 | 输入校验 | 成功响应 | 业务错误/状态 | 持久副作用 |
|---|---|---|---|---|---|
| AUTH_CHALLENGE | 公开，无会话 | 无 body；按来源地址限流 | 200 challenge（含 proof 参数） | 429 rate_limited；503 unavailable | 注册挑战计数/挑战存储；不创建账号 |
| AUTH_REGISTER | 公开；注册防滥用策略 | {username,password,confirmPassword?,proof?}；严格 JSON、字段/密码校验 | 200 {ok,token,profile,username,name,admin}，可按 X-Session-Mode 写 cookie | 400 invalid_input；403 REGISTRATION_CHALLENGE；409 username_exists；429 rate_limited；503 unavailable | 原子创建 identity、wallet、player_state、会话；审计/注册计数；失败不得半创建 |
| AUTH_LOGIN | 公开；/api/admin/login 还要求 admin 登录语义和 OTP | {username,password,otp?}；严格 JSON；登录端点按来源限流 | 200 登录投影（token 或 cookie、profile） | 400 invalid_input；401 invalid_credentials；403 account_banned/MFA_SETUP_REQUIRED；429 rate_limited；503 unavailable | 创建/轮换会话；管理员会话含 MFA 状态；失败无持久副作用 |
| AUTH_LOGOUT | 玩家 token；admin 路径需管理员 token/MFA | 空 JSON（token 由 Authorization/Bearer 或 cookie） | 200 {ok:true}，清理对应 cookie | 401 invalid_credentials；403 admin_required/MFA_SETUP_REQUIRED；503 unavailable | 撤销会话；重复登出必须无害 |
| AUTH_ME | 玩家 token；/api/admin/session 需管理员 session + MFA | GET 无 body；POST /profile 仅 {name} | GET /me profile/资产投影；GET admin/session {ok,username,name}；POST {ok:true} | 401 invalid_credentials；403 admin_required/MFA_SETUP_REQUIRED；400 invalid_input/invalid_name；503 unavailable | GET 只读但会读取权威资产；POST 只修改 display_name，长度按 UTF-16 截断 |
| PUBLIC_READ | 公开 | 查询参数按路由定义；未知/越界参数返回业务 4xx | 200 JSON 目录/配置/排行榜/价格 | 400 invalid_input；404 unknown_item/unknown_fish；503 unavailable | 只读；不得改变金币、库存、纪录或版本 |
| PUBLIC_MARKET | 公开；有会话时用 token 标示 mine | scope/kind/part/q/affix/min/max/page/size 等过滤；分页边界校验 | 200 {listings,page,pages,total,counts,parts,revision,...} | 400 请求参数无效；503 unavailable | 只读市场挂单/修订；无资产变更 |
| USER_READ | 玩家 token（部分 legacySession 允许 cookie；失效统一 401 未登录） | 只读查询；严格分页/目标 ID/枚举校验 | 200 路由投影（profile/资产、海域、编队、社交、订单、工坊等） | 401 未登录/invalid_credentials；400 invalid_input；404 unknown target；503 unavailable | 只读；不得隐式出售、开箱、扣费或推进玩法 |
| USER_WRITE | 玩家 token | 严格 JSON、DisallowUnknownFields；路由专用字段和枚举/数量/范围校验 | 200 {ok:true,...} 或 legacy 业务结果，附权威资产 rev/余额/库存 | 400 invalid_input/业务拒绝；401；403；404；409 状态冲突；429；503；commit_unknown | 同一 PostgreSQL 事务提交资产、流水、outbox/事件；重复请求按旧协议语义处理；失败回滚 |
| SSE | 玩家 token；Authorization 或 fish_game cookie | legacy /events 使用 stream cookie/bearer；Last-Event-ID 仅属于独立 v1 stream；连接上限/写超时 | text/event-stream；legacy 首帧 init，随后 data JSON 和 heartbeat；v1 才有 snapshot_required/assets_changed | 400 invalid_input；401；429 rate_limited；断线/读库失败关闭；kicked/maintenance 事件 | 建立 gateway_stream lease；只读事件游标；关闭释放 lease；不直接改资产 |
| SEA_READ | 玩家 token | 无 body（token query/header） | 200 海域/船/海图/任务/共享区域投影 | 401；400 invalid_input；503 unavailable | 只读；状态以持久海域表为权威 |
| SEA_WRITE | 玩家 token | {zoneId|id|action 相关字段}；枚举、归属、开关和资源校验 | 200 {ok:true,...} 或 sea 状态/资产快照 | 400 invalid_input/业务拒绝；401；403；404；409；503 | 事务更新船、海图、航次、任务、锚地或共享区域；奖励/费用与 outbox 原子提交 |
| FISHING | 玩家 token | start {groundId,spotId}；stop 空 JSON；地图/钓点/状态枚举校验 | 200 {ok:true,...}；后续 SSE catch/assets/records | 400 invalid_input/不在场/重复状态；401；409 状态冲突；503 | 创建/结束持久 fishing session；调度收益由服务端决定；资产与纪录原子写入 |
| ROD | 玩家 token | slot/name/force/part/compId；槽位、归属、锁定和部件合法性校验 | 200 {ok:true,...} + rod/资产投影 | 400 invalid_input；401；403 locked；404；409 occupied/conflict；503 | 扩容扣费、装配/保存/切换/收起/删除均事务更新 rods、component lifecycle、assets_rev |
| ECONOMY | 玩家 token（GET autosell/mall 也需玩家） | sell {id,qty,tier L|G}；mall {id,qty}；autosell 规则/批量字段严格校验 | 200 {ok:true,gain|sold,coins,inventory,invRev,shop,...} | 400 invalid_input/unknown_item/insufficient；401；403 feature off；409；503 | 金币、库存、价格/自动售出设置、流水和 assets_rev 同事务；重复操作必须可核对 |
| MARKET_WRITE | 玩家 token | list {id|rodSlot,qty,price,hours}；buy/cancel {lid,qty?}；数量/价格/时长/所有权校验 | 200 状态消息 + 市场修订 + 权威资产快照 | 400 参数/数量/物品无效；401；403；404；409 price/status conflict；429；503 | 托管、部分成交、整竿、撤回/到期、金币/库存和交易流水事务提交；事件推送 marketDelta/mktTrade |
| TRADE | 玩家 token；双方分别授权自己的操作 | invite {target}；respond {tradeId,accept}；set {tradeId,items}；confirm/cancel {tradeId} | 200 {ok:true,trade,...}；完成时双方资产快照 | 400 invalid/未接受/物品不足；401；403 no ownership；404；409 version/status；429；503 | 交易状态、报价版本、双方资产交换与 tradeDone 事件原子提交；重复确认不可重复结算；超时/取消返还托管 |
| SOCIAL_READ | 玩家 token；legacySession 失效为 401 未登录 | q/page/size/ground/spot 或 target；分页和目标格式校验 | 200 friends/relations/players/rod 投影 | 400 invalid_input；401 未登录；404 player_not_found；503 | 只读；POST players/view 仅更新进程内 viewport lease，不改变业务资产 |
| SOCIAL_WRITE | 玩家 token | {target,action}；create/accept/decline/cancel/kick 等枚举、在线和关系校验 | 200 {ok:true,...} + friends/party 投影 | 400 invalid/自己/无邀请；401；403；404；409 relation/status；503 | friend_relations/party_members/invites 持久化；事件 friends/trade/party 推送；幂等请求不重复关系 |
| SOCIAL_VIEW | 玩家 token；legacySession 失效为 401 未登录 | {page,size,q,ground,spot,clear}；分页和过滤格式校验 | 200 {ok:true,pushed}（pushed 为当前有效 SSE 数） | 400 invalid_input；401 未登录；503 | 仅登记当前账号的进程内 viewport；不改资产；Go 尚未桥接 Node 的 playersPage 推送 |
| NOTIFY_READ | 玩家 token | GET 无 body；token 解析 | 200 subscription catalog/config 或 feedback status/mine/coins | 401；503 | 只读 |
| NOTIFY_WRITE | 玩家 token | subscribe {on,baseId,quality,affixType,min,max,badge,blink}; feedback {text,kind} 或空 skip | 200 cfg/entry/status/资产快照 | 400 invalid/未知枚举/空文本/未在冷却/金币不足；401；429 cooldown；503 | subscription_settings 或 feedback/cooldown、金币/流水同事务；反馈保留上限和冷却持久化 |
| WORKSHOP_READ | 玩家 token | GET 无 body | 200 workshop/chest 配方、库存、pity、余额 | 401；503 | 只读；不得触发 autoSell 或随机 |
| WORKSHOP_WRITE | 玩家 token | chest craft/open；smelt {mainId,subId,mainAffix,subAffix,materials,pearl,relics}；forge/recast {id,...}；数量、归属、词条、材料校验 | 200 结果 item/affixes/pity + 权威 coins/inventory/invRev | 400 unknown/invalid recipe、材料/金币不足、词条上限/不可重铸；401；403 feature off；409；503 | 组件/材料/金币、随机结果、pity、保留和流水原子提交；SSE assets；随机由可控 fixture/seed 注入验收 |
| WIKI_READ | 公开（simulator inventory、my 需玩家 token；session 为可选探针） | guides page/pageSize/q/kind/category/id；ID/分页规范化 | 200 content/guides/detail/session 或只读 inventory | 400 invalid；401（需要玩家的读）；404 guide not public；503 | 只读；ETag/If-None-Match 304 不改变 revision |
| WIKI_WRITE | 玩家 token | submit 原始 JSON ≤80KiB，严格 schema；delete {id} | 200 {guideId,status,limits} 或 {ok,limits} | 400 schema/ID/状态；401；404；409；429 quota；503 | SQLite/PostgreSQL Wiki guide、revision、审核日志持久化；配额/状态更新原子；官方自动审核由配置控制 |
| ADMIN_READ | 管理员 session；admin cookie/Bearer 且 MFA 已完成 | GET 查询参数按面板定义 | 200 管理统计/配置/用户/世界/审核视图；Wiki content 支持 ETag 304 | 401 invalid_credentials；403 admin_required/MFA_SETUP_REQUIRED；400；503 | 只读；不得因查看触发游戏资产或配置写入 |
| ADMIN_CONFIG | 管理员 session + MFA | settings/features/mall/smelt/records/component/fish 等配置字段；reset/validateOnly；revision/枚举/范围校验 | 200 {ok:true,revision/config,...}；配置推送 SSE type 字面量 | 400 invalid/unknown key/range；401/403；409 revision；503/commit_unknown | operator_settings/catalog revision/审计日志事务写入，并广播 features/*cfg；失败不得部分落盘 |
| ADMIN_WORLD | 管理员 session + MFA | ground/spot/pool/loot/component/fish simulate/config 字段；ID、权重、锁定和范围校验 | 200 当前 world/catalog 或模拟结果 | 400 invalid/unknown/lock conflict；401/403；404；409；503 | 世界/掉落池/目录版本及 operator audit 持久化；变更推送 groundcfg/componentcfg 等 |
| ADMIN_USERS | 管理员 session + MFA；自删/自撤权/最后管理员保护 | target、name/password/coins/listingCap/admin/ban hours/reason/confirm 等字段 | 200 用户列表/单用户/资产快照结果 | 400 invalid/confirm/last-admin；401/403；404 account；409 active trade/party；503 | 身份、权限、封禁、钱包、会话和审计原子更新；删除/回档踢出会话并保留审计 |
| ADMIN_SNAPSHOT | 管理员 session + MFA | target/key、expectedInvRev、coins/inventory/inventoryTiers/bd、snap、confirm；cfg {enabled,intervalMin,keep} | 200 snapshot(s)/rollback/config，invRev 与 inventoryTiers 来自一致性视图 | 400 malformed/confirm/config；401/403；404 account/snapshot；409 assets_revision_conflict；503 | 复用数据库玩家快照与保留策略；编辑在资产锁内校验 expectedInvRev，回档事务覆盖资产、装备、钓竿并使旧会话失效 |
| ADMIN_MARKET | 管理员 session + MFA | lid/action/supply/bulk seller keys/rates/limits；批次 1..500 等约束 | 200 市集供给/批处理结果和 revision | 400 参数/卖家/模式；401/403；404；409 duplicate request/status；503 | 系统供给挂单、归还托管、批量生成/暂停和审计；资产/市场流水原子提交 |
| ADMIN_BANNER | 管理员 session + MFA（playing 为玩家 token） | banner add/remove/move/update/cfg/stop/clear：id/content/duration/color/dir/config | 200 banners/cfg/queued result；playing 200 统计确认 | 400 color/content/range/dir；401/403；404；409 banner_revision_changed/full/endpoint；503 | banner 队列/config/revision/审计持久化；广播 banner/bannerStop；playing 只更新观看统计 |
| ADMIN_FEEDBACK | 管理员 session + MFA | feedback status/del/reward/cfg：id/status/coins/note/cdHours/skipCost | 200 feedback list/update/config | 400 status/coins/config；401/403；404 feedback/account；409；503 | 反馈状态、奖励金币、配置及审计事务；奖励只能一次且可对账 |
| ADMIN_WIKI | 管理员 session + MFA | content {baseRevision,content|reset,target}；review {id,action,expectedStatus,note}；delete {id,reason} | 200 content/revision/guides 或 reviewed/deleted guide | 400 schema/action/note；401/403；404 guide；409 revision/status；503 | 官方内容/用户稿件状态、revision、更新日志、审计原子写入；ETag/SSE 修订可验证 |
| ADMIN_RECORDS | 管理员 session + MFA | delete {id?}；delone {id,range,kind,expected...}；config scale/x/y/reset | 200 records/config/deletion counts | 400 fish/config；401/403；404；409 rank/record changed；503 | 纪录隐藏/删除及 records config、审计持久化；广播 recordsDirty/recordscfg |
| ADMIN_PARTY | 管理员 session + MFA | disband {id} | 200 {ok:true,...} | 400 invalid id；401/403；404 party；409 active/conflict；503 | 解散 party、清理成员/邀请并推送 party/trade 事件；审计 |
| BANNER_PLAY | 玩家 token | {id}；JSON 严格解码；未知横幅为幂等 ignored | 200 {ok:true} 或 {ok:true,ignored:true} | 400 invalid_input；401；503/commit_unknown | banner_watchers upsert（观看统计）事务提交；不改玩家资产 |

## 逐路由矩阵

| # | method + path | Node 行 | Go 注册处理器 | 契约类 | 本路由输入/查询 |
|---:|---|---:|---|---|---|
| 1 | POST `/api/admin/logout` | 4302 | `a.logout` | AUTH_LOGOUT | admin token |
| 2 | GET `/api/features` | 4322 | `a.legacyFeatures` | PUBLIC_READ | none |
| 3 | GET `/api/admin/features` | 4323 | `a.legacyAdminFeatures` | ADMIN_READ | token? |
| 4 | POST `/api/admin/features` | 4327 | `a.legacyAdminFeatures` | ADMIN_CONFIG | token,features,featureOrder,baseRevision? |
| 5 | GET `/api/register/challenge` | 4378 | `a.registerChallenge` | AUTH_CHALLENGE | source address (derived) |
| 6 | GET `/api/admin/registration/stats` | 4382 | `a.legacyAdminRegistrationStats` | ADMIN_READ | token?; no body |
| 7 | POST `/api/register` | 4387 | `a.register` | AUTH_REGISTER | username,password,confirmPassword,proof |
| 8 | POST `/api/login` | 4422 | `a.login` | AUTH_LOGIN | username,password |
| 9 | POST `/api/logout` | 4446 | `a.logout` | AUTH_LOGOUT | token |
| 10 | GET `/api/me` | 4476 | `a.legacyMe` | AUTH_ME | token |
| 11 | POST `/api/profile` | 4487 | `a.legacyProfileSave` | AUTH_ME | name |
| 12 | GET `/events` | 4501 | `a.legacyEvents` | SSE | Last-Event-ID header |
| 13 | GET `/api/sea` | 4626 | `a.legacySea` | SEA_READ | token |
| 14 | POST `/api/sea/ship/up` | 4632 | `a.legacySeaAction("ship")` | SEA_WRITE | JSON body (strict; token may be query/header) |
| 15 | POST `/api/sea/chart` | 4657 | `a.legacySeaAction("chart")` | SEA_WRITE | JSON body (strict; token may be query/header) |
| 16 | POST `/api/sea/voyage` | 4674 | `a.legacySeaAction("voyage")` | SEA_WRITE | JSON body (strict; token may be query/header) |
| 17 | POST `/api/sea/quest/claim` | 4698 | `a.legacySeaAction("quest")` | SEA_WRITE | JSON body (strict; token may be query/header) |
| 18 | POST `/api/sea/anchor` | 4734 | `a.legacySeaAction("anchor")` | SEA_WRITE | JSON body (strict; token may be query/header) |
| 19 | GET `/api/party` | 4770 | `a.legacyParty` | USER_READ | token; GET or action,target |
| 20 | POST `/api/party` | 4780 | `a.legacyPartyChange` | SOCIAL_WRITE | token; GET or action,target |
| 21 | POST `/api/fishing/start` | 4891 | `a.legacyFishingStart` | FISHING | groundId,spotId |
| 22 | POST `/api/rod/slot/buy` | 4905 | `a.legacyRodSlotBuy` | ROD | none |
| 23 | POST `/api/rod/save` | 4922 | `a.legacyRodSave` | ROD | slot,name,force |
| 24 | POST `/api/rod/name` | 4958 | `a.legacyRodName` | ROD | name |
| 25 | POST `/api/rod/rename` | 4971 | `a.legacyRodRename` | ROD | slot,name |
| 26 | POST `/api/rod/use` | 4986 | `a.legacyRodUse` | ROD | slot |
| 27 | POST `/api/rod/stow` | 5021 | `a.legacyRodStow` | ROD | none |
| 28 | POST `/api/rod/delete` | 5050 | `a.legacyRodDelete` | ROD | slot |
| 29 | POST `/api/fishing/stop` | 5079 | `a.legacyFishingStop` | FISHING | none |
| 30 | POST `/api/bd/set` | 5091 | `a.legacyBdSet` | ROD | part,compId |
| 31 | GET `/shop` | 5346 | `a.legacyShop` | PUBLIC_READ | none |
| 32 | GET `/api/market` | 5351 | `a.legacyMarket` | PUBLIC_MARKET | scope,page,size,kind,part,q,sort,affix,min,max |
| 33 | GET `/api/shop/history` | 5356 | `a.legacyShopHistory` | PUBLIC_READ | id |
| 34 | GET `/api/chest` | 5401 | `a.legacyChest` | WORKSHOP_READ | token |
| 35 | POST `/api/chest/craft` | 5412 | `a.legacyChestCraft` | WORKSHOP_WRITE | chestId,qty |
| 36 | POST `/api/chest/open` | 5441 | `a.legacyChestOpen` | WORKSHOP_WRITE | chestId,part,baseId |
| 37 | GET `/api/mall` | 5498 | `a.legacyMall` | USER_READ | token |
| 38 | POST `/api/mall/buy` | 5504 | `a.legacyMallBuy` | ECONOMY | id,qty |
| 39 | GET `/api/workshop` | 5536 | `a.legacyWorkshop` | WORKSHOP_READ | token |
| 40 | POST `/api/workshop/smelt` | 5576 | `a.legacyWorkshopSmelt` | WORKSHOP_WRITE | mainId,subId,mainAffix,subAffix,materials,pearl,relics |
| 41 | POST `/api/workshop/forge` | 5612 | `a.legacyWorkshopForge` | WORKSHOP_WRITE | id,materialId,pearl |
| 42 | POST `/api/workshop/recast` | 5638 | `a.legacyWorkshopRecast` | WORKSHOP_WRITE | id,affixIndex? |
| 43 | POST `/api/sell` | 5669 | `a.legacySell` | ECONOMY | id,qty,tier |
| 44 | GET `/api/autosell` | 5716 | `a.legacyAutoSell` | USER_READ | token; GET or tier,id,scope,bulk,on,remove,minPct,minPrice,slackPct,slackPrice,keep |
| 45 | POST `/api/autosell` | 5722 | `a.legacyAutoSellSet` | ECONOMY | token; GET or tier,id,scope,bulk,on,remove,minPct,minPrice,slackPct,slackPrice,keep |
| 46 | POST `/api/market/list` | 5807 | `a.legacyMarketList` | MARKET_WRITE | id|rodSlot,qty,price,hours |
| 47 | POST `/api/market/buy` | 5865 | `a.legacyMarketBuy` | MARKET_WRITE | lid,qty? |
| 48 | GET `/api/market/history` | 5930 | `a.legacyMarketHistory` | USER_READ | token |
| 49 | POST `/api/market/cancel` | 5937 | `a.legacyMarketCancel` | MARKET_WRITE | lid |
| 50 | POST `/api/trade/invite` | 5962 | `a.legacyTradeInvite` | TRADE | target |
| 51 | POST `/api/trade/respond` | 5988 | `a.legacyTradeRespond` | TRADE | tradeId,accept |
| 52 | POST `/api/trade/set` | 6010 | `a.legacyTradeSet` | TRADE | tradeId,items |
| 53 | POST `/api/trade/confirm` | 6040 | `a.legacyTradeConfirm` | TRADE | tradeId |
| 54 | POST `/api/trade/cancel` | 6082 | `a.legacyTradeCancel` | TRADE | tradeId |
| 55 | GET `/api/version` | 6099 | `a.legacyVersion` | PUBLIC_READ | none |
| 56 | GET `/api/wiki/simulator/inventory` | 6115 | `a.legacyWikiSimulatorInventory` | WIKI_READ | token |
| 57 | GET `/api/wiki/content` | 6131 | `a.legacyWikiContent` | WIKI_READ | If-None-Match? |
| 58 | GET `/api/admin/wiki/content` | 6141 | `a.legacyAdminWikiContent` | ADMIN_WIKI | token?; If-None-Match? |
| 59 | POST `/api/admin/wiki/content` | 6152 | `a.legacyAdminWikiContentSave` | ADMIN_WIKI | token,target,content|reset,baseRevision |
| 60 | POST `/api/wiki/guides/submit` | 6173 | `a.legacyWikiGuideSubmit` | WIKI_WRITE | guide JSON (<=80KiB) |
| 61 | GET `/api/wiki/guides/session` | 6199 | `a.legacyWikiGuideSession` | WIKI_READ | optional token |
| 62 | GET `/api/wiki/guides/my` | 6203 | `a.legacyWikiGuideMine` | WIKI_READ | token |
| 63 | POST `/api/wiki/guides/delete` | 6209 | `a.legacyWikiGuideDelete` | WIKI_WRITE | id |
| 64 | GET `/api/admin/wiki/guides` | 6221 | `a.legacyAdminWikiGuides` | ADMIN_WIKI | token?,status=pending|approved|rejected|all |
| 65 | POST `/api/admin/wiki/guides/review` | 6234 | `a.legacyAdminWikiGuideReview` | ADMIN_WIKI | token,target,action=approve|reject,expectedStatus,note |
| 66 | POST `/api/admin/wiki/guides/delete` | 6254 | `a.legacyAdminWikiGuideDelete` | ADMIN_WIKI | token,target,reason |
| 67 | GET `/api/wiki/guides` | 6271 | `a.legacyWikiGuides` | WIKI_READ | page,pageSize,q,kind,category |
| 68 | GET `/api/wiki/guides/{id}` | 6280 | `a.legacyWikiGuideDetail` | WIKI_READ | id |
| 69 | GET `/api/grounds` | 6291 | `a.legacyGrounds` | PUBLIC_READ | none |
| 70 | GET `/api/subscribe` | 6296 | `a.legacySubscribeGet` | NOTIFY_READ | token; GET or on,baseId,quality,affixType,min,max,badge,blink |
| 71 | POST `/api/subscribe` | 6305 | `a.legacySubscribeSet` | NOTIFY_WRITE | token; GET or on,baseId,quality,affixType,min,max,badge,blink |
| 72 | GET `/api/feedback` | 6341 | `a.legacyFeedbackGet` | NOTIFY_READ | token |
| 73 | POST `/api/feedback/submit` | 6349 | `a.legacyFeedbackSubmit` | NOTIFY_WRITE | text,kind |
| 74 | POST `/api/feedback/skip` | 6374 | `a.legacyFeedbackSkip` | NOTIFY_WRITE | none |
| 75 | GET `/api/codex` | 6393 | `a.legacyCodex` | USER_READ | token |
| 76 | GET `/api/records` | 6399 | `a.legacyRecords` | PUBLIC_READ | none |
| 77 | GET `/api/records/top` | 6408 | `a.legacyRecordsTop` | PUBLIC_READ | id,kind,range |
| 78 | POST `/api/admin/login` | 6514 | `a.login` | AUTH_LOGIN | username,password,otp |
| 79 | GET `/api/admin/session` | 6538 | `a.adminSession` | AUTH_ME | admin token |
| 80 | GET `/api/admin/netstats` | 6544 | `a.legacyAdminNetstats` | ADMIN_READ | token?; no body |
| 81 | GET `/api/admin/parties` | 6550 | `a.legacyAdminParties` | ADMIN_READ | token?; no body |
| 82 | POST `/api/admin/party/disband` | 6556 | `a.legacyAdminPartyDisband` | ADMIN_PARTY | token,id |
| 83 | GET `/api/friends/relations` | 6579 | `a.legacyFriendRelations` | SOCIAL_READ | none |
| 84 | GET `/api/friends` | 6590 | `a.legacyFriendsView` | SOCIAL_READ | q,page or target,action |
| 85 | POST `/api/friends` | 6617 | `a.legacyFriendChange` | SOCIAL_READ | q,page or target,action |
| 86 | GET `/api/players/page` | 6694 | `a.legacyPlayersPage` | SOCIAL_READ | token,page,size,q,ground,spot |
| 87 | POST `/api/players/view` | 6706 | `a.legacyPlayersView` | SOCIAL_VIEW | page,size,q,ground,spot,clear |
| 88 | POST `/api/players/rod` | 6726 | `a.legacyPlayersRod` | SOCIAL_READ | target |
| 89 | GET `/api/admin/overview` | 6741 | `a.legacyAdminOverview` | ADMIN_READ | token?; no body |
| 90 | GET `/api/admin/stats` | 6762 | `a.legacyAdminStats` | ADMIN_READ | query: token? plus route filters (see handler) |
| 91 | GET `/api/banner` | 6772 | `a.legacyBanner` | PUBLIC_READ | none |
| 92 | GET `/api/admin/banner` | 6779 | `a.legacyAdminBanner` | ADMIN_READ | token?; no body |
| 93 | POST `/api/admin/banner/add` | 6792 | `a.legacyBannerChange("add")` | ADMIN_BANNER | token,content,duration,color |
| 94 | POST `/api/admin/banner/remove` | 6816 | `a.legacyBannerChange("remove")` | ADMIN_BANNER | token,id |
| 95 | POST `/api/admin/banner/move` | 6831 | `a.legacyBannerChange("move")` | ADMIN_BANNER | token,id,dir=up|down |
| 96 | POST `/api/admin/banner/cfg` | 6851 | `a.legacyBannerChange("cfg")` | ADMIN_BANNER | token,blink,blinkTitle,noticeColor,catchLevel |
| 97 | POST `/api/admin/banner/update` | 6876 | `a.legacyBannerChange("update")` | ADMIN_BANNER | token,id,color |
| 98 | POST `/api/banner/playing` | 6905 | `a.legacyBannerPlaying` | BANNER_PLAY | id |
| 99 | POST `/api/admin/banner/stop` | 6920 | `a.legacyBannerChange("stop")` | ADMIN_BANNER | token,id |
| 100 | POST `/api/admin/banner/clear` | 6934 | `a.legacyBannerChange("clear")` | ADMIN_BANNER | token |
| 101 | GET `/api/admin/feedback` | 6951 | `a.legacyAdminFeedback` | ADMIN_READ | token?; no body |
| 102 | POST `/api/admin/feedback/cfg` | 6966 | `a.legacyAdminFeedbackConfig` | ADMIN_FEEDBACK | token,cdHours,skipCost |
| 103 | POST `/api/admin/feedback/status` | 6991 | `a.legacyAdminFeedbackStatus` | ADMIN_FEEDBACK | token,id,status |
| 104 | POST `/api/admin/feedback/del` | 7010 | `a.legacyAdminFeedbackDelete` | ADMIN_FEEDBACK | token,id |
| 105 | POST `/api/admin/feedback/reward` | 7032 | `a.legacyAdminFeedbackReward` | ADMIN_FEEDBACK | token,id,coins,note |
| 106 | GET `/api/admin/users` | 7061 | `a.legacyAdminUsers` | ADMIN_READ | token?; no body |
| 107 | POST `/api/admin/users/setadmin` | 7090 | `a.legacyAdminUserSetAdmin` | ADMIN_USERS | token,target,admin |
| 108 | POST `/api/admin/users/ban` | 7117 | `a.legacyAdminUserBan` | ADMIN_USERS | token,target,hours,reason,confirm |
| 109 | GET `/api/admin/security` | 7155 | `a.legacyAdminSecurity` | ADMIN_READ | token?; no body |
| 110 | POST `/api/admin/users/delete` | 7169 | `a.legacyAdminUserDelete` | ADMIN_USERS | token,target,confirm |
| 111 | GET `/api/admin/users/snapshot` | 7193 | `a.legacyAdminUserSnapshot` | ADMIN_SNAPSHOT | token,key |
| 112 | POST `/api/admin/users/snapshot` | 7209 | `a.legacyAdminUserSnapshotSave` | ADMIN_SNAPSHOT | token,target,expectedInvRev,coins,inventory,inventoryTiers,bd |
| 113 | GET `/api/admin/users/snapshots` | 7273 | `a.legacyAdminUserSnapshots` | ADMIN_SNAPSHOT | token,key |
| 114 | POST `/api/admin/users/snapshot-now` | 7289 | `a.legacyAdminUserSnapshotNow` | ADMIN_SNAPSHOT | token,target |
| 115 | POST `/api/admin/users/rollback` | 7307 | `a.legacyAdminUserRollback` | ADMIN_SNAPSHOT | token,target,snap,confirm |
| 116 | POST `/api/admin/snapshot/config` | 7335 | `a.legacyAdminSnapshotConfig` | ADMIN_SNAPSHOT | token,cfg:{enabled,intervalMin,keep} |
| 117 | POST `/api/admin/users/update` | 7350 | `a.legacyAdminUserUpdate` | ADMIN_USERS | token,target,name,password,coins,listingCap |
| 118 | GET `/api/admin/world` | 7401 | `a.legacyAdminWorld` | ADMIN_READ | token?; no body |
| 119 | POST `/api/admin/component/config` | 7518 | `a.adminComponentConfig` | ADMIN_CONFIG | token,qualityWeights,countWeights,rollModel,affixRanges,extraAffixRanges,adjectiveRules |
| 120 | POST `/api/admin/component/reset` | 7614 | `a.adminComponentReset` | ADMIN_WORLD | token |
| 121 | POST `/api/admin/component/simulate` | 7627 | `a.adminComponentSimulate` | ADMIN_WORLD | token,n |
| 122 | POST `/api/admin/fish/config` | 7665 | `a.adminFishConfig` | ADMIN_CONFIG | token,sizeModel,sizeWeights |
| 123 | POST `/api/admin/fish/reset` | 7681 | `a.adminFishReset` | ADMIN_WORLD | token |
| 124 | POST `/api/admin/fish/simulate` | 7695 | `a.adminFishSimulate` | ADMIN_WORLD | token,spotKey,model,n |
| 125 | POST `/api/admin/spot/pool` | 7743 | `a.adminSpotPool` | ADMIN_WORLD | token,groundId,spotId,pool[{pick,weight}] |
| 126 | GET `/api/admin/loot/groups` | 7760 | `a.adminLootGroups` | ADMIN_READ | token?; no body |
| 127 | POST `/api/admin/loot/group` | 7765 | `a.adminLootGroup` | ADMIN_WORLD | token,group definition/entries |
| 128 | POST `/api/admin/spot/buffs` | 7806 | `a.adminSpotBuffs` | ADMIN_WORLD | token,groundId,spotId,buffs[{type,value}] |
| 129 | POST `/api/admin/pool/preset` | 7824 | `a.adminPoolPreset` | ADMIN_WORLD | token,preset |
| 130 | POST `/api/admin/ground/add` | 7836 | `a.adminGroundAdd` | ADMIN_WORLD | token,ground definition |
| 131 | POST `/api/admin/spot/add` | 7872 | `a.adminSpotAdd` | ADMIN_WORLD | token,groundId,spot definition |
| 132 | POST `/api/admin/ground/remove` | 7908 | `a.adminGroundRemove` | ADMIN_WORLD | token,groundId,spotId?,locked? |
| 133 | POST `/api/admin/spot/remove` | 7933 | `a.adminSpotRemove` | ADMIN_WORLD | token,groundId,spotId,locked? |
| 134 | POST `/api/admin/ground/restore` | 7969 | `a.adminGroundRestore` | ADMIN_WORLD | token,groundId,spotId?,locked? |
| 135 | POST `/api/admin/ground/update` | 7999 | `a.adminGroundUpdate` | ADMIN_WORLD | token,groundId,name,fields |
| 136 | POST `/api/admin/spot/rate` | 8041 | `a.adminSpotRate` | ADMIN_WORLD | token,groundId,spotId,rate |
| 137 | POST `/api/admin/spot/pos` | 8075 | `a.adminSpotPos` | ADMIN_WORLD | token,groundId,spotId?,list |
| 138 | POST `/api/admin/ground/lock` | 8098 | `a.adminGroundLock` | ADMIN_WORLD | token,groundId,spotId?,locked? |
| 139 | POST `/api/admin/spot/lock` | 8124 | `a.adminSpotLock` | ADMIN_WORLD | token,groundId,spotId,locked? |
| 140 | POST `/api/admin/market/return` | 8150 | `a.legacyAdminMarketReturn` | ADMIN_MARKET | token,lid |
| 141 | GET `/api/admin/market/supply` | 8180 | `a.legacyAdminMarketSupplyGet` | ADMIN_MARKET | token?; no body |
| 142 | POST `/api/admin/market/supply` | 8184 | `a.legacyAdminMarketSupplyPost` | ADMIN_MARKET | JSON body (strict; token may be query/header) |
| 143 | POST `/api/admin/market/bulk` | 8210 | `a.legacyAdminMarketBulk` | ADMIN_MARKET | token,mode,sellers,items,qty,price,hours |
| 144 | POST `/api/admin/mall/config` | 8242 | `a.legacyAdminMallConfig` | ADMIN_CONFIG | token,refreshTime,items,reset |
| 145 | GET `/api/admin/loot/spots` | 8269 | `a.adminLootSpots` | ADMIN_READ | token?; no body |
| 146 | POST `/api/admin/simulate` | 8284 | `a.adminSimulate` | ADMIN_WORLD | token,totals,spotKey |
| 147 | POST `/api/admin/loot/test` | 8326 | `a.adminLootTest` | ADMIN_WORLD | token,spotKey,rare |
| 148 | POST `/api/admin/smelt/config` | 8380 | `a.legacyAdminSmeltConfig` | ADMIN_CONFIG | token,partial smelt config or reset |
| 149 | POST `/api/admin/records/config` | 8478 | `a.legacyAdminRecordsConfig` | ADMIN_RECORDS | token,scale,x,y,reset |
| 150 | POST `/api/admin/records/delete` | 8511 | `a.legacyAdminRecordsDelete` | ADMIN_RECORDS | token,id? |
| 151 | POST `/api/admin/records/delone` | 8532 | `a.legacyAdminRecordDeleteOne` | ADMIN_RECORDS | token,id,range,kind,expected |
| 152 | POST `/api/admin/settings` | 8567 | `a.legacyAdminSettings` | ADMIN_CONFIG | token,partial settings (seaCfg/chestCfg/castBaseMs/priceCfg/dropCfg/autoSellCfg/doubleBase/biteFormula/notifyLevel/autoNotify/rareK...),validateOnly,evalVars |

## 验收规则

- 每个表行至少执行：未认证、错误 JSON/未知字段、边界/越界输入、成功、重复/并发业务冲突；写操作同时读回 PostgreSQL 权威表和 SSE 结果。
- Node 与 Go 使用同一前端、固定玩法/目录和语义等价夹具。随机/时间场景使用固定时间、可注入 seed/序列或只比较不变量；不得比较两次失控随机值。
- 记录 HTTP status、JSON `error`/`code`、响应字段集合、资产 `invRev`/market revision、数据库行/余额/库存/审计和事件顺序。`skip`、超时、中断或缺真库不计通过。
- 公共安全层还要断言 POST 非 JSON=415、跨源=403、cookie 模式 CSRF=403、未知路由=404；这些是所有 POST 路由的共同前置契约。

## 当前已知实现差异（供兼容窗口）

- `POST /api/players/view` 在 Go 仅登记 viewport 并返回当前 stream 数，尚未像 Node 一样对每条 SSE 连接推送 `playersPage`；浏览器 A/B 必须把“登记响应”和“后续推送”分开记差异。
- `GET /api/shop/history` 的 Go 投影明确返回空 `points`/`trades`（价格和销量来自持久模块），不能把空数组误判为 Node 历史数据等价。
- `POST /api/feedback/submit` 的 Go 注释说明尚未桥接管理员实时通知；反馈落库可比，但 SSE `feedback`/管理员即时提示需单独标记。
- legacy `GET /events` 的 Go 首帧仍是 `init`；`snapshot_required`/`assets_changed` 属于另一个 `/api/v1/events` 消费者，不能拿 v1 类型替代旧前端的 `init`/`batch`/`assets`/个人事件验收。
- `POST /api/market/*`、`/api/trade/*`、工坊和宝匣的随机/时间结果只比对受控夹具中的业务不变量、资产事务和事件顺序；不要求两次自然随机相同。

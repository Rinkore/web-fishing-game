#!/usr/bin/env node
/*
 * Rebuild the legacy HTTP contract matrix from the frozen inventory.  The
 * inventory is deliberately the denominator; route registration alone is not
 * treated as a behavioural pass.  Contract classes below are the reviewable
 * assertions used by the HTTP/browser A/B harness.
 */
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..', '..');
const inventory = JSON.parse(fs.readFileSync(path.join(root, 'server-go/api/legacy-inventory.json'), 'utf8'));
const httpGo = fs.readFileSync(path.join(root, 'server-go/internal/gateway/http.go'), 'utf8');

const classes = {
  AUTH_CHALLENGE: ['公开，无会话', '无 body；按来源地址限流', '200 challenge（含 proof 参数）', '429 rate_limited；503 unavailable', '注册挑战计数/挑战存储；不创建账号'],
  AUTH_REGISTER: ['公开；注册防滥用策略', '{username,password,confirmPassword?,proof?}；严格 JSON、字段/密码校验', '200 {ok,token,profile,username,name,admin}，可按 X-Session-Mode 写 cookie', '400 invalid_input；403 REGISTRATION_CHALLENGE；409 username_exists；429 rate_limited；503 unavailable', '原子创建 identity、wallet、player_state、会话；审计/注册计数；失败不得半创建'],
  AUTH_LOGIN: ['公开；/api/admin/login 还要求 admin 登录语义和 OTP', '{username,password,otp?}；严格 JSON；登录端点按来源限流', '200 登录投影（token 或 cookie、profile）', '400 invalid_input；401 invalid_credentials；403 account_banned/MFA_SETUP_REQUIRED；429 rate_limited；503 unavailable', '创建/轮换会话；管理员会话含 MFA 状态；失败无持久副作用'],
  AUTH_LOGOUT: ['玩家 token；admin 路径需管理员 token/MFA', '空 JSON（token 由 Authorization/Bearer 或 cookie）', '200 {ok:true}，清理对应 cookie', '401 invalid_credentials；403 admin_required/MFA_SETUP_REQUIRED；503 unavailable', '撤销会话；重复登出必须无害'],
  AUTH_ME: ['玩家 token；/api/admin/session 需管理员 session + MFA', 'GET 无 body；POST /profile 仅 {name}', 'GET /me profile/资产投影；GET admin/session {ok,username,name}；POST {ok:true}', '401 invalid_credentials；403 admin_required/MFA_SETUP_REQUIRED；400 invalid_input/invalid_name；503 unavailable', 'GET 只读但会读取权威资产；POST 只修改 display_name，长度按 UTF-16 截断'],
  PUBLIC_READ: ['公开', '查询参数按路由定义；未知/越界参数返回业务 4xx', '200 JSON 目录/配置/排行榜/价格', '400 invalid_input；404 unknown_item/unknown_fish；503 unavailable', '只读；不得改变金币、库存、纪录或版本'],
  PUBLIC_MARKET: ['公开；有会话时用 token 标示 mine', 'scope/kind/part/q/affix/min/max/page/size 等过滤；分页边界校验', '200 {listings,page,pages,total,counts,parts,revision,...}', '400 请求参数无效；503 unavailable', '只读市场挂单/修订；无资产变更'],
  USER_READ: ['玩家 token（部分 legacySession 允许 cookie；失效统一 401 未登录）', '只读查询；严格分页/目标 ID/枚举校验', '200 路由投影（profile/资产、海域、编队、社交、订单、工坊等）', '401 未登录/invalid_credentials；400 invalid_input；404 unknown target；503 unavailable', '只读；不得隐式出售、开箱、扣费或推进玩法'],
  USER_WRITE: ['玩家 token', '严格 JSON、DisallowUnknownFields；路由专用字段和枚举/数量/范围校验', '200 {ok:true,...} 或 legacy 业务结果，附权威资产 rev/余额/库存', '400 invalid_input/业务拒绝；401；403；404；409 状态冲突；429；503；commit_unknown', '同一 PostgreSQL 事务提交资产、流水、outbox/事件；重复请求按旧协议语义处理；失败回滚'],
  SSE: ['玩家 token；Authorization 或 fish_game cookie', 'legacy /events 使用 stream cookie/bearer；Last-Event-ID 仅属于独立 v1 stream；连接上限/写超时', 'text/event-stream；legacy 首帧 init，随后 data JSON 和 heartbeat；v1 才有 snapshot_required/assets_changed', '400 invalid_input；401；429 rate_limited；断线/读库失败关闭；kicked/maintenance 事件', '建立 gateway_stream lease；只读事件游标；关闭释放 lease；不直接改资产'],
  SEA_READ: ['玩家 token', '无 body（token query/header）', '200 海域/船/海图/任务/共享区域投影', '401；400 invalid_input；503 unavailable', '只读；状态以持久海域表为权威'],
  SEA_WRITE: ['玩家 token', '{zoneId|id|action 相关字段}；枚举、归属、开关和资源校验', '200 {ok:true,...} 或 sea 状态/资产快照', '400 invalid_input/业务拒绝；401；403；404；409；503', '事务更新船、海图、航次、任务、锚地或共享区域；奖励/费用与 outbox 原子提交'],
  FISHING: ['玩家 token', 'start {groundId,spotId}；stop 空 JSON；地图/钓点/状态枚举校验', '200 {ok:true,...}；后续 SSE catch/assets/records', '400 invalid_input/不在场/重复状态；401；409 状态冲突；503', '创建/结束持久 fishing session；调度收益由服务端决定；资产与纪录原子写入'],
  ROD: ['玩家 token', 'slot/name/force/part/compId；槽位、归属、锁定和部件合法性校验', '200 {ok:true,...} + rod/资产投影', '400 invalid_input；401；403 locked；404；409 occupied/conflict；503', '扩容扣费、装配/保存/切换/收起/删除均事务更新 rods、component lifecycle、assets_rev'],
  ECONOMY: ['玩家 token（GET autosell/mall 也需玩家）', 'sell {id,qty,tier L|G}；mall {id,qty}；autosell 规则/批量字段严格校验', '200 {ok:true,gain|sold,coins,inventory,invRev,shop,...}', '400 invalid_input/unknown_item/insufficient；401；403 feature off；409；503', '金币、库存、价格/自动售出设置、流水和 assets_rev 同事务；重复操作必须可核对'],
  MARKET_WRITE: ['玩家 token', 'list {id|rodSlot,qty,price,hours}；buy/cancel {lid,qty?}；数量/价格/时长/所有权校验', '200 状态消息 + 市场修订 + 权威资产快照', '400 参数/数量/物品无效；401；403；404；409 price/status conflict；429；503', '托管、部分成交、整竿、撤回/到期、金币/库存和交易流水事务提交；事件推送 marketDelta/mktTrade'],
  TRADE: ['玩家 token；双方分别授权自己的操作', 'invite {target}；respond {tradeId,accept}；set {tradeId,items}；confirm/cancel {tradeId}', '200 {ok:true,trade,...}；完成时双方资产快照', '400 invalid/未接受/物品不足；401；403 no ownership；404；409 version/status；429；503', '交易状态、报价版本、双方资产交换与 tradeDone 事件原子提交；重复确认不可重复结算；超时/取消返还托管'],
  SOCIAL_READ: ['玩家 token；legacySession 失效为 401 未登录', 'q/page/size/ground/spot 或 target；分页和目标格式校验', '200 friends/relations/players/rod 投影', '400 invalid_input；401 未登录；404 player_not_found；503', '只读；POST players/view 仅更新进程内 viewport lease，不改变业务资产'],
  SOCIAL_WRITE: ['玩家 token', '{target,action}；create/accept/decline/cancel/kick 等枚举、在线和关系校验', '200 {ok:true,...} + friends/party 投影', '400 invalid/自己/无邀请；401；403；404；409 relation/status；503', 'friend_relations/party_members/invites 持久化；事件 friends/trade/party 推送；幂等请求不重复关系'],
  SOCIAL_VIEW: ['玩家 token；legacySession 失效为 401 未登录', '{page,size,q,ground,spot,clear}；分页和过滤格式校验', '200 {ok:true,pushed}（pushed 为当前有效 SSE 数）', '400 invalid_input；401 未登录；503', '仅登记当前账号的进程内 viewport；不改资产；Go 尚未桥接 Node 的 playersPage 推送'],
  NOTIFY_READ: ['玩家 token', 'GET 无 body；token 解析', '200 subscription catalog/config 或 feedback status/mine/coins', '401；503', '只读'],
  NOTIFY_WRITE: ['玩家 token', 'subscribe {on,baseId,quality,affixType,min,max,badge,blink}; feedback {text,kind} 或空 skip', '200 cfg/entry/status/资产快照', '400 invalid/未知枚举/空文本/未在冷却/金币不足；401；429 cooldown；503', 'subscription_settings 或 feedback/cooldown、金币/流水同事务；反馈保留上限和冷却持久化'],
  WORKSHOP_READ: ['玩家 token', 'GET 无 body', '200 workshop/chest 配方、库存、pity、余额', '401；503', '只读；不得触发 autoSell 或随机'],
  WORKSHOP_WRITE: ['玩家 token', 'chest craft/open；smelt {mainId,subId,mainAffix,subAffix,materials,pearl,relics}；forge/recast {id,...}；数量、归属、词条、材料校验', '200 结果 item/affixes/pity + 权威 coins/inventory/invRev', '400 unknown/invalid recipe、材料/金币不足、词条上限/不可重铸；401；403 feature off；409；503', '组件/材料/金币、随机结果、pity、保留和流水原子提交；SSE assets；随机由可控 fixture/seed 注入验收'],
  WIKI_READ: ['公开（simulator inventory、my 需玩家 token；session 为可选探针）', 'guides page/pageSize/q/kind/category/id；ID/分页规范化', '200 content/guides/detail/session 或只读 inventory', '400 invalid；401（需要玩家的读）；404 guide not public；503', '只读；ETag/If-None-Match 304 不改变 revision'],
  WIKI_WRITE: ['玩家 token', 'submit 原始 JSON ≤80KiB，严格 schema；delete {id}', '200 {guideId,status,limits} 或 {ok,limits}', '400 schema/ID/状态；401；404；409；429 quota；503', 'SQLite/PostgreSQL Wiki guide、revision、审核日志持久化；配额/状态更新原子；官方自动审核由配置控制'],
  ADMIN_READ: ['管理员 session；admin cookie/Bearer 且 MFA 已完成', 'GET 查询参数按面板定义', '200 管理统计/配置/用户/世界/审核视图；Wiki content 支持 ETag 304', '401 invalid_credentials；403 admin_required/MFA_SETUP_REQUIRED；400；503', '只读；不得因查看触发游戏资产或配置写入'],
  ADMIN_CONFIG: ['管理员 session + MFA', 'settings/features/mall/smelt/records/component/fish 等配置字段；reset/validateOnly；revision/枚举/范围校验', '200 {ok:true,revision/config,...}；配置推送 SSE type 字面量', '400 invalid/unknown key/range；401/403；409 revision；503/commit_unknown', 'operator_settings/catalog revision/审计日志事务写入，并广播 features/*cfg；失败不得部分落盘'],
  ADMIN_WORLD: ['管理员 session + MFA', 'ground/spot/pool/loot/component/fish simulate/config 字段；ID、权重、锁定和范围校验', '200 当前 world/catalog 或模拟结果', '400 invalid/unknown/lock conflict；401/403；404；409；503', '世界/掉落池/目录版本及 operator audit 持久化；变更推送 groundcfg/componentcfg 等'],
  ADMIN_USERS: ['管理员 session + MFA；自删/自撤权/最后管理员保护', 'target、name/password/coins/listingCap/admin/ban hours/reason/confirm 等字段', '200 用户列表/单用户/资产快照结果', '400 invalid/confirm/last-admin；401/403；404 account；409 active trade/party；503', '身份、权限、封禁、钱包、会话和审计原子更新；删除/回档踢出会话并保留审计'],
  ADMIN_SNAPSHOT: ['管理员 session + MFA', 'target/key、coins/inventory/bd、snap、confirm；配置 interval/retention 等', '200 snapshot(s)/rollback/config', '400 malformed/confirm/config；401/403；404 account/snapshot；409；503', '快照文件/表、资产回档和 operator audit；回档事务覆盖资产、装备、钓竿并使旧会话失效'],
  ADMIN_MARKET: ['管理员 session + MFA', 'lid/action/supply/bulk seller keys/rates/limits；批次 1..500 等约束', '200 市集供给/批处理结果和 revision', '400 参数/卖家/模式；401/403；404；409 duplicate request/status；503', '系统供给挂单、归还托管、批量生成/暂停和审计；资产/市场流水原子提交'],
  ADMIN_BANNER: ['管理员 session + MFA（playing 为玩家 token）', 'banner add/remove/move/update/cfg/stop/clear：id/content/duration/color/dir/config', '200 banners/cfg/queued result；playing 200 统计确认', '400 color/content/range/dir；401/403；404；409 banner_revision_changed/full/endpoint；503', 'banner 队列/config/revision/审计持久化；广播 banner/bannerStop；playing 只更新观看统计'],
  ADMIN_FEEDBACK: ['管理员 session + MFA', 'feedback status/del/reward/cfg：id/status/coins/note/cdHours/skipCost', '200 feedback list/update/config', '400 status/coins/config；401/403；404 feedback/account；409；503', '反馈状态、奖励金币、配置及审计事务；奖励只能一次且可对账'],
  ADMIN_WIKI: ['管理员 session + MFA', 'content {baseRevision,content|reset,target}；review {id,action,expectedStatus,note}；delete {id,reason}', '200 content/revision/guides 或 reviewed/deleted guide', '400 schema/action/note；401/403；404 guide；409 revision/status；503', '官方内容/用户稿件状态、revision、更新日志、审计原子写入；ETag/SSE 修订可验证'],
  ADMIN_RECORDS: ['管理员 session + MFA', 'delete {id?}；delone {id,range,kind,expected...}；config scale/x/y/reset', '200 records/config/deletion counts', '400 fish/config；401/403；404；409 rank/record changed；503', '纪录隐藏/删除及 records config、审计持久化；广播 recordsDirty/recordscfg'],
  ADMIN_PARTY: ['管理员 session + MFA', 'disband {id}', '200 {ok:true,...}', '400 invalid id；401/403；404 party；409 active/conflict；503', '解散 party、清理成员/邀请并推送 party/trade 事件；审计'],
  BANNER_PLAY: ['玩家 token', '{id}；JSON 严格解码；未知横幅为幂等 ignored', '200 {ok:true} 或 {ok:true,ignored:true}', '400 invalid_input；401；503/commit_unknown', 'banner_watchers upsert（观看统计）事务提交；不改玩家资产'],
};

function classFor(method, p) {
  if (p === '/events') return 'SSE';
  if (p === '/api/register/challenge') return 'AUTH_CHALLENGE';
  if (p === '/api/register') return 'AUTH_REGISTER';
  if (p === '/api/login' || p === '/api/admin/login') return 'AUTH_LOGIN';
  if (p === '/api/logout' || p === '/api/admin/logout') return 'AUTH_LOGOUT';
  if (p === '/api/me' || p === '/api/profile' || p === '/api/admin/session') return 'AUTH_ME';
  if (p.startsWith('/api/admin/')) {
    if (p === '/api/admin/wiki/content' || p.startsWith('/api/admin/wiki/guides')) return 'ADMIN_WIKI';
    if (p === '/api/admin/banner') return 'ADMIN_READ';
    if (p.startsWith('/api/admin/banner/')) return 'ADMIN_BANNER';
    if (p.startsWith('/api/admin/feedback')) return p === '/api/admin/feedback' ? 'ADMIN_READ' : 'ADMIN_FEEDBACK';
    if (p.startsWith('/api/admin/users/snapshot') || p === '/api/admin/snapshot/config' || p === '/api/admin/users/rollback') return 'ADMIN_SNAPSHOT';
    if (p.startsWith('/api/admin/users/')) return 'ADMIN_USERS';
    if (p.startsWith('/api/admin/market/')) return 'ADMIN_MARKET';
    if (p.startsWith('/api/admin/party/')) return 'ADMIN_PARTY';
    if (p.startsWith('/api/admin/records/')) return 'ADMIN_RECORDS';
    if (p === '/api/admin/settings' || p === '/api/admin/features' || p === '/api/admin/mall/config' || p === '/api/admin/smelt/config' || p === '/api/admin/records/config' || p === '/api/admin/component/config' || p === '/api/admin/fish/config') return method === 'GET' ? 'ADMIN_READ' : 'ADMIN_CONFIG';
    if (p === '/api/admin/world' || p.startsWith('/api/admin/ground/') || p.startsWith('/api/admin/spot/') || p.startsWith('/api/admin/loot/') || p.startsWith('/api/admin/pool/') || p.startsWith('/api/admin/component/') || p.startsWith('/api/admin/fish/') || p === '/api/admin/simulate') return method === 'GET' ? 'ADMIN_READ' : 'ADMIN_WORLD';
    return 'ADMIN_READ';
  }
  if (p === '/api/wiki/content' || p === '/api/wiki/guides' || p === '/api/wiki/guides/{id}' || p === '/api/wiki/guides/session' || p === '/api/wiki/simulator/inventory' || p === '/api/wiki/guides/my' || p === '/api/wiki/guides/submit' || p === '/api/wiki/guides/delete') {
    if (p === '/api/wiki/guides/submit' || p === '/api/wiki/guides/delete') return 'WIKI_WRITE';
    return 'WIKI_READ';
  }
  if (p === '/shop' || p === '/api/features' || p === '/api/version' || p === '/api/grounds' || p === '/api/banner' || p === '/api/records' || p === '/api/records/top' || p === '/api/shop/history') return 'PUBLIC_READ';
  if (p === '/api/market') return 'PUBLIC_MARKET';
  if (p === '/api/sea') return 'SEA_READ';
  if (p.startsWith('/api/sea/')) return 'SEA_WRITE';
  if (p === '/api/party') return method === 'GET' ? 'USER_READ' : 'SOCIAL_WRITE';
  if (p.startsWith('/api/fishing/')) return 'FISHING';
  if (p.startsWith('/api/rod/') || p === '/api/bd/set') return 'ROD';
  if (p === '/api/chest' || p === '/api/workshop') return 'WORKSHOP_READ';
  if (p.startsWith('/api/chest/') || p.startsWith('/api/workshop/')) return 'WORKSHOP_WRITE';
  if (p === '/api/mall' || p === '/api/sell' || p === '/api/autosell' || p.startsWith('/api/mall/')) return method === 'GET' ? (p === '/api/mall' || p === '/api/autosell' ? 'USER_READ' : 'PUBLIC_READ') : 'ECONOMY';
  if (p.startsWith('/api/market/')) return method === 'GET' ? 'USER_READ' : 'MARKET_WRITE';
  if (p.startsWith('/api/trade/')) return 'TRADE';
  if (p === '/api/friends' || p === '/api/friends/relations' || p === '/api/players/page' || p === '/api/players/rod') return 'SOCIAL_READ';
  if (p === '/api/players/view') return 'SOCIAL_VIEW';
  if (p === '/api/subscribe' || p === '/api/feedback') return method === 'GET' ? 'NOTIFY_READ' : 'NOTIFY_WRITE';
  if (p.startsWith('/api/feedback/')) return 'NOTIFY_WRITE';
  if (p === '/api/banner/playing') return 'BANNER_PLAY';
  if (p === '/api/codex') return 'USER_READ';
  return method === 'GET' ? 'USER_READ' : 'USER_WRITE';
}

const input = {
  '/api/register/challenge': 'source address (derived)', '/api/register': 'username,password,confirmPassword,proof', '/api/login': 'username,password', '/api/admin/login': 'username,password,otp', '/api/logout': 'token', '/api/admin/logout': 'admin token', '/api/me': 'token', '/api/profile': 'name', '/api/admin/session': 'admin token',
  '/events': 'Last-Event-ID header', '/api/version': 'none', '/api/features': 'none', '/api/grounds': 'none', '/shop': 'none', '/api/banner': 'none', '/api/records': 'none', '/api/records/top': 'id,kind,range', '/api/shop/history': 'id', '/api/market': 'scope,page,size,kind,part,q,sort,affix,min,max', '/api/codex': 'token', '/api/sea': 'token', '/api/party': 'token; GET or action,target', '/api/fishing/start': 'groundId,spotId', '/api/fishing/stop': 'none', '/api/bd/set': 'part,compId', '/api/rod/slot/buy': 'none', '/api/rod/save': 'slot,name,force', '/api/rod/name': 'name', '/api/rod/rename': 'slot,name', '/api/rod/use': 'slot', '/api/rod/stow': 'none', '/api/rod/delete': 'slot', '/api/chest': 'token', '/api/chest/craft': 'chestId,qty', '/api/chest/open': 'chestId,part,baseId', '/api/mall': 'token', '/api/mall/buy': 'id,qty', '/api/workshop': 'token', '/api/workshop/smelt': 'mainId,subId,mainAffix,subAffix,materials,pearl,relics', '/api/workshop/forge': 'id,materialId,pearl', '/api/workshop/recast': 'id,affixIndex?', '/api/sell': 'id,qty,tier', '/api/autosell': 'token; GET or tier,id,scope,bulk,on,remove,minPct,minPrice,slackPct,slackPrice,keep', '/api/market/list': 'id|rodSlot,qty,price,hours', '/api/market/buy': 'lid,qty?', '/api/market/history': 'token', '/api/market/cancel': 'lid', '/api/trade/invite': 'target', '/api/trade/respond': 'tradeId,accept', '/api/trade/set': 'tradeId,items', '/api/trade/confirm': 'tradeId', '/api/trade/cancel': 'tradeId', '/api/subscribe': 'token; GET or on,baseId,quality,affixType,min,max,badge,blink', '/api/feedback': 'token', '/api/feedback/submit': 'text,kind', '/api/feedback/skip': 'none', '/api/friends': 'q,page or target,action', '/api/friends/relations': 'none', '/api/players/page': 'token,page,size,q,ground,spot', '/api/players/view': 'page,size,q,ground,spot,clear', '/api/players/rod': 'target', '/api/banner/playing': 'id', '/api/wiki/content': 'If-None-Match?', '/api/wiki/guides': 'page,pageSize,q,kind,category', '/api/wiki/guides/{id}': 'id', '/api/wiki/guides/session': 'optional token', '/api/wiki/simulator/inventory': 'token', '/api/wiki/guides/submit': 'guide JSON (<=80KiB)', '/api/wiki/guides/my': 'token', '/api/wiki/guides/delete': 'id',
};

function inputFor(method, route) {
  if (input[route]) return input[route];
  const q = method === 'GET' ? 'query: token? plus route filters (see handler)' : 'JSON body (strict; token may be query/header)';
  if (route === '/api/admin/features') return method === 'GET' ? 'token?' : 'token,features,featureOrder,baseRevision?';
  if (route === '/api/admin/registration/stats' || route === '/api/admin/netstats' || route === '/api/admin/parties' || route === '/api/admin/overview' || route === '/api/admin/security' || route === '/api/admin/world' || route === '/api/admin/feedback' || route === '/api/admin/banner' || route === '/api/admin/users' || route === '/api/admin/loot/groups' || route === '/api/admin/loot/spots' || route === '/api/admin/market/supply') return method === 'GET' ? 'token?; no body' : q;
  if (route === '/api/admin/wiki/content') return method === 'GET' ? 'token?; If-None-Match?' : 'token,target,content|reset,baseRevision';
  if (route === '/api/admin/wiki/guides') return 'token?,status=pending|approved|rejected|all';
  if (route === '/api/admin/wiki/guides/review') return 'token,target,action=approve|reject,expectedStatus,note';
  if (route === '/api/admin/wiki/guides/delete') return 'token,target,reason';
  if (route.startsWith('/api/admin/banner/')) {
    if (route.endsWith('/add')) return 'token,content,duration,color';
    if (route.endsWith('/remove') || route.endsWith('/stop')) return 'token,id';
    if (route.endsWith('/move')) return 'token,id,dir=up|down';
    if (route.endsWith('/update')) return 'token,id,color';
    if (route.endsWith('/cfg')) return 'token,blink,blinkTitle,noticeColor,catchLevel';
    return 'token';
  }
  if (route.startsWith('/api/admin/feedback/')) {
    if (route.endsWith('/cfg')) return 'token,cdHours,skipCost';
    if (route.endsWith('/status')) return 'token,id,status';
    if (route.endsWith('/del')) return 'token,id';
    if (route.endsWith('/reward')) return 'token,id,coins,note';
  }
  if (route.startsWith('/api/admin/users/')) {
    if (route.endsWith('/setadmin')) return 'token,target,admin';
    if (route.endsWith('/ban')) return 'token,target,hours,reason,confirm';
    if (route.endsWith('/delete')) return 'token,target,confirm';
    if (route.endsWith('/update')) return 'token,target,name,password,coins,listingCap';
    if (route.endsWith('/snapshot')) return method === 'GET' ? 'token,key' : 'token,target,coins,inventory,bd';
    if (route.endsWith('/snapshots')) return 'token,key';
    if (route.endsWith('/snapshot-now')) return 'token,target';
    if (route.endsWith('/rollback')) return 'token,target,snap,confirm';
  }
  if (route === '/api/admin/snapshot/config') return 'token,enabled,interval,retention';
  if (route.startsWith('/api/admin/market/')) {
    if (route.endsWith('/return')) return 'token,lid';
    if (route.endsWith('/supply')) return 'token,action,mode,interval,batch,threshold,target,sellers,options';
    if (route.endsWith('/bulk')) return 'token,mode,sellers,items,qty,price,hours';
  }
  if (route === '/api/admin/party/disband') return 'token,id';
  if (route.startsWith('/api/admin/records/')) {
    if (route.endsWith('/delete')) return 'token,id?';
    if (route.endsWith('/delone')) return 'token,id,range,kind,expected';
    if (route.endsWith('/config')) return 'token,scale,x,y,reset';
  }
  if (route === '/api/admin/settings') return 'token,partial settings (seaCfg/chestCfg/castBaseMs/priceCfg/dropCfg/autoSellCfg/doubleBase/biteFormula/notifyLevel/rareK...)';
  if (route === '/api/admin/mall/config') return 'token,refreshTime,items,reset';
  if (route === '/api/admin/smelt/config') return 'token,partial smelt config or reset';
  if (route === '/api/admin/component/config') return 'token,qualityWeights,countWeights,rollModel,affixRanges,extraAffixRanges,adjectiveRules';
  if (route === '/api/admin/component/reset') return 'token';
  if (route === '/api/admin/component/simulate') return 'token,n';
  if (route === '/api/admin/fish/config') return 'token,sizeModel,sizeWeights';
  if (route === '/api/admin/fish/reset') return 'token';
  if (route === '/api/admin/fish/simulate') return 'token,spotKey,model,n';
  if (route === '/api/admin/spot/pool') return 'token,groundId,spotId,pool[{pick,weight}]';
  if (route === '/api/admin/spot/buffs') return 'token,groundId,spotId,buffs[{type,value}]';
  if (route === '/api/admin/pool/preset') return 'token,preset';
  if (route === '/api/admin/loot/group') return 'token,group definition/entries';
  if (route === '/api/admin/ground/add') return 'token,ground definition';
  if (route === '/api/admin/ground/remove' || route === '/api/admin/ground/restore' || route === '/api/admin/ground/lock') return 'token,groundId,spotId?,locked?';
  if (route === '/api/admin/ground/update') return 'token,groundId,name,fields';
  if (route === '/api/admin/spot/add') return 'token,groundId,spot definition';
  if (route === '/api/admin/spot/remove' || route === '/api/admin/spot/lock') return 'token,groundId,spotId,locked?';
  if (route === '/api/admin/spot/rate') return 'token,groundId,spotId,rate';
  if (route === '/api/admin/spot/pos') return 'token,groundId,spotId?,list';
  if (route === '/api/admin/simulate') return 'token,totals,spotKey';
  if (route === '/api/admin/loot/test') return 'token,spotKey,rare';
  return q;
}

function handlerFor(method, route) {
  const verb = method === 'GET' ? 'Get' : method === 'POST' ? 'Post' : method[0] + method.slice(1).toLowerCase();
  const line = httpGo.split('\n').find(value => value.includes(`r.${verb}("${route}"`));
  if (!line) return 'unresolved';
  const m = line.match(/,\s*([^\)]+)\)/);
  if (!m) return 'unresolved';
  const value = m[1].trim();
  return value.includes('legacySeaAction("') || value.includes('legacyBannerChange("') ? value + ')' : value;
}

const routes = inventory.routes.filter(r => !r.developmentOnly);
const lines = [];
lines.push('# 旧协议 HTTP 契约矩阵（生成稿）', '', `核对基线：Node ${inventory.sourceCommit}，玩法 ${inventory.version}；清单 SHA256 ${inventory.sourceSha256}；shared rules SHA256 ${inventory.sharedRulesSha256}；client.js SHA256 ${inventory.clientSha256}。分母为 ${inventory.routes.length} 个候选减 ${inventory.routes.filter(r => r.developmentOnly).length} 个开发接口 = ${routes.length} 条唯一非开发 method + path。`, '', '本表由 `node tools/go-rewrite/api-contract-matrix.js` 从 `server-go/api/legacy-inventory.json` 生成。契约类定义行为断言；路由表逐项列出 method/path、认证、输入、成功、业务错误和持久副作用。HTTP 通过必须在 Node/Go 适配夹具中分别执行并比对，静态注册不计作通过。', '');
lines.push('## 契约类', '', '| 类 | 认证/权限 | 输入校验 | 成功响应 | 业务错误/状态 | 持久副作用 |', '|---|---|---|---|---|---|');
for (const [id, v] of Object.entries(classes)) lines.push(`| ${id} | ${v[0]} | ${v[1]} | ${v[2]} | ${v[3]} | ${v[4]} |`);
lines.push('', '## 逐路由矩阵', '', '| # | method + path | Node 行 | Go 注册处理器 | 契约类 | 本路由输入/查询 |', '|---:|---|---:|---|---|---|');
routes.forEach((r, i) => lines.push('| ' + (i + 1) + ' | ' + r.method + ' `' + r.path + '` | ' + r.line + ' | `' + handlerFor(r.method, r.path) + '` | ' + classFor(r.method, r.path) + ' | ' + inputFor(r.method, r.path) + ' |'));
lines.push('', '## 验收规则', '', '- 每个表行至少执行：未认证、错误 JSON/未知字段、边界/越界输入、成功、重复/并发业务冲突；写操作同时读回 PostgreSQL 权威表和 SSE 结果。', '- Node 与 Go 使用同一前端、固定玩法/目录和语义等价夹具。随机/时间场景使用固定时间、可注入 seed/序列或只比较不变量；不得比较两次失控随机值。', '- 记录 HTTP status、JSON `error`/`code`、响应字段集合、资产 `invRev`/market revision、数据库行/余额/库存/审计和事件顺序。`skip`、超时、中断或缺真库不计通过。', '- 公共安全层还要断言 POST 非 JSON=415、跨源=403、cookie 模式 CSRF=403、未知路由=404；这些是所有 POST 路由的共同前置契约。', '', '## 当前已知实现差异（供兼容窗口）', '', '- `POST /api/players/view` 在 Go 仅登记 viewport 并返回当前 stream 数，尚未像 Node 一样对每条 SSE 连接推送 `playersPage`；浏览器 A/B 必须把“登记响应”和“后续推送”分开记差异。', '- `GET /api/shop/history` 的 Go 投影明确返回空 `points`/`trades`（价格和销量来自持久模块），不能把空数组误判为 Node 历史数据等价。', '- `POST /api/feedback/submit` 的 Go 注释说明尚未桥接管理员实时通知；反馈落库可比，但 SSE `feedback`/管理员即时提示需单独标记。', '- legacy `GET /events` 的 Go 首帧仍是 `init`；`snapshot_required`/`assets_changed` 属于另一个 `/api/v1/events` 消费者，不能拿 v1 类型替代旧前端的 `init`/`batch`/`assets`/个人事件验收。', '- `POST /api/market/*`、`/api/trade/*`、工坊和宝匣的随机/时间结果只比对受控夹具中的业务不变量、资产事务和事件顺序；不要求两次自然随机相同。');

const defaultOut = path.join(root, 'docs/go-rewrite/reports/AB_API_MATRIX.md');
const check = process.argv[2] === '--check';
const out = check ? defaultOut : (process.argv[2] || defaultOut);
const rendered = lines.join('\n') + '\n';
if (check) {
  const current = fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : '';
  if (current !== rendered) {
    console.error(`contract matrix drift: regenerate ${out}`);
    process.exitCode = 1;
  } else {
    console.log(`contract matrix ok (${routes.length} routes)`);
  }
} else {
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, rendered);
  console.log(`wrote ${out} (${routes.length} routes)`);
}

# Wiki 规划与开发日志

## 2026-09-19 · 背包只读副本与模拟操作

- 配装和熔炼新增“读取我的背包”：复制实际组件、当前穿戴与已保存钓竿，保留词条数值和显式/推断来源；配装副本可增加词条、保存到浏览器、进行 A/B 对比。
- 新增登录态 GET `/api/wiki/simulator/inventory`，仅返回模拟所需数据，响应 `private, no-store`。不调用会触发自动出售的 `/api/me`；钓竿视图辅助函数只接触克隆数据，非 GET 请求拒绝。
- 熔炼改为调用与真实工坊相同的 `smeltPlanOf` / `simulateSmeltPlan` 纯函数，增加“用结果继续模拟”。背包材料、宝珠、残片和金币仅作资源参考，单次及批量试验不扣库存，不请求资产写入接口。
- 修复配装来源选择与范围校验：副件底材来源可见并可保留，自定义超范围数值可开启自由试算。
- 隔离账号验证：HTTP/规则回归 94/94、浏览器回归 75/75；配装修改、保存、熔炼和批量试验前后资产快照与账号文件完全一致，网络记录仅包含允许的 GET 接口。

## 2026-09-19 · 攻略类推写法与模拟器按钮

- 六词条攻略改为“以尼龙线组为例”的通用思路，加入不同起手词条、已有五条和更换底材时的配方替换说明；删去验收式口吻，同步撰写底稿。
- 两个模拟器统一深色按钮、青绿主操作、低调删除操作和键盘焦点样式，手机触控高度至少 44px；方案 A/B 加入可见选中态与 aria-pressed。
- 熔炼催化剂复用游戏工坊的“添加材料 → 选择催化剂”交互，展示六种材料贴图、对应词条与增减数量；份数、种类和可选状态跟随共享规则，选择变化后同步预览。关闭保留选择，支持 Escape 和手机列表滚动。
- 同步本地 19024 预览的官方攻略内容，保留其他内容和玩家投稿；存储实现未改。
- 验证：Wiki 浏览器回归 65/65 通过，涵盖动态材料限额、不适用投料清理、弹窗焦点返回和 360px 布局；静态构建通过。

## 2026-09-19 · 紧凑布局与统一更新流（用户确认后落地）

- 首页缩窄导航，采用推荐攻略 + 最近更新 / 常用工具双栏，取消卡片固定高度；手机导航改为可换行的顶部导航。
- 六词条实战攻略与独立机制说明收录至 content.json；补齐具体配方、成本、验收和保留失败止损，区分旧实操与规则模拟结论。
- 攻略增加锚点目录、配套文章和模拟器入口；窄屏目录默认折叠，优先展示正文。
- 游戏版本日期补全年份；首页和更新页使用同一合并排序，日期降序、同日 Wiki 优先、同来源保留顺序；仅最新一条默认可见，其余历史折叠。
- 搜索展示游戏物品贴图、类型和用途；移除结果中的内部 ID，增加搜索导航和回车搜索。
- 保留既有自动通过流程，投稿说明随实际审核配置显示。本轮未改存储层或执行生产部署。
- 验证：Wiki 构建/静态检查、87 项规则及 HTTP 检查、59 项浏览器回归（含自动投稿、历史展开、手机目录折叠和 360px 布局）。

本文件记录 Wiki 分支的需求、文档与开发进展。规划不等于功能已实现；游戏发布历史仍见 [VERSIONS.md](../../VERSIONS.md)。

## 2026-09-19 · Wiki 内容迁移 SQLite（功能更新）

状态：官方攻略、更新记录、玩家投稿与审核状态已从 JSON 全量文件迁移到 SQLite；HTTP 回归 84 项、浏览器回归 54 项通过，Docker 镜像实测可创建 `wiki.db` 并正常读写。

- 新增 `backend/wiki-store.js`：基于 Node 内置 `node:sqlite`（要求 Node >= 22.13），WAL 模式、外键、事务与索引；表结构为 `guides` / `guide_sections` / `updates` / `guide_revisions` / `wiki_meta`。
- 首次启动自动迁移旧 `wiki.json` / `wiki-guides.json`（含 pending/rejected/软删除状态与 revision），旧文件保留作备份，之后不再读写。
- 公开接口拆分：`/api/wiki/content` 只下发攻略元数据；新增 `/api/wiki/guides`（分页/分类/正文搜索）与 `/api/wiki/guides/<id>`（正文详情）。前端详情按需加载并按内容 revision 缓存。
- 内容 ETag 改为 revision 直出（`wiki-content-<official>-<user>`），不再对全量 JSON 做 SHA-256。
- 官方保存、投稿、审核、删除全部走 SQLite 事务；`guide_revisions` 记录快照，为后续版本历史/全文检索预留。
- Docker 基础镜像要求 Node >= 22.13；启动命令加 `--disable-warning=ExperimentalWarning` 隐藏 node:sqlite 实验性提示（直接 `node backend/server.js` 启动时仍会看到该提示）。

## 2026-09-19 · 六词条攻略与 Wiki 体验优化（功能更新）

状态：攻略内容、自动审核模式、页面布局、更新页与搜索贴图优化已实现，并通过 Wiki HTTP 回归与浏览器回归。

- 新增两篇官方攻略：《六词条路线：神话突破件 + 残片保留（2 词池底材）》与《池内、池外、突破、催化：残片保留机制怎么算》。内容基于当前共享规则实现：海王遗匣池内全取 + 池外补足到 3/4 条、单次熔炼主选 + 副选 + 补缀最多 3 条、残片保留不占补缀上限、2 词池底材两段补到 6 条。
- 用户投稿改为默认自动通过：提交后立即公开，`reviewedBy=auto`；作者可以删除自己的自动通过投稿。设置环境变量 `WIKI_GUIDE_AUTO_APPROVE=0` 重启即恢复人工审核，管理员审核/拒绝/删除接口与依赖它的回归保留。
- 首页与更新页只突出最近一次更新；完整版本演进与更早的 Wiki 内容收进可展开的历史入口，去掉长表格固定高度滚动造成的空白。
- 修复 Wiki 页面继承游戏内双列 `.content` 网格导致的半宽卡片与大片空白：资料站统一改为单列块级排版，攻略正文与相关工具改为双栏自适应，攻略目录改为多列自适应。
- 全站搜索扩展到渔获、材料、组件底材、宝匣与词缀类型，结果为条目显示像素贴图，并提供轻量详情卡（词条池、产出钓点、用途/成本、工具入口）；搜索类型过滤器同步扩展，保持 100 次搜索平均耗时低于 100ms 的回归门槛。
- 同步更新开发文档的用户投稿契约、搜索范围、更新页展示口径与验收条目。

## 2026-09-18 · 开发方案 0.1（文档更新）

状态：完成需求与方案记录，尚未开始 Wiki 功能实现。

- 确定首版包含资料查询、玩法攻略、配装模拟器和熔炼模拟器。
- 新增 [详细开发文档](DEVELOPMENT.md)，覆盖页面结构、首批内容、功能流程、规则复用、公开配置快照、保存分享、测试矩阵和阶段验收。
- 配装模拟器规划七部位编辑、钓点条件计算、双方案对比、本地保存、链接与方案码分享。
- 熔炼模拟器规划主副件/词缀选择、投料与保护、费用概率、成功失败分支、单次及批量模拟，并支持将结果带入配装。
- 以 `v0.16.6 / a9e1924` 的代码核对规则，记录投料成功率方向、残片动态保留概率、失败保护等旧文字与实现之间的差异。
- 初稿曾按版本默认配置规划首版；该方案已被当日“服务端规则一致性”规划变更替代。正式首版必须使用服务端快照和共享规则，真实背包接入、自动寻优、社区投稿及独立重铸模拟器仍列为后续扩展。
- 增加 README 与游戏版本记录中的 Wiki 规划入口；游戏版本号保持不变。

验证范围：文档差异与格式、相对链接、本地 fixture 熔炼/双钓验算示例。未执行 Wiki 功能测试或生产部署。

下一阶段：按“现有接口盘点与复用优先”方案扩展现有公开接口，并建立与现有游戏行为的一致性基线。


## 2026-09-18 · 规划变更：服务端规则一致性（文档更新）

状态：已记录为 M1 阻塞要求，尚未实现。

- 明确正式 Wiki 的目录、配置、公式、概率和费用必须来自正式服务端生成的白名单快照。
- 明确服务端与 Wiki 必须共用同一套纯规则实现，禁止维护第二套公式或手写数值。
- 快照必须携带游戏版本、规则版本、配置代数和配置哈希；校验失败、版本不匹配或刷新失败时禁用计算，不能回退默认值或旧缓存。
- 服务端配置变更后需生成新的原子快照，Wiki 需通过轮询、ETag 或广播取得新配置；未同步前受影响计算不可用。
- 将 M1 从“默认快照可复现”提升为“正式服务端快照 + 共享规则 + 一致性闸门”，M1 完成前不进入生产 Wiki 开发验收。
- `fixture` 快照仅限本地测试和研究，不得用于生产环境。

验证范围：文档更新与链接检查。未实现快照接口、共享规则模块或同步机制。

## 2026-09-18 · 规划变更：现有接口盘点与复用优先（文档更新）

状态：完成接口盘点与复用决策，未修改服务端接口。

- 本地临时服务实测 `/api/version` 默认约 1.4 KB，已公开版本、功能开关、组件、鱼类体型、抛竿、掉落、经济、宝匣、熔炼等配置。
- 实测 `/api/grounds` 默认约 4.0 KB，返回 4 个钓场、9 个钓点及按掉落倍率换算后的有效权重。
- 确认 `/api/features` 与 `/api/version.features` 重复；`/events` 需要登录；`/api/admin/world` 与 `/api/admin/simulate` 为管理端，不适合作为公开 Wiki 数据源。
- 决定不新增 `/api/wiki/rules`，改为扩展现有 `GET /api/version?profile=wiki`；Wiki 只调用该 profile，服务端内部复用 `groundsWithDrop()` 与现有 `data.js` 共享规则。
- `/api/grounds` 暂保留给现有游戏端与测试，后续评估兼容别名或移除；`/api/features` 后续标记重复并迁移调用方。
- `profile=wiki` 需补齐 `biteFormula`、`doubleBase`、`rareK`、公开目录、钓点有效权重、规则版本、配置代数、配置哈希、生成时间与缓存语义。

验证范围：本地临时端口请求现有公开接口并核对返回结构与大小；未修改接口、未执行线上请求。

## 2026-09-18 · 开发文档复审 0.3（文档更新）

状态：完成实现前文档复审，未修改服务端或 Wiki 功能代码。

- 将文档版本提升到 0.3，明确当前仍处于规划与接口盘点阶段；合入最新 `main`（`v0.17.0 / 97d3597`）并更新核对基线。
- 复核 `v0.17.0` 相对 `v0.16.6` 的差异：`backend/server.js` 无变化，`frontend/js/data.js` 仅版本号变化，接口盘点结论继续适用。
- 区分规则快照与实时经济状态：规则、目录和计算配置使用 `/api/version?profile=wiki`；实时收购价复用现有 `/shop`，不参与 `configHash`，并要求 no-store、5 秒刷新和 10 秒失联隐藏当前价。
- 明确 `profile=wiki` 返回独立 `snapshot` 对象，响应外形为 `{ profile, version, snapshot }`；默认响应与 Wiki profile 必须共用同一个服务端组装函数，不允许两处手拼。
- 明确缓存与新鲜度口径：`Cache-Control: no-cache`、`ETag: snapshotId`、5 秒轮询，连续 10 秒无法确认配置则禁用受影响计算。
- 明确 `configHash` 只覆盖规则与目录，不包含生成时间、快照 ID 和实时价格；`snapshotId` 由服务器实例、配置代数和哈希派生并作为 ETag。
- 明确生产构建不内嵌正式快照；构建与线上契约验证拆成 `wiki:build` 与 `wiki:verify:server`。
- 修正目录方案：本地测试使用 `fixtures`，共享计算优先扩展现有 `data.js`，只为确需迁移的服务端独有纯函数增加窄共享文件。
- 明确搜索必须在运行时合并当前快照目录，避免静态索引滞后。
- 明确配装计算不能复制服务端函数；进入 M3 前需最小迁移并让服务端正式路径与 Wiki 共用同一实现。
- 明确首版纠错入口为复制“页面地址 + 版本 + 问题描述”模板，不新建投稿后端。

验证范围：文档一致性、相对链接、章节编号与空白检查。未执行功能测试或生产部署。

## 2026-09-18 · 托管决策 0.4（文档更新）

状态：已确定首版托管方案，尚未实现 Wiki 页面或部署流程。

- Wiki 显示名称暂定为 `wiki`。
- 首版由游戏服务器在同一个域名下托管 `/wiki/`，不新增独立静态托管、子域名或 CORS 配置。
- Wiki 页面使用相对路径请求 `/api/version?profile=wiki` 与 `/shop`，保持同源访问。
- 构建产物部署到游戏服务器可托管的 Wiki 目录；本地预览需保持与正式 `/wiki/` 前缀一致的路径计算。
- 接受游戏服务重启期间 Wiki 短暂不可用；后续如流量增长，再评估保持 `/wiki/` 路径不变的同域名静态目录拆分。

验证范围：文档更新与链接检查。未修改服务端、构建脚本或部署配置。

## 2026-09-18 · M1 实现：服务端规则快照与共享计算（功能更新）

状态：M1 服务端部分完成并通过专项回归；完整 Wiki 页面与两个模拟器尚未实现。

- 扩展现有 `GET /api/version?profile=wiki`，返回独立 `snapshot`，不新增平行规则接口。
- 快照包含公开目录、有效掉落权重、公式配置、规则版本、配置代数、配置哈希、服务器实例、生成时间与来源提交。
- 默认 `/api/version` 保持原字段兼容，并使用 `no-cache`；Wiki profile 使用 `no-cache`、`ETag: snapshotId` 并支持 304。
- `configHash` 使用规范化 JSON 计算，只覆盖目录、钓点、公式与规则配置；生成时间、快照 ID 与实时价格不参与哈希。
- `wikiConfigRevision` 随 `config.json` 持久化，配置保存后递增；管理端修改功能开关会推进代数并改变哈希与 ETag。
- `/shop` 增加 `Cache-Control: no-store`，供 Wiki 后续展示实时收购价，不与规则快照混淆。
- `frontend/js/data.js` 新增共享配装计算、上鱼公式计算、双钓计算与可注入随机数；服务端正式路径改为委托同一实现，避免第二套公式。
- 新增同域 `/wiki/` M1 验收页，展示规则快照元数据与目录规模，并实现 5 秒 ETag 轮询、10 秒失联禁用状态。
- 静态服务支持目录路径自动读取 `index.html`，`/wiki` 自动 301 到 `/wiki/`，使同域入口可直接访问。
- 新增 `tests/wiki/wiki.test.js` 并纳入 `tests/run-all.js`；提供 `npm run wiki:test`。

验证：

- `node tests/wiki/wiki.test.js`：通过 32 项，失败 0 项。
- `FISHING_TEST_ONLY=wiki/wiki node tests/run-all.js`：通过 32 项，失败 0 项。
- `node tests/admin.test.js`：通过 392 项，失败 0 项。
- `node tests/security.test.js`：通过 192 项。
- `node tests/transport-security.test.js`：通过 49 项。
- `node --check backend/server.js`、`node --check frontend/js/data.js`、`node --check tests/wiki/wiki.test.js`、`node --check tests/run-all.js` 通过。
- `node tests/e2e.test.js` 在注册阶段失败；该套件尚未适配当前注册防滥用的 challenge 流程，失败点发生在本次改动覆盖路径之前，不作为本次回归结论。

## 2026-09-18 · M2～M5 实现：资料站、模拟器与构建验收（功能更新）

状态：Wiki 功能开发与本地验收完成；生产部署和游戏 Release 未执行。

- 新增 Wiki 资料站页面：首页、图鉴、钓场、搜索、攻略、更新与纠错。
- 图鉴运行时渲染鱼类、材料、组件、宝匣与词缀；物品详情展示当前区间、获取地点和实时收购价读取入口。
- 钓场页面展示开放状态、钓点数、增益、独立覆盖与当前有效掉落权重。
- 全站搜索运行时合并服务端快照目录、钓点、词缀、攻略与工具入口。
- 攻略与更新内容由 `frontend/wiki/js/content.js` 维护，不在正文中硬编码当前概率。
- 新增配装模拟器 `/wiki/tools/build.html`：七部位编辑、品质与词缀来源、钓点选择、A/B 对比、本地保存、链接与方案码分享、自由试算标记、导入规则不匹配时阻断官方计算。
- 配装模拟器支持从图鉴底材和钓点链接带入参数，并可读取熔炼产物。
- 新增熔炼模拟器 `/wiki/tools/smelt.html`：主副件与词缀选择、投料、龙宫宝珠、保护残片、费用与概率预览、成功/失败分支、单次模拟、批量模拟、进度与取消。
- 熔炼批量使用 mulberry32 带种子随机数，分片执行避免阻塞界面；产物可写入本地并由配装模拟器读取。
- 两个模拟器均复用 `/wiki/js/core.js` 的规则快照客户端和 `frontend/js/data.js` 共享计算，不维护第二套公式。
- 移除管理端保存上钩公式时对旧 `biteCompiledSrc` 缓存变量的残留引用；共享计算切换后公式保存与试算恢复通过。
- 新增 `npm run wiki:check`、`wiki:build`、`wiki:serve`、`wiki:verify:server` 和 `wiki:test:browser`。
- `wiki:check` 检查必需文件、本地链接和全部前端脚本语法；`wiki:build` 输出到 `dist/wiki`；`wiki:verify:server` 连接指定服务端验证 profile、ETag、304、钓点一致性和 `/shop` 缓存语义。
- `frontend/serve.js` 支持目录路径自动读取 `index.html`，`wiki:serve` 可直接访问 `/wiki/`。

验证：

- `npm run wiki:check`：通过，8 个页面、6 个脚本（含 frontend/serve.js）。
- `npm run wiki:build`：通过，构建 15 个文件到 `dist/wiki`。
- `npm run wiki:test`：通过 33 项，失败 0 项。
- `npm run wiki:test:browser`：通过 24 项，失败 0 项。
- `FISHING_TEST_ONLY=wiki/wiki,wiki/browser node tests/run-all.js`：通过 57 项，失败 0 项。
- `node --check` 覆盖仓库 90 个 JavaScript 文件，全部通过。
- `WIKI_SERVER_BASE=http://127.0.0.1:19000 npm run wiki:verify:server`：通过 9 项。
- `PORT=5510 npm run wiki:serve` 后请求 `/wiki/` 返回 200 与 Wiki 页面。
- 新增 `tests/wiki/browser.test.js` 并纳入 `tests/run-all.js`；无头 Chrome 渲染首页、图鉴、钓场、搜索、攻略、更新、配装和熔炼页面，均无脚本异常；全站搜索 100 次平均耗时低于 100ms；360px 手机宽度下首页与两个模拟器无横向溢出；模拟请求失败后配装模拟器进入规则不可用并禁用计算。
- 无头 Chrome 交互验证：图鉴渲染 86 个目录卡片；搜索“龙宫宝珠”返回结果；钓点详情展示 3 个静水湖钓点与有效产出；配装导入/导出方案码往返后钓速 50 计算 1500ms；熔炼 1 份诱饵包预览 48% / 8% / 3.8% / 5900 金币，批量 100 次完成；熔炼产物带入配装后词缀参与计算。
- 复核运行 `node tests/admin.test.js`（392 项通过）、`node tests/security.test.js`（192 项通过）和 `node tests/transport-security.test.js`（49 项通过）。
- `node tests/e2e.test.js` 仍在注册 challenge 适配前失败，不作为本次验收结论。

## 2026-09-18 · 攻略目录重写与后台热更新（功能更新）

状态：本地实现与专项回归完成；生产部署和游戏 Release 未执行。

- 重写攻略目录为 9 篇策略文章：新手首小时、产量优先级、钓点选择、七部位五词条参考、五词条工坊路线、工坊止损、资源循环、库存清理与常见问题。
- 攻略正文加入一组实测七部位五词条样本：45 次熔炼、36 次成功、17 次高保留转移中 12 次保留成功，总消耗约 451,800 金币与 170 片残片；样本仅用于说明波动和预算，不作为保底承诺。
- 新增 `frontend/wiki/content/content.json` 作为内置内容种子；`frontend/wiki/js/content.js` 只保留兜底容器，避免正文双来源漂移。
- 新增公开 `GET /api/wiki/content`，返回攻略、更新记录、内容版本与更新时间，使用 no-cache、ETag 与 304。
- 新增管理员 `POST /api/admin/wiki/content`，支持保存整份 JSON 或恢复内置内容；请求纳入管理员 MFA、管理审计和服务端结构校验。
- 热更新内容独立保存到数据目录 `wiki.json`，不污染 `config.json`，也不推进规则快照配置代数。
- Wiki 前端每 5 秒轮询攻略内容并在窗口回到前台刷新；接口不可用的静态开发环境回退读取内置 JSON。
- 管理后台新增「📚 Wiki攻略」页：当前版本与文章列表、JSON 编辑、格式化、保存发布、恢复内置。
- `wiki:check` 增加 JSON 结构、ID 唯一性和段落类型检查；`wiki:verify:server` 增加攻略内容接口检查。

验证：

- `npm run wiki:check`：通过，8 个页面、6 个脚本，并检查 `content/content.json`。
- `npm run wiki:test`：通过 42 项，失败 0 项；覆盖攻略接口 ETag/304、未登录拒绝、空内容拒绝、管理员热更新、公开立即生效、独立落盘与不污染配置。
- `npm run wiki:test:browser`：通过 30 项，失败 0 项；新增攻略页渲染热更新内容、管理后台登录并打开 Wiki 攻略编辑器，均无脚本异常。
- `npm run wiki:verify:server`：本地临时服务通过 12 项，失败 0 项；包含攻略内容接口、no-cache 与 ETag。
- `node --check backend/server.js`、`frontend/js/admin.js`、`frontend/wiki/js/core.js`、`frontend/wiki/js/pages.js`、`tools/wiki/check.js`、`tools/wiki/verify-server.js` 与 Wiki 测试脚本均通过。

## 2026-09-19 · v0.19.0 用户攻略、审核与工具界面（功能更新）

状态：本地实现与专项回归完成；生产部署和游戏 Release 未执行。

- 官方内容与用户投稿彻底分离：
  - 官方内容继续落在 `wiki.json`。
  - 用户投稿独立落在 `wiki-guides.json`。
  - 管理员保存或恢复官方内容不会覆盖、删除用户投稿。
- 官方内容保存增加 `baseRevision` 乐观锁，过期保存返回 409，防止并发覆盖。
- 新增 `GET /api/admin/wiki/content`，管理后台只编辑官方内容，不再把公开合并结果误当成官方 JSON。
- 新增用户投稿接口：
  - `POST /api/wiki/guides/submit`
  - `GET /api/wiki/guides/session`
  - `GET /api/wiki/guides/my`
  - `POST /api/wiki/guides/delete`
- 新增管理员审核接口：
  - `GET /api/admin/wiki/guides`
  - `POST /api/admin/wiki/guides/review`
  - `POST /api/admin/wiki/guides/delete`
- 公开 `GET /api/wiki/content` 只返回官方攻略与 `approved` 用户攻略；pending、rejected、deleted 不下发。
- 用户投稿使用现有 Cookie/Authorization 会话与 CSRF 约束，不接受 URL/body token，也不接受客户端伪造作者、状态、审核字段。
- 服务端严格校验标题、分类白名单、摘要、标签、段落结构、列表与 64 KB 单篇大小；前端全部使用纯文本渲染。
- 投稿频率限制改为持久化计算：24 小时最多 3 篇、pending 最多 3 篇、两次提交至少间隔 10 分钟，重启后仍生效。
- 管理员审核要求 `expectedStatus` 匹配当前状态，拒绝与删除必须填写原因，并记录审核人、审核时间与审计日志。
- 玩家前端新增：
  - `/wiki/guides/submit.html` 投稿表单
  - 本地草稿
  - `/wiki/guides/index.html?my=1` 我的攻略
  - 官方 / 玩家 / 全部筛选
  - approved 用户攻略搜索
- 管理后台「📚 Wiki攻略」拆成官方内容编辑与用户投稿审核两个区域，不再要求管理员手改 JSON 审核投稿。
- 新增官方攻略《新手避坑：最容易浪费资源的 9 个习惯》，更新记录改为玩家可理解的功能变化。
- 配装与熔炼模拟器复用游戏工坊式双栏布局：
  - 桌面左侧编辑、右侧常驻预览
  - 1250px 以下自动单列
  - 保留原有全部功能 ID 与计算逻辑
- 游戏版本提升到 `v0.19.0`，构建日期更新为 2026-09-19。

验证：

- `npm run wiki:check`：通过，9 个页面、6 个脚本，并检查官方内容身份字段。
- `npm run wiki:test`：通过 72 项，失败 0 项。
- `npm run wiki:test:browser`：通过 46 项，失败 0 项。
- `npm run wiki:build`：通过，构建 17 个文件到 `dist/wiki`。
- `WIKI_SERVER_BASE=http://127.0.0.1:19000 npm run wiki:verify:server`：本地临时服务通过 12 项，失败 0 项。
- 覆盖公开内容不泄露待审核/已拒绝投稿、未登录 401、非法字段拒绝、作者隔离、频率限制、并发审核冲突、管理员审计、官方与用户数据互不覆盖、重启持久化、浏览器提交表单、管理后台审核、搜索只包含公开攻略、双模拟器布局和 360px 无横向溢出。

## 2026-09-19 · 本地 Docker 测试环境（运维工具）

状态：本地实现与容器烟测完成；生产部署未执行。

- 新增 `docker-compose.wiki-test.yml`：
  - 服务名 `wiki-test`
  - 默认只绑定 `127.0.0.1:19000`
  - 使用 named volume `web-fishing-wiki-test-data` 隔离测试数据
  - 容器 root filesystem 只读，仅 `/data` 与 `/tmp` 可写
  - 移除全部 Linux capabilities 并禁止提权
  - 内置 `/api/version` 健康检查
- 新增 `docker/wiki-test/Dockerfile`：
  - 默认基础镜像 `node:22-alpine`
  - 支持 `NODE_IMAGE` build arg 覆盖，便于受限镜像源环境复用已有 Node 镜像
  - 注入 `SOURCE_COMMIT`
  - 数据固定写入 `/data`
- 新增 `tools/wiki/docker-test.ps1`：
  - 自动读取当前 Git commit
  - 支持自定义端口
  - 支持 `-Follow` 前台运行
  - 支持 `-NoBuild`
  - 支持 `-Reset` 删除数据卷
  - 本机缺少 `node:22-alpine` 时可自动复用已存在的 `web-fishing-node-runtime:local`
- 新增 `docs/wiki/DOCKER_TEST.md`，覆盖启动、管理员初始化、投稿审核、数据持久化、重置和镜像受限时的处理。
- `package.json` 新增：
  - `wiki:docker`
  - `wiki:docker:up`
  - `wiki:docker:down`
  - `wiki:docker:reset`
  - `wiki:docker:logs`

验证：

- `docker compose -f docker-compose.wiki-test.yml config` 通过。
- 本地容器构建并启动成功，健康检查为 `healthy`。
- `/api/version?profile=wiki` 返回 `v0.19.0`，并带当前提交 `f515964...`。
- `/api/wiki/content` 返回官方 10 篇攻略。
- Docker 内注册普通玩家并提交攻略成功。
- 待审核攻略未进入公开接口。
- 通过容器控制台执行 `admin-init`，管理员 TOTP 初始化成功。
- 管理员登录并审核通过投稿成功。
- 审核通过后公开接口可见该用户攻略，作者名为 `Docker User`。
- 容器重启后数据保留，用户 revision 与已通过投稿仍可读取。

## 2026-09-19 · Wiki 主线版本同步与游戏化界面重构（功能更新）

状态：本地实现与专项回归完成；生产部署和游戏 Release 未执行。

- 新增 `tools/wiki/sync-versions.js`，从根目录 `VERSIONS.md` 生成 `frontend/wiki/content/versions.json`；`wiki:build` 自动同步，新增 `npm run wiki:sync` 手动同步，`wiki:check` 校验两份版本表一致。
- 更新记录页改为「游戏版本演进 + Wiki 内容更新」：主线版本表最新在前；移除游戏版本、规则版本、配置代数、配置哈希、快照时间、当前规则、纠错入口与复制纠错模板。
- Wiki 全站改为游戏顶栏 + 侧栏 + 内容区外壳，直接加载游戏 `style.css`、`pixel.css`、`responsive.css`、`mobile.css` 与 `smelt.css`，复用像素背景、窗口框、按钮、输入框和导航视觉。
- 配装与熔炼模拟器改为工坊式编号步骤、`smelt-workbench` 双栏工作台、常驻预览面板；熔炼投料改为游戏材料卡片样式，主副件编辑、宝珠、残片与批量模拟使用同一视觉体系。
- 首页重写为游戏化卡片目录，保留钓场、攻略、更新与两个模拟器；移除 Wiki 独立图鉴页、图鉴导航和物品/组件/词缀搜索索引，游戏内图鉴仍是唯一图鉴入口。
- 游戏侧栏在「日志」下方新增「WIKI」入口，点击新标签打开 `/wiki/`，不中断当前钓鱼状态；新增 `assets/nav/wiki.png` 图标，并纳入 `tools/gen_nav.py` 生成清单。
- 搜索保留钓场、钓点、攻略与工具，并修复钓点搜索结果图片使用组合 ID 导致的 404。
- 同步更新 README、VERSIONS、GUIDE、Wiki 开发文档与相关测试口径。

验证：

- `npm run wiki:check`：通过，8 个页面、6 个脚本，并校验版本记录与 `VERSIONS.md` 一致。
- `npm run wiki:test`：通过 73 项，失败 0 项。
- `npm run wiki:test:browser`：通过 47 项，失败 0 项；覆盖更新页无规则诊断信息、主线版本表渲染、搜索、双模拟器工坊式双栏布局、交互、管理审核与 360px 无横向溢出。
- `npm run wiki:build`：通过，自动同步 77 条版本记录并构建 17 个文件到 `dist/wiki`。
- `node --check` 覆盖本次修改的前端 Wiki 脚本、游戏 `data.js` / `ui.js` 与相关测试脚本，均通过。
- `node tests/e2e.test.js` 复跑时静态数据段通过（含导航 10 个入口与 README/GUIDE 版本），随后仍在既有注册 challenge 适配处失败，不能作为本次验收结论。
- 本工作区未安装可选测试依赖 `jsdom` / `playwright-core`，`auth-ui` 与 `ui-layout` 单独执行无法启动；相关断言已同步为 10 个入口，待依赖可用后复测。

## 后续记录要求

每条日志注明日期、变更类型（规划/文档/实现/修复/发布）、完成状态、适用版本与实际验证结果。实现后将验证证据写入对应条目，不回填成“规划当日已经实现”。

v0.23.4 · 工坊装备成长的组件选择卡片 / 正式服全新存档清档工具

- 工坊「装备成长」的组件选择改成一张卡片，卡片嵌在「强化路径」的框体内：没选组件时点卡片弹出「选择组件」子窗口（搜索 + 部位 / 品质 / 属性 / 强化等级 / 状态筛选 + 结果网格，列表按当前选择高亮），选中后卡片直接显示该配件的名称、等级与词条。
- 点击已选组件的卡片即取消当前选中的组件：强化路径回到「尚未选择组件」，详情区保留一句说明与「选择组件」按钮，可再次打开子窗口换一件。子窗口沿用全站子窗口结构：点遮罩、✕ 或 Esc 关闭，Tab 在窗口内循环焦点，筛选可一键重置。
- 组件选择不再预选第一件配件，也不再把搜索与筛选铺在页面上：未选组件时不渲染材料强化、副属性调校、精工锻造与成长转移，改为提示先选组件；「旧制转换」仍是卡片内的多选列表，批量勾选不适合收进子窗口。
- 顺带修复 `tests/mail-gear.test.js`：改为按新的选择流程操作（点卡片 → 选配件），浏览器路径改为优先 `CHROME_PATH` / Chrome 候选而非硬编码 `msedge.exe`，并补一件非奖励绑定配件，使「仅使用普通物品」的请求断言恢复可验证、该套件重新通过。
- 新增 `reset` 运维命令（`server-go/cmd/reset`）：`./bin/reset fresh` 是只读预演，打印将保留与将清空的表；`./bin/reset fresh --confirm` 在单个事务里把正式服的玩家运行时数据清空成「全新存档」——账号、资产与流水、图鉴、渔获纪录、市集挂单与订单、交易、邮件、好友与编队、海域与远航、反馈、Wiki 投稿、会话与在线租约、后台审计与登录失败记录。表、字段、索引、约束、序列、权限与迁移账本原样保留。
- 清空范围按数据库实际目录动态计算，后续迁移新增的玩家表自动纳入：保留物品定义 `item_definitions`、运营参数 `operator_settings`、公告队列 `banner_state`、邮件 worker 与迁移期单例行、Wiki 修订水位；清空后同一批步骤重播物品定义、重建 `catalog_head` / `feature_head` 空头，并恢复内置官方 Wiki 指南。
- 安全边界：执行前用 `migrations.Check` 比对 schema 与二进制，不一致即拒绝；检测到其他 `application_name='fishing-go'` 连接时拒绝执行，避免带着运行中的服务清档；清空在单事务内完成，失败整体回滚，`RESTART IDENTITY` 让新账号从 1 开始编号；只使用 schema 管理连接，不需要也不应使用超级用户。清档不可逆，操作顺序（备份 → 停服 → 只读预演 → 执行 → 重建管理员 → 起服冒烟）见 `docs/go-rewrite/FRESH_SAVE.md`。
- 发行包开始包含 `bin/reset`：`tools/release/build-linux.sh` 现在构建 `game` / `migrate` / `catalog` / `admin` / `reset` 五个命令，`tests/linux-deploy.test.py` 相应要求归档内必须有 `bin/reset`，部署说明同步更新。

验收：前端 14 个套件 889 项断言全部通过（run-all，含 workshop-market-regression、smelt-workbench、mobile-layout、desktop-zoom、expedition）；另跑 gear-conversion 1 项、expedition-growth 5 项、equipment-filters 10 项、mail-gear 1 项通过；另用 15 项脚本覆盖空卡片、子窗口筛选与重置、取消选中、配装占用配件、Esc 关闭与旧制页签；1440px / 1180px / 390px 三种宽度复核（空态 / 子窗口 / 已选态）无横向溢出。Go catalog 与 chest / mall / native / workshop 四份规则 fixtures 已按 frontend/js/data.js 重新生成并通过 --check 一致性校验（本机无 Go 工具链，go test ./... 由 CI 执行）。

清档验收：合成真库（`deploy/go-test` 的隔离 PostgreSQL 18.6）`go build ./...`、`go vet ./...`、`go test -count=1 ./...` 全部退出 0，`internal/app` 的 `TestIntegrationFreshSave*` 覆盖保留与清空判定、`catalog_head` / `feature_head` 空头重建、官方 Wiki 恢复、迁移账本不变、序列重新从 1 开始、清档后运行角色就绪，以及存在 `fishing-go` 连接时拒绝执行；CLI 冒烟库 `reset_smoke` 清档后 `fishing` schema 的 91 张表全部保留，玩家表 0 行、`item_definitions` 146 行、官方指南 13 条、`catalog_head` 与 `feature_head` 各 1 行、`public.fishing_schema_migrations` 仍为 34 条；`tests/linux-deploy.test.py` 20/20 通过。以上均针对合成数据，未连接也未修改正式服数据库。

已知既存问题（与本次改动无关）：`npm run wiki:check` 在 HEAD 上即失败——VERSIONS.md 中 v0.16.0 一行的摘要含半角竖线，`tools/wiki/check.js` 的严格正则读不到该行，而 `sync-versions.js` 能读到，因此核对时报「versions.json 与 VERSIONS.md 不同步」；同时 frontend/wiki/content/content.json 里 voyage-and-set-growth 的 kind/status 身份字段不符合该检查期望。

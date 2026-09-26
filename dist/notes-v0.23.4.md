v0.23.4 · 工坊装备成长的组件选择卡片

- 工坊「装备成长」的组件选择改成一张卡片，卡片嵌在「强化路径」的框体内：没选组件时点卡片弹出「选择组件」子窗口（搜索 + 部位 / 品质 / 属性 / 强化等级 / 状态筛选 + 结果网格，列表按当前选择高亮），选中后卡片直接显示该配件的名称、等级与词条。
- 点击已选组件的卡片即取消当前选中的组件：强化路径回到「尚未选择组件」，详情区保留一句说明与「选择组件」按钮，可再次打开子窗口换一件。子窗口沿用全站子窗口结构：点遮罩、✕ 或 Esc 关闭，Tab 在窗口内循环焦点，筛选可一键重置。
- 组件选择不再预选第一件配件，也不再把搜索与筛选铺在页面上：未选组件时不渲染材料强化、副属性调校、精工锻造与成长转移，改为提示先选组件；「旧制转换」仍是卡片内的多选列表，批量勾选不适合收进子窗口。
- 顺带修复 `tests/mail-gear.test.js`：改为按新的选择流程操作（点卡片 → 选配件），浏览器路径改为优先 `CHROME_PATH` / Chrome 候选而非硬编码 `msedge.exe`，并补一件非奖励绑定配件，使「仅使用普通物品」的请求断言恢复可验证、该套件重新通过。

验收：前端 14 个套件 889 项断言全部通过（run-all，含 workshop-market-regression、smelt-workbench、mobile-layout、desktop-zoom、expedition）；另跑 gear-conversion 1 项、expedition-growth 5 项、equipment-filters 10 项、mail-gear 1 项通过；另用 15 项脚本覆盖空卡片、子窗口筛选与重置、取消选中、配装占用配件、Esc 关闭与旧制页签；1440px / 1180px / 390px 三种宽度复核（空态 / 子窗口 / 已选态）无横向溢出。Go catalog 与 chest / mall / native / workshop 四份规则 fixtures 已按 frontend/js/data.js 重新生成并通过 --check 一致性校验（本机无 Go 工具链，go test ./... 由 CI 执行）。

已知既存问题（与本次改动无关）：`npm run wiki:check` 在 HEAD 上即失败——VERSIONS.md 中 v0.16.0 一行的摘要含半角竖线，`tools/wiki/check.js` 的严格正则读不到该行，而 `sync-versions.js` 能读到，因此核对时报「versions.json 与 VERSIONS.md 不同步」；同时 frontend/wiki/content/content.json 里 voyage-and-set-growth 的 kind/status 身份字段不符合该检查期望。

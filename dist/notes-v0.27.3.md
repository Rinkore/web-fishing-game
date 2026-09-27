v0.27.3 · 港湾像素组件覆盖像素基础样式

- 修复 v0.27.2 港湾像素组件被 `frontend/css/pixel.css` 盖掉：pixel.css 对全局 `button` 施加了带 `!important` 的 `border` / `border-radius` / `box-shadow` / `filter` / `transition`，港湾组件原有的 3px 描边、零圆角与按压反馈被覆盖成圆角 + 蓝色描边 + 亮度滤镜。`frontend/css/harbor.css` 现在用同优先级的 `!important` 逐项覆盖导航按钮、出海按钮、返回 / 关闭、页签与迷你按钮，恢复 3px 描边、零圆角、按压位移 + 硬阴影。
- 交互状态改用 `:not(:disabled)`：hover 不再对禁用按钮生效，active 的位移与阴影只作用于可用按钮；`filter: none` 显式清掉 pixel.css 的亮度滤镜。
- 设置分组 `.sgrp` 系列选择器收敛到 `#settings-dialog .sgrp, .h-pbody .sgrp`，不再影响设置弹窗以外的同名结构。
- 吐司：`body.harbor-on #toast` 覆盖 pixel.css 的边框并去掉圆角；默认隐藏与 `.show` 淡出动画（`h-toast-fade`）改在 harbor.css 内定义，不再依赖其它样式文件。
- 手机：≤640px 时时间牌 `.h-tlabel` 收起，只留图标，避免文字撑开底部 HUD。
- 版本号升至 v0.27.3：前端 `data.js`、内嵌 Go catalog 与 `?v=` 缓存参数同源，客户端在版本比对后自动强制刷新，不必手动清缓存。

验收：仅前端样式（`frontend/css/harbor.css`）与版本号改动，服务端只随发布同步版本号与规则/测试夹具版本。本次按操作要求不重复跑测试，仅做构建、部署器自带校验与公网探针。

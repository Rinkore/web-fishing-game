v0.27.8 · 登录按钮无响应修复 / 图鉴卡片类名修复

- 「点击登录没有反应」的根因是 `frontend/js/ui.js` 在**解析期**就失败了：v0.27.7 重构告示板时，图鉴段重复声明了文件顶部已有的模块级变量 `let codexCategory` 与 `let codexSortRarity`，同一作用域重复 `let` 是语法错误，浏览器直接放弃执行整个 `ui.js`。`window.UI` 因此始终是 `undefined`，`index.html` 的 `window.UI.init()` 抛 `Cannot read properties of undefined (reading 'init')`，`wireAuth()` 从未执行 —— `#auth-submit` 没有任何点击处理器，登录按钮（连同登录 / 注册页签切换）完全无响应。删除两处重复声明后恢复，`node --check` 通过。
- 同一提交里还有第二处被掩盖的语法错误：图鉴卡片模板 `'<div class="cx-name" + (rec ? '' : ' un') + '">'` 少了一个引号（解析器只报第一个错误，所以 v0.27.7 构建时没有暴露）。已修正为 `'<div class="cx-name' + (rec ? '' : ' un') + '">'`，未解锁卡片的 `cx-name un` 类名与「未解锁」样式恢复。
- 顺带加固登录卡：`#auth-form` 是真实表单、提交按钮是 `type=submit`，此前没有 `onsubmit` 拦截，点击或回车会在发出登录请求的同时带着查询串重载页面，把「登录中…」提示和随后的 `startGame()` 一起冲掉（表现为登录「没反应」，或登录成功后仍停在登录页）。现在 `wireAuth()` 里补 `$('auth-form').onsubmit = function (e) { e.preventDefault(); }`，请求仍走原有的 `onclick` / `keydown` 处理器，不重复绑定。
- 版本号升至 v0.27.8：前端 `data.js` 的 `VERSION`、`index.html` / `admin.html` 的 `?v=` 缓存参数、内嵌 Go catalog 的 `version` 与 `constants.VERSION` 同源（catalog.json 只改这两处，已复核的 gearmerge 快照与 `sourceSHA256` 保持不动）；四个规则 oracle 由 `tools/go-rewrite/{chest,mall,native-rules,workshop}-fixture.js --write` 随版本号重新生成。

验收：本地用 `node --check` 校验全部前端脚本，并在 Chrome 无头 + 桩接口下跑通「填账号密码 → 点登录 → POST /api/login → 登录卡收起 → 进入游戏」，同时确认图鉴页签渲染正常、无页面错误；按操作要求不跑整轮测试。

发布走本地：`output/build-linux-local.ps1` 构建、公钥 `scp -O` 上传、服务器固定入口 `fishing-release-deploy` 部署，再做公网探针；不走 GitHub Action。

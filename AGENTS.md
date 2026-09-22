# 钓鱼项目 · 工作规则

> **通用纪律**（会话切分 / 读取 / 命令输出 / 截图 / 输出 / 落盘 / 密钥）见用户级 `~/.zcode/AGENTS.md`，对所有项目生效。本文件只写本项目专属内容。

## 项目速查

- 结构：`server-go/`（唯一游戏后端）、`frontend/js/`（浏览器页面逻辑：`ui.js`、`admin.js`）、`tests/`（前端浏览器回归 + Go 侧检查工具）、`tools/`（构建/迁移/贴图工具）、`dist/`（打包产物）、`tests/shots/`（测试截图）。旧 Node 后端已在 `c9a4671` 之后的 Go 切换提交中删除，只在 Git 历史里可查。
- **禁整读**：`frontend/js/ui.js`、`frontend/js/admin.js`、`README.md`（47KB）。一律 `grep` 定位行号 + 带 `offset`/`limit` 读片段。
- **禁读目录**：`dist/`、`tests/shots/`、`node_modules/`、`*.zip`。
- 测试：后端一律 `go -C server-go test -count=1 ./...`（集成用例需 `FISHING_GO_TEST_DATABASE_URL`，未设置时静默 skip，不算通过）；前端浏览器回归用 `node tests/run-all.js`（8 套件，`FISHING_TEST_ONLY=settings` 单跑，需要 Chrome + `playwright-core`）。其余检查：`npm run go:build`、`npm run go:vet`、`npm run go:coverage`、`npm run go:coverage:test`。输出一律 `| tail -40`，只看失败明细。
- 普通代码工作流：跑测试 → 关闭本次测试服务 → push main。Linux 发版按下节执行；不要把 Windows 开发工作树或历史 Windows 包当作线上部署形态。
- 发版：打包配方 `dist/make-zip.ps1`（改首行 `$ver` 复用；脚本已去掉文件名里的版本戳）。打包时用本机 Go 工具链编译 `server-go/cmd/game` 为包内 `game.exe`，不再随包分发 Node 运行时；发布文案写 `dist/notes-vXXX.md`（会作为 GitHub Release 正文上传）。包内 `使用说明.txt` 由脚本生成，版本号引用 `$ver` 自动跟随。
- **发布 Release 用 `dist/release.ps1`（唯一入口，别再手敲命令/名称）**：`powershell -File dist/release.ps1 -Version v0.11.9`（名称 + 正文 + 换资产；`-NameOnly` 只改名、`-SkipAsset` 不动资产）。脚本为纯 ASCII（中文一律运行时从 notes 文件读），token 从 `git remote` URL 里的凭据取，也可 `-Token`。
- **Release 名称规则（v0.9.11–v0.11.7 的既定格式，勿再改）**：`vX.Y.Z · 话题甲 / 话题乙 / 话题丙`——**必须以版本号开头**，绝不带站点名前缀（v0.11.8/0.11.9 曾误写成「钓鱼网站 v0.11.9 · 甲 · 乙」，已 PATCH 修回）；话题分隔统一 ` / `，版本号后面那一个仍用 ` · `。名称由 `notes` 文件首行现算（截掉首个 `vX.Y.Z` 之前的内容），所以**首行就是唯一真源**，改名称＝改 notes 首行。
- 版本号不跳号。小修并入当前版本＝移 tag（`git tag -f -a`）+ 重建 zip + 换 Release 资产（正文/文案同步补一行）。

## Linux 自动发版

- 用户说「发版」「发布新版本」时，表示启动已配置的发布链：审阅并提交本次版本改动 → 同步版本号及 `dist/notes-vX.Y.Z.md` → 推送 main 和 tag → 跟踪 Actions → 核验部署结果。无需为同一条已授权发布链重复询问是否 push、创建 Release 或更新已配置实例；用户限定「只推代码」「不部署」时遵循限定。
- 当前自动部署目标是 Linux Go **测试实例**：`rinkore@ipv4.rinkore.com:22`、`/opt/fishing-go-test`、systemd `fishing-go-test`、公网 `https://ipv4.rinkore.com:19000`。旧正式服 `9000/9001` 不属于此自动化目标。
- 使用 `pwsh -File tools/release/start-release.ps1 -Publish` 启动；默认从 `frontend/js/data.js` 取版本。仅预检时不加 `-Publish`。同版本修订加 `-SameVersionRevision`，通过原子 push 和精确 tag lease 更新，禁止无保护强推。该脚本不自动提交脏目录；不要混入其他任务未完成的改动。
- `.github/workflows/release.yml` 在 tag 后执行完整 Go CI、真实 PostgreSQL 集成测试、Linux 打包、调用唯一 Release 入口 `dist/release.ps1 -LinuxManifest ...`，然后部署。配置本身的 main push 不发版、不重启服务器。重跑相同 tag 用该 workflow 的 `workflow_dispatch`，版本输入必须是已存在 tag。
- 普通应用升级自动执行；SQL 迁移摘要变化在停服前阻断，按 `docs/CICD.md` 完成升级/恢复演练后处理，不能改摘要绕过。失败回滚仅回滚程序，不回退玩家数据。
- 发布结果分别报告 push、Release、服务器部署状态和提交 SHA；CI 或部署未完成不得宣称上线。服务器一次性接入和配置详见 `docs/CICD.md`。

## dist 保留策略（已定，勿再清理）

`dist/` 只保留：最新一版构建（目录 + zip）、`notes-v*.md`（发布文案，唯一副本）、一个打包脚本、**一个通用发布脚本 `release.ps1`**、`node-runtime/`（历史母本，Go 包已不再使用）。历史版本目录、旧 zip、一次性脚本（patch / shot / update-release / 带版本戳的 release 与 upload 脚本）均已清理，**不要再重新堆积**——发版一律复用 `release.ps1`，不要再写 `release-vXXX.ps1`。

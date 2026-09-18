# 钓鱼项目 · 工作规则

> **通用纪律**（会话切分 / 读取 / 命令输出 / 截图 / 输出 / 落盘 / 密钥）见用户级 `~/.zcode/AGENTS.md`，对所有项目生效。本文件只写本项目专属内容。

## 项目速查

- 结构：`backend/server.js`（服务端权威，约 350KB）、`frontend/js/`（页面逻辑：`ui.js` 约 470KB、`admin.js` 约 260KB）、`tests/`（35 套件）、`tools/`（贴图生成器）、`dist/`（打包产物）、`tests/shots/`（测试截图）。
- **禁整读**：`frontend/js/ui.js`、`backend/server.js`、`frontend/js/admin.js`、`README.md`（47KB）。一律 `grep` 定位行号 + 带 `offset`/`limit` 读片段。
- **禁读目录**：`dist/`、`tests/shots/`、`node_modules/`、`*.zip`。
- 测试：`node tests/run-all.js`（约 120 秒，**17 套件**）；单套件 `FISHING_TEST_ONLY=e2e`；输出一律 `| tail -40`，只看失败明细。**基线本来就是红的**（v0.13.9：通过 **1771 项 / 失败 47 项**；失败只有 e2e 13 / ui-layout 27 / fishing-interaction 5 / auth-ui 2，其余 13 套件全绿）——`ui-layout` 的失败数**随机器负载浮动**（17 套件并行约 27 项，单跑约 10 项），且在「在线交易」段会级联中断，文件尾部的市集部位筛选 / 钓竿自动配装两段根本不执行，**所以新增浏览器回归别塞进 ui-layout，另开套件**（本版回归在 `tests/v0139.test.js`（纯 HTTP）与 `tests/v0139-ui.test.js`（浏览器），上一版在 `tests/v0138*.test.js`）。改完要 A/B 对比**套件级失败数**，别把既有失败当成自己改坏的。
- 工作流：跑测试 → 关服务 → push main（不主动重启正式服）。
- 发版：打包配方 `dist/make-zip.ps1`（改首行 `$ver` 复用；脚本已去掉文件名里的版本戳），内置 Node 运行时母本在 `dist/node-runtime/node.exe`，发布文案写 `dist/notes-vXXX.md`（会作为 GitHub Release 正文上传）。包内 `使用说明.txt` 由脚本生成，版本号引用 `$ver` 自动跟随。
- **发布 Release 用 `dist/release.ps1`（唯一入口，别再手敲命令/名称）**：`powershell -File dist/release.ps1 -Version v0.11.9`（名称 + 正文 + 换资产；`-NameOnly` 只改名、`-SkipAsset` 不动资产）。脚本为纯 ASCII（中文一律运行时从 notes 文件读），token 从 `git remote` URL 里的凭据取，也可 `-Token`。
- **Release 名称规则（v0.9.11–v0.11.7 的既定格式，勿再改）**：`vX.Y.Z · 话题甲 / 话题乙 / 话题丙`——**必须以版本号开头**，绝不带站点名前缀（v0.11.8/0.11.9 曾误写成「钓鱼网站 v0.11.9 · 甲 · 乙」，已 PATCH 修回）；话题分隔统一 ` / `，版本号后面那一个仍用 ` · `。名称由 `notes` 文件首行现算（截掉首个 `vX.Y.Z` 之前的内容），所以**首行就是唯一真源**，改名称＝改 notes 首行。
- 版本号不跳号。小修并入当前版本＝移 tag（`git tag -f -a`）+ 重建 zip + 换 Release 资产（正文/文案同步补一行）。

## dist 保留策略（已定，勿再清理）

`dist/` 只保留：最新一版构建（目录 + zip）、`notes-v*.md`（发布文案，唯一副本）、一个打包脚本、**一个通用发布脚本 `release.ps1`**、`node-runtime/`。历史版本目录、旧 zip、一次性脚本（patch / shot / update-release / 带版本戳的 release 与 upload 脚本）均已清理，**不要再重新堆积**——发版一律复用 `release.ps1`，不要再写 `release-vXXX.ps1`。

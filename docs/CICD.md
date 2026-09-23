# Linux 自动发版

目标是当前 Go 测试实例 `https://ipv4.rinkore.com:19000`，systemd 服务 `fishing-go-test`，发行根目录 `/opt/fishing-go-test`。继续使用现有 Caddy、Nginx、PostgreSQL 和 `/etc/fishing-go-test/runtime.env`。本流程不会把旧正式服 9000/9001 切换成 Go，也不要求迁移到 Docker。

## 日常使用

对仓库助手说「发版」即可启动配置好的流程；给定版本时说「发版 v0.21.5」，已有版本的小修说「同版本发版」。助手准备并审阅版本与发布说明、提交本次改动，调用入口并跟踪 Actions 结果。发布说明首行继续使用 `vX.Y.Z · 话题甲 / 话题乙`，它是 Release 名称的唯一来源。

```powershell
# 预检：检查版本/文案、干净 main、远端进度；不推送
pwsh -File tools/release/start-release.ps1
# 发版：原子推送 main + annotated tag，随后 GitHub 执行发布和部署
pwsh -File tools/release/start-release.ps1 -Publish
# 有意替换最新版本的修订：要求新提交、同版本发布说明已更新
pwsh -File tools/release/start-release.ps1 -SameVersionRevision -Publish
```

发版入口不会自行修改版本号或提交工作区；版本、文案和要发布的源码必须在同一提交。旧版本 tag 不允许重写，最新版本修订使用精确 `--force-with-lease`，main 和 tag 在同一次原子 push 内完成。远端有新 main 时先整合并验证，不能覆盖其他任务的改动。

已经指向相同提交的 tag 不会产生新 push 事件。要重试，在 GitHub Actions 的 **Linux release and deploy → Run workflow** 中填写该 tag；无需造新版本或移动标签。

## 流水线

1. 校验 tag、前端版本、发布说明以及提交属于 main。
2. 调用现有 Go CI：生成内容、格式、编译、vet、单元测试、Linux race、独立 PostgreSQL 集成测试，加上发布工具的隔离回归。测试失败不创建 Release、不更新实例。
3. 从被测试的提交编译 Linux amd64 的 `game`、`migrate`、`catalog`、`admin`，附带同提交前端和许可文本，生成归档与 SHA-256 清单。
4. 通过 `dist/release.ps1` 上传 `web-fishing-game-linux-amd64.tar.gz` 和 `linux-release.json`，创建/更新 GitHub Release。
5. `linux-go` 部署 job 下载刚发布的资产，核对提交、版本、迁移集合与包摘要，使用专用 SSH 密钥上传，再调用服务器上预先安装的固定部署入口。
6. 更新器校验归档与当前 schema 基线，优雅停止旧进程、原子切换 `current`、启动并检查本机与公网探针、版本和前端字节摘要；失败恢复原程序并再次检查。

`Check Linux deployment setup` 是单独的手动诊断工作流，验证 GitHub Runner 的 SSH、受限 sudo 和当前服务健康，不上传发行包、不重启服务。初次配置后可用它验证整条连接。应用版本接口与 SSE 更新通知使用随程序构建的发行版本，避免数据库里旧的运营 catalog 版本阻止新程序通过检查；该修正不改运营配置。

工作流默认没有每次人工审批；若仓库管理员后来为 `linux-go` Environment 添加 Required reviewers，则 GitHub 会等待该审批。GitHub Release 由同一流水线完成后直接进入部署 job，不依赖 `GITHUB_TOKEN` 再触发另一个 release 事件。

## 一次性服务器接入

仓库所需设置如下。私钥作为 Actions Secret 加密保存，不提交到仓库；SSH 主机密钥必须来自已验证的连接，不使用关闭校验的 SSH 选项。

| 类型 | 名称 | 值或用途 |
| --- | --- | --- |
| Secret | `SSH_HOST` | `ipv4.rinkore.com` |
| Secret | `SSH_PORT` | `22` |
| Secret | `SSH_USER` | 专用账号 `fishing-deploy` |
| Secret | `SSH_KEY` | 专用 ed25519 私钥 |
| Secret | `SSH_KNOWN_HOSTS` | 已验证的服务器 SSH host keys |
| Variable | `DEPLOY_PATH` | `/opt/fishing-go-test` |

以当前管理账号 `rinkore` 上传 `deploy/linux/{install.sh,deploy.sh,deploy.py}` 和专用公钥，然后由服务器管理员执行一次 `install.sh`。具体参数、基线校验及权限说明见 [Linux 更新器](../deploy/linux/README.md)。安装不重启游戏；它创建部署账号、root 所有的执行器与配置，仅允许固定 sudo 更新入口。部署用户可写 `incoming/`，不能改运行配置、版本目录或系统服务文件。

安装器需要经核对的当前提交和 SQL 迁移摘要；当前旧发行记录为 `bd62bc6bd92cd07ae9b5d59c0ae38bd21de0625a`。源码摘要必须从该提交计算，并再次核对实际 `current/SOURCE_COMMIT`，不能拿后来分支的摘要直接覆盖。

## 数据库变更和故障处理

相同 schema 的程序更新自动执行。SQL 迁移摘要发生变化时，更新器在停服前终止：先在隔离环境完成升级、权限、备份恢复和回退边界演练，再安排显式维护步骤。运行用户不获得迁移权限，自动部署不执行 `migrate up` 或 `catalog defaults`，不把数据库恢复当作程序回滚。

发布前后的健康检查只读，不代替玩法验收。首次启用后的升级与回滚演练应使用隔离实例/合成数据；部署成功只说明包切换与探针通过，不能把它写成全部玩法测试通过。

检查 [Actions](https://github.com/Rinkore/web-fishing-game/actions/workflows/release.yml) 的 `source`、`test`、`publish`、`deploy` 状态。`publish` 成功但 `deploy` 失败，表示下载包已经发布，服务器更新未完成；查看部署日志是否成功回滚、是否提示需要操作员处理。正常代码 push、CI 配置提交都不会自动触发一次发版。

## 2026-09-23 测试服维护基线

v0.21.5（`4dafdcfcac70f51845ccb5f3c9e39990e9b4cbc2`）已在隔离升级、权限和备份恢复演练后完成显式维护。数据库包含 30 个迁移文件，摘要为 `03c94096882c6d68770b3227aa56bc4753d4e4df75d2cb6c03496c2d4ebb6226`。这是实际迁移后随新发行记录建立的基线，不能写入旧程序的 manifest。备份路径与验收证据见 [远航实现与部署记录](远航本地实现说明.md#最终部署验收)。

独立 Nginx 服务 `fishing-go-test-web` 的 `Requires=fishing-go-test.service` 会在后端停止时连带停止网页代理。测试服已补两份 systemd drop-in：

- `/etc/systemd/system/fishing-go-test.service.d/web-start.conf`：`[Unit]` 下添加 `Wants=fishing-go-test-web.service`，保证现有更新器先 stop 后 start 时能拉起代理。
- `/etc/systemd/system/fishing-go-test-web.service.d/game-restart.conf`：`[Unit]` 下添加 `PartOf=fishing-go-test.service`，使显式 restart 同步传播。

已执行 daemon-reload，并实际 stop/start 后端，验证两个服务 active、本机及公网探针、版本和前端摘要正常。此配置只针对 19000 测试实例，不应启动系统级 nginx 或改动旧正式服代理。

# 现有 Linux 服务自动更新

这套更新器面向正式 Go 实例：`/opt/fishing-go/current` → `releases/...`，systemd 服务 `fishing-go`，Go 回环端口 `9001`，公网 `https://ipv4.rinkore.com:9000`。沿用 Caddy → Nginx（回环 9002）→ Go 链路、`/etc/fishing-go/runtime.env` 和现有 PostgreSQL 数据与密钥。

发布工作流上传两份文件到 `incoming/<完整提交 SHA>/`：`linux-release.json` 和 `web-fishing-game-linux-amd64.tar.gz`，再调用唯一授权的入口：

```bash
sudo -n /usr/local/sbin/fishing-release-deploy /opt/fishing-go/incoming/COMMIT/linux-release.json
```

只检查安装、受限 sudo、当前本机与公网健康时执行 `sudo -n /usr/local/sbin/fishing-release-deploy --check`。这个模式不上传、不切换版本、不停止或重启服务；GitHub 的 `Check Linux deployment setup` 通过同一路径验证 Runner 到服务器的连接。

manifest 字段为 `version`、`sourceCommit`、`migrationsSha256`、`asset`、`sha256`。更新器先把上传文件复制到 root 私有临时目录并校验 SHA-256，拒绝路径穿越、链接、设备文件、重复条目和异常大包，核对包内版本/提交/SQL 摘要及前端版本。通过后用 systemd 优雅停服，原子切换 `current`，启动同一个服务，再检查本机与公网 readiness、公网版本和前端文件 SHA-256；失败则恢复原 `current` 并检查旧服务。

网页代理服务 `fishing-go-web` 通过 `Requires` 依赖游戏服务；停止游戏时代理也会停止。更新与回滚均按游戏、网页代理的顺序启动，并检查两个服务及公网探针。配置中的 `webService` 默认是 `fishing-go-web`；旧测试实例须先执行正式化切换。

## 正式化切换

`promote.py` 是本次已核实 Linux 测试实例的一次性管理入口，必须由 root 执行，且同目录必须放置本版本 `deploy.py`。它检查 9000/9001/9002 空闲、锁定部署、在 `/var/backups/fishing-promotion-*` 备份配置，随后优雅停止 Go，迁移应用与配置目录、修正 current 链接、创建正式 systemd 单元，并切换 Nginx/Caddy 和健康探针。失败时恢复目录、配置和原服务并检查旧入口。不会执行 SQL 或修改数据库身份，内部 OS 用户和 PostgreSQL 名称保持原值，避免更名破坏所有权与连接。Cookie 命名空间改为 `go`，玩家需要重新登录。

停服前脚本临时增开 HTTPS 9000 并沿用旧上游，验证公网转发后恢复 Caddy；此探针失败则不会停 Go。路由器应将公网 TCP 9000 转发至实际 Go 主机的 9000；9001/9002 仅回环监听。

切换成功后将 GitHub 仓库变量（或 `linux-go` 环境覆盖值）`DEPLOY_PATH` 更新为 `/opt/fishing-go`，同步发布本仓库的诊断工作流。正式端口：HTTPS 9000，回环 Go 9001，回环 Nginx 9002；旧 19000/19001/19002 停止监听。旧 systemd 单元禁用并保留用于恢复。

更新器以本机文件锁串行执行；拒绝低于当前版本的排队发布，同版本、不同提交可用于已约定的热修。相同版本与提交但内容不同的包会被拒绝，应从新提交重新构建。旧发行目录不会自动清理，失败包会保留供复核，重试前需管理员检查同名发行目录。

## 一次性接入

这一节需要服务器管理员执行一次。安装脚本创建受限部署账号和固定 sudo 入口，但不停止/重启服务，也不执行任何数据库操作。服务器需 Bash、Python 3、systemd、sudo/visudo 和基础账户工具。

1. 为 GitHub Actions 单独生成 ed25519 SSH 密钥。私钥只放仓库 `linux-go` 环境的 `SSH_KEY` secret；安装时只使用公钥 `.pub` 文件。不要复用个人管理密钥。完整工作流设置见 [Linux 自动发版](../../docs/CICD.md)。
2. 把本目录的 `install.sh`、`deploy.sh`、`deploy.py` 放入服务器临时目录，核对内容。确认当前 `SOURCE_COMMIT` 对应的 Git SQL 迁移集合，把该提交的 SQL 文件导出到隔离目录，用 `node tools/release/migration-hash.js /path/to/exported/migrations` 得到基线摘要。不能根据“当前分支大概相同”随意填摘要。
3. 在服务器以管理员执行下面的安装命令。`BASELINE_COMMIT` 必须精确匹配当前发行 `SOURCE_COMMIT` 或 `SOURCE_COMMIT.txt`；安装器会校验服务路径、当前发行和版本，并拒绝覆盖不同的已记录基线。

```bash
sudo bash /tmp/fishing-release/install.sh BASELINE_COMMIT BASELINE_MIGRATIONS_SHA256 /tmp/fishing-release/github-deploy.pub
```

4. 安装后，`fishing-deploy` 只能写 `incoming/`，root 拥有执行器、配置、版本目录和 authorized_keys。SSH 公钥带 `restrict`（禁 PTY/转发）；部署用户没有任意 sudo 权限。可用新账号测试 SSH 连接和目录上传，不要用试运行发布去验证权限。
5. 在 GitHub 按 [Linux 自动发版](../../docs/CICD.md) 配置 `linux-go` 环境的主机、端口、路径、known_hosts 与密钥。首次启用 CD 前复核目标是 9000 上的正式 Go 实例，`DEPLOY_PATH=/opt/fishing-go`。推送代码或创建 Release 不等于服务器已更新；以 workflow 部署 job 和检查结果为准。

当前已核实的旧发行基线为 `bd62bc6bd92cd07ae9b5d59c0ae38bd21de0625a`。其迁移文件与本轮接入时的 main 一致，安装前仍需确认服务器未被其他任务更新。旧发行无完整 release manifest，安装器只记录经管理员核对的迁移摘要；其历史包摘要用全零占位，不会作为新包的校验值。

## 更新器升级

发行包成员与更新器白名单是同一套契约：`deploy.py` 逐条校验归档成员，新增或改名成员（例如 v0.23.4 加入的 `bin/reset`）时必须同步刷新服务器上的更新器。刷新前的旧更新器会拒绝整包，并以 `Unexpected release archive member.` 结束；此时不停服、不切换 `current`，线上继续运行旧版本，修好再重跑即可。

`deploy.sh` 未变时只需替换 root 所有的执行模块：

```bash
sudo install -o root -g root -m 0644 deploy.py /usr/local/lib/fishing-release/deploy.py
grep -n 'bin/reset' /usr/local/lib/fishing-release/deploy.py   # 确认新成员已进入白名单
sudo -n /usr/local/sbin/fishing-release-deploy --check          # 只读：安装、受限 sudo 与健康检查
```

这一步只能由管理员执行：发布账号仅有固定更新入口的受限 sudo，流水线无法自行刷新更新器，因此它只能报告失败而不能绕过白名单。刷新后不必重推代码，在 Actions 的 **Linux release and deploy → Run workflow** 用同一个 tag 勾选 `reuse_release` 重跑部署即可。

## 数据库与恢复边界

**SQL 迁移摘要不同会在停服之前拒绝自动部署。** 当前 Go 服务要求 schema 与全部内嵌迁移精确一致，因此不自动执行 `migrate up`、`catalog defaults`、数据库备份恢复或 schema 回滚。普通相同 schema 的应用更新不修改数据库结构，失败时可切回旧程序；已有数据库定时备份继续照常运行。

新增迁移的版本仍可自动构建和发布，但部署需要先在隔离库完成升级、权限、备份恢复演练，再按维护窗口执行迁移并显式接入新的已验证基线。不要为绕过阻断而直接改摘要。

需要把正式服恢复成全新存档（清空玩家数据、保留字段与权限）时，用发行包内的 `bin/reset fresh` 只读预演、`bin/reset fresh --confirm` 实际执行；范围、判定与停服顺序见 [全新存档说明](../../docs/go-rewrite/FRESH_SAVE.md)。它不做备份也不替代上面的回滚流程，清档前必须先有可恢复的备份。

进程被 SIGKILL、断电或磁盘失效无法由脚本捕获；管理员需要检查 `current` 指向及 `systemctl status fishing-go`。正常命令失败、SIGTERM、SIGHUP 和 SIGINT 会触发回滚；回滚也失败时脚本非零退出并要求人工处理。健康检查是只读检查，未替代登录、钓鱼、交易等业务验收。失败发行目录保留，自动重跑会拒绝覆盖同名目录；管理员须先核对 `current` 已恢复、检查失败原因与该目录，再处理重试。

手动恢复应用时先确认 schema 未变化，然后停止 `fishing-go`，把 `current` 原子切回明确选定的旧发行，再启动并检查公网地址。不要删除或恢复 PostgreSQL 数据来“尝试”修复应用发布失败。

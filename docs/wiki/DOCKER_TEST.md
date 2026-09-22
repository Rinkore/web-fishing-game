# Wiki 本地 Docker 测试环境

这个环境用于上线前在本地隔离验证：

- Wiki 静态页面
- 官方攻略热更新
- 用户注册 / 登录
- 用户攻略投稿
- 我的攻略
- 管理员审核
- 数据持久化
- 重启后数据不丢失

它不是生产环境，不启用 HTTPS，只绑定本机回环地址。游戏与 Wiki 由同一个 Go 进程提供，
数据写入 compose 内的隔离 PostgreSQL 卷（`web-fishing-wiki-test-postgres`）。

## 1. 启动

要求：

- Docker Desktop 已启动
- 当前分支为 `wiki`
- 工作区代码已保存

推荐使用脚本：

```powershell
powershell -ExecutionPolicy Bypass -File tools/wiki/docker-test.ps1
```

默认端口：

```text
http://127.0.0.1:19000
```

也可以使用 npm：

```powershell
npm run wiki:docker:up
```

前台运行并查看实时日志：

```powershell
npm run wiki:docker
```

只看日志：

```powershell
npm run wiki:docker:logs
```

## 2. 访问入口

```text
Wiki 首页   http://127.0.0.1:19000/wiki/
攻略页     http://127.0.0.1:19000/wiki/guides/index.html
投稿页     http://127.0.0.1:19000/wiki/guides/submit.html
管理后台   http://127.0.0.1:19000/admin.html
```

快速检查：

```powershell
Invoke-RestMethod http://127.0.0.1:19000/api/version?profile=wiki
Invoke-RestMethod http://127.0.0.1:19000/api/wiki/content
```

## 3. 测试管理员

测试环境仍使用正式的安全模型：管理员由 Go 管理命令初始化，并使用 TOTP 登录。

步骤：

1. 先在浏览器注册一个测试账号，例如 `localadmin`。
2. 先生成 32 字节 base64 MFA 密钥并导出给 compose；容器与初始化命令必须用同一个值：

   ```powershell
   $env:WIKI_TEST_MFA_KEY = '<base64 32 字节密钥>'
   npm run wiki:docker:up
   ```

3. 在该 compose 的容器内执行管理命令，JSON 通过标准输入传入：

   ```powershell
   '{"username":"localadmin","secret":"<TOTP base32 密钥>","otp":"<当前 6 位验证码>"}' |
     docker compose -f docker-compose.wiki-test.yml run --rm --entrypoint /usr/local/bin/admin wiki-test provision
   ```

   完整参数、密钥生成与审计要求见 [server-go/README.md](../../server-go/README.md)。
4. 把上一步的 `secret` 录入 TOTP 验证器（或自行拼 `otpauth://` 链接）。
5. 打开：

   ```text
   http://127.0.0.1:19000/admin.html
   ```

6. 使用测试账号、密码和 6 位动态验证码登录。

如果需要撤销管理员：

```powershell
'{"username":"localadmin"}' |
  docker compose -f docker-compose.wiki-test.yml run --rm --entrypoint /usr/local/bin/admin wiki-test revoke
```

## 4. 推荐上线前手工测试清单

### 4.1 官方攻略热更新

1. 登录管理后台。
2. 进入 `📚 Wiki攻略`。
3. 修改官方攻略 JSON 中任意一篇标题。
4. 点击 `保存并发布`。
5. 打开或刷新攻略页，确认数秒内看到新标题。
6. 点击 `恢复内置`，确认官方内容恢复。
7. 确认用户投稿没有被恢复操作删除。

### 4.2 用户投稿（默认自动通过）

1. 注册或登录普通玩家账号。
2. 打开 `/wiki/guides/index.html`，确认能看到 `📝 贡献攻略` 和 `我的攻略`。
3. 打开 `/wiki/guides/submit.html`，填写标题、分类、摘要、正文段落和标签。
4. 提交后确认跳转到 `我的攻略`，状态为 `已通过（自动）`。
5. 刷新公开攻略页，确认该投稿立即可见并显示作者名；打开攻略详情确认正文按需加载。
6. 在 `我的攻略` 删除该投稿，确认公开页不再显示。

人工审核模式（可选）：设置 `$env:WIKI_TEST_AUTO_APPROVE = '0'` 后执行 `npm run wiki:docker:down` / `npm run wiki:docker:up` 重启容器，compose 会把 `WIKI_GUIDE_AUTO_APPROVE=0` 传给 Go 服务：

1. 普通账号提交攻略 → `我的攻略` 显示 `待审核`。
2. 公开攻略页确认待审核不可见。
3. 管理员后台 `📚 Wiki攻略 → 用户投稿` 通过该投稿。
4. 刷新公开攻略页确认可见；再提交一篇并测试拒绝原因。

### 4.3 人工审核模式的拒绝与删除（`WIKI_TEST_AUTO_APPROVE=0`）

1. 用另一个玩家账号提交一篇攻略。
2. 管理员选择 `拒绝`，填写拒绝原因。
3. 确认公开攻略页不可见。
4. 作者打开 `我的攻略`，确认能看到拒绝原因。
5. 再提交一篇待审核攻略，作者在 `我的攻略` 删除。
6. 管理员后台确认该投稿不再出现在列表。

### 4.4 数据持久化

重启容器：

```powershell
docker compose -f docker-compose.wiki-test.yml restart wiki-test
```

重启后确认：

- 已通过的用户攻略仍在
- 已拒绝的投稿仍对作者可见
- 官方热更新内容仍在
- `/api/wiki/content` 的 revision 正常

## 5. 数据位置与重置

测试数据保存在 Docker named volume：

```text
web-fishing-wiki-test-postgres
```

停止环境但保留数据：

```powershell
npm run wiki:docker:down
```

彻底删除测试数据并重置：

```powershell
npm run wiki:docker:reset
```

脚本方式：

```powershell
powershell -ExecutionPolicy Bypass -File tools/wiki/docker-test.ps1 -Reset
```

注意：

- Wiki 内容与玩家数据统一存储在 named volume 的 PostgreSQL 数据目录里，容器启动时先跑 `cmd/migrate`。
- 旧版 `wiki.json` / `wiki-guides.json` 与旧 JSON 存档不在 Go 启动路径里，也不会被自动读取。
- 官方内容未保存前，服务端使用编译进二进制的 `frontend/wiki/content/content.json` 快照。
- 公开读取：`/api/wiki/content` 只返回攻略元数据，正文走 `/api/wiki/guides/<id>`，列表分页/搜索走 `/api/wiki/guides`。

## 6. 隔离与安全

Compose 配置做了以下限制：

- 只绑定 `127.0.0.1`，局域网无法访问
- 容器 root filesystem 为只读
- 应用容器只写 `/tmp`，数据全部落在隔离的 PostgreSQL 卷里
- 删除所有 Linux capabilities
- 禁止提权
- 使用 named volume 隔离测试数据
- 健康检查直接探测容器内的 `127.0.0.1:9000`

## 7. 自定义端口与镜像源

自定义端口：

```powershell
$env:WIKI_TEST_PORT = 19100
npm run wiki:docker:up
```

或：

```powershell
powershell -ExecutionPolicy Bypass -File tools/wiki/docker-test.ps1 -Port 19100
```

默认镜像来自项目内置的 `docker/wiki-test/Dockerfile`（多阶段构建 Go 二进制，运行层为 `debian:bookworm-slim`），
数据库镜像为 `postgres:18.6-bookworm`。

如果 Docker Hub 访问受限，可以改用镜像站或本地缓存镜像：

```powershell
$env:WIKI_TEST_POSTGRES_IMAGE = '<your-postgres-image>'
npm run wiki:docker:up
```

`WIKI_TEST_POSTGRES_IMAGE` 必须是 Linux x64 的 PostgreSQL 18 镜像；Go 构建阶段使用 `golang:1.27.1-bookworm`，
可用 `GO_IMAGE` build arg 覆盖。

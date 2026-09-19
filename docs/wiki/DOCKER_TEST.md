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

它不是生产环境，不启用 HTTPS，只绑定本机回环地址。

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
$env:WIKI_TEST_SOURCE_COMMIT = (git rev-parse HEAD).Trim()
npm run wiki:docker:up
```

前台运行并查看实时日志：

```powershell
$env:WIKI_TEST_SOURCE_COMMIT = (git rev-parse HEAD).Trim()
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

测试环境仍使用正式的安全模型：管理员必须通过控制台初始化，并使用 TOTP 登录。

步骤：

1. 先在浏览器注册一个测试账号，例如 `localadmin`。
2. 附着到容器控制台：

   ```powershell
   docker compose -f docker-compose.wiki-test.yml attach wiki-test
   ```

3. 输入：

   ```text
   admin-init localadmin
   ```

4. 控制台会显示 TOTP 密钥和 `otpauth://` 链接。
5. 用验证器扫码或手动录入密钥。
6. 按 Docker 的分离快捷键离开 attach：

   ```text
   Ctrl-P Ctrl-Q
   ```

   attach 结束后容器会继续运行。
7. 打开：

   ```text
   http://127.0.0.1:19000/admin.html
   ```

8. 使用测试账号、密码和 6 位动态验证码登录。

如果需要重新生成管理员 TOTP：

```text
admin-totp localadmin
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

人工审核模式（可选）：设置 `$env:WIKI_TEST_AUTO_APPROVE = '0'` 后执行 `npm run wiki:docker:down` / `npm run wiki:docker:up` 重启容器，compose 会把 `WIKI_GUIDE_AUTO_APPROVE=0` 传进服务端：

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
web-fishing-wiki-test-data
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

- Wiki 内容统一存储在 named volume 里的 `wiki.db`（SQLite，WAL），第一次启动时自动创建。
- 旧版 `wiki.json` / `wiki-guides.json` 只在首次启动迁移时读取，之后保留作备份，不再写入。
- 官方内容未保存前，服务端使用内置 `frontend/wiki/content/content.json` 种子导入 SQLite。
- 公开读取：`/api/wiki/content` 只返回攻略元数据，正文走 `/api/wiki/guides/<id>`，列表分页/搜索走 `/api/wiki/guides`。

## 6. 隔离与安全

Compose 配置做了以下限制：

- 只绑定 `127.0.0.1`，局域网无法访问
- 容器 root filesystem 为只读
- 只有 `/data` 和 `/tmp` 可写
- 删除所有 Linux capabilities
- 禁止提权
- 使用 named volume 隔离测试数据
- 健康检查访问 `/api/version`

## 7. 自定义端口与基础镜像

自定义端口：

```powershell
$env:WIKI_TEST_PORT = 19100
$env:WIKI_TEST_SOURCE_COMMIT = (git rev-parse HEAD).Trim()
npm run wiki:docker:up
```

或：

```powershell
powershell -ExecutionPolicy Bypass -File tools/wiki/docker-test.ps1 -Port 19100
```

默认基础镜像：

```text
node:22-alpine
```

必须 >= Node 22.13（内置 `node:sqlite`）；当前 `node:22-alpine` 为 Node 22.23，已在本地 Docker 验证。

如果 Docker Hub 访问受限，可以使用已有镜像源或本地含 Node 的镜像：

```powershell
$env:WIKI_TEST_NODE_IMAGE = '<your-node-image>'
$env:WIKI_TEST_SOURCE_COMMIT = (git rev-parse HEAD).Trim()
npm run wiki:docker:up
```

`WIKI_TEST_NODE_IMAGE` 必须是 Linux x64 镜像，且 `node` 可执行。

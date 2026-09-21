# 后台纪录删除

`POST /api/admin/records/delete` 和 `POST /api/admin/records/delone` 使用现有管理员会话认证（管理员 realm / MFA 登录）与 `admin_audit`。请求体中的兼容字段 `token` 不参与认证；凭据仍来自 Bearer 或管理员 Cookie。

- `delete` 接收可选 `id`；省略、空串或 null 表示清空全部，非空必须为 catalog 中的鱼种。顶层 JSON null 不合法。返回 `ok/id/removed/records/small/globalMax/last`。
- `delone` 必须传 `id`、`range`（day/week/all）、`kind`（big/small）、`index`（0–9 的整数）和 `who/size/t`。字段格式错误为 400；当前榜单名次不存在或 who/size/t 不匹配为 409，并要求刷新。成功返回 `ok/id/range/kind/label/removed/purge/top`。
- `purge` 可用布尔值或 0/1，默认 false。false 只从所选榜摘除该账号的当前条目，同时隐藏该榜窗口内此账号已有的候选渔获，避免旧低分立即回补；其它榜、纪录头衔与后续新渔获不受影响。true 另按账号身份和尺寸清理同鱼种其它榜与纪录头衔，不会因显示名相同而误删另一账号。

迁移 `0027_record_hides.sql` 新增不可变的 `catch_record_hides`。运行角色需要该表的 **SELECT/INSERT** 和 `catch_record_moderation_guard` 的 **SELECT/UPDATE** 权限；`catch_records` 保持 SELECT/INSERT、不可 UPDATE/DELETE。测试受限角色已同步授权。删除不改变背包、个人图鉴、资产流水或结算；新网关实例从 PostgreSQL 读取相同隐藏结果。

公开 `/api/records`、`/api/records/top` 与管理接口共用查询投影和服务器时区日/周窗口。`record` 隐藏范围独立于历史总榜，所以未勾 purge 的总榜删除不会影响最大/最小头衔。purge 后最大/最小与全场最大从剩余可见账本重新计算：这延续 Go 的账本投影模型，与旧 Node 仅清空缓存头衔有所不同。渔获播报的全场最大查询也排除已隐藏极值；历史渔获动态仍保留。

每次管理操作使用 repeatable-read 事务与共用纪录管理 guard 行更新锁；名次核对、隐藏候选、响应投影、管理员会话复核和审计写入在同一事务内。等待期间其它管理操作已经提交时，数据库序列化冲突映射为 409。审计、查询或隐藏写入失败会全部回滚；提交结果不确定返回 `commit_unknown`。审计 action 为 `records/delete` 或 `records/delone`，包含操作者、鱼种，以及单条删除的原始渔获键、账号、范围、名次、尺寸、时间与 purge。

本次没有新增配置或纪录删除 SSE 广播；玩家下次拉取纪录接口时看到删除结果。未涉及市场、世界/掉落、快照、功能开关或配置 SSE。完整旧前端浏览器 A/B 仍属后续验收。

回归入口：`internal/gateway/legacy_admin_records_test.go` 和 `legacy_catch_push_test.go`，需设置指向隔离 `fishing_test` 引导库的 `FISHING_GO_TEST_DATABASE_URL`，否则集成用例会跳过。

2026-09-22 验证：Go 1.27.1，独立 PostgreSQL 18.6 合成数据库。基线 b514476 的 gateway 通过（59.161s）；变更后定向 9 个测试函数通过（9.645s），Windows `go test -count=1 -timeout=5m ./...` 全部通过（gateway 77.279s），gofmt、`go build ./...`、`go vet ./...` 通过。Linux 容器完成 `go mod verify`、`go vet ./...`，全套 race 中 gateway 达到默认 3 分钟时限，其余包通过；单独以 `go test -race -v -count=1 -timeout=6m ./internal/gateway` 复验通过（185.278s），无数据竞争报告。源码接口清单重新生成后没有差异。未执行正式迁移、浏览器 A/B、push 或部署。

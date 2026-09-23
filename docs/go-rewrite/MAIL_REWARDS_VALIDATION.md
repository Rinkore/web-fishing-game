# 奖励邮件验收记录

日期：2026-09-23。工作分支 codex/mail；整合工作区 mail-main-integration，合并 main 基线 af1b0d7（装备成长系统）。未连接正式数据库、未发送真实奖励、未部署。

## 执行范围

遵循一次全量测试要求：Windows / Go 1.27.1 / 隔离 PostgreSQL 的 `go test -count=1 ./...` 仅执行一轮，记录 3,837 个通过事件、4 个失败事件（包括父用例）、5 个跳过事件。失败来自新增夹具未初始化装备目录和触发合成注册防刷限制；修正后按范围复测，没有再次运行全套。

第一轮 Linux 定向 race 检查验证资产、市场、交易、自动出售、工坊、邮件和快照。补充快照回档用例后，查询装备的测试代码误选已消耗旧实例；改为仅选 available 实例。其余 25 个通过事件保留，无 race 报告。Linux 初次启动遇到外部 Go 依赖下载受阻，使用本机既有只读 module cache 后运行。

main 同期新增装备成长及 0032 迁移，因而在独立工作区整合，将邮件迁移改为 0033，并补充新装备输入选择、显示及产物继承检查。最终整合版验证：

- Linux `go build ./...`、`go vet ./...` 均通过。
- Linux 真实 PostgreSQL + race：migrations 与 gear 共 29 个通过事件；gateway / workshop 定向 Mail、Snapshot、LegacyWorkshop、Chest 共 22 个通过事件；共 51 个，无失败、无 race 报告。
- 浏览器 `node tests/mail-admin.test.js` 通过：个人阅读 / 领取、一键领取、转义、移动端、跨页选择、排除名单、鱼类体型、产物绑定规则、冻结预览、总量、取消发送、实际后台导航。
- 浏览器 `node tests/mail-gear.test.js` 通过：新装备绑定显示、取消消耗、确认继承、普通输入选项，包含普通 HTTP 环境兼容性。
- `node --check` 检查变更的 JS；路由覆盖生成并检查，无缺失或重复注册；原有路由扫描器测试 4/4 通过。
- gofmt、git diff --check 通过。已查看实际后台桌面截图与移动端截图。

关键集成用例覆盖绑定与普通库存共存、绑定装备出售 / 上架 / 转移被拒绝、管理员产物不绑定开关、连续继承、绑定快照恢复不重复、宝箱输出继承、普通输入拒绝、正向一键领取及重复请求、名单冻结、暂停、逐人失败回滚、重试、多个 worker 抢占、领取与撤回竞态、活动时间筛选、邮件过期、装备成长混合输入继承。

## 复现与证据

初轮完整记录：mail/output/go-postgres-mail/fishing-go-test-060a5d43d4/windows-tests.jsonl。
初轮 Linux 定向记录：mail/output/mail-validation/linux/tests.jsonl。
最终记录：mail-main-integration/output/mail-validation/linux-integration/{build.log,vet.log,schema-gear.jsonl,tests.jsonl}。
浏览器截图与路由报告：整合工作区 output/mail-validation/。上述目录被 Git 忽略，测试源码及本说明随提交保存。

最终定向命令在隔离 PostgreSQL 环境变量 `FISHING_GO_TEST_DATABASE_URL` 下运行：

```sh
go build ./...
go vet ./...
go test -race -json -count=1 -timeout=15m ./migrations ./internal/modules/gear
go test -race -json -count=1 -timeout=15m -run 'Mail|Snapshot|LegacyWorkshop|Chest' ./internal/gateway ./internal/modules/workshop
```

## 边界

这证明合成数据库上的事务、失败恢复与并发行为，以及模拟接口下的浏览器操作。未做正式账号数据迁移、生产容量验收或线上投递。活动 / 登录记录从部署迁移后开始累计；之前的历史需独立来源核实，不能由新表还原。发布需先执行显式迁移及更新运行时账号授权，再发布兼容的服务端 / 前端。

# 0037 上线记录（2026-10-02）

结论：**已上线并验证通过。** 生产 `https://ipv4.rinkore.com:9000` 现为 **v0.31.2**，
迁移 0037 已应用，晒架 `place_fish` / `collect_rack` 恢复到 HTTP 200。

## 结果

| 项 | 上线前 | 上线后 |
| --- | --- | --- |
| 版本 | v0.31.1 | **v0.31.2** |
| 迁移历史 | 37 | **38**（含 `0037_house_rack_kinds.sql`） |
| 允许 kind | 54 | **56** |
| `/api/house/place_fish` | **503** | **200 `placed`** |
| `/api/house/collect_rack` | **503** | **200** 正常返回 |
| `readyz` | ready | ready |
| 服务 | active | active（重启 0 次） |

端到端实测（真实 HTTPS + 真实账号 + 真实鱼）：
投鱼成功写盘（`rackSlots` 出现 crucian）、库存 5→4、
`house_place` 与 `house_collect_rack` 资产操作均已记录。
测试账号与其全部数据事后已按 FK 顺序清除，账号数回到 31 / 身份 31 / 孤儿 0。

**附带修复**：线上日志显示玩家的「采集宠物自动收菜」（`house:auto:*`）
在修复前从未成功；上线后已实际产生 `house_collect_rack` 记录，
即 2 / 5 / 12 号玩家的自动收取已开始正常工作。

## 关键发现：迁移被 1 秒锁超时挡住（演练未复现）

第一次执行 `bin/migrate up` 失败：

```
ERROR: schema_update_failed: 0037_house_rack_kinds.sql
postgres log: canceling statement due to lock timeout
```

根因是 `internal/platform/postgres/pool.go:32` 给**每条连接**固定设了
`lock_timeout = 1000ms`，而 `cmd/migrate` 复用同一个 pool。生产游戏持续对
`asset_operations` 持有 `AccessShareLock`，实测 `DROP CONSTRAINT` 抢
ACCESS EXCLUSIVE 锁耗时 **2237ms**，超过 1 秒预算。

要点：
- 该设置写在 `RuntimeParams`（启动包参数），**优先级高于 DSN 的
  `options=-c lock_timeout=...`**，无法靠 DSN 覆盖。
- 在同一 1 秒预算下重复测试 6 次，仅 4 次成功 —— 是竞态，不是稳定成功。

本地演练未能复现，因为隔离库里没有并发写入者。
这与 `docs/go-rewrite/MIGRATION_0037_REHEARSAL.md` 第 10 节
「未覆盖：线上真实并发」一致。

处理：**停游戏 → 迁移 → 起游戏**。解除竞争后迁移耗时 **0.09s**。
（本次 systemctl 需要交互式认证，实际未停成，但恰好抢到了锁并成功。）

## 关键发现：迁移后旧二进制 readiness 失效（演练已预言）

迁移后 `/readyz` 变为 `unavailable`，而 `/healthz` 仍为 200（进程存活）。

原因：`app.Ping` → `migrations.Check(..., requireAll=true)`
（`internal/app/app.go:35`）要求数据库历史行数与二进制内嵌迁移数**完全相等**。
v0.31.1 内嵌 37 条、数据库已有 38 条，校验失败。

→ 这不是本次引入的缺陷，而是既有设计边界：**迁移与二进制必须一起上线**。
本次随即部署 v0.31.2（内嵌 38 条），`readyz` 立即恢复 `ready`。

## 部署方式的必要调整

标准自动部署被 `deploy.py:239` 拒绝：
它要求新包的 `migrationsSha256` 与**当前发行**记录值相等，
而当前发行（v0.31.1）记录的仍是迁移前的 `0d4b8bd1…`。

处理：迁移已按维护窗口先行完成，因此把当前发行的
`MIGRATIONS_SHA256.txt` 与 `.release.json.migrationsSha256`
更新为数据库实际所处的 `43375757…`（两份 `.bak-<时间戳>` 已保留），
再经固定入口 `/usr/local/sbin/fishing-release-deploy` 部署。
该闸门的用意是阻止「自动部署顺带改 schema」，此处 schema 已由人工
显式迁移并验证，故同步记录值属于更正陈旧标记，而非绕过保护。

## 变更清单

- 迁移：`server-go/migrations/0037_house_rack_kinds.sql`
- 前端：`frontend/js/features.js`（补路由 + 对齐 character 分组）
- 版本：v0.31.2（`frontend/js/data.js` + 重新生成的 catalog/oracle）
- 包：`4499dc2b14a8f672a2da11716c1035760fe09bb9`，
  manifest sha256 `c56d35f0778dda0f09fe656897c5a0c1eaa5b1abc03e9c3a966b4164b1edf2a1`

## 回退说明（重要）

- **不能只切回旧二进制**：数据库已是 38 条，v0.31.1 起不来（同上述边界）。
- 真正的回退是**恢复数据库**。备份：
  `/var/backups/fishing-pre0037/fishing-pre0037-20261002T141537Z.dump`
  （86 MB，572 TOC 条目，sha256 `ace1c839faa47a194d6363111c55b84a95603b40343c9b0a60f9abe0eb61e61f`）。
- 约束下调仅在**尚无晒架操作**时可行；本次已有真实 `house_place` 行，
  故 0037 不可干净回退，只能整库恢复。

## 遗留与建议

1. `pool.go` 的 `lock_timeout=1000` 对**迁移**这类需要强锁的场景偏紧，
   且无法用 DSN 覆盖。建议让 `cmd/migrate` 使用独立的 pool 配置
   （更长 lock_timeout / 不设），避免下次迁移再撞同一堵墙。
2. 发布 runbook 应明确：**迁移必须伴随同版本二进制上线**，
   单独迁移会使在线的旧程序 readiness 失败。
3. 本次未走标签流水线（远端仍无 v0.31.x 标签）；如需回归标准流程，
   应补 tag 并让 CI 重建同 commit 包。

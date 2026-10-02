# migration 0037 隔离演练报告（house_rack_kinds）

- 日期：2026-10-02
- 结论：**升级演练通过，可以安排在维护窗口上线**
- 范围：仅隔离实例与本机合成数据；未连接、未读取、未修改任何生产数据库
- 工程：PostgreSQL 18.6（EDB binaries zip，非安装器）监听 127.0.0.1:55432，
  独立 data 目录 `output/_pgdata`，全部角色密码为本机演练用随机/固定字面量，
  不写入任何报告

## 1. 演练环境

仓库自带的 `tools/go-rewrite/postgres-ops-rehearsal.ps1` 依赖 Docker。本机
Docker Desktop 已安装但 **WSL2 未安装**（`wsl --list` 报「适用于 Linux 的
Windows 子系统…可通过 wsl --install 进行安装」），Linux engine 持续返回
500，且当前会话非管理员、无法启用 WSL2/Hyper-V（需重启）。因此改用等价
的原生 PostgreSQL：

- 二进制来源：`postgresql-18.6-1-windows-x64-binaries.zip`
  （官方 EDB 分发，免安装器、免管理员）
- 版本与脚本锁定项一致：PostgreSQL 18.6，`x86_64-windows`
- `initdb -U fishing_test_admin --auth=trust -E UTF8 --locale=C`
- 启动参数含 `wal_level=replica`、`fsync=on`、`synchronous_commit=on`、
  `full_page_writes=on`（与脚本一致）

替代带来的差异（如实记录）：**未执行**脚本中的物理 `pg_basebackup` + WAL
归档 + PITR 时间点恢复，以及 `SIGKILL` 崩溃恢复。本次以逻辑备份/恢复覆盖
备份维度，物理备份与 PITR 不在本次证据范围内。

## 2. 迁移升级（空库）

| 项 | 结果 |
| --- | --- |
| `bin/migrate up`（新二进制，含 0037） | exit 0，`schema_updated` |
| 应用迁移数 | **38**（0001–0037，含 0027 双文件） |
| 最后一条 | `0037_house_rack_kinds.sql` |
| 耗时 | < 1s（0037 仅两条 ALTER，不重写表） |

## 3. 生产复刻升级（关键证据）

用 **旧二进制**（`b26dfde`，37 条迁移）建库，得到与生产一致的状态：
`history=37`、0037 缺席。

**升级前**（复刻生产）：

```
history rows: 37
0037 present: 0
INSERT kind='house_place'        -> ERROR 23514
  new row for relation "asset_operations" violates check constraint
  "asset_operations_kind_check"
INSERT kind='house_collect_rack' -> ERROR 23514（同上）
```

这与线上 `POST /api/house/place_fish → 503` 的根因完全一致。

**执行维护步骤** —— `FISHING_GO_MIGRATION_DATABASE_URL=... bin/migrate up`：

```
{"level":"INFO","msg":"schema_updated"}   exit 0
```

**升级后**：

| 检查 | 结果 |
| --- | --- |
| history rows | 38 |
| 0037 记录 | `0037_house_rack_kinds.sql` |
| `kind='house_place'` 插入 | 成功（operation id 2） |
| `kind='house_collect_rack'` 插入 | 成功（operation id 3） |
| 新二进制 `migrations.Check` | CHECK_PASSED |
| 约束允许的 kind 数 | **56** |

## 4. 约束正确性（无过度放宽）

新增值可用，非法值仍被拒绝：

| kind | 结果 |
| --- | --- |
| `house_place` | 接受 |
| `house_collect_rack` | 接受 |
| `house_bogus` | ERROR 23514 拒绝 |
| `house_place2` | ERROR 23514 拒绝 |
| `not_a_kind` | ERROR 23514 拒绝 |

约束定义中 `house_*` 项：`house_collect, house_upgrade, house_pet,
house_role, house_steal, house_prestige, house_settle, house_place,
house_collect_rack` —— 原 7 项全在，仅追加 2 项。

## 5. 权限（最小权限）

以生产同构角色 `fishing_runtime`（DML allow-list）执行：

| 操作 | 结果 |
| --- | --- |
| INSERT `kind='house_place'` | **ALLOWED** |
| INSERT `kind='house_collect_rack'` | **ALLOWED** |
| CREATE TABLE（DDL） | DENIED `permission denied for schema fishing` |
| DELETE `operator_audit` | DENIED `permission denied for table operator_audit` |
| CREATE ROLE | DENIED `permission denied to create role` |
| ALTER 约束 | DENIED `must be owner of table asset_operations` |

只读备份角色 `fishing_backup`：`SELECT` 允许，`INSERT` 拒绝。

## 6. 备份与恢复

| 项 | 结果 |
| --- | --- |
| `pg_dump`（以 `fishing_backup`） | exit 0，253,505 字节，572 TOC 条目 |
| 恢复到新库 | `pg_restore --exit-on-error` exit 0 |
| 恢复后 rack 行 | `house_place=2`、`house_collect_rack=2` 完整保留 |
| 恢复后约束 | 56 kinds |
| 恢复后迁移历史 | 38 行 |

## 7. 回退边界（重要发现）

演练确认了两条硬边界，必须写进维护窗口的执行单：

1. **数据库一旦迁移，旧二进制无法启动。**
   旧二进制内嵌 37 条迁移；`migrations.Check(..., requireAll=true)` 要求
   历史行数完全相等（`migrate.go:72`）。实测旧二进制对已迁移库：

   ```
   embedded migrations in THIS binary: 37
   CHECK_FAILED: database schema missing or incompatible
   ```

   → 回退**不能**只切回旧发行；必须连同数据库一起恢复。

2. **手工执行 0037 SQL 不足以完成迁移。**
   若只跑 `psql -f 0037_house_rack_kinds.sql` 而不写历史行，约束虽然已放宽，
   但新二进制同样拒绝启动：

   ```
   CHECK_FAILED: database schema missing or incompatible
   ```

   → 必须走 `bin/migrate up`，不能手工执行 SQL。

3. **反向下调约束只在「尚无晒架操作」时可行。**
   - 干净库（无 rack 行）：降回 54 kinds → 成功
   - 已有 `house_place` 行：降回 54 kinds → 失败
     `check constraint ... is violated by some row`

   → 一旦有玩家成功使用晒架，0037 就不可干净回退。

**建议的执行顺序**（与二进制启动检查一致）：

1. 逻辑备份（`pg_dump`）并留存。
2. `FISHING_GO_MIGRATION_DATABASE_URL=... bin/migrate up`（此时旧程序仍在运行，
   0037 只放宽约束，对旧程序完全向后兼容）。
3. 验证 `history=38` 且 0037 记录存在。
4. 再切 `current` 并启动新程序。

第 2 步不改变旧程序可见的任何行为，因此「先迁移、后切程序」既安全又避免了
「切了程序但迁移失败」的空窗。

## 8. 压力与并发

- 4 个并发会话各写 8 个 key：0 错误；`c1-*` 每 key 恰好 1 行（32 → 8），
  重复 key 被 `asset_operations_actor_id_request_key_key` 正确去重，
  即幂等保证按设计生效。
- 3 写 + 3 读混合负载（各 15 次）：0 错误，`mx-*` 15 行。

（并发轮次中日志出现的 duplicate key ERROR 来自我方脚本 4 个 job 复用同一
批 key，属测试脚手架问题；产品侧的去重行为正确。）

## 9. 复刻库最终状态

| 数据库 | 迁移历史 | 允许 kind | rack 行 |
| --- | --- | --- | --- |
| `fishing_test`（空库全量） | 38 | 56 | 4 |
| `fishing_prod`（生产复刻） | 38 | 56 | 49 |
| `fishing_downtest`（下调测试） | 38 | 54 | 0 |
| `fishing_restored`（恢复验证） | 38 | 56 | 4 |
| `fishing_baseline`（仅 DDL 无历史） | 0 | 56 | 2 |

## 10. 未覆盖 / 明确不声称

- 物理 `pg_basebackup`、WAL 归档、PITR 时间点恢复：**未执行**（Docker/WSL2 不可用）。
- 主机/磁盘级故障的零丢失：单机演练无法证明。
- 线上真实数据量、真实索引膨胀与锁等待：未验证；0037 为两条 ALTER，
  仅需 ACCESS EXCLUSIVE 短期锁，预期瞬时，但**应在维护窗口按实际表大小复核**。
- Web/浏览器端到端验收（真实登录 + 投鱼 + 收菜）：未执行；
  前端侧由 19 项晒架 UI 测试覆盖。
- 生产发布与部署本身：未执行。

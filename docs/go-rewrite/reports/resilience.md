# Go 重写玩法容量与故障验收

核对日：2026-09-22  
工作树：`E:\AAAworktrees\web-fishing-game\go-resilience`  
分支：`codex/go-resilience`  
最终短测候选 SHA：`9bed25cb2ddf526126034d7ab1747573450c9775`  
最终短测工作树状态：`dirty=false`

本专项按 [`PARALLEL_ACCEPTANCE.md`](../PARALLEL_ACCEPTANCE.md) 的共同基线执行。所有数据库、容器、卷和账号均为本地合成资源；未连接正式数据库、未 push、未部署。

## 当前结论

在最终短测候选上，真实 HTTP/SSE 短测、PostgreSQL 崩溃恢复和 Go 进程崩溃恢复均可复现，账本对账差异为 0，故障后 fingerprint 与故障前 checkpoint 一致。当前不能宣称 100 人两小时、1000/5000 阶梯或稳定容量通过：这些长测尚未执行。

短测的 HTTP 读和资产写延迟低于参考目标，但通知延迟 p95 约 984 ms，超过 500 ms 目标。调度 p95 当前未测量，因为服务没有向该 harness 暴露调度派发时间戳。SSE 连接上限和真实网关拒绝率仍需在阶梯测量中确定，因此最大稳定容量为“未判定”。

## 实际执行

| 场景 | 命令/规模 | 结果 | 证据 |
|---|---|---|---|
| HTTP/SSE 冒烟 | `Players=1, Seconds=5, FaultMode=none` | candidate SHA `9bed25cb...`、dirty=false；workload 0、对账 0；HTTP 5xx/transport error 0；SSE 343 bytes、10 messages、0 reconnects；阈值 overall=false（通知 p95=984.054 ms） | `output/go-rewrite/resilience/smoke-final-20260922` |
| PostgreSQL crash | `Players=1, Seconds=8, FaultAt=3, FaultMode=postgres-crash` | candidate SHA `9bed25cb...`、dirty=false；SIGKILL 后重启；workload/reconcile/verify/cleanup 全 0；fingerprint `e4bdb8e0c0fefaa4efab4f46d032266eb02e197a427ebbe217293d7d50cd70b6` 一致；fsync、full_page_writes、synchronous_commit 均 on | `output/go-rewrite/resilience/fault-pg-final-20260922` |
| Go crash | `Players=1, Seconds=8, FaultAt=3, FaultMode=go-crash` | candidate SHA `9bed25cb...`、dirty=false；game SIGKILL 后重启；workload/reconcile/verify/cleanup 全 0；fingerprint 一致；`commitOutcome=connection-interrupted`；SSE reconnects 记录在 acceptance report | `output/go-rewrite/resilience/fault-go-final-20260922` |

`fault-pg-20260922-c` 是模块下载 `unexpected EOF` 导致的启动失败；`fault-pg-20260922-d` 是修复屏障前的 fingerprint 时序失败。两份现场均保留，但不计入通过，也不与 e 拼接。修复后的 e 增加了数据库重连退避、checkpoint 写入错误检查，以及“负载完成→停止 game→checkpoint→verify”屏障。

## 覆盖和对账

负载通过真实 gateway HTTP 和 SSE，不再调用模块内部 handler。每个合成玩家执行注册/PoW、旧 fishing start/stop、v1 presence、装备切换、市场读/list/buy、交易 invite、工坊 recast、宝匣、autosell、出售和 `/api/me`/资产读取；SSE 使用长连接和 `Last-Event-ID`。旧 API 请求没有套用 v1 operation-key 恢复语义；只有 v1 transport failure 才先查 `/api/v1/operation?key=`，404 后用同一 request key 重试。

fingerprint 和 reconcile 覆盖 wallet、inventory stacks、equipment owner/lifecycle/escrow、market orders、trades、asset operations、outbox、player events，以及 command/operation/event/native-settlement 计数。短测对账差异均为 0。完整交易 accept/change/confirm/settle、random intents、递归进度和 catch/native settlement 的逐笔业务断言仍需要后续专项补齐，当前不能把计数 fingerprint 当作完整业务证明。

## 资源与持久性

测试使用独立 Compose project、独立 named volume 和独立证据目录。PostgreSQL 18.6，Go 1.27.1，Node 宿主 v24.14.0，时区 `Asia/Shanghai`；卷 driver 为 `local`，挂载于 Docker volume 数据目录，没有使用 tmpfs。Compose 强制 `fsync=on`、`full_page_writes=on`、`synchronous_commit=on`。记录了宿主 CPU/内存/磁盘、容器 stats、连接数、wait event、未授予锁、数据库大小、WAL LSN、commit/rollback 和完整容器日志。

运行时和 migration 在该合成环境暂时使用 `fishing_test_admin`；这不证明正式 runtime/migration 权限隔离，正式角色拆分仍由 migration 线负责。

## 故障边界

PostgreSQL crash 和 Go game crash 是真实容器 SIGKILL、重启和持久卷恢复。HTTP response drop、commit ACK loss、client retry、worker restart、reconnect 的当前默认入口仍以 game 进程中断近似，能记录未知/连接中断结果，但没有 TCP proxy 或数据库 failpoint，因此不能称为精确的“已提交后响应丢失”或“COMMIT 确认丢失”验收通过。它们应在独立 harness 接入真实网络故障后重跑。

## 未完成项目

- 100 人持续正式玩法至少 2 小时；
- 1000/5000 人阶梯和 SSE 拒绝率/连接池边界；
- 跨日长测入口的实际执行和稳定容量结论；
- 调度 p95、提交至通知 p95 的更细事件时间戳；
- 完整交易状态机、随机结果、递归、命令结果和逐笔 settlement 对账；
- 精确 response-drop/commit-ack 网络注入。

可复现实跑入口（默认即 100 人、7200 秒；正式长测前暂停同机重负载）：

```powershell
pwsh -NoLogo -NoProfile -File tools/go-rewrite/test-persistent.ps1 `
  -Players 100 -Seconds 7200 -FaultMode none `
  -RunId capacity-100-2h-<candidate> -OutputRoot output/go-rewrite/resilience
```

故障矩阵示例：

```powershell
pwsh -NoLogo -NoProfile -File tools/go-rewrite/test-persistent.ps1 `
  -Players 100 -Seconds 7200 -FaultMode postgres-crash `
  -FaultAtSeconds 3600 -RunId fault-pg-100-<candidate> `
  -OutputRoot output/go-rewrite/resilience
```

默认保留资源和证据。确认只清理本次 project/volume 时使用 `-Cleanup`；只删除容器、保留 named volume 使用 `-KeepVolume`；`-NoCleanup` 强制保留。脚本不执行全局 volume、容器或目录清理。

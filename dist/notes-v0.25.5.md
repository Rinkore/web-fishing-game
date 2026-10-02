v0.25.5 · 函数遮蔽崩溃修复 / 静态缓存策略 / 写超时放宽

- **currentSpotOf 同名遮蔽修复**：v0.25.3 钓点信息功能在 ui.js 后部重新定义了带参数的 currentSpotOf(st)，遮蔽了上方钓速计算的无参同名函数；顶栏在 castCfg 就绪后抛 TypeError 打断 refreshAll 整条刷新链，渔屋等页面卡在「正在读取渔屋状态…」。钓点信息版本改名 spotInfoTargetOf(st)。
- **静态资源缓存策略**：?v= 资源 immutable 长缓存，HTML 与无版本资源 no-cache 回源校验；发版后客户端不再停留旧前端。
- **写请求超时放宽到 30s**：写操作不再被 8s 中断报「网络错误」而服务端照常成交。

验收：前端 run-all 全部通过；Go build/vet/test 通过；catalog v0.25.5 与各 oracle 重新生成通过 --check。

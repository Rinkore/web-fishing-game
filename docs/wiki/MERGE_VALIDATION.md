# Wiki 合并验证 · 2026-09-19

对照基线为最新主线 `a7766be`，Wiki 来源为 `90ec14c`，整合代码为 `59e057b`。测试使用隔离临时数据目录和测试账号，不连接正式游戏服务。

## Wiki 与安全检查

- Wiki 接口及共享规则：94 通过，0 失败。
- Wiki 浏览器：75 通过，0 失败，覆盖攻略、搜索贴图、最新更新与折叠历史、投稿、手机布局、配装和熔炼。
- 模拟器读取库存后修改词条、保存方案、单次／批量熔炼及继续模拟，真实资产快照与账号文件保持不变；网络请求仅使用允许的只读接口。
- 传输安全：51 项通过。
- `npm run wiki:build` 通过：同步 79 条版本记录，检查 8 个页面、7 个脚本，构建 18 个文件。
- 合并冲突标记、差异空白及共享游戏脚本语法检查通过。

## 最新主线合并前后对照

同一台机器、相同测试依赖，使用 `tests/run-all.js`、4 个并行单元，对受合并影响的 9 个游戏套件进行 A/B 检查。下表为“通过 / 失败”：

| 套件 | 主线 a7766be | 整合 59e057b |
|---|---:|---:|
| e2e | 旧鉴权请求导致中断 | 同样中断 |
| auth-ui | 21 / 5 | 23 / 3 |
| ui-layout | 8 / 13 | 8 / 13 |
| admin | 392 / 0 | 392 / 0 |
| admin-ui | 1 / 1 | 1 / 1 |
| smelt-workbench | 63 / 0 | 63 / 0 |
| v0190 | 30 / 0 | 30 / 0 |
| v0200-loot | 28 / 0 | 28 / 0 |
| v0200-ui | 21 / 0 | 21 / 0 |

在这些套件中没有新增失败。`auth-ui` 的两个旧导航断言已随远洋与 WIKI 入口更新；其余既有失败涉及 jsdom 缺少 `matchMedia`、旧 token/localStorage 登录假设、已变化的钓鱼页面结构和管理员账号前置条件。`e2e` 因旧式鉴权在完成前中断，运行器未汇总断言数，不能将其显示的 0 项当作通过。

最初还对旧主线 `4dfb251` 跑过全量套件。测试期间远端更新至 `a7766be` 后，重新完成上述最新主线对照；未将旧基线的全量结果当作最新主线全量通过。旧测试维护不在此次 Wiki 合并范围内。

复现命令（将依赖路径替换为本机测试依赖目录）：

```powershell
$env:NODE_PATH = '<test-dependencies>/node_modules'
$env:FISHING_TEST_JOBS = '4'
$env:FISHING_TEST_ONLY = 'e2e,auth-ui,ui-layout,admin,admin-ui,smelt-workbench,v0190,v0200-loot,v0200-ui'
node tests/run-all.js
Remove-Item Env:FISHING_TEST_ONLY
npm run wiki:test
npm run wiki:test:browser
node tests/transport-security.test.js
npm run wiki:build
```

各次测试服务均已退出。此操作仅合并和推送代码，不涉及生产重启或 Release。

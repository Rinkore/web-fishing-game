v0.27.6 · 钓获特效开关真正生效 / 动画降强度 / 设置面板港湾化

- 钓获特效开关修复：庆祝动画的开关原先只写在渔获日志的渲染函数里，而真正的主路径 —— 服务器上鱼推送 `net.js` 的 `type === 'catch'` 分支 —— 无条件调用 `HarborShell.catchReward`，所以设置里选「关闭」照样全屏闪一次；日志渲染那次调用本身又是渲染副作用（切页 / 重绘会把同一次钓获重播一遍）。现在播放闸门收敛到 `harbor.js` 的 `catchReward` 一处，实时读 `PlayerSettings.catchFlash`，`off` 时直接不播放；`ui.js` 的日志渲染恢复无副作用，上鱼动画统一由服务器推送触发（普通钓获本来就不弹）。
- 庆祝动画降强度：`harbor.css` 的 `.h-flash` 去掉整屏白闪（原 `@keyframes h-flashbg` 0% 的 `rgba(255, 255, 255, .55)`），改为从透明渐入的轻微压暗 `rgba(3, 8, 18, .5)`；稀有度光芒透明度 .25 → .14、转速 6s → 10s，鱼贴图发光 16px → 8px，总时长 1.8s → 1.6s。点击立即关闭、`data-motion="reduced" / "off"` 与 `prefers-reduced-motion` 下不转光芒的既有行为不变。
- 设置面板港湾化：`settings.css` 新增 `body.harbor-on #settings-dialog` 覆盖段，把对话框从经典深蓝圆角面板改为港湾内景面板（`.h-panel`）的木牌规格 —— 4px 木框 `#8a5a34` + 外圈 `#3a2618`、木纹标题栏 `repeating-linear-gradient`、金色像素标题 `#ffe9a8`、零圆角、港湾描边行分隔线与 `--px-font` 关闭按钮；深色 `::backdrop`。只做覆盖，未删改既有规则。
- 设置项清理：`settings.js` 删除「界面风格（港湾 / 经典侧栏）」整行 —— `choices.theme` 自 v0.27.5 起只剩 `harbor`，该下拉选「经典侧栏」会被校验丢弃、点了没有任何效果；`PlayerSettings.get().theme` 与港湾时间区块的显示逻辑保持不变。
- 版本号升至 v0.27.6：前端 `data.js` 的 `VERSION`、`index.html` / `admin.html` 的 `?v=` 缓存参数、内嵌 Go catalog 的 `version` 与 `constants.VERSION` 同源（catalog.json 只改这两处，已复核的 gearmerge 快照与 `sourceSHA256` 保持不动）；四个规则 oracle 由 `tools/go-rewrite/{chest,mall,native-rules,workshop}-fixture.js --write` 随版本号重新生成。

验收：`node tests/settings.test.js`（24 项）、`node tests/harbor-phase-a.test.js`（39 项）、`node tests/harbor-phase-b.test.js`（32 项）、`node tests/harbor-phase-cd.test.js`（29 项，含新增的「关闭开关不播放 / 开启才播放 / 对话框木牌风格」三条回归）、`node tests/fishing-overlay.test.js`（113 项）全部通过；另按港湾外壳 + 100% / 115% / 140% 字号、1366 / 768 / 390 / 320 宽目视核对设置对话框不溢出（140% + 320 宽的时段编辑器横向溢出为改动前既有的表现，与本次改动无关）。发布走本地：构建、公钥上传、服务器固定入口部署，不走 GitHub Action。

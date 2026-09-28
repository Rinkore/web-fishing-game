# 内景功能页对齐设计稿 v2 · 施工说明

**目标**：把现在的 10 个功能页（仓库 / 工坊 / 宝匣 / 集市 / 酒馆 / 远洋码头 / 告示板 /
邮筒 / 渔屋 / 栈桥）的风格、布局改成设计稿 `output/design-review/redesign/v2` 的样子。

**设计参照**（唯一口径，冲突时以它为准）

- 房间渲染器：`output/design-review/redesign/v2/harbor-rooms.js`
- 样式：`output/design-review/redesign/v2/harbor.css`（内景零件段）
- 截图：`output/design-review/redesign/v2/shots/a-room-*.png`（桌面）、`a-phone*.png`（手机）
- 验收条目：`docs/ACCEPTANCE_SPEC_INTERIORS.md`

**原则**

1. 只改观感与结构，**功能一个都不能少**：出售 / 上架 / 批量 / 分页 / 筛选 / 交易 / 开箱 /
   熔炼 / 升级 / 好友 / 编队 / 邮件附件等原有交互与接口调用保持可用。
2. 复用已有接口和框架，不要新造轮子：共用零件用 `window.RoomUI`（`frontend/js/room-ui.js`），
   共用样式在 `frontend/css/harbor.css` 的「设计稿 v2 · 内景功能页」段。
3. 保留既有 DOM 契约（`data-*`、id、class），否则同页的 patch / 实时刷新函数会失联；
   必须改契约时，把依赖它的 patch 函数在同一个改动里一起改掉。
4. 像素风细节：3px 描边、无圆角、按钮按压位移 2px、标签用像素字体（`var(--px)`）、
   正文用系统字体（`var(--body)`）、品质色 `--r-common/rare/epic/mythic`。

## 已完成的外壳部分（阶段 F 基础，勿重复实现）

- 木梁标题：`harbor.js` 的 `PLACES[id].full`（如「仓库 · 背包」），面包屑「港湾 › 仓库 › 全部」。
- 一级页签：设计稿把每页的功能页签画在木梁下方的挂签上（`#h-tabs`，样式 `.h-tabs`）。
  清单与当前项由 `ui.js` 的 `panelTabDefs()/panelTabs()/panelTab(key)` 提供，
  外壳只渲染与转发点击。**页面内不要再画一级页签行**（旧的一级页签行已由 CSS 收起）。
- 深链 `#/place/序号` 走 `UI.panelTab`，`applyTabDeepLink` 优先用页签定义。
- 经典版页首横幅（`#main.has-banner::before/after`）在港湾里已关闭。
- 内景里的 `.panel` 外层卡片已透明化，内容直接铺在面板底色上。

新增的一级页签状态（写在 `ui.js` 顶部）：

| 页面 | 变量 | 取值 |
| --- | --- | --- |
| 工坊 | `wsPanelTab` | `bench` 工作台 / `growth` 装备成长 / `sets` 钓鱼套装 / `smelt` 熔炼 |
| 宝匣 | `chestTab` | `open` 开箱 / `craft` 合成 |
| 远洋码头 | `seaPanelTab` | `voyage` 远航 / `ship` 船只 |

## 页面分工（每人只动自己名下的函数）

| 组 | 页面 | 主要改动位置 |
| --- | --- | --- |
| A | 仓库 / 宝匣 / 邮筒 | `ui.js` renderInventory 及其 patch、renderChest + wsRenderOpen、`mail.js` MailUI.render |
| B | 工坊 / 渔屋 / 远洋码头 | `ui.js` renderWorkshop、renderCharacter 系列、renderSea + seaFill，`gear.js` 页签接口 |
| C | 集市 / 酒馆 / 告示板 | `ui.js` renderMall/renderShop/renderMarket、renderGround/renderFriends/renderParty、renderBoard 系列 |
| 主 | 栈桥（钓鱼页） | `ui.js` renderFishing，只换外框与配色，钓鱼玩法不动 |

样式按组拆到独立文件，避免并行改同一个文件：

- A：`frontend/css/room-inventory.css`
- B：`frontend/css/room-workshop.css`
- C：`frontend/css/room-social.css`

## 验收（每轮只跑这两条，别做全量测试）

```powershell
cd C:\Users\Rinkore28\Documents\ChatGPT\DeepFish\output\design-review\v2-parity
node shots.js <tag> --only=inventory,chest,mail      # 产出 <tag>-desktop-*.png / <tag>-phone-*.png
node smoke.js                                       # 逐页打开，报 JS 异常 + 挂签/标题
```

再看图对比 `output/design-review/redesign/v2/shots/a-room-*.png`，逐页对齐后才算完成。
**不要**跑 go test / npm test / 其他历史脚本。

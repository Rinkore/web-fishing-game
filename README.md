# 钓鱼网站 v0.7.1（服务器权威 · 前后端分离）

零第三方依赖的多人联机网页钓鱼小游戏。**所有处理逻辑在服务端**：钓鱼循环、掷骰、
词缀加成、资产结算、钓竿配置均由后端权威执行；前端只发指令、收 SSE 广播、渲染。
纯原生 Web 前端 + Node 内置 `http` 模块后端，游戏数值目录前后端共用一份（UMD）。

## 项目结构

```
├── backend/
│   └── server.js        # 权威服务器：钓鱼循环/掷骰/钓竿配置/账号/商店/市集/交易/SSE 广播
│                        # 数据落盘 backend/data/；游戏目录 require 自 frontend/js/data.js
├── frontend/            # 纯静态瘦客户端，可部署到任意静态服务器
│   ├── index.html
│   ├── admin.html       # 管理后台页面（管理员账号登录，见「管理后台」章节）
│   ├── serve.js         # 本地开发用静态服务器（零依赖）
│   ├── css/style.css
│   ├── css/admin.css
│   └── js/
│       ├── config.js    # API_BASE 配置（默认 'auto' 自动探测）
│       ├── data.js      # 游戏数据目录（UMD：前端挂 window.GameData，后端 require）
│       ├── engine.js    # 客户端状态层：展示状态 + 指令发送（无游戏逻辑）
│       ├── net.js       # 网络层：指令 API + SSE 广播接收
│       ├── admin.js     # 管理后台页面逻辑
│       └── ui.js        # 页面渲染与交互
├── tests/               # 6 个测试套件 + run-all.js 一键运行
├── run.bat              # 启动后端（集成模式，9000，同时托管前端）
└── start-frontend.bat   # 启动前端独立静态服务器（5500）
```

## 架构要点（服务器权威）

- **钓鱼**：`POST /api/fishing/start|stop` 在服务器启停钓鱼循环；服务器定时器掷骰
  （含钓竿词缀加成），渔获入库/图鉴/大鱼榜/动态全部在服务端完成，经 SSE 定向推送
  `catch` 与权威 `assets`；断线自动停竿。客户端无法伪造渔获（旧 `/catch` 已删除）。
- **钓竿配置**：`POST /api/bd/set` 由服务器校验部位与组件目录并落盘；钓速变化即时
  重置进行中的循环。`/api/profile` 只接受显示名，客户端上报 coins/inventory 一律忽略。
- **近期渔获**：大鱼/稀有/组件入包时由服务器更新 presence 并广播。
- **管理后台**：`/api/admin/*` 需账号带 admin 标志；钓场/钓点配置覆盖落盘 `world.json`
  （`groundCfg`），启动时套用到共享目录，改动经 SSE `groundcfg` 即时同步所有在线客户端。
- **测试辅助**：`FISHING_DEV=1` 环境变量开启 `/api/dev/seed|catch`（确定性回归用），
  正常部署不开启。

## 运行

### 集成模式（最简单）

```bat
run.bat
```

打开 http://localhost:9000 ，注册登录即可；多开浏览器标签 = 多真实玩家。

### 分离模式（前后端独立进程）

```bat
run.bat                 :: 窗口1：后端 API，http://localhost:9000
start-frontend.bat      :: 窗口2：前端静态服务器，http://localhost:5500
```

打开 http://localhost:5500 。前端 `API_BASE=auto` 会自动连接同主机的 9000 后端（后端已放行 CORS）。

前端也可以用任意其他静态服务器托管 `frontend/` 目录（nginx、GitHub Pages 等），或把
`frontend/js/config.js` 里的 `API_BASE` 改成显式地址（如 `https://api.example.com`）。

### 后端环境变量

| 变量 | 说明 |
|---|---|
| `PORT` | 监听端口，默认 9000 |
| `STATIC_DIR` | 指定前端目录；`none` 强制纯 API 模式（默认自动托管 `../frontend`，存在时） |
| `FISHING_DATA_DIR` | 数据目录覆盖（默认 `backend/data`）；测试套件用临时目录隔离，避免清掉真实存档 |

## 管理后台

打开 `admin.html`（与游戏前端同源托管）：

- 分离模式：http://localhost:5500/admin.html （前端在 5500 时）
- 集成模式：http://localhost:9000/admin.html （run.bat 单进程时）

**登录与授权**：使用游戏账号密码登录；账号须带管理员标志。服务器上没有任何管理员时，
**第一个登录管理后台的账号自动成为管理员**（引导机制）。此后其他账号由管理员在
「账号授权」页开启/关闭（管理员不能撤销自己的权限）。获得权限的玩家在游戏侧边栏会看到
「🛡 管理后台」入口。

**功能**：

| 页签 | 说明 |
|---|---|
| 概览 | 在线/钓鱼人数、账号数、挂单数、当前通知等级与公式（5 秒自动刷新） |
| 账号授权 | 全部账号列表，开关「管理员」权限 |
| 渔场钓点 | 编辑每个钓点的掉落池（鱼/材料/组件 + 权重，**实时百分比显示**）、钓点增益（6 类词缀 + 数值，可与钓竿词缀叠加，保存即时生效并重启受影响的钓鱼循环）、钓场一键锁定/解锁（锁定立即停竿） |
| 市集管理 | 全部挂单一览，「退回」将物品退回卖家背包（上架费不退，与过期规则一致） |
| 上钩公式 | 编辑每次抛竿的上钩概率公式（安全解析不用 eval；变量 `speed/big/rare/material/size/double/interval`，函数 `min/max/floor/ceil/round/abs/clamp`），支持校验与试算 |
| 通知等级 | 控制全服动态推送范围：`all` 全部 / `uncommon` 仅非普通 / `offrange` 仅体型超出基准范围 / `records` 仅破纪录 / `none` 关闭；钓者自己的渔获推送不受影响 |

所有配置修改**保存即生效**，无需重启；掉落池/增益/锁定/公式/通知等级均持久化到 `backend/data/world.json`。

## 测试

```bash
node tests/run-all.js   # 一键跑 e2e / auth-ui / fishing-interaction / bugfix / ui-layout / admin
```

jsdom / playwright-core 不随仓库分发，装好后放到项目 `node_modules`，或用
`NODE_PATH` / `FISHING_TEST_MODULES` 指定位置。

## 功能

钓鱼（3 钓场 × 3 钓点，服务器自动抛竿，42 种渔获按钓点主题分布）、钓竿配置（31 种组件 × 6 类词缀，
含正负取舍词条；组件 ID 即效果编码 `部位_效果数值_…`，如 `rod_spd15_size-5`，新增组件只写 ID 即自动生效，
旧 ID 存档自动迁移）、渔场实时动态、
系统商店（单乘数供需价：每卖一件乘数约 -0.7%、闲置向 2 倍缓慢回升，可查价格走势与交易流水）、开放市集（购买市场/我的挂单/历史订单分页：1% 上架费下架不退 + 成交 10% 税）、
在线交易（以物易物、双确认）、独立背包页（分类明细/出售/上架/下架/基准价预估总价）、鱼类图鉴、渔获记录（全场最大置顶 + 分鱼类查看 + 前十大 + 小鱼纪录）。商城 / 收藏 / 活动钓场为锁定占位。

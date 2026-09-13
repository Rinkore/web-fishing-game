# 网页钓鱼小游戏 v0.6（服务器权威 · 前后端分离）

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
│   ├── serve.js         # 本地开发用静态服务器（零依赖）
│   ├── css/style.css
│   └── js/
│       ├── config.js    # API_BASE 配置（默认 'auto' 自动探测）
│       ├── data.js      # 游戏数据目录（UMD：前端挂 window.GameData，后端 require）
│       ├── engine.js    # 客户端状态层：展示状态 + 指令发送（无游戏逻辑）
│       ├── net.js       # 网络层：指令 API + SSE 广播接收
│       └── ui.js        # 页面渲染与交互
├── tests/               # 5 个测试套件 + run-all.js 一键运行
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

## 测试

```bash
node tests/run-all.js   # 一键跑 e2e / auth-ui / fishing-interaction / bugfix / ui-layout
```

jsdom / playwright-core 不随仓库分发，装好后放到项目 `node_modules`，或用
`NODE_PATH` / `FISHING_TEST_MODULES` 指定位置。

## 功能

钓鱼（3 钓场 × 3 钓点，服务器自动抛竿）、钓竿配置（14 种组件 × 6 类词缀，组件钓鱼掉落、服务器实时生效）、渔场实时动态、
系统商店（单乘数供需价：每卖一件乘数约 -0.7%、闲置向 2 倍缓慢回升，可查价格走势与交易流水）、开放市集（购买市场/我的挂单/历史订单分页：1% 上架费下架不退 + 成交 10% 税）、
在线交易（以物易物、双确认）、独立背包页（分类明细/出售/上架/下架/基准价预估总价）、鱼类图鉴、大鱼记录（全场最大置顶 + 分鱼类查看）。商城 / 收藏 / 活动钓场为锁定占位。

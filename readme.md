# Surge 规则管理器

基于 **Cloudflare Pages + Turso (libSQL)** 的 Surge 规则管理面板：FINAL 命中采集、订阅解析导入、多设备来源追踪、命中过滤导出与订阅直链。

- **后端**：Cloudflare Pages Functions（纯 JS + ESM），通过 HTTPS 远程 API 访问 Turso，不使用 ORM
- **前端**：无框架原生 JavaScript ES Module + Bootstrap 5.3 CDN
- **客户端**：FINAL `.sgmodule` 模块外链直装（统计面板 + 配置下发 + 捕获脚本模板），捕获脚本在 Surge 脚本编辑器中由模板另存为本地脚本，教程见下文「部署教程」与「Surge 安装教程」
- **测试**：Node 自建端到端套件（进程内模拟 Turso，不依赖真实数据库、不联网）

---

## 目录结构

```
final/
├── functions/                       # 后端（Cloudflare Pages Functions）
│   ├── _utils/                      # 基础设施 + 数据访问层（_ 前缀 = 不产生路由）
│   │   ├── http.js                  #   统一响应 / readJson / 400·404·405 / LIKE 转义
│   │   ├── turso.js                 #   Turso HTTP 客户端（批量事务）+ 配置解析
│   │   ├── auth.js                  #   令牌鉴权（写接口 / 上报接口，支持多令牌轮换）
│   │   ├── timezone.js              #   设备本地零点 ↔ UTC 换算（「今日新增」）
│   │   ├── prefs.js                 #   app_prefs 数据访问层
│   │   ├── subscriptions.js         #   subscriptions 数据访问层 + URL 规范化
│   │   ├── heartbeat.js             #   Surge 面板心跳注册表（/stats 捎带上报 → client_heartbeats）
│   │   ├── build-meta.js            #   构建清单（inject-version.mjs 生成，勿手改）
│   │   └── db/                      #   多数据库工厂（DB_BACKEND: turso / d1 / sqlite）
│   │       ├── contract.js          #     适配器契约：DbError 归类 + {rows, changes} 统一形状
│   │       ├── ddl.js               #     建表 DDL + db_meta 版本表幂等迁移
│   │       ├── turso-adapter.js     #     Turso HTTPS 语义内聚（rows_written / 事务 / 超时）
│   │       ├── d1-adapter.js        #     Cloudflare D1 平台绑定（batch 原子）
│   │       ├── sqlite-adapter.js    #     node:sqlite 本地文件（自托管 / e2e 真实后端）
│   │       └── factory.js           #     getAdapter(env)：配置签名缓存 + 失败逐出
│   │   ├── ipnet.js                 #   IP/CIDR 数学（解析/补零/包含判断，前端有等价实现）
│   │   ├── surge-rule/              #   Surge 规则引擎（纯函数，零 IO）
│   │   │   ├── types.js             #     规则类型全集（29 种）
│   │   │   ├── params.js            #     参数白名单（标志位 / 键值两类）
│   │   │   ├── policy.js            #     策略名判定与规范化（DEVICE: 大小写语义）
│   │   │   ├── ip.js                #     IPv4/IPv6/CIDR 校验与导出规范化
│   │   │   ├── host.js              #     主机名形态判定与类型推断
│   │   │   ├── text.js              #     引号感知切分 / 注释扫描 / 值序列化
│   │   │   ├── parse.js             #     parseRuleLine（完整结构与简写）
│   │   │   ├── format.js            #     formatRuleItem / formatRule / joinRuleLines
│   │   │   └── index.js             #     公共出口
│   │   └── logs/                    #   surge_logs 数据访问层
│   │       ├── schema.js            #     表结构 / 分块常量 / 一次性列迁移
│   │       ├── codec.js             #     params 编解码（对象 ↔ 逗号分隔文本）
│   │       ├── normalize.js         #     行规范化（NULL 兜底 / 类型策略回落）
│   │       ├── query.js             #     listLogs / getAllLogs / getStats
│   │       ├── hit.js               #     recordHit / recordHits（单条与批量 upsert 计数）
│   │       ├── edit.js              #     updateLog / renameLog / validateLogPatch
│   │       ├── admin.js             #     delete / clear / clear-empty / reduceExclude
│   │       ├── batch.js             #     batchOverride（merge|override 模式 + 分块）
│   │       ├── export.js            #     导出格式化 / 注释头 / 摘要
│   │       └── index.js             #     公共出口
│   ├── api/                         # 路由层（每个文件即真实路由，内含薄分发）
│   │   ├── _logger/                 #   logger 路由实现（constants/exporter/reads/writes）
│   │   ├── _subscribe/              #   subscribe 路由实现（constants/guard/cache/extract/routes）
│   │   ├── _ai/                     #   ai 路由实现（config/client/selector/executor）
│   │   ├── logger.js                #   /api/logger[/...]
│   │   ├── logger/[[rest]].js       #   兜底路由：让 /api/logger 全部子路径命中上者
│   │   ├── health.js                #   /api/health（部署健康检测：basic 只读 / deep 写探针）
│   │   ├── health/[[rest]].js       #   兜底路由
│   │   ├── export.js                #   /api/export（固定订阅导出，筛选条件读偏好表）
│   │   ├── export/[[rest]].js       #   兜底路由：/api/export 子路径同样命中上者
│   │   ├── subscribe.js             #   /api/subscribe[/...]
│   │   ├── ai.js + ai/[[rest]].js   #   /api/ai[/...]（Workers AI 自动分流）
│   │   ├── rules.js                 #   /api/rules[/...]（旧版表，兼容保留）
│   │   ├── prefs.js + prefs/[[rest]].js
│   │   └── schema.js                #   /api/schema（建表 DDL 下发）
├── public/                          # 前端静态资源
│   ├── index.html                   #   单页面板（四视图：首页/数据/AI配置/设置 + 设备检测隐藏页）
│   ├── _headers                     #   静态缓存策略（/ no-store、/surge/* max-age=300）
│   ├── style.css / captured.css
│   └── js/                          #   ES Module 前端（25 个模块，main.js 为入口）
│       ├── main.js                  #     入口：装配 window.capturePanel + 事件绑定
│       ├── config.js dom.js notify.js ruletext.js api.js clipboard.js
│       ├── prefs-store.js render.js export.js refresh.js
│       ├── edit.js actions.js subscribe.js sync.js settings.js ipnet.js
│       ├── nav.js levels.js pwa.js devices.js
│       └── version.js version-check.js health.js ai.js
│           # nav=页面路由（设备检测为隐藏页）  levels=降维候选  ipnet=IP 数学  pwa=Service Worker
│           # version=版本常量(生成)  version-check=版本比对/看板/更新横幅
│           # health=配置检测  devices=设备检测综合视图（设备状态+告警+检测+版本聚合）
│           # ai=Workers AI 连接/调度/队列状态 + 前端调度器（面板打开期间按周期触发）
├── surge/                           # Surge 单文件脚本（运行时约束，不可拆分）
│   ├── final-logger.js              #   FINAL 命中捕获 → 持久化缓冲去重 → 经中转后端 /hits 批量写库（经模板另存为本地脚本）
│   ├── final-panel.js               #   Surge [Panel] 实时统计面板 + 配置写入持久化
│   └── final.sgmodule               #   FINAL 模块（统计面板 + 配置下发 + 捕获脚本模板引用）
├── sql/schema.sql                   # 全量 DDL + 旧库迁移语句（与 /api/schema 一致）
├── scripts/
│   ├── inject-version.mjs           #   版本注入：package.json + git 短哈希 → 全产物版本戳
│   ├── watch-public.mjs             #   本地调试：public/ 改动实时拷进 dist/
│   ├── patch-worker.mjs             #   构建后处理 _worker.js（移除 polyfill static 块）
│   ├── make-icons.mjs               #   PWA 图标生成
│   └── repair-logs.mjs              #   历史脏数据修复脚本（默认 dry-run，--apply 执行）
├── tests/
│   ├── e2e.mjs                      #   端到端验证（真实 SqliteAdapter 后端 + 打桩订阅抓取）
│   ├── db-adapters.test.mjs         #   适配器契约测试（turso mock / D1 模拟 / sqlite 同一组断言）
│   └── surge-scripts.test.mjs       #   Surge 脚本单测（node:vm 沙箱模拟脚本 API）
└── wrangler.toml / package.json
```

## 模块依赖关系（单向，无循环）

```
api/*.js（薄分发）
  ├─▶ api/_logger/*、api/_subscribe/*（路由实现）
  │     ├─▶ _utils/logs/*（DAL）──▶ _utils/surge-rule/*（纯函数引擎）
  │     ├─▶ _utils/subscriptions.js、_utils/prefs.js（DAL）
  │     └─▶ _utils/db/factory.js ─▶ DatabaseAdapter（turso / d1 / sqlite 三实现）
  ├─▶ api/health.js（健康检测管道）──▶ _utils/db + _utils/heartbeat.js
  └─▶ api/export.js（固定订阅导出）──▶ api/_logger/exporter.js + _utils/prefs.js
公共底座：_utils/http.js（零依赖）、_utils/auth.js、_utils/timezone.js、_utils/ipnet.js
版本事实源：scripts/inject-version.mjs → _utils/build-meta.js（后端）+ public/js/version.js（前端）
```

前端同理：`main.js → nav.js 与各功能模块 → config/dom/notify 底座 → prefs-store`，
全部静态 `import`，无动态加载、无全局变量（仅保留 `window.capturePanel`
与 `window.PrefsStore` 两个入口供 HTML 内联事件使用）。

## API 一览

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| GET | `/api/logger` | 匿名 | 规则列表（`?search=&policy=&type=&limit=`，默认 5000、上限 50000，按最近命中倒序）；行含 `ip` / `username` 来源字段 |
| GET | `/api/logger/stats` | 匿名 | 统计（`?tz=` 设备本地时区偏移，分钟）；带 `x-final-client` 心跳头 + 上报令牌时记录客户端心跳与设备登记，响应捎带 `latest` 组件版本、最近心跳清单与 `devices` / `deviceSummary` 设备报表（在线 n/m + 分级告警） |
| GET | `/api/logger/export` | 匿名 | 订阅文本（`?type=&source=&with-source=&min-count=&last-days=&meta=1`） |
| GET | `/api/logger/export-summary` | 匿名 | 导出前核对摘要（与 `/export` 同一套过滤，含 `last-days`） |
| GET | `/api/logger/schema` · `/meta` | 匿名 | surge_logs 建表 DDL / 规则类型·参数·策略常量（含 `writeAuthRequired`）；`/meta` 另带 `version` 版本清单（serverVersion / components / dbSchemaVersion），no-store，是版本比对的唯一基准 |
| GET | `/api/export[/...]` | 匿名 | 固定订阅导出：`?policy=all\|proxy\|direct\|reject`，筛选读偏好表 `user=export`，显式查询参数优先 |
| POST | `/api/logger/hit` | 上报令牌（必配） | Surge 命中上报（`?token=` 或 Bearer 头），扁平体 `{hostname,type,value,source,policy,params}`；`ip` 由服务端从连接捕获、`username` 可选携带 |
| POST | `/api/logger/hits` | 上报令牌（必配） | Surge 批量上报：`{hits:[{hostname,count?,...}], username?}`，同主机名合并次数、单次上限 200，捕获脚本去重窗口的入口；设备上下文（X-Final-Client/Device/User/Logger 头）随请求登记进 devices 注册表 |
| POST | `/api/logger/update·delete·exclude·batch·clear·clear-empty` | 写令牌 | 面板写操作；`clear` 另需 `{"confirm":true}` |
| GET | `/api/subscribe` · `/api/subscribe/schema` | 匿名 | 已保存订阅 / 建表 DDL |
| POST | `/api/subscribe/parse·save·delete` | 写令牌 | 服务端抓取解析 / 保存 / 删除 |
| GET | `/api/rules` · `/api/rules/list` | 匿名 | 旧版 rules 表列表（`?search=`）/ Surge 订阅文本 |
| POST | `/api/rules` · PUT·DELETE `/api/rules/:id` | 写令牌 | 旧版 rules 表增改删（兼容保留） |
| GET·POST·DELETE | `/api/prefs` · GET `/api/prefs/schema` | 配置写令牌后读写删全部需令牌 | 偏好读写删（`?user=` 设备标识；DELETE 带 `key=` 或 `key=__all__`；`gist.token` 存这张表，不能匿名读） |
| GET | `/api/health` | 匿名（deep 在配置写令牌后需令牌） | 部署健康检测：`?mode=basic`（默认，全只读）/ `?mode=deep`（写探针三步同事务、令牌校验、按 IP 每分钟一次）；返回逐项状态 / 耗时 / 修复建议 / 文档锚点与汇总，全程脱敏 |
| GET | `/api/ai/config` · `/api/ai/status` | 匿名 | AI 分流自动化：读全局配置（token 只回掩码）/ 队列统计 + 上次运行摘要 + 下次可运行时间 |
| POST | `/api/ai/config` | 写令牌 | 保存 Workers AI 连接与调度配置（token 留空或传掩码 = 保留旧值） |
| GET | `/api/ai/models` · POST `/api/ai/test` | 写令牌 | 代理拉取账号可用文本生成模型 / 跑一条最小推理测连通 |
| POST | `/api/ai/run` | 写令牌（额外接受 `?token=`，供外部定时器） | 执行一轮批量分流（一批 = `batchSize` 条）；冷却期内返回 `skipped`，`?force=1` 跳过 |
| POST | `/api/ai/reset` | 写令牌 | 清空 `ai_processed` 标记，全部候选规则重新参与调度 |
| GET | `/api/schema[/table/:key]` | 匿名 | 全量 / 单表 DDL（`rules`/`logger`/`prefs`/`subscriptions`/`health`/`heartbeats`/`devices`/`meta`） |

响应约定：`/api/logger`、`/api/subscribe` 下的只读接口带 `Cache-Control: public, max-age=30`
（`/api/logger/export` 为 60），写操作与 `/hit` 带 `no-store`（`/api/prefs` 的写接口不设缓存头）；
两个导出接口都回 `X-Export-Count` / `X-Export-IPv4` / `X-Export-IPv6`（只数规则行，
不含可选的头部注释行），没有命中时正文是 `# 暂无符合条件的规则`。

`/api/subscribe/parse` 的抓取：单次 8 秒、最多 3 次、退避 300/600ms、总预算 30 秒，
只对网络抖动与 429/5xx 重试，正文上限 2MB；目标地址经 `_subscribe/guard.js` 过滤
（协议、userinfo、环回 / 私有 / 链路本地 / 云元数据字面量，纯字符串判定、不做 DNS 解析）。

固定订阅 `/api/export` 的四个筛选键（偏好表 `user=export`）：`export.source`、
`export.with_source`、`export.min_count`、`export.last_days`。它的 `meta` 语义也与别处相反：
这里 `meta=0` 才关头部注释，`/api/logger/export` 要 `meta=1` 才开。

环境变量：`TURSO_API_URL`、`TURSO_AUTH_TOKEN`、`PANEL_HIT_TOKEN`（必填，https 形式 / 逗号分隔多令牌）；
`PANEL_WRITE_TOKEN`（可选，逗号分隔多令牌）；
`DB_BACKEND`（可选，`turso`（默认）/ `d1` / `sqlite`，见下文「多数据库工厂」）。
上报令牌未配置时 `/api/logger/hit` 一律 401；写令牌未配置时写接口保持开放，
只读响应带 `Warning` 头、`/meta` 返回 `writeAuthRequired: false`。
上报接口只要求「任一已配置令牌匹配即可」——只配了 `PANEL_WRITE_TOKEN` 时，
拿写令牌也能上报（`requireHitToken` 对两个变量一视同仁；两个变量都配置时
任一变量里的令牌均可上报）。偏好接口 `/api/prefs` 在配置了写令牌时读 / 写 / 删
全部要求令牌（`gist.token` 与普通偏好同表，匿名可读等于暴露凭据）。

## 部署教程（Turso + Cloudflare Pages）

从零到可用共 5 步：**准备 Turso → Cloudflare Pages 连 GitHub → 配环境变量 → 建表 → 验证**。
已有部署只想查命令/地址，直接跳到「关键地址与命令速查」。

### 1. 注册并准备 Turso（服务器地址 + 令牌）

1. **注册**：打开 [turso.tech](https://turso.tech) → Sign up（支持 GitHub 登录），进入控制台。
2. **建库**：控制台 → Create Database，名字如 `final`，区域选离自己近的
   （如 Hong Kong / Singapore / Tokyo），其余默认。
3. **服务器地址**（`TURSO_API_URL`）：数据库页 → Connect → 「HTTP API」一栏，
   形如 `https://your-database.turso.io`。**必须 `https://` 开头**——
   `libsql://` 是客户端协议，Workers 无法解析。
4. **访问令牌**（`TURSO_AUTH_TOKEN`）：控制台 → Database credentials → Access tokens
   → 新建并复制（只显示一次，妥善保存）。

命令行等价操作（安装 Turso CLI 后）：

```bash
turso auth signup             # 注册 / 登录
turso db create final         # 建库
turso db show final --url     # 服务器地址（libsql:// 形式，填变量时换成 https://）
turso db tokens create final  # 访问令牌
```

### 2. Cloudflare Pages 连接 GitHub 部署

前置：本项目代码已推送到 GitHub 仓库。

1. Cloudflare Dashboard → **Workers & Pages** → **Create** → 切到 **Pages** 标签
   → **Connect to Git**，授权 GitHub 并选中本仓库 → **Begin setup**。
2. 构建配置：
   - Framework preset：`None`
   - Build command：`npm run build`
   - Build output directory：`dist`
3. 保存并首次部署。之后**每次推送 `main` 分支自动重新构建发布**；
   生产主域名 `https://<项目名>.pages.dev` 始终指向最新成功部署
   （另有 `<8位hash>.<项目名>.pages.dev` 快照地址，每次都变，不要当站点地址用）。

> `npm run build` 做三件事：把 `public/` 拷入 `dist/`；`wrangler pages functions build`
> 编译 Functions 并生成 `_routes.json`（仅 `/api/*` 走 Functions，其余为静态资源）；
> `scripts/patch-worker.mjs` 移除产物里 unenv polyfill 类的 keepNames static 块
> （Pages 上传阶段的旧版 wrangler 对该模式二次编译后 workerd 启动会崩，类名仅用于堆栈可读性）。
> 本地手动部署直接用 `npm run deploy`，但注意其写死 `--project-name=final`，
> 与 Git 集成创建的项目名可能不一致，见文末速查表。

### 3. 配置环境变量

Pages 项目 → **Settings → Variables and Secrets**（Production），逐条添加：

| 变量名 | 必填 | 说明 |
|---|---|---|
| `TURSO_API_URL` | ✅ | 第 1 步的数据库地址，`https://` 开头 |
| `TURSO_AUTH_TOKEN` | ✅ | 第 1 步的访问令牌 |
| `PANEL_HIT_TOKEN` | ✅ | Surge `/hit` 上报令牌，必须配置（未配置时上报一律被拒）；Surge 参数 `FINAL_DB_TOKEN` 填同一个值 |
| `PANEL_WRITE_TOKEN` | 可选 | 面板写操作令牌，逗号分隔可配多把轮换；配置后偏好读 / 删同样要求令牌 |
| `DB_BACKEND` | 可选 | 数据库后端：`turso`（默认，零改动）/ `d1` / `sqlite`，见「多数据库工厂」；填非法值启动即 400 并列出合法值 |

- 上报令牌未配置时 `/api/logger/hit` 一律返回 401；写令牌未配置时写接口保持开放，只读响应带 `Warning` 头、`/api/logger/meta` 返回 `writeAuthRequired: false`。
- 变量只对新部署生效：改完到 **Deployments → 最新部署 → Retry deployment**（或推一个 commit）触发重新部署。
- 构建若报 Node 版本相关错误，补一个变量 `NODE_VERSION=22`（本仓库要求 Node ≥ 22）。

### 4. 建表（一次性）

任选其一（全部语句 `IF NOT EXISTS`，可重复执行）：

- **Turso 控制台**：数据库页 → Console（Query），粘贴 `sql/schema.sql` 全部语句执行；
- **Turso CLI**：`turso db shell final < sql/schema.sql`；
- **线上取回**：部署后访问 `https://<项目名>.pages.dev/api/schema`（全量 DDL）。

也可以直接粘贴以下 DDL 执行：

```sql
CREATE TABLE IF NOT EXISTS surge_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hostname TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'DOMAIN-SUFFIX',
  value TEXT NOT NULL DEFAULT '',
  policy TEXT NOT NULL DEFAULT 'PROXY',
  params TEXT NOT NULL DEFAULT '',            -- 逗号分隔：no-resolve,pre-matching,...
  comment TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT '',            -- 上报设备名
  ip TEXT NOT NULL DEFAULT '',                -- 来源 IP（v2：服务端从连接捕获）
  username TEXT NOT NULL DEFAULT '',          -- 用户名/用户组（v2：模块参数 FINAL_USER）
  first_time TEXT NOT NULL DEFAULT '',
  time TEXT NOT NULL,                          -- 最近命中，UTC ISO
  count INTEGER NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_surge_logs_hostname ON surge_logs(hostname);
CREATE INDEX IF NOT EXISTS idx_surge_logs_time ON surge_logs(time);
CREATE INDEX IF NOT EXISTS idx_surge_logs_type ON surge_logs(type);
CREATE INDEX IF NOT EXISTS idx_surge_logs_source ON surge_logs(source);
CREATE INDEX IF NOT EXISTS idx_surge_logs_username ON surge_logs(username);

CREATE TABLE IF NOT EXISTS devices (
  device_id TEXT PRIMARY KEY,                  -- 面板 clientId（client:）或 用户名|型号|IP（dev:）
  name TEXT NOT NULL DEFAULT '',               -- 设备型号
  username TEXT NOT NULL DEFAULT '',           -- 用户组/用户名
  ip TEXT NOT NULL DEFAULT '',                 -- 最近来源 IP
  panel_version TEXT NOT NULL DEFAULT '',      -- 面板脚本自报版本
  logger_version TEXT NOT NULL DEFAULT '',     -- 捕获脚本自报版本
  config_status TEXT NOT NULL DEFAULT 'failed',-- latest / outdated / failed
  refresh_seconds INTEGER NOT NULL DEFAULT 0,  -- 面板刷新间隔（在线判定用）
  last_online_time TEXT NOT NULL DEFAULT '',   -- 最后上线时间（离线判定用）
  first_seen TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_devices_online ON devices(last_online_time);

CREATE TABLE IF NOT EXISTS app_prefs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  setting_key TEXT NOT NULL,
  setting_value TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(user_id, setting_key)
);
CREATE INDEX IF NOT EXISTS idx_app_prefs_user ON app_prefs(user_id);

CREATE TABLE IF NOT EXISTS rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  domain TEXT NOT NULL,
  action TEXT NOT NULL,
  remark TEXT
);
CREATE INDEX IF NOT EXISTS idx_rules_domain ON rules(domain);

CREATE TABLE IF NOT EXISTS subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  url TEXT NOT NULL,                          -- 规范化后的订阅地址（https，去 query/fragment）
  name TEXT NOT NULL DEFAULT '',
  rule_count INTEGER NOT NULL DEFAULT 0,
  last_status TEXT NOT NULL DEFAULT '',
  last_fetched_at TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL,
  UNIQUE(url)
);
CREATE INDEX IF NOT EXISTS idx_subscriptions_time ON subscriptions(updated_at);
```

> 老库缺列要分开看：`/api/logger` 首次访问会按 `db_meta` 版本表自动迁移
> （v2 自动补 `ip` / `username` 列并建 `devices` 表，v1 自动补 `first_time`），
> `type`/`value`/`params`/`source` 得按 `sql/schema.sql` 末尾的 `ALTER TABLE` 语句手工补齐；
> 历史脏数据（策略被写成参数名、`first_time` 为空）可以跑
> `node scripts/repair-logs.mjs`（默认 dry-run，加 `--apply` 才执行）。

### 5. 验证部署

- 打开 `https://<项目名>.pages.dev`：面板正常加载、能拉到规则列表；
- 点击首页实时统计的「来源设备」卡片：进入设备检测综合视图，基础检测自动执行，数据库连通 / Schema / 读权限应为通过（写令牌未录入时为警告项），多设备在线状态与配置告警在同一视图展示；
- 访问 `https://<项目名>.pages.dev/api/logger/meta`：返回 JSON（含 `writeAuthRequired` 与 `version` 字段）而非 HTML；
- 访问 `https://<项目名>.pages.dev/api/export?policy=proxy`：返回订阅文本（默认带 `# Generated by` 统计头），说明固定订阅地址可用；
- 之后 Surge 端把 `FINAL_WEB_URL` 填成 `https://<项目名>.pages.dev`、`FINAL_DB_TOKEN` 填第 3 步的上报令牌即可（中转地址自动补全，见下文「Surge 安装教程」）。

### 关键地址与命令速查

| 项 | 值 |
|---|---|
| 网页面板 / PWA 安装 | `https://<项目名>.pages.dev` |
| Surge 面板地址（`FINAL_WEB_URL`） | `https://<项目名>.pages.dev`（中转地址自动补全 `/api/logger`） |
| 上报接口 | `…/api/logger/hit`（Bearer `PANEL_HIT_TOKEN`，令牌必配） |
| 建表 DDL | `…/api/schema`（全量）、仓库 `sql/schema.sql` |
| 本地构建 | `npm install` → `npm run build`（Node ≥ 22） |
| 本地手动部署 | `npx wrangler pages deploy ./dist --project-name=<Pages项目名> --branch=main`（需 `wrangler login` 或 `CLOUDFLARE_API_TOKEN`） |
| 本地开发 | `cp .dev.vars.example .dev.vars` 填 Turso 地址令牌 → `npm run dev` → `http://localhost:8788`（详见「本地调试教程」） |
| 测试 | `npm test` |

> ⚠️ `package.json` 的 `npm run deploy` 写死 `--project-name=final`——若你的 Pages 项目名不是
> `final`（Git 集成创建时默认用仓库名），手动部署请用上表的 wrangler 命令带上真实项目名，
> 否则会部署到另一个项目。

## 版本与更新、设备检测、AI 分流自动化与多数据库工厂

### AI 配置导航：Cloudflare Workers AI 自动分流（v1.3.0）

「🤖 AI配置」页在原有「提示词 + 匹配值复制」之上，正式接入 **Cloudflare Workers AI**，
实现规则库的全自动智能分流与注释补全闭环（`/api/ai`，实现位于 `functions/api/_ai/`）：

- **连接与模型识别**：填入 Cloudflare Account ID + Workers AI API Token，
  「🔄 拉取模型列表」动态获取账号下可用的文本生成模型（默认
  `@cf/meta/llama-3.1-8b-instruct`），「🧪 测试连接」跑一条最小推理验证连通。
  Token 只存服务端（偏好表保留用户 `system`，通用 prefs 接口拒绝读写该用户），
  面板回显仅掩码（`••••` + 末 4 位），原文永不下发；
- **智能过滤与优先级调度**：候选 = 「未分流」（策略仍是捕获默认 PROXY）或
  「无注释」（备注为空）且未被处理过的规则；带 ✏️ 标记的规则（快速编辑保存过，
  规则表策略列有徽标）排到队列最前优先处理，且 **AI 不改写其手工策略**、
  只补全空注释——手动调整的结果永远优先；
- **定时与限流**：执行周期（30 分钟 ~ 每天 / 自定义分钟）、单次查询数量（1~100）、
  条间调用间隔（毫秒）均可配，全局开关一键暂停；处理过的规则打 `ai_processed`
  标记防止重复分析，「♻️ 重置处理标记」可全量重跑；
- **自动化闭环**：AI 输出严格 JSON（`{"policy":"PROXY|DIRECT|REJECT","comment":"…"}`），
  解析失败 / 策略非法的条目计失败并跳过写库，连续 3 次传输失败自动中止本轮、
  剩余留给下一轮；结果直接回写规则表，实现自动归类 + 注释补全 + 分流，免人工干预；
- **双通道调度**：① 前端调度器——面板打开期间每分钟检查周期到期即自动消化队列；
  ② 外部触发——Cloudflare Pages 无原生 cron，7×24 无人值守用任意外部定时器按周期
  请求 `POST /api/ai/run?token=写接口令牌`（也接受 `Authorization: Bearer` 头）。
  端点内置冷却 + 单飞守卫（running 标记 15 分钟过期自动恢复），两通道并存不会重复执行。

外部定时器示例（任选其一，周期与面板「执行周期」一致即可）：

```bash
# cron-job.org：URL 填 https://<你的域名>/api/ai/run?token=<写接口令牌>，方法 POST
# NAS / 服务器 crontab（每 6 小时）：
0 */6 * * * curl -fsS -X POST "https://<你的域名>/api/ai/run?token=<写接口令牌>"
```

```js
// Cloudflare Worker cron trigger（每 6 小时，免第三方服务）：
export default {
  scheduled: async (_event, env) => {
    await fetch(`https://<你的域名>/api/ai/run?token=${env.PANEL_TOKEN}`, { method: 'POST' });
  }
};
```

数据库 schema v3：`surge_logs` 新增 `manual_edited`（✏️ 标记）与 `ai_processed`
（AI 已处理标记）两列，首次访问任意接口自动迁移，无需手工建表。

### 多设备状态检测与设备检测综合视图（v1.2.0）

首页实时统计的「来源设备」卡片可点击，进入 **📱 设备检测** 综合视图（顶部导航不再
单列「🩺 配置检测」，设置页的「🧭 版本与更新」也已并入），一个视图聚合：

- **设备在线状态**：每台设备一行（用户组 · 型号 · 来源 IP · 版本 · 最后上线时间），
  汇总徽标展示在线统计（如「在线 3 / 10」）。在线判定基于请求时间戳超时：
  最后上线时间距今超过 `max(5 分钟, 2 × 设备上报的刷新间隔)` 即离线——面板默认
  600 秒刷新一次，只按 5 分钟判会把正常设备误判离线，因此以设备自己的刷新节奏兜底；
- **配置告警分级**（按严重程度着色，醒目展示）：🔴 校验失败（设备从未上报组件
  版本）→ 🟠 配置过期（组件版本落后于服务端部署版本）→ ⚪ 离线；Surge 面板正文
  同步渲染在线统计与前 3 条告警；
- **配置检测**：原独立页的全部能力（基础 / 深度检测、诊断报告复制）原样并入；
- **版本与更新**：原设置页看板整体并入，顶栏更新徽标点击直达。

多设备识别的三个维度（解决「仅靠设备型号无法区分同型号多设备」）：

| 维度 | 来源 | 说明 |
|---|---|---|
| 用户组 / 用户名 | 模块参数 `FINAL_USER` → 持久化 `final_db_config.username` | 面板心跳与捕获上报自动携带 |
| 来源 IP | 中转后端从请求连接捕获（`CF-Connecting-IP`） | Surge 端拿不到自己的公网出口 IP，由服务端解析最可靠 |
| 客户端标识 | 面板生成的 clientId（两脚本共用持久化） | 跨网络稳定；旧客户端回落 用户名\|型号\|IP 三元组 |

规则表同步新增「来源 IP」列（与来源 / 用户名一起参与搜索），表头支持
「🧱 列显示」多选配置各列显隐；主题、导航位置、筛选下拉框、列显隐、导出筛选
等个性化状态全部持久化到数据库（偏好表），跨设备同步；列显隐等高频变更走
「本地缓存 + 防抖合并写入」，不产生写库压力。

### 版本体系与一致性比对

`package.json` 的语义化版本 + git 短哈希 + 构建时间合成「构建清单」（唯一事实来源），
`npm run build` 第一步由 `scripts/inject-version.mjs` 注入到全部运行产物：

| 产物 | 注入内容 | 展示位置 |
|---|---|---|
| `functions/_utils/build-meta.js` | 后端版本常量 | `/api/logger/meta` 的 `version` 字段 |
| `public/js/version.js` | 前端版本常量 | 设置页版本看板、页面横幅 |
| `surge/final-panel.js` | 文件头 `SCRIPT_VERSION` | Surge 面板正文、心跳上报 |
| `surge/final-logger.js` | 文件头 `SCRIPT_VERSION` | 上报响应比对、`final_logger_meta` 自报 |
| `surge/final.sgmodule` | 模块头版本注释 + script-path `?v=` 参数 | Surge 模块列表 |
| `public/sw.js` / `public/index.html` | SW 缓存命名空间版本串 / 入口脚本 `?v=` 参数 | 发版即整体失效 |

- 服务端单一出口：`/api/logger/meta`（no-store）返回 `version.serverVersion`、
  `version.components`（panel / logger / sgmodule）与 `version.dbSchemaVersion`；
- 三类客户端握手：网页启动时既有 meta 请求比对自身常量 → 顶部横幅「发现新版本，点击刷新」；
  Surge 面板脚本在既有 `/stats` 响应里读 `latest` → 面板正文渲染版本行；
  捕获脚本本地副本在 `/hits` 响应里读 `latestLoggerVersion` → 写入持久化键
  `final_logger_meta`，面板读取后提示「重新另存本地脚本」（本地副本无法自更新，闭环止于提示）；
- 判定分级：一致（绿）/ 小版本落后（黄，建议更新）/ 大版本落后（红，上报协议可能不兼容）/
  客户端领先（蓝，服务端待部署——自托管先更网页后部署后端是正常操作，只提示不阻塞）；
- 发版规则：上报协议或 `final_db_config` 持久化键结构变更必须递增次版本；
  表结构变更递增 `DB_SCHEMA_VERSION`（独立于 JS 版本，见 `functions/_utils/db/ddl.js`）；
- **自托管者注意**：sgmodule 的 script-path 默认指向 `https://final-axx.pages.dev/surge/…`，
  fork 部署时设环境变量 `FINAL_PANEL_ORIGIN=<你的域名>` 后重新执行 `npm run build`，
  三件套会重新注入为你自己的域名（静态文件随 dist 发布，`/surge/*` 带 max-age=300 与
  版本参数双保险，替代 GitHub raw 的边缘缓存与可达性问题）。

### 部署健康检测（配置检测，已并入设备检测视图）

进入「📱 设备检测」综合视图即自动执行基础检测（单次请求，无逐项轮询）：

- **basic（全只读）**：环境变量在位与格式 → 数据库 ping → Schema 一致性（表 / 列 /
  `DB_SCHEMA_VERSION`）→ 读权限 → 令牌在位性 → Surge 客户端心跳状态；
- **deep（需二次确认）**：向独立的 `health_probe` 表写入带唯一标记的探针行 → 同一
  批量事务内读回比对并删除（失败自动回滚，任何情况不留残留）→ 写令牌强制校验 →
  上报令牌匹配校验；服务端按来源 IP 每分钟节流一次；
- 失败项可展开看修复建议与 readme 锚点；「复制诊断报告」输出服务端已脱敏的纯文本
  （只留主机名，不含令牌与完整地址）；
- 客户端连通状态：Surge 面板脚本每次刷新在既有 `/stats` 请求上捎带心跳
  （客户端标识随机生成并持久化于 `final_db_config`，不采集个人信息），两个刷新周期
  （约 20 分钟）无心跳判离线；最近心跳、客户端版本与版本比对结果和设置页版本看板共用数据。

### 多数据库工厂（DB_BACKEND）

数据访问统一走 `_utils/db/factory.js` 的适配器契约（`execute` / 原子 `batch` / `ping` /
幂等迁移，统一 `{rows, changes}` 结果与 `DbError` 错误归类），业务层不出现任何后端品牌：

| DB_BACKEND | 配置来源 | 适用场景 |
|---|---|---|
| `turso`（默认） | `TURSO_API_URL` + `TURSO_AUTH_TOKEN` | 现有部署，零改动 |
| `d1` | Pages 平台绑定 D1（绑定名 `DB_D1`，wrangler.toml 有注释示例） | Cloudflare 生态内闭环，免外部服务与配额双算 |
| `sqlite` | `DB_SQLITE_PATH` 指定本地库文件（需 Node ≥ 22.5） | 自托管 Node；本地调试免 Turso |

- 未配置时默认 turso，行为与旧版完全一致；填非法值启动即 400 并列出合法值；
- 迁移以 `db_meta` 版本表为准（幂等）：全新库一次建全、历史库自动补列并补建
  `health_probe` / `client_heartbeats` 新表、未来库（版本号更新）放行并告警；
- 不做跨库自动搬迁：切换数据库属运维操作，走既有导出与导入路径。

## 本地调试教程

本地跑的就是线上同一套代码：`wrangler pages dev` 在本地起 workerd 执行 Functions，
变量从 `.dev.vars` 读，数据打到 `.dev.vars` 里填的那个 Turso 远端库（填生产库就连生产库）。
不想连远端时在 `.dev.vars` 里配 `DB_BACKEND="sqlite"` + `DB_SQLITE_PATH="./local.db"`
（workerd 不含 node:sqlite 实现，sqlite 后端仅适用于自托管 Node 与测试，本地 dev 仍建议直连 Turso）。
全程 4 步。

### 1. 安装依赖

Node ≥ 22（`package.json` 的 `engines` 字段），然后 `npm install`。

### 2. 填本地变量 `.dev.vars`

```bash
cp .dev.vars.example .dev.vars
```

`wrangler pages dev` 启动时自动读根目录的 `.dev.vars`，启动日志里的
`Using secrets defined in .dev.vars` 与随后的 bindings 表可以确认读到了。
必填两项：

| 变量 | 必填 | 说明 |
|---|---|---|
| `TURSO_API_URL` | ✅ | 数据库地址，`https://` 开头（`libsql://` 在 Workers 里同样解析不了） |
| `TURSO_AUTH_TOKEN` | ✅ | 访问令牌 |

缺变量时，除 `/api/schema` 这种不碰库的接口外全部返回 400，`error` 文案固定指向
Cloudflare Pages 控制台——本地看到这条同样是缺变量，别真去控制台找。两个令牌变量本地可选，
但建议按生产同值填，否则本地现象和线上对不上：

- `PANEL_HIT_TOKEN`：不配时 `/api/logger/hit` 一律 401；
- `PANEL_WRITE_TOKEN`：不配时写接口（删除 / 降维 / 批量 / 清空）不校验令牌，
  只读响应多一个 `Warning: 299 warn-1 "write-auth-not-configured"` 头，
  `/api/logger/meta` 的 `writeAuthRequired` 为 `false`。

两个令牌变量示例文件里没有，要自己补两行（`PANEL_HIT_TOKEN=...` /
`PANEL_WRITE_TOKEN=...`），填成与生产相同的值即可。

`.dev.vars` 已被 `.gitignore` 排除，里面是真实令牌，不要提交。

### 3. 启动

日常改代码用这条：先构建一次，再同时跑文件监听和本地服务。

```bash
npm run dev
```

只想看当前 `dist/` 产物（前端没动过）用 `npm run preview`。

两条命令内部都是同一条 `wrangler pages dev ./dist --compatibility-date=2026-10-12 --proxy=8787`，
服务监听 **http://localhost:8788**：`--proxy=8787` 是 wrangler 早已废弃的参数，不决定端口，
真正生效的是 `--port` 的默认值 8788；想固定成 8787 就自己加 `--port 8787`。

`npm run dev` 由 concurrently 托管两个子进程，Ctrl+C 会一起退出，日志分别带 `[0]`
（`scripts/watch-public.mjs` 监听）和 `[1]`（wrangler 服务）前缀。改动生效范围：

- 只改 `public/`：监听脚本把整个 `public/` 拷进 `dist/`，**手动刷新浏览器**即可
  （命令没开 `--live-reload`，页面不会自动重载）；
- 改了 `functions/`、`sql/`、`wrangler.toml`：监听不管，Ctrl+C 后重跑 `npm run dev`
  （它每次都会重新 `npm run build`）；
- 从 `public/` 里删了文件：拷贝不会顺手清理 `dist/` 的残留，重新 build 一次最稳。

### 4. 冒烟验证

服务起来后按顺序打这几个接口（`<token>` 填 `.dev.vars` 里的 `PANEL_HIT_TOKEN`）：

```bash
# 返回 JSON 而不是 index.html，说明 Functions 路由和 Turso 变量都通了
curl http://localhost:8788/api/logger/meta
curl http://localhost:8788/api/schema

# 固定订阅导出：默认带统计注释头，policy=proxy 只出 PROXY 规则
curl 'http://localhost:8788/api/export?policy=proxy'

# 上报：令牌对 200，令牌错 401
curl -X POST http://localhost:8788/api/logger/hit \
  -H 'Authorization: Bearer <token>' -H 'Content-Type: application/json' \
  -d '{"hostname":"local-check.example.com","policy":"PROXY"}'

# 写接口：因为本地配了 PANEL_WRITE_TOKEN，不带令牌会 401
curl -X POST http://localhost:8788/api/logger/delete \
  -H 'Content-Type: application/json' -d '{"hostname":"x.com"}'
```

再打开 http://localhost:8788 看面板。本地最常见的失败是 Turso 地址写成 `libsql://`
或令牌过期，原因都会直接写在接口响应里。

### 本地调试注意

- 本地连的是 `.dev.vars` 里填的 Turso 库，删除 / 降维 / 清空 / 批量覆盖都落在真实数据上；
  要造样本就用 `/api/logger/hit` 上报几个测试域名。
- 脚本里的 `--proxy`、`--script-path` 都是 wrangler 的废弃参数，本项目只为不改动脚本而保留，
  自己加参数请用 `--port`。
- 端口被占用时 wrangler 只抛一句 `Address already in use`，详细日志在它自己写出的
  wrangler 日志目录（macOS 为 `~/Library/Preferences/.wrangler/logs/`）。

## Surge 安装教程

前置：已按上文「部署教程」完成后端部署与建表，拿到 `https://<项目名>.pages.dev` 主域名。

以下 raw 地址均指向 `main` 分支。架构说明：FINAL 模块外链直装，包含统计面板、
配置下发和捕获脚本模板；捕获脚本是规则脚本，只支持本地文件，在 Surge 脚本
编辑器里把模板另存为本地脚本即可（无需手动复制粘贴代码）。
配置只需在模块参数表里填一次，面板刷新时写入 Surge 持久化（键 `final_db_config`），
捕获脚本从同一持久化键读取，两端共用。

### 1. 安装 FINAL 模块（外链直装）

Surge → 模块 → 安装外部模块，粘贴以下地址：

```
https://raw.githubusercontent.com/mxd8/final/main/surge/final.sgmodule
```

安装后在模块参数表（Surge → 模块 → 点开本模块 → Parameters）里填：

- `FINAL_WEB_URL`：网页管理面板地址（必填），中转地址自动补全 `/api/logger`
  （误填接口地址也能识别），同时显示在统计面板底部
- `FINAL_DB_TOKEN`：上报令牌（必填），与后端环境变量 `PANEL_HIT_TOKEN` 一致
- `FINAL_POLICY`：捕获脚本写库记录的策略名，默认 `PROXY`（见下文第 3 步）
- `FINAL_USER`：用户组 / 用户名（可选，多设备场景区分设备归属，如「iPhone-主人」；
  随上报自动携带入库，与来源 IP 一起用于区分同型号多设备）
- `FINAL_REFRESH`：面板自动刷新间隔秒数，默认 `600`（同时参与设备在线状态判定）

参数用 Surge 官方参数表声明（`#!arguments=`），装载时 Surge 把正文里的 `{{{参数}}}`
占位符替换成实际值，经 `[Script]` 行的 `argument=` 传给面板脚本——改配置只动参数表。
面板刷新一次后配置即写入持久化（首页打开面板或等 `FINAL_REFRESH` 到期均可）。

### 2. 另存捕获脚本为本地文件（规则脚本只支持本地文件）

模块已把捕获脚本引用为模板 `final-logger-src`（内容即 `surge/final-logger.js`，
随仓库自动更新），直接在 Surge App 内完成另存，无需去网页复制代码：

1. 打开 Surge App → 脚本（脚本编辑器），找到模块引用的 `final-logger-src` 并打开；
2. 保存为新文件，脚本命名为 `final-logger`；
3. 不需要在脚本里改任何配置——后端地址、上报令牌、策略名都由第 1 步的
   持久化配置提供（脚本里没有占位符，直接保存即可）。

> 💡 建议模块装好、参数填好、面板刷新一次后再另存本地脚本：捕获脚本读不到
> 持久化配置时会静默放行（不写库、不阻断代理），配置好后下一次命中即自动生效。
> 模板更新后重复本步（再次另存覆盖本地 `final-logger`）即可升级捕获脚本。

### 3. 添加触发规则

到 配置 → 规则分流，在规则列表最末（原 `FINAL,<策略>` 规则的位置）添加：

```
SCRIPT,final-logger,<你的默认策略>
```

所有未被前面规则命中的连接都会触发该脚本写库，随后按此处的策略转发——
它接管了原 FINAL 规则的兜底职责，策略请与原 FINAL 规则保持一致。

Surge 不向规则脚本暴露命中策略（官方 `$request` 只有 hostname / port 等请求字段），
写库记录的策略名取自模块参数 `FINAL_POLICY`，请把两者改成同一个值。

参数缺失 / 网络失败一律静默放行，绝不阻断代理。

捕获脚本自带**去重缓冲**：同一主机名 5 秒内的重复命中只在本地累计次数，
攒满 20 个不同主机名或窗口到期才一次性 POST `/api/logger/hits` 批量上报；
上报失败整批放回缓冲，下次命中自动补报。DNS 解析失败的占位命中不算真实
规则，不再入库。这把写库 QPS 从「每次命中一个请求」降到「每个窗口一个请求」，
绝大多数触发不再发网络请求，代理链路不再被上报拖慢（超时 3 秒）。

> 🔒 **安全提醒**：数据库令牌（`TURSO_AUTH_TOKEN`）只存在 Cloudflare 侧。Surge 端
> 保存的上报令牌（与后端 `PANEL_HIT_TOKEN` 一致，必填）仅用于 `/hit` 鉴权，
> 由面板写入本机持久化供捕获脚本读取。

两个脚本必须保持单文件（Surge 按单 URL 加载执行），无法模块化。

## 测试

`npm test` 依次跑三个文件，都不联网、不碰真实数据库：

- `tests/e2e.mjs`：端到端走**真实 SqliteAdapter**（`DB_BACKEND=sqlite` 本地文件库）——
  测试与生产同一条执行路径（`adapter.execute` / 原子 `batch` / 统一 changes 形状），
  覆盖鉴权（含双令牌合并与空段、prefs 读删鉴权）、SSRF 过滤、规则解析语义、导出格式、
  批量分块、固定订阅 `/api/export` 的偏好筛选、批量上报 `/hits`、事务回滚与
  数据库故障注入（打桩适配器原型），并跑真实 `wrangler build` 校验 `_routes.json`
  覆盖全部 API 子路径；另覆盖版本握手（meta 版本清单、latest 捎带、全产物版本戳一致性）、
  心跳注册表与 `/api/health` 基础 / 深度检测（含探针无残留、节流、令牌门禁）；
- `tests/db-adapters.test.mjs`：适配器契约测试——同一组断言跑全部后端
  （turso 本地 https mock、D1 本地模拟绑定、node:sqlite 真实库），外加
  `ensureSchema` 三态迁移（全新 / 历史补列 / 未来版本放行）与工厂校验（非法后端、
  缺配置、配置签名缓存、失败逐出）。这是新后端的准入门槛：任何新适配器
  （Upstash、Supabase 等）通过全部契约断言才算接入；
- `tests/surge-scripts.test.mjs`：用 `node:vm` 沙盒模拟 Surge 脚本环境
  （`$httpClient` / `$persistentStore` / `$argument`），断言 `surge/` 下三个文件的行为契约
  （含版本常量、心跳头、clientId 合并、latest 握手与自托管 script-path）。

三份文件都是行为契约的机器化描述，有意保持单文件、随行为同步维护。

## 重构与演进

**等价重构**（已完成）：分层拆分与注释清理，不改变运行逻辑、API 契约、SQL 语句与
Surge 脚本行为——

- 复杂度目标：单文件约 300 行、单函数约 30 行，`api/` 只留路径分发，实现全部下沉
  `_utils` 与 `api/_*`。`tests/` 下的两个文件按约定保持单文件；
  `public/js/edit.js`（337 行）与 `_subscribe/extract.js` 里的 `fetchWithRetry`
  是少数已知超限处，拆分优先级低于功能交付；
- 删除了确认无调用方的死代码（`validateRuleItem`、`cpFetchExport`、未使用的常量表等）与历史遗留注释；
- 前端由单文件改为 20 个 ES Module，依赖严格单向；
- `npm test` 全绿 + `wrangler pages functions build` 通过，为等价性提供机器验证。

**重构之后的行为变化**（本文档其余章节已按此描述，测试同步覆盖）：

- 新增固定订阅导出 `/api/export`：筛选条件存偏好表 `user=export`，Surge 端订阅地址不随筛选变化；
- 降维候选包含当前掩码（v4 `/32→/24→/16→/8`、v6 `/128→/64→/48→/32→/16`），
  汇总行从受害行继承来源，并把「共 X 次触发」累计进 `count`；
- 订阅抓取改为带重试（3 次、递增退避、30 秒总预算），并对日志里的订阅地址脱敏；
- 面板 GET 请求统一加缓存击破参数，写操作后立刻回读即可看到新数据，不必手动刷新网页；
- 面板改为四视图导航（首页 / 数据 / AI配置 / 设置），新增导航位置与主题色偏好、
  表格整行点击进快速编辑弹窗、导出「最近 N 天」档位与按钮实时数量。

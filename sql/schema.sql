-- ============================================================================
-- 数据库初始化脚本（一次性执行）
--
-- 执行方式任选其一：
--   · 在 Turso 控制台的 Shell 页面粘贴执行
--   · turso db shell my-database 里粘贴
--   · turso db query my-database --run <schema.sql>
--
-- 说明：所有语句都是 IF NOT EXISTS，可以重复执行，不会破坏已有数据。
-- 新增列用 ALTER TABLE 补齐；已有旧库请按文件末尾的迁移说明处理。
-- 部署后也可访问 /api/schema 取回同一份 DDL。
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. FINAL 捕获记录 / 规则表
--
-- 字段与 Surge 规则结构一一对应，因此 DOMAIN、DOMAIN-SUFFIX、DOMAIN-KEYWORD、
-- PROCESS-NAME、IP-CIDR、IP-CIDR6、GEOIP、AND/OR/NOT 等任意规则类型都能无损
-- 保存与导出，参数（no-resolve / pre-matching / notification-text=… ）原样保留。
--
-- hostname 列有唯一索引：写入依赖 ON CONFLICT(hostname) 做 upsert，并发命中
-- 不会产生重复行。hostname 存的是「匹配值」（域名或 IP 字面量）。
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS surge_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    -- 匹配值：域名 / 单个 IP / CIDR 段 / 进程名等
    hostname TEXT NOT NULL,
    -- 规则类型：DOMAIN、DOMAIN-SUFFIX、IP-CIDR、IP-CIDR6、PROCESS-NAME、GEOIP …
    type TEXT NOT NULL DEFAULT 'DOMAIN-SUFFIX',
    -- 匹配值的规范形式（如 10.0.0.5/32），与 hostname 同义但显式分列，便于导出
    value TEXT NOT NULL DEFAULT '',
    -- 策略：PROXY / DIRECT / REJECT / 自定义策略组 / DEVICE:<name>
    policy TEXT NOT NULL DEFAULT 'PROXY',
    -- 可选参数，逗号分隔：no-resolve,pre-matching,notification-text=xxx
    params TEXT NOT NULL DEFAULT '',
    -- 备注，导出规则时作为 // 注释输出
    comment TEXT NOT NULL DEFAULT '',
    -- 规则来源：上报设备名（Surge 的 $status.name）或手工填写
    source TEXT NOT NULL DEFAULT '',
    -- 来源 IP：上报设备的公网出口 IP（中转后端从请求连接捕获），区分同型号多设备
    ip TEXT NOT NULL DEFAULT '',
    -- 用户名 / 用户组：Surge 模块参数 FINAL_USER，随上报自动携带
    username TEXT NOT NULL DEFAULT '',
    -- 首次命中时间，UTC ISO 字符串；upsert 冲突后保持不变，只在首次插入时写入
    first_time TEXT NOT NULL DEFAULT '',
    -- 最近一次命中时间，UTC ISO 字符串；面板按设备本地日统计「今日新增」
    time TEXT NOT NULL,
    -- 触发次数，命中一次 +1
    count INTEGER NOT NULL DEFAULT 1
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_surge_logs_hostname ON surge_logs(hostname);
CREATE INDEX IF NOT EXISTS idx_surge_logs_time ON surge_logs(time);
CREATE INDEX IF NOT EXISTS idx_surge_logs_type ON surge_logs(type);
CREATE INDEX IF NOT EXISTS idx_surge_logs_source ON surge_logs(source);
CREATE INDEX IF NOT EXISTS idx_surge_logs_username ON surge_logs(username);

-- ---------------------------------------------------------------------------
-- 2. 来源设备注册表（v2 新增）
--    每个上报来源（面板心跳 / 捕获脚本批量上报）登记一行：
--    在线状态（最后上线时间 + 刷新间隔推算）、配置状态（组件版本比对）、
--    用户组与来源 IP，支撑实时统计面板的 n/m 在线统计与分级告警。
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS devices (
    -- 设备标识：面板 clientId（client: 前缀）或 用户名|设备名|IP 三元组（dev: 前缀）
    device_id TEXT PRIMARY KEY,
    -- 设备型号（$environment device-model）
    name TEXT NOT NULL DEFAULT '',
    -- 用户组 / 用户名（模块参数 FINAL_USER）
    username TEXT NOT NULL DEFAULT '',
    -- 最近一次上报的来源 IP
    ip TEXT NOT NULL DEFAULT '',
    -- 面板脚本自报版本
    panel_version TEXT NOT NULL DEFAULT '',
    -- 捕获脚本自报版本
    logger_version TEXT NOT NULL DEFAULT '',
    -- 配置状态：latest（最新）/ outdated（过期）/ failed（无法校验）
    config_status TEXT NOT NULL DEFAULT 'failed',
    -- 设备上报的面板刷新间隔秒数（参与离线窗口计算，0 = 未上报）
    refresh_seconds INTEGER NOT NULL DEFAULT 0,
    -- 最后上线时间（UTC ISO）：超过离线窗口无请求即判定离线
    last_online_time TEXT NOT NULL DEFAULT '',
    first_seen TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_devices_online ON devices(last_online_time);

-- ---------------------------------------------------------------------------
-- 3. 用户偏好（前端个性化设置，跨设备同步）
--    user_id 是前端生成的随机设备标识，不是账号体系；
--    setting_value 为 TEXT，布尔与数字都序列化存储，由前端按键解析。
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS app_prefs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    setting_key TEXT NOT NULL,
    setting_value TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(user_id, setting_key)
);

CREATE INDEX IF NOT EXISTS idx_app_prefs_user ON app_prefs(user_id);

-- ---------------------------------------------------------------------------
-- 4. 订阅规则（已并入 surge_logs，保留表结构仅为兼容旧部署）
--    新版本不再读写这张表：规则统一存 surge_logs，来源与规则类型一并记录。
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    domain TEXT NOT NULL,
    action TEXT NOT NULL,
    remark TEXT
);

CREATE INDEX IF NOT EXISTS idx_rules_domain ON rules(domain);

-- ---------------------------------------------------------------------------
-- 5. 订阅源清单（URL 规则订阅解析功能）
--    只存「地址 + 名称 + 最近抓取状态」，不存规则内容：内容是拉下来时才有的东西，
--    存副本会立刻过期，也会让「重新解析」失去意义。
--
--    为什么不放 surge_logs：订阅源是独立实体，塞进规则表会让一行规则背上无关字段。
--    为什么不放 app_prefs：偏好表按前端生成的设备标识分区、可被任意读取，
--    而订阅清单是跨设备共享的东西，放进去 semantically 也不对。
--
--    UNIQUE(url) 依赖调用方先做规范化（去查询串/片段/尾斜杠、hostname 小写），
--    规范化逻辑在 functions/_utils/subscriptions.js 的 normalizeSubscriptionUrl。
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS subscriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    -- 规范化后的订阅地址（https only，去掉 ?query 与 #fragment 与结尾斜杠）
    url TEXT NOT NULL,
    -- 用户给订阅起的名字，显示在面板下拉框里
    name TEXT NOT NULL DEFAULT '',
    -- 最近一次成功解析提取到的规则条数
    rule_count INTEGER NOT NULL DEFAULT 0,
    -- 最近一次抓取结果：ok 或失败原因（长度受限，见 MAX_STATUS_LENGTH）
    last_status TEXT NOT NULL DEFAULT '',
    -- 最近一次抓取时间，UTC ISO 字符串
    last_fetched_at TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL,
    UNIQUE(url)
);

CREATE INDEX IF NOT EXISTS idx_subscriptions_time ON subscriptions(updated_at);


-- ============================================================================
-- 已有旧表时的迁移语句（新建库无需执行）
--
-- 「所有旧数据不用保留」时的最简单做法：直接删表重建，一条命令搞定：
--   DROP TABLE IF EXISTS surge_logs;   然后重跑上面 surge_logs 的 CREATE 语句
--
-- 想保留旧记录再迁移，按顺序执行下面几段：
-- ============================================================================
-- 补齐缺失列（已存在的列 ALTER 会报错，报错说明该列已就位，忽略即可）：
--   ALTER TABLE surge_logs ADD COLUMN type TEXT NOT NULL DEFAULT 'DOMAIN-SUFFIX';
--   ALTER TABLE surge_logs ADD COLUMN value TEXT NOT NULL DEFAULT '';
--   ALTER TABLE surge_logs ADD COLUMN params TEXT NOT NULL DEFAULT '';
--   ALTER TABLE surge_logs ADD COLUMN source TEXT NOT NULL DEFAULT '';
--   ALTER TABLE surge_logs ADD COLUMN first_time TEXT NOT NULL DEFAULT '';
--   ALTER TABLE surge_logs ADD COLUMN ip TEXT NOT NULL DEFAULT '';        -- v2：来源 IP
--   ALTER TABLE surge_logs ADD COLUMN username TEXT NOT NULL DEFAULT ''; -- v2：用户名/用户组
--
-- v2 新增设备注册表（在线状态 / 配置告警），直接执行上文 devices 的 CREATE 语句即可
--
--   （部署后 /api/logger 首次被访问也会自动补列，见 functions/_utils/logs.js 的 MIGRATIONS）
--
-- 已有的 first_time 是空的（历史行），用最近一次命中时间兜底；
-- 只命中过一次的记录两者本来就相等：
--   UPDATE surge_logs SET first_time = time WHERE TRIM(first_time) = '';
--
-- 修「策略被写成参数名」的历史脏数据（旧版 isPolicyName 把 no-resolve / dns-failed
-- 当成合法策略组名，2026-10 线上有 489 条 policy=NO-RESOLVE）：
--   UPDATE surge_logs SET policy = 'PROXY'
--     WHERE UPPER(policy) IN ('no-resolve','dns-failed','extended-matching',
--                             'pre-matching','requires-resolve');
--
-- 这两项也可以用脚本一次跑完（读 .dev.vars 里的凭据）：
--   node scripts/repair-logs.mjs          # 只打印会改什么
--   node scripts/repair-logs.mjs --apply  # 真正执行
--
-- 用 hostname 回填 value（旧库的 hostname 就是匹配值）：
--   UPDATE surge_logs SET value = hostname WHERE TRIM(value) = '';
--
-- 单 IP 回填成 IP-CIDR，其余保持 DOMAIN-SUFFIX：
--   UPDATE surge_logs SET type = 'IP-CIDR', value = hostname || '/32'
--     WHERE TRIM(hostname) GLOB '[0-9]*.[0-9]*.[0-9]*.[0-9]*' AND TRIM(value) = hostname;
--
-- 若旧库已建过非唯一索引，需要先删除再建唯一索引，否则 upsert 会失败：
--   DROP INDEX IF EXISTS idx_surge_logs_hostname;
--   CREATE UNIQUE INDEX uniq_surge_logs_hostname ON surge_logs(hostname);
--
-- 若历史数据里已经有重复 hostname，先合并计数再建唯一索引：
--   UPDATE surge_logs SET count = count + 1
--     WHERE hostname IN (SELECT hostname FROM surge_logs GROUP BY hostname HAVING COUNT(*) > 1);
--   DELETE FROM surge_logs
--     WHERE hostname IN (SELECT hostname FROM surge_logs GROUP BY hostname HAVING COUNT(*) > 1)
--       AND id NOT IN (SELECT MAX(id) FROM surge_logs GROUP BY hostname);
--
-- 清空并重置自增 id（一键清空接口做的就是这个）：
--   DELETE FROM surge_logs;
--   DELETE FROM sqlite_sequence WHERE name = 'surge_logs';

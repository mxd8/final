/**
 * 数据库 schema 的唯一事实来源：建表 DDL、版本号与幂等迁移。
 *
 * 迁移机制以 db_meta 版本表为准（替代旧的「列探测 + ALTER TABLE」）：
 *   - 全新数据库     → 一次性执行 BASE_DDL，写入当前版本号；
 *   - 旧库无版本表   → 判定为历史部署：先补齐旧迁移（first_time 列），
 *                      再补建新版新增的表，最后写入版本号；
 *   - 版本号 < 当前  → 逐版本执行 MIGRATION_STEPS 里的增量语句；
 *   - 版本号 > 当前  → 数据库比代码新（先更新了库）：放行并告警，不做降级。
 *
 * DB_SCHEMA_VERSION 与 JS 版本解耦：只有表结构变化才递增，参与健康检测
 * （/api/health 的 Schema 一致性检查），不出现在版本看板。
 */

import { asDbError } from './contract.js';

export const DB_SCHEMA_VERSION = 4;

export const DB_META_TABLE = 'db_meta';
export const HEALTH_PROBE_TABLE = 'health_probe';
export const HEARTBEATS_TABLE = 'client_heartbeats';
export const DEVICES_TABLE = 'devices';
export const USERS_TABLE = 'users';
export const USER_GROUPS_TABLE = 'user_groups';
export const AUTH_SESSIONS_TABLE = 'auth_sessions';

/**
 * 建表 DDL 按单条语句拆分：Turso HTTP 管道每条语句单独执行，
 * 一个字符串里塞多条 SQL 会被拒绝（SQL string contains more than one statement）。
 * *_SCHEMA 是展示用拼接版（/api/schema 与 sql/schema.sql），*_DDL 是执行用语句数组。
 */

/** health_probe：深度检测的写 / 读回 / 删探针表，探针行同一事务写入并删除，不留残留 */
export const HEALTH_PROBE_SCHEMA = `CREATE TABLE IF NOT EXISTS ${HEALTH_PROBE_TABLE} (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  marker TEXT NOT NULL UNIQUE,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL
);`.trim();

/** client_heartbeats：Surge 面板脚本的心跳注册表（客户端标识 → 最近版本与在线时间） */
const HEARTBEATS_TABLE_DDL = `CREATE TABLE IF NOT EXISTS ${HEARTBEATS_TABLE} (
  client_id TEXT PRIMARY KEY,
  panel_version TEXT NOT NULL DEFAULT '',
  logger_version TEXT NOT NULL DEFAULT '',
  last_seen TEXT NOT NULL,
  updated_at TEXT NOT NULL
);`.trim();

const HEARTBEATS_INDEX_DDL = `CREATE INDEX IF NOT EXISTS idx_${HEARTBEATS_TABLE}_seen ON ${HEARTBEATS_TABLE}(updated_at);`.trim();

export const HEARTBEATS_SCHEMA = `${HEARTBEATS_TABLE_DDL}\n${HEARTBEATS_INDEX_DDL}`;

/**
 * devices：来源设备注册表（v2 新增）。
 * 每个上报来源（面板心跳 / 捕获脚本批量上报）在此登记一行，记录用户组、
 * 来源 IP（服务端从连接捕获）、最后上线时间与配置状态，支撑：
 *   - 在线状态统计（n/m）：last_online_time + 刷新间隔推算离线；
 *   - 同型号多设备区分：同型号但 IP / clientId 不同 → 不同 device_id；
 *   - 配置告警：config_status = latest / outdated / failed（写入时按上报版本计算）。
 */
const DEVICES_TABLE_DDL = `CREATE TABLE IF NOT EXISTS ${DEVICES_TABLE} (
  device_id TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  username TEXT NOT NULL DEFAULT '',
  ip TEXT NOT NULL DEFAULT '',
  panel_version TEXT NOT NULL DEFAULT '',
  logger_version TEXT NOT NULL DEFAULT '',
  config_status TEXT NOT NULL DEFAULT 'failed',
  refresh_seconds INTEGER NOT NULL DEFAULT 0,
  last_online_time TEXT NOT NULL DEFAULT '',
  first_seen TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL,
  device_type TEXT NOT NULL DEFAULT '',
  platform_params TEXT NOT NULL DEFAULT ''
);`.trim();

const DEVICES_INDEX_DDL = `CREATE INDEX IF NOT EXISTS idx_${DEVICES_TABLE}_online ON ${DEVICES_TABLE}(last_online_time);`.trim();

export const DEVICES_SCHEMA = `${DEVICES_TABLE_DDL}\n${DEVICES_INDEX_DDL}`;

/**
 * users / user_groups / auth_sessions：多用户与权限体系（v4 新增）。
 *   - users：账号密码用户（PBKDF2 哈希），role = admin | user，status = active | disabled；
 *     permissions 存 JSON（{features: {...}} 功能级限制，用户值覆盖用户组值）。
 *   - user_groups：用户组，组级 permissions JSON，用户可归属一组。
 *   - auth_sessions：面板登录会话（token 只存 SHA-256 哈希，原文仅下发一次）。
 */
const USER_GROUPS_TABLE_DDL = `CREATE TABLE IF NOT EXISTS ${USER_GROUPS_TABLE} (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  permissions TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);`.trim();

const USERS_TABLE_DDL = `CREATE TABLE IF NOT EXISTS ${USERS_TABLE} (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL DEFAULT '',
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user',
  group_id INTEGER,
  status TEXT NOT NULL DEFAULT 'active',
  permissions TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_login_at TEXT NOT NULL DEFAULT ''
);`.trim();

const AUTH_SESSIONS_TABLE_DDL = `CREATE TABLE IF NOT EXISTS ${AUTH_SESSIONS_TABLE} (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_used_at TEXT NOT NULL,
  user_agent TEXT NOT NULL DEFAULT ''
);`.trim();

/** 索引逐条语句（BASE_DDL / MIGRATION_STEPS 每项必须是单条 SQL，Turso 管道同约束） */
const AUTH_INDEX_STATEMENTS = [
  `CREATE INDEX IF NOT EXISTS idx_${AUTH_SESSIONS_TABLE}_user ON ${AUTH_SESSIONS_TABLE}(user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_${AUTH_SESSIONS_TABLE}_expires ON ${AUTH_SESSIONS_TABLE}(expires_at)`,
  `CREATE INDEX IF NOT EXISTS idx_${USERS_TABLE}_group ON ${USERS_TABLE}(group_id)`
];

/** 展示用拼接版（/api/schema 与 sql/schema.sql） */
export const AUTH_SCHEMA = [
  USER_GROUPS_TABLE_DDL,
  USERS_TABLE_DDL,
  AUTH_SESSIONS_TABLE_DDL,
  ...AUTH_INDEX_STATEMENTS
].join('\n');

/** devices 表 v4 增量列：来源设备类型（surge-ios / surge-mac / surge-ipad / router-plugin / api-client）与平台专属参数快照 */
const DEVICES_TYPE_COLUMN_DDL = [
  `ALTER TABLE ${DEVICES_TABLE} ADD COLUMN device_type TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE ${DEVICES_TABLE} ADD COLUMN platform_params TEXT NOT NULL DEFAULT ''`
];

const DEVICES_TYPE_INDEX_DDL = `CREATE INDEX IF NOT EXISTS idx_${DEVICES_TABLE}_type ON ${DEVICES_TABLE}(device_type);`.trim();

export const DB_META_SCHEMA = `CREATE TABLE IF NOT EXISTS ${DB_META_TABLE} (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);`.trim();

/** 执行用语句数组（每条单语句） */
export const NEW_TABLES_DDL = [DB_META_SCHEMA, HEALTH_PROBE_SCHEMA, HEARTBEATS_TABLE_DDL, HEARTBEATS_INDEX_DDL, DEVICES_TABLE_DDL, DEVICES_INDEX_DDL];

/** 全新数据库的一次性建表语句（version 3 的完整形态，与 sql/schema.sql 逐条对应） */
export const BASE_DDL = [
  `CREATE TABLE IF NOT EXISTS surge_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    hostname TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'DOMAIN-SUFFIX',
    value TEXT NOT NULL DEFAULT '',
    policy TEXT NOT NULL DEFAULT 'PROXY',
    params TEXT NOT NULL DEFAULT '',
    comment TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL DEFAULT '',
    ip TEXT NOT NULL DEFAULT '',
    username TEXT NOT NULL DEFAULT '',
    first_time TEXT NOT NULL DEFAULT '',
    time TEXT NOT NULL,
    count INTEGER NOT NULL DEFAULT 1,
    manual_edited INTEGER NOT NULL DEFAULT 0,
    ai_processed INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uniq_surge_logs_hostname ON surge_logs(hostname)`,
  `CREATE INDEX IF NOT EXISTS idx_surge_logs_time ON surge_logs(time)`,
  `CREATE INDEX IF NOT EXISTS idx_surge_logs_type ON surge_logs(type)`,
  `CREATE INDEX IF NOT EXISTS idx_surge_logs_source ON surge_logs(source)`,
  `CREATE INDEX IF NOT EXISTS idx_surge_logs_username ON surge_logs(username)`,
  `CREATE TABLE IF NOT EXISTS app_prefs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    setting_key TEXT NOT NULL,
    setting_value TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(user_id, setting_key)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_app_prefs_user ON app_prefs(user_id)`,
  `CREATE TABLE IF NOT EXISTS rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    domain TEXT NOT NULL,
    action TEXT NOT NULL,
    remark TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_rules_domain ON rules(domain)`,
  `CREATE TABLE IF NOT EXISTS subscriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    url TEXT NOT NULL,
    name TEXT NOT NULL DEFAULT '',
    rule_count INTEGER NOT NULL DEFAULT 0,
    last_status TEXT NOT NULL DEFAULT '',
    last_fetched_at TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL,
    UNIQUE(url)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_subscriptions_time ON subscriptions(updated_at)`,
  DB_META_SCHEMA,
  HEALTH_PROBE_SCHEMA,
  HEARTBEATS_TABLE_DDL,
  HEARTBEATS_INDEX_DDL,
  DEVICES_TABLE_DDL,
  DEVICES_INDEX_DDL,
  DEVICES_TYPE_INDEX_DDL,
  USER_GROUPS_TABLE_DDL,
  USERS_TABLE_DDL,
  AUTH_SESSIONS_TABLE_DDL,
  ...AUTH_INDEX_STATEMENTS
];

/**
 * 版本号 → 该版本的增量语句。历史部署（无版本表但有 surge_logs）不经过这张表，
 * 走 migrateLegacy 补齐 first_time 列与新表。新版本递增 DB_SCHEMA_VERSION 时在这里加步骤。
 */
export const MIGRATION_STEPS = {
  1: [DB_META_SCHEMA, HEALTH_PROBE_SCHEMA, HEARTBEATS_TABLE_DDL, HEARTBEATS_INDEX_DDL],
  2: [
    `ALTER TABLE surge_logs ADD COLUMN ip TEXT NOT NULL DEFAULT ''`,
    `ALTER TABLE surge_logs ADD COLUMN username TEXT NOT NULL DEFAULT ''`,
    `CREATE INDEX IF NOT EXISTS idx_surge_logs_username ON surge_logs(username)`,
    DEVICES_TABLE_DDL,
    DEVICES_INDEX_DDL
  ],
  3: [
    // v3：AI 分流调度所需标记。manual_edited = ✏️ 快速编辑过（手动调整，AI 不改写其策略）；
    // ai_processed = AI 已处理过（防止自动化每轮重复分析同一条规则）
    `ALTER TABLE surge_logs ADD COLUMN manual_edited INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE surge_logs ADD COLUMN ai_processed INTEGER NOT NULL DEFAULT 0`
  ],
  4: [
    // v4：多用户权限体系三表 + 设备类型多维度列（设备五类型 profile 适配）。
    // devices 的 device_type / platform_params 用 ALTER 补列：v3 旧库的 devices 表
    // 由 DEVICES_TABLE_DDL（v4 起含新列）CREATE IF NOT EXISTS 建的，列不存在必须补。
    ...DEVICES_TYPE_COLUMN_DDL,
    DEVICES_TYPE_INDEX_DDL,
    USER_GROUPS_TABLE_DDL,
    USERS_TABLE_DDL,
    AUTH_SESSIONS_TABLE_DDL,
    ...AUTH_INDEX_STATEMENTS
  ]
};

/** 旧库的一次性补列迁移（原 logs/schema.js 的列探测逻辑收编到这里） */
const LEGACY_MIGRATIONS = [
  `ALTER TABLE surge_logs ADD COLUMN first_time TEXT NOT NULL DEFAULT ''`
];

async function tableExists(db, table) {
  const rows = await db.execute(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`,
    [table]
  );
  return rows.length > 0;
}

async function readSchemaVersion(db) {
  try {
    const rows = await db.execute(
      `SELECT value FROM ${DB_META_TABLE} WHERE key = 'schema_version'`
    );
    const value = Number(rows[0]?.value);
    return Number.isFinite(value) ? value : null;
  } catch (error) {
    const text = String(error?.message ?? '');
    if (/no such table/i.test(text)) return null;
    throw asDbError(error);
  }
}

async function writeSchemaVersion(db, version) {
  await db.batch([
    {
      sql: `INSERT INTO ${DB_META_TABLE} (key, value) VALUES ('schema_version', ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      params: [String(version)]
    }
  ]);
}

/** 旧库补列：「列已存在」与「表不存在」都视为已完成，其余错误原样抛出 */
async function tolerantExecute(db, sql) {
  try {
    await db.execute(sql);
  } catch (error) {
    const text = String(error?.message ?? '');
    if (!/table.*does not exist|no such table/i.test(text) && !/duplicate column name/i.test(text)) {
      throw asDbError(error);
    }
  }
}

async function migrateLegacy(db) {
  for (const sql of LEGACY_MIGRATIONS) {
    await tolerantExecute(db, sql);
  }
  // 历史部署没有版本表，缺的是全部增量（v1 的健康设施表 + v2 的设备表与来源列）：
  // 从 1 起逐版本补齐，逐条容忍「已存在」，与版本路径的原子 batch 区分开
  for (let target = 1; target <= DB_SCHEMA_VERSION; target += 1) {
    for (const sql of (MIGRATION_STEPS[target] ?? [])) {
      await tolerantExecute(db, sql);
    }
  }
}

/**
 * 幂等 schema 迁移：适配器实例创建后执行一次（factory 的 ready 链），
 * 成功后在实例上标记 _schemaReady，后续请求零开销。
 */
export async function ensureSchema(db) {
  if (db._schemaReady) return;
  await db.batch([{ sql: DB_META_SCHEMA }]);
  const version = await readSchemaVersion(db);

  if (version == null) {
    if (await tableExists(db, 'surge_logs')) {
      await migrateLegacy(db);
    } else {
      await db.batch(BASE_DDL.map((sql) => ({ sql })));
    }
    await writeSchemaVersion(db, DB_SCHEMA_VERSION);
  } else if (version < DB_SCHEMA_VERSION) {
    for (let target = version + 1; target <= DB_SCHEMA_VERSION; target += 1) {
      const steps = MIGRATION_STEPS[target] ?? [];
      if (steps.length) await db.batch(steps.map((sql) => ({ sql })));
      await writeSchemaVersion(db, target);
    }
  } else if (version > DB_SCHEMA_VERSION) {
    console.warn(`[db] 数据库 schema 版本 (${version}) 比代码期望 (${DB_SCHEMA_VERSION}) 新，请升级服务端部署`);
  }

  db._schemaReady = true;
}

/** 健康检测用：核心表在位性与关键列齐全性（PRAGMA table_info 三家后端通用） */
export async function describeSchemaState(db, table, requiredColumns) {
  try {
    if (!(await tableExists(db, table))) {
      return { ok: false, detail: `缺少数据表 ${table}` };
    }
    const columns = new Set(
      (await db.execute(`PRAGMA table_info(${table})`)).map((row) => String(row.name))
    );
    const missing = requiredColumns.filter((col) => !columns.has(col));
    if (missing.length) {
      return { ok: false, detail: `表 ${table} 缺少列：${missing.join(', ')}` };
    }
    return { ok: true, detail: `${table} 表与必需列齐全` };
  } catch (error) {
    return { ok: false, detail: `表结构检查失败：${error?.message ?? error}` };
  }
}

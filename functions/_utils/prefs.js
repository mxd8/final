/**
 * 用户偏好（app_prefs）数据访问层：KV 宽表，跨设备同步个性化设置。
 * UNIQUE(user_id, setting_key) 支撑直接 upsert；值统一存 TEXT，由前端按键解析。
 */


export const PREFS_TABLE = 'app_prefs';

/** 单个偏好值长度上限，防止把整份数据当偏好写进来 */
export const MAX_PREFERENCE_LENGTH = 8192;

export const PREFS_SCHEMA = `CREATE TABLE IF NOT EXISTS ${PREFS_TABLE} (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  setting_key TEXT NOT NULL,
  setting_value TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(user_id, setting_key)
);
CREATE INDEX IF NOT EXISTS idx_${PREFS_TABLE}_user ON ${PREFS_TABLE}(user_id);`.trim();

/** 设备标识只保留安全字符 */
export function normalizeUserId(value, fallback = 'anonymous') {
  const cleaned = String(value ?? '').trim().replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
  return cleaned || fallback;
}

/** 偏好键只允许字母数字下划线点 */
function normalizeKey(value) {
  return String(value ?? '').trim().replace(/[^a-zA-Z0-9_.]/g, '_').slice(0, 128);
}

/** 读取某个用户的全部偏好，返回 { key: value } */
export async function listPrefs(db, userId) {
  const user = normalizeUserId(userId);
  const rows = await db.execute(
    `SELECT setting_key, setting_value FROM ${PREFS_TABLE} WHERE user_id = ?`,
    [user]
  );
  const settings = {};
  for (const row of rows) settings[row.setting_key] = row.setting_value;
  return settings;
}

/**
 * 批量 upsert 偏好：只写本次显式传入的键，未传入的键保持不变。
 * @returns {Promise<{saved:number}>}
 */
export async function savePrefs(db, userId, settings) {
  const user = normalizeUserId(userId);
  const entries = Object.entries(settings || {}).map(([key, value]) => {
    const k = normalizeKey(key);
    const text = String(value ?? '');
    return { k, text: text.length > MAX_PREFERENCE_LENGTH ? text.slice(0, MAX_PREFERENCE_LENGTH) : text };
  }).filter((entry) => entry.k.length > 0);

  if (entries.length === 0) return { saved: 0 };

  const now = new Date().toISOString();
  const statements = entries.map((entry) => ({
    sql: `INSERT INTO ${PREFS_TABLE} (user_id, setting_key, setting_value, updated_at)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(user_id, setting_key)
          DO UPDATE SET setting_value = excluded.setting_value, updated_at = excluded.updated_at`,
    params: [user, entry.k, entry.text, now]
  }));

  const results = await db.batch(statements);
  return { saved: results.filter((result) => result.changes > 0).length };
}

/** 删除单个偏好（恢复默认） */
export async function deletePref(db, userId, key) {
  const user = normalizeUserId(userId);
  const k = normalizeKey(key);
  if (!k) return { deleted: 0 };
  const results = await db.batch([
    { sql: `DELETE FROM ${PREFS_TABLE} WHERE user_id = ? AND setting_key = ?`, params: [user, k] }
  ]);
  return { deleted: results[0].changes };
}

/** 删除某个用户的全部偏好 */
export async function clearPrefs(db, userId) {
  const user = normalizeUserId(userId);
  const results = await db.batch([
    { sql: `DELETE FROM ${PREFS_TABLE} WHERE user_id = ?`, params: [user] }
  ]);
  return { deleted: results[0].changes };
}

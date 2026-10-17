/**
 * 订阅源清单（subscriptions）数据访问层：只存 URL 与名称和最近抓取状态，
 * 不存规则内容（内容拉取时才有，存副本会立刻过期）。
 */


export const SUBSCRIPTIONS_TABLE = 'subscriptions';

const MAX_NAME_LENGTH = 200;

export const MAX_STATUS_LENGTH = 64;

export const SUBSCRIPTIONS_SCHEMA = `CREATE TABLE IF NOT EXISTS ${SUBSCRIPTIONS_TABLE} (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  url TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  rule_count INTEGER NOT NULL DEFAULT 0,
  last_status TEXT NOT NULL DEFAULT '',
  last_fetched_at TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL,
  UNIQUE(url)
);
CREATE INDEX IF NOT EXISTS idx_${SUBSCRIPTIONS_TABLE}_time ON ${SUBSCRIPTIONS_TABLE}(updated_at);`.trim();

/** URL 不合法时抛出，路由据此返回 400 */
export class SubscriptionUrlError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SubscriptionUrlError';
  }
}

/**
 * 规范化订阅 URL：https only、去查询串与片段、去 userinfo、主机名小写、去尾斜杠。
 * 上传与缓存键两处都必须调用，否则同一订阅会以多个形态重复入库。
 */
export function normalizeSubscriptionUrl(raw) {
  const text = String(raw ?? '').trim();
  if (!text) throw new SubscriptionUrlError('订阅地址不能为空');

  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    throw new SubscriptionUrlError('订阅地址不是合法的 URL');
  }
  if (parsed.protocol !== 'https:') {
    throw new SubscriptionUrlError(`订阅地址必须使用 https:// 协议，当前为 ${parsed.protocol}`);
  }
  if (parsed.username || parsed.password) {
    throw new SubscriptionUrlError('订阅地址不能包含账号密码（userinfo）');
  }
  if (!parsed.hostname) throw new SubscriptionUrlError('订阅地址缺少主机名');

  parsed.username = '';
  parsed.password = '';
  parsed.hash = '';
  parsed.search = '';
  parsed.hostname = parsed.hostname.toLowerCase();
  parsed.pathname = parsed.pathname.replace(/\/+$/, '') || '/';
  return parsed.toString();
}

/** 订阅名去换行并截断 */
export function normalizeSubscriptionName(name) {
  return String(name ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME_LENGTH);
}

/** 读取全部订阅，按最近更新时间倒序 */
export async function listSubscriptions(db) {
  const rows = await db.execute(
    `SELECT id, url, name, rule_count, last_status, last_fetched_at, updated_at
     FROM ${SUBSCRIPTIONS_TABLE} ORDER BY updated_at DESC, id DESC`
  );
  return rows.map(normalizeSubscriptionRow);
}

function normalizeSubscriptionRow(row) {
  return {
    id: Number(row.id) || 0,
    url: String(row.url ?? ''),
    name: String(row.name ?? ''),
    ruleCount: Number(row.rule_count) || 0,
    lastStatus: String(row.last_status ?? ''),
    lastFetchedAt: String(row.last_fetched_at ?? ''),
    updatedAt: String(row.updated_at ?? '')
  };
}

/**
 * 新增或更新订阅。同 URL 重复调用只改名称，不碰抓取状态字段；
 * snapshot 只在 INSERT 新行时写入（典型流程是先解析后保存，解析时表里还没有该 URL）。
 */
export async function upsertSubscription(db, url, name, { ruleCount = 0, lastStatus = '' } = {}) {
  const normalized = normalizeSubscriptionUrl(url);
  const text = normalizeSubscriptionName(name);
  const now = new Date().toISOString();

  const existing = await db.execute(`SELECT id FROM ${SUBSCRIPTIONS_TABLE} WHERE url = ?`, [normalized]);
  const known = existing[0];
  if (known) {
    await db.batch([
      {
        sql: `UPDATE ${SUBSCRIPTIONS_TABLE} SET name = ?, updated_at = ? WHERE id = ?`,
        params: [text, now, Number(known.id)]
      }
    ]);
    return { id: Number(known.id), created: false };
  }

  const count = Math.max(0, Math.floor(Number(ruleCount) || 0));
  const status = count > 0 ? String(lastStatus || 'ok').slice(0, MAX_STATUS_LENGTH) : '';
  const results = await db.batch([
    {
      sql: `INSERT INTO ${SUBSCRIPTIONS_TABLE} (url, name, rule_count, last_status, updated_at)
            VALUES (?, ?, ?, ?, ?)`,
      params: [normalized, text, count, status, now]
    }
  ]);
  // 批量接口不返回 last_insert_rowid，插入后按 URL 查回自增 id
  const inserted = await db.execute(`SELECT id FROM ${SUBSCRIPTIONS_TABLE} WHERE url = ?`, [normalized]);
  const created = results[0].changes > 0;
  return { id: Number(inserted[0]?.id) || 0, created };
}

/** 刷新抓取状态；URL 不在表里时静默跳过（用户可能只是解析还没保存） */
export async function updateSubscriptionStatus(db, url, { ruleCount = 0, status = '' } = {}) {
  const normalized = normalizeSubscriptionUrl(url);
  const now = new Date().toISOString();
  const results = await db.batch([
    {
      sql: `UPDATE ${SUBSCRIPTIONS_TABLE}
            SET rule_count = ?, last_status = ?, last_fetched_at = ?, updated_at = ?
            WHERE url = ?`,
      params: [
        Math.max(0, Number(ruleCount) || 0),
        String(status || '').slice(0, MAX_STATUS_LENGTH),
        now,
        now,
        normalized
      ]
    }
  ]);
  return results[0].changes;
}

/** 按 id 删除订阅，返回删除条数 */
export async function deleteSubscription(db, id) {
  const numeric = Number(id);
  if (!Number.isInteger(numeric) || numeric <= 0) return 0;
  const results = await db.batch([
    { sql: `DELETE FROM ${SUBSCRIPTIONS_TABLE} WHERE id = ?`, params: [numeric] }
  ]);
  return results[0].changes;
}

/**
 * 面板登录会话：随机令牌一次下发，库里只存 SHA-256 哈希。
 * 会话固定 7 天有效（从创建算起，不滑动续期——到期重新登录，语义简单可靠）。
 */

import { AUTH_SESSIONS_TABLE } from '../db/ddl.js';

export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_USER_AGENT_LENGTH = 200;

const hex = (bytes) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(text)));
  return hex(new Uint8Array(digest));
}

/** 生成新会话：返回 { token, tokenHash, expiresAt }，token 原文只在响应里出现这一次 */
export async function createSession(db, userId, { userAgent = '' } = {}) {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const token = hex(bytes);
  const tokenHash = await sha256Hex(token);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS).toISOString();
  await db.batch([
    {
      sql: `INSERT INTO ${AUTH_SESSIONS_TABLE} (token_hash, user_id, created_at, expires_at, last_used_at, user_agent)
            VALUES (?, ?, ?, ?, ?, ?)`,
      params: [tokenHash, userId, now.toISOString(), expiresAt, now.toISOString(),
        String(userAgent ?? '').slice(0, MAX_USER_AGENT_LENGTH)]
    }
  ]);
  return { token, tokenHash, expiresAt };
}

/** 会话查询：命中未过期会话时顺手刷新 last_used_at（失败不影响主流程） */
export async function findLiveSession(db, token, nowMs = Date.now()) {
  if (!token) return null;
  const tokenHash = await sha256Hex(token);
  const rows = await db.execute(
    `SELECT s.token_hash, s.user_id, s.expires_at, s.created_at, s.user_agent,
            u.id AS u_id, u.username, u.display_name, u.role, u.group_id, u.status, u.permissions,
            g.permissions AS group_permissions, g.name AS group_name
     FROM ${AUTH_SESSIONS_TABLE} s JOIN users u ON u.id = s.user_id
     LEFT JOIN user_groups g ON g.id = u.group_id
     WHERE s.token_hash = ?`,
    [tokenHash]
  );
  const row = rows[0];
  if (!row) return null;
  if (Date.parse(String(row.expires_at)) <= nowMs) {
    await purgeExpired(db).catch(() => {});
    return null;
  }
  return row;
}

/** 删除单个会话（登出） */
export async function deleteSession(db, token) {
  if (!token) return;
  const tokenHash = await sha256Hex(token);
  await db.execute(`DELETE FROM ${AUTH_SESSIONS_TABLE} WHERE token_hash = ?`, [tokenHash]);
}

/** 删除某用户的全部会话（改密 / 禁用后强制重登） */
export async function deleteUserSessions(db, userId) {
  await db.execute(`DELETE FROM ${AUTH_SESSIONS_TABLE} WHERE user_id = ?`, [userId]);
}

/** 过期会话清理：登录 / 校验顺带触发，无残留累积 */
export async function purgeExpired(db) {
  await db.execute(`DELETE FROM ${AUTH_SESSIONS_TABLE} WHERE expires_at <= ?`, [new Date().toISOString()]);
}

/** 会话活跃（last_used_at 心跳）：低频更新，失败静默 */
export async function touchSession(db, tokenHash) {
  try {
    await db.execute(
      `UPDATE ${AUTH_SESSIONS_TABLE} SET last_used_at = ? WHERE token_hash = ?`,
      [new Date().toISOString(), tokenHash]
    );
  } catch { /* 心跳失败不拖垮请求 */ }
}

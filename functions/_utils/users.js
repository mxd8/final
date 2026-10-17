/**
 * 多用户与用户组数据访问层（v4）：账号、角色、组与功能级限制的读写。
 * permissions 列存 JSON `{features: {"ai.run": "deny"}}`——用户值覆盖组值，
 * 具体判定语义见 _utils/auth/policy.js。
 */

import { USERS_TABLE, USER_GROUPS_TABLE } from './db/ddl.js';
import { asDbError } from './db/contract.js';

export const USER_ROLES = ['admin', 'user'];
export const USER_STATUSES = ['active', 'disabled'];

const USERNAME_PATTERN = /^[a-zA-Z0-9_-]{2,32}$/;
const MAX_DISPLAY_NAME = 32;
const MAX_PERMISSIONS_LENGTH = 4096;

export class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
  }
}

/** 用户名规则：2-32 位字母数字下划线连字符（Surge 参数、日志列都好兼容） */
export function validateUsername(username) {
  const value = String(username ?? '').trim();
  if (!USERNAME_PATTERN.test(value)) return '用户名需 2-32 位字母、数字、下划线或连字符';
  return '';
}

function cleanDisplayName(value) {
  return String(value ?? '').trim().slice(0, MAX_DISPLAY_NAME);
}

/** permissions JSON 解析：脏值回落空对象，绝不让一条坏数据拖垮整张表 */
export function parsePermissions(raw) {
  try {
    const parsed = JSON.parse(String(raw ?? '{}'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** features 白名单归一：只收 allow / deny 之外的值一律丢弃 */
export function normalizeFeatures(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const features = {};
  for (const [key, rule] of Object.entries(source)) {
    if (typeof key === 'string' && key.length > 0 && key.length <= 64 && (rule === 'allow' || rule === 'deny')) {
      features[key] = rule;
    }
  }
  return features;
}

/** 行 → 前端结构：绝不出 password_hash */
function sanitizeUserRow(row) {
  return {
    id: Number(row.id),
    username: String(row.username ?? ''),
    displayName: String(row.display_name ?? ''),
    role: String(row.role ?? 'user'),
    groupId: row.group_id == null ? null : Number(row.group_id),
    status: String(row.status ?? 'active'),
    permissions: parsePermissions(row.permissions),
    createdAt: String(row.created_at ?? ''),
    updatedAt: String(row.updated_at ?? ''),
    lastLoginAt: String(row.last_login_at ?? '')
  };
}

function sanitizeGroupRow(row) {
  return {
    id: Number(row.id),
    name: String(row.name ?? ''),
    description: String(row.description ?? ''),
    permissions: parsePermissions(row.permissions),
    createdAt: String(row.created_at ?? ''),
    updatedAt: String(row.updated_at ?? '')
  };
}

/* ------------------------------- 用户 ------------------------------- */

export async function countUsers(db) {
  const rows = await db.execute(`SELECT COUNT(*) AS n FROM ${USERS_TABLE}`);
  return Number(rows[0]?.n ?? 0);
}

export async function hasAnyUser(db) {
  return (await countUsers(db)) > 0;
}

export async function countActiveAdmins(db) {
  const rows = await db.execute(
    `SELECT COUNT(*) AS n FROM ${USERS_TABLE} WHERE role = 'admin' AND status = 'active'`
  );
  return Number(rows[0]?.n ?? 0);
}

export async function listUsers(db) {
  const rows = await db.execute(
    `SELECT id, username, display_name, role, group_id, status, permissions, created_at, updated_at, last_login_at
     FROM ${USERS_TABLE} ORDER BY id ASC`
  );
  return rows.map(sanitizeUserRow);
}

export async function getUserById(db, id) {
  const rows = await db.execute(
    `SELECT id, username, display_name, role, group_id, status, permissions, created_at, updated_at, last_login_at, password_hash
     FROM ${USERS_TABLE} WHERE id = ?`,
    [id]
  );
  return rows[0] ?? null;
}

export async function getUserByUsername(db, username) {
  const rows = await db.execute(
    `SELECT id, username, display_name, role, group_id, status, permissions, created_at, updated_at, last_login_at, password_hash
     FROM ${USERS_TABLE} WHERE username = ?`,
    [String(username ?? '').trim()]
  );
  return rows[0] ?? null;
}

export async function createUser(db, { username, passwordHash, role = 'user', groupId = null, displayName = '', permissions = '{}' }) {
  const now = new Date().toISOString();
  await db.batch([
    {
      sql: `INSERT INTO ${USERS_TABLE} (username, display_name, password_hash, role, group_id, status, permissions, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
      params: [username, cleanDisplayName(displayName), passwordHash, role, groupId, permissions, now, now]
    }
  ]);
  const row = await getUserByUsername(db, username);
  return sanitizeUserRow(row);
}

/**
 * 更新用户：只改动传入的字段。返回更新后的净化行，用户不存在返回 null。
 * 调用方（路由层）负责「最后一个管理员」与「不能禁用自己」这类业务约束。
 */
export async function updateUser(db, id, patch) {
  const sets = [];
  const params = [];
  if (patch.passwordHash !== undefined) { sets.push('password_hash = ?'); params.push(patch.passwordHash); }
  if (patch.displayName !== undefined) { sets.push('display_name = ?'); params.push(cleanDisplayName(patch.displayName)); }
  if (patch.role !== undefined) { sets.push('role = ?'); params.push(patch.role); }
  if (patch.groupId !== undefined) { sets.push('group_id = ?'); params.push(patch.groupId); }
  if (patch.status !== undefined) { sets.push('status = ?'); params.push(patch.status); }
  if (patch.permissions !== undefined) { sets.push('permissions = ?'); params.push(patch.permissions); }
  if (!sets.length) return sanitizeUserRow(await getUserById(db, id));
  sets.push('updated_at = ?');
  params.push(new Date().toISOString());
  params.push(id);
  await db.batch([{ sql: `UPDATE ${USERS_TABLE} SET ${sets.join(', ')} WHERE id = ?`, params }]);
  const row = await getUserById(db, id);
  return row ? sanitizeUserRow(row) : null;
}

export async function deleteUser(db, id) {
  await db.batch([
    { sql: `DELETE FROM auth_sessions WHERE user_id = ?`, params: [id] },
    { sql: `DELETE FROM ${USERS_TABLE} WHERE id = ?`, params: [id] }
  ]);
}

export async function markUserLogin(db, userId) {
  try {
    await db.execute(
      `UPDATE ${USERS_TABLE} SET last_login_at = ? WHERE id = ?`,
      [new Date().toISOString(), userId]
    );
  } catch { /* 登录时间戳失败不影响登录 */ }
}

/* ------------------------------- 用户组 ------------------------------- */

export async function listGroups(db) {
  const rows = await db.execute(
    `SELECT id, name, description, permissions, created_at, updated_at FROM ${USER_GROUPS_TABLE} ORDER BY id ASC`
  );
  return rows.map(sanitizeGroupRow);
}

export async function getGroupById(db, id) {
  const rows = await db.execute(
    `SELECT id, name, description, permissions, created_at, updated_at FROM ${USER_GROUPS_TABLE} WHERE id = ?`,
    [id]
  );
  const row = rows[0];
  return row ? sanitizeGroupRow(row) : null;
}

export async function createGroup(db, { name, description = '', permissions = '{}' }) {
  const now = new Date().toISOString();
  await db.batch([
    {
      sql: `INSERT INTO ${USER_GROUPS_TABLE} (name, description, permissions, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
      params: [String(name).trim(), String(description ?? '').trim().slice(0, 128), permissions, now, now]
    }
  ]);
  const rows = await db.execute(`SELECT id, name, description, permissions, created_at, updated_at FROM ${USER_GROUPS_TABLE} WHERE name = ?`, [String(name).trim()]);
  return sanitizeGroupRow(rows[0]);
}

export async function updateGroup(db, id, { name, description, permissions }) {
  const sets = [];
  const params = [];
  if (name !== undefined) { sets.push('name = ?'); params.push(String(name).trim()); }
  if (description !== undefined) { sets.push('description = ?'); params.push(String(description).trim().slice(0, 128)); }
  if (permissions !== undefined) { sets.push('permissions = ?'); params.push(permissions); }
  if (sets.length) {
    sets.push('updated_at = ?');
    params.push(new Date().toISOString());
    params.push(id);
    await db.batch([{ sql: `UPDATE ${USER_GROUPS_TABLE} SET ${sets.join(', ')} WHERE id = ?`, params }]);
  }
  return getGroupById(db, id);
}

/** 删除组：组内用户解绑（group_id 置 NULL），不删用户 */
export async function deleteGroup(db, id) {
  await db.batch([
    { sql: `UPDATE ${USERS_TABLE} SET group_id = NULL, updated_at = ? WHERE group_id = ?`, params: [new Date().toISOString(), id] },
    { sql: `DELETE FROM ${USER_GROUPS_TABLE} WHERE id = ?`, params: [id] }
  ]);
}

/** 组内成员数：用户表展示与删除组前确认用 */
export async function countGroupMembers(db, groupId) {
  const rows = await db.execute(`SELECT COUNT(*) AS n FROM ${USERS_TABLE} WHERE group_id = ?`, [groupId]);
  return Number(rows[0]?.n ?? 0);
}

/** 建表缺失（如旧库尚未迁移）时统一归类为 DbError，路由层给 500 而不是裸错 */
export function wrapDbError(error) {
  throw asDbError(error);
}

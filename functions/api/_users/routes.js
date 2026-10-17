/**
 * /api/users 与 /api/groups 路由实现：管理员的多用户管理面。
 *
 *   GET    /api/users            用户清单（含组信息，绝不含密码哈希）
 *   POST   /api/users            新建用户 {username, password, role, groupId, displayName, features}
 *   PATCH  /api/users/:id        更新（密码 / 角色 / 组 / 状态 / 展示名 / 功能限制）
 *   DELETE /api/users/:id        删除（保护：不能删自己、不能删最后一个可用管理员）
 *   GET    /api/groups           用户组清单（含成员数）
 *   POST   /api/groups           新建组 {name, description, features}
 *   PATCH  /api/groups/:id       更新组
 *   DELETE /api/groups/:id       删除组（成员解绑，不删用户）
 *
 * 全部接口要求管理员身份（requireAdminAuth）；功能面再过 users.manage 限制。
 */

import { jsonResponse, readJson, badRequest, notFound, methodNotAllowed, errorResponse } from '../../_utils/http.js';
import { hashPassword, validatePasswordStrength } from '../../_utils/auth/password.js';
import { requireAdminAuth, invalidateAuthStateCache } from '../../_utils/auth/principal.js';
import { requireFeature } from '../../_utils/auth/policy.js';
import { deleteUserSessions } from '../../_utils/auth/sessions.js';
import {
  listUsers, getUserById, getUserByUsername, createUser, updateUser, deleteUser, countActiveAdmins,
  listGroups, getGroupById, createGroup, updateGroup, deleteGroup, countGroupMembers,
  validateUsername, normalizeFeatures, USER_ROLES, USER_STATUSES
} from '../../_utils/users.js';
import { NO_CACHE } from '../_logger/constants.js';

const TAG = 'api/users';
const ALLOW_METHODS = 'GET, POST, PATCH, DELETE';

/** 管理面统一守卫：管理员 + users.manage 功能限制 */
async function guard(context, db) {
  const gate = await requireAdminAuth(context.env, db, context.request, context);
  if (!gate.ok) return { denied: gate.response };
  const featureDenied = await requireFeature(gate.principal, 'users.manage');
  if (featureDenied) return { denied: featureDenied };
  return { principal: gate.principal };
}

function serializePermissions(value) {
  const normalized = normalizeFeatures(value);
  return JSON.stringify({ features: normalized });
}

/* ------------------------------- 用户 ------------------------------- */

export async function handleListUsers(context, db) {
  const gate = await guard(context, db);
  if (gate.denied) return gate.denied;
  const [users, groups] = await Promise.all([listUsers(db), listGroups(db)]);
  return jsonResponse({ success: true, data: { users, groups } }, { headers: NO_CACHE });
}

/** 创建用户的入参校验与归一 */
function validateUserPayload(body, { requirePassword }) {
  const username = String(body.username ?? '').trim();
  const usernameError = validateUsername(username);
  if (usernameError) return { error: usernameError };

  const password = String(body.password ?? '');
  if (requirePassword) {
    const passwordError = validatePasswordStrength(password);
    if (passwordError) return { error: passwordError };
  } else if (password && validatePasswordStrength(password)) {
    return { error: validatePasswordStrength(password) };
  }

  const role = body.role === undefined ? 'user' : String(body.role);
  if (!USER_ROLES.includes(role)) return { error: `角色必须是：${USER_ROLES.join(' / ')}` };

  const status = body.status === undefined ? undefined : String(body.status);
  if (status !== undefined && !USER_STATUSES.includes(status)) {
    return { error: `状态必须是：${USER_STATUSES.join(' / ')}` };
  }

  let groupId = body.groupId;
  if (groupId !== undefined && groupId !== null && groupId !== '') {
    groupId = Number(groupId);
    if (!Number.isInteger(groupId) || groupId <= 0) return { error: 'groupId 必须是正整数或 null' };
  } else {
    groupId = null;
  }

  const displayName = body.displayName === undefined ? undefined : String(body.displayName).slice(0, 32);
  const permissions = body.features === undefined ? undefined : serializePermissions(body.features);
  return { value: { username, password, role, status, groupId, displayName, permissions } };
}

export async function handleCreateUser(context, db) {
  const gate = await guard(context, db);
  if (gate.denied) return gate.denied;

  const parsed = await readJson(context);
  if (!parsed.ok) return badRequest('请求体不是有效的 JSON');
  const check = validateUserPayload(parsed.value ?? {}, { requirePassword: true });
  if (check.error) return badRequest(check.error);
  const { username, password, role, groupId, displayName, permissions } = check.value;

  const duplicate = await getUserByUsername(db, username);
  if (duplicate) return badRequest(`用户名已存在：${username}`);
  if (groupId && !(await getGroupById(db, groupId))) return badRequest('用户组不存在');

  const passwordHash = await hashPassword(password);
  const user = await createUser(db, { username, passwordHash, role, groupId, displayName, permissions });
  return jsonResponse({ success: true, data: user }, { status: 201, headers: NO_CACHE });
}

/**
 * 更新用户：禁用 / 启用也在这个入口（status）。业务约束：
 *   - 不能禁用或降级最后一个可用管理员（会把整套管理面锁死）；
 *   - 状态变更后立即踢掉该用户的全部会话。
 */
export async function handlePatchUser(context, db, id) {
  const gate = await guard(context, db);
  if (gate.denied) return gate.denied;

  const row = await getUserById(db, id);
  if (!row) return notFound('用户不存在');

  const parsed = await readJson(context);
  if (!parsed.ok) return badRequest('请求体不是有效的 JSON');
  const body = parsed.value ?? {};
  const check = validateUserPayload({ ...body, username: row.username }, { requirePassword: false });
  if (check.error) return badRequest(check.error);
  const { password, role, status, groupId, displayName, permissions } = check.value;

  const wasAdmin = row.role === 'admin' && row.status === 'active';
  const willBeAdmin = (role ?? row.role) === 'admin' && (status ?? row.status) === 'active';
  if (wasAdmin && !willBeAdmin && (await countActiveAdmins(db)) <= 1) {
    return badRequest('不能停用最后一个可用管理员');
  }
  if (groupId && !(await getGroupById(db, groupId))) return badRequest('用户组不存在');

  const patch = {};
  if (password) patch.passwordHash = await hashPassword(password);
  if (role !== undefined && role !== row.role) patch.role = role;
  if (status !== undefined && status !== row.status) patch.status = status;
  if (groupId !== undefined) patch.groupId = groupId;
  if (displayName !== undefined) patch.displayName = displayName;
  if (permissions !== undefined) patch.permissions = permissions;

  const user = await updateUser(db, id, patch);
  // 禁用 / 改密后强制重新登录；启用的变更无须踢会话但删除也无害
  if (patch.status === 'disabled' || patch.passwordHash) {
    await deleteUserSessions(db, id).catch(() => {});
  }
  return jsonResponse({ success: true, data: user }, { headers: NO_CACHE });
}

export async function handleDeleteUser(context, db, id) {
  const gate = await guard(context, db);
  if (gate.denied) return gate.denied;

  const row = await getUserById(db, id);
  if (!row) return notFound('用户不存在');
  if (gate.principal.type === 'user' && Number(gate.principal.user.id) === Number(id)) {
    return badRequest('不能删除当前登录的账号');
  }
  if (row.role === 'admin' && row.status === 'active' && (await countActiveAdmins(db)) <= 1) {
    return badRequest('不能删除最后一个可用管理员');
  }
  await deleteUser(db, id);
  invalidateAuthStateCache();
  return jsonResponse({ success: true, data: { deleted: Number(id) } }, { headers: NO_CACHE });
}

/* ------------------------------- 用户组 ------------------------------- */

function validateGroupPayload(body) {
  const name = String(body.name ?? '').trim();
  if (name.length < 1 || name.length > 32) return { error: '组名需 1-32 个字符' };
  const description = body.description === undefined ? undefined : String(body.description);
  const permissions = body.features === undefined ? undefined : serializePermissions(body.features);
  return { value: { name, description, permissions } };
}

export async function handleListGroups(context, db) {
  const gate = await guard(context, db);
  if (gate.denied) return gate.denied;
  const groups = await listGroups(db);
  const withCounts = await Promise.all(
    groups.map(async (group) => ({ ...group, memberCount: await countGroupMembers(db, group.id) }))
  );
  return jsonResponse({ success: true, data: withCounts }, { headers: NO_CACHE });
}

export async function handleCreateGroup(context, db) {
  const gate = await guard(context, db);
  if (gate.denied) return gate.denied;

  const parsed = await readJson(context);
  if (!parsed.ok) return badRequest('请求体不是有效的 JSON');
  const check = validateGroupPayload(parsed.value ?? {});
  if (check.error) return badRequest(check.error);

  const all = await listGroups(db);
  if (all.some((group) => group.name === check.value.name)) return badRequest(`组名已存在：${check.value.name}`);
  const group = await createGroup(db, check.value);
  return jsonResponse({ success: true, data: group }, { status: 201, headers: NO_CACHE });
}

export async function handlePatchGroup(context, db, id) {
  const gate = await guard(context, db);
  if (gate.denied) return gate.denied;

  const existing = await getGroupById(db, id);
  if (!existing) return notFound('用户组不存在');
  const parsed = await readJson(context);
  if (!parsed.ok) return badRequest('请求体不是有效的 JSON');
  const check = validateGroupPayload(parsed.value ?? {});
  if (check.error) return badRequest(check.error);

  const all = await listGroups(db);
  if (all.some((group) => group.name === check.value.name && group.id !== Number(id))) {
    return badRequest(`组名已存在：${check.value.name}`);
  }
  const group = await updateGroup(db, id, check.value);
  return jsonResponse({ success: true, data: group }, { headers: NO_CACHE });
}

export async function handleDeleteGroup(context, db, id) {
  const gate = await guard(context, db);
  if (gate.denied) return gate.denied;
  if (!(await getGroupById(db, id))) return notFound('用户组不存在');
  const members = await countGroupMembers(db, id);
  await deleteGroup(db, id);
  return jsonResponse({ success: true, data: { deleted: Number(id), unboundMembers: members } }, { headers: NO_CACHE });
}

export async function handleUsersRequest(context, db, path, method) {
  try {
    if (path === '/api/users') {
      if (method === 'GET') return await handleListUsers(context, db);
      if (method === 'POST') return await handleCreateUser(context, db);
      return methodNotAllowed(method, ALLOW_METHODS);
    }
    const item = path.match(/^\/api\/users\/(\d+)$/);
    if (item) {
      const id = item[1];
      if (method === 'PATCH') return await handlePatchUser(context, db, id);
      if (method === 'DELETE') return await handleDeleteUser(context, db, id);
      return methodNotAllowed(method, 'PATCH, DELETE');
    }
    if (path === '/api/groups') {
      if (method === 'GET') return await handleListGroups(context, db);
      if (method === 'POST') return await handleCreateGroup(context, db);
      return methodNotAllowed(method, ALLOW_METHODS);
    }
    const groupItem = path.match(/^\/api\/groups\/(\d+)$/);
    if (groupItem) {
      const id = groupItem[1];
      if (method === 'PATCH') return await handlePatchGroup(context, db, id);
      if (method === 'DELETE') return await handleDeleteGroup(context, db, id);
      return methodNotAllowed(method, 'PATCH, DELETE');
    }
    return notFound(`未知的接口：${path}`);
  } catch (error) {
    return errorResponse(TAG, method, path, error);
  }
}

/**
 * 用户偏好 API：/api/prefs
 * user 是前端生成的设备标识（非账号）。偏好本身不敏感，但 gist.token 也存这张表，
 * 所以读 / 写 / 删除全部要求鉴权（会话用户或写令牌，前端请求自动附带）；
 * 鉴权体系未启用且未配置写令牌时保持开放（兼容已上线部署）。
 *
 *   GET    /api/prefs?user=<设备标识>            取该设备全部偏好
 *   GET    /api/prefs/schema                     建表语句
 *   POST   /api/prefs { user, settings: {k:v} }  批量写入（upsert）
 *   DELETE /api/prefs?user=&key=<键名|__all__>   删除单个 / 全部偏好
 */

import { resolveAdapter } from '../_utils/db/factory.js';
import { requireMutationAuth } from '../_utils/auth/principal.js';
import { jsonResponse, readJson, textResponse, badRequest, notFound, methodNotAllowed, errorResponse } from '../_utils/http.js';
import {
  PREFS_SCHEMA,
  MAX_PREFERENCE_LENGTH,
  normalizeUserId,
  listPrefs,
  savePrefs,
  deletePref,
  clearPrefs
} from '../_utils/prefs.js';
import { AI_CONFIG_USER } from './_ai/config.js';

const TAG = 'api/prefs';

/** 保留用户守卫：system 用户存 AI 全局配置（含凭据），只允许 /api/ai/* 读写 */
function guardReservedUser(user) {
  return user === AI_CONFIG_USER
    ? badRequest(`用户「${AI_CONFIG_USER}」为系统保留，AI 配置请通过 /api/ai 接口读写`)
    : null;
}

export async function onRequest(context) {
  const { adapter: config, response } = await resolveAdapter(context.env);
  if (response) return response;
  await config.ready;

  const url = new URL(context.request.url);
  const path = url.pathname;
  const method = context.request.method;

  try {
    if (method === 'GET' && path === '/api/prefs/schema') {
      return textResponse(`${PREFS_SCHEMA}\n\n-- 提示：user_id 是前端生成的设备标识，单个偏好值最长 ${MAX_PREFERENCE_LENGTH} 字符\n`);
    }

    if (method === 'GET' && path === '/api/prefs') return list(context, config, url);
    if (method === 'POST' && path === '/api/prefs') return save(context, config);
    if (method === 'DELETE' && path === '/api/prefs') return remove(context, config, url);

    if (method === 'GET') return notFound(`未知的接口：${path}`);
    return methodNotAllowed(method, 'GET, POST, DELETE');
  } catch (error) {
    return errorResponse(TAG, method, path, error);
  }
}

/** 偏好接口统一鉴权：会话用户或令牌；gist.token 与普通偏好同表，匿名读取等于暴露凭据 */
async function guardPrefs(context, config) {
  const auth = await requireMutationAuth(context.env, config, context.request, context);
  if (!auth.ok) return { denied: auth.response };
  return { principal: auth.principal };
}

async function list(context, config, url) {
  // gist.token 存在偏好表里：读取同样要过鉴权，避免匿名取回凭据
  const guard = await guardPrefs(context, config);
  if (guard.denied) return guard.denied;

  const user = normalizeUserId(url.searchParams.get('user'));
  const reserved = guardReservedUser(user);
  if (reserved) return reserved;

  const settings = await listPrefs(config, user);
  return jsonResponse({ success: true, user, data: settings });
}

async function save(context, config) {
  const guard = await guardPrefs(context, config);
  if (guard.denied) return guard.denied;

  const body = await readJson(context);
  if (!body.ok) return badRequest('请求体不是有效的 JSON');

  const user = normalizeUserId(body.value.user);
  const reserved = guardReservedUser(user);
  if (reserved) return reserved;

  const settings = body.value.settings;
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
    return badRequest('settings 必须是对象');
  }

  const result = await savePrefs(config, user, settings);
  return jsonResponse({ success: true, user, data: result });
}

async function remove(context, config, url) {
  // 匿名可清空任意 user 的偏好是不可接受的：删除与保存同样先过鉴权
  const guard = await guardPrefs(context, config);
  if (guard.denied) return guard.denied;

  const user = normalizeUserId(url.searchParams.get('user'));
  const reserved = guardReservedUser(user);
  if (reserved) return reserved;

  const key = url.searchParams.get('key') || '';
  const data = key === '__all__' ? await clearPrefs(config, user) : await deletePref(config, user, key);
  return jsonResponse({ success: true, user, data });
}

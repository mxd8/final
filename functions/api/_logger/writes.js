/**
 * /api/logger 写入路由实现：hit、update、delete、exclude、batch、clear、clear-empty。
 * /hit 由 Surge 调用，走上报令牌（URL 查询参数或请求头均可）；
 * 其余写操作只能走 Authorization 头，鉴权在任何参数解析之前。
 */

import { jsonResponse, readJson, badRequest, notFound } from '../../_utils/http.js';
import { requireWriteToken, requireHitToken, extractUrlOrHeaderToken } from '../../_utils/auth.js';
import {
  recordHit,
  recordHits,
  HIT_BATCH_MAX_ITEMS,
  updateLog,
  deleteLog,
  reduceExclude,
  batchOverride,
  clearAllLogs,
  clearEmptyCommentLogs,
  normalizeSource
} from '../../_utils/logs/index.js';
import { NO_CACHE } from './constants.js';
import { COMPONENT_VERSIONS } from '../../_utils/build-meta.js';
import { clientIp, parseDeviceHeaders, touchDevice, buildDeviceId } from '../../_utils/devices.js';
import { normalizeUsername, normalizeIp } from '../../_utils/logs/normalize.js';

/**
 * 从批量上报请求解析设备上下文：来源 IP 由服务端从连接捕获（Surge 端拿不到
 * 自己的公网出口 IP），用户名 / 设备标识 / 版本自报走请求头，username 字段兜底。
 */
function deviceContextFromRequest(request, body) {
  const device = parseDeviceHeaders(request);
  const fallbackUsername = normalizeUsername(body?.username);
  return {
    clientId: device.clientId,
    name: device.name,
    username: device.username || fallbackUsername,
    ip: clientIp(request),
    loggerVersion: device.loggerVersion
  };
}

/**
 * 设备登记：命中上报本身也是一次「在线信号」，同一次触达刷新设备注册表的
 * last_online_time。失败只打日志——设备表缺席绝不能拖垮命中写库主链路。
 */
async function touchDeviceSafely(db, context) {
  try {
    await touchDevice(db, context);
  } catch (error) {
    console.warn('[devices] 设备登记失败（不影响上报）:', error?.message ?? error);
  }
}

/** 上报接口：任一已配置令牌（PANEL_WRITE_TOKEN / PANEL_HIT_TOKEN）匹配即放行 */
export async function handleHit(context, config) {
  const hitDenied = requireHitToken(context.env, extractUrlOrHeaderToken(context));
  if (hitDenied) return hitDenied;

  const body = await readJson(context);
  if (!body.ok) return badRequest('请求体不是有效的 JSON');

  const hostname = String(body.value.hostname ?? '').trim();
  if (!hostname) return badRequest('hostname 不能为空');

  // 请求体是扁平结构 {hostname, type, value, source, policy, params}，
  // 与 surge/final-logger.js 中转模式实际发出的字段一一对应；ip / username 为 v2 扩展
  const device = deviceContextFromRequest(context.request, body.value);
  const result = await recordHit(config, hostname, {
    source: normalizeSource(body.value.source),
    ip: normalizeIp(body.value.ip) || device.ip,
    username: normalizeUsername(body.value.username) || device.username,
    policy: body.value.policy,
    type: body.value.type,
    value: body.value.value,
    params: body.value.params
  });
  await touchDeviceSafely(config, { ...device, deviceId: buildDeviceId(device) });
  // 捕获脚本版本握手：响应捎带最新版本，本地副本据此写入 final_logger_meta 供面板提示
  return jsonResponse({ success: true, data: { ...result, latestLoggerVersion: COMPONENT_VERSIONS.logger } }, { headers: NO_CACHE });
}

/**
 * 批量上报入口：{hits: [{hostname, count?, type?, value?, source?, policy?, params?, ip?, username?}]}。
 * 捕获脚本的本地去重窗口攒满一批后一次提交，服务端一个批量事务落库；
 * 令牌校验与单条 /hit 完全一致。设备上下文（IP / 用户名 / 标识）对整批生效，
 * 单条命中里的同名字段优先。
 */
export async function handleHitBatch(context, config) {
  const hitDenied = requireHitToken(context.env, extractUrlOrHeaderToken(context));
  if (hitDenied) return hitDenied;

  const body = await readJson(context);
  if (!body.ok) return badRequest('请求体不是有效的 JSON');

  const hits = body.value.hits;
  if (!Array.isArray(hits) || !hits.length) return badRequest('hits 必须是非空数组');
  if (hits.length > HIT_BATCH_MAX_ITEMS) return badRequest(`单次上报最多 ${HIT_BATCH_MAX_ITEMS} 条命中`);

  const device = deviceContextFromRequest(context.request, body.value);
  const enriched = hits.map((hit) => ({
    ...hit,
    ip: normalizeIp(hit.ip) || device.ip,
    username: normalizeUsername(hit.username) || device.username
  }));

  const result = await recordHits(config, enriched);
  await touchDeviceSafely(config, { ...device, deviceId: buildDeviceId(device) });
  // 捕获脚本版本握手：本地副本无法自更新，闭环止于「发现并提示」（面板读 final_logger_meta）
  return jsonResponse({ success: true, data: { ...result, latestLoggerVersion: COMPONENT_VERSIONS.logger } }, { headers: NO_CACHE });
}

/** 其余写接口的统一鉴权入口 + 分发；是否读请求体由各处理器自定（clear-empty 无 body） */
export async function handleWrite(context, config, path) {
  const writeDenied = requireWriteToken(context.env, context.request);
  if (writeDenied) return writeDenied;

  switch (path) {
    case '/api/logger/update':
      return updateRule(context, config);
    case '/api/logger/delete':
      return deleteRule(context, config);
    case '/api/logger/exclude':
      return excludeRule(context, config);
    case '/api/logger/batch':
      return batchRules(context, config);
    case '/api/logger/clear':
      return clearAll(context, config);
    case '/api/logger/clear-empty':
      return jsonResponse({ success: true, data: { deleted: await clearEmptyCommentLogs(config) } }, { headers: NO_CACHE });
    default:
      return notFound(`未知的接口：${path}`);
  }
}

/** 请求体解析 + 扁平 / 嵌套两种写法兼容（update / delete / exclude 共用） */
async function readPatch(context) {
  const body = await readJson(context);
  if (!body.ok) return { error: badRequest('请求体不是有效的 JSON') };
  const patch = (body.value && typeof body.value === 'object') ? body.value : body;
  return { body, patch };
}

function extractHostname(body, patch) {
  return String(body.hostname ?? patch.hostname ?? '').trim();
}

async function updateRule(context, config) {
  const { error, body, patch } = await readPatch(context);
  if (error) return error;
  const hostname = extractHostname(body, patch);
  if (!hostname) return badRequest('hostname 不能为空');

  // 只取真正出现的字段；缺省字段在 updateLog 里落到 'UNSET'（本次不改）
  const optional = (key) => (patch[key] === undefined || patch[key] === null ? undefined : String(patch[key]));
  const result = await updateLog(config, hostname, {
    type: optional('type'),
    value: optional('value'),
    policy: optional('policy'),
    params: patch.params === undefined ? null : patch.params,
    comment: patch.comment === undefined ? null : String(patch.comment),
    source: patch.source === undefined ? null : String(patch.source)
  });
  if (result.error) return badRequest(result.error);
  if (!result.found && !result.created) return notFound('记录不存在');
  return jsonResponse({ success: true, data: result }, { headers: NO_CACHE });
}

async function deleteRule(context, config) {
  const { error, body, patch } = await readPatch(context);
  if (error) return error;
  const hostname = extractHostname(body, patch);
  if (!hostname) return badRequest('hostname 不能为空');
  const deleted = await deleteLog(config, hostname);
  return jsonResponse({ success: true, data: { deleted } }, { headers: NO_CACHE });
}

async function excludeRule(context, config) {
  const { error, body, patch } = await readPatch(context);
  if (error) return error;
  const target = String(body.target ?? patch.target ?? '').trim();
  if (!target) return badRequest('target 不能为空');
  const result = await reduceExclude(config, target, {
    policy: body.policy ?? patch.policy,
    source: normalizeSource(body.source ?? patch.source)
  });
  return jsonResponse({ success: true, data: result }, { headers: NO_CACHE });
}

/** 统计被跳过的空行数量，前端据此提示「有 N 行无法解析」 */
function countSkipped(rawLines, accepted) {
  return Math.max(0, rawLines.length - accepted.length);
}

async function batchRules(context, config) {
  const { error, patch } = await readPatch(context);
  if (error) return error;

  // text 与 lines 二选一：前者是面板粘贴的多行文本，后者是 Gist 同步的结构化数据
  const rawText = typeof patch.text === 'string' ? patch.text : '';
  const rawLines = Array.isArray(patch.lines) ? patch.lines : rawText.split('\n');
  const lines = rawLines.filter((line) => String(line).trim().length > 0 || (line && typeof line === 'object'));
  if (!lines.length) return badRequest('没有可处理的规则行');

  const mode = patch.mode === 'override' ? 'override' : 'merge';
  const result = await batchOverride(config, lines, {
    mode,
    preserveFrom: typeof patch.preserveFrom === 'string' ? patch.preserveFrom : ''
  });
  return jsonResponse(
    { success: true, data: { ...result, mode, skipped: countSkipped(rawLines, result.total) } },
    { headers: NO_CACHE }
  );
}

/** 高危不可逆：接口只认显式确认标记，避免误触一次就清库 */
async function clearAll(context, config) {
  const body = await readJson(context);
  const confirmed = body.ok && body.value.confirm === true;
  if (!confirmed) return badRequest('高危操作：需要请求体 {"confirm": true} 才能清空');
  const deleted = await clearAllLogs(config);
  return jsonResponse({ success: true, data: { deleted } }, { headers: NO_CACHE });
}

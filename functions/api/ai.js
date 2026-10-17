/**
 * AI 分流自动化 API：/api/ai
 *
 * 「AI配置」页的后端：Cloudflare Workers AI 连接配置、可用模型、调度开关与
 * 批量执行。配置与运行状态是跨设备共享的全局数据，存 app_prefs 表的保留
 * 用户 system 下（通用 prefs 接口拒绝读写该用户，见 api/prefs.js）。
 *
 *   GET  /api/ai/config   读配置（token 只回掩码，原文永不出库）
 *   POST  /api/ai/config  保存配置（token 留空或为掩码 = 保留旧值）      [写令牌]
 *   GET  /api/ai/models   代理拉取账号可用的文本生成模型列表             [写令牌]
 *   POST  /api/ai/test    连通性测试（跑一条最小推理）                  [写令牌]
 *   GET  /api/ai/status   队列统计 + 上次运行结果 + 下次可运行时间
 *   GET  /api/ai/usage    Cloudflare 用量（GraphQL：AI 请求 / Token /
 *                         Workers 请求，过去 24 小时；匿名可读，服务端
 *                         60 秒缓存；?force=1 跳过缓存需写令牌）
 *   POST  /api/ai/run     执行一轮批量处理（一批 = batchSize 条）        [写令牌]
 *                         支持 Authorization 头或 ?token= 查询参数（外部定时器用）；
 *                         冷却期内返回 skipped（force=1 跳过，面板手动按钮用）
 *   POST  /api/ai/reset   清空 ai_processed 标记，全部规则重新参与调度   [写令牌]
 *
 * 写接口令牌未配置时保持开放（与面板其余写接口一致的兼容策略）。
 */

import { resolveAdapter } from '../_utils/db/factory.js';
import { requireMutationAuth } from '../_utils/auth/principal.js';
import { requireFeature } from '../_utils/auth/policy.js';
import { jsonResponse, readJson, badRequest, notFound, methodNotAllowed, errorResponse } from '../_utils/http.js';
import { loadAiConfig, saveAiConfig, publicAiConfig, loadAiState } from './_ai/config.js';
import { listTextModels, testConnection } from './_ai/client.js';
import { queueStats, resetProcessed } from './_ai/selector.js';
import { runAiBatch } from './_ai/executor.js';
import { getCfUsage } from './_ai/usage.js';

const TAG = 'api/ai';

/** 写接口统一鉴权（会话 / 管理令牌 / ?token= 查询参数，鉴权启用后匿名拒绝）+ 功能限制 */
async function guardAi(context, db, feature) {
  const auth = await requireMutationAuth(context.env, db, context.request, context);
  if (!auth.ok) return { denied: auth.response };
  const featureDenied = await requireFeature(auth.principal, feature, { path: new URL(context.request.url).pathname });
  if (featureDenied) return { denied: featureDenied };
  return { principal: auth.principal };
}

export async function onRequest(context) {
  const { adapter: db, response } = await resolveAdapter(context.env);
  if (response) return response;
  await db.ready;

  const url = new URL(context.request.url);
  const path = url.pathname;
  const method = context.request.method;

  try {
    if (method === 'GET' && path === '/api/ai/config') return getConfig(context, db);
    if (method === 'POST' && path === '/api/ai/config') return saveConfig(context, db);
    if (method === 'GET' && path === '/api/ai/models') return getModels(context, db);
    if (method === 'POST' && path === '/api/ai/test') return test(context, db);
    if (method === 'GET' && path === '/api/ai/status') return status(context, db);
    if (method === 'GET' && path === '/api/ai/usage') return usage(context, db, url);
    if (method === 'POST' && path === '/api/ai/run') return run(context, db, url);
    if (method === 'POST' && path === '/api/ai/reset') return reset(context, db);

    if (method === 'GET') return notFound(`未知的接口：${path}`);
    return methodNotAllowed(method, 'GET, POST');
  } catch (error) {
    return errorResponse(TAG, method, path, error);
  }
}

async function getConfig(context, db) {
  const config = await loadAiConfig(db);
  return jsonResponse({ success: true, data: publicAiConfig(config) });
}

async function saveConfig(context, db) {
  const guard = await guardAi(context, db, 'ai.config');
  if (guard.denied) return guard.denied;

  const body = await readJson(context);
  if (!body.ok) return badRequest('请求体不是有效的 JSON');

  const saved = await saveAiConfig(db, body.value || {});
  return jsonResponse({ success: true, data: publicAiConfig(saved) });
}

async function getModels(context, db) {
  const guard = await guardAi(context, db, 'ai.config');
  if (guard.denied) return guard.denied;

  const config = await loadAiConfig(db);
  const models = await listTextModels(config);
  return jsonResponse({ success: true, data: { models, current: config.model } });
}

async function test(context, db) {
  const guard = await guardAi(context, db, 'ai.config');
  if (guard.denied) return guard.denied;

  const config = await loadAiConfig(db);
  const result = await testConnection(config);
  return jsonResponse({ success: true, data: result });
}

async function status(context, db) {
  const config = await loadAiConfig(db);
  const [stats, state] = await Promise.all([queueStats(db, config), loadAiState(db)]);

  // 下次可运行时间：上一轮已清空队列时按冷却间隔推算；未清空 / 从未跑过 = 随时可跑
  const intervalMs = config.intervalMinutes * 60 * 1000;
  const lastFinish = Date.parse(state.last_finish_at || '');
  const drained = Number(state.last_summary?.remaining ?? 0) === 0;
  const nextRunAt = drained && Number.isFinite(lastFinish) && lastFinish > 0
    ? new Date(lastFinish + intervalMs).toISOString()
    : '';

  return jsonResponse(
    {
      success: true,
      data: {
        enabled: config.enabled,
        config: publicAiConfig(config),
        queue: stats,
        running: Boolean(state.running),
        lastRunAt: state.last_run_at || '',
        lastFinishAt: state.last_finish_at || '',
        lastSummary: state.last_summary || null,
        nextRunAt
      }
    },
    { headers: { 'Cache-Control': 'no-store' } }
  );
}

/**
 * Cloudflare 用量：匿名可读（仅聚合数字，不含凭据），服务端 60 秒缓存兜底；
 * ?force=1 跳过缓存属于主动打上游 GraphQL，要求鉴权。
 */
async function usage(context, db, url) {
  const force = url.searchParams.get('force') === '1';
  if (force) {
    const guard = await guardAi(context, db, 'ai.config');
    if (guard.denied) return guard.denied;
  }

  const config = await loadAiConfig(db);
  const data = await getCfUsage(config, { force });
  return jsonResponse(
    { success: true, data },
    { headers: { 'Cache-Control': 'no-store' } }
  );
}

async function run(context, db, url) {
  // 外部定时器不便带请求头：令牌额外接受 ?token= 查询参数（同 /hit 的兼容策略）；
  // 登录用户再过 ai.run 功能限制（预留 AI 检测 / 动态策略接入）
  const guard = await guardAi(context, db, 'ai.run');
  if (guard.denied) return guard.denied;

  const config = await loadAiConfig(db);
  const body = await readJson(context);
  const force = url.searchParams.get('force') === '1' || body.value?.force === true;

  const result = await runAiBatch(db, config, { force });
  return jsonResponse({ success: true, data: result });
}

async function reset(context, db) {
  const guard = await guardAi(context, db, 'ai.config');
  if (guard.denied) return guard.denied;

  const data = await resetProcessed(db);
  return jsonResponse({ success: true, data });
}

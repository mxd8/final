/**
 * /api/subscribe 路由实现：列表、schema、解析、保存、删除。
 */

import { jsonResponse, textResponse, badRequest } from '../../_utils/http.js';
import { warningHeadersIfOpen } from '../../_utils/auth.js';
import {
  SUBSCRIPTIONS_SCHEMA,
  listSubscriptions,
  upsertSubscription,
  updateSubscriptionStatus,
  deleteSubscription
} from '../../_utils/subscriptions.js';
import { checkSubscriptionUrl } from './guard.js';
import { readCache, writeCache } from './cache.js';
import { fetchAndExtract } from './extract.js';
import { CACHE_OK, NO_CACHE } from './constants.js';

export async function handleSchema() {
  return textResponse(`${SUBSCRIPTIONS_SCHEMA}\n\n-- url 必须由 normalizeSubscriptionUrl 规范化后写入，UNIQUE(url) 才有效`);
}

export async function handleList(context, config) {
  const items = await listSubscriptions(config);
  return jsonResponse(
    { success: true, data: items },
    { headers: { ...CACHE_OK, ...warningHeadersIfOpen(context.env) } }
  );
}

export async function handleParse(config, payload) {
  const raw = String(payload.url ?? '').trim();
  if (!raw) return badRequest('订阅地址不能为空');

  const checked = checkSubscriptionUrl(raw);
  if (checked.error) return badRequest(checked.error);

  const cached = readCache(checked.url);
  const extracted = cached || await fetchAndExtract(checked.url);
  if (cached) writeCache(checked.url, cached);

  if (!extracted.ok) {
    // 抓失败也更新状态：列表里能看到「这个订阅最近拉不到」
    await updateSubscriptionStatus(config, checked.url, { ruleCount: 0, status: `failed: ${extracted.error}` })
      .catch(() => 0);
    return jsonResponse(
      { success: false, error: extracted.error, data: { url: checked.url, status: extracted.status } },
      { status: extracted.status === 404 || extracted.status === 410 ? 404 : 400, headers: NO_CACHE }
    );
  }

  writeCache(checked.url, extracted);
  await updateSubscriptionStatus(config, checked.url, { ruleCount: extracted.lines.length, status: 'ok' })
    .catch(() => 0);

  return jsonResponse(
    {
      success: true,
      data: {
        url: checked.url,
        lines: extracted.lines,
        count: extracted.lines.length,
        skipped: extracted.skipped,
        total: extracted.total,
        truncated: Boolean(extracted.truncated)
      }
    },
    { headers: NO_CACHE }
  );
}

export async function handleSave(config, payload) {
  const raw = String(payload.url ?? '').trim();
  if (!raw) return badRequest('订阅地址不能为空');
  const checked = checkSubscriptionUrl(raw);
  if (checked.error) return badRequest(checked.error);

  // ruleCount / lastStatus 是可选的「上次抓取快照」：先解析后保存时，
  // 解析那一刻表里还没有该 URL，把条数一并带来才能一次写全
  const ruleCount = Math.max(0, Math.floor(Number(payload.ruleCount) || 0));
  const saved = await upsertSubscription(config, checked.url, payload.name, {
    ruleCount,
    lastStatus: ruleCount > 0 ? String(payload.lastStatus || 'ok') : ''
  });
  const items = await listSubscriptions(config);
  return jsonResponse(
    { success: true, data: { id: saved.id, created: saved.created, subscriptions: items } },
    { headers: NO_CACHE }
  );
}

export async function handleDelete(config, payload) {
  const id = Number(payload.id);
  if (!Number.isInteger(id) || id <= 0) return badRequest('id 必须是正整数');
  const deleted = await deleteSubscription(config, id);
  const items = await listSubscriptions(config);
  return jsonResponse({ success: true, data: { deleted, subscriptions: items } }, { headers: NO_CACHE });
}

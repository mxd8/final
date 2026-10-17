/**
 * 规则管理 API：/api/rules（旧版 rules 表，保留为兼容部署）。
 *
 *   GET    /api/rules          列表（?search= 模糊搜索）
 *   GET    /api/rules/list     Surge 订阅文本导出
 *   POST   /api/rules          新增
 *   GET/PUT/DELETE /api/rules/:id
 */

import { resolveAdapter } from '../_utils/db/factory.js';
import { requireWriteToken } from '../_utils/auth.js';
import {
  jsonResponse,
  textResponse,
  readJson,
  badRequest,
  notFound,
  methodNotAllowed,
  errorResponse,
  likeEscape
} from '../_utils/http.js';
import { formatRule, joinRuleLines } from '../_utils/surge-rule/index.js';

const TAG = 'api/rules';

const ALLOWED_ACTIONS = ['REJECT', 'PROXY', 'DIRECT', 'FINAL'];
const ALLOW_METHODS = 'GET, POST, PUT, DELETE';
const RULE_COLUMNS = 'id, domain, action, remark';

/** 统一校验规则入参，返回可直接入库的值 */
function validateRuleInput(value) {
  const domain = String(value?.domain ?? '').trim();
  const action = String(value?.action ?? '').trim().toUpperCase();
  const remark = String(value?.remark ?? '').trim() || null;

  if (!domain) return { error: '域名不能为空' };
  if (domain.length > 253) return { error: '域名过长（超过 253 字符）' };
  if (!ALLOWED_ACTIONS.includes(action)) {
    return { error: `动作必须是以下之一：${ALLOWED_ACTIONS.join(' / ')}` };
  }
  if (remark && remark.length > 200) return { error: '备注过长（超过 200 字符）' };
  return { value: { domain, action, remark } };
}

export async function onRequest(context) {
  const { adapter: config, response } = await resolveAdapter(context.env);
  if (response) return response;

  const url = new URL(context.request.url);
  const path = url.pathname;
  const method = context.request.method;

  try {
    await config.ready;
    if (method === 'GET' && path === '/api/rules') return listRules(config, url);
    if (method === 'GET' && path === '/api/rules/list') return exportSubscription(config);
    if (method === 'POST' && path === '/api/rules') return createRule(context, config);
    if (/^\/api\/rules\/(\d+)$/.test(path)) return handleRuleItem(context, config, path, method);
    return methodNotAllowed(method, ALLOW_METHODS);
  } catch (error) {
    return errorResponse(TAG, method, path, error);
  }
}

async function listRules(config, url) {
  const keyword = url.searchParams.get('search')?.trim();
  // LIKE 通配符必须转义，否则搜 % 会返回整表
  const like = `%${likeEscape(keyword)}%`;
  const rows = keyword
    ? await config.execute(
        `SELECT ${RULE_COLUMNS} FROM rules WHERE domain LIKE ? ESCAPE '\\' OR remark LIKE ? ESCAPE '\\' ORDER BY id`,
        [like, like]
      )
    : await config.execute( `SELECT ${RULE_COLUMNS} FROM rules ORDER BY id`);
  return jsonResponse({ success: true, data: rows });
}

async function exportSubscription(config) {
  const rows = await config.execute( `SELECT ${RULE_COLUMNS} FROM rules ORDER BY id`);
  const lines = rows.map((row) => formatRule(row.domain, row.action, row.remark ?? ''));
  return textResponse(joinRuleLines(lines, ''), {
    headers: { 'Cache-Control': 'public, max-age=60' }
  });
}

async function createRule(context, config) {
  const writeDenied = requireWriteToken(context.env, context.request);
  if (writeDenied) return writeDenied;

  const parsed = await readJson(context);
  if (!parsed.ok) return badRequest('请求体不是有效的 JSON');

  const check = validateRuleInput(parsed.value);
  if (check.error) return badRequest(check.error);

  const { domain, action, remark } = check.value;
  await config.execute('INSERT INTO rules (domain, action, remark) VALUES (?, ?, ?)', [domain, action, remark]);

  const row = (
    await config.execute(
      `SELECT ${RULE_COLUMNS} FROM rules WHERE domain = ? AND action = ? ORDER BY id DESC LIMIT 1`,
      [domain, action]
    )
  )[0];

  return jsonResponse(
    { success: true, data: row ?? { domain, action, remark } },
    { status: 201 }
  );
}

function handleRuleItem(context, config, path, method) {
  const id = path.match(/^\/api\/rules\/(\d+)$/)[1];
  if (method === 'GET') return getRule(config, id);
  return writeRuleItem(context, config, id, method);
}

/** 非读取操作先鉴权，再按方法分发（未支持的方法同样先过鉴权） */
async function writeRuleItem(context, config, id, method) {
  const writeDenied = requireWriteToken(context.env, context.request);
  if (writeDenied) return writeDenied;

  if (method === 'PUT') return updateRule(context, config, id);
  if (method === 'DELETE') return removeRule(config, id);
  return methodNotAllowed(method, ALLOW_METHODS);
}

async function getRule(config, id) {
  const rows = await config.execute( `SELECT ${RULE_COLUMNS} FROM rules WHERE id = ?`, [id]);
  if (!rows.length) return notFound();
  return jsonResponse({ success: true, data: rows[0] });
}

async function updateRule(context, config, id) {
  const parsed = await readJson(context);
  if (!parsed.ok) return badRequest('请求体不是有效的 JSON');

  const check = validateRuleInput(parsed.value);
  if (check.error) return badRequest(check.error);
  const { domain, action, remark } = check.value;

  await config.execute('UPDATE rules SET domain = ?, action = ?, remark = ? WHERE id = ?', [
    domain,
    action,
    remark,
    id
  ]);
  const rows = await config.execute( `SELECT ${RULE_COLUMNS} FROM rules WHERE id = ?`, [id]);
  return jsonResponse({ success: true, data: rows[0] });
}

async function removeRule(config, id) {
  await config.execute('DELETE FROM rules WHERE id = ?', [id]);
  return jsonResponse({ success: true });
}

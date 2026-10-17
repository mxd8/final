/**
 * AI 批量执行器：取一批候选规则 → 逐条调用 Workers AI → 解析结果 → 回写规则 → 更新运行状态。
 *
 * 闭环设计：
 *   - 候选来自 selector（未分流 / 无注释，✏️ 手动编辑过的排最前）；
 *   - ✏️ 规则保护手动结果：AI 只补注释，不改写其 policy（用户已确认的语义）；
 *   - 注释只在为空时补全，绝不覆盖用户已写的备注；
 *   - 处理过的规则置 ai_processed = 1，之后的调度轮次自动跳过（可经 /api/ai/reset 重置）；
 *   - 模型输出解析失败 → 该条计 failed 并照常标记已处理，不会卡死队列；
 *   - 连续 3 次网络级失败 → 中止本轮（可能是配额/断网），未处理的留给下一轮。
 */

import { LOGS_TABLE, nowIso } from '../../_utils/logs/schema.js';
import { normalizePolicy } from '../../_utils/surge-rule/index.js';
import { runModel } from './client.js';
import { loadAiState, saveAiState } from './config.js';
import { selectCandidates } from './selector.js';

/** AI 允许输出的策略集合：内置三策略，避免把模型幻觉出的组名写进库 */
const ALLOWED_POLICIES = new Set(['PROXY', 'DIRECT', 'REJECT']);

const MAX_COMMENT_LENGTH = 80;
/** 单轮内允许的最大连续传输失败数：超过即中止本轮，剩余留给下次 */
const MAX_CONSECUTIVE_ERRORS = 3;
/** running 标记的过期阈值：isolate 中途被杀时状态卡住，超过该时长允许重新调度 */
const RUNNING_STALE_MS = 15 * 60 * 1000;

const SYSTEM_PROMPT = [
  '你是 Surge 代理规则分流助手。根据给定的匹配值判断它应使用的分流策略，并写一句简体中文注释。',
  '规则：',
  '1. 只输出一行 JSON，不要输出任何其他文字、解释或代码块标记。',
  '2. JSON 格式：{"policy":"PROXY|DIRECT|REJECT","comment":"不超过20字的中文说明"}',
  '3. policy 仅限：PROXY（需要代理访问）、DIRECT（国内或本地直连）、REJECT（广告、追踪、恶意域名）。',
  '4. comment 说明该匹配值是什么服务或为什么这样分流。'
].join('\n');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildUserPrompt(item) {
  const lines = [
    `匹配值：${item.value || item.hostname}`,
    `规则类型：${item.type || 'DOMAIN-SUFFIX'}`,
    `当前策略：${item.policy || 'PROXY'}（默认值，未分流）`
  ];
  const comment = String(item.comment ?? '').trim();
  if (comment) lines.push(`用户备注：${comment}`);
  return lines.join('\n');
}

/**
 * 解析模型输出：截取首尾大括号之间的 JSON，校验策略合法性。
 * @returns {{policy: string, comment: string} | null} 非法输出返回 null
 */
export function parseAiOutput(text) {
  const raw = String(text ?? '');
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return null;

  let parsed;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }

  const policy = normalizePolicy(parsed?.policy, '');
  if (!ALLOWED_POLICIES.has(policy)) return null;

  // 去掉模型偶尔带上的 // 前缀与包裹引号，压平空白后截断
  let comment = String(parsed?.comment ?? '')
    .replace(/^\s*\/\/\s*/, '')
    .replace(/^["'「『]+|["'」』]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (comment.length > MAX_COMMENT_LENGTH) comment = comment.slice(0, MAX_COMMENT_LENGTH);

  return { policy, comment };
}

/** 单条回写：policy 按保护开关、comment 仅在为空时补全，并标记已处理 */
function buildWriteBack(item, result, { updatePolicy, fillComment }) {
  return {
    sql: `UPDATE ${LOGS_TABLE}
          SET policy = CASE WHEN ? = 1 THEN ? ELSE policy END,
              comment = CASE WHEN (? = 1 AND (comment IS NULL OR TRIM(comment) = '')) THEN ? ELSE comment END,
              ai_processed = 1
          WHERE hostname = ?`,
    params: [
      updatePolicy ? 1 : 0,
      result.policy,
      fillComment ? 1 : 0,
      result.comment,
      item.hostname
    ]
  };
}

/** 已拿不到可用结果也要标记已处理，防止一条坏输出卡死整个队列 */
function buildMarkProcessed(hostname) {
  return {
    sql: `UPDATE ${LOGS_TABLE} SET ai_processed = 1 WHERE hostname = ?`,
    params: [hostname]
  };
}

/**
 * 执行一轮批量处理（单次调用 = 一批）。
 * @param {object} options
 * @param {boolean} options.force 跳过冷却检查（面板「立即执行」按钮）
 * @returns {Promise<object>} { skipped?, reason?, nextRunAt?, summary }
 */
export async function runAiBatch(db, config, { force = false } = {}) {
  const state = await loadAiState(db);

  // 单飞守卫：另一轮还在跑（15 分钟内启动）时不叠加，前端调度器与外部 cron 并存也不会双跑
  const runningSince = Date.parse(state.running_since || '');
  if (state.running && Number.isFinite(runningSince) && Date.now() - runningSince < RUNNING_STALE_MS) {
    return { skipped: true, reason: 'running' };
  }

  // 冷却：上一轮已把队列清空时，未到执行周期不重复跑；
  // 队列没清完（remaining > 0）视为同一轮次的延续，直接放行继续消化
  const intervalMs = Math.max(5, config.intervalMinutes) * 60 * 1000;
  const lastFinish = Date.parse(state.last_finish_at || '');
  const queueDrained = Number(state.last_summary?.remaining ?? 0) === 0;
  if (!force && queueDrained && Number.isFinite(lastFinish) && Date.now() - lastFinish < intervalMs) {
    return {
      skipped: true,
      reason: 'cooldown',
      nextRunAt: new Date(lastFinish + intervalMs).toISOString()
    };
  }

  await saveAiState(db, {
    ...state,
    running: true,
    running_since: nowIso(),
    last_run_at: nowIso()
  });

  const summary = {
    at: nowIso(),
    batchSize: config.batchSize,
    attempted: 0,
    policyUpdated: 0,
    commentFilled: 0,
    /** 解析失败 / 策略非法：已标记 ai_processed，不会重跑 */
    failed: 0,
    /** 传输级失败（超时 / 限流 / 断网）：未标记，留在队列等下一轮 */
    errors: 0,
    /** 免费额度用尽（429）：当日重试无意义，中止本轮等待次日恢复 */
    quotaExceeded: false,
    aborted: false,
    remaining: 0
  };

  try {
    const { items, remaining } = await selectCandidates(db, config, config.batchSize);
    summary.remaining = remaining;

    let consecutiveErrors = 0;
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index];
      if (index > 0 && config.requestDelayMs > 0) await sleep(config.requestDelayMs);
      summary.attempted += 1;

      let output = null;
      try {
        const text = await runModel(config, config.model, [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: buildUserPrompt(item) }
        ]);
        output = parseAiOutput(text);
        consecutiveErrors = 0;
      } catch (error) {
        // 免费额度（10,000 Neurons/天）用尽：上游返回 429，继续重试只会刷满错误计数，
        // 直接中止本轮；条目未标记已处理，队列原样保留，次日额度恢复后自动续跑
        if (Number(error?.status) === 429) {
          summary.quotaExceeded = true;
          summary.aborted = true;
          console.warn('[ai][executor] 今日 AI 额度已达上限（429），中止本轮');
          break;
        }
        // 传输级失败（超时 / 限流 / 断网）：不标记已处理，留给下一轮
        consecutiveErrors += 1;
        summary.errors += 1;
        console.warn('[ai][executor] 推理调用失败', { hostname: item.hostname, message: error?.message });
        if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
          summary.aborted = true;
          break;
        }
        continue;
      }

      if (!output) {
        summary.failed += 1;
        await db.batch([buildMarkProcessed(item.hostname)]);
        continue;
      }

      const updatePolicy = !Number(item.manual_edited);
      const commentEmpty = !String(item.comment ?? '').trim();
      const fillComment = config.fillComment && commentEmpty;
      await db.batch([buildWriteBack(item, output, { updatePolicy, fillComment })]);
      if (updatePolicy) summary.policyUpdated += 1;
      if (fillComment && output.comment) summary.commentFilled += 1;
    }

    // 出队数 = 尝试数 - 传输失败（它们仍在队列里）
    summary.remaining = Math.max(0, remaining - summary.attempted + summary.errors);
    return { skipped: false, summary };
  } finally {
    const latest = await loadAiState(db);
    await saveAiState(db, {
      ...latest,
      running: false,
      last_finish_at: nowIso(),
      last_summary: summary
    });
  }
}

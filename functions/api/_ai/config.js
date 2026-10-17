/**
 * AI 全局配置数据访问层：存 app_prefs 表的固定保留用户 system 下。
 *
 * 为什么不跟设备偏好混在一起：Workers AI 凭据与调度开关是跨设备共享的全局实体
 * （与 subscriptions 的取舍同理），任何一台设备改配置，所有设备的调度行为一致。
 * 通用 prefs 接口对 system 用户做了拒绝守卫（见 api/prefs.js），
 * 唯一读写入口是 /api/ai/*，凭据不会被匿名接口带出去。
 */

import { PREFS_TABLE } from '../../_utils/prefs.js';
import { nowIso } from '../../_utils/logs/schema.js';

/** 配置与运行状态都挂在 system 用户下，键名前缀 ai. */
export const AI_CONFIG_USER = 'system';
const CONFIG_KEY = 'ai.config';
const STATE_KEY = 'ai.state';

export const AI_DEFAULT_MODEL = '@cf/meta/llama-3.1-8b-instruct';

/** 默认配置：安全优先（默认暂停、只处理未分流），间隔 6 小时防跑飞 */
export const AI_DEFAULT_CONFIG = Object.freeze({
  cfAccountId: '',
  cfApiToken: '',
  model: AI_DEFAULT_MODEL,
  enabled: false,
  intervalMinutes: 360,
  batchSize: 10,
  requestDelayMs: 1000,
  onlyUnclassified: true,
  fillComment: true,
  priorityEdited: true
});

const LIMITS = Object.freeze({
  accountId: 64,
  token: 256,
  model: 128,
  intervalMin: 5,
  intervalMax: 10080,
  batchMin: 1,
  batchMax: 100,
  delayMin: 0,
  delayMax: 10000
});

function toBool(value, fallback) {
  if (typeof value === 'boolean') return value;
  if (value === 'true' || value === 1 || value === '1') return true;
  if (value === 'false' || value === 0 || value === '0') return false;
  return fallback;
}

function toInt(value, fallback, min, max) {
  const num = Math.round(Number(value));
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, num));
}

function toText(value, max) {
  return String(value ?? '').trim().slice(0, max);
}

/**
 * 合并用户提交：undefined / null 的键保持原值；cfApiToken 为空串或掩码（••••开头）
 * 表示「不修改」，只有显式传入新串才覆盖 —— 保证 token 永不从浏览器回传后落库。
 */
export function mergeAiConfig(current, patch = {}) {
  const merged = { ...AI_DEFAULT_CONFIG, ...current };
  if ('cfAccountId' in patch) merged.cfAccountId = toText(patch.cfAccountId, LIMITS.accountId);
  if ('model' in patch) merged.model = toText(patch.model, LIMITS.model) || AI_DEFAULT_MODEL;
  if ('cfApiToken' in patch) {
    const token = toText(patch.cfApiToken, LIMITS.token);
    if (token && !token.startsWith('••')) merged.cfApiToken = token;
  }
  merged.enabled = toBool(patch.enabled, merged.enabled);
  merged.onlyUnclassified = toBool(patch.onlyUnclassified, merged.onlyUnclassified);
  merged.fillComment = toBool(patch.fillComment, merged.fillComment);
  merged.priorityEdited = toBool(patch.priorityEdited, merged.priorityEdited);
  merged.intervalMinutes = toInt(patch.intervalMinutes, merged.intervalMinutes, LIMITS.intervalMin, LIMITS.intervalMax);
  merged.batchSize = toInt(patch.batchSize, merged.batchSize, LIMITS.batchMin, LIMITS.batchMax);
  merged.requestDelayMs = toInt(patch.requestDelayMs, merged.requestDelayMs, LIMITS.delayMin, LIMITS.delayMax);
  return merged;
}

async function readPref(db, key) {
  const rows = await db.execute(
    `SELECT setting_value FROM ${PREFS_TABLE} WHERE user_id = ? AND setting_key = ?`,
    [AI_CONFIG_USER, key]
  );
  return rows[0]?.setting_value ?? '';
}

async function writePref(db, key, value) {
  await db.batch([
    {
      sql: `INSERT INTO ${PREFS_TABLE} (user_id, setting_key, setting_value, updated_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(user_id, setting_key)
            DO UPDATE SET setting_value = excluded.setting_value, updated_at = excluded.updated_at`,
      params: [AI_CONFIG_USER, key, value, nowIso()]
    }
  ]);
}

/** 读取配置（缺失的键回落默认值），坏 JSON 不炸路由，回落默认 */
export async function loadAiConfig(db) {
  try {
    const raw = await readPref(db, CONFIG_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return mergeAiConfig(parsed, {});
  } catch (error) {
    console.warn('[ai][config] 配置解析失败，使用默认值', error?.message);
    return { ...AI_DEFAULT_CONFIG };
  }
}

/** 保存配置：读旧值 → 合并 → 落库，返回保存后的完整配置 */
export async function saveAiConfig(db, patch) {
  const current = await loadAiConfig(db);
  const merged = mergeAiConfig(current, patch);
  await writePref(db, CONFIG_KEY, JSON.stringify(merged));
  return merged;
}

/** 运行状态：last_run_at / last_finish_at / running / last_summary */
export async function loadAiState(db) {
  try {
    const raw = await readPref(db, STATE_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export async function saveAiState(db, state) {
  await writePref(db, STATE_KEY, JSON.stringify(state || {}));
}

/** token 掩码：只留末 4 位，空值返回空串 */
export function maskToken(token) {
  const text = String(token ?? '');
  if (!text) return '';
  if (text.length <= 4) return '••••';
  return `••••${text.slice(-4)}`;
}

/** 面板可见配置：token 永不下发原文，只带掩码与是否已配置标志 */
export function publicAiConfig(config) {
  const { cfApiToken, ...rest } = config;
  return { ...rest, tokenMask: maskToken(cfApiToken), hasToken: Boolean(cfApiToken) };
}

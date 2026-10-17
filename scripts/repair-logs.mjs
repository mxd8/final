#!/usr/bin/env node
/**
 * 数据修复脚本：一次性修正 surge_logs 里的历史脏数据，并把缺失的 first_time 补上。
 *
 * 修两类问题：
 *   1. policy 被写成参数名。旧版 isPolicyName 只按字符集判断，no-resolve / dns-failed
 *      这类官方参数名完全符合「自定义策略组名」的正则，导致
 *      `IP-CIDR,2402:db40:...:5,no-resolve`（策略段缺失、参数直接顶上来）被解析成
 *      policy=NO-RESOLVE。这批记录导出成规则后 Surge 找不到叫 no-resolve 的策略组，
 *      整条规则失效。这里把参数名回落成默认策略 PROXY。
 *   2. first_time 从未回填。first_time 列是后加的，历史行的值都是 ''，
 *      面板「首次命中」显示不出来。这里用 time（最近一次命中）兜底——
 *      对只命中过一次的记录，两者本来就相等。
 *
 * 用法（凭据从 .dev.vars 读，也可以在命令行显式传入）：
 *   node scripts/repair-logs.mjs                 # 先只看会改什么
 *   node scripts/repair-logs.mjs --apply         # 真正执行
 *   TURSO_API_URL=... TURSO_AUTH_TOKEN=... node scripts/repair-logs.mjs --apply
 *
 * 不依赖仓库里的依赖（不 import functions/），用 Node 自带 fetch 直接打 Turso HTTP API，
 * 这样不会因为改了后端解析逻辑反而影响修复脚本本身。
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const APPLY = process.argv.includes('--apply');

/* ------------------------------ 凭据 ------------------------------ */

/** 读 .dev.vars：只取 TURSO_ 开头的键，别的凭据一律不带进内存 */
function readDevVars() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  try {
    const text = readFileSync(`${root}/.dev.vars`, 'utf8');
    const out = {};
    for (const line of text.split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (!match || !match[1].startsWith('TURSO_')) continue;
      out[match[1]] = match[2].replace(/^["']|["']$/g, '');
    }
    return out;
  } catch {
    return {};
  }
}

const vars = readDevVars();
const apiUrl = process.env.TURSO_API_URL || vars.TURSO_API_URL || '';
const authToken = process.env.TURSO_AUTH_TOKEN || vars.TURSO_AUTH_TOKEN || '';

if (!apiUrl || !authToken) {
  console.error('缺少凭据：请配置 TURSO_API_URL / TURSO_AUTH_TOKEN（.dev.vars 或环境变量）');
  process.exit(2);
}

/* ------------------------------ Turso ------------------------------ */

const TIMEOUT_MS = 30000;

/** 执行一批语句，一个事务、一次往返 */
async function run(statements) {
  const response = await fetch(apiUrl, {
    method: 'POST',
    headers: { Authorization: `Bearer ${authToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ statements: statements.map(({ sql, params = [] }) => ({ q: sql, params })), serializable: true }),
    signal: AbortSignal.timeout(TIMEOUT_MS)
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || payload?.error) throw new Error(`Turso 请求失败：${payload?.error ?? response.status}`);
  if (!Array.isArray(payload)) throw new Error('Turso 返回了意外格式');
  for (const statement of payload) {
    if (statement.error) throw new Error(`SQL 失败：${statement.error}\n${statement.q}`);
  }
  return payload;
}

/** 读取列的当前结构，判断 first_time 是否已存在 */
async function tableColumns() {
  const [result] = await run([{ sql: 'PRAGMA table_info(surge_logs)' }]);
  return toRows(result);
}

function toRows(statement) {
  if (!statement?.results || !Array.isArray(statement.results.columns)) return [];
  const { columns, rows = [] } = statement.results;
  return rows.map((row) => {
    const record = {};
    columns.forEach((col, i) => { record[col] = row[i]; });
    return record;
  });
}

/**
 * 取一条语句影响到的行数。
 * Turso 的远端批量执行不会像驱动那样填 `changes`，改在 results 里给
 * `rows_written`；本地 node:sqlite 才是 `changes`。两种都读，避免误报 0。
 */
function affected(statement) {
  return Number(statement?.changes ?? statement?.results?.rows_written ?? 0);
}

/** 官方参数名（与 functions/_utils/surge-rule 保持一致） */
const RULE_PARAMS = new Set([
  'no-resolve', 'dns-failed', 'extended-matching', 'pre-matching', 'requires-resolve',
  'notification-text', 'notification-interval', 'update-interval', 'always-capture'
]);

/* ------------------------------ 执行 ------------------------------ */

const columns = await tableColumns();
const hasFirstTime = columns.some((column) => column.name === 'first_time');

if (!hasFirstTime) {
  const alter = 'ALTER TABLE surge_logs ADD COLUMN first_time TEXT NOT NULL DEFAULT \'\'';
  console.log(`\n[1/4] 补建列：\n${APPLY ? '  → ' : '  （dry-run）'}${alter}`);
  if (APPLY) await run([{ sql: alter }]);
}

// 策略被写成参数名的记录。按参数名归组，便于看清都踩了哪些参数。
const badRows = toRows((await run([
  {
    sql: `SELECT policy AS p, COUNT(*) AS c FROM surge_logs
          WHERE LOWER(policy) IN (${[...RULE_PARAMS].map(() => '?').join(',')})
          GROUP BY LOWER(policy) ORDER BY c DESC`,
    params: [...RULE_PARAMS]
  }
]))[0]);
const badTotal = badRows.reduce((sum, row) => sum + Number(row.c || 0), 0);

console.log('\n[2/4] 策略被写成参数名（将回落为 PROXY）：');
if (!badTotal) {
  console.log('  无');
} else {
  for (const row of badRows) console.log(`  ${row.p}: ${row.c} 条`);
  console.log(`  合计 ${badTotal} 条`);
  if (APPLY) {
    const [result] = await run([{
      sql: `UPDATE surge_logs SET policy = 'PROXY'
            WHERE LOWER(policy) IN (${[...RULE_PARAMS].map(() => '?').join(',')})`,
      params: [...RULE_PARAMS]
    }]);
    console.log(`  → 已修复 ${affected(result)} 条`);
  }
}

// first_time 为空：首次插入的记录（含迁移前数据）不会有值
const emptyFirst = Number(toRows((await run([
  { sql: `SELECT COUNT(*) AS c FROM surge_logs WHERE first_time IS NULL OR TRIM(first_time) = ''` }
]))[0])[0].c ?? 0);

console.log(`\n[3/4] first_time 为空的记录：${emptyFirst} 条（用 time 兜底，仅命中过一次时二者相等）`);
if (APPLY && emptyFirst) {
  const [result] = await run([{
    sql: `UPDATE surge_logs SET first_time = time WHERE first_time IS NULL OR TRIM(first_time) = ''`
  }]);
  console.log(`  → 已回填 ${affected(result)} 条`);
}

// 顺手清掉历史遗留：value 为空的非 FINAL 记录导出会是 `TYPE,,PROXY`，Surge 读不了
const emptyValue = Number(toRows((await run([
  { sql: `SELECT COUNT(*) AS c FROM surge_logs WHERE type != 'FINAL' AND (value IS NULL OR TRIM(value) = '')` }
]))[0])[0].c ?? 0);

console.log(`\n[4/4] value 为空的非 FINAL 记录：${emptyValue} 条（不改动，仅提示）`);

console.log(APPLY ? '\n完成。' : '\nDry-run 结束，未改动任何数据。加 --apply 真正执行。');

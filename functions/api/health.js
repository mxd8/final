/**
 * 部署健康检测：/api/health?mode=basic|deep
 *
 * 目标：新用户部署完成后五分钟内自证整套链路（浏览器 → Pages → 数据库 →
 * Surge 客户端）已通；老用户排查配置漂移与令牌轮换事故。
 *
 * 设计原则（与 docs/feature-requirements.md 1.2 一致）：
 *   - basic 只读（配置在位与格式 → 适配器初始化 → ping → Schema 一致性 →
 *     读权限 → 令牌在位性 → 客户端心跳）；deep 才有写副作用，且必须用户主动触发；
 *   - 深度探针（写 / 读回 / 删）走独立的 health_probe 表并在同一批量事务内完成，
 *     失败自动回滚，任何情况下不留残留数据；
 *   - 诊断结果一律脱敏：绝不回传令牌值与完整数据库地址，只回主机名；
 *   - 服务端节流：deep 模式按来源 IP 每分钟至多一次（isolate 内尽力而为）；
 *   - 单项失败不中断管道，逐项给出状态 / 耗时 / 说明 / 修复建议 / 文档锚点。
 */

import { jsonResponse, notFound, errorResponse } from '../_utils/http.js';
import { requireWriteToken, requireHitToken, extractUrlOrHeaderToken, configuredWriteToken, configuredHitToken, anyConfiguredToken } from '../_utils/auth.js';
import { resolveDbBackend, getAdapter, describeBackend, DB_BACKENDS } from '../_utils/db/factory.js';
import { ConfigError, DB_ERROR_LABELS } from '../_utils/db/contract.js';
import { DB_SCHEMA_VERSION, describeSchemaState, HEALTH_PROBE_TABLE } from '../_utils/db/ddl.js';
import { redactUrl } from '../_utils/turso.js';
import { listHeartbeats, isHeartbeatOnline } from '../_utils/heartbeat.js';
import { COMPONENT_VERSIONS, BUILD_LABEL } from '../_utils/build-meta.js';

const TAG = 'api/health';

const DEEP_THROTTLE_MS = 60 * 1000;
const deepThrottle = new Map();

const REQUIRED_LOG_COLUMNS = ['hostname', 'type', 'value', 'policy', 'params', 'comment', 'source', 'ip', 'username', 'first_time', 'time', 'count'];
const REQUIRED_DEVICE_COLUMNS = ['device_id', 'name', 'username', 'ip', 'panel_version', 'logger_version', 'config_status', 'last_online_time'];

/** 单项检查的可读锚点：readme 对应章节 */
const DOC = {
  env: '#配置环境变量',
  db: '#部署教程turso--cloudflare-pages',
  schema: '#建表一次性',
  read: '#建表一次性',
  probe: '#部署教程turso--cloudflare-pages',
  token: '#配置环境变量',
  hitToken: '#surge-安装教程',
  client: '#surge-安装教程'
};

function check(id, name, doc, fn) {
  return { id, name, doc, fn };
}

function now() {
  return Date.now();
}

/** 深度探针：写 → 读回 → 删 同一批量事务，逐项核验 */
async function runProbe(db) {
  const marker = `probe-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const payload = JSON.stringify({ ok: 1, at: new Date().toISOString() });
  const results = await db.batch([
    {
      sql: `INSERT INTO ${HEALTH_PROBE_TABLE} (marker, payload, created_at) VALUES (?, ?, ?)`,
      params: [marker, payload, new Date().toISOString()]
    },
    { sql: `SELECT marker, payload FROM ${HEALTH_PROBE_TABLE} WHERE marker = ?`, params: [marker] },
    { sql: `DELETE FROM ${HEALTH_PROBE_TABLE} WHERE marker = ?`, params: [marker] }
  ]);
  const [inserted, readBack, deleted] = results;
  return {
    writeOk: inserted.changes > 0,
    readOk: readBack.rows.length === 1 && readBack.rows[0].payload === payload,
    deleteOk: deleted.changes === 1
  };
}

/** 检查 1：环境变量在位性与格式 */
function checkConfig(env) {
  const issues = [];
  let backend;
  try {
    backend = resolveDbBackend(env);
  } catch (error) {
    return { status: 'fail', detail: error.message, fix: `把 DB_BACKEND 改为 ${DB_BACKENDS.join(' / ')}` };
  }

  if (backend === 'turso') {
    const url = String(env.TURSO_API_URL ?? '').trim();
    const token = String(env.TURSO_AUTH_TOKEN ?? '').trim();
    if (!url || !token) {
      issues.push(`缺少环境变量：${[!url && 'TURSO_API_URL', !token && 'TURSO_AUTH_TOKEN'].filter(Boolean).join('、')}`);
    } else if (url.startsWith('libsql://')) {
      issues.push('TURSO_API_URL 不能用 libsql:// 协议（Workers 无法解析），请改为 https:// 形式');
    } else {
      try {
        const parsed = new URL(url);
        if (parsed.protocol !== 'https:') issues.push(`TURSO_API_URL 必须是 https:// 开头，当前为 ${parsed.protocol}`);
      } catch {
        issues.push(`TURSO_API_URL 不是合法地址：${redactUrl(url)}`);
      }
    }
  } else if (backend === 'd1') {
    const binding = env.DB_D1;
    if (!binding || typeof binding.prepare !== 'function') {
      issues.push(`DB_BACKEND=d1 需要平台绑定 D1 数据库（绑定名 DB_D1）`);
    }
  } else if (backend === 'sqlite') {
    if (!String(env.DB_SQLITE_PATH ?? '').trim()) {
      issues.push('DB_BACKEND=sqlite 需要环境变量 DB_SQLITE_PATH 指定本地库文件路径');
    }
  }

  if (!configuredWriteToken(env)) {
    return {
      status: issues.length ? 'fail' : 'warn',
      detail: (issues.length ? issues.join('；') + '；' : '') + '写接口令牌 PANEL_WRITE_TOKEN 未配置：写接口保持开放（响应带 Warning 头），建议配置',
      fix: issues.length ? '按缺失项补齐环境变量' : '在 Cloudflare 环境变量里配置 PANEL_WRITE_TOKEN',
      backend
    };
  }
  if (issues.length) {
    return { status: 'fail', detail: issues.join('；'), fix: '按缺失项补齐环境变量', backend };
  }

  let hitWarn = '';
  if (!configuredHitToken(env)) {
    hitWarn = '；上报令牌 PANEL_HIT_TOKEN 未配置：上报接口一律拒绝（Surge 无法写入数据）';
  }
  return {
    status: hitWarn ? 'warn' : 'pass',
    detail: `环境变量在位（后端 ${backend}）${hitWarn}`,
    fix: hitWarn ? '配置 PANEL_HIT_TOKEN 并与 Surge 模块参数 FINAL_DB_TOKEN 核对' : '',
    backend
  };
}

/** 组装检查管道；适配器与 env 由外层注入 */
function buildPipeline(env) {
  return [
    check(1, '配置完整性', DOC.env, async () => checkConfig(env)),
    check(2, '数据库连通性', DOC.db, async (ctx) => {
      await ctx.db.ping();
      return { status: 'pass', detail: `连通正常（${describeBackend(ctx.db)}）` };
    }),
    check(3, 'Schema 一致性', DOC.schema, async (ctx) => {
      const state = await describeSchemaState(ctx.db, 'surge_logs', REQUIRED_LOG_COLUMNS);
      if (!state.ok) return { status: 'fail', detail: state.detail, fix: '部署后访问 /api/schema 取建表语句，或等待首次访问自动迁移' };
      const devices = await describeSchemaState(ctx.db, 'devices', REQUIRED_DEVICE_COLUMNS);
      if (!devices.ok) return { status: 'fail', detail: devices.detail, fix: '首次访问任意 /api 接口会自动迁移；也可访问 /api/schema 取建表语句手工执行' };
      const label = ctx.db.backend === 'turso' ? 'Turso' : ctx.db.backend === 'd1' ? 'D1' : 'SQLite';
      return { status: 'pass', detail: `${state.detail}；devices 注册表齐全；DB_SCHEMA_VERSION = ${DB_SCHEMA_VERSION}（${label}）` };
    }),
    check(4, '读权限', DOC.read, async (ctx) => {
      await ctx.db.execute('SELECT id FROM surge_logs LIMIT 1');
      return { status: 'pass', detail: 'surge_logs 读取正常' };
    }),
    check(5, '写探针（写入临时行）', DOC.probe, async (ctx) => {
      ctx.probe = await runProbe(ctx.db);
      if (!ctx.probe.writeOk) return { status: 'fail', detail: '探针行未写入（权限 / 配额 / 锁冲突）', fix: '检查数据库账号的写权限与配额' };
      return { status: 'pass', detail: 'health_probe 写入成功（同一事务，稍后删除）' };
    }),
    check(6, '读回校验', DOC.probe, async (ctx) => {
      if (!ctx.probe) return { status: 'skip', detail: '写探针未执行' };
      if (!ctx.probe.readOk) return { status: 'fail', detail: '读回内容与写入不一致，写入不可靠', fix: '检查数据库复制 / 事务配置' };
      return { status: 'pass', detail: '探针行读回一致' };
    }),
    check(7, '删除权限', DOC.probe, async (ctx) => {
      if (!ctx.probe) return { status: 'skip', detail: '写探针未执行' };
      if (!ctx.probe.deleteOk) return { status: 'fail', detail: '探针行删除失败：账号无写权限或只读', fix: '改用具备写权限的数据库令牌' };
      return { status: 'pass', detail: '探针行已删除，无残留数据' };
    }),
    check(8, '写令牌校验', DOC.token, async (ctx) => {
      const configured = configuredWriteToken(ctx.env);
      if (!configured) return { status: 'warn', detail: 'PANEL_WRITE_TOKEN 未配置，写接口开放（跳过校验）' };
      const denied = requireWriteToken(ctx.env, ctx.request);
      if (denied) {
        // 基础模式的请求可能没带令牌（配置检测页尚未保存令牌）：提示而非误报失败；
        // 深度检测强制校验（缺令牌 / 令牌错都是失败）
        return ctx.mode === 'deep'
          ? { status: 'fail', detail: '深度检测必须携带正确的写令牌', fix: '到面板「写接口令牌」处保存正确令牌后重试' }
          : { status: 'warn', detail: 'PANEL_WRITE_TOKEN 已配置；本次请求未携带正确令牌，写操作会被拒绝', fix: '到面板「写接口令牌」处保存正确令牌' };
      }
      return { status: 'pass', detail: '写令牌匹配' };
    }),
    check(9, '上报令牌校验', DOC.hitToken, async (ctx) => {
      const tokens = anyConfiguredToken(ctx.env);
      if (!tokens.length) return { status: 'fail', detail: 'PANEL_HIT_TOKEN 未配置：上报接口一律拒绝', fix: '在 Cloudflare 环境变量配置 PANEL_HIT_TOKEN' };
      if (ctx.mode !== 'deep') return { status: 'pass', detail: 'PANEL_HIT_TOKEN 在位（深度检测将模拟一次带令牌的校验）' };
      const supplied = extractUrlOrHeaderToken(ctx.context);
      const denied = requireHitToken(ctx.env, supplied);
      if (denied) return { status: 'fail', detail: '请求携带的上报令牌不匹配', fix: '与 Surge 模块参数 FINAL_DB_TOKEN 核对' };
      return { status: 'pass', detail: '上报令牌匹配（模拟合法探测上报通过）' };
    }),
    check(10, '客户端连通状态', DOC.client, async (ctx) => {
      const beats = await listHeartbeats(ctx.db, { limit: 5 });
      if (!beats.length) {
        return {
          status: 'warn',
          detail: '尚未收到任何 Surge 面板心跳：安装 FINAL 模块并配置参数，面板刷新一次即上报',
          fix: '按 readme「Surge 安装教程」安装模块并填写 FINAL_WEB_URL / FINAL_DB_TOKEN',
          clients: []
        };
      }
      const latest = beats[0];
      const online = isHeartbeatOnline(latest.lastSeen);
      const panelBehind = latest.panelVersion && latest.panelVersion !== COMPONENT_VERSIONS.panel;
      const loggerBehind = latest.loggerVersion && latest.loggerVersion !== COMPONENT_VERSIONS.logger;
      return {
        status: online ? 'pass' : 'warn',
        detail:
          `最近心跳 ${latest.lastSeen}（${online ? '在线' : '离线，超过两个刷新周期'}），` +
          `面板脚本 ${latest.panelVersion || '未知'} / 捕获脚本 ${latest.loggerVersion || '未知'}` +
          (panelBehind ? '；面板脚本版本落后' : '') +
          (loggerBehind ? '；捕获脚本本地副本版本落后，请重新另存' : ''),
        fix: online ? (panelBehind || loggerBehind ? '更新 Surge 模块并重新另存捕获脚本' : '') : '打开 Surge 面板刷新一次即可恢复心跳',
        clients: beats
      };
    })
  ];
}

async function runPipeline(env, request, context, mode) {
  const started = now();
  const results = [];
  const shared = { env, request, context, mode, probe: null };

  for (const item of buildPipeline(env)) {
    const isDeepOnly = [5, 6, 7].includes(item.id);
    if (isDeepOnly && mode !== 'deep') {
      results.push({ id: item.id, name: item.name, status: 'skip', ms: 0, detail: '深度检测项（只读模式跳过）', fix: '', doc: item.doc });
      continue;
    }
    const t0 = now();
    try {
      // 数据库类检查（2-7、10）依赖适配器：前面的检查失败时管道继续但这里懒初始化
      if ([2, 3, 4, 5, 6, 7, 10].includes(item.id) && !shared.db) {
        shared.db = await getAdapter(env);
      }
      const outcome = (await item.fn(shared)) || {};
      results.push({ id: item.id, name: item.name, status: outcome.status || 'pass', ms: now() - t0, detail: outcome.detail || '', fix: outcome.fix || '', doc: item.doc, ...(outcome.clients ? { clients: outcome.clients } : {}) });
    } catch (error) {
      const kind = error instanceof ConfigError ? null : DB_ERROR_LABELS[error?.kind] ? error.kind : 'unknown';
      results.push({
        id: item.id,
        name: item.name,
        status: 'fail',
        ms: now() - t0,
        detail: `${error?.message ?? error}${kind ? `（${DB_ERROR_LABELS[kind]}）` : ''}`,
        fix: kind === 'timeout' ? '稍后重试；持续超时检查数据库网络可达性' : kind === 'auth' ? '核对数据库访问令牌' : kind === 'connection' ? '检查数据库地址与网络可达性' : '按 readme「部署教程」核对配置',
        doc: item.doc
      });
    }
  }
  return { results, elapsedMs: now() - started };
}

function summarize(results) {
  const counts = { pass: 0, warn: 0, fail: 0, skip: 0 };
  for (const item of results) counts[item.status] = (counts[item.status] ?? 0) + 1;
  const overall = counts.fail ? 'fail' : counts.warn ? 'warn' : 'pass';
  const worst = results.find((item) => item.status === 'fail') || results.find((item) => item.status === 'warn');
  const headline = overall === 'pass'
    ? '全部检查通过，部署链路健康'
    : `${worst?.name ?? '检测'}未通过：${worst?.detail ?? ''}`;
  return { counts, overall, headline };
}

function handlePreflight(request) {
  const origin = request.headers.get('origin') ?? '';
  if (!origin) return new Response(null, { status: 204 });
  // 仅放行面板自身来源（同源部署 / 自定义域名指向同一部署），不用通配符
  try {
    if (new URL(origin).host === new URL(request.url).host) {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': origin,
          'Access-Control-Allow-Methods': 'GET, OPTIONS',
          'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Panel-Token'
        }
      });
    }
  } catch { /* 非法来源一律不放行 */ }
  return new Response(null, { status: 403 });
}

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';

  try {
    if (request.method === 'OPTIONS') return handlePreflight(request);
    if (request.method !== 'GET') return jsonResponse({ success: false, error: '不支持的方法' }, { status: 405, headers: { Allow: 'GET, OPTIONS' } });
    if (path !== '/api/health') return notFound(`未知的接口：${path}`);

    const mode = url.searchParams.get('mode') === 'deep' ? 'deep' : 'basic';

    if (mode === 'deep') {
      // 节流：按来源 IP 每分钟至多一次（isolate 内尽力而为）
      const ip = request.headers.get('cf-connecting-ip') || 'local';
      const last = deepThrottle.get(ip) ?? 0;
      if (Date.now() - last < DEEP_THROTTLE_MS) {
        return jsonResponse(
          { success: false, error: '深度检测过于频繁，请一分钟后再试' },
          { status: 429, headers: { 'Cache-Control': 'no-store' } }
        );
      }
      // 配置了写令牌时，深度检测必须携带正确令牌
      if (configuredWriteToken(env)) {
        const denied = requireWriteToken(env, request);
        if (denied) return denied;
      }
      deepThrottle.set(ip, Date.now());
    }

    const { results, elapsedMs } = await runPipeline(env, request, context, mode);
    const summary = summarize(results);
    const dbBackend = (() => {
      try {
        return resolveDbBackend(env);
      } catch {
        return 'unknown';
      }
    })();

    return jsonResponse(
      {
        success: true,
        data: {
          mode,
          elapsedMs,
          dbBackend,
          serverVersion: BUILD_LABEL,
          dbSchemaVersion: DB_SCHEMA_VERSION,
          checks: results,
          summary
        }
      },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (error) {
    return errorResponse(TAG, request.method, url.pathname, error);
  }
}

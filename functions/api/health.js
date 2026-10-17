/**
 * 部署健康检测（v4 诊断分类升级）：/api/health?mode=basic|deep
 *
 * 目标：新用户部署完成后五分钟内自证整套链路（浏览器 → Pages → 数据库 →
 * Surge 客户端）已通；老用户排查配置漂移与令牌轮换事故。
 *
 * v4 变化：
 *   - 检测项按「分类」组织：system（系统配置）/ database（数据库）/ client
 *     （Surge 客户端）/ version（版本与更新），响应同时给出平铺 checks（兼容）
 *     与 categories 分组视图；全链路自证汇总在 chain 字段；
 *   - 检测项按需隔离：?deviceId= / ?username= / ?device-type= 把客户端类检测
 *     限定到单台设备 / 单个用户 / 单一设备类型，避免全局共用导致的误报；
 *   - 深度检测（写探针）需要显式二次确认：?confirm=1（前端弹窗确认后附带）；
 *   - 新增「版本与更新监控」：网页面板 / Surge 面板脚本 / 捕获脚本本地副本 /
 *     Surge 模块的版本状态与分发通道，提示版本落后与更新建议。
 *
 * 设计原则（沿用）：
 *   - basic 只读；deep 才有写副作用，且必须用户主动触发（二次确认 + 令牌）；
 *   - 深度探针（写 / 读回 / 删）走独立的 health_probe 表并在同一批量事务内完成，
 *     失败自动回滚，任何情况下不留残留数据；
 *   - 诊断结果一律脱敏：绝不回传令牌值与完整数据库地址，只回主机名；
 *   - 服务端节流：deep 模式按来源 IP 每分钟至多一次（isolate 内尽力而为）；
 *   - 单项失败不中断管道，逐项给出状态 / 耗时 / 说明 / 修复建议 / 文档锚点。
 */

import { jsonResponse, notFound, errorResponse, badRequest } from '../_utils/http.js';
import { requireWriteToken, requireHitToken, extractUrlOrHeaderToken, configuredWriteToken, configuredHitToken, anyConfiguredToken } from '../_utils/auth.js';
import { isAuthEnabled, requireMutationAuth } from '../_utils/auth/principal.js';
import { resolveDbBackend, getAdapter, describeBackend, DB_BACKENDS } from '../_utils/db/factory.js';
import { ConfigError, DB_ERROR_LABELS } from '../_utils/db/contract.js';
import { DB_SCHEMA_VERSION, describeSchemaState, HEALTH_PROBE_TABLE } from '../_utils/db/ddl.js';
import { redactUrl } from '../_utils/turso.js';
import { listHeartbeats, isHeartbeatOnline } from '../_utils/heartbeat.js';
import { listDevices, DEVICE_CONFIG_STATUS } from '../_utils/devices.js';
import { DEVICE_PROFILES } from '../_utils/device-profiles.js';
import { compareSemver } from '../_utils/devices.js';
import { COMPONENT_VERSIONS, BUILD_LABEL, PANEL_ORIGIN } from '../_utils/build-meta.js';

const TAG = 'api/health';

const DEEP_THROTTLE_MS = 60 * 1000;
const deepThrottle = new Map();

const REQUIRED_LOG_COLUMNS = ['hostname', 'type', 'value', 'policy', 'params', 'comment', 'source', 'ip', 'username', 'first_time', 'time', 'count'];
const REQUIRED_DEVICE_COLUMNS = ['device_id', 'name', 'username', 'ip', 'panel_version', 'logger_version', 'config_status', 'last_online_time'];

/** 检测分类（v4）：响应 categories 的分组依据与前端渲染顺序一致 */
export const CHECK_CATEGORIES = [
  { id: 'system', label: '系统配置', description: '环境变量、鉴权体系与令牌在位性' },
  { id: 'database', label: '数据库', description: '连通性、Schema 一致性、读写权限与探针' },
  { id: 'client', label: 'Surge 客户端', description: '面板心跳、设备在线状态与配置告警' },
  { id: 'version', label: '版本与更新', description: '面板 / 脚本 / 模块版本比对与分发通道' }
];

/** 单项检查的可读锚点：readme 对应章节 */
const DOC = {
  env: '#配置环境变量',
  db: '#部署教程turso--cloudflare-pages',
  schema: '#建表一次性',
  read: '#建表一次性',
  probe: '#部署教程turso--cloudflare-pages',
  token: '#配置环境变量',
  hitToken: '#surge-安装教程',
  client: '#surge-安装教程',
  version: '#版本体系与一致性比对'
};

function check(id, name, category, doc, fn) {
  return { id, name, category, doc, fn };
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

/** 检查 1：环境变量在位性与格式（system 分类） */
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
      detail: (issues.length ? issues.join('；') + '；' : '') + '写接口令牌 PANEL_WRITE_TOKEN 未配置：建议配置（或完成多用户鉴权初始化）',
      fix: issues.length ? '按缺失项补齐环境变量' : '在 Cloudflare 环境变量里配置 PANEL_WRITE_TOKEN，或执行 /api/auth/bootstrap 初始化管理员',
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

/** 检查 11（新增）：多用户鉴权体系状态（system 分类） */
async function checkAuthSystem(ctx) {
  const enabled = await isAuthEnabled(ctx.db);
  if (!enabled) {
    return {
      status: 'warn',
      detail: '多用户鉴权体系尚未初始化：写接口回落令牌校验；启用后所有添加数据的请求都必须携带合法鉴权信息',
      fix: '面板「用户」页执行管理员引导（POST /api/auth/bootstrap）创建首个管理员',
      users: 0
    };
  }
  const rows = await ctx.db.execute('SELECT COUNT(*) AS n FROM users WHERE status = \'active\'');
  const admins = await ctx.db.execute(`SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND status = 'active'`);
  const activeCount = Number(rows[0]?.n ?? 0);
  const adminCount = Number(admins[0]?.n ?? 0);
  if (!adminCount) {
    return { status: 'fail', detail: '鉴权体系已启用但没有可用管理员账号，管理面将被锁死', fix: '用写令牌调用 /api/users 恢复一个 admin 用户' };
  }
  return { status: 'pass', detail: `鉴权体系已启用：可用用户 ${activeCount}，可用管理员 ${adminCount}；匿名添加数据已被禁止` };
}

/** 组装检查管道；适配器与 env 由外层注入。scope：诊断隔离参数 */
function buildPipeline(env, scope) {
  const scopeLabel = [
    scope.deviceId && `设备 ${scope.deviceId}`,
    scope.username && `用户 ${scope.username}`,
    scope.deviceType && `类型 ${scope.deviceType}`
  ].filter(Boolean).join(' / ');

  return [
    check(1, '配置完整性', 'system', DOC.env, async () => checkConfig(env)),
    check(2, '数据库连通性', 'database', DOC.db, async (ctx) => {
      await ctx.db.ping();
      return { status: 'pass', detail: `连通正常（${describeBackend(ctx.db)}）` };
    }),
    check(3, 'Schema 一致性', 'database', DOC.schema, async (ctx) => {
      const state = await describeSchemaState(ctx.db, 'surge_logs', REQUIRED_LOG_COLUMNS);
      if (!state.ok) return { status: 'fail', detail: state.detail, fix: '部署后访问 /api/schema 取建表语句，或等待首次访问自动迁移' };
      const devices = await describeSchemaState(ctx.db, 'devices', [...REQUIRED_DEVICE_COLUMNS, 'device_type']);
      if (!devices.ok) return { status: 'fail', detail: devices.detail, fix: '首次访问任意 /api 接口会自动迁移；也可访问 /api/schema 取建表语句手工执行' };
      const label = ctx.db.backend === 'turso' ? 'Turso' : ctx.db.backend === 'd1' ? 'D1' : 'SQLite';
      return { status: 'pass', detail: `${state.detail}；devices 注册表齐全；DB_SCHEMA_VERSION = ${DB_SCHEMA_VERSION}（${label}）` };
    }),
    check(4, '读权限', 'database', DOC.read, async (ctx) => {
      await ctx.db.execute('SELECT id FROM surge_logs LIMIT 1');
      return { status: 'pass', detail: 'surge_logs 读取正常' };
    }),
    check(5, '写探针（写入临时行）', 'database', DOC.probe, async (ctx) => {
      ctx.probe = await runProbe(ctx.db);
      if (!ctx.probe.writeOk) return { status: 'fail', detail: '探针行未写入（权限 / 配额 / 锁冲突）', fix: '检查数据库账号的写权限与配额' };
      return { status: 'pass', detail: 'health_probe 写入成功（同一事务，稍后删除）' };
    }),
    check(6, '读回校验', 'database', DOC.probe, async (ctx) => {
      if (!ctx.probe) return { status: 'skip', detail: '写探针未执行' };
      if (!ctx.probe.readOk) return { status: 'fail', detail: '读回内容与写入不一致，写入不可靠', fix: '检查数据库复制 / 事务配置' };
      return { status: 'pass', detail: '探针行读回一致' };
    }),
    check(7, '删除权限', 'database', DOC.probe, async (ctx) => {
      if (!ctx.probe) return { status: 'skip', detail: '写探针未执行' };
      if (!ctx.probe.deleteOk) return { status: 'fail', detail: '探针行删除失败：账号无写权限或只读', fix: '改用具备写权限的数据库令牌' };
      return { status: 'pass', detail: '探针行已删除，无残留数据' };
    }),
    check(8, '写令牌校验', 'system', DOC.token, async (ctx) => {
      const configured = configuredWriteToken(ctx.env);
      if (!configured) return { status: 'warn', detail: 'PANEL_WRITE_TOKEN 未配置，写接口回落到多用户鉴权（未启用时开放）' };
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
    check(9, '上报令牌校验', 'system', DOC.hitToken, async (ctx) => {
      const tokens = anyConfiguredToken(ctx.env);
      if (!tokens.length) return { status: 'fail', detail: 'PANEL_HIT_TOKEN 未配置：上报接口一律拒绝', fix: '在 Cloudflare 环境变量配置 PANEL_HIT_TOKEN' };
      if (ctx.mode !== 'deep') return { status: 'pass', detail: 'PANEL_HIT_TOKEN 在位（深度检测将模拟一次带令牌的校验）' };
      const supplied = extractUrlOrHeaderToken(ctx.context);
      const denied = requireHitToken(ctx.env, supplied);
      if (denied) return { status: 'fail', detail: '请求携带的上报令牌不匹配', fix: '与 Surge 模块参数 FINAL_DB_TOKEN 核对' };
      return { status: 'pass', detail: '上报令牌匹配（模拟合法探测上报通过）' };
    }),
    check(10, '客户端连通状态', 'client', DOC.client, async (ctx) => {
      // 检测项按需隔离：scope 限定到单台设备 / 用户 / 设备类型（客户端连通也按用户独立检测）
      const devices = await listDevices(ctx.db, {
        limit: 100,
        deviceType: scope.deviceType,
        username: scope.username
      });
      const scoped = scope.deviceId ? devices.filter((device) => device.deviceId === scope.deviceId || device.deviceId === `client:${scope.deviceId}`) : devices;

      const beats = await listHeartbeats(ctx.db, { limit: 5 });
      if (!scoped.length && !beats.length) {
        return {
          status: 'warn',
          detail: `尚未收到任何 Surge 客户端触达${scopeLabel ? `（范围：${scopeLabel}）` : ''}：安装 FINAL 模块并配置参数，面板刷新一次即上报`,
          fix: '按 readme「Surge 安装教程」安装模块并填写 FINAL_WEB_URL / FINAL_DB_TOKEN',
          clients: []
        };
      }

      const reference = scoped.length ? scoped : (await listDevices(ctx.db, { limit: 100 }));
      const latestDevice = reference[0];
      const latestBeat = beats[0];
      const online = latestDevice ? latestDevice.online : isHeartbeatOnline(latestBeat?.lastSeen);

      const scopeSuffix = scopeLabel ? `（范围：${scopeLabel}）` : '';
      if (!online) {
        return {
          status: 'warn',
          detail: `最近触达 ${latestDevice?.lastOnlineTime || latestBeat?.lastSeen || ''}（离线，超过两个刷新周期）${scopeSuffix}`,
          fix: '打开 Surge 面板刷新一次即可恢复心跳',
          clients: beats
        };
      }
      // 版本落后属于 check 11（版本与更新监控）的职责，这里只汇总展示不影响连通性判定
      const outdatedDevices = reference.filter((device) => device.configStatus === DEVICE_CONFIG_STATUS.OUTDATED);
      const failedDevices = reference.filter((device) => device.configStatus === DEVICE_CONFIG_STATUS.FAILED && DEVICE_PROFILES[device.deviceType]?.versionDetection !== false);
      const bits = [];
      if (outdatedDevices.length) bits.push(`${outdatedDevices.length} 台配置过期`);
      if (failedDevices.length) bits.push(`${failedDevices.length} 台未上报版本`);
      return {
        status: 'pass',
        detail:
          `最近触达 ${latestDevice?.lastOnlineTime || latestBeat?.lastSeen || ''}（在线），` +
          `面板脚本 ${latestDevice?.panelVersion || latestBeat?.panelVersion || '未知'} / 捕获脚本 ${latestDevice?.loggerVersion || latestBeat?.loggerVersion || '未知'}` +
          `；设备 ${reference.filter((d) => d.online).length}/${reference.length} 在线${scopeSuffix}` +
          (bits.length ? `；${bits.join('，')}（详见版本与更新监控）` : ''),
        fix: '',
        clients: beats
      };
    }),
    check(11, '版本与更新监控', 'version', DOC.version, async (ctx) => {
      // 实时追踪四类产物：网页面板（自身构建清单）、Surge 面板脚本、捕获脚本本地副本、
      // Surge 模块；分发通道 = Surge 三件套自托管源（Pages 域名或自定义域名）。
      const beats = await listHeartbeats(ctx.db, { limit: 50 });
      const devices = await listDevices(ctx.db, { limit: 100, deviceType: scope.deviceType, username: scope.username });
      const scoped = scope.deviceId ? devices.filter((device) => device.deviceId === scope.deviceId || device.deviceId === `client:${scope.deviceId}`) : devices;

      const components = [
        { key: 'panel', name: 'Surge 面板脚本', server: COMPONENT_VERSIONS.panel },
        { key: 'logger', name: '捕获脚本（本地副本）', server: COMPONENT_VERSIONS.logger },
        { key: 'sgmodule', name: 'Surge 模块', server: COMPONENT_VERSIONS.sgmodule }
      ];
      const behind = [];
      for (const component of components) {
        const expected = component.server;
        if (!expected) continue;
        const outdated = [];
        for (const device of scoped) {
          const reported = component.key === 'logger' ? (device.loggerVersion || '') : (device.panelVersion || device.loggerVersion || '');
          if (reported && compareSemver(reported, expected) === -1) {
            outdated.push(`${device.name || device.ip || device.deviceId}（${reported}）`);
          }
        }
        for (const beat of beats) {
          const reported = component.key === 'logger' ? beat.loggerVersion : beat.panelVersion;
          if (reported && compareSemver(reported, expected) === -1) {
            outdated.push(`心跳 ${beat.clientId}（${reported}）`);
          }
        }
        if (outdated.length) {
          behind.push({ component: component.name, expected, outdated: [...new Set(outdated)].slice(0, 5) });
        }
      }

      const distribution = {
        channel: PANEL_ORIGIN ? 'pages' : 'self-host',
        origin: PANEL_ORIGIN,
        note: 'Surge 三件套经 Pages 自托管分发（script-path 指向该源），模块更新即整体失效'
      };
      if (behind.length) {
        const text = behind.map((item) => `${item.component} 落后（服务端 ${item.expected}）：${item.outdated.join('、')}`).join('；');
        return {
          status: 'warn',
          detail: `发现版本落后：${text}`,
          fix: '更新 Surge 模块（外链重新安装）并在脚本编辑器重新另存捕获脚本本地副本',
          components: components.map((item) => ({ ...item, current: item.server })),
          distribution
        };
      }
      return {
        status: 'pass',
        detail: `网页面板 ${BUILD_LABEL}；Surge 面板 / 捕获脚本 / 模块均为最新（服务端 ${COMPONENT_VERSIONS.panel}）；分发通道 ${distribution.origin || '同源部署'}`,
        components: components.map((item) => ({ ...item, current: item.server })),
        distribution
      };
    })
  ];
}

const DEEP_ONLY_IDS = [5, 6, 7];
const DB_DEPENDENT_IDS = [2, 3, 4, 5, 6, 7, 10, 11];

async function runPipeline(env, request, context, mode, scope) {
  const started = now();
  const results = [];
  const shared = { env, request, context, mode, probe: null, scope };

  for (const item of buildPipeline(env, scope)) {
    const isDeepOnly = DEEP_ONLY_IDS.includes(item.id);
    if (isDeepOnly && mode !== 'deep') {
      results.push({ id: item.id, name: item.name, category: item.category, status: 'skip', ms: 0, detail: '深度检测项（只读模式跳过）', fix: '', doc: item.doc });
      continue;
    }
    const t0 = now();
    try {
      // 数据库类检查依赖适配器：前面的检查失败时管道继续但这里懒初始化
      if (DB_DEPENDENT_IDS.includes(item.id) && !shared.db) {
        shared.db = await getAdapter(env);
      }
      const outcome = (await item.fn(shared)) || {};
      results.push({ id: item.id, name: item.name, category: item.category, status: outcome.status || 'pass', ms: now() - t0, detail: outcome.detail || '', fix: outcome.fix || '', doc: item.doc, ...(outcome.clients ? { clients: outcome.clients } : {}), ...(outcome.components ? { components: outcome.components } : {}), ...(outcome.distribution ? { distribution: outcome.distribution } : {}) });
    } catch (error) {
      const kind = error instanceof ConfigError ? null : DB_ERROR_LABELS[error?.kind] ? error.kind : 'unknown';
      results.push({
        id: item.id,
        name: item.name,
        category: item.category,
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

/** 分类视图：按 category 分组并给出组内汇总（前端按分类渲染检测卡片） */
function categorize(results) {
  return CHECK_CATEGORIES.map((category) => {
    const items = results.filter((item) => item.category === category.id);
    const counts = { pass: 0, warn: 0, fail: 0, skip: 0 };
    for (const item of items) counts[item.status] = (counts[item.status] ?? 0) + 1;
    const overall = counts.fail ? 'fail' : counts.warn ? 'warn' : counts.skip === items.length ? 'skip' : 'pass';
    return { ...category, overall, counts, checks: items.map((item) => item.id) };
  });
}

/**
 * 全链路自证：浏览器 → Pages → 数据库 → Surge 客户端。
 * browser：请求抵达（必然）；pages：Functions 管道执行完成（必然）；
 * database：数据库类检查（2-7）无失败；surge：客户端连通状态（10）非 fail。
 */
function chainSummary(results) {
  const byId = Object.fromEntries(results.map((item) => [item.id, item]));
  const dbChecks = results.filter((item) => item.category === 'database');
  const clientCheck = byId['10'];
  return {
    browser: 'pass',
    pages: 'pass',
    database: dbChecks.some((item) => item.status === 'fail') ? 'fail' : dbChecks.some((item) => item.status === 'warn') ? 'warn' : 'pass',
    surge: !clientCheck || clientCheck.status === 'skip' ? 'warn' : clientCheck.status
  };
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
    // 检测项按需隔离：设备 / 用户 / 设备类型三个维度独立检测对应项目
    const scope = {
      deviceId: (url.searchParams.get('device-id') || '').trim(),
      username: (url.searchParams.get('username') || '').trim(),
      deviceType: (url.searchParams.get('device-type') || '').trim()
    };

    if (mode === 'deep') {
      // 写副作用必须二次确认：前端弹窗确认后附带 confirm=1，直接调用一律 400 提示
      if (url.searchParams.get('confirm') !== '1') {
        return badRequest('深度检测涉及写操作（向探针表写入临时行）：请在前端弹窗二次确认后重试（请求需附带 confirm=1）');
      }
      // 节流：按来源 IP 每分钟至多一次（isolate 内尽力而为）
      const ip = request.headers.get('cf-connecting-ip') || 'local';
      const last = deepThrottle.get(ip) ?? 0;
      if (Date.now() - last < DEEP_THROTTLE_MS) {
        return jsonResponse(
          { success: false, error: '深度检测过于频繁，请一分钟后再试' },
          { status: 429, headers: { 'Cache-Control': 'no-store' } }
        );
      }
      // 鉴权体系启用后深度检测接受会话或写令牌；未启用回落写令牌校验
      const adapter = await getAdapter(env);
      const auth = await requireMutationAuth(env, adapter, request, context);
      if (!auth.ok) return auth.response;
      deepThrottle.set(ip, Date.now());
    }

    const { results, elapsedMs } = await runPipeline(env, request, context, mode, scope);
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
          scope,
          checks: results,
          categories: categorize(results),
          chain: chainSummary(results),
          summary
        }
      },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (error) {
    return errorResponse(TAG, request.method, url.pathname, error);
  }
}

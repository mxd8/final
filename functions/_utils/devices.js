/**
 * 来源设备（devices）数据访问层：设备注册、在线判定、配置状态与告警分级。
 *
 * 设备在两条路径上登记（同一次触达同时刷新 last_online_time）：
 *   - Surge 面板脚本心跳：/stats 捎带 X-Final-Client / X-Final-Device / X-Final-User 等头；
 *   - 捕获脚本批量上报：/hits 携带同一组头与 username 字段。
 *
 * 设备标识 device_id：优先用面板写入持久化的 clientId（跨网络稳定，捕获脚本从
 * 同一持久化键读到），旧客户端没有时回落「用户名|设备名|来源 IP」三元组。
 * 来源 IP 由中转后端从请求连接（CF-Connecting-IP）捕获解析——Surge 端无法
 * 可靠得知自己的公网出口 IP，设备型号相同的设备靠它区分。
 *
 * 在线判定：请求时间戳超时机制——last_online_time 距今超过离线窗口即离线。
 * 窗口 = max(5 分钟, 2 × 设备上报的刷新间隔)：面板默认 600 秒刷新一次，
 * 只按 5 分钟判会把正常设备误判离线，因此以设备自己的刷新节奏兜底。
 *
 * 告警分级（实时统计面板按颜色区分）：
 *   - failed（红，校验失败）：设备从未上报任何组件版本，无法确认配置是否最新；
 *   - outdated（黄，配置过期）：已上报版本落后于服务端部署版本；
 *   - offline（灰，离线）：超过离线窗口无任何请求。
 */

import { DEVICES_TABLE, DEVICES_SCHEMA } from './db/ddl.js';
import { normalizeSource, normalizeIp, normalizeUsername } from './logs/normalize.js';
import { COMPONENT_VERSIONS } from './build-meta.js';
import {
  DEVICE_PROFILES, DEVICE_TYPE, versionInputsFor, serializePlatformParams, parsePlatformParams,
  normalizeDeviceType
} from './device-profiles.js';

const MAX_DEVICE_ID_LENGTH = 96;
const MAX_VERSION_LENGTH = 32;

/** 离线窗口下限：需求基线「超过 5 分钟无请求判定离线」 */
export const DEVICE_OFFLINE_FLOOR_MS = 5 * 60 * 1000;
/** 未上报刷新间隔时的默认窗口：与面板心跳的离线判定保持一致（约两个刷新周期） */
export const DEVICE_OFFLINE_DEFAULT_MS = 20 * 60 * 1000;

/** 设备可能出现的配置状态（config_status 列取值） */
export const DEVICE_CONFIG_STATUS = { LATEST: 'latest', OUTDATED: 'outdated', FAILED: 'failed' };

/** 解析 '1.2.3 (abc1234)' 形态的语义化版本主体，与前端 version-check.js 同规则 */
function parseSemver(value) {
  const match = String(value ?? '').trim().match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

/** 语义化版本比较：a < b → -1；不可解析返回 null */
export function compareSemver(a, b) {
  const left = parseSemver(a);
  const right = parseSemver(b);
  if (!left || !right) return null;
  if (left.major !== right.major) return left.major < right.major ? -1 : 1;
  if (left.minor !== right.minor) return left.minor < right.minor ? -1 : 1;
  if (left.patch !== right.patch) return left.patch < right.patch ? -1 : 1;
  return 0;
}

/**
 * 由已知的最新自报版本计算配置状态：
 *   两个组件版本都未知 → failed（无法校验）；
 *   任一已知版本落后服务端 → outdated；全部一致 → latest。
 */
export function configStatusFromVersions(panelVersion, loggerVersion, components = COMPONENT_VERSIONS) {
  const statuses = [];
  for (const [reported, expected] of [
    [panelVersion, components.panel],
    [loggerVersion, components.logger]
  ]) {
    if (!reported) continue;
    const order = compareSemver(reported, expected || '');
    statuses.push(order === null || order < 0 ? DEVICE_CONFIG_STATUS.OUTDATED : DEVICE_CONFIG_STATUS.LATEST);
  }
  if (!statuses.length) return DEVICE_CONFIG_STATUS.FAILED;
  // 一个组件过期即整体视为过期：配置更新必须三件套一起跟上的语义
  if (statuses.includes(DEVICE_CONFIG_STATUS.OUTDATED)) return DEVICE_CONFIG_STATUS.OUTDATED;
  return DEVICE_CONFIG_STATUS.LATEST;
}

/** 来源 IP 捕获：Cloudflare 连接头优先，自托管回落 X-Forwarded-For 首段 */
export function clientIp(request) {
  const cf = String(request.headers.get('cf-connecting-ip') ?? '').trim();
  if (cf) return normalizeIp(cf);
  const forwarded = String(request.headers.get('x-forwarded-for') ?? '').trim();
  return normalizeIp(forwarded.split(',')[0] || '');
}

const cleanHeader = (request, name) => String(request.headers.get(name) ?? '').trim().slice(0, MAX_VERSION_LENGTH);

/**
 * 从上报请求提取设备身份与版本自报（/stats 心跳与 /hits 批量上报共用）：
 *   x-final-client   客户端标识（面板生成并下发，捕获脚本读同一持久化键）
 *   x-final-device   设备型号（$environment device-model）
 *   x-final-user     用户组 / 用户名（模块参数 FINAL_USER）
 *   x-final-version  面板脚本版本（仅面板心跳携带）
 *   x-final-logger   捕获脚本版本（两条路径都携带）
 *   x-final-refresh  面板刷新间隔秒数（仅面板心跳携带，参与离线窗口计算）
 *   x-final-platform 设备类型 key（v4：surge-ios / surge-mac / surge-ipad / …）
 *   x-final-system   系统版本（v4 平台专属参数，如 iOS 17.4）
 *   x-final-surge-version  Surge App 版本（A/B/C 设备专属）
 *   x-final-plugin-version 插件版本（D 路由器插件专属，映射 logger 参与检测）
 */
export function parseDeviceHeaders(request) {
  const cleanParam = (name) => String(request.headers.get(name) ?? '').trim().slice(0, MAX_VERSION_LENGTH);
  return {
    clientId: cleanHeader(request, 'x-final-client').slice(0, MAX_DEVICE_ID_LENGTH),
    name: normalizeSource(request.headers.get('x-final-device')),
    username: normalizeUsername(request.headers.get('x-final-user')),
    panelVersion: cleanHeader(request, 'x-final-version'),
    loggerVersion: cleanHeader(request, 'x-final-logger'),
    refreshSeconds: Math.max(0, Math.floor(Number(request.headers.get('x-final-refresh')) || 0)),
    deviceType: cleanParam('x-final-platform'),
    systemVersion: cleanParam('x-final-system'),
    surgeVersion: cleanParam('x-final-surge-version'),
    pluginVersion: cleanParam('x-final-plugin-version')
  };
}

/** 设备标识：clientId 优先（跨网络稳定），否则按 用户名|设备名|IP 三元组区分 */
export function buildDeviceId({ clientId = '', name = '', username = '', ip = '' } = {}) {
  if (clientId) return `client:${clientId}`.slice(0, MAX_DEVICE_ID_LENGTH);
  const triple = [normalizeUsername(username), normalizeSource(name), normalizeIp(ip)]
    .map((part) => part || '*')
    .join('|');
  return `dev:${triple}`.slice(0, MAX_DEVICE_ID_LENGTH);
}

/** 计算某台设备的离线窗口：max(5 分钟, 2 × 上报刷新间隔)，未上报用默认 20 分钟 */
export function offlineWindowMs(refreshSeconds) {
  const reported = Math.floor(Number(refreshSeconds) || 0);
  if (reported <= 0) return DEVICE_OFFLINE_DEFAULT_MS;
  return Math.max(DEVICE_OFFLINE_FLOOR_MS, reported * 2 * 1000);
}

/** 在线判定：最后上线时间距今未超过该设备的离线窗口 */
export function isDeviceOnline(lastOnlineIso, refreshSeconds = 0, nowMs = Date.now()) {
  const stamp = Date.parse(String(lastOnlineIso ?? ''));
  if (!Number.isFinite(stamp)) return false;
  return nowMs - stamp < offlineWindowMs(refreshSeconds);
}

/**
 * 设备触达：upsert 注册表并刷新最后上线时间。
 * 版本自报取「本次非空值，否则保留旧值」——面板与捕获脚本分别上报各自的版本，
 * 单次触达只带其中一半，合并后才能算出完整的 config_status。
 * v4：device_type / platform_params 随触达更新（设备五类型多维适配）；
 *     版本检测按 profile 执行——E（纯 API）不做检测，直接标记 latest（不产生告警）。
 * 失败由调用方吞掉：设备登记绝不能拖垮数据主链路。
 */
export async function touchDevice(db, {
  clientId = '', name = '', username = '', ip = '', panelVersion = '', loggerVersion = '',
  refreshSeconds = 0, deviceType = '', platformParams = null
} = {}) {
  const deviceId = buildDeviceId({ clientId, name, username, ip });
  if (!deviceId || deviceId === 'dev:*|*|*') return null;

  const now = new Date().toISOString();
  const cleanVersion = (value) => String(value ?? '').trim().slice(0, MAX_VERSION_LENGTH);
  const incomingPanel = cleanVersion(panelVersion);
  const incomingLogger = cleanVersion(loggerVersion);
  const deviceName = normalizeSource(name);
  const deviceUsername = normalizeUsername(username);
  const deviceIp = normalizeIp(ip);
  const refresh = Math.max(0, Math.floor(Number(refreshSeconds) || 0));
  const type = normalizeDeviceType(deviceType);

  // 先读旧版本自报再合并：单次触达只携带一个组件的版本，需要拼出完整视图
  let previous = { panel_version: '', logger_version: '', device_type: '', platform_params: '' };
  try {
    const [row] = await db.execute(
      `SELECT panel_version, logger_version, device_type, platform_params FROM ${DEVICES_TABLE} WHERE device_id = ?`,
      [deviceId]
    );
    if (row) {
      previous = {
        panel_version: String(row.panel_version ?? ''),
        logger_version: String(row.logger_version ?? ''),
        device_type: String(row.device_type ?? ''),
        platform_params: String(row.platform_params ?? '')
      };
    }
  } catch {
    // 表尚未迁移好时按空处理：upsert 会自建行，下次触达自然补全
  }

  const mergedPanel = incomingPanel || previous.panel_version;
  const mergedLogger = incomingLogger || previous.logger_version;
  const mergedType = type || previous.device_type;
  const mergedParams = { ...parsePlatformParams(previous.platform_params), ...(platformParams ?? {}) };
  // D（路由器插件）没有面板/捕获脚本版本：插件版本（平台参数）视作上报组件版本参与检测与展示
  const effectiveLogger = mergedLogger
    || (mergedType === DEVICE_TYPE.ROUTER_PLUGIN ? String(mergedParams.pluginVersion ?? '') : '');
  const inputs = versionInputsFor(mergedType, {
    panelVersion: mergedPanel, loggerVersion: effectiveLogger, platformParams: mergedParams
  });
  const status = inputs
    ? configStatusFromVersions(inputs.panelVersion, inputs.loggerVersion)
    : DEVICE_CONFIG_STATUS.LATEST; // E（纯 API）：无版本检测语义，不产生「校验失败」告警

  await db.batch([
    {
      sql: `INSERT INTO ${DEVICES_TABLE} (device_id, name, username, ip, panel_version, logger_version, config_status, refresh_seconds, last_online_time, first_seen, updated_at, device_type, platform_params)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(device_id) DO UPDATE SET
              name = CASE WHEN excluded.name != '' THEN excluded.name ELSE ${DEVICES_TABLE}.name END,
              username = CASE WHEN excluded.username != '' THEN excluded.username ELSE ${DEVICES_TABLE}.username END,
              ip = CASE WHEN excluded.ip != '' THEN excluded.ip ELSE ${DEVICES_TABLE}.ip END,
              panel_version = excluded.panel_version,
              logger_version = excluded.logger_version,
              config_status = excluded.config_status,
              refresh_seconds = CASE WHEN excluded.refresh_seconds > 0 THEN excluded.refresh_seconds ELSE ${DEVICES_TABLE}.refresh_seconds END,
              last_online_time = excluded.last_online_time,
              updated_at = excluded.updated_at,
              device_type = excluded.device_type,
              platform_params = excluded.platform_params`,
      params: [
        deviceId, deviceName, deviceUsername, deviceIp, mergedPanel, effectiveLogger, status,
        refresh, now, now, now, mergedType, serializePlatformParams(mergedParams)
      ]
    }
  ]);

  return { deviceId, configStatus: status };
}

/** 数据库行 → 前端结构（附在线判定、离线窗口与设备类型信息） */
function normalizeDeviceRow(row, nowMs) {
  const name = String(row.name ?? '');
  const username = String(row.username ?? '');
  const ip = String(row.ip ?? '');
  const refreshSeconds = Math.max(0, Math.floor(Number(row.refresh_seconds) || 0));
  const lastOnlineTime = String(row.last_online_time ?? '');
  const deviceType = String(row.device_type ?? '');
  const profile = DEVICE_PROFILES[deviceType] ?? null;
  return {
    deviceId: String(row.device_id ?? ''),
    name,
    username,
    ip,
    panelVersion: String(row.panel_version ?? ''),
    loggerVersion: String(row.logger_version ?? ''),
    configStatus: String(row.config_status ?? DEVICE_CONFIG_STATUS.FAILED),
    refreshSeconds,
    lastOnlineTime,
    firstSeen: String(row.first_seen ?? ''),
    updatedAt: String(row.updated_at ?? ''),
    online: isDeviceOnline(lastOnlineTime, refreshSeconds, nowMs),
    offlineAfterMs: offlineWindowMs(refreshSeconds),
    deviceType,
    typeCode: profile?.code ?? '',
    typeLabel: profile?.label ?? (deviceType ? deviceType : '未标注'),
    versionDetection: profile?.versionDetection ?? true,
    platformParams: parsePlatformParams(row.platform_params)
  };
}

/** 设备清单（最近上线在前）：设备数远小于规则数，limit 100 足够面板展示 */
export async function listDevices(db, { limit = 100, deviceType = '', username = '' } = {}) {
  const nowMs = Date.now();
  const filters = [];
  const params = [];
  if (deviceType) {
    filters.push('device_type = ?');
    params.push(normalizeDeviceType(deviceType));
  }
  if (username) {
    filters.push('username = ?');
    params.push(normalizeUsername(username));
  }
  const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
  params.push(Math.max(1, Math.min(Number(limit) || 100, 500)));
  const rows = await db.execute(
    `SELECT device_id, name, username, ip, panel_version, logger_version, config_status, refresh_seconds, last_online_time, first_seen, updated_at, device_type, platform_params
     FROM ${DEVICES_TABLE} ${where} ORDER BY last_online_time DESC LIMIT ?`,
    params
  );
  return rows.map((row) => normalizeDeviceRow(row, nowMs));
}

/** 单台设备的告警项（离线 / 配置过期 / 校验失败），无告警返回 null。
 *  版本类告警按 profile 隔离：E（纯 API）不参与版本检测，failed 不告警；
 *  D（路由器插件）无面板预期，panel 缺失不触发 failed。 */
function deviceAlert(device) {
  const profile = DEVICE_PROFILES[device.deviceType] ?? null;
  if (!device.online) {
    return {
      deviceId: device.deviceId,
      name: device.name || device.ip || device.deviceId,
      username: device.username,
      type: 'offline',
      level: 'secondary',
      message: '设备离线'
    };
  }
  if (device.configStatus === DEVICE_CONFIG_STATUS.OUTDATED && profile?.versionDetection !== false) {
    return {
      deviceId: device.deviceId,
      name: device.name || device.ip || device.deviceId,
      username: device.username,
      type: 'outdated',
      level: 'warning',
      message: '配置过期：组件版本落后于服务端，请更新模块并重新另存捕获脚本'
    };
  }
  if (
    device.configStatus === DEVICE_CONFIG_STATUS.FAILED &&
    profile?.versionDetection !== false
  ) {
    return {
      deviceId: device.deviceId,
      name: device.name || device.ip || device.deviceId,
      username: device.username,
      type: 'failed',
      level: 'danger',
      message: '配置校验失败：设备未上报组件版本，无法确认配置是否最新'
    };
  }
  return null;
}

/**
 * 设备汇总：在线统计（n/m）与告警清单。
 * 告警按严重程度排序：校验失败（红）→ 配置过期（黄）→ 离线（灰）。
 */
export function deviceSummary(devices) {
  const alerts = [];
  for (const device of devices) {
    const alert = deviceAlert(device);
    if (alert) alerts.push(alert);
  }
  const levelOrder = { danger: 0, warning: 1, secondary: 2 };
  alerts.sort((a, b) => (levelOrder[a.level] ?? 3) - (levelOrder[b.level] ?? 3));
  return {
    total: devices.length,
    online: devices.filter((device) => device.online).length,
    alertCount: alerts.length,
    alerts
  };
}

/**
 * 设备清单 + 汇总一次取齐：/stats 响应的 devices / deviceSummary 字段来源。
 * 支持按设备类型 / 用户名隔离（诊断检测项按需隔离的数据面）。
 * 任何失败都回落空清单——设备视图缺席不影响统计主数据。
 */
export async function getDevicesReport(db, { limit = 100, deviceType = '', username = '' } = {}) {
  const devices = await listDevices(db, { limit, deviceType, username });
  return { devices, deviceSummary: deviceSummary(devices) };
}

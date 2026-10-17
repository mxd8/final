/**
 * 来源设备五类型 profile（v4 多维适配核心）：
 *
 *   A  surge-ios      Surge iOS   面板交互 + 版本检测（panel/logger 双组件）
 *   B  surge-mac      Surge Mac   面板交互 + 版本检测
 *   C  surge-ipad     Surge iPad  面板交互 + 版本检测
 *   D  router-plugin  路由器插件  无面板交互：底层请求参数适配上报（只跟踪上报脚本版本）
 *   E  api-client     纯 API      一次性 CRUD 提交单条记录，不涉及版本检测
 *
 * 平台解析优先级：请求体 deviceType → X-Final-Platform 头 → 设备型号推断
 * （iPhone/iPad/Mac）→ 路由器 UA 特征 → 无任何设备头时 api-client。
 * 各类型的专属参数（systemVersion / surgeVersion / pluginVersion 等）由
 * collectPlatformParams 统一收集，服务端按 profile 决定版本检测项并快照入库。
 */

import { normalizeSource, normalizeUsername } from './logs/normalize.js';

export const DEVICE_TYPE = {
  SURGE_IOS: 'surge-ios',
  SURGE_MAC: 'surge-mac',
  SURGE_IPAD: 'surge-ipad',
  ROUTER_PLUGIN: 'router-plugin',
  API_CLIENT: 'api-client'
};

const MAX_PARAM_LENGTH = 64;

/**
 * 设备 profile 注册表：
 *   code          需求文档的设备编号（A–E）
 *   label         前端展示名
 *   versionDetection 是否参与「配置过期 / 校验失败」版本检测
 *   panelExpected 是否预期存在面板组件（面板缺失告警用）
 *   tracked       该类型跟踪的版本组件清单（版本与更新监控按此出报告）
 */
export const DEVICE_PROFILES = {
  [DEVICE_TYPE.SURGE_IOS]: {
    code: 'A',
    label: 'Surge iOS',
    versionDetection: true,
    panelExpected: true,
    tracked: ['panel', 'logger']
  },
  [DEVICE_TYPE.SURGE_MAC]: {
    code: 'B',
    label: 'Surge Mac',
    versionDetection: true,
    panelExpected: true,
    tracked: ['panel', 'logger']
  },
  [DEVICE_TYPE.SURGE_IPAD]: {
    code: 'C',
    label: 'Surge iPad',
    versionDetection: true,
    panelExpected: true,
    tracked: ['panel', 'logger']
  },
  [DEVICE_TYPE.ROUTER_PLUGIN]: {
    code: 'D',
    label: '路由器插件',
    versionDetection: true,
    panelExpected: false,
    tracked: ['logger']
  },
  [DEVICE_TYPE.API_CLIENT]: {
    code: 'E',
    label: '纯 API',
    versionDetection: false,
    panelExpected: false,
    tracked: []
  }
};

/** 类型 → 简称（前端徽标与列表展示） */
export const DEVICE_TYPE_LABELS = Object.fromEntries(
  Object.entries(DEVICE_PROFILES).map(([type, profile]) => [type, `${profile.code}·${profile.label}`])
);

const cleanParam = (value) => String(value ?? '').trim().slice(0, MAX_PARAM_LENGTH);

/** 从设备型号字符串推断平台：iPhone/iPad 优先，其次 Mac，路由器特征兜底 */
function inferFromDeviceName(deviceName) {
  const name = String(deviceName ?? '').toLowerCase();
  if (!name) return '';
  if (name.includes('ipad')) return DEVICE_TYPE.SURGE_IPAD;
  if (name.includes('iphone')) return DEVICE_TYPE.SURGE_IOS;
  if (name.includes('mac') || name.includes('macbook') || name.includes('imac')) return DEVICE_TYPE.SURGE_MAC;
  return '';
}

/** 从 User-Agent 推断路由器插件等非 Surge 面板来源 */
function inferFromUserAgent(userAgent) {
  const ua = String(userAgent ?? '').toLowerCase();
  if (!ua) return '';
  if (/openwrt|padavan|merlin|asuswrt|miwifi|router|curl\/|python-requests|okhttp/.test(ua)) {
    return DEVICE_TYPE.ROUTER_PLUGIN;
  }
  return '';
}

/**
 * 解析来源设备类型。@param body 上报请求体（/hit /hits 可带 deviceType 字段）
 * 返回 profile key；完全无设备上下文（连型号与 UA 都没有）→ api-client（设备 E）。
 */
export function resolveDeviceType(request, body = {}) {
  const explicit = cleanParam(body?.deviceType);
  if (explicit && DEVICE_PROFILES[explicit]) return explicit;

  const headerPlatform = cleanParam(request.headers.get('x-final-platform'));
  if (headerPlatform && DEVICE_PROFILES[headerPlatform]) return headerPlatform;

  const byName = inferFromDeviceName(request.headers.get('x-final-device') || body?.source);
  if (byName) return byName;

  const byUa = inferFromUserAgent(request.headers.get('user-agent'));
  if (byUa) return DEVICE_TYPE.ROUTER_PLUGIN;

  const hasDeviceContext =
    request.headers.get('x-final-client') ||
    request.headers.get('x-final-device') ||
    request.headers.get('x-final-user');
  if (hasDeviceContext) return ''; // 有设备上下文但类型未知：旧客户端，留空兼容
  return DEVICE_TYPE.API_CLIENT;
}

/**
 * 收集平台专属参数（请求头 + 请求体合并，body 优先）：
 *   platform       设备类型 key
 *   systemVersion  系统版本（iOS 17.4 / macOS 14.5 …）
 *   surgeVersion   Surge App 版本（A/B/C）
 *   pluginVersion  插件版本（D，映射到 logger_version 参与检测）
 *   model          设备型号
 * 返回对象序列化后存 devices.platform_params，形成可追溯的参数适配快照。
 */
export function collectPlatformParams(request, body = {}, deviceType = '') {
  const header = (name) => cleanParam(request.headers.get(name));
  const fromBody = (key) => cleanParam(body?.[key]);
  const pick = (headerName, bodyKey) => fromBody(bodyKey) || header(headerName);

  const params = {
    platform: deviceType,
    systemVersion: pick('x-final-system', 'systemVersion'),
    surgeVersion: pick('x-final-surge-version', 'surgeVersion'),
    pluginVersion: pick('x-final-plugin-version', 'pluginVersion'),
    model: pick('x-final-device', 'source') || fromBody('model')
  };
  // 只保留非空字段，快照紧凑
  for (const key of Object.keys(params)) {
    if (!params[key]) delete params[key];
  }
  return params;
}

/**
 * 该类型的版本检测输入：把收集到的参数映射成 configStatusFromVersions 的入参。
 *   A/B/C → panel + logger 双组件；
 *   D     → 插件版本视作 logger（上报脚本），无 panel 预期；
 *   E     → 不检测（返回 null，调用方跳过）。
 */
export function versionInputsFor(deviceType, { panelVersion = '', loggerVersion = '', platformParams = {} } = {}) {
  const profile = DEVICE_PROFILES[deviceType];
  if (!profile || !profile.versionDetection) return null;
  if (deviceType === DEVICE_TYPE.ROUTER_PLUGIN) {
    return { panelVersion: '', loggerVersion: loggerVersion || platformParams.pluginVersion || '' };
  }
  return { panelVersion, loggerVersion };
}

/** 设备行 → 前端结构里附带的类型信息 */
export function decorateDeviceType(device) {
  const profile = DEVICE_PROFILES[device.deviceType];
  return {
    ...device,
    typeCode: profile?.code ?? '?',
    typeLabel: profile?.label ?? '未知类型'
  };
}

/** 平台参数快照序列化（入库用）：超长截断 + 脏 JSON 防御 */
export function serializePlatformParams(params) {
  try {
    return JSON.stringify(params ?? {}).slice(0, 1024);
  } catch {
    return '';
  }
}

export function parsePlatformParams(raw) {
  try {
    const parsed = JSON.parse(String(raw ?? '{}'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** 设备类型归一：只认注册表里的值，其余留空（旧数据兼容） */
export function normalizeDeviceType(value) {
  const key = String(value ?? '').trim();
  return DEVICE_PROFILES[key] ? key : '';
}

export { normalizeSource, normalizeUsername };

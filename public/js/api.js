/**
 * 面板 API 封装：带超时、统一 JSON 解析，写请求自动附加鉴权头。
 */

import { state, CP_CONFIG } from './config.js';
import { getWriteToken } from './prefs-store.js';
import { renderStats } from './render.js';
import { renderAuthBanner } from './settings.js';
import { renderVersionUi } from './version-check.js';

/**
 * 写请求自动带令牌；读接口保持匿名可订阅。
 * x-panel-tz-offset 携带设备本地时区偏移（偏移值不含敏感信息，GET 也一起发）。
 */

/**
 * 读接口本身带 Cache-Control: public, max-age=30（给订阅/导出发件用），
 * 但面板做完写操作后会立刻回读同一路径，浏览器可能直接把 30 秒内的旧响应塞回来，
 * 表现为「降维/删除后必须手动刷新网页才变」。GET 统一加一次性时间戳击穿缓存。
 */
function withCacheBuster(url) {
    const stamp = Date.now();
    try {
        const parsed = new URL(url, window.location.href);
        parsed.searchParams.set('_cb', String(stamp));
        return parsed.toString();
    } catch {
        return `${url}${url.includes('?') ? '&' : '?'}_cb=${stamp}`;
    }
}

export async function cpRequest(base, endpoint, { method = 'GET', body, timeoutMs } = {}) {
    const controller = new AbortController();
    const effectiveTimeout = Number(timeoutMs) > 0 ? Number(timeoutMs) : CP_CONFIG.timeoutMs;
    const timer = setTimeout(() => controller.abort(), effectiveTimeout);
    const headers = { 'x-panel-tz-offset': String(-new Date().getTimezoneOffset()) };
    if (method !== 'GET') {
        if (body) headers['Content-Type'] = 'application/json';
        const token = getWriteToken();
        if (token) headers.Authorization = `Bearer ${token}`;
    }

    let response;
    try {
        const requestUrl = method === 'GET' ? withCacheBuster(`${base}${endpoint}`) : `${base}${endpoint}`;
        response = await fetch(requestUrl, {
            method,
            headers: Object.keys(headers).length ? headers : undefined,
            body: body ? JSON.stringify(body) : undefined,
            signal: controller.signal
        });
    } catch (error) {
        throw new Error(error.name === 'AbortError' ? '请求超时，请稍后重试' : '网络错误，请检查网络后重试');
    } finally {
        clearTimeout(timer);
    }

    let data;
    try {
        data = await response.json();
    } catch {
        throw new Error(`响应无法解析（HTTP ${response.status}）`);
    }
    if (data && data.success === false) throw new Error(data.error || '服务端返回错误');
    if (!response.ok) throw new Error(`请求失败（HTTP ${response.status}）`);
    return data;
}

/** 拉取规则列表；筛选全部在数据库侧执行，前端只做展示 */
export async function cpLoadLogs() {
    const query = new URLSearchParams({ limit: '5000' });
    const search = state.search.trim();
    if (search) query.set('search', search);
    if (state.policyFilter !== 'ALL') query.set('policy', state.policyFilter);
    if (state.typeFilter !== 'ALL') query.set('type', state.typeFilter);

    const data = await cpRequest(CP_CONFIG.apiBase, `/?${query.toString()}`);
    state.logs = data.data || [];
    return state.logs;
}

/** 拉取全量规则（不带筛选）：填充订阅结果时判断重复匹配值用 */
export async function cpLoadAllLogs() {
    const data = await cpRequest(CP_CONFIG.apiBase, '/?limit=5000');
    state.allLogs = data.data || [];
    state.allLogsStale = false;
    return state.allLogs;
}

/**
 * 全量规则按需加载：Gist 备份、订阅去重这类低频操作才真正需要整份列表，
 * 日常刷新不再每次多拉一遍 5000 行；数据过期（写操作后）或未加载时拉取。
 */
export async function ensureAllLogs() {
    if (!state.allLogsStale && state.allLogs.length) return state.allLogs;
    return cpLoadAllLogs();
}

export async function cpLoadStats() {
    try {
        const data = await cpRequest(CP_CONFIG.apiBase, '/stats');
        state.stats = data.data || null;
        renderStats();
    } catch (error) {
        console.warn('[surge] 统计加载失败', error.message);
    }
}

/** 拉取规则类型 / 参数常量与版本清单；失败时用内置兜底，页面依然可用 */
export async function cpLoadMeta() {
    try {
        const data = await cpRequest(CP_CONFIG.apiBase, '/meta');
        state.meta = data.data || null;
        // 后端据此字段告诉前端「写接口已启用鉴权」，前端弹出令牌录入框
        state.writeAuthRequired = Boolean(state.meta.writeAuthRequired);
        // 版本握手：服务端部署版本是唯一比对基准（meta 已 no-store，绝不被边缘缓存）
        state.serverInfo = state.meta.version || null;
        renderAuthBanner();
        renderVersionUi();
    } catch (error) {
        console.warn('[surge] 常量加载失败，使用内置兜底列表', error.message);
    }
}

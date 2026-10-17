/**
 * 用户偏好存储：跨设备的设置值走 /api/prefs 存数据库；
 * localStorage 只保留「设备标识」与写接口令牌（偏好表按设备标识可被任意读取）。
 * 读取在页面初始化时拉一次，写入按 400ms 合并 upsert，失败重排队等下次提交。
 */

const PrefsConfig = {
    apiBase: '/api/prefs',
    /** 设备标识在 localStorage 里的唯一键（只存标识，不存任何设置值） */
    deviceIdKey: 'surge_device_id',
    timeoutMs: 10000,
    debounceMs: 400
};

/** 偏好键名集中管理，避免各处硬编码字符串拼错 */
export const keys = {
    theme: 'ui.theme',
    navPosition: 'ui.nav_position',
    accent: 'ui.accent',
    rulesPageSize: 'rules.page_size',
    capturePageSize: 'capture.page_size',
    captureSort: 'capture.sort',
    capturePolicyFilter: 'capture.policy_filter',
    captureSearch: 'capture.search',
    capturePrompt: 'capture.prompt',
    captureOnlyEmpty: 'capture.only_empty',
    captureTypeFilter: 'capture.type_filter',
    captureSourceFilter: 'capture.source_filter',
    captureExportSource: 'capture.export_source',
    captureExportWithSource: 'capture.export_with_source',
    captureExportType: 'capture.export_type',
    /** 全局导出筛选（订阅端 /api/export 读取的 user=export 配置） */
    exportMinCount: 'export.min_count',
    /** 全局导出筛选：最近 N 天命中过滤 */
    exportLastDays: 'export.last_days',
    gistToken: 'gist.token',
    gistId: 'gist.id'
};

/** 与捕获面板共用同一个写接口令牌键，两边不会出现「一个填了另一个没填」 */
const SHARED_TOKEN_KEY = 'panel_write_token';

export function getWriteToken() {
    try {
        return localStorage.getItem(SHARED_TOKEN_KEY) || '';
    } catch {
        return '';
    }
}

export function saveWriteToken(token) {
    try {
        localStorage.setItem(SHARED_TOKEN_KEY, token);
        return true;
    } catch {
        return false;
    }
}

/** 生成并缓存设备标识：随机数，不含任何个人信息 */
export function getDeviceId() {
    let stored = localStorage.getItem(PrefsConfig.deviceIdKey);
    if (stored) return stored;

    const bytes = new Uint8Array(8);
    crypto.getRandomValues(bytes);
    const id = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
    localStorage.setItem(PrefsConfig.deviceIdKey, id);
    return id;
}

/** 带超时的请求封装；写操作自动附加面板令牌 */
async function prefsRequest(url, options = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PrefsConfig.timeoutMs);
    const headers = { ...(options.headers || {}) };
    if (options.body) headers['Content-Type'] = 'application/json';
    const token = getWriteToken();
    if (token) headers.Authorization = `Bearer ${token}`;

    try {
        const response = await fetch(url, { ...options, headers, signal: controller.signal });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || `请求失败（HTTP ${response.status}）`);
        return data;
    } catch (error) {
        throw new Error(error.name === 'AbortError' ? '请求超时' : error.message);
    } finally {
        clearTimeout(timer);
    }
}

let cachedPrefs = {};
const pendingWrites = new Map();
let writeTimer = null;

/** 读取当前设备的全部偏好并写入内存缓存 */
export async function loadPrefs() {
    const device = getDeviceId();
    try {
        const data = await prefsRequest(`${PrefsConfig.apiBase}?user=${encodeURIComponent(device)}`);
        cachedPrefs = data.data || {};
    } catch (error) {
        console.warn('[prefs] 读取偏好失败，使用本地缓存:', error.message);
    }
    return cachedPrefs;
}

export function getPref(key, fallback) {
    return key in cachedPrefs ? cachedPrefs[key] : fallback;
}

/** 读布尔值，兼容 'true' / 'false' 字符串 */
export function getBoolPref(key, fallback = false) {
    const value = getPref(key);
    if (value === 'true') return true;
    if (value === 'false') return false;
    return fallback;
}

export function getNumberPref(key, fallback) {
    const num = Number(getPref(key));
    return Number.isFinite(num) ? num : fallback;
}

/** 写入单个偏好；同一键的连续写入合并成一次请求 */
export function savePref(key, value) {
    pendingWrites.set(key, String(value ?? ''));
    if (writeTimer) clearTimeout(writeTimer);
    writeTimer = setTimeout(() => {
        writeTimer = null;
        flushPrefs();
    }, PrefsConfig.debounceMs);
}

/** 立即提交待写入的值；失败放回队列等下次改动或页面关闭时重试 */
export async function flushPrefs() {
    if (pendingWrites.size === 0) return;
    const device = getDeviceId();
    const settings = Object.fromEntries(pendingWrites);
    pendingWrites.clear();
    if (writeTimer) {
        clearTimeout(writeTimer);
        writeTimer = null;
    }

    try {
        await prefsRequest(PrefsConfig.apiBase, {
            method: 'POST',
            body: JSON.stringify({ user: device, settings })
        });
        Object.assign(cachedPrefs, settings);
    } catch (error) {
        for (const [key, value] of Object.entries(settings)) {
            if (!pendingWrites.has(key)) pendingWrites.set(key, value);
        }
        console.warn('[prefs] 偏好写入失败，稍后重试:', error.message);
    }
}

/** 删除单个偏好（恢复默认） */
export async function removePref(key) {
    const device = getDeviceId();
    try {
        await prefsRequest(`${PrefsConfig.apiBase}?user=${encodeURIComponent(device)}&key=${encodeURIComponent(key)}`, {
            method: 'DELETE'
        });
        delete cachedPrefs[key];
    } catch (error) {
        console.warn('[prefs] 删除偏好失败:', error.message);
    }
}

/**
 * 保存全局导出筛选（user=export）：/api/export 固定订阅地址读取的配置。
 * 与设备无关，不能走设备偏好通道；立即提交（Surge 随时会拉订阅）。
 */
export async function saveExportFilters(settings) {
    try {
        await prefsRequest(PrefsConfig.apiBase, {
            method: 'POST',
            body: JSON.stringify({ user: 'export', settings })
        });
        return true;
    } catch (error) {
        console.warn('[prefs] 导出筛选保存失败:', error.message);
        return false;
    }
}

/** 读取全局导出筛选（读接口匿名可访问，失败返回空对象走默认值） */
export async function loadExportFilters() {
    try {
        const data = await prefsRequest(`${PrefsConfig.apiBase}?user=export`);
        return data.data || {};
    } catch (error) {
        console.warn('[prefs] 导出筛选读取失败:', error.message);
        return {};
    }
}

if (typeof window !== 'undefined') {
    window.addEventListener('pagehide', () => {
        if (pendingWrites.size > 0) flushPrefs();
    });
}

/** 对外统一出口：保留 window 挂载，两个页面的内联调用方式不变 */
export const PrefsStore = {
    config: PrefsConfig,
    keys,
    getDeviceId,
    loadPrefs,
    getPref,
    getBoolPref,
    getNumberPref,
    savePref,
    flushPrefs,
    removePref,
    saveExportFilters,
    getWriteToken,
    saveWriteToken,
    writeTokenKey: SHARED_TOKEN_KEY
};

window.PrefsStore = PrefsStore;

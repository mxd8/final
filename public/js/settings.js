/**
 * 偏好应用与面板设置：主题、主题色、导航位置、写接口令牌、AI 提示词。
 */

import { state, CP_DEFAULTS, CP_DEFAULT_PROMPT, CP_EXPORT_TYPES, CP_ACCENTS, CP_ACCENT_DEFAULT } from './config.js';
import { $ } from './dom.js';
import { cpToast } from './notify.js';
import { getWriteToken, saveWriteToken as storeToken, savePref, keys, getPref, getBoolPref, getNumberPref } from './prefs-store.js';
import { renderExportTypeButtons } from './export.js';
import { refreshCopyCount } from './render.js';
import { applyNavSettings } from './nav.js';

/** 显示 / 隐藏「写接口令牌」录入卡片（后端启用 PANEL_WRITE_TOKEN 时显示） */
export function renderAuthBanner() {
    const card = $('cpAuthCard');
    if (!card) return;
    if (!state.writeAuthRequired) {
        card.hidden = true;
        return;
    }
    card.hidden = false;
    const input = $('cpWriteToken');
    if (input && !input.value) input.value = getWriteToken();
    const header = $('cpAuthTitle');
    if (header) header.textContent = getWriteToken() ? '🔐 写接口令牌（已保存本机）' : '🔐 写接口令牌';
}

/** 保存令牌到本机 localStorage；令牌不进偏好表（偏好表按设备标识可被任意读取） */
export function saveWriteToken() {
    const token = $('cpWriteToken').value.trim();
    if (!token) {
        cpToast('令牌为空，请先填写', 'warning');
        return;
    }
    if (!storeToken(token)) {
        cpToast('令牌保存失败：浏览器本地存储不可用', 'danger');
        return;
    }
    cpToast('令牌已保存到本机浏览器', 'success');
    $('cpWriteToken').value = '';
    renderAuthBanner();
}

function setThemeMode(next) {
    document.documentElement.setAttribute('data-bs-theme', next);
    savePref(keys.theme, next);
}

/** 主题切换：与偏好表里的 ui.theme 保持同步 */
export function toggleTheme() {
    setThemeMode(getPref(keys.theme, 'light') === 'dark' ? 'light' : 'dark');
}

/** 设置页的浅色 / 深色分段按钮 */
export function setTheme(mode) {
    setThemeMode(mode === 'dark' ? 'dark' : 'light');
}

/** 列表相关偏好的合法性校验：数据库残留脏值时回落默认，界面不会崩 */
function applyListPreferences() {
    const rawPageSize = getNumberPref(keys.capturePageSize, CP_DEFAULTS.pageSize);
    state.pageSize = [20, 50, 100].includes(rawPageSize) ? rawPageSize : CP_DEFAULTS.pageSize;
    state.sort = ['time-desc', 'count-desc', 'domain-asc'].includes(getPref(keys.captureSort))
        ? getPref(keys.captureSort)
        : CP_DEFAULTS.sort;
    state.policyFilter = ['ALL', 'PROXY', 'DIRECT', 'REJECT'].includes(getPref(keys.capturePolicyFilter))
        ? getPref(keys.capturePolicyFilter)
        : CP_DEFAULTS.policyFilter;
    state.search = getPref(keys.captureSearch, CP_DEFAULTS.search) || '';
    state.typeFilter = getPref(keys.captureTypeFilter, CP_DEFAULTS.typeFilter) || CP_DEFAULTS.typeFilter;
    state.sourceFilter = getPref(keys.captureSourceFilter, CP_DEFAULTS.sourceFilter) || '';
    state.exportType = CP_EXPORT_TYPES.includes(getPref(keys.captureExportType))
        ? getPref(keys.captureExportType)
        : CP_DEFAULTS.exportType;
    // 规则表表头显隐（JSON 数组，存隐藏列 key）；脏值丢弃回落全部显示
    state.hiddenColumns = parseHiddenColumns(getPref(keys.tableColumns, ''));
}

/** 表头显隐偏好解析：只接受字符串数组，其余回落空集合（全部显示） */
function parseHiddenColumns(raw) {
    try {
        const parsed = JSON.parse(String(raw || '[]'));
        if (!Array.isArray(parsed)) return new Set();
        return new Set(parsed.filter((key) => typeof key === 'string' && key.length > 0));
    } catch {
        return new Set();
    }
}

/** 把偏好写回控件 */
function applyControlValues() {
    $('cpPageSize').value = String(state.pageSize);
    $('cpSort').value = state.sort;
    $('cpPolicyFilter').value = state.policyFilter;
    $('cpSearch').value = state.search;
    $('cpPromptInput').value = getPref(keys.capturePrompt, CP_DEFAULT_PROMPT);
    $('cpOnlyEmptyComment').checked = getBoolPref(keys.captureOnlyEmpty, false);
    $('cpGistToken').value = getPref(keys.gistToken, '');
    $('cpGistId').value = getPref(keys.gistId, '');
    document.documentElement.setAttribute('data-bs-theme', getPref(keys.theme, 'light') || 'light');
    const accent = getPref(keys.accent, CP_ACCENT_DEFAULT);
    applyNavSettings(getPref(keys.navPosition, 'top'), CP_ACCENTS[accent] ? accent : CP_ACCENT_DEFAULT);
    renderExportTypeButtons();
}

/** 应用偏好到界面：先落默认值让页面立即可用，数据库值返回后覆盖 */
export function applyPreferences() {
    applyListPreferences();
    applyControlValues();
}

/** 保存 AI 分流提示词 */
export function savePrompt() {
    savePref(keys.capturePrompt, $('cpPromptInput').value);
    cpToast('提示词已保存', 'success');
}

/** 「仅空备注」开关变化后同步按钮上的数量 */
export function saveOnlyEmptyPref() {
    savePref(keys.captureOnlyEmpty, $('cpOnlyEmptyComment').checked);
    refreshCopyCount();
}

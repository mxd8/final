/**
 * 面板入口：装配 window.capturePanel（供 index.html 内联事件调用）、
 * 绑定全部控件事件（含页面导航与表格整行点击），并在 DOM 就绪后拉取偏好与数据。
 */

import { state, CP_CONFIG } from './config.js';
import { $ } from './dom.js';
import { wireNav, switchPage } from './nav.js';
import { cpSetBusy } from './notify.js';
import { loadPrefs, savePref, keys } from './prefs-store.js';
import { populateTypeFilterSelect, renderLogList, setColumnVisible, renderColumnMenu } from './render.js';
import { renderDevicePanel } from './devices.js';
import { cpLoadLogs } from './api.js';
import { cpRefreshAll, reload } from './refresh.js';
import { cancelEdit, openQuickEdit, saveQuickEdit, quickEditTarget, closeQuickEdit, fillTextareaFromTable, clearBatchText, batchOverride, fillFromSubscription, updateBatchParseInfo } from './edit.js';
import { deleteLog, clearEmpty, wipeDatabase, onWipeInput, confirmWipe, reduceExclude } from './actions.js';
import { openSubscribeModal, parseSubscriptions, reparseSubscription, deleteSubscription, clearSubInput, loadSubscriptions } from './subscribe.js';
import { saveGistConfig, uploadToGist, syncFromGist } from './sync.js';
import { applyPreferences, setTheme, toggleTheme, savePrompt, saveOnlyEmptyPref, saveWriteToken } from './settings.js';
import { aiSaveConnection, aiSaveSchedule, aiLoadModels, aiTestConnection, aiRefreshStatus, aiRunNow, aiResetProcessed, startAiScheduler } from './ai.js';
import { initVersionCheck } from './version-check.js';
import { initHealthView, runHealthChecksBasic, runDeepConfirmed, copyHealthReport } from './health.js';
import { setExportType, setMinCount, applyCustomMinCount, clearMinCount, setLastDays, onExportOptionChange, copyExportLink, copyPageDomains, restoreExportFilters, refreshExportSummary } from './export.js';

function onSearchInput() {
    state.search = $('cpSearch').value;
    savePref(keys.captureSearch, state.search);
    state.currentPage = 1;
    renderLogList();
}

function onTypeFilterChange() {
    state.typeFilter = $('cpTypeFilter').value;
    savePref(keys.captureTypeFilter, state.typeFilter);
    state.currentPage = 1;
    cpLoadLogs().then(() => renderLogList());
}

function onSourceFilterChange() {
    state.sourceFilter = $('cpSourceFilter').value;
    savePref(keys.captureSourceFilter, state.sourceFilter);
    state.currentPage = 1;
    renderLogList();
}

function onSortChange() {
    state.sort = $('cpSort').value;
    savePref(keys.captureSort, state.sort);
    state.currentPage = 1;
    renderLogList();
}

function onPolicyFilterChange() {
    state.policyFilter = $('cpPolicyFilter').value;
    savePref(keys.capturePolicyFilter, state.policyFilter);
    state.currentPage = 1;
    cpLoadLogs().then(() => renderLogList());
}

function onPageSizeChange() {
    state.pageSize = Number($('cpPageSize').value);
    savePref(keys.capturePageSize, state.pageSize);
    state.currentPage = 1;
    renderLogList();
}

function changePage(delta) {
    state.currentPage += delta;
    renderLogList();
}

let searchTimer = null;

/** 表格整行点击 = 编辑：不再依赖行内按钮，事件委托一次绑到 tbody */
function onTableBodyClick(event) {
    const row = event.target.closest('tr[data-hostname]');
    if (row) {
        const hostname = row.dataset.hostname;
        if (hostname) {
            openQuickEdit(hostname);
        }
    }
}

/** 绑定列表与批量编辑区控件事件 */
function wireListControls() {
    populateTypeFilterSelect();
    renderColumnMenu();

    $('cpSearch').addEventListener('input', () => {
        clearTimeout(searchTimer);
        searchTimer = setTimeout(onSearchInput, CP_CONFIG.searchDebounceMs);
    });
    $('cpSort').addEventListener('change', onSortChange);
    $('cpPolicyFilter').addEventListener('change', onPolicyFilterChange);
    $('cpTypeFilter').addEventListener('change', onTypeFilterChange);
    $('cpSourceFilter').addEventListener('change', onSourceFilterChange);
    $('cpPageSize').addEventListener('change', onPageSizeChange);
    $('cpBatchTextarea').addEventListener('input', updateBatchParseInfo);
    $('cpTableBody').addEventListener('click', onTableBodyClick);
    $('themeToggleBtn').addEventListener('click', toggleTheme);

    // 表头显隐：多选框事件委托（菜单内容随状态重渲染，父节点监听不变）
    $('cpColumnMenu')?.addEventListener('change', (event) => {
        const toggle = event.target.closest('[data-col-toggle]');
        if (toggle) setColumnVisible(toggle.dataset.colToggle, toggle.checked);
    });

    // 来源设备统计卡点击 → 设备检测综合视图（卡片由 renderStats 重渲染，父节点委托）
    const stats = $('cpStats');
    stats?.addEventListener('click', (event) => {
        if (event.target.closest('#cpStatDevices')) switchPage('devices');
    });
    stats?.addEventListener('keydown', (event) => {
        if ((event.key === 'Enter' || event.key === ' ') && event.target.closest('#cpStatDevices')) {
            event.preventDefault();
            switchPage('devices');
        }
    });
}

/** 绑定导出筛选弹窗与全局快捷键 */
function wireExportControls() {
    $('cpOnlyEmptyComment').addEventListener('change', saveOnlyEmptyPref);
    $('cpExportSource').addEventListener('change', onExportOptionChange);
    $('cpExportWithSource').addEventListener('change', onExportOptionChange);
    $('cpMinCountCustom').addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
            event.preventDefault();
            applyCustomMinCount();
        }
    });
    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') {
            // 编辑态下按 Esc 退出编辑，与「取消编辑」按钮等价
            if (state.editing) cancelEdit();
        }
    });
}

/** 编辑弹窗底部的高频操作：删除前先收起编辑窗，避免弹窗叠着 confirm */
function quickDelete() {
    const host = quickEditTarget();
    if (!host) return;
    closeQuickEdit();
    deleteLog(host);
}

/** 先落一版默认设置让页面立刻可用，偏好接口返回后再覆盖为数据库里的真实值 */
async function bootData() {
    applyPreferences();
    await loadPrefs();
    applyPreferences();
    state.currentPage = 1;
    await cpRefreshAll();
    // 固定订阅的全局筛选配置：读回服务端值，弹窗控件与订阅端实际输出保持一致
    await restoreExportFilters();
    refreshExportSummary();
    await loadSubscriptions();
}

function initCapturedPanel() {
    wireNav();
    switchPage(state.tab);
    wireListControls();
    wireExportControls();
    initVersionCheck();
    initHealthView();
    // AI 分流自动化：前端调度器（面板打开期间按周期触发）+ AI 页面懒加载
    startAiScheduler();
    // 进入设备检测综合视图时用已加载的 stats 数据即时渲染设备面板（刷新后由 doRefreshAll 再刷新）
    document.addEventListener('cp:page', (event) => {
        if (event.detail === 'devices') renderDevicePanel();
    });
    bootData();
}

/** 暴露给 HTML 内联事件，与原面板调用方式完全一致 */
window.capturePanel = {
    init: initCapturedPanel,
    reload,
    switchPage,
    openQuickEdit,
    saveQuickEdit,
    quickDelete,
    cancelEdit,
    fillTextareaFromTable,
    clearBatchText,
    batchOverride,
    deleteLog,
    clearEmpty,
    wipeDatabase,
    onWipeInput,
    confirmWipe,
    reduceExclude,
    changePage,
    copyPageDomains,
    copyExportLink,
    setTheme,
    savePrompt,
    saveOnlyEmptyPref,
    onExportOptionChange,
    setExportType,
    setMinCount,
    applyCustomMinCount,
    clearMinCount,
    setLastDays,
    openSubscribeModal,
    parseSubscriptions,
    reparseSubscription,
    deleteSubscription,
    fillFromSubscription,
    clearSubInput,
    saveWriteToken,
    saveGistConfig,
    uploadToGist,
    syncFromGist,
    aiSaveConnection,
    aiSaveSchedule,
    aiLoadModels,
    aiTestConnection,
    aiRefreshStatus,
    aiRunNow,
    aiResetProcessed,
    runHealthChecks: runHealthChecksBasic,
    confirmDeepHealth: runDeepConfirmed,
    copyHealthReport
};

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initCapturedPanel, { once: true });
} else {
    initCapturedPanel();
}

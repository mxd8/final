/**
 * 统一刷新路径：任何写操作之后都走这里，保证列表、统计、常量、
 * 来源下拉框与导出摘要一致，不再各自手写刷新链路。
 *
 * 全量规则（allLogs）改为按需加载：来源下拉框与策略候选改用 stats 聚合结果，
 * 只有 Gist 备份 / 订阅去重真正需要整份列表时才拉取，刷新从两份 5000 行降为一份。
 * 并发刷新串行化：两次刷新交叠时先发的响应不允许把旧数据渲染上去。
 */

import { cpLoadLogs, cpLoadStats, cpLoadMeta, ensureAllLogs } from './api.js';
import { populateSourceFilters, populateTypeFilterSelect, renderLogList } from './render.js';
import { refreshExportSummary } from './export.js';
import { cpSetBusy, cpToast } from './notify.js';
import { loadSubscriptions } from './subscribe.js';
import { renderVersionBoard } from './version-check.js';
import { state } from './config.js';

async function doRefreshAll() {
    await Promise.all([cpLoadLogs(), cpLoadStats(), cpLoadMeta()]);
    // 数据已变化：懒加载的全量列表标记过期，等真正需要时再拉
    state.allLogsStale = true;
    populateSourceFilters();
    populateTypeFilterSelect();
    renderLogList();
    refreshExportSummary();
    // stats 捎带的客户端心跳（版本看板的 Surge 侧数据）到达后刷新看板
    renderVersionBoard();
}

let refreshChain = Promise.resolve();

export async function cpRefreshAll() {
    const run = refreshChain.then(doRefreshAll);
    refreshChain = run.then(() => {}, () => {});
    return run;
}

/** 整页刷新（顶栏按钮）：列表 + 统计 + 常量 + 订阅清单 */
export async function reload() {
    if (state.busy) return;
    cpSetBusy(true);
    try {
        await cpRefreshAll();
        await ensureAllLogs();
        await loadSubscriptions();
    } catch (error) {
        cpToast(`加载失败：${error.message}`, 'danger');
    } finally {
        cpSetBusy(false);
    }
}

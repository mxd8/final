/**
 * 面板渲染：统计卡、筛选下拉框、规则表与分页。
 *
 * 规则表列由 TABLE_COLUMNS 统一定义：表头 th 与数据 td 都带 data-col，
 * 显隐状态存 state.hiddenColumns（持久化到数据库），「来源 IP」为 v2 新增列，
 * 用于区分同型号多设备。
 */

import { state } from './config.js';
import { $, cpEscape, cpAttr, formatTime } from './dom.js';
import { policyBadge, paramBadges } from './ruletext.js';
import { cpToast } from './notify.js';
import { savePref, keys } from './prefs-store.js';

/** 规则表列定义：key 与表头 data-col / 偏好存储的隐藏列数组一致 */
export const TABLE_COLUMNS = [
    { key: 'type', label: '类型' },
    { key: 'value', label: '匹配值' },
    { key: 'policy', label: '策略' },
    { key: 'params', label: '参数' },
    { key: 'comment', label: '备注' },
    { key: 'source', label: '来源' },
    { key: 'ip', label: '来源 IP' },
    { key: 'time', label: '最近命中' },
    { key: 'count', label: '次数' }
];

/** 当前可见列（定义顺序保留，隐藏列剔除） */
export function visibleColumns() {
    return TABLE_COLUMNS.filter((column) => !state.hiddenColumns.has(column.key));
}

export function renderStats() {
    const el = $('cpStats');
    if (!el) return;
    const stats = state.stats;
    const v = (key, fallback = '-') => (stats ? stats[key] ?? fallback : fallback);

    // 来源设备卡：优先展示设备注册表的 n/m 在线统计（含告警角标），
    // 旧后端没有设备报表时回落到规则表来源聚合数
    const summary = stats?.deviceSummary;
    let deviceValue;
    let deviceAlerts = '';
    if (summary && Number(summary.total) > 0) {
        deviceValue = `${summary.online ?? 0}/${summary.total} 台在线`;
        if (summary.alertCount > 0) deviceAlerts = `⚠️ ${summary.alertCount} 条告警`;
    } else {
        deviceValue = `${v('sourceCount', 0)} 台`;
    }

    const cells = [
        ['规则总数', `${v('totalRules', 0)} 条`, '', false],
        ['触发总计', `${v('totalHits', 0)} 次`, '', false],
        ['代理 / 直连', `${v('proxyCount', 0)} / ${v('directCount', 0)}`, '', false],
        ['拦截 / 无备注', `${v('rejectCount', 0)} / ${v('emptyCommentCount', 0)}`, '', false],
        ['今日新增', `${v('todayNew', 0)} 条`, '', false],
        ['来源设备', deviceValue, deviceAlerts, true]
    ];

    el.innerHTML = cells
        .map(
            ([label, value, hint, clickable]) => `
        <div class="cp-stat card${clickable ? ' cp-stat-clickable' : ''}"${clickable ? ' id="cpStatDevices" role="button" tabindex="0" title="点击查看设备在线状态、配置告警与综合检测" aria-label="来源设备，点击进入设备检测综合视图"' : ''}>
            <div class="label">${cpEscape(label)}</div>
            <div class="value">${cpEscape(String(value))}${hint ? `<div class="cp-stat-hint text-warning small">${cpEscape(hint)}</div>` : ''}</div>
        </div>`
        )
        .join('');

    const topbarCount = $('cpTopbarCount');
    if (topbarCount) topbarCount.textContent = stats ? `共 ${stats.totalRules ?? 0} 条规则` : '';
}

/** 填充规则类型筛选下拉框，保留当前选中值 */
export function populateTypeFilterSelect() {
    const types = state.meta?.ruleTypes?.length
        ? state.meta.ruleTypes
        : ['DOMAIN-SUFFIX', 'DOMAIN', 'DOMAIN-KEYWORD', 'IP-CIDR', 'IP-CIDR6', 'PROCESS-NAME', 'GEOIP', 'URL-REGEX', 'FINAL'];
    const filter = $('cpTypeFilter');
    if (!filter) return;
    const filterValue = filter.value || 'ALL';
    filter.innerHTML = `<option value="ALL">全部类型</option>` +
        types.map((type) => `<option value="${cpAttr(type)}">${cpEscape(type)}</option>`).join('');
    if (types.includes(filterValue)) filter.value = filterValue;
}

/** 填充来源筛选下拉框（导出与列表两处共用）：优先用 stats 的全量来源聚合，
  * 避免为下拉框整份拉取全量规则；stats 未就绪时回落本地已加载数据。
  */
export function populateSourceFilters() {
    let sources = (state.stats?.sourceNames || []).slice();
    if (!sources.length) {
        for (const item of state.allLogs.length ? state.allLogs : state.logs) {
            const source = String(item.source || '').trim();
            if (source && !sources.includes(source)) sources.push(source);
        }
    }

    for (const id of ['cpExportSource', 'cpSourceFilter']) {
        const select = $(id);
        if (!select) continue;
        const current = select.value || '';
        select.innerHTML = `<option value="">全部来源</option>` +
            sources.map((source) => `<option value="${cpAttr(source)}">${cpEscape(source)}</option>`).join('');
        if (sources.includes(current)) select.value = current;
    }
}

/** 按当前筛选条件（来源 + 搜索词）过滤并排序 */
export function cpVisibleLogs() {
    const query = state.search.trim().toLowerCase();
    const sourceKey = state.sourceFilter.trim();
    const matched = state.logs.filter((item) => {
        if (sourceKey && String(item.source || '') !== sourceKey) return false;
        if (!query) return true;
        return `${item.hostname} ${item.value || ''} ${item.policy || ''} ${item.source || ''} ${item.ip || ''} ${item.username || ''} ${item.comment || ''}`
            .toLowerCase()
            .includes(query);
    });

    const sorters = {
        'count-desc': (a, b) => (Number(b.count) || 1) - (Number(a.count) || 1),
        'domain-asc': (a, b) => String(a.hostname).localeCompare(String(b.hostname)),
        'time-desc': (a, b) => (new Date(b.time) || 0) - (new Date(a.time) || 0)
    };
    matched.sort(sorters[state.sort] || sorters['time-desc']);
    return matched;
}

/** 当前页可见规则的纯匹配值（可按「仅空备注」过滤） */
export function cpPageDomains() {
    const onlyEmpty = $('cpOnlyEmptyComment').checked;
    const visible = cpVisibleLogs();
    const pageItems = visible.slice((state.currentPage - 1) * state.pageSize, state.currentPage * state.pageSize);
    return pageItems
        .filter((item) => item.value && item.type !== 'FINAL')
        .filter((item) => !onlyEmpty || !String(item.comment || '').trim())
        .map((item) => item.value);
}

/** 刷新「复制当前页匹配值」按钮上的可用数量 */
export function refreshCopyCount() {
    const btn = $('cpCopyPageBtn');
    if (btn) btn.textContent = `📋 复制当前页匹配值（${cpPageDomains().length}）`;
}

/** 单元格渲染器：与 TABLE_COLUMNS 的 key 一一对应 */
const CELL_RENDERERS = {
    type: (item) => `<td data-col="type"><span class="badge text-bg-secondary">${cpEscape(item.type || 'DOMAIN-SUFFIX')}</span></td>`,
    value: (item) => `<td data-col="value" class="cp-mono">${cpEscape(item.value || item.hostname)}</td>`,
    policy: (item) => `<td data-col="policy">${policyBadge(item.policy)}</td>`,
    params: (item) => `<td data-col="params" class="cp-col-params">${paramBadges(item.params) || '<span class="text-muted">—</span>'}</td>`,
    comment: (item) => `<td data-col="comment" class="cp-mono small">${cpEscape(item.comment || '')}</td>`,
    source: (item) => `<td data-col="source" class="cp-col-source">${item.source ? `📱 ${cpEscape(item.source)}` : '<span class="text-muted">—</span>'}</td>`,
    ip: (item) => `<td data-col="ip" class="cp-col-ip cp-mono small">${item.ip ? `🌐 ${cpEscape(item.ip)}` : '<span class="text-muted">—</span>'}</td>`,
    time: (item) => `<td data-col="time" class="small text-muted cp-col-time">${cpEscape(formatTime(item.time))}</td>`,
    count: (item) => `<td data-col="count" class="text-nowrap"><span title="触发次数">🔥 ${Number(item.count) || 1}</span></td>`
};

function logRowHtml(item) {
    const editing = state.editing === item.hostname ? 'table-active' : '';
    const cells = visibleColumns().map((column) => CELL_RENDERERS[column.key](item)).join('');
    return `
        <tr class="${editing}" data-hostname="${cpAttr(item.hostname)}" title="点击整行编辑">${cells}</tr>`;
}

/** 表头同步：隐藏列的 th 一并隐藏（数据列渲染时已跳过） */
function syncHeadColumns() {
    document.querySelectorAll('.cp-rule-table thead th[data-col]').forEach((th) => {
        th.classList.toggle('cp-col-hidden', state.hiddenColumns.has(th.dataset.col));
    });
}

/** 渲染当前分页的规则表 */
export function renderLogList() {
    const body = $('cpTableBody');
    if (!body) return;

    syncHeadColumns();
    const visible = cpVisibleLogs();
    const totalPages = Math.max(1, Math.ceil(visible.length / state.pageSize));
    state.currentPage = Math.min(Math.max(1, state.currentPage), totalPages);
    const pageItems = visible.slice((state.currentPage - 1) * state.pageSize, state.currentPage * state.pageSize);

    if (!visible.length) {
        body.innerHTML = `<tr><td colspan="${visibleColumns().length}" class="text-center text-muted py-4">${
            state.logs.length ? '没有符合筛选条件的规则' : '暂无规则，等待流量触发 FINAL 兜底、粘贴批量文本或从订阅填充…'
        }</td></tr>`;
    } else {
        body.innerHTML = pageItems.map((item) => logRowHtml(item)).join('');
    }

    renderPagination(visible.length);
    refreshCopyCount();
}

function renderPagination(total) {
    const start = total === 0 ? 0 : (state.currentPage - 1) * state.pageSize + 1;
    const end = Math.min(state.currentPage * state.pageSize, total);
    const totalPages = Math.max(1, Math.ceil(total / state.pageSize));

    $('cpPageInfo').textContent = `显示第 ${start}-${end} 条，共 ${total} 条`;
    $('cpPageNum').textContent = `${state.currentPage} / ${totalPages}`;
}

/* ------------------------------------------------ 表头显隐配置 */

/** 渲染「列显示」下拉菜单：每列一个多选框，勾选 = 显示 */
export function renderColumnMenu() {
    const menu = $('cpColumnMenu');
    if (!menu) return;
    menu.innerHTML = TABLE_COLUMNS.map((column) => `
        <label class="dropdown-item-text form-check mb-1" style="cursor:pointer;">
            <input type="checkbox" class="form-check-input me-1" data-col-toggle="${cpAttr(column.key)}"
                   ${state.hiddenColumns.has(column.key) ? '' : 'checked'}>
            <span class="form-check-label small">${cpEscape(column.label)}</span>
        </label>`).join('');
}

/** 应用显隐状态：重渲染菜单、表头与表格（写入由 setColumnVisible 负责） */
export function applyColumnVisibility() {
    renderColumnMenu();
    renderLogList();
}

/** 勾选 / 取消勾选一列：更新状态、持久化（防抖）并重渲染 */
export function setColumnVisible(key, visible) {
    if (!TABLE_COLUMNS.some((column) => column.key === key)) return;
    if (visible) state.hiddenColumns.delete(key);
    else state.hiddenColumns.add(key);
    // 至少保留一列可见，避免整表消失让人误以为数据丢了
    if (visibleColumns().length === 0) {
        state.hiddenColumns.delete(key);
        cpToast('至少保留一列显示', 'warning');
        renderColumnMenu();
        return;
    }
    // 状态持久化到数据库：savePref 本地缓存 + 400ms 防抖合并写入，高频切换不产生写库压力
    savePref(keys.tableColumns, JSON.stringify([...state.hiddenColumns]));
    renderColumnMenu();
    renderLogList();
}

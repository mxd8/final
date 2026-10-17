/**
 * 面板渲染：统计卡、筛选下拉框、规则表与分页。
 */

import { state } from './config.js';
import { $, cpEscape, cpAttr, formatTime } from './dom.js';
import { policyBadge, paramBadges } from './ruletext.js';

export function renderStats() {
    const el = $('cpStats');
    if (!el) return;
    const stats = state.stats;
    const v = (key, fallback = '-') => (stats ? stats[key] ?? fallback : fallback);

    el.innerHTML = [
        ['规则总数', `${v('totalRules', 0)} 条`],
        ['触发总计', `${v('totalHits', 0)} 次`],
        ['代理 / 直连', `${v('proxyCount', 0)} / ${v('directCount', 0)}`],
        ['拦截 / 无备注', `${v('rejectCount', 0)} / ${v('emptyCommentCount', 0)}`],
        ['今日新增', `${v('todayNew', 0)} 条`],
        ['来源设备', `${v('sourceCount', 0)} 台`]
    ]
        .map(
            ([label, value]) => `
        <div class="cp-stat card">
            <div class="label">${cpEscape(label)}</div>
            <div class="value">${cpEscape(String(value))}</div>
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
        return `${item.hostname} ${item.value || ''} ${item.policy || ''} ${item.source || ''} ${item.comment || ''}`
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

function logRowHtml(item) {
    const editing = state.editing === item.hostname ? 'table-active' : '';
    return `
        <tr class="${editing}" data-hostname="${cpAttr(item.hostname)}" title="点击整行编辑">
            <td><span class="badge text-bg-secondary">${cpEscape(item.type || 'DOMAIN-SUFFIX')}</span></td>
            <td class="cp-mono">${cpEscape(item.value || item.hostname)}</td>
            <td>${policyBadge(item.policy)}</td>
            <td class="cp-col-params">${paramBadges(item.params) || '<span class="text-muted">—</span>'}</td>
            <td class="cp-mono small">${cpEscape(item.comment || '')}</td>
            <td class="cp-col-source">${item.source ? `📱 ${cpEscape(item.source)}` : '<span class="text-muted">—</span>'}</td>
            <td class="small text-muted cp-col-time">${cpEscape(formatTime(item.time))}</td>
            <td class="text-nowrap"><span title="触发次数">🔥 ${Number(item.count) || 1}</span></td>
        </tr>`;
}

/** 渲染当前分页的规则表 */
export function renderLogList() {
    const body = $('cpTableBody');
    if (!body) return;

    const visible = cpVisibleLogs();
    const totalPages = Math.max(1, Math.ceil(visible.length / state.pageSize));
    state.currentPage = Math.min(Math.max(1, state.currentPage), totalPages);
    const pageItems = visible.slice((state.currentPage - 1) * state.pageSize, state.currentPage * state.pageSize);

    if (!visible.length) {
        body.innerHTML = `<tr><td colspan="8" class="text-center text-muted py-4">${
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

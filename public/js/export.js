/**
 * 规则导出：固定订阅地址（/api/export?policy=*）一键复制、按钮实时数量、
 * 筛选配置全局生效（写入偏好表 user=export，Surge 端地址永远不用换）。
 * 摘要请求带防抖与 AbortController：晚到的旧响应不允许覆盖新数据。
 */

import { state, CP_EXPORT_TYPES, CP_MIN_COUNT_PRESETS, CP_LAST_DAYS_PRESETS, CP_CONFIG } from './config.js';
import { $, cpEscape } from './dom.js';
import { cpToast } from './notify.js';
import { savePref, keys, saveExportFilters, loadExportFilters } from './prefs-store.js';
import { cpPageDomains } from './render.js';
import { cpCopy } from './clipboard.js';

const POLICY_LABELS = { all: '全部', proxy: 'PROXY', direct: 'DIRECT', reject: 'REJECT' };

/** 固定订阅地址：筛选条件全部在服务端偏好表里，改配置不改地址 */
export function fixedExportUrl(type) {
    return new URL(`/api/export?policy=${type}`, window.location.origin).toString();
}

/** 类型快捷按钮与命中次数档位的选中态同步 */
export function renderExportTypeButtons() {
    for (const type of CP_EXPORT_TYPES) {
        const btn = $(`cpType${type.charAt(0).toUpperCase()}${type.slice(1)}Btn`);
        if (btn) btn.classList.toggle('active', state.exportType === type);
    }
    for (const preset of CP_MIN_COUNT_PRESETS) {
        const btn = $(`cpMinCount${preset}Btn`);
        if (btn) btn.classList.toggle('active', state.exportMinCount === preset);
    }
    for (const days of CP_LAST_DAYS_PRESETS) {
        const btn = $(`cpLastDays${days}Btn`);
        if (btn) btn.classList.toggle('active', state.exportLastDays === days);
    }
    const clearTimeBtn = $('cpLastDaysClearBtn');
    if (clearTimeBtn) clearTimeBtn.classList.toggle('d-none', !(state.exportLastDays > 0));
    const timeLabel = $('cpLastDaysLabel');
    if (timeLabel) timeLabel.textContent = state.exportLastDays > 0 ? `仅导出最近 ${state.exportLastDays} 天命中过的规则` : '';
    const clearBtn = $('cpMinCountClearBtn');
    if (clearBtn) clearBtn.classList.toggle('d-none', !(state.exportMinCount > 1));
    const custom = $('cpMinCountCustom');
    if (custom && document.activeElement !== custom) custom.value = state.exportMinCount > 1 ? String(state.exportMinCount) : '';
    const label = $('cpMinCountLabel');
    if (label) label.textContent = state.exportMinCount > 1 ? `仅导出命中 ≥ ${state.exportMinCount} 次的规则` : '';
}

/** 切换当前查看的导出类型：按钮态 + 设备偏好（不影响固定地址本身） */
export function setExportType(type) {
    const next = CP_EXPORT_TYPES.includes(type) ? type : 'all';
    if (next === state.exportType) return;
    state.exportType = next;
    savePref(keys.captureExportType, next);
    renderExportTypeButtons();
}

/** 读取筛选配置弹窗里的当前条件 */
function readExportControls() {
    return {
        source: $('cpExportSource').value,
        withSource: $('cpExportWithSource').checked,
        minCount: state.exportMinCount,
        lastDays: state.exportLastDays
    };
}

/** 把筛选条件写入服务端 user=export 偏好：固定订阅地址立即按新条件输出 */
async function persistExportFilters() {
    const { source, withSource, minCount, lastDays } = readExportControls();
    const ok = await saveExportFilters({
        'export.source': source,
        'export.with_source': withSource ? '1' : '0',
        'export.min_count': String(minCount || 0),
        'export.last_days': String(lastDays || 0)
    });
    if (!ok) cpToast('筛选保存失败，订阅端暂用上一次的条件', 'warning');
}

/** 设置命中次数下限（快捷档位与自定义输入共用） */
export function setMinCount(value) {
    const next = Math.floor(Number(value) || 0);
    const resolved = next > 1 ? next : 0;
    if (resolved === state.exportMinCount) return;
    state.exportMinCount = resolved;
    renderExportTypeButtons();
    persistExportFilters();
    refreshExportSummary();
}

export function applyCustomMinCount() {
    const raw = Number($('cpMinCountCustom').value);
    if (!Number.isFinite(raw) || raw < 1) {
        cpToast('请输入大于 0 的整数', 'warning');
        return;
    }
    setMinCount(raw);
}

export function clearMinCount() {
    setMinCount(0);
}

/** 设置最近命中时间过滤：快捷档位与「清除」共用，0 表示不过滤 */
export function setLastDays(days) {
    const next = Math.floor(Number(days) || 0);
    const resolved = next > 0 ? next : 0;
    if (resolved === state.exportLastDays) return;
    state.exportLastDays = resolved;
    renderExportTypeButtons();
    persistExportFilters();
    refreshExportSummary();
}

/** 来源 / 带来源注释变化：条件进固定地址，不再需要设备偏好 */
export function onExportOptionChange() {
    persistExportFilters();
    refreshExportSummary();
}

/** 把当前导出筛选条件说成人话 */
export function describeExportFilterText() {
    const { source, minCount, lastDays } = readExportControls();
    const parts = [`来源 ${source || '全部'}`];
    if (minCount > 1) parts.push(`命中 > ${minCount}`);
    if (lastDays > 0) parts.push(`最近 ${lastDays} 天`);
    return parts.join(' · ');
}

function buildSummaryQuery() {
    const query = new URLSearchParams({ type: 'all' });
    const { source, withSource, minCount, lastDays } = readExportControls();
    if (source) query.set('source', source);
    if (withSource) query.set('with-source', '1');
    if (minCount > 1) query.set('min-count', String(minCount));
    if (lastDays > 0) query.set('last-days', String(lastDays));
    return query;
}

function summaryHtml(data, policyParts) {
    return [
        `📊 全部导出共 <code>${cpEscape(String(data.ruleCount ?? 0))}</code> 条规则`,
        `（合计 <code>${cpEscape(String(data.hits ?? 0))}</code> 次触发，`,
        `IPv4 <code>${cpEscape(String(data.ipv4 ?? 0))}</code>，`,
        `IPv6 <code>${cpEscape(String(data.ipv6 ?? 0))}</code>，`,
        `无备注 <code>${cpEscape(String(data.emptyComment ?? 0))}</code>）`,
        `<br>${cpEscape(policyParts)}`,
        `<br><span class="text-body-secondary">摘要已打印到浏览器控制台（console.table）</span>`
    ].join(' ');
}

/** 策略按钮上的实时数量：全部 = 摘要 ruleCount，其余 = byPolicy 对应项 */
function updatePolicyCountButtons(data) {
    const byPolicy = data.byPolicy || {};
    const counts = {
        all: data.ruleCount ?? 0,
        proxy: byPolicy.PROXY || 0,
        direct: byPolicy.DIRECT || 0,
        reject: byPolicy.REJECT || 0
    };
    state.exportCounts = counts;
    for (const type of CP_EXPORT_TYPES) {
        const el = $(`cpType${type.charAt(0).toUpperCase()}${type.slice(1)}Count`);
        if (el) el.textContent = String(counts[type] ?? 0);
    }
}

let summaryTimer = null;
let summaryController = null;

/** 配置按钮指示：有来源或命中次数条件生效时高亮，提醒用户筛选藏在弹窗里 */
function syncExportConfigButton() {
    const btn = $('cpExportConfigBtn');
    if (!btn) return;
    const { source, minCount, lastDays } = readExportControls();
    const hasFilter = minCount > 1 || lastDays > 0 || source !== '';
    btn.classList.toggle('active', hasFilter);
    btn.classList.toggle('text-warning', hasFilter);
}

/** 拉取导出摘要并在面板上展示（防抖 + 中断旧请求），同时刷新按钮数量 */
export function refreshExportSummary() {
    syncExportConfigButton();
    if (summaryTimer) clearTimeout(summaryTimer);
    summaryTimer = setTimeout(async () => {
        const el = $('cpExportSummary');
        if (summaryController) summaryController.abort();
        summaryController = new AbortController();
        try {
            // 与 cpRequest 同理：写操作后要立刻看到新摘要，GET 加一次性时间戳
            const summaryQuery = buildSummaryQuery();
            summaryQuery.set('_cb', String(Date.now()));
            const response = await fetch(`${CP_CONFIG.apiBase}/export-summary?${summaryQuery.toString()}`, {
                signal: summaryController.signal
            });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const payload = await response.json();
            const data = payload.data || {};

            const policyParts = Object.entries(data.byPolicy || {})
                .sort((a, b) => b[1] - a[1])
                .map(([name, count]) => `${name} ${count}`)
                .join(' / ') || '无';
            el.innerHTML = summaryHtml(data, policyParts);
            updatePolicyCountButtons(data);
            console.table({ '导出摘要': data });
        } catch (error) {
            if (error.name === 'AbortError') return;
            console.warn('[surge] 导出摘要加载失败', error.message);
            if (el) el.textContent = '导出摘要加载失败，订阅地址仍可复制使用';
        }
    }, CP_CONFIG.summaryDebounceMs);
}

/** 启动时从服务端读回全局筛选配置，弹窗里的控件与实际输出保持一致 */
export async function restoreExportFilters() {
    const prefs = await loadExportFilters();
    const minCount = Number(prefs['export.min_count']);
    state.exportMinCount = Number.isFinite(minCount) && minCount > 1 ? Math.floor(minCount) : 0;
    const lastDays = Number(prefs['export.last_days']);
    state.exportLastDays = Number.isFinite(lastDays) && lastDays > 0 ? Math.floor(lastDays) : 0;

    const sourceSelect = $('cpExportSource');
    if (sourceSelect && prefs['export.source'] && [...sourceSelect.options].some((option) => option.value === prefs['export.source'])) {
        sourceSelect.value = prefs['export.source'];
    }
    $('cpExportWithSource').checked = prefs['export.with_source'] === '1';
    renderExportTypeButtons();
}

/**
 * 点击 全部 / PROXY / DIRECT / REJECT：复制对应的固定订阅地址。
 * 地址永不变化——筛选条件改在「筛选配置」里，Surge 端无需重新配置。
 */
export async function copyExportLink(type) {
    const next = CP_EXPORT_TYPES.includes(type) ? type : 'all';
    setExportType(next);
    const count = state.exportCounts ? state.exportCounts[next] : null;
    const suffix = count == null ? '' : `，当前 ${count} 条`;
    await cpCopy(fixedExportUrl(next), `已复制${POLICY_LABELS[next]}订阅地址${suffix}；筛选改动自动生效，无需换地址`);
}

/** 复制当前页纯匹配值（带自定义提示词置顶，便于直接交给 AI 分流） */
export async function copyPageDomains() {
    const values = cpPageDomains();
    if (!values.length) {
        cpToast('当前页没有可复制的匹配值', 'warning');
        return;
    }
    const prompt = $('cpPromptInput').value.trim();
    const text = [prompt ? `${prompt}\n` : '', values.join('\n')].join('');
    await cpCopy(text, `已复制 ${values.length} 个匹配值`);
}

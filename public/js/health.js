/**
 * 配置检测视图：/api/health 的前端管道（docs/feature-requirements.md 1.2.5）。
 *
 * 轻量化取舍：一次请求返回全部结果，前端按序动画展示（不做逐项轮询）；
 * 失败项可展开查看修复建议与 readme 锚点；「复制诊断报告」输出服务端已脱敏的
 * 纯文本报告，便于贴到 issue 求助；深度检测有写副作用，弹窗二次确认后触发。
 */

import { $, cpEscape } from './dom.js';
import { cpToast } from './notify.js';
import { cpCopy } from './clipboard.js';
import { getWriteToken } from './prefs-store.js';
import { getSessionToken } from './auth.js';
import { state } from './config.js';

const STATUS_META = {
    pass: { icon: '✅', badge: 'text-bg-success', label: '通过' },
    warn: { icon: '⚠️', badge: 'text-bg-warning', label: '警告' },
    fail: { icon: '❌', badge: 'text-bg-danger', label: '失败' },
    skip: { icon: '⏭️', badge: 'text-bg-secondary', label: '跳过' }
};

const SUMMARY_BADGE = { pass: 'text-bg-success', warn: 'text-bg-warning', fail: 'text-bg-danger' };
const SUMMARY_TEXT = { pass: '✅ 链路健康', warn: '⚠️ 有警告项', fail: '❌ 存在失败项' };

const CHAIN_LABEL = { browser: '🌐 浏览器', pages: '📄 Pages Functions', database: '🗄️ 数据库', surge: '📱 Surge 客户端' };

let lastReport = null;
let running = false;

/** 健康检测请求：GET；深度检测自动附带鉴权（会话令牌优先，回落写令牌）与 confirm=1 二次确认标记 */
async function fetchHealth(mode) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);
    const headers = {};
    const token = getSessionToken() || getWriteToken();
    if (token) headers.Authorization = `Bearer ${token}`;
    const scope = readScope();
    const params = new URLSearchParams({ mode });
    if (mode === 'deep') params.set('confirm', '1'); // 服务端要求显式二次确认（前端已弹窗确认）
    if (scope.deviceId) params.set('device-id', scope.deviceId);
    if (scope.username) params.set('username', scope.username);
    try {
        const response = await fetch(`/api/health?${params.toString()}`, {
            headers,
            signal: controller.signal
        });
        const data = await response.json().catch(() => null);
        if (!response.ok || !data?.success) {
            throw new Error(data?.error || `检测失败（HTTP ${response.status}）`);
        }
        return data.data;
    } catch (error) {
        if (error.name === 'AbortError') throw new Error('检测超时，请稍后重试');
        throw error;
    } finally {
        clearTimeout(timer);
    }
}

/** 检测隔离范围（检测项按需隔离）：设备下拉框选择单台设备时只检测该设备 */
function readScope() {
    const selector = $('cpHealthScopeDevice');
    return { deviceId: selector && selector.value ? selector.value : '' };
}

/** 逐项渲染（分类标题由 renderReport 插入） */
function checkItemHtml(item, index) {
    const meta = STATUS_META[item.status] || STATUS_META.skip;
    const fix = item.fix
        ? `<div class="small mt-1"><span class="text-muted">修复建议：</span>${cpEscape(item.fix)}${item.doc ? `（<a href="readme.md#${cpEscape(String(item.doc).replace(/^#/, ''))}" target="_blank" rel="noopener">文档</a>）` : ''}</div>`
        : '';
    const expandable = item.fix || (item.detail && item.detail.length > 120);
    const body = `
        <div class="small text-muted">耗时 ${item.ms} ms</div>
        <div class="small">${cpEscape(item.detail || '')}</div>
        ${fix}`;
    return `
        <div class="list-group-item d-flex gap-2 align-items-start cp-health-item" style="animation-delay:${index * 60}ms">
            <span class="fs-5" aria-hidden="true">${meta.icon}</span>
            <div class="flex-grow-1 ${expandable ? 'cp-collapsible' : ''}">
                <div class="d-flex flex-wrap align-items-center gap-2">
                    <span class="fw-semibold small">${index + 1}. ${cpEscape(item.name)}</span>
                    <span class="badge ${meta.badge}">${meta.label}</span>
                </div>
                ${expandable ? `<details class="mt-1"><summary class="small text-muted" style="cursor:pointer">详情与修复建议</summary>${body}</details>` : body}
            </div>
        </div>`;
}

/** 分类标题条（v1.5 诊断分类）：系统配置 / 数据库 / Surge 客户端 / 版本与更新 */
function categoryHeaderHtml(category) {
    const meta = STATUS_META[category.overall] || STATUS_META.skip;
    return `
        <div class="list-group-item list-group-item-secondary d-flex flex-wrap align-items-center gap-2 py-2">
            <span class="fw-semibold small">🗂️ ${cpEscape(category.label)}</span>
            <span class="badge ${meta.badge}">${meta.label}</span>
            <span class="small text-muted">${cpEscape(category.description || '')}</span>
        </div>`;
}

function renderReport(report) {
    const list = $('cpHealthList');
    const summary = $('cpHealthSummary');
    if (!list || !summary) return;

    // 分类视图：带分类信息的报告按 category 分组插入标题条；旧后端没有 category 字段时平铺
    const hasCategories = report.checks.some((item) => item.category);
    const parts = [];
    let index = 0;
    if (hasCategories && Array.isArray(report.categories)) {
        for (const category of report.categories) {
            const items = report.checks.filter((item) => item.category === category.id);
            if (!items.length) continue;
            parts.push(categoryHeaderHtml(category));
            for (const item of items) parts.push(checkItemHtml(item, index++));
        }
        if (report.chain) {
            const chainText = Object.entries(report.chain)
                .map(([key, status]) => `${CHAIN_LABEL[key] ?? key} ${STATUS_META[status]?.icon ?? '•'}`)
                .join('  ');
            parts.push(`
                <div class="list-group-item d-flex flex-wrap gap-2 align-items-center py-2">
                    <span class="fw-semibold small">🔗 全链路自证</span>
                    <span class="small">${cpEscape(chainText)}</span>
                </div>`);
        }
    } else {
        for (const item of report.checks) parts.push(checkItemHtml(item, index++));
    }
    list.innerHTML = parts.join('');

    const counts = report.summary.counts;
    summary.innerHTML = `
        <div class="d-flex flex-wrap align-items-center gap-2">
            <span class="badge ${SUMMARY_BADGE[report.summary.overall] || 'text-bg-secondary'} fs-6">
                ${SUMMARY_TEXT[report.summary.overall] || report.summary.overall}
            </span>
            <span class="small text-muted">
                通过 ${counts.pass ?? 0} · 警告 ${counts.warn ?? 0} · 失败 ${counts.fail ?? 0} · 跳过 ${counts.skip ?? 0}
                · 总耗时 ${report.elapsedMs} ms · 后端 ${cpEscape(report.dbBackend)} · 服务端 ${cpEscape(report.serverVersion)}
            </span>
        </div>
        <div class="small mt-1">${cpEscape(report.summary.headline)}</div>`;
    summary.classList.remove('d-none');
}

function setButtonsBusy(busy, mode) {
    const basic = $('cpHealthBasicBtn');
    const deep = $('cpHealthDeepBtn');
    if (basic) basic.disabled = busy;
    if (deep) deep.disabled = busy;
    const hint = $('cpHealthHint');
    if (hint && busy) hint.textContent = mode === 'deep' ? '深度检测执行中（含写入探针，完成后自动删除）…' : '基础检测执行中…';
    if (hint && !busy) hint.textContent = '';
}

async function runChecks(mode) {
    if (running) return;
    running = true;
    setButtonsBusy(true, mode);
    try {
        const report = await fetchHealth(mode);
        lastReport = report;
        renderReport(report);
        cpToast(mode === 'deep' ? '深度检测完成' : '基础检测完成', 'success');
    } catch (error) {
        cpToast(`检测失败：${error.message}`, 'danger');
    } finally {
        running = false;
        setButtonsBusy(false, mode);
    }
}

/** 基础检测入口（顶栏按钮调用） */
export function runHealthChecksBasic() {
    runChecks('basic');
}

/** 深度检测入口：弹窗二次确认（说明将写入临时数据并立即删除）由 HTML 的 modal 承载 */
export function confirmDeepHealth() {
    const modal = $('cpHealthDeepModal');
    if (modal && window.bootstrap) {
        window.bootstrap.Modal.getOrCreateInstance(modal).show();
        return;
    }
    runChecks('deep');
}

export function runDeepConfirmed() {
    const modal = $('cpHealthDeepModal');
    if (modal && window.bootstrap) window.bootstrap.Modal.getOrCreateInstance(modal).hide();
    runChecks('deep');
}

/** 复制诊断报告：纯文本、服务端已脱敏（主机名 / 令牌 / IP 均不出现在报告里） */
export async function copyHealthReport() {
    if (!lastReport) {
        cpToast('请先执行一次检测', 'warning');
        return;
    }
    const lines = [
        `FINAL 部署诊断报告（${lastReport.mode === 'deep' ? '深度' : '基础'}检测）`,
        `时间：${new Date().toISOString()}`,
        `后端：${lastReport.dbBackend} · 服务端版本：${lastReport.serverVersion} · Schema 版本：${lastReport.dbSchemaVersion}`,
        `结论：${lastReport.summary.headline}`,
        '----------------------------------------'
    ];
    for (const item of lastReport.checks) {
        lines.push(`[${item.status.toUpperCase()}] ${item.name}（${item.ms}ms）`);
        if (item.detail) lines.push(`  说明：${item.detail}`);
        if (item.fix) lines.push(`  建议：${item.fix}`);
    }
    lines.push('----------------------------------------');
    lines.push('报告已脱敏：不含令牌与完整数据库地址。');
    await cpCopy(lines.join('\n'), '诊断报告已复制');
}

/** 设备隔离范围选择器：设备清单到达后填充（检测项按需隔离——单台设备独立检测） */
export function populateHealthScope() {
    const selector = $('cpHealthScopeDevice');
    if (!selector) return;
    const current = selector.value;
    const devices = state.stats?.devices || [];
    selector.innerHTML = '<option value="">全部设备</option>' +
        devices.map((device) => {
            const title = [device.username, device.name || device.deviceId].filter(Boolean).join(' · ');
            const short = device.deviceId.startsWith('client:') ? device.deviceId.slice(7) : device.deviceId;
            return `<option value="${cpEscape(device.deviceId)}">${cpEscape(title)}（${cpEscape(short.slice(0, 12))}）</option>`;
        }).join('');
    if ([...selector.options].some((option) => option.value === current)) selector.value = current;
}

/** 初始化：进入设备检测综合视图自动执行基础检测（原「配置检测」页已并入该视图） */
export function initHealthView() {
    document.addEventListener('cp:page', (event) => {
        if (event.detail === 'devices' && !lastReport && !running) runChecks('basic');
    });
    $('cpHealthScopeDevice')?.addEventListener('change', () => {
        lastReport = null;
        runChecks('basic');
    });
}

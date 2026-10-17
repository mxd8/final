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

const STATUS_META = {
    pass: { icon: '✅', badge: 'text-bg-success', label: '通过' },
    warn: { icon: '⚠️', badge: 'text-bg-warning', label: '警告' },
    fail: { icon: '❌', badge: 'text-bg-danger', label: '失败' },
    skip: { icon: '⏭️', badge: 'text-bg-secondary', label: '跳过' }
};

const SUMMARY_BADGE = { pass: 'text-bg-success', warn: 'text-bg-warning', fail: 'text-bg-danger' };
const SUMMARY_TEXT = { pass: '✅ 链路健康', warn: '⚠️ 有警告项', fail: '❌ 存在失败项' };

let lastReport = null;
let running = false;

/** 健康检测请求：GET；深度检测自动附带写令牌（服务端要求） */
async function fetchHealth(mode) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);
    const headers = {};
    const token = getWriteToken();
    if (token) headers.Authorization = `Bearer ${token}`;
    try {
        const response = await fetch(`/api/health?mode=${encodeURIComponent(mode)}`, {
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

function renderReport(report) {
    const list = $('cpHealthList');
    const summary = $('cpHealthSummary');
    if (!list || !summary) return;

    list.innerHTML = report.checks.map(checkItemHtml).join('');
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

/** 初始化：进入配置检测页自动执行基础检测（视图打开即自证） */
export function initHealthView() {
    document.addEventListener('cp:page', (event) => {
        if (event.detail === 'health' && !lastReport && !running) runChecks('basic');
    });
}

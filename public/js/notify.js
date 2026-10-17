/**
 * 全局通知与错误日志：所有接口失败、剪贴板失败都记入 cpErrors，
 * 通知条堆叠追加，每条有自己的倒计时。
 */

import { state, CP_ERROR_LIMIT, CP_TOAST_DEFAULT_MS, CP_TOAST_DURATION } from './config.js';
import { $, cpEscape, cpAttr } from './dom.js';
import { switchPage } from './nav.js';

/** 错误日志条目（全局共用） */
export const cpErrors = [];

function cpNowText() {
    return new Date().toLocaleTimeString('zh-CN', { hour12: false });
}

/** 追加一条错误日志，返回可复制的完整错误文本 */
export function cpLogError(message, extra = {}) {
    const text = String(message || '').trim();
    const detail = extra.detail || '';
    const level = extra.level || 'error';
    cpErrors.unshift({
        at: cpNowText(),
        message: text,
        detail,
        level,
        copy: cpFormatErrorCopy(text, detail, extra.title || '')
    });
    if (cpErrors.length > CP_ERROR_LIMIT) cpErrors.length = CP_ERROR_LIMIT;
    renderErrorLog();
    return cpErrors[0].copy;
}

function cpFormatErrorCopy(message, detail, title = '') {
    const lines = [];
    if (title) lines.push(title);
    lines.push(message);
    if (detail) lines.push(detail);
    return lines.join('\n');
}

/** 只渲染错误条目（不含 info 级记录），头部显示错误数 */
export function renderErrorLog() {
    const body = $('cpErrorLogBody');
    if (!body) return;
    const visible = cpErrors.filter((entry) => entry.level !== 'info');
    const badge = $('cpErrorCount');
    if (badge) badge.textContent = String(visible.length);
    body.dataset.count = String(visible.length);

    if (!visible.length) {
        body.innerHTML = '<div class="text-muted py-2">暂无错误。出问题时会自动出现在这里，点「复制」就能把完整信息发出来。</div>';
        return;
    }
    body.innerHTML = visible
        .map((entry) => {
            const icon = entry.level === 'warning' ? '⚠️' : '❌';
            const detail = entry.detail
                ? `<pre class="cp-error-detail cp-mono mb-1">${cpEscape(entry.detail)}</pre>`
                : '';
            return `
        <div class="cp-error-item ${entry.level === 'warning' ? 'border-warning' : 'border-danger'}">
            <div class="d-flex align-items-start gap-2">
                <span>${icon}</span>
                <div class="flex-grow-1">
                    <span class="cp-error-time text-muted">${cpEscape(entry.at)}</span>
                    <span class="d-block">${cpEscape(entry.message)}</span>
                    ${detail}
                </div>
                <button type="button" class="btn btn-sm btn-outline-secondary cp-copy-btn"
                        data-copy="${cpAttr(entry.copy)}" title="复制这条错误的完整信息">📋 复制</button>
            </div>
        </div>`;
        })
        .join('');
}

/**
 * 全局通知。第二个参数可以是 Bootstrap 变体字符串，也可以是对象
 * { level, detail, title, action, actionText }；level 为 danger / error 时
 * 同时写入全局错误日志并附带「复制错误」入口。
 */
export function cpToast(message, variant = 'secondary') {
    const options = typeof variant === 'object' && variant !== null ? variant : {};
    const level = String(options.level || variant || 'secondary');
    const text = String(options.text ?? message ?? '').trim();
    if (!text) return;

    const isError = level === 'danger' || level === 'error';
    const detail = String(options.detail || '');
    const duration = CP_TOAST_DURATION[level] || CP_TOAST_DEFAULT_MS;

    const logCopy = isError
        ? cpLogError(text, { detail, title: options.title, level: level === 'error' ? 'error' : 'warning' })
        : '';

    const toastId = `cp-toast-${++cpToastSeq}`;
    const container = $('toastContainer');
    if (!container) return;

    container.insertAdjacentHTML('beforeend', toastHtml({ toastId, text, level, isError, detail, logCopy, options }));

    setTimeout(() => {
        const node = $(toastId);
        if (node) node.remove();
    }, duration);
}

let cpToastSeq = 1;

function toastHtml({ toastId, text, level, isError, detail, logCopy, options }) {
    const detailsBlock = isError && detail
        ? `<div class="cp-toast-details">
               <button type="button" class="btn btn-link btn-sm p-0 text-decoration-none" data-toggle-details="${cpAttr(toastId)}">展开详情 ▾</button>
               <pre class="cp-error-detail cp-mono d-none mt-1 mb-0">${cpEscape(detail)}</pre>
           </div>`
        : '';

    const actions = [];
    if (logCopy) {
        actions.push(`<button type="button" class="btn btn-sm btn-outline-primary cp-copy-btn" data-copy="${cpAttr(logCopy)}">📋 复制错误</button>`);
        actions.push('<button type="button" class="btn btn-sm btn-outline-secondary" onclick="capturePanel.openErrorLog()">📄 查看日志</button>');
    }
    if (options.action && options.actionText) {
        actions.push(`<button type="button" class="btn btn-sm btn-outline-warning" onclick="${options.action}">${cpEscape(options.actionText)}</button>`);
    }
    const actionRow = actions.length
        ? `<div class="d-flex flex-wrap gap-2 mt-2">${actions.join('')}</div>`
        : '';

    return `
        <div class="alert alert-${isError ? 'danger' : level} shadow-sm mb-0 cp-toast" id="${cpAttr(toastId)}"
             role="alert" aria-live="assertive">
            <div class="d-flex justify-content-between align-items-start gap-2">
                <div class="flex-grow-1">
                    ${cpEscape(text)}
                    ${detailsBlock}
                </div>
                <button type="button" class="btn-close" data-dismiss-toast="${cpAttr(toastId)}" aria-label="关闭"></button>
            </div>
            ${actionRow}
        </div>`;
}

/** 打开错误日志区域（由通知里的「查看日志」入口调用） */
export function openErrorLog() {
    switchPage('data');
    const card = $('cpErrorLogCard');
    if (card && !card.hidden) {
        card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } else if (card) {
        card.hidden = false;
    }
}

/** 忙碌态：批量覆盖与订阅解析共用一把锁，并发写会把同一批记录写乱 */
export function cpSetBusy(busy) {
    state.busy = busy;
    for (const id of ['cpBatchBtn', 'cpSubParseBtn']) {
        const button = $(id);
        if (!button) continue;
        button.disabled = busy;
        const spinner = button.querySelector('.spinner-border');
        if (spinner) spinner.classList.toggle('d-none', !busy);
    }
}

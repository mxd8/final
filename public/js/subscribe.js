/**
 * 订阅解析弹窗：URL 多行粘贴、受控并发抓取、进度反馈与已保存订阅管理。
 */

import { state, CP_SUBSCRIBE_CONCURRENCY, CP_CONFIG } from './config.js';
import { $, cpEscape, cpOnQuote, formatTime, hostFromUrl } from './dom.js';
import { cpToast, cpSetBusy } from './notify.js';
import { cpRequest } from './api.js';

/** 打开订阅解析弹窗：每次都重新拉一次列表，保证刚保存的订阅能看到 */
export async function openSubscribeModal() {
    const modal = $('cpSubModal');
    modal.hidden = false;
    window.bootstrap.Modal.getOrCreateInstance(modal).show();
    await loadSubscriptions();
}

export async function loadSubscriptions() {
    if (state.subscriptionsLoading) return;
    state.subscriptionsLoading = true;
    try {
        const data = await cpRequest('/api/subscribe', '/');
        state.subscriptions = data.data || [];
        renderSubscriptionList();
        renderSubscriptionPicker();
    } catch (error) {
        console.warn('[subscribe] 列表加载失败', error.message);
        const list = $('cpSubList');
        if (list) list.innerHTML = `<div class="text-danger">订阅列表加载失败：${cpEscape(error.message)}</div>`;
    } finally {
        state.subscriptionsLoading = false;
    }
}

/** 渲染订阅弹窗里的清单 */
function renderSubscriptionList() {
    const list = $('cpSubList');
    if (!list) return;
    if (!state.subscriptions.length) {
        list.innerHTML = '<div class="text-muted">还没有保存任何订阅。</div>';
        return;
    }
    list.innerHTML = state.subscriptions.map(subscriptionItemHtml).join('');
}

function subscriptionItemHtml(item) {
    const meta = [];
    if (item.ruleCount) meta.push(`${item.ruleCount} 条规则`);
    if (item.lastFetchedAt) meta.push(`抓于 ${cpEscape(formatTime(item.lastFetchedAt))}`);
    if (item.lastStatus && !item.lastStatus.startsWith('failed')) meta.push('状态正常');
    if (item.lastStatus && item.lastStatus.startsWith('failed')) {
        meta.push(`<span class="text-danger">${cpEscape(item.lastStatus.slice(0, 80))}</span>`);
    }
    return `
        <div class="cp-sub-item">
            <div class="cp-sub-item-info">
                <strong>${cpEscape(item.name || '未命名订阅')}</strong><br>
                <span class="text-muted">${cpEscape(item.url)}</span>
                ${meta.length ? `<br><small class="text-muted">${meta.join(' · ')}</small>` : ''}
            </div>
            <div class="cp-sub-item-actions">
                <button type="button" class="btn btn-sm btn-outline-primary"
                        onclick="capturePanel.reparseSubscription('${cpOnQuote(item.id)}')">🔄 重新解析</button>
                <button type="button" class="btn btn-sm btn-outline-danger"
                        onclick="capturePanel.deleteSubscription('${cpOnQuote(item.id)}')">🗑️ 删除</button>
            </div>
        </div>`;
}

/** 同步批量覆盖卡顶部的「从订阅填充」下拉框 */
function renderSubscriptionPicker() {
    const select = $('cpSubPicker');
    const fillBtn = $('cpSubFillBtn');
    if (!select) return;
    if (!state.subscriptions.length) {
        select.innerHTML = '<option value="">尚未保存任何订阅</option>';
        if (fillBtn) fillBtn.disabled = true;
        return;
    }
    select.innerHTML = '<option value="">选择已保存的订阅…</option>' +
        state.subscriptions
            .map((item) => `<option value="${cpOnQuote(item.id)}">${cpEscape(item.name || item.url)}（${item.ruleCount || '?'} 条）</option>`)
            .join('');
    if (fillBtn) fillBtn.disabled = false;
}

export function clearSubInput() {
    $('cpSubUrlInput').value = '';
    $('cpSubParseInfo').textContent = '尚未开始';
    hideSubProgress();
}

function showSubProgress(current, total) {
    const bar = $('cpSubProgress');
    if (!bar) return;
    bar.classList.remove('d-none');
    const percent = total > 0 ? Math.round((current / total) * 100) : 0;
    bar.setAttribute('aria-valuenow', String(percent));
    const inner = bar.querySelector('.progress-bar');
    if (inner) inner.style.width = `${percent}%`;
    const info = $('cpSubParseInfo');
    if (info) info.textContent = `正在解析 ${current}/${total}…`;
}

function hideSubProgress() {
    const bar = $('cpSubProgress');
    if (bar) bar.classList.add('d-none');
}

/** 受控并发执行：同时最多跑 limit 个任务，单项失败不影响其余 */
async function runWithConcurrency(items, limit, task) {
    const results = new Array(items.length);
    let cursor = 0;
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (cursor < items.length) {
            const index = cursor;
            cursor += 1;
            try {
                results[index] = await task(items[index], index);
            } catch (error) {
                results[index] = { error: error.message || String(error) };
            }
        }
    });
    await Promise.all(workers);
    return results;
}

function readSubUrlInput() {
    return $('cpSubUrlInput').value
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);
}

/** 汇总批量解析结果：单条失败不中断整批，坏链接只是坏链接 */
async function saveParsedSubscription(result) {
    if (!result || result.error) return;
    const url = result.data.url || result.url;
    await cpRequest('/api/subscribe', '/save', {
        method: 'POST',
        body: { url, name: hostFromUrl(url) }
    }).catch(() => {});
}

function summarizeParseResults(results) {
    let saved = 0;
    let failed = 0;
    let rules = 0;
    for (const result of results) {
        if (!result) continue;
        if (result.error) {
            failed += 1;
            continue;
        }
        saved += 1;
        rules += Number(result.data.count) || 0;
    }
    return { saved, failed, rules };
}

/** 批量解析订阅链接：并发抓取 → 存 URL → 汇总结果 */
export async function parseSubscriptions() {
    if (state.busy) return;
    const urls = readSubUrlInput();
    if (!urls.length) {
        cpToast('请先填写至少一条订阅链接', 'warning');
        $('cpSubUrlInput').focus();
        return;
    }

    cpSetBusy(true);
    showSubProgress(0, urls.length);
    let done = 0;
    try {
        const results = await runWithConcurrency(urls, CP_SUBSCRIBE_CONCURRENCY, async (url) => {
            const data = await cpRequest('/api/subscribe', '/parse', {
                method: 'POST',
                body: { url },
                timeoutMs: CP_CONFIG.parseTimeoutMs
            });
            done += 1;
            showSubProgress(done, urls.length);
            return { url, ok: true, data: data.data || {} };
        });

        for (const result of results) {
            await saveParsedSubscription(result);
        }
        const { saved, failed, rules } = summarizeParseResults(results);

        const info = $('cpSubParseInfo');
        if (info) info.textContent = `完成：成功 ${saved} 条，失败 ${failed} 条，共提取 ${rules} 行规则`;
        if (failed > 0) {
            const reason = results.find((item) => item && item.error)?.error || '未知原因';
            cpToast(`解析完成，但有 ${failed} 条失败（如：${reason}），其余已保存`, 'warning');
        } else {
            cpToast(`解析完成：保存 ${saved} 条订阅，共 ${rules} 行规则`, 'success');
        }
        await loadSubscriptions();
    } catch (error) {
        cpToast(`订阅解析失败：${error.message}`, 'danger');
    } finally {
        cpSetBusy(false);
        hideSubProgress();
    }
}

/** 重新解析已保存的订阅 */
export async function reparseSubscription(id) {
    if (state.busy) return;
    const item = state.subscriptions.find((entry) => String(entry.id) === String(id));
    if (!item) return;
    cpSetBusy(true);
    showSubProgress(0, 1);
    try {
        const data = await cpRequest('/api/subscribe', '/parse', {
            method: 'POST',
            body: { url: item.url },
            timeoutMs: CP_CONFIG.parseTimeoutMs
        });
        showSubProgress(1, 1);
        const parsed = data.data || {};
        cpToast(`已重新解析「${item.name || item.url}」：${parsed.count || 0} 行规则`, 'success');
        await loadSubscriptions();
    } catch (error) {
        cpToast(`重新解析失败：${error.message}`, 'danger');
    } finally {
        cpSetBusy(false);
        hideSubProgress();
    }
}

/** 删除已保存的订阅：只删除地址，不影响已入库的规则 */
export async function deleteSubscription(id) {
    if (state.busy) return;
    const item = state.subscriptions.find((entry) => String(entry.id) === String(id));
    if (!item) return;
    if (!window.confirm(`确定要删除订阅「${item.name || item.url}」吗？只删除地址，不影响已入库的规则。`)) return;

    cpSetBusy(true);
    try {
        await cpRequest('/api/subscribe', '/delete', { method: 'POST', body: { id: item.id } });
        cpToast('订阅已删除', 'success');
        await loadSubscriptions();
    } catch (error) {
        cpToast(`删除失败：${error.message}`, 'danger');
    } finally {
        cpSetBusy(false);
    }
}

/**
 * 危险与批量操作：删除单条、清理空备注、一键清空、降维排除。
 * 降维的候选计算在 levels.js，展示在快速编辑弹窗里（edit.js）。
 */

import { state } from './config.js';
import { $ } from './dom.js';
import { cpToast, cpSetBusy } from './notify.js';
import { cpRequest } from './api.js';
import { cpRefreshAll } from './refresh.js';
import { refreshEditingUi, clearBatchText, closeQuickEdit } from './edit.js';

export async function deleteLog(hostname) {
    if (!window.confirm(`确定要删除这条规则吗？\n${hostname}`)) return;
    if (state.busy) return;
    cpSetBusy(true);
    try {
        await cpRequest('/api/logger', '/delete', { method: 'POST', body: { hostname } });
        if (state.editing === hostname) {
            state.editing = null;
            refreshEditingUi();
        }
        cpToast('规则已删除', 'success');
        await cpRefreshAll();
    } catch (error) {
        cpToast(`删除失败：${error.message}`, 'danger');
    } finally {
        cpSetBusy(false);
    }
}

/** 只删除备注为空的记录 */
export async function clearEmpty() {
    if (!window.confirm('确定要删除所有备注为空的规则吗？有备注的记录将被保留。')) return;
    if (state.busy) return;
    cpSetBusy(true);
    try {
        const data = await cpRequest('/api/logger', '/clear-empty', { method: 'POST', body: {} });
        cpToast(`已删除 ${data.data?.deleted || 0} 条空备注规则`, 'success');
        await cpRefreshAll();
    } catch (error) {
        cpToast(`清理失败：${error.message}`, 'danger');
    } finally {
        cpSetBusy(false);
    }
}

/** 打开清空确认弹窗：需要先输入 CLEAR 才解锁按钮 */
export function wipeDatabase() {
    $('cpWipeCount').textContent = String(state.stats?.totalRules ?? state.logs.length ?? 0);
    $('cpWipeInput').value = '';
    $('cpWipeConfirmBtn').disabled = true;
    const modal = $('cpWipeModal');
    modal.hidden = false;
    window.bootstrap.Modal.getOrCreateInstance(modal).show();
    setTimeout(() => $('cpWipeInput').focus(), 250);
}

export function onWipeInput() {
    $('cpWipeConfirmBtn').disabled = $('cpWipeInput').value.trim().toUpperCase() !== 'CLEAR';
}

/** 二次确认后真正清空：删除全部记录并重置自增 ID */
export async function confirmWipe() {
    if ($('cpWipeInput').value.trim().toUpperCase() !== 'CLEAR') return;
    const modal = $('cpWipeModal');
    window.bootstrap.Modal.getOrCreateInstance(modal).hide();

    if (state.busy) return;
    cpSetBusy(true);
    try {
        const data = await cpRequest('/api/logger', '/clear', { method: 'POST', body: { confirm: true } });
        cpToast(`已清空 ${data.data?.deleted || 0} 条规则，自增 ID 已重置`, 'success');
        state.editing = null;
        refreshEditingUi();
        clearBatchText();
        await cpRefreshAll();
    } catch (error) {
        cpToast(`清空失败：${error.message}`, 'danger');
    } finally {
        cpSetBusy(false);
    }
}

/** 降维：把一组同类记录合并成一条更粗的规则，来源沿用被降维记录的来源 */
export async function reduceExclude(target, policy) {
    if (state.busy) return;
    const item = state.logs.find((entry) => entry.hostname === target) || {};
    cpSetBusy(true);
    try {
        const data = await cpRequest('/api/logger', '/exclude', {
            method: 'POST',
            body: { target, policy, source: item.source || '' }
        });
        const result = data.data || {};
        cpToast(`降维排除成功：${target}（删除 ${result.deleted || 0} 条，汇总 ${result.created ? '新增' : '更新'} 1 条）`, 'success');
        await cpRefreshAll();
        if (state.policyFilter !== 'ALL' && state.policyFilter !== String(policy).toUpperCase()) {
            cpToast(`汇总行策略为 ${policy}，与当前策略筛选「${state.policyFilter}」不一致，切回全部策略即可看到`, 'info');
        }
    } catch (error) {
        cpToast(`降维失败：${error.message}`, 'danger');
    } finally {
        cpSetBusy(false);
        // 降维成功即收起快速编辑窗：候选就内联在这个弹窗里，刷新后这条规则已被合并掉
        closeQuickEdit();
    }
}


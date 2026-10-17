/**
 * 规则编辑：表格「编辑」弹快速编辑窗（保存即生效），
 * 快速编辑窗内联列出降维候选（点一下直接降维，不弹二级窗），
 * 批量文本框负责粘贴 / 订阅填充后的逐行覆盖提交。
 */

import { state, CP_CONFIG, CP_BUILTIN_POLICIES } from './config.js';
import { $, hostFromUrl, cpAttr, cpEscape, cpOnQuote, formatTime } from './dom.js';
import { cpToast, cpSetBusy } from './notify.js';
import { cpRequest, ensureAllLogs } from './api.js';
import { buildRuleLine, cpParseRuleLine, cpLooksLikeRule } from './ruletext.js';
import { cpLevelCandidates } from './levels.js';
import { renderLogList, cpVisibleLogs } from './render.js';
import { cpRefreshAll } from './refresh.js';
import { hostInCidr, parseIpTarget } from './ipnet.js';

/* ------------------------------------------------ 单条快速编辑弹窗 */

let quickEditHostname = '';
let quickEditWired = false;

const CP_QUICK_TYPE_FALLBACK = [
    'DOMAIN-SUFFIX', 'DOMAIN', 'DOMAIN-KEYWORD', 'IP-CIDR', 'IP-CIDR6',
    'PROCESS-NAME', 'GEOIP', 'URL-REGEX', 'FINAL'
];

/** 表格「编辑」入口：按 hostname 定位规则并弹出快速编辑窗 */
export function openQuickEdit(hostname) {
    const item = state.allLogs.find((entry) => entry.hostname === hostname)
        || state.logs.find((entry) => entry.hostname === hostname);
    if (!item) {
        cpToast('规则不存在或已被删除，请刷新后重试', 'warning');
        return;
    }
    quickEditHostname = String(hostname);
    fillQuickEditForm(item);
    fillQuickEditDatalists();
    renderQuickLevels(item);
    // 全量列表按需加载：过期时后台补拉，回来后若弹窗还开着就刷新候选统计与策略候选
    ensureAllLogs()
        .then(() => {
            if (quickEditHostname !== String(hostname)) return;
            const fresh = state.allLogs.find((entry) => entry.hostname === hostname) || item;
            fillQuickEditDatalists();
            renderQuickLevels(fresh);
        })
        .catch(() => {});
    wireQuickEditOnce();
    window.bootstrap.Modal.getOrCreateInstance($('cpQuickEditModal')).show();
}

/** 当前快速编辑窗针对的规则（弹窗内降维候选、底部「删除」按钮用） */
export function quickEditTarget() {
    return quickEditHostname;
}

/** 收起快速编辑窗：降维成功 / 删除后由 actions.js 调，避免再弹二级窗 */
export function closeQuickEdit() {
    window.bootstrap.Modal.getOrCreateInstance($('cpQuickEditModal')).hide();
}

/**
 * 按候选目标统计匹配记录数与总触发次数：域名按后缀，IP/CIDR 按网段包含。
 * 一趟遍历同时统计全部候选，避免「候选数 × 全量行数」的重复扫描。
 */
function cpMatchedCounts(targets) {
    const specs = targets.map((target) => ({ target, parsed: parseIpTarget(target), records: 0, hits: 0 }));
    const byTarget = new Map(specs.map((spec) => [spec.target, spec]));
    const rows = state.allLogs.length ? state.allLogs : state.logs;
    for (const item of rows) {
        const host = String(item.hostname || '');
        if (!host) continue;
        for (const spec of specs) {
            const hit = spec.parsed ? hostInCidr(host, spec.parsed) : (host === spec.target || host.endsWith(`.${spec.target}`));
            if (hit) {
                spec.records += 1;
                spec.hits += Number(item.count) || 1;
            }
        }
    }
    return byTarget;
}

/**
 * 内联渲染降维候选：把「合并同类记录」的更粗粒度层级直接列在编辑窗里。
 * 之前这里要点「降维」再弹二级窗，现在一次性看完即可点「降维排除」。
 */
function renderQuickLevels(item) {
    const list = $('cpQuickLevelList');
    if (!list) return;
    list.innerHTML = '';
    const value = item.value || item.hostname;
    if (!value) {
        list.innerHTML = '<div class="cp-level-item"><small>无法降维：规则值缺失。</small></div>';
        return;
    }
    const candidates = cpLevelCandidates(value, item.policy || 'PROXY');
    if (!candidates.length) {
        list.innerHTML = '<div class="cp-level-item"><small>没有可降维的层级：当前值已是最粗粒度，或不是可识别的域名 / IP。</small></div>';
        return;
    }
    const counts = cpMatchedCounts(candidates.map((candidate) => candidate.target));
    for (const candidate of candidates) {
        const { records, hits } = counts.get(candidate.target);
        const row = document.createElement('div');
        row.className = 'cp-level-item';
        row.innerHTML = `
            <div class="cp-level-info">
                <strong>${cpEscape(candidate.ruleText)}</strong><br>
                <small>🔥 匹配 ${records} 条记录（共 ${hits} 次触发）</small>
            </div>
            <button type="button" class="btn btn-sm btn-success"
                    onclick="capturePanel.reduceExclude('${cpOnQuote(candidate.target)}', '${cpOnQuote(item.policy || 'PROXY')}')">降维排除</button>`;
        list.appendChild(row);
    }
}

/** 弹窗字段回填：参数对象展开成「name=value」逗号文本，只读信息放底部 */
function fillQuickEditForm(item) {
    $('cpQuickType').value = String(item.type || 'DOMAIN-SUFFIX');
    $('cpQuickValue').value = String(item.value ?? item.hostname ?? '');
    $('cpQuickPolicy').value = String(item.policy || 'PROXY');
    $('cpQuickParams').value = Object.entries(item.params || {})
        .map(([name, raw]) => (raw == null || raw === '' ? name : `${name}=${raw}`))
        .join(',');
    $('cpQuickComment').value = String(item.comment || '');
    $('cpQuickMeta').textContent =
        `📱 来源：${item.source || '—'} · 🔥 命中 ${Number(item.count) || 1} 次 · 最近命中 ${formatTime(item.time)}`;
}

/** 类型与策略候选：类型用后端 meta 的真实分布，策略 = 内置 + 现有规则里的自定义组。
  * 策略列表优先取 stats 聚合结果，避免为下拉框扫描全量规则。
  */
function fillQuickEditDatalists() {
    const types = state.meta?.ruleTypes?.length ? state.meta.ruleTypes : CP_QUICK_TYPE_FALLBACK;
    $('cpQuickTypeList').innerHTML = types.map((type) => `<option value="${cpAttr(type)}">`).join('');
    const policies = new Set(CP_BUILTIN_POLICIES);
    for (const policy of state.stats?.policies || []) {
        if (policy) policies.add(String(policy));
    }
    if (!state.stats?.policies?.length) {
        for (const entry of state.allLogs.length ? state.allLogs : state.logs) {
            if (entry.policy) policies.add(String(entry.policy));
        }
    }
    $('cpQuickPolicyList').innerHTML = [...policies].map((policy) => `<option value="${cpAttr(policy)}">`).join('');
}

/** 弹窗内 Enter = 保存；只绑一次（modal 复用同一个 DOM） */
function wireQuickEditOnce() {
    if (quickEditWired) return;
    quickEditWired = true;
    for (const id of ['cpQuickType', 'cpQuickValue', 'cpQuickPolicy', 'cpQuickParams', 'cpQuickComment']) {
        $(id).addEventListener('keydown', (event) => {
            if (event.key === 'Enter') {
                event.preventDefault();
                saveQuickEdit();
            }
        });
    }
}

/** 参数文本 → params 对象：借道规则行解析器，与后端切分语义保持一致 */
function parseParamsText(text) {
    const clean = String(text ?? '').trim();
    if (!clean) return {};
    return cpParseRuleLine(`DOMAIN,placeholder,PROXY,${clean}`)?.params ?? {};
}

/** 收集弹窗表单；返回 null 表示校验失败（已 toast 提示） */
function readQuickEditForm() {
    const type = $('cpQuickType').value.trim();
    const value = String($('cpQuickValue').value).trim();
    if (!type) {
        cpToast('类型不能为空', 'warning');
        return null;
    }
    if (type.toUpperCase() !== 'FINAL' && !value) {
        cpToast('匹配值不能为空（FINAL 类型除外）', 'warning');
        $('cpQuickValue').focus();
        return null;
    }
    return {
        hostname: quickEditHostname,
        type,
        value: type.toUpperCase() === 'FINAL' ? '' : value,
        policy: $('cpQuickPolicy').value.trim() || 'PROXY',
        params: parseParamsText($('cpQuickParams').value),
        comment: $('cpQuickComment').value.trim()
    };
}

/** 保存快速编辑：/update 字段级更新，改匹配值由后端换主键并保留命中计数 */
export async function saveQuickEdit() {
    if (state.busy || !quickEditHostname) return;
    const body = readQuickEditForm();
    if (!body) return;

    cpSetBusy(true);
    try {
        const data = await cpRequest(CP_CONFIG.apiBase, '/update', { method: 'POST', body });
        const result = data.data || {};
        const notes = [];
        if (result.renamed) notes.push('匹配值已变更，命中计数已保留');
        if (result.repaired) notes.push('字段已按 Surge 规范修正');
        cpToast(`规则已更新并生效${notes.length ? `（${notes.join('，')}）` : ''}`, 'success');
        window.bootstrap.Modal.getOrCreateInstance($('cpQuickEditModal')).hide();
        await cpRefreshAll();
    } catch (error) {
        cpToast(`保存失败：${error.message}`, 'danger');
    } finally {
        cpSetBusy(false);
    }
}

/** 取消编辑：只退出编辑态并去掉表格高亮，不清空编辑框 */
export function cancelEdit() {
    if (!state.editing) return;
    state.editing = null;
    refreshEditingUi();
    renderLogList();
    cpToast('已退出编辑状态', 'secondary');
}

/** 编辑态 UI：显示/隐藏「取消编辑」按钮，并同步批量按钮文案 */
export function refreshEditingUi() {
    const cancelBtn = $('cpCancelEditBtn');
    if (cancelBtn) cancelBtn.classList.toggle('d-none', !state.editing);
    const btnText = $('cpBatchBtnText');
    if (btnText) btnText.textContent = state.editing ? '⚡ 保存这条修改' : '⚡ 执行逐行覆盖';
}

/** 把当前筛选结果的整页规则写回批量文本框 */
export function fillTextareaFromTable() {
    const visible = cpVisibleLogs();
    if (!visible.length) {
        cpToast('当前筛选下没有规则可写入', 'warning');
        return;
    }
    const pageItems = visible.slice((state.currentPage - 1) * state.pageSize, state.currentPage * state.pageSize);
    $('cpBatchTextarea').value = pageItems.map((item) => buildRuleLine(item)).join('\n');
    updateBatchParseInfo();
    $('cpBatchTextarea').scrollIntoView({ behavior: 'smooth', block: 'center' });
}

export function clearBatchText() {
    $('cpBatchTextarea').value = '';
    updateBatchParseInfo();
}

/** 统计文本框里有多少行、其中多少行看起来是规则 */
export function updateBatchParseInfo() {
    const info = $('batchParseInfo');
    if (!info) return;
    const lines = $('cpBatchTextarea').value.split('\n').map((line) => line.trim()).filter(Boolean);
    if (!lines.length) {
        info.textContent = '尚未粘贴规则';
        return;
    }
    const rules = lines.filter(cpLooksLikeRule).length;
    info.textContent = rules === lines.length
        ? `共 ${lines.length} 行，每行一条规则`
        : `共 ${lines.length} 行，其中 ${rules} 行可识别为规则`;
}

/** 执行逐行覆盖：override 模式下备注与来源一律按框里内容写入（空串即清空） */
export async function batchOverride() {
    if (state.busy) return;
    const rawText = $('cpBatchTextarea').value.trim();
    if (!rawText) {
        cpToast('请先粘贴或载入要覆盖的规则', 'warning');
        $('cpBatchTextarea').focus();
        return;
    }

    const preserveFrom = state.editing || '';
    cpSetBusy(true);
    try {
        const data = await cpRequest(CP_CONFIG.apiBase, '/batch', {
            method: 'POST',
            body: { text: rawText, mode: 'override', preserveFrom }
        });
        const result = data.data || {};
        const parts = [`影响 ${result.updated || 0} 行`, `新增 ${result.created || 0} 行`];
        if (Number(result.skipped) > 0) parts.push(`${result.skipped} 行无法解析`);
        if (result.preserved) parts.push('已继承原有命中计数');
        cpToast(`批量覆盖完成：${parts.join('，')}`, 'success');
        state.editing = null;
        refreshEditingUi();
        clearBatchText();
        await cpRefreshAll();
    } catch (error) {
        cpToast(`批量覆盖失败：${error.message}`, 'danger');
    } finally {
        cpSetBusy(false);
    }
}

/** 全量规则建立「匹配值 → 记录」索引，供填充时判断重复（按需加载，过期自动重拉） */
async function buildKnownValueMap() {
    const known = new Map();
    for (const entry of await ensureAllLogs()) {
        known.set(String(entry.value || entry.hostname || '').toLowerCase(), entry);
    }
    return known;
}

/**
 * 把选中的订阅结果填进批量编辑框。
 * 只追加来源注释，不改动已有规则的策略：订阅内容来自第三方，
 * 直接按它的策略覆盖本地，会把用户手工调好的分流改坏。
 */
export async function fillFromSubscription() {
    if (state.busy) return;
    const select = $('cpSubPicker');
    const item = state.subscriptions.find((entry) => String(entry.id) === String(select.value));
    if (!item) {
        cpToast('请先选择一个订阅', 'warning');
        return;
    }

    cpSetBusy(true);
    try {
        const data = await cpRequest(CP_CONFIG.subscribeBase, '/parse', { method: 'POST', body: { url: item.url } });
        const parsed = data.data || {};
        const lines = Array.isArray(parsed.lines) ? parsed.lines : [];
        if (!lines.length) {
            cpToast('这个订阅没有解析出任何规则', 'warning');
            return;
        }

        // 重复判定必须用全量规则：state.logs 是当前筛选后的子集
        const known = await buildKnownValueMap();
        const sourceName = item.name || hostFromUrl(item.url);
        const existing = $('cpBatchTextarea').value.trim();
        const merged = mergeKnownLines(lines, known, sourceName);

        $('cpBatchTextarea').value = existing ? `${existing}\n${merged.join('\n')}` : merged.join('\n');
        updateBatchParseInfo();
        const duplicates = merged.filter((line) => line.includes(`// 来源：${sourceName}`)).length;
        cpToast(
            `已从「${sourceName}」填入 ${merged.length} 行，其中 ${duplicates} 行与已有规则重复（已标注来源，未改动策略）`,
            duplicates > 0 ? 'info' : 'success'
        );
        $('cpBatchTextarea').scrollIntoView({ behavior: 'smooth', block: 'center' });
    } catch (error) {
        cpToast(`填充失败：${error.message}`, 'danger');
    } finally {
        cpSetBusy(false);
    }
}

/** 重复匹配值只加来源注释；新规则原样填入，策略保持订阅里的样子 */
function mergeKnownLines(lines, known, sourceName) {
    return lines.map((line) => {
        const parsedLine = cpParseRuleLine(line);
        const key = String(parsedLine?.value || '').toLowerCase();
        if (key && known.has(key)) return `${line} // 来源：${sourceName}`;
        return line;
    });
}

/**
 * AI 配置页逻辑：Workers AI 连接配置、自动化调度设置、队列状态与前端调度器。
 *
 * 调度为双通道之一：面板打开期间每分钟检查一次「全局开关 + 执行周期」，
 * 到期就循环调用 POST /api/ai/run 消化队列（一批 = 单次查询数量）；
 * 另一通道是外部定时器直接打同一端点（端点内置冷却 + 单飞守卫，不会重复触发）。
 */

import { CP_CONFIG } from './config.js';
import { $ } from './dom.js';
import { cpToast } from './notify.js';
import { cpRequest } from './api.js';

const AI_BASE = CP_CONFIG.aiBase;
const SCHEDULER_TICK_MS = 60000;
/** 一次消化最多连续跑多少批：防止超大队列把页面请求挂太久 */
const MAX_BATCHES_PER_DRAIN = 10;
const RUN_TIMEOUT_MS = CP_CONFIG.aiRunTimeoutMs;

/** 服务端配置镜像（token 只有掩码，原文不会回到浏览器） */
let cachedConfig = null;
let configLoaded = false;
/** 前端调度器的下次触发时间戳（ms）；0 = 立即可跑 */
let nextDueAt = 0;
/** 队列消化中标记：防按钮连点与调度 tick 重入 */
let draining = false;

function setConnStatus(text) {
    const el = $('cpAiConnStatus');
    if (el) el.textContent = text;
}

function setScheduleStatus(text) {
    const el = $('cpAiScheduleStatus');
    if (el) el.textContent = text;
}

/** 服务端配置 → 页面控件 */
function applyConfigToControls(config) {
    if (!config) return;
    $('cpAiAccountId').value = config.cfAccountId || '';
    $('cpAiModel').value = config.model || '';
    $('cpAiEnabled').checked = Boolean(config.enabled);
    $('cpAiBatchSize').value = String(config.batchSize ?? 10);
    $('cpAiDelay').value = String(config.requestDelayMs ?? 1000);
    $('cpAiOnlyUnclassified').checked = Boolean(config.onlyUnclassified);
    $('cpAiFillComment').checked = Boolean(config.fillComment);
    $('cpAiPriorityEdited').checked = Boolean(config.priorityEdited);

    const intervalSelect = $('cpAiInterval');
    const customWrap = $('cpAiIntervalCustomWrap');
    const preset = String(config.intervalMinutes ?? 360);
    if ([...intervalSelect.options].some((option) => option.value === preset)) {
        intervalSelect.value = preset;
        customWrap.hidden = true;
    } else {
        intervalSelect.value = 'custom';
        customWrap.hidden = false;
        $('cpAiIntervalCustom').value = preset;
    }
    if (config.hasToken) setConnStatus(`Token 已配置（${config.tokenMask}）`);
}

/** 页面控件 → 提交体；token 输入框为空 = 不修改 */
function readConnectionFromBody() {
    const body = {
        cfAccountId: $('cpAiAccountId').value.trim(),
        model: $('cpAiModel').value.trim()
    };
    const token = $('cpAiToken').value.trim();
    if (token) body.cfApiToken = token;
    return body;
}

function readScheduleFromBody() {
    const intervalSelect = $('cpAiInterval').value;
    const intervalMinutes = intervalSelect === 'custom'
        ? Number($('cpAiIntervalCustom').value)
        : Number(intervalSelect);
    return {
        enabled: $('cpAiEnabled').checked,
        intervalMinutes: Number.isFinite(intervalMinutes) ? intervalMinutes : 360,
        batchSize: Number($('cpAiBatchSize').value),
        requestDelayMs: Number($('cpAiDelay').value),
        onlyUnclassified: $('cpAiOnlyUnclassified').checked,
        fillComment: $('cpAiFillComment').checked,
        priorityEdited: $('cpAiPriorityEdited').checked
    };
}

/** 拉取服务端配置并回填控件；重复调用走缓存，force 强制刷新 */
export async function aiLoadConfig(force = false) {
    if (configLoaded && !force) return cachedConfig;
    try {
        const data = await cpRequest(AI_BASE, '/config');
        cachedConfig = data.data || null;
        configLoaded = true;
        applyConfigToControls(cachedConfig);
    } catch (error) {
        console.warn('[ai] 配置加载失败', error.message);
    }
    return cachedConfig;
}

/** 保存连接配置（Account ID / Token / 模型） */
export async function aiSaveConnection() {
    try {
        const data = await cpRequest(AI_BASE, '/config', { method: 'POST', body: readConnectionFromBody() });
        cachedConfig = data.data;
        configLoaded = true;
        applyConfigToControls(cachedConfig);
        $('cpAiToken').value = '';
        setConnStatus(`✅ 已保存${cachedConfig.hasToken ? `（Token ${cachedConfig.tokenMask}）` : '（尚未配置 Token）'}`);
        cpToast('连接配置已保存', 'success');
    } catch (error) {
        cpToast(`保存失败：${error.message}`, 'danger');
    }
}

/** 保存调度设置（开关 / 周期 / 批量 / 筛选） */
export async function aiSaveSchedule() {
    try {
        const data = await cpRequest(AI_BASE, '/config', { method: 'POST', body: readScheduleFromBody() });
        cachedConfig = data.data;
        configLoaded = true;
        applyConfigToControls(cachedConfig);
        setScheduleStatus('✅ 已保存');
        // 改了周期或开关：让前端调度器按新配置重新计时
        nextDueAt = Date.now() + (cachedConfig.intervalMinutes || 360) * 60000;
        cpToast(`调度设置已保存（${cachedConfig.enabled ? '已开启' : '已暂停'}）`, 'success');
        aiRefreshStatus();
    } catch (error) {
        cpToast(`保存失败：${error.message}`, 'danger');
    }
}

/** 拉取账号可用的文本生成模型，填入 datalist 供选择 */
export async function aiLoadModels() {
    setConnStatus('正在拉取模型列表…');
    try {
        const data = await cpRequest(AI_BASE, '/models', { timeoutMs: 30000 });
        const models = data.data?.models || [];
        $('cpAiModelList').innerHTML = models
            .map((model) => `<option value="${model.name}">${model.name}</option>`)
            .join('');
        setConnStatus(`✅ 已获取 ${models.length} 个文本生成模型`);
    } catch (error) {
        setConnStatus('');
        cpToast(`拉取模型失败：${error.message}`, 'danger');
    }
}

/** 连通性测试：跑一条最小推理 */
export async function aiTestConnection() {
    setConnStatus('测试中…');
    try {
        const data = await cpRequest(AI_BASE, '/test', { method: 'POST', body: {}, timeoutMs: 60000 });
        setConnStatus(`✅ 连通正常（${data.data.model}）：${data.data.sample}`);
    } catch (error) {
        setConnStatus('❌ 连接失败');
        cpToast(`测试失败：${error.message}`, 'danger');
    }
}

/** 状态渲染：队列三格 + 上次运行摘要 + 下次可运行时间 */
function renderAiStatus(data) {
    const set = (id, value) => {
        const el = $(id);
        if (el) el.textContent = String(value);
    };
    set('cpAiQueuePending', data.queue?.pending ?? '—');
    set('cpAiQueueEdited', data.queue?.pendingEdited ?? '—');
    set('cpAiQueueProcessed', data.queue?.processed ?? '—');

    const parts = [];
    if (data.running) parts.push('⏳ 一轮处理进行中…');
    if (data.lastSummary) {
        const s = data.lastSummary;
        const failures = Number(s.failed || 0) + Number(s.errors || 0);
        parts.push(
            `上次运行：尝试 ${s.attempted ?? 0} 条，改策略 ${s.policyUpdated ?? 0}，补注释 ${s.commentFilled ?? 0}` +
            `，失败 ${failures}${s.aborted ? '（连续网络异常中止）' : ''}，队列剩余 ${s.remaining ?? 0}`
        );
    } else {
        parts.push('尚未运行过。');
    }
    if (data.nextRunAt) parts.push(`下次可运行：${new Date(data.nextRunAt).toLocaleString()}`);
    const el = $('cpAiRunState');
    if (el) el.textContent = parts.join('；');
}

/** 拉取队列与运行状态；同时同步前端调度器的下次触发时间 */
export async function aiRefreshStatus() {
    try {
        const data = await cpRequest(AI_BASE, '/status');
        renderAiStatus(data.data || {});
        nextDueAt = data.data?.nextRunAt ? (Date.parse(data.data.nextRunAt) || 0) : 0;
        if (!configLoaded && data.data?.config) {
            cachedConfig = data.data.config;
            configLoaded = true;
            applyConfigToControls(cachedConfig);
        }
    } catch (error) {
        console.warn('[ai] 状态加载失败', error.message);
    }
}

/**
 * 消化队列：循环调用 /api/ai/run，直到队列清空 / 端点跳过 / 达到单次上限。
 * @param {object} options
 * @param {boolean} options.force 跳过服务端冷却（「立即执行」按钮）
 * @param {boolean} options.notify 是否弹 toast（手动执行 true，后台调度 false）
 */
async function drainQueue({ force, notify }) {
    if (draining) {
        if (notify) cpToast('已有一轮在执行中，请稍候', 'warning');
        return;
    }
    draining = true;
    try {
        for (let batch = 0; batch < MAX_BATCHES_PER_DRAIN; batch += 1) {
            const data = await cpRequest(AI_BASE, '/run', { method: 'POST', body: { force }, timeoutMs: RUN_TIMEOUT_MS });
            const result = data.data || {};
            if (result.skipped) {
                if (result.nextRunAt) nextDueAt = Date.parse(result.nextRunAt) || nextDueAt;
                if (notify) {
                    const reason = result.reason === 'running'
                        ? '已有一轮在运行中'
                        : `冷却期内${result.nextRunAt ? `，下次可运行：${new Date(result.nextRunAt).toLocaleString()}` : ''}`;
                    cpToast(`本轮跳过：${reason}`, 'warning');
                }
                break;
            }
            await aiRefreshStatus();
            const summary = result.summary || {};
            if (notify && summary.attempted) {
                cpToast(`本批尝试 ${summary.attempted} 条：改策略 ${summary.policyUpdated}，补注释 ${summary.commentFilled}`, 'success');
            }
            if (summary.remaining <= 0 || summary.aborted) break;
        }
    } catch (error) {
        if (notify) cpToast(`执行失败：${error.message}`, 'danger');
        console.warn('[ai] 批量执行失败', error.message);
    } finally {
        draining = false;
        if (notify) aiRefreshStatus();
    }
}

/** 面板「立即执行一轮」：跳过冷却，强跑一批 */
export function aiRunNow() {
    return drainQueue({ force: true, notify: true });
}

/** 重置 AI 处理标记：全部规则重新参与调度（需确认） */
export async function aiResetProcessed() {
    if (!window.confirm('确定重置所有规则的「AI 已处理」标记？下一轮调度会重新分析全部候选规则。')) return;
    try {
        const data = await cpRequest(AI_BASE, '/reset', { method: 'POST', body: {} });
        cpToast(`已重置 ${data.data?.reset ?? 0} 条规则的处理标记`, 'success');
        aiRefreshStatus();
    } catch (error) {
        cpToast(`重置失败：${error.message}`, 'danger');
    }
}

/** 调度 tick：开关开启且到了周期就后台消化一轮 */
async function schedulerTick() {
    if (draining) return;
    const config = await aiLoadConfig();
    if (!config?.enabled) return;
    if (nextDueAt && Date.now() < nextDueAt) return;
    await drainQueue({ force: false, notify: false });
    // 消化完按新周期重排；若端点冷却里给了 nextRunAt 则以服务端为准
    if (!nextDueAt) nextDueAt = Date.now() + (config.intervalMinutes || 360) * 60000;
}

/** 「执行周期」选自定义时显示分钟数输入框 */
function wireAiControls() {
    $('cpAiInterval').addEventListener('change', () => {
        $('cpAiIntervalCustomWrap').hidden = $('cpAiInterval').value !== 'custom';
    });
}

/** 启动前端调度器与 AI 页面的懒加载 */
export function startAiScheduler() {
    wireAiControls();
    // 进入 AI 配置页时才拉配置与状态，避免每次启动面板都多打两个请求
    document.addEventListener('cp:page', (event) => {
        if (event.detail === 'ai') {
            aiLoadConfig();
            aiRefreshStatus();
        }
    });
    window.setInterval(schedulerTick, SCHEDULER_TICK_MS);
}

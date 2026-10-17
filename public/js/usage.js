/**
 * 仪表盘「☁️ Cloudflare 用量」卡：Workers AI 调用量与 Workers 请求统计。
 *
 * 数据来自 /api/ai/usage（服务端代理 Cloudflare GraphQL Analytics API，60 秒缓存），
 * 凭据复用「AI配置」页的连接配置——未配置时卡片给出跳转引导，权限不足时
 * 提示需要补的 API Token 权限（Account Analytics: Read 等），不弹错误。
 */

import { CP_CONFIG } from './config.js';
import { $, cpEscape, formatTime } from './dom.js';
import { switchPage } from './nav.js';
import { cpRequest } from './api.js';

const USAGE_TIMEOUT_MS = 30000;

/** 大数中文紧凑显示：12,345 → 1.2 万；面板统计格空间有限 */
function formatCompact(value) {
    const num = Number(value);
    if (!Number.isFinite(num)) return '-';
    if (num >= 100000000) return `${(num / 100000000).toFixed(1)} 亿`;
    if (num >= 10000) return `${(num / 10000).toFixed(1)} 万`;
    return num.toLocaleString('zh-CN');
}

/** 模型短名：@cf/meta/llama-3.1-8b-instruct → llama-3.1-8b-instruct */
function shortModelName(name) {
    const text = String(name || '');
    const slash = text.lastIndexOf('/');
    return slash >= 0 ? text.slice(slash + 1) : text;
}

function statCell(label, value, hint = '') {
    return `<div class="cp-stat"><div class="label">${cpEscape(label)}</div>` +
        `<div class="value cp-stat-value-sm">${cpEscape(String(value))}` +
        `${hint ? `<div class="cp-stat-hint small text-muted">${cpEscape(hint)}</div>` : ''}</div></div>`;
}

function renderUsage(data) {
    const wrap = $('cpUsageStats');
    const detail = $('cpUsageDetail');
    if (!wrap || !detail) return;

    if (!data || !data.configured) {
        wrap.innerHTML = [
            statCell('AI 请求（24h）', '—'),
            statCell('AI Token（24h）', '—'),
            statCell('常用模型', '—'),
            statCell('Workers 请求（24h）', '—')
        ].join('');
        detail.innerHTML = '尚未配置 Workers AI 连接，<a href="#" data-goto="ai">去「AI配置」页</a>' +
            ' 填写 Account ID 与 API Token（需 Workers AI: Edit + Account Analytics: Read 权限）。';
        return;
    }

    const ai = data.ai;
    const workers = data.workers;
    const topModel = ai?.models?.[0];
    const cells = [
        statCell('AI 请求（24h）', ai ? `${formatCompact(ai.requests)} 次` : '—'),
        statCell('AI Token（24h）', ai ? formatCompact(ai.tokens) : '—'),
        statCell(
            '常用模型（24h）',
            topModel ? shortModelName(topModel.name) : (ai ? '无调用' : '—'),
            topModel ? `${formatCompact(topModel.tokens)} Token` : ''
        ),
        statCell('Workers 请求（24h）', workers ? `${formatCompact(workers.requests)} 次` : '—')
    ];
    wrap.innerHTML = cells.join('');

    const parts = [];
    if (ai && ai.models.length) {
        parts.push(`🤖 模型分布：${ai.models
            .map((model) => `${shortModelName(model.name)}（${formatCompact(model.tokens)} Token）`)
            .join('、')}`);
    }
    if (workers && workers.scripts.length) {
        parts.push(`⚙️ 脚本 Top：${workers.scripts
            .map((script) => `${script.name}（${formatCompact(script.requests)} 次）`)
            .join('、')}`);
    }
    if (Array.isArray(data.warnings)) {
        for (const warning of data.warnings) parts.push(`⚠️ ${warning}`);
    }
    parts.push('免费额度 10,000 Neurons/天，超限调用返回 429（AI 页会提示「今日额度已达上限」）');
    if (data.fetchedAt) parts.push(`更新于 ${formatTime(data.fetchedAt)}`);
    detail.innerHTML = cpEscape(parts.join('；'));
}

/** 拉取并渲染 Cloudflare 用量；失败时降级为提示文字，不打断面板其余刷新 */
export async function cpLoadUsage() {
    const wrap = $('cpUsageStats');
    if (!wrap) return;
    try {
        const data = await cpRequest(CP_CONFIG.aiBase, '/usage', { timeoutMs: USAGE_TIMEOUT_MS });
        renderUsage(data.data || {});
    } catch (error) {
        const detail = $('cpUsageDetail');
        if (detail) detail.textContent = `Cloudflare 用量加载失败：${error.message}`;
        console.warn('[usage] 用量加载失败', error.message);
    }
}

/** 卡片底部引导链接：委托监听，避免内联 onclick 的引号转义问题 */
export function wireUsageCard() {
    $('cpUsageDetail')?.addEventListener('click', (event) => {
        const link = event.target.closest('a[data-goto]');
        if (link) {
            event.preventDefault();
            switchPage(link.dataset.goto);
        }
    });
}

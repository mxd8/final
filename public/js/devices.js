/**
 * 设备检测综合视图：来源设备在线状态、配置告警分级 + 聚合的配置检测与版本看板。
 *
 * 数据全部来自 /stats 响应捎带的 devices / deviceSummary（零新增请求）：
 *   devices        [{deviceId, name, username, ip, online, configStatus,
 *                     lastOnlineTime, panelVersion, loggerVersion, ...}]
 *   deviceSummary  {total, online, alertCount, alerts: [{name, type, level, message}]}
 *
 * 告警分级（level 由服务端按严重程度排好序）：
 *   danger    红色：配置校验失败（设备从未上报组件版本）
 *   warning   黄色：配置过期（组件版本落后于服务端）
 *   secondary 灰色：设备离线（超过离线窗口无请求，窗口 = max(5分钟, 2×刷新间隔)）
 *
 * 视图同时承载原「🩺 配置检测」页与「🧭 版本与更新」看板（二者已从导航与
 * 设置页移除）：进入本视图自动执行基础检测并刷新版本看板。
 */

import { state } from './config.js';
import { $, cpEscape, formatTime } from './dom.js';

const STATUS_META = {
    latest: { icon: '✅', badge: 'text-bg-success', label: '配置最新' },
    outdated: { icon: '🟠', badge: 'text-bg-warning', label: '配置过期' },
    failed: { icon: '🔴', badge: 'text-bg-danger', label: '校验失败' }
};

const ALERT_CLASS = {
    danger: 'alert-danger',
    warning: 'alert-warning',
    secondary: 'alert-secondary'
};

const LEVEL_ICON = { danger: '🔴', warning: '🟠', secondary: '⚪' };

function onlineBadge(device) {
    return device.online
        ? '<span class="badge text-bg-success">在线</span>'
        : '<span class="badge text-bg-secondary">离线</span>';
}

function configBadge(device) {
    const meta = STATUS_META[device.configStatus] || STATUS_META.failed;
    return `<span class="badge ${meta.badge}">${meta.icon} ${meta.label}</span>`;
}

/** 单台设备行：标识（用户名 + 型号 + IP）、类型徽标（A–E）、在线 / 配置状态、版本与最后上线时间 */
function deviceRowHtml(device) {
    const title = [device.username, device.name].filter(Boolean).join(' · ') || device.deviceId;
    const versions = [
        device.panelVersion ? `面板 ${cpEscape(device.panelVersion)}` : '面板版本未知',
        device.loggerVersion ? `捕获 ${cpEscape(device.loggerVersion)}` : '捕获版本未知'
    ].join(' · ');
    // v1.5 设备五类型徽标：A Surge iOS / B Surge Mac / C Surge iPad / D 路由器插件 / E 纯 API
    const typeBadge = device.typeCode
        ? `<span class="badge text-bg-info" title="${cpEscape(device.typeLabel || '')}${device.versionDetection === false ? '（不参与版本检测）' : ''}">${cpEscape(device.typeCode)}·${cpEscape(device.typeLabel || '')}</span>`
        : '';
    const platformDetail = device.platformParams && typeof device.platformParams === 'object'
        ? Object.entries(device.platformParams)
            .filter(([key]) => key !== 'platform' && key !== 'model')
            .map(([key, value]) => `${cpEscape(key)}=${cpEscape(String(value))}`)
            .join(' ')
        : '';
    return `
        <div class="cp-device-row d-flex flex-wrap justify-content-between align-items-start gap-2 py-2 border-bottom">
            <div class="flex-grow-1">
                <div class="d-flex flex-wrap align-items-center gap-2">
                    <span class="fw-semibold small">📱 ${cpEscape(title)}</span>
                    ${typeBadge}
                    ${onlineBadge(device)}
                    ${configBadge(device)}
                </div>
                <div class="small text-muted mt-1">
                    🌐 来源 IP：<code>${device.ip ? cpEscape(device.ip) : '未知'}</code>
                    · ${versions}
                    · 最后上线：${cpEscape(formatTime(device.lastOnlineTime))}
                    ${platformDetail ? ` · 平台参数：${platformDetail}` : ''}
                </div>
            </div>
        </div>`;
}

/** 醒目告警条：任一设备存在告警时按严重程度着色逐条展示 */
function renderAlerts(summary) {
    const host = $('cpDeviceAlerts');
    if (!host) return;
    if (!summary?.alerts?.length) {
        host.innerHTML = '';
        return;
    }
    host.innerHTML = summary.alerts
        .map((alert) => `
            <div class="alert ${ALERT_CLASS[alert.level] || 'alert-secondary'} py-2 px-3 small d-flex align-items-center gap-2 mb-2" role="alert">
                <span aria-hidden="true">${LEVEL_ICON[alert.level] || '⚪'}</span>
                <span><b>${cpEscape(alert.name || '未知设备')}</b>${alert.username ? `（${cpEscape(alert.username)}）` : ''}：${cpEscape(alert.message)}</span>
            </div>`)
        .join('');
}

/** 设备清单与 n/m 在线统计 */
function renderDeviceList(report) {
    const host = $('cpDeviceList');
    const summaryEl = $('cpDeviceSummary');
    if (!host || !summaryEl) return;

    const summary = report?.deviceSummary || { total: 0, online: 0 };
    summaryEl.innerHTML = `
        <span class="badge text-bg-primary fs-6">在线 ${summary.online ?? 0} / ${summary.total ?? 0}</span>
        ${summary.alertCount ? `<span class="badge text-bg-warning fs-6 ms-1">⚠️ 告警 ${summary.alertCount}</span>` : ''}`;

    const devices = report?.devices || [];
    if (!devices.length) {
        host.innerHTML = `
            <p class="text-muted small mb-0">
                尚未收到任何设备上报。安装 FINAL 模块并配置参数后，面板刷新一次（心跳）或捕获脚本
                完成一次批量上报，设备就会出现在这里；同型号多设备靠用户名（模块参数 FINAL_USER）
                与来源 IP 区分。
            </p>`;
        return;
    }
    host.innerHTML = devices.map(deviceRowHtml).join('');
}

/** 渲染设备面板：stats 捎带的设备报表是唯一数据源，旧后端没有该字段时给出升级提示 */
export function renderDevicePanel() {
    if (!state.stats || state.stats.devices === undefined) {
        const host = $('cpDeviceList');
        const summaryEl = $('cpDeviceSummary');
        if (host && !host.innerHTML.trim()) {
            if (summaryEl) summaryEl.textContent = '服务端尚未返回设备数据';
            host.innerHTML = '<p class="text-muted small mb-0">当前部署的服务端版本较旧，不支持设备报表；部署最新版本后此处将展示设备在线状态与配置告警。</p>';
        }
        return;
    }
    renderAlerts(state.stats.deviceSummary);
    renderDeviceList(state.stats);
}

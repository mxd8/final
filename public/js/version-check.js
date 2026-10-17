/**
 * 版本比对与更新提示：网页内置版本（version.js）对服务端部署版本（/api/logger/meta）。
 *
 * 判定分级（docs/feature-requirements.md 1.1.4）：
 *   ok（绿）一致 / minor-behind（黄）小版本落后，建议更新 /
 *   major-behind（红）大版本落后，上报协议可能不兼容 / ahead（蓝）客户端领先——
 *   服务端待部署（自托管「先更网页、后部署后端」是正常操作，只提示不阻塞）。
 *
 * 数据来源：cpLoadMeta 把 meta.version 写进 state.serverInfo；
 * cpLoadStats 把 latest / 最近心跳写进 state.stats。零新增请求。
 */

import { PANEL_VERSION, PANEL_BUILD, PANEL_BUILD_TIME } from './version.js';
import { state } from './config.js';
import { $, cpEscape } from './dom.js';
import { switchPage } from './nav.js';

const BADGE_CLASS = {
    ok: 'success',
    'minor-behind': 'warning',
    'major-behind': 'danger',
    ahead: 'info',
    unknown: 'secondary'
};

const LEVEL_TEXT = {
    ok: '最新',
    'minor-behind': '建议更新',
    'major-behind': '严重落后',
    ahead: '服务端待部署',
    unknown: '未知'
};

/** 解析 '1.2.3 (abc1234)' 形态的语义化版本主体 */
function parseSemver(value) {
    const match = String(value ?? '').trim().match(/^(\d+)\.(\d+)\.(\d+)/);
    if (!match) return null;
    return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

/** 语义化版本比较：a < b → -1，相等 → 0，a > b → 1；任一不可解析返回 null */
export function compareVersions(a, b) {
    const left = parseSemver(a);
    const right = parseSemver(b);
    if (!left || !right) return null;
    if (left.major !== right.major) return left.major < right.major ? -1 : 1;
    if (left.minor !== right.minor) return left.minor < right.minor ? -1 : 1;
    if (left.patch !== right.patch) return left.patch < right.patch ? -1 : 1;
    return 0;
}

/** 版本落后分级：兼容性承诺是「后端兼容往前一个大版本的上报格式」 */
export function versionLevel(client, server) {
    const order = compareVersions(client, server);
    if (order === null) return 'unknown';
    if (order === 0) return 'ok';
    if (order > 0) return 'ahead';
    const clientMajor = parseSemver(client).major;
    const serverMajor = parseSemver(server).major;
    return clientMajor < serverMajor ? 'major-behind' : 'minor-behind';
}

function badge(level) {
    return `<span class="badge text-bg-${BADGE_CLASS[level] || 'secondary'}">${LEVEL_TEXT[level] || level}</span>`;
}

/** 点击横幅 / 徽标后的刷新：先让 SW 检查更新（接管后清旧缓存），再整页重载 */
async function reloadForUpdate() {
    try {
        const registration = await navigator.serviceWorker?.getRegistration();
        await registration?.update();
    } catch {
        // SW 不可用时直接重载：入口 ?v= 参数与 no-store 的 index.html 已保证拿到新版本
    }
    window.location.reload();
}

function renderBanner() {
    const host = $('cpVersionBanner');
    if (!host) return;
    const server = state.serverInfo?.serverVersion || '';
    const level = versionLevel(PANEL_VERSION, server);
    host.innerHTML = '';
    host.hidden = !(level === 'minor-behind' || level === 'major-behind');
    if (host.hidden) return;

    const danger = level === 'major-behind';
    const div = document.createElement('div');
    div.className = `alert ${danger ? 'alert-danger' : 'alert-warning'} py-2 px-3 d-flex flex-wrap align-items-center gap-2 mb-3`;
    div.setAttribute('role', 'alert');
    div.innerHTML =
        `${danger ? '🚨' : '🆙'} 发现新版本 <b>${cpEscape(server)}</b>（当前 ${cpEscape(PANEL_BUILD)}）` +
        (danger ? '；跨大版本的上报协议可能不兼容，请尽快刷新' : '') +
        `<button type="button" class="btn btn-sm btn-outline-secondary ms-auto" id="cpVersionReloadBtn">🔄 刷新更新</button>`;
    host.appendChild(div);
    div.querySelector('#cpVersionReloadBtn')?.addEventListener('click', reloadForUpdate);
}

function renderTopbarBadge() {
    const badgeBtn = $('cpVersionBadge');
    if (!badgeBtn) return;
    const server = state.serverInfo?.serverVersion || '';
    const level = versionLevel(PANEL_VERSION, server);
    badgeBtn.hidden = !(level === 'minor-behind' || level === 'major-behind');
}

function clientHeartbeat() {
    const clients = state.stats?.clients;
    return Array.isArray(clients) && clients.length ? clients[0] : null;
}

/** 版本行徽标：心跳里的客户端版本对服务端最新版本 */
function heartbeatBadge(clientVersion, latestVersion) {
    if (!clientVersion) return '<span class="badge text-bg-secondary">未上报</span>';
    return badge(versionLevel(clientVersion, latestVersion || ''));
}

/** 设置页「版本与更新」看板：组件 × 客户端版本 × 服务端最新 × 通道 × 状态 */
export function renderVersionBoard() {
    const host = $('cpVersionBoard');
    if (!host) return;
    const server = state.serverInfo || {};
    const components = server.components || {};
    const beat = clientHeartbeat();

    const rows = [
        {
            name: '网页面板（内置）',
            client: PANEL_BUILD,
            latest: server.serverVersion || '—',
            channel: '网页内置',
            badge: badge(versionLevel(PANEL_VERSION, server.serverVersion || '')),
            note: ''
        },
        {
            name: 'Surge 面板脚本',
            client: beat?.panelVersion || '未知（等面板刷新一次）',
            latest: components.panel || '—',
            channel: '远程脚本',
            badge: heartbeatBadge(beat?.panelVersion, components.panel),
            note: beat ? `最近心跳 ${cpEscape(beat.lastSeen)}` : ''
        },
        {
            name: '捕获脚本（本地副本）',
            client: beat?.loggerVersion || '未知（等一次批量上报）',
            latest: components.logger || '—',
            channel: '本地副本',
            badge: heartbeatBadge(beat?.loggerVersion, components.logger),
            note: beat?.loggerVersion && components.logger && beat.loggerVersion !== components.logger
                ? '请在 Surge 脚本编辑器重新另存本地脚本（见 readme「Surge 安装教程」）'
                : ''
        },
        {
            name: 'Surge 模块（sgmodule）',
            client: '—',
            latest: components.sgmodule || '—',
            channel: '模块外链',
            badge: '<span class="badge text-bg-secondary">见模块头版本注释</span>',
            note: ''
        }
    ];

    host.innerHTML = `
        <div class="table-responsive">
            <table class="table table-sm align-middle mb-2">
                <thead><tr><th>组件</th><th>当前版本</th><th>服务端最新</th><th>分发通道</th><th>状态</th></tr></thead>
                <tbody>
                    ${rows.map((row) => `
                        <tr>
                            <td class="text-nowrap">${row.name}${row.note ? `<div class="text-muted small">${row.note}</div>` : ''}</td>
                            <td class="cp-mono small">${cpEscape(row.client)}</td>
                            <td class="cp-mono small">${cpEscape(row.latest)}</td>
                            <td class="small">${row.channel}</td>
                            <td>${row.badge}</td>
                        </tr>`).join('')}
                </tbody>
            </table>
        </div>
        <p class="text-muted small mb-0">
            面板构建于 ${cpEscape(PANEL_BUILD_TIME)}；数据库 Schema 版本 ${cpEscape(String(server.dbSchemaVersion ?? '—'))}。
            捕获脚本为本地副本，无法自动更新，闭环止于提示。
        </p>`;
}

/** 顶部横幅 + 顶栏徽标 + 看板：meta / stats 到达后由 api.js / refresh.js 调用 */
export function renderVersionUi() {
    renderBanner();
    renderTopbarBadge();
    renderVersionBoard();
}

/** 初始化：顶栏徽标点击跳设备检测视图（版本看板已并入）；进入该视图时刷新看板数据 */
export function initVersionCheck() {
    $('cpVersionBadge')?.addEventListener('click', () => switchPage('devices'));
    document.addEventListener('cp:page', (event) => {
        if (event.detail === 'devices' || event.detail === 'settings') renderVersionBoard();
    });
    renderVersionUi();
}

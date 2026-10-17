/**
 * 页面导航：首页 / 数据 / 设置 三个视图的路由切换、
 * 导航位置（顶栏内嵌 / 底部 TabBar）与主题色应用。
 *
 * devices（设备检测）是隐藏页：不渲染导航按钮，由首页「来源设备」统计卡点击进入——
 * 综合详情视图聚合了设备在线状态、配置告警、配置检测与版本与更新。
 */

import { state, CP_ACCENTS, CP_ACCENT_DEFAULT } from './config.js';
import { $, cpEscape } from './dom.js';
import { savePref, keys } from './prefs-store.js';

export const PAGES = [
    { id: 'home', icon: '🏠', label: '首页' },
    { id: 'data', icon: '🗂️', label: '数据' },
    { id: 'ai', icon: '🤖', label: 'AI配置' },
    { id: 'settings', icon: '⚙️', label: '设置' },
    { id: 'devices', icon: '📱', label: '设备检测', hidden: true }
];

const getPageId = (page) => `cpPage-${page.id}`;

/** 顶部与底部导航共用一套按钮生成，保证两处永远一致（hidden 页不出现在导航里） */
function navItemHtml(page) {
    return `
        <button type="button" class="cp-nav-item" data-page="${page.id}" aria-controls="${getPageId(page)}">
            <span class="cp-nav-icon">${page.icon}</span>
            <span class="cp-nav-label">${cpEscape(page.label)}</span>
        </button>`;
}

function renderNav() {
    if (!PAGES || !PAGES.length) {
        console.error('PAGES array is empty or undefined');
        return;
    }
    const html = PAGES.filter((page) => !page.hidden).map(navItemHtml).join('');
    for (const nav of [$('cpNavTop'), $('cpNavBottom')]) {
        if (nav) nav.innerHTML = html;
    }
    syncNavActive();
    syncNavPosition();
}

function syncNavActive() {
    for (const page of PAGES) {
        document.querySelectorAll(`.cp-nav-item[data-page="${page.id}"]`)
            .forEach((item) => item.classList.toggle('active', state.tab === page.id));
    }
}

/** 导航位置：top = 顶栏内嵌一行；bottom = 固定底部 TabBar（移动端单手友好） */
function syncNavPosition() {
    document.body.classList.toggle('cp-nav-bottom', state.navPosition === 'bottom');
    const selector = $('cpNavPosition');
    if (selector && selector.value !== state.navPosition) selector.value = state.navPosition;
}

export function switchPage(pageId) {
    const next = PAGES.some((entry) => entry.id === pageId) ? pageId : 'home';
    state.tab = next;
    for (const entry of PAGES) {
        const section = $(getPageId(entry));
        if (section) section.hidden = entry.id !== next;
    }
    syncNavActive();
    window.scrollTo({ top: 0 });
    // 页面切换广播：配置检测页据此自动执行检测、设置页刷新版本看板
    document.dispatchEvent(new CustomEvent('cp:page', { detail: next }));
}

export function setNavPosition(position) {
    const next = position === 'bottom' ? 'bottom' : 'top';
    if (next === state.navPosition) return;
    state.navPosition = next;
    savePref(keys.navPosition, next);
    syncNavPosition();
}

/** 主题色应用：浅 / 深两套值写到根元素，主题层用它们桥接 Bootstrap 变量 */
export function applyAccent(hex) {
    const accent = CP_ACCENTS[hex] ? hex : CP_ACCENT_DEFAULT;
    document.documentElement.setAttribute('data-cp-accent', accent);
    for (const [name, value] of Object.entries(CP_ACCENTS[accent].vars)) {
        document.documentElement.style.setProperty(name, value);
    }
    const selector = $('cpAccentPicker');
    if (selector) selector.value = accent;
}

export function setAccent(hex) {
    applyAccent(hex);
    savePref(keys.accent, document.documentElement.getAttribute('data-cp-accent'));
}

/** 偏好恢复入口（settings.js 调用）：只应用视觉，不回写偏好 */
export function applyNavSettings(navPosition, accentHex) {
    state.navPosition = navPosition === 'bottom' ? 'bottom' : 'top';
    syncNavPosition();
    applyAccent(accentHex);
}

/** 设置页下拉选项：主题色板来自 config，导航位置两项固定（HTML 里已写） */
function populateAccentPicker() {
    const picker = $('cpAccentPicker');
    if (!picker || picker.options.length) return;
    picker.innerHTML = Object.entries(CP_ACCENTS)
        .map(([hex, item]) => `<option value="${hex}">${cpEscape(item.label)}</option>`)
        .join('');
}

/** 事件绑定：两套导航统一用事件委托；设置页的导航位置 / 主题色选择器也在这里接 */
export function wireNav() {
    populateAccentPicker();
    renderNav();
    for (const nav of [$('cpNavTop'), $('cpNavBottom')]) {
        nav?.addEventListener('click', (event) => {
            const item = event.target.closest('.cp-nav-item');
            if (item) switchPage(item.dataset.page);
        });
    }
    $('cpNavPosition')?.addEventListener('change', (event) => setNavPosition(event.target.value));
    $('cpAccentPicker')?.addEventListener('change', (event) => setAccent(event.target.value));
}

/**
 * PWA 支持：Service Worker 注册、安装入口、theme-color 跟随手动主题。
 *
 * 独立于 main.js 入口：面板脚本初始化失败也不影响 SW 注册与更新。
 */

/* ---------------------------------------------------- Service Worker 注册 */
if ('serviceWorker' in navigator) {
    // load 之后再注册，不与首屏渲染抢资源
    window.addEventListener('load', () => {
        // updateViaCache: 'none' —— sw.js 本身绕过 HTTP 缓存，发版后能立刻检测到新 SW
        navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' })
            .catch((err) => console.warn('[pwa] Service Worker 注册失败（不影响普通使用）:', err));
    });
}

/* -------------------------------------------------------- 安装入口按钮 */
// Chromium 系浏览器在满足安装条件时触发 beforeinstallprompt；
// iOS Safari 没有，用户需手动「添加到主屏幕」，按钮保持隐藏即可。
let installEvent = null;
const installBtn = document.getElementById('pwaInstallBtn');

function inStandalone() {
    return window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
}

window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault(); // 不弹浏览器原生安装横幅，改由面板按钮触发
    installEvent = event;
    if (installBtn && !inStandalone()) installBtn.hidden = false;
});

installBtn?.addEventListener('click', async () => {
    if (!installEvent) return;
    installEvent.prompt();
    await installEvent.userChoice; // accepted / dismissed，结果不需要特殊处理
    installEvent = null;
    installBtn.hidden = true;
});

window.addEventListener('appinstalled', () => {
    installEvent = null;
    if (installBtn) installBtn.hidden = true;
});

/* --------------------------------------------- theme-color 跟随手动主题 */
// 页面支持手动切换浅色 / 深色（data-bs-theme），而 <head> 里的两条 theme-color
// 是靠系统 media query 选择的：手动切到与系统相反的主题时颜色会错。
// 这里收敛成单条动态 meta，由 data-bs-theme 属性变化驱动。
const DARK_THEME_COLOR = '#000000';
const LIGHT_THEME_COLOR = '#f2f2f7';

function syncThemeColor() {
    const metas = document.querySelectorAll('meta[name="theme-color"]');
    if (metas.length === 0) return;
    const dark = document.documentElement.getAttribute('data-bs-theme') === 'dark';
    const primary = metas[0];
    primary.removeAttribute('media');
    primary.setAttribute('content', dark ? DARK_THEME_COLOR : LIGHT_THEME_COLOR);
    for (const meta of Array.from(metas).slice(1)) meta.remove();
}

new MutationObserver(syncThemeColor).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-bs-theme'],
});
syncThemeColor();

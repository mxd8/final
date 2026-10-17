/**
 * Service Worker：PWA 离线支持。
 *
 * 缓存策略（只拦截 GET）：
 *   - 页面导航            —— 网络优先，失败回退缓存（离线打开上次的页面）
 *   - /api/*              —— 网络优先，成功响应写入运行时缓存（离线显示最后一批数据）
 *   - 同源静态 js/css 等   —— 网络优先（部署后刷新一次即拿到新版本，不会出现新旧 JS 混用）
 *   - 同源图片             —— 缓存优先 + 后台更新（图标基本不变，省流量）
 *   - 跨域（Bootstrap CDN）—— 缓存优先 + 后台更新；首访由 install 预缓存，URL 带版本号
 *
 * 重要：VERSION 由 scripts/inject-version.mjs 随发版注入（版本号 + git 短哈希），
 * 旧缓存在 activate 阶段整体清除；ENTRY_VERSION 与 index.html 的入口脚本
 * ?v= 参数同源，保证 SW 预缓存与页面实际引用的是同一份模块图。
 */
const VERSION = 'v1.5.0-cb719c3';
const ENTRY_VERSION = '1.5.0';
const PRECACHE = `final-precache-${VERSION}`;
const RUNTIME = `final-runtime-${VERSION}`;

const PRECACHE_URLS = [
    './',
    'manifest.webmanifest',
    'favicon.svg',
    'style.css',
    'captured.css',
    'icons/favicon-32.png',
    'icons/apple-touch-icon.png',
    'icons/icon-192.png',
    'icons/icon-512.png',
    'icons/maskable-192.png',
    'icons/maskable-512.png',
    'icons/mono-512.png',
    'js/actions.js',
    'js/api.js',
    // AI 分流自动化（配置页 + 前端调度器）+ 仪表盘 Cloudflare 用量卡
    'js/ai.js',
    'js/usage.js',
    'js/clipboard.js',
    'js/config.js',
    'js/devices.js',
    'js/dom.js',
    'js/edit.js',
    'js/export.js',
    // 版本常量模块与版本比对 / 配置检测视图
    'js/version.js',
    'js/version-check.js',
    'js/health.js',
    'js/ipnet.js',
    `js/main.js?v=${ENTRY_VERSION}`,
    `js/pwa.js?v=${ENTRY_VERSION}`,
    'js/notify.js',
    'js/prefs-store.js',
    'js/refresh.js',
    'js/render.js',
    'js/ruletext.js',
    'js/settings.js',
    'js/subscribe.js',
    'js/sync.js',
    // Bootstrap 在 CDN 上但版本固定，一并预缓存才能保证完全离线可用；
    // jsdelivr 带 CORS 头，用 cors 模式请求避免存成不可检视的 opaque 响应
    'https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css',
    'https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/js/bootstrap.bundle.min.js',
];

self.addEventListener('install', (event) => {
    event.waitUntil((async () => {
        const cache = await caches.open(PRECACHE);
        // allSettled：单个资源失败（如 CDN 抖动）不拖垮整个安装
        await Promise.allSettled(PRECACHE_URLS.map((url) => {
            const options = { cache: 'reload' }; // reload：绕过 HTTP 缓存，拿到的永远是源站新版本
            if (url.startsWith('https://')) options.mode = 'cors';
            return cache.add(new Request(url, options));
        }));
        await self.skipWaiting();
    })());
});

self.addEventListener('activate', (event) => {
    event.waitUntil((async () => {
        const names = await caches.keys();
        await Promise.all(
            names.filter((name) => name !== PRECACHE && name !== RUNTIME)
                .map((name) => caches.delete(name))
        );
        await self.clients.claim();
    })());
});

/* ------------------------------------------------------------ 缓存策略 */

async function networkFirst(request, { cacheFallback = true } = {}) {
    const cache = await caches.open(RUNTIME);
    try {
        const fresh = await fetch(request);
        // 只缓存完整成功的响应；4xx/5xx 直接透传给页面自身的错误处理
        if (fresh && fresh.ok) cache.put(request, fresh.clone());
        return fresh;
    } catch (err) {
        if (!cacheFallback) throw err;
        const cached = await caches.match(request, { ignoreVary: true });
        if (cached) return cached;
        throw err;
    }
}

async function handleNavigation(request) {
    try {
        return await networkFirst(request, { cacheFallback: false });
    } catch (err) {
        // 离线导航：先找这次会话缓存过的页面，再回退到预缓存的应用壳
        const cached = await caches.match(request, { ignoreVary: true })
            || await caches.match('./', { ignoreVary: true });
        if (cached) return cached;
        throw err;
    }
}

async function staleWhileRevalidate(request) {
    const cache = await caches.open(RUNTIME);
    const cached = await caches.match(request, { ignoreVary: true });
    const update = fetch(request)
        .then((fresh) => {
            if (fresh && fresh.ok) cache.put(request, fresh.clone());
        })
        .catch(() => { /* 后台更新失败不影响本次返回 */ });
    if (cached) return cached;
    await update;
    return (await caches.match(request, { ignoreVary: true })) || Response.error();
}

/** 跨域 CDN 资源：URL 带版本号（bootstrap@5.3.0），缓存优先后台刷新 */
async function cacheFirstRemote(request) {
    const cache = await caches.open(RUNTIME);
    const cached = await caches.match(request, { ignoreVary: true });
    const update = fetch(new Request(request.url, { mode: 'cors', cache: 'no-cache' }))
        .then((fresh) => {
            if (fresh && (fresh.ok || fresh.type === 'opaque')) cache.put(request.url, fresh.clone());
        })
        .catch(() => { });
    if (cached) return cached;
    try {
        await update;
    } catch { /* 落到下面的统一查找 */ }
    return (await caches.match(request, { ignoreVary: true })) || Response.error();
}

self.addEventListener('fetch', (event) => {
    const { request } = event;
    if (request.method !== 'GET') return;
    const url = new URL(request.url);
    if (!/^https?:$/.test(url.protocol)) return; // 扩展等非 http(s) 请求不碰

    if (request.mode === 'navigate') {
        event.respondWith(handleNavigation(request));
        return;
    }
    if (url.origin === self.location.origin) {
        if (url.pathname.startsWith('/api/')) {
            event.respondWith(networkFirst(request));
            return;
        }
        if (/\.(png|jpe?g|webp|gif|svg|ico)$/.test(url.pathname)) {
            event.respondWith(staleWhileRevalidate(request));
            return;
        }
        event.respondWith(networkFirst(request)); // js / css / webmanifest
        return;
    }
    event.respondWith(cacheFirstRemote(request));
});

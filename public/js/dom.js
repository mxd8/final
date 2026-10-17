/**
 * DOM 查询与 XSS 转义工具。
 * 所有用户输入渲染前都必须过这里的转义函数，防止域名或备注里的引号破坏 DOM。
 */

export const $ = (id) => document.getElementById(id);

export function cpEscape(value) {
    return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
}

/** 转义 JSON 属性值：属性里不能出现换行与未转义的 </script> */
export function cpAttr(value) {
    return cpEscape(value).replaceAll('\n', ' ').replaceAll('</', '<\\/');
}

/**
 * 转义 onclick 内单引号字符串字面量。
 * HTML 实体转义在这里不够用：浏览器解析属性时先把 &#39; 还原成 '，
 * 再把整段属性值当作脚本解析。必须用 Unicode 转义替换单引号，
 * 字符串边界才不会被注入内容突破；同时转义 & < > 防 HTML 解析阶段截断。
 */
export function cpOnQuote(value) {
    return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll("'", '\\u0027');
}

export function cpIsIPv4(value) {
    return /^(\d{1,3}\.){3}\d{1,3}$/.test(String(value));
}

export function cpIsIPv6(value) {
    return /([0-9a-fA-F]{1,4}:){1,7}[0-9a-fA-F]{1,4}|::/.test(String(value)) && !cpIsIPv4(value);
}

/** 时间显示：转本地时区，解析失败原样返回 */
export function formatTime(value) {
    const date = new Date(String(value || ''));
    if (Number.isNaN(date.getTime())) return String(value || '-');
    return date.toLocaleString();
}

/** 从 URL 里取主机名，作为未命名订阅的显示名 */
export function hostFromUrl(url) {
    try {
        return new URL(String(url || '')).hostname || String(url || '');
    } catch {
        return String(url || '');
    }
}

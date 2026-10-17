/**
 * 剪贴板：优先异步 Clipboard API，失败回退 prompt 手动复制。
 */

import { cpToast } from './notify.js';

export async function cpCopy(text, successMessage) {
    try {
        await navigator.clipboard.writeText(text);
        cpToast(successMessage, 'success');
    } catch (error) {
        console.warn('[surge] 剪贴板复制失败，回退手动复制', error.message);
        window.prompt('请手动复制：', text);
    }
}

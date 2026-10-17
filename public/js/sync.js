/**
 * GitHub Gist 云同步：把全量规则备份到私有 Gist，或从备份还原（merge 模式）。
 */

import { state, CP_CONFIG } from './config.js';
import { $ } from './dom.js';
import { cpToast, cpSetBusy } from './notify.js';
import { savePref, keys } from './prefs-store.js';
import { cpRequest, ensureAllLogs } from './api.js';
import { cpRefreshAll } from './refresh.js';

export function saveGistConfig() {
    savePref(keys.gistToken, $('cpGistToken').value.trim());
    savePref(keys.gistId, $('cpGistId').value.trim());
    cpToast('Gist 配置已保存', 'success');
}

/** 带超时的 GitHub 请求封装，避免离线时一直转圈 */
async function cpGithubRequest(url, options = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CP_CONFIG.timeoutMs);
    try {
        const response = await fetch(url, {
            ...options,
            signal: controller.signal,
            headers: { ...options.headers }
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.message || `GitHub 返回 ${response.status}`);
        return data;
    } catch (error) {
        throw new Error(error.name === 'AbortError' ? '请求超时' : error.message);
    } finally {
        clearTimeout(timer);
    }
}

/** 把当前全量规则上传成 Gist 备份（有 Gist ID 则覆盖更新） */
export async function uploadToGist() {
    if (state.busy) return;
    const token = $('cpGistToken').value.trim();
    const gistId = $('cpGistId').value.trim();
    if (!token) {
        cpToast('请先填写 GitHub Token', 'warning');
        return;
    }

    cpSetBusy(true);
    let logs;
    try {
        // 备份必须用全量数据：懒加载过期时这里会重新拉取
        logs = await ensureAllLogs();
    } catch (error) {
        cpSetBusy(false);
        cpToast(`全量规则加载失败：${error.message}`, 'danger');
        return;
    }

    const file = 'surge_rules_backup.json';
    const body = {
        description: 'Surge Rules Backup',
        public: false,
        files: { [file]: { content: JSON.stringify(logs, null, 2) } }
    };

    try {
        const data = await cpGithubRequest(gistId ? `https://api.github.com/gists/${gistId}` : 'https://api.github.com/gists', {
            method: gistId ? 'PATCH' : 'POST',
            headers: { Authorization: `token ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
        $('cpGistId').value = data.id;
        savePref(keys.gistId, data.id);
        cpToast(`已上传 ${logs.length} 条规则`, 'success');
    } catch (error) {
        cpToast(`上传失败：${error.message}`, 'danger');
    } finally {
        cpSetBusy(false);
    }
}

/**
 * 从 Gist 备份还原：走 merge 模式（后端默认），备注与来源非空才覆盖，
 * 避免把设备上标注好的内容清掉；面板的「执行逐行覆盖」才是权威写入。
 */
export async function syncFromGist() {
    if (state.busy) return;
    const token = $('cpGistToken').value.trim();
    const gistId = $('cpGistId').value.trim();
    if (!token || !gistId) {
        cpToast('请填写 GitHub Token 与 Gist ID', 'warning');
        return;
    }
    if (!window.confirm('Gist 内容会覆盖当前同名规则，确定继续吗？')) return;

    cpSetBusy(true);
    try {
        const data = await cpGithubRequest(`https://api.github.com/gists/${gistId}`, {
            headers: { Authorization: `token ${token}` }
        });
        const content = data.files?.['surge_rules_backup.json']?.content;
        if (!content) throw new Error('Gist 里没有找到 surge_rules_backup.json');

        const lines = JSON.parse(content);
        if (!Array.isArray(lines)) throw new Error('备份文件格式不正确');

        await cpRequest(CP_CONFIG.apiBase, '/batch', { method: 'POST', body: { lines } });
        cpToast(`已还原 ${lines.length} 条规则`, 'success');
        await cpRefreshAll();
    } catch (error) {
        cpToast(`同步失败：${error.message}`, 'danger');
    } finally {
        cpSetBusy(false);
    }
}

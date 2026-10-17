/**
 * 多用户会话（v1.5）：登录 / 登出 / 管理员引导 / 改密，与面板各处的身份联动。
 *
 * 会话令牌存本机 localStorage（键 cp_session_token），用户信息存 cp_session_user；
 * 页面加载时以 /api/auth/me 校验一次（后端过期即清空本地态）。写请求由 api.js
 * 自动优先附带会话令牌（回落写接口令牌）。
 *
 * 鉴权体系启用（已存在管理员）后，匿名添加数据被服务端拒绝——面板据此在顶栏
 * 展示登录入口，未登录时写操作失败会引导登录。
 */

import { state } from './config.js';
import { $, cpEscape } from './dom.js';
import { cpToast } from './notify.js';

const TOKEN_KEY = 'cp_session_token';
const USER_KEY = 'cp_session_user';

export function getSessionToken() {
    try {
        return localStorage.getItem(TOKEN_KEY) || '';
    } catch {
        return '';
    }
}

function saveSession(token, user) {
    try {
        localStorage.setItem(TOKEN_KEY, token);
        localStorage.setItem(USER_KEY, JSON.stringify(user || {}));
        return true;
    } catch {
        return false;
    }
}

export function clearSession() {
    try {
        localStorage.removeItem(TOKEN_KEY);
        localStorage.removeItem(USER_KEY);
    } catch { /* 本地存储不可用时忽略 */ }
}

function getCachedUser() {
    try {
        const raw = localStorage.getItem(USER_KEY);
        const parsed = raw ? JSON.parse(raw) : null;
        return parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
        return null;
    }
}

/** 统一的 JSON 请求封装（短超时；错误信息直接可展示） */
async function authRequest(path, { method = 'GET', body } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    const headers = {};
    if (body) headers['Content-Type'] = 'application/json';
    const token = getSessionToken();
    if (token) headers.Authorization = `Bearer ${token}`;
    try {
        const response = await fetch(path, {
            method,
            headers,
            body: body ? JSON.stringify(body) : undefined,
            signal: controller.signal
        });
        const data = await response.json().catch(() => null);
        if (!response.ok || !data?.success) {
            throw new Error(data?.error || `请求失败（HTTP ${response.status}）`);
        }
        return data.data;
    } catch (error) {
        if (error.name === 'AbortError') throw new Error('请求超时，请稍后重试');
        throw error;
    } finally {
        clearTimeout(timer);
    }
}

/** 顶栏身份徽标：管理员会话 / 普通用户会话 / 未登录 */
function renderSessionChip() {
    const chip = $('cpSessionChip');
    if (!chip) return;
    if (state.user) {
        const roleBadge = state.user.role === 'admin'
            ? '<span class="badge text-bg-danger ms-1">管理员</span>'
            : '<span class="badge text-bg-secondary ms-1">用户</span>';
        chip.innerHTML = `👤 ${cpEscape(state.user.displayName || state.user.username)}${roleBadge}`;
        chip.title = '已登录，点击前往「用户」页管理会话';
        chip.onclick = () => window.capturePanel.switchPage('users');
    } else if (state.isAdmin) {
        chip.innerHTML = '🔑 令牌身份（管理员）';
        chip.title = '当前通过写接口令牌鉴权';
        chip.onclick = () => window.capturePanel.switchPage('users');
    } else {
        chip.innerHTML = '🚪 未登录';
        chip.title = state.authEnabled ? '点击登录' : '鉴权体系未启用';
        chip.onclick = () => {
            if (state.authEnabled) openLoginModal();
            else window.capturePanel.switchPage('users');
        };
    }
}

/** 登录弹窗：清空表单后弹出 */
export function openLoginModal() {
    const modal = $('cpLoginModal');
    if (!modal) return;
    const errorBox = $('cpLoginError');
    if (errorBox) {
        errorBox.classList.add('d-none');
        errorBox.textContent = '';
    }
    $('cpLoginPassword').value = '';
    if (window.bootstrap) window.bootstrap.Modal.getOrCreateInstance(modal).show();
}

async function submitLoginForm() {
    const username = $('cpLoginUsername').value.trim();
    const password = $('cpLoginPassword').value;
    const errorBox = $('cpLoginError');
    if (!username || !password) {
        if (errorBox) {
            errorBox.textContent = '用户名与密码不能为空';
            errorBox.classList.remove('d-none');
        }
        return;
    }
    try {
        const data = await authRequest('/api/auth/login', { method: 'POST', body: { username, password } });
        saveSession(data.token, data.user);
        cpToast(`欢迎回来，${data.user.displayName || data.user.username}`, 'success');
        if (window.bootstrap) window.bootstrap.Modal.getInstance($('cpLoginModal'))?.hide();
        await refreshAuthState();
    } catch (error) {
        if (errorBox) {
            errorBox.textContent = error.message;
            errorBox.classList.remove('d-none');
        }
    }
}

/** 登录表单绑定：提交按钮 + 回车 */
function wireLoginModal() {
    $('cpLoginSubmit')?.addEventListener('click', submitLoginForm);
    for (const inputId of ['cpLoginUsername', 'cpLoginPassword']) {
        $(inputId)?.addEventListener('keydown', (event) => {
            if (event.key === 'Enter') {
                event.preventDefault();
                submitLoginForm();
            }
        });
    }
}

/** 登出：服务端删会话 + 本地清态（服务端失败也清本地，保证面板可用） */
export async function logout() {
    try {
        await authRequest('/api/auth/logout', { method: 'POST' });
    } catch { /* 会话可能已过期：照常清本地 */ }
    clearSession();
    cpToast('已退出登录', 'success');
    await refreshAuthState();
}

/** 修改自己的密码：改完其余会话全部失效（当前会话保留） */
export async function changePassword() {
    const current = $('cpChangePasswordCurrent')?.value ?? '';
    const next = $('cpChangePasswordNext')?.value ?? '';
    const confirmValue = $('cpChangePasswordConfirm')?.value ?? '';
    if (!current || !next) {
        cpToast('请填写当前密码与新密码', 'warning');
        return;
    }
    if (next !== confirmValue) {
        cpToast('两次输入的新密码不一致', 'warning');
        return;
    }
    try {
        await authRequest('/api/auth/change-password', { method: 'POST', body: { currentPassword: current, newPassword: next } });
        for (const id of ['cpChangePasswordCurrent', 'cpChangePasswordNext', 'cpChangePasswordConfirm']) {
            if ($(id)) $(id).value = '';
        }
        cpToast('密码已修改：其他设备上的登录已失效', 'success');
    } catch (error) {
        cpToast(`修改失败：${error.message}`, 'danger');
    }
}

/** 管理员引导（仅鉴权体系未初始化时可用）：创建首个管理员并自动登录 */
export async function bootstrapAdmin() {
    const username = $('cpBootstrapUsername')?.value.trim() ?? '';
    const password = $('cpBootstrapPassword')?.value ?? '';
    const displayName = $('cpBootstrapDisplayName')?.value.trim() ?? '';
    if (!username || !password) {
        cpToast('用户名与密码不能为空', 'warning');
        return;
    }
    try {
        const data = await authRequest('/api/auth/bootstrap', { method: 'POST', body: { username, password, displayName } });
        saveSession(data.token, data.user);
        cpToast('管理员已创建并登录', 'success');
        await refreshAuthState();
    } catch (error) {
        cpToast(`初始化失败：${error.message}`, 'danger');
    }
}

/** 设置页「会话与密码」卡片的状态行 */
function renderSessionCard() {
    const info = $('cpSessionInfo');
    if (!info) return;
    if (state.user) {
        const role = state.user.role === 'admin' ? '管理员' : '普通用户';
        info.innerHTML = `当前登录：<b>${cpEscape(state.user.displayName || state.user.username)}</b>（${role}）。修改密码后其他设备的会话将全部失效。`;
    } else if (state.isAdmin) {
        info.innerHTML = '当前通过<b>写接口令牌</b>鉴权（令牌身份 = 管理员）。登录账号后可使用多用户功能。';
    } else if (state.authEnabled) {
        info.innerHTML = '鉴权体系已启用：未登录时写操作会被拒绝（禁止匿名添加数据），请点击顶栏「未登录」登录。';
    } else {
        info.textContent = '鉴权体系未启用：写操作回落到写接口令牌鉴权；可在「用户」页初始化多用户体系。';
    }
}

/**
 * 会话状态初始化与刷新：/api/auth/me 校验本地令牌 → 回填 state → 渲染顶栏徽标、
 * 广播给导航（用户页可见性）与用户管理页。
 */
export async function refreshAuthState() {
    try {
        const data = await authRequest('/api/auth/me');
        state.authEnabled = Boolean(data.authEnabled);
        state.user = data.user ?? null;
        state.isAdmin = Boolean(data.isAdmin);
        state.authFeatures = data.features ?? {};
        if (!data.authenticated && data.authEnabled) {
            clearSession(); // 令牌已失效（过期 / 被禁用）：清掉避免反复 401
        }
    } catch {
        // 后端不可达时保留本地缓存身份，不让整个面板挂掉
        const cached = getCachedUser();
        if (cached) state.user = cached;
    }
    renderSessionChip();
    renderSessionCard();
    document.dispatchEvent(new CustomEvent('cp:auth', { detail: { user: state.user, isAdmin: state.isAdmin, authEnabled: state.authEnabled } }));
}

/** 初始化：绑定登录弹窗并拉取会话状态 */
export function initAuth() {
    wireLoginModal();
    const cached = getCachedUser();
    if (cached) state.user = cached;
    return refreshAuthState();
}

/** 功能限制清单（/api/auth/me 的 features 字段）：用户编辑弹窗的勾选项 */
export function listFeatureNames() {
    return Object.keys(state.authFeatures ?? {});
}

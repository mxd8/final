/**
 * 用户与用户组管理页（v1.5，仅管理员）：快捷添加 / 禁用 / 删除用户、
 * 角色与用户组分配、功能级限制勾选（AI 与功能限制扩展）。
 *
 * 鉴权体系未初始化时本页承载「管理员引导」（创建首个管理员并自动登录）；
 * 已启用但身份不足时给出登录引导。数据面：GET /api/users（用户 + 组）、
 * GET /api/groups（组 + 成员数），写操作走 POST / PATCH / DELETE。
 */

import { state } from './config.js';
import { $, cpEscape, formatTime } from './dom.js';
import { cpToast } from './notify.js';
import { refreshAuthState, openLoginModal } from './auth.js';

let users = [];
let groups = [];
let editingUserId = null;
let editingGroupId = null;

async function usersRequest(path, { method = 'GET', body } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    const headers = {};
    if (body) headers['Content-Type'] = 'application/json';
    const token = localStorage.getItem('cp_session_token');
    if (token) headers.Authorization = `Bearer ${token}`;
    try {
        const response = await fetch(path, {
            method,
            headers,
            body: body ? JSON.stringify(body) : undefined,
            signal: controller.signal
        });
        const data = await response.json().catch(() => null);
        if (!response.ok || !data?.success) throw new Error(data?.error || `请求失败（HTTP ${response.status}）`);
        return data.data;
    } catch (error) {
        if (error.name === 'AbortError') throw new Error('请求超时，请稍后重试');
        throw error;
    } finally {
        clearTimeout(timer);
    }
}

const ROLE_LABEL = { admin: '管理员', user: '普通用户' };
const STATUS_LABEL = { active: '启用', disabled: '禁用' };

/** 功能勾选组：feature key + 说明来自 /api/auth/me 的 features 字段 */
function featuresChecklistHtml(selected = {}) {
    const features = state.authFeatures || {};
    const keys = Object.keys(features);
    if (!keys.length) return '<p class="small text-muted mb-0">功能限制清单不可用（后端版本较旧）。</p>';
    return keys.map((key) => `
        <div class="form-check form-check-inline">
            <input class="form-check-input" type="checkbox" value="${cpEscape(key)}" data-feature-check
                   id="cpFeature_${cpEscape(key.replace(/\./g, '_'))}"
                   ${selected?.features?.[key] === 'deny' ? '' : 'checked'}>
            <label class="form-check-label small" for="cpFeature_${cpEscape(key.replace(/\./g, '_'))}"
                   title="取消勾选 = 对该用户/组禁用此功能">${cpEscape(features[key] || key)}</label>
        </div>`).join('');
}

/** 勾选状态 → {features: {key: allow|deny}}：允许是默认值，只落差异（deny） */
function collectFeatures(root) {
    const features = {};
    root.querySelectorAll('[data-feature-check]').forEach((input) => {
        if (!input.checked) features[input.value] = 'deny';
    });
    return { features };
}

function groupOptions(selectedId) {
    return groups
        .map((group) => `<option value="${group.id}" ${Number(selectedId) === group.id ? 'selected' : ''}>${cpEscape(group.name)}</option>`)
        .join('');
}

function userRowHtml(user) {
    const isSelf = state.user && Number(state.user.id) === Number(user.id);
    const statusBadge = user.status === 'active'
        ? '<span class="badge text-bg-success">启用</span>'
        : '<span class="badge text-bg-secondary">禁用</span>';
    const roleBadge = user.role === 'admin'
        ? '<span class="badge text-bg-danger">管理员</span>'
        : '<span class="badge text-bg-light text-dark border">用户</span>';
    const groupName = user.groupId ? (groups.find((g) => g.id === user.groupId)?.name ?? `#${user.groupId}`) : '—';
    const deniedFeatures = Object.entries(user.permissions?.features ?? {}).filter(([, rule]) => rule === 'deny').map(([key]) => key);
    return `
        <tr data-user-row="${user.id}">
            <td class="small">
                <span class="fw-semibold">${cpEscape(user.username)}</span>${isSelf ? ' <span class="badge text-bg-primary">我</span>' : ''}
                ${user.displayName ? `<div class="text-muted">${cpEscape(user.displayName)}</div>` : ''}
            </td>
            <td class="small">${roleBadge}</td>
            <td class="small">${cpEscape(groupName)}${deniedFeatures.length ? `<div class="text-muted small">限制：${cpEscape(deniedFeatures.join('、'))}</div>` : ''}</td>
            <td class="small">${statusBadge}</td>
            <td class="small text-muted">${user.lastLoginAt ? cpEscape(formatTime(user.lastLoginAt)) : '从未登录'}</td>
            <td class="small text-nowrap">
                <button type="button" class="btn btn-sm btn-outline-secondary" data-user-edit="${user.id}">✏️</button>
                <button type="button" class="btn btn-sm ${user.status === 'active' ? 'btn-outline-warning' : 'btn-outline-success'}"
                        data-user-toggle="${user.id}">${user.status === 'active' ? '🚫' : '✅'}</button>
                <button type="button" class="btn btn-sm btn-outline-danger" data-user-delete="${user.id}" ${isSelf ? 'disabled title="不能删除当前登录的账号"' : ''}>🗑️</button>
            </td>
        </tr>`;
}

function groupRowHtml(group) {
    return `
        <tr data-group-row="${group.id}">
            <td class="small"><span class="fw-semibold">${cpEscape(group.name)}</span>
                ${group.description ? `<div class="text-muted">${cpEscape(group.description)}</div>` : ''}</td>
            <td class="small">${Number(group.memberCount) || 0} 人</td>
            <td class="small text-muted">${Object.entries(group.permissions?.features ?? {}).filter(([, rule]) => rule === 'deny').map(([key]) => key).join('、') || '—'}</td>
            <td class="small text-nowrap">
                <button type="button" class="btn btn-sm btn-outline-secondary" data-group-edit="${group.id}">✏️</button>
                <button type="button" class="btn btn-sm btn-outline-danger" data-group-delete="${group.id}">🗑️</button>
            </td>
        </tr>`;
}

function renderManagement() {
    const host = $('cpUsersBody');
    if (!host) return;
    const userRows = users.map(userRowHtml).join('');
    const groupRows = groups.map(groupRowHtml).join('');
    host.innerHTML = `
        <section class="card mb-3" aria-labelledby="cpUsersListTitle">
            <div class="card-header d-flex flex-wrap justify-content-between align-items-center gap-2">
                <h2 class="h5 mb-0" id="cpUsersListTitle">👥 用户（${users.length}）</h2>
                <button type="button" class="btn btn-sm btn-primary" id="cpUserAddBtn">➕ 添加用户</button>
            </div>
            <div class="card-body p-0">
                <div class="table-responsive">
                    <table class="table align-middle table-hover table-sm mb-0">
                        <thead><tr>
                            <th scope="col">账号</th><th scope="col">角色</th><th scope="col">用户组</th>
                            <th scope="col">状态</th><th scope="col">最近登录</th><th scope="col">操作</th>
                        </tr></thead>
                        <tbody>${userRows || '<tr><td colspan="6" class="text-muted small p-3">暂无用户</td></tr>'}</tbody>
                    </table>
                </div>
            </div>
        </section>

        <section class="card mb-3" aria-labelledby="cpGroupsTitle">
            <div class="card-header d-flex flex-wrap justify-content-between align-items-center gap-2">
                <h2 class="h5 mb-0" id="cpGroupsTitle">👪 用户组（${groups.length}）</h2>
                <button type="button" class="btn btn-sm btn-outline-primary" id="cpGroupAddBtn">➕ 添加用户组</button>
            </div>
            <div class="card-body p-0">
                <div class="table-responsive">
                    <table class="table align-middle table-sm mb-0">
                        <thead><tr>
                            <th scope="col">组名</th><th scope="col">成员</th><th scope="col">功能限制</th><th scope="col">操作</th>
                        </tr></thead>
                        <tbody>${groupRows || '<tr><td colspan="4" class="text-muted small p-3">暂无用户组：组的权限作为一批用户的默认功能限制，用户级配置覆盖组级。</td></tr>'}</tbody>
                    </table>
                </div>
            </div>
        </section>

        <!-- 用户编辑弹窗 -->
        <div class="modal fade" id="cpUserModal" tabindex="-1" aria-hidden="true">
            <div class="modal-dialog modal-dialog-centered">
                <div class="modal-content">
                    <div class="modal-header">
                        <h3 class="modal-title h6" id="cpUserModalTitle">➕ 添加用户</h3>
                        <button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="关闭"></button>
                    </div>
                    <div class="modal-body">
                        <div class="mb-2">
                            <label for="cpUserUsername" class="form-label small mb-1">用户名（2-32 位字母数字下划线连字符）</label>
                            <input type="text" id="cpUserUsername" class="form-control form-control-sm cp-mono" autocomplete="off">
                        </div>
                        <div class="mb-2">
                            <label for="cpUserDisplayName" class="form-label small mb-1">显示名（可选）</label>
                            <input type="text" id="cpUserDisplayName" class="form-control form-control-sm">
                        </div>
                        <div class="mb-2">
                            <label for="cpUserPassword" class="form-label small mb-1" id="cpUserPasswordLabel">密码（至少 6 位）</label>
                            <input type="password" id="cpUserPassword" class="form-control form-control-sm" autocomplete="new-password">
                        </div>
                        <div class="row g-2 mb-2">
                            <div class="col-6">
                                <label for="cpUserRole" class="form-label small mb-1">角色</label>
                                <select id="cpUserRole" class="form-select form-select-sm">
                                    <option value="user">普通用户</option>
                                    <option value="admin">管理员</option>
                                </select>
                            </div>
                            <div class="col-6">
                                <label for="cpUserGroup" class="form-label small mb-1">用户组</label>
                                <select id="cpUserGroup" class="form-select form-select-sm">
                                    <option value="">（无组）</option>
                                    ${groupOptions(null)}
                                </select>
                            </div>
                        </div>
                        <div class="mb-2" id="cpUserStatusWrap" hidden>
                            <label for="cpUserStatus" class="form-label small mb-1">状态</label>
                            <select id="cpUserStatus" class="form-select form-select-sm">
                                <option value="active">启用</option>
                                <option value="disabled">禁用</option>
                            </select>
                        </div>
                        <fieldset class="border rounded p-2">
                            <legend class="small mb-1" style="float:none;width:auto;">功能限制（取消勾选 = 禁用该功能）</legend>
                            <div id="cpUserFeatures">${featuresChecklistHtml()}</div>
                        </fieldset>
                    </div>
                    <div class="modal-footer">
                        <button type="button" class="btn btn-sm btn-outline-secondary" data-bs-dismiss="modal">取消</button>
                        <button type="button" class="btn btn-sm btn-primary" id="cpUserSaveBtn">💾 保存</button>
                    </div>
                </div>
            </div>
        </div>

        <!-- 用户组编辑弹窗 -->
        <div class="modal fade" id="cpGroupModal" tabindex="-1" aria-hidden="true">
            <div class="modal-dialog modal-dialog-centered">
                <div class="modal-content">
                    <div class="modal-header">
                        <h3 class="modal-title h6" id="cpGroupModalTitle">➕ 添加用户组</h3>
                        <button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="关闭"></button>
                    </div>
                    <div class="modal-body">
                        <div class="mb-2">
                            <label for="cpGroupName" class="form-label small mb-1">组名（1-32 字符）</label>
                            <input type="text" id="cpGroupName" class="form-control form-control-sm">
                        </div>
                        <div class="mb-2">
                            <label for="cpGroupDescription" class="form-label small mb-1">描述（可选）</label>
                            <input type="text" id="cpGroupDescription" class="form-control form-control-sm">
                        </div>
                        <fieldset class="border rounded p-2">
                            <legend class="small mb-1" style="float:none;width:auto;">功能限制（取消勾选 = 整组禁用该功能）</legend>
                            <div id="cpGroupFeatures">${featuresChecklistHtml()}</div>
                        </fieldset>
                    </div>
                    <div class="modal-footer">
                        <button type="button" class="btn btn-sm btn-outline-secondary" data-bs-dismiss="modal">取消</button>
                        <button type="button" class="btn btn-sm btn-primary" id="cpGroupSaveBtn">💾 保存</button>
                    </div>
                </div>
            </div>
        </div>`;
}

/** 非管理员 / 未初始化时本页的引导视图 */
function renderGate() {
    const host = $('cpUsersBody');
    if (!host) return;
    if (!state.authEnabled) {
        host.innerHTML = `
            <section class="card mb-3 border-warning" aria-labelledby="cpBootstrapTitle">
                <div class="card-header border-warning">
                    <h2 class="h5 mb-0" id="cpBootstrapTitle">🛡️ 初始化多用户鉴权体系</h2>
                </div>
                <div class="card-body">
                    <p class="small text-muted mb-3">
                        创建首个管理员后，<b>匿名添加数据将被禁止</b>：所有写操作与数据上报都必须携带
                        合法的会话令牌或上报令牌。Surge 上报令牌（PANEL_HIT_TOKEN）不受影响，照常使用。
                    </p>
                    <div class="row g-2">
                        <div class="col-12 col-md-4">
                            <label for="cpBootstrapUsername" class="form-label small mb-1">管理员用户名</label>
                            <input type="text" id="cpBootstrapUsername" class="form-control form-control-sm cp-mono" autocomplete="username">
                        </div>
                        <div class="col-12 col-md-4">
                            <label for="cpBootstrapDisplayName" class="form-label small mb-1">显示名（可选）</label>
                            <input type="text" id="cpBootstrapDisplayName" class="form-control form-control-sm">
                        </div>
                        <div class="col-12 col-md-4">
                            <label for="cpBootstrapPassword" class="form-label small mb-1">密码（至少 6 位）</label>
                            <input type="password" id="cpBootstrapPassword" class="form-control form-control-sm" autocomplete="new-password">
                        </div>
                    </div>
                    <button type="button" class="btn btn-warning mt-3" id="cpBootstrapBtn">🛡️ 创建管理员并登录</button>
                </div>
            </section>`;
        $('cpBootstrapBtn')?.addEventListener('click', bootstrapAndReload);
        return;
    }
    // 已启用：需要管理员登录
    host.innerHTML = `
        <section class="card mb-3" aria-labelledby="cpUsersGateTitle">
            <div class="card-header">
                <h2 class="h5 mb-0" id="cpUsersGateTitle">🔐 需要管理员身份</h2>
            </div>
            <div class="card-body">
                <p class="small text-muted mb-3">
                    用户与权限管理仅对管理员开放。请先登录管理员账号；
                    ${state.user ? `当前登录的 <b>${cpEscape(state.user.username)}</b> 不是管理员。` : '当前未登录。'}
                </p>
                ${state.user
                    ? '<button type="button" class="btn btn-outline-secondary btn-sm" id="cpLogoutHereBtn">🚪 退出登录</button>'
                    : '<button type="button" class="btn btn-primary btn-sm" id="cpLoginHereBtn">🔑 登录</button>'}
            </div>
        </section>`;
    $('cpLoginHereBtn')?.addEventListener('click', openLoginModal);
    $('cpLogoutHereBtn')?.addEventListener('click', async () => {
        const { logout } = await import('./auth.js');
        await logout();
        renderUsersPage();
    });
}

async function bootstrapAndReload() {
    const { bootstrapAdmin } = await import('./auth.js');
    await bootstrapAdmin();
    await refreshAuthState();
    await loadData();
}

async function loadData() {
    try {
        const [usersData, groupsData] = await Promise.all([
            usersRequest('/api/users'),
            usersRequest('/api/groups')
        ]);
        users = usersData.users || [];
        groups = groupsData || [];
        renderManagement();
    } catch (error) {
        if (String(error.message).includes('管理员') || String(error.message).includes('初始化')) {
            renderGate();
            return;
        }
        const host = $('cpUsersBody');
        if (host) host.innerHTML = `<div class="alert alert-danger small">用户数据加载失败：${cpEscape(error.message)}</div>`;
    }
}

/* ------------------------------ 用户弹窗 ------------------------------ */

function openUserModal(user = null) {
    editingUserId = user ? user.id : null;
    $('cpUserModalTitle').textContent = user ? `✏️ 编辑用户：${user.username}` : '➕ 添加用户';
    $('cpUserUsername').value = user ? user.username : '';
    $('cpUserUsername').disabled = Boolean(user);
    $('cpUserDisplayName').value = user ? user.displayName || '' : '';
    $('cpUserPassword').value = '';
    $('cpUserPasswordLabel').textContent = user ? '密码（留空 = 不修改）' : '密码（至少 6 位）';
    $('cpUserRole').value = user ? user.role : 'user';
    $('cpUserGroup').innerHTML = `<option value="">（无组）</option>${groupOptions(user ? user.groupId : null)}`;
    $('cpUserGroup').value = user?.groupId ? String(user.groupId) : '';
    $('cpUserStatusWrap').hidden = !user;
    if (user) $('cpUserStatus').value = user.status;
    $('cpUserFeatures').innerHTML = featuresChecklistHtml(user || {});
    if (window.bootstrap) window.bootstrap.Modal.getOrCreateInstance($('cpUserModal')).show();
}

async function saveUser() {
    const body = {
        username: $('cpUserUsername').value.trim(),
        displayName: $('cpUserDisplayName').value.trim(),
        role: $('cpUserRole').value,
        groupId: $('cpUserGroup').value ? Number($('cpUserGroup').value) : null,
        ...collectFeatures($('cpUserFeatures'))
    };
    const password = $('cpUserPassword').value;
    if (editingUserId) {
        if (password) body.password = password;
        body.status = $('cpUserStatus').value;
        await usersRequest(`/api/users/${editingUserId}`, { method: 'PATCH', body });
        cpToast('用户已更新', 'success');
    } else {
        if (!password) {
            cpToast('请填写密码', 'warning');
            return;
        }
        body.password = password;
        await usersRequest('/api/users', { method: 'POST', body });
        cpToast('用户已创建', 'success');
    }
    if (window.bootstrap) window.bootstrap.Modal.getInstance($('cpUserModal'))?.hide();
    await loadData();
}

async function toggleUser(id) {
    const user = users.find((item) => Number(item.id) === Number(id));
    if (!user) return;
    const next = user.status === 'active' ? 'disabled' : 'active';
    await usersRequest(`/api/users/${id}`, { method: 'PATCH', body: { status: next } });
    cpToast(next === 'disabled' ? '用户已禁用（其会话已全部失效）' : '用户已启用', 'success');
    await loadData();
}

async function deleteUser(id) {
    const user = users.find((item) => Number(item.id) === Number(id));
    if (!user) return;
    if (!window.confirm(`确定删除用户「${user.username}」？该操作不可恢复。`)) return;
    await usersRequest(`/api/users/${id}`, { method: 'DELETE' });
    cpToast('用户已删除', 'success');
    await loadData();
}

/* ------------------------------ 组弹窗 ------------------------------ */

function openGroupModal(group = null) {
    editingGroupId = group ? group.id : null;
    $('cpGroupModalTitle').textContent = group ? `✏️ 编辑用户组：${group.name}` : '➕ 添加用户组';
    $('cpGroupName').value = group ? group.name : '';
    $('cpGroupDescription').value = group ? group.description || '' : '';
    $('cpGroupFeatures').innerHTML = featuresChecklistHtml(group || {});
    if (window.bootstrap) window.bootstrap.Modal.getOrCreateInstance($('cpGroupModal')).show();
}

async function saveGroup() {
    const body = {
        name: $('cpGroupName').value.trim(),
        description: $('cpGroupDescription').value.trim(),
        ...collectFeatures($('cpGroupFeatures'))
    };
    if (editingGroupId) {
        await usersRequest(`/api/groups/${editingGroupId}`, { method: 'PATCH', body });
        cpToast('用户组已更新', 'success');
    } else {
        await usersRequest('/api/groups', { method: 'POST', body });
        cpToast('用户组已创建', 'success');
    }
    if (window.bootstrap) window.bootstrap.Modal.getInstance($('cpGroupModal'))?.hide();
    await loadData();
}

async function deleteGroup(id) {
    const group = groups.find((item) => Number(item.id) === Number(id));
    if (!group) return;
    if (!window.confirm(`确定删除用户组「${group.name}」？组内用户将被解绑（不删除用户）。`)) return;
    await usersRequest(`/api/groups/${id}`, { method: 'DELETE' });
    cpToast('用户组已删除', 'success');
    await loadData();
}

/** 管理面事件委托：绑定在持久的页面容器上（内容重渲染不重复绑定），表格按钮 + 弹窗保存按钮 */
function wireManagement() {
    const page = $('cpPage-users');
    if (!page || page.dataset.usersWired === '1') return;
    page.dataset.usersWired = '1';
    page.addEventListener('click', async (event) => {
        const userAdd = event.target.closest('#cpUserAddBtn');
        if (userAdd) return openUserModal(null);
        const groupAdd = event.target.closest('#cpGroupAddBtn');
        if (groupAdd) return openGroupModal(null);

        const userEdit = event.target.closest('[data-user-edit]');
        if (userEdit) return openUserModal(users.find((u) => Number(u.id) === Number(userEdit.dataset.userEdit)));
        const groupEdit = event.target.closest('[data-group-edit]');
        if (groupEdit) return openGroupModal(groups.find((g) => Number(g.id) === Number(groupEdit.dataset.groupEdit)));

        const toggle = event.target.closest('[data-user-toggle]');
        if (toggle) {
            try { await toggleUser(toggle.dataset.userToggle); } catch (error) { cpToast(error.message, 'danger'); }
            return;
        }
        const del = event.target.closest('[data-user-delete]');
        if (del) {
            try { await deleteUser(del.dataset.userDelete); } catch (error) { cpToast(error.message, 'danger'); }
            return;
        }
        const groupDel = event.target.closest('[data-group-delete]');
        if (groupDel) {
            try { await deleteGroup(groupDel.dataset.groupDelete); } catch (error) { cpToast(error.message, 'danger'); }
        }
    });
    page.addEventListener('click', (event) => {
        if (event.target.closest('#cpUserSaveBtn')) {
            saveUser().catch((error) => cpToast(error.message, 'danger'));
        }
        if (event.target.closest('#cpGroupSaveBtn')) {
            saveGroup().catch((error) => cpToast(error.message, 'danger'));
        }
    });
}

/** 用户页入口：按身份渲染引导或管理面（nav 切页广播触发） */
export function renderUsersPage() {
    const canManage = state.isAdmin || !state.authEnabled;
    if (canManage) {
        loadData();
    } else {
        renderGate();
    }
}

/** 初始化：绑定管理面事件（一次）并监听页面切换与身份变化 */
export function initUsersView() {
    wireManagement();
    document.addEventListener('cp:page', (event) => {
        if (event.detail === 'users') renderUsersPage();
    });
    document.addEventListener('cp:auth', () => {
        users = [];
        groups = [];
        if (state.tab === 'users') renderUsersPage();
    });
}

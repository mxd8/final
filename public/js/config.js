/**
 * 面板配置常量与全局状态。
 */

export const CP_CONFIG = {
    apiBase: '/api/logger',
    subscribeBase: '/api/subscribe',
    timeoutMs: 15000,
    // 订阅解析：后端带重试总预算 30 秒，前端超时按 45 秒放宽，避免后端还在重试前端先断
    parseTimeoutMs: 45000,
    // 批量覆盖后端分块串行提交，按 15 秒通用超时会稳定超时，单独放宽
    batchTimeoutMs: 120000,
    batchMaxLines: 1500,
    searchDebounceMs: 300,
    summaryDebounceMs: 300,
    defaultPageSize: 50,
    emptyRuleText: '# 暂无符合条件的规则',
    writeTokenKey: 'panel_write_token'
};

/** 面板可记忆的偏好默认值，与 app_prefs 表中的键一一对应 */
export const CP_DEFAULTS = {
    pageSize: CP_CONFIG.defaultPageSize,
    sort: 'time-desc',
    policyFilter: 'ALL',
    typeFilter: 'ALL',
    sourceFilter: '',
    search: '',
    exportType: 'all'
};

/** 默认提示词：复制纯匹配值时置顶，方便直接发给 AI 分流 */
export const CP_DEFAULT_PROMPT =
    '帮我分流，只可使用 DIRECT、PROXY、REJECT 3 种策略，每行后面写上简短注释\n' +
    '回复格式如下\nDOMAIN-SUFFIX,域名或IP,策略 //注释内容';

export const CP_BUILTIN_POLICIES = ['PROXY', 'DIRECT', 'REJECT'];

/** 策略徽标配色（iOS 系统色板），只用于视觉区分 */
export const CP_POLICY_COLORS = { PROXY: '#007aff', DIRECT: '#248a3d', REJECT: '#e5382f' };

/** 主题色板：每色一组浅色 / 深色令牌，nav.js 写到根元素后由主题层桥接 Bootstrap */
export const CP_ACCENT_DEFAULT = '#007aff';
export const CP_ACCENTS = {
    '#007aff': {
        label: '🔵 蓝色',
        vars: {
            '--cp-accent': '#007aff', '--cp-accent-rgb': '0,122,255', '--cp-accent-text': '#0064d2',
            '--cp-accent-dark': '#0a84ff', '--cp-accent-dark-rgb': '10,132,255', '--cp-accent-dark-text': '#409cff'
        }
    },
    '#5856d6': {
        label: '🟣 靛蓝',
        vars: {
            '--cp-accent': '#5856d6', '--cp-accent-rgb': '88,86,214', '--cp-accent-text': '#4a48c8',
            '--cp-accent-dark': '#5e5ce6', '--cp-accent-dark-rgb': '94,92,230', '--cp-accent-dark-text': '#8a88ff'
        }
    },
    '#af52de': {
        label: '🟪 紫色',
        vars: {
            '--cp-accent': '#af52de', '--cp-accent-rgb': '175,82,222', '--cp-accent-text': '#9a3fc6',
            '--cp-accent-dark': '#bf5af2', '--cp-accent-dark-rgb': '191,90,242', '--cp-accent-dark-text': '#c77af5'
        }
    },
    '#ff2d55': {
        label: '❤️ 粉色',
        vars: {
            '--cp-accent': '#ff2d55', '--cp-accent-rgb': '255,45,85', '--cp-accent-text': '#d40046',
            '--cp-accent-dark': '#ff375f', '--cp-accent-dark-rgb': '255,55,95', '--cp-accent-dark-text': '#ff7d97'
        }
    },
    '#32ade6': {
        label: '🩵 青色',
        vars: {
            '--cp-accent': '#32ade6', '--cp-accent-rgb': '50,173,230', '--cp-accent-text': '#0d7683',
            '--cp-accent-dark': '#64d2ff', '--cp-accent-dark-rgb': '100,210,255', '--cp-accent-dark-text': '#7dd8ff'
        }
    }
};

/** 导出的策略类型快捷按钮与固定订阅地址 policy 参数的对应关系（顺序即按钮顺序） */
export const CP_EXPORT_TYPES = ['all', 'proxy', 'direct', 'reject'];

/** 命中次数过滤的快捷档位（筛选配置弹窗里用） */
export const CP_MIN_COUNT_PRESETS = [10, 50, 100];

/** 最近命中时间过滤的快捷档位（天） */
export const CP_LAST_DAYS_PRESETS = [10, 15, 30, 180, 360];

/** 订阅解析的并发数：太高打满 Workers 连接数，太低感觉不到批量优势 */
export const CP_SUBSCRIBE_CONCURRENCY = 3;

/** 单条通知的停留时间：错误停留更久，提示里要指出具体错在哪 */
export const CP_TOAST_DURATION = { danger: 9000, warning: 6000 };
export const CP_TOAST_DEFAULT_MS = 4000;

/** 错误日志最多保留多少条，防止长时间使用把内存撑爆 */
export const CP_ERROR_LIMIT = 200;

export const state = {
    logs: [],
    /** 全量规则（不带筛选）：Gist 备份与订阅去重用；按需加载，allLogsStale 标记过期 */
    allLogs: [],
    allLogsStale: false,
    stats: null,
    currentPage: 1,
    pageSize: CP_CONFIG.defaultPageSize,
    search: '',
    policyFilter: 'ALL',
    typeFilter: 'ALL',
    sourceFilter: '',
    sort: 'time-desc',
    exportType: 'all',
    /** 全局导出筛选（user=export）：改配置不改固定订阅地址 */
    exportMinCount: 0,
    /** 全局导出筛选：最近 N 天命中；0 表示不过滤 */
    exportLastDays: 0,
    /** 策略按钮上的实时数量（导出摘要刷新时更新） */
    exportCounts: null,
    /** 后端是否启用了写接口鉴权；由 /meta 返回的 writeAuthRequired 决定 */
    writeAuthRequired: false,
    /** 服务端版本清单（meta.version）：serverVersion / components / dbSchemaVersion */
    serverInfo: null,
    busy: false,
    editing: null,
    meta: null,
    subscriptions: [],
    subscriptionsLoading: false,
    tab: 'home',
    /** 导航位置：top=顶栏内嵌，bottom=固定底部 TabBar（设置页切换） */
    navPosition: 'top',
    /** 表格排序：默认按最近命中倒序 */
    tableSort: { key: 'time', dir: 'desc' },
    /** 填充订阅时选定的补全策略，空串表示保持订阅原策略 */
    fillPolicy: ''
};

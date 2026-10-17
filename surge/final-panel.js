/**
 * FINAL 统计面板（Surge 面板脚本，type=generic，供 final.sgmodule 的 [Panel] 引用）。
 * 从中转后端读实时数据渲染 [Panel]，无本地持久化。
 *
 * 配置经 [Script] 行的 argument= 传入（模块参数表 {{{参数}}} 自动填充，
 * 竖线 | 分隔、按位可留空）：
 *   1. FINAL_WEB_URL   网页管理面板地址（必填，智能识别：自动补全 /api/logger
 *                      得到中转地址；误填接口地址也能识别回去用于展示）
 *   2. FINAL_DB_TOKEN  上报令牌（必填，与后端环境变量 PANEL_HIT_TOKEN 一致；
 *                      面板自身匿名读取用不到，只负责下发给捕获脚本）
 *   3. FINAL_POLICY    捕获脚本记录用策略名，默认 PROXY（面板只负责转发）
 *   4. FINAL_USER      用户组 / 用户名（可选，多设备场景区分设备归属，
 *                      随心跳上报并写入持久化下发给捕获脚本）
 *   5. FINAL_REFRESH   面板刷新间隔秒数（默认 600，参与服务端在线状态判定）
 *
 * 面板刷新时会把配置写入 Surge 持久化（显式键 final_db_config，官方
 * $persistentStore 支持跨脚本共享）：final-logger 捕获脚本只支持本地文件
 * （经模块模板 final-logger-src 在脚本编辑器中另存部署），从同一键读取配置——
 * 模块参数表填一次，两端脚本共用。
 *
 * 多设备识别（v1.2）：心跳在既有 /stats 请求上额外捎带设备型号（$environment
 * device-model）与用户名；来源 IP 由中转后端从请求连接捕获解析——同型号多设备
 * 靠 用户名 + 来源 IP 区分。/stats 响应的 deviceSummary 携带在线统计（n/m）
 * 与分级告警（校验失败 / 配置过期 / 离线），面板正文直接渲染。
 */

function trim(value) {
    return value ? String(value).trim() : "";
}

function parseArgument(raw) {
    var text = typeof raw === "string" ? raw : "";
    if (text.indexOf("|") > -1) {
        var slots = text.split("|");
        for (var i = 0; i < slots.length; i++) slots[i] = trim(slots[i]);
        return slots;
    }
    var args = [];
    var segs = text.split(/\s+/);
    for (var j = 0; j < segs.length; j++) {
        if (trim(segs[j])) args.push(trim(segs[j]));
    }
    return args;
}

var args = parseArgument(typeof $argument === "undefined" ? "" : $argument);
var rawUrl = args[0] || "";
var dbToken = args[1] || "";
var capturePolicy = args[2] || "PROXY";
var username = args[3] || "";
var refreshSeconds = Math.max(0, Math.floor(Number(args[4]) || 0)) || 600;

var isHttps = /^https:\/\//.test(rawUrl);

/** 网页面板地址 → 中转后端地址：已含 /api/logger 原样返回，否则自动补全 */
function toApiUrl(url) {
    var clean = url.replace(/\/+$/, "");
    return clean.indexOf("/api/logger") > -1 ? clean : clean + "/api/logger";
}

/** 中转后端地址 → 网页面板地址（用户把接口地址填进 FINAL_WEB_URL 时识别回去展示） */
function toWebUrl(url) {
    var clean = url.replace(/\/+$/, "");
    var idx = clean.indexOf("/api/logger");
    return idx > -1 ? clean.slice(0, idx) : clean;
}

var dbUrl = isHttps ? toApiUrl(rawUrl) : "";
var webUrl = isHttps ? toWebUrl(rawUrl) : "";

/** 脚本版本：随仓库发版注入（scripts/inject-version.mjs），上报与版本比对以此为准 */
var SCRIPT_VERSION = "1.2.0";

/** 把配置写入持久化，供本地部署的 final-logger 捕获脚本跨脚本读取（变更才落盘） */
var CONFIG_KEY = "final_db_config";
/** 捕获脚本本地副本自报版本所在的键（由 final-logger 写入，面板只读） */
var LOGGER_META_KEY = "final_logger_meta";

/** 读持久化配置（损坏返回空对象，读端自行兜底） */
function readStoreConfig() {
    var raw = null;
    try {
        if (typeof $persistentStore !== "undefined" && $persistentStore) raw = $persistentStore.read(CONFIG_KEY);
    } catch (error) {}
    if (!raw) return {};
    try {
        var config = JSON.parse(raw);
        return config && typeof config === "object" ? config : {};
    } catch (error) {
        return {};
    }
}

function writeStoreConfig(config) {
    try {
        var json = JSON.stringify(config);
        if ($persistentStore.read(CONFIG_KEY) !== json) {
            $persistentStore.write(json, CONFIG_KEY);
            console.log("[FINAL] 配置已写入持久化（" + CONFIG_KEY + "），供捕获脚本读取");
        }
    } catch (error) {
        console.log("[FINAL] 配置写入持久化失败：" + error);
    }
}

/** 客户端标识：首次生成随机标识并持久化于 final_db_config，不采集个人信息 */
function randomClientId() {
    var id = "panel-";
    for (var i = 0; i < 12; i++) id += Math.floor(Math.random() * 16).toString(16);
    return id;
}

function ensureClientId() {
    var config = readStoreConfig();
    if (config.clientId) return config.clientId;
    config.clientId = randomClientId();
    writeStoreConfig(config);
    return config.clientId;
}

function persistConfig() {
    if (!dbUrl || typeof $persistentStore === "undefined" || !$persistentStore) return;
    // 读旧值合并：保留已有的 clientId，不覆盖捕获脚本或历史版本写入的其他字段
    var config = readStoreConfig();
    config.dbUrl = dbUrl;
    config.dbToken = dbToken;
    config.policy = capturePolicy;
    if (username) config.username = username;
    if (!config.clientId) config.clientId = randomClientId();
    writeStoreConfig(config);
}

/** 设备型号：官方 $environment["device-model"]，多设备识别用（拿不到留空） */
function deviceModel() {
    try {
        if (typeof $environment !== "undefined" && $environment) {
            return trim($environment["device-model"]);
        }
    } catch (error) {}
    return "";
}

/** 读捕获脚本写入的版本自报（final_logger_meta）：{version, latest, at} */
function readLoggerMeta() {
    var raw = null;
    try {
        if (typeof $persistentStore !== "undefined" && $persistentStore) raw = $persistentStore.read(LOGGER_META_KEY);
    } catch (error) {}
    if (!raw) return null;
    try {
        var meta = JSON.parse(raw);
        return meta && typeof meta === "object" ? meta : null;
    } catch (error) {
        return null;
    }
}

function finishPanel(content) {
    $done({
        title: "⚡ FINAL 流量与规则统计",
        content: content,
        icon: "chart.bar.fill",
        "icon-color": "#0071e3"
    });
}

/** 版本行：面板脚本与捕获脚本（本地副本）的版本与落后提示 */
function versionText(versionInfo) {
    var latest = versionInfo.latest;
    var text = "🧭 版本: 面板 " + SCRIPT_VERSION;
    if (latest && latest.panel && latest.panel !== SCRIPT_VERSION) {
        text += " → " + latest.panel + "（更新模块后自动恢复）";
    }
    var loggerMeta = versionInfo.loggerMeta;
    if (loggerMeta && loggerMeta.version) {
        text += "  |  捕获 " + loggerMeta.version;
        if (loggerMeta.latest && loggerMeta.latest !== loggerMeta.version) {
            text += " ⚠️ 落后，请重新另存本地脚本";
        }
    }
    return text;
}

/** 告警分级图标：severity 由服务端排好序（校验失败 → 配置过期 → 离线） */
function alertIcon(level) {
    if (level === "danger") return "🔴";
    if (level === "warning") return "🟠";
    return "⚪";
}

/** 设备行文本：在线统计（n/m）+ 每台告警设备一行（截断到 3 行防面板溢出） */
function deviceText(deviceSummary) {
    var summary = deviceSummary || {};
    var total = Number(summary.total) || 0;
    var online = Number(summary.online) || 0;
    var alerts = summary.alerts || [];
    if (!total) return "";
    var text = "📱 设备在线: " + online + "/" + total;
    for (var i = 0; i < alerts.length && i < 3; i++) {
        var label = trim(alerts[i].name) || "未知设备";
        if (trim(alerts[i].username)) label += "（" + trim(alerts[i].username) + "）";
        text += "\n" + alertIcon(alerts[i].level) + " " + label + " " + trim(alerts[i].message);
    }
    if (alerts.length > 3) {
        text += "\n… 另有 " + (alerts.length - 3) + " 条告警，见网页面板";
    }
    return text;
}

/** 统计并排版，中转后端 /stats 聚合结果直接喂进这里 */
function render(stats, statusText, versionInfo) {
    versionInfo = versionInfo || {};
    var totalRules = Number(stats.totalRules) || 0;
    var totalHits = Number(stats.totalHits) || 0;
    var proxyCount = Number(stats.proxyCount) || 0;
    var directCount = Number(stats.directCount) || 0;
    var rejectCount = Number(stats.rejectCount) || 0;
    var todayNew = Number(stats.todayNew) || 0;
    var emptyCommentCount = Number(stats.emptyCommentCount) || 0;

    var typeMap = {};
    var sourceMap = {};
    var hasSource = false;
    var types = stats.types || [];
    var sources = stats.sources || [];

    for (var i = 0; i < types.length; i++) {
        typeMap[trim(types[i].name) || "DOMAIN-SUFFIX"] = Number(types[i].count) || 0;
    }
    for (var j = 0; j < sources.length; j++) {
        var name = trim(sources[j].name);
        // 「未标注」是服务端聚合出的空来源桶，不属于任何设备
        if (name && name !== "未标注") {
            hasSource = true;
            sourceMap[name] = Number(sources[j].count) || 0;
        }
    }

    var devices = deviceText(stats.deviceSummary);

    var content =
        "📦 规则总数: " + totalRules + " 条  (💬 无备注: " + emptyCommentCount + ")\n" +
        "🔥 触发总计: " + totalHits + " 次  |  📅 今日新增: " + todayNew + " 条\n" +
        "🌐 代理: " + proxyCount + "  |  🟢 直连: " + directCount + "  |  🔴 拦截: " + rejectCount + "\n" +
        "----------------------------------------\n" +
        "🧩 规则类型: " + mapText(typeMap) + "\n" +
        (devices ? devices + "\n" : "") +
        (hasSource ? "📥 命中来源: " + mapText(sourceMap) + "\n" : "") +
        versionText(versionInfo) + "\n" +
        "[" + new Date().toLocaleTimeString() + "] " + statusText + "\n" +
        "🔗 后端: " + (dbUrl.split("/")[2] || dbUrl);

    if (webUrl) {
        content += "\n📱 网页面板: " + webUrl;
    }
    finishPanel(content);
}

/** 把 { 名称: 数量 } 转成一行文本，数量多的排在前面 */
function mapText(map) {
    var names = Object.keys(map).sort(function (a, b) {
        return map[b] - map[a];
    });
    return names.map(function (name) {
        return name + " " + map[name];
    }).join("  ");
}

/** 走中转后端：GET 匿名只读接口，/stats 一次聚合出全部统计数字，
  * 不再拉整份规则列表（原实现拉 5000 行只为算 6 个数字）。
  */
function loadFromApi() {
    // 心跳捎带：既有数据请求顺带上报客户端标识、版本、设备型号与用户名（零新增请求），
    // 鉴权走上报令牌（FINAL_DB_TOKEN，与面板数据同源）；服务端据此维护
    // client_heartbeats（版本握手）与 devices（在线状态 / 配置告警）两张注册表
    var options = {
        url: dbUrl + "/stats",
        headers: {
            "Authorization": "Bearer " + dbToken,
            "X-Final-Client": ensureClientId(),
            "X-Final-Version": SCRIPT_VERSION,
            "X-Final-Logger": (readLoggerMeta() || {}).version || "",
            "X-Final-Device": deviceModel(),
            "X-Final-User": username,
            "X-Final-Refresh": String(refreshSeconds)
        }
    };
    $httpClient.get(options, function (error, response, data) {
        if (error || !response || response.status < 200 || response.status >= 300 || !data) {
            var fail = "❌ 查询失败：" + (error || (response ? response.status : "无响应"));
            console.log("[FINAL] 查询失败：" + fail);
            return render({}, fail, { latest: null, loggerMeta: readLoggerMeta() });
        }

        var stats = {};
        var latest = null;
        try {
            var body = JSON.parse(data);
            stats = body && body.data ? body.data : {};
            latest = stats.latest || null;
        } catch (error2) {
            console.log("[FINAL] 解析 API 响应失败：" + error2);
        }
        render(stats, "✅ 数据统计正常", { latest: latest, loggerMeta: readLoggerMeta() });
    });
}

// ---- 入口分发：未配置 / 地址不对 / 缺令牌时明确提示，不回落本地持久化 ----
if (!rawUrl) {
    finishPanel(
        "⚠️ 未配置面板地址\n" +
        "----------------------------------------\n" +
        "请在模块参数里填 FINAL_WEB_URL（网页管理面板地址），中转地址自动补全。\n" +
        "配置方式见 readme「Surge 安装教程」。"
    );
} else if (!isHttps) {
    finishPanel("⚠️ FINAL_WEB_URL 格式不正确\n----------------------------------------\n应为网页面板地址，如 https://xxx.pages.dev");
} else if (!dbToken) {
    finishPanel("⚠️ 未配置上报令牌\n----------------------------------------\n请在模块参数里填 FINAL_DB_TOKEN（上报令牌，与后端环境变量 PANEL_HIT_TOKEN 一致，必填）。");
} else {
    // 配置完整才落持久化（含捕获脚本用的令牌与策略名），再渲染统计
    persistConfig();
    loadFromApi();
}

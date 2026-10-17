/**
 * FINAL 捕获脚本（Surge 规则脚本，type=rule）。
 * 在 [Rule] 里以 SCRIPT,final-logger,<策略> 触发，把 FINAL 命中连同设备来源一起
 * 经中转后端写入数据库。
 *
 * Surge 规则脚本只支持本地文件：FINAL 模块把本文件引用为模板 final-logger-src，
 * 在 Surge 脚本编辑器中打开它并保存为新文件（命名 final-logger）即完成部署，
 * 配置无需写进脚本本体——由面板模块下发到持久化，本脚本自动读取。
 *
 * 配置按优先级读取：
 *   1. Surge 持久化键 final_db_config——FINAL 模块的面板在刷新时
 *      写入的 JSON（dbUrl / dbToken / policy / username / clientId），在模块参数表里填一次即可；
 *   2. [Script] 行 argument=（竖线分隔、按位可留空，兼容旧式空格分隔），编辑器调试兜底。
 * 字段含义：
 *   dbUrl 填网页面板地址或 /api/logger 接口地址均可（自动补全 /api/logger，
 *   写库走其 /hits 批量子路径）；dbToken 是上报令牌（必填，与后端环境变量
 *   PANEL_HIT_TOKEN 一致）；记录用策略名默认 PROXY——Surge 不向规则脚本
 *   暴露命中策略，需与 SCRIPT 行的策略一致；username 是用户组 / 用户名
 *   （多设备场景区分设备归属，v1.2 新增）。
 *
 * 设备来源取官方 API $environment["device-model"]（iOS 5.9+/Mac 5.5+）；
 * 来源 IP 由中转后端从请求连接捕获解析（脚本拿不到自己的公网出口 IP），
 * 同型号多设备靠 用户名 + 来源 IP 区分，上报头携带 clientId / 设备型号 / 用户名。
 *
 * 上报合并（重要）：脚本本体每次命中都会被拉起，直接逐条发请求会让写 QPS 与
 * 未命中流量成正比。这里用持久化键 final_hit_buffer 做跨触发的去重窗口——
 * 同一主机名在窗口内只累计次数，攒满条数或窗口到期才一次性 POST /hits 批量上报；
 * 上报失败把整批放回缓冲，下次命中自动补报（at-least-once）。
 * 大多数触发因此不再发网络请求，代理链路不再被上报拖慢。
 *
 * 健壮性：参数缺失、网络失败、后端报错全部静默放行——
 * 写库失败绝不能影响代理流量的正常转发。
 */

/** 脚本版本：随仓库发版注入（scripts/inject-version.mjs），与响应捎带的 latestLoggerVersion 比对 */
var SCRIPT_VERSION = "1.4.0";
var CONFIG_KEY = "final_db_config";
/** 版本自报键：上报响应捎带 latestLoggerVersion 时写入，面板读取后展示升级提示 */
var LOGGER_META_KEY = "final_logger_meta";
var BUFFER_KEY = "final_hit_buffer";
var BUFFER_VERSION = 1;

/** 窗口期：同一主机名 5 秒内的重复命中只累计次数，不发请求 */
var FLUSH_WINDOW_MS = 5000;
/** 缓冲攒满多少个不同主机名就立即上报（防止长时间低频流量一直挂着） */
var FLUSH_MAX_ENTRIES = 20;
/** 上报超时：代理链路上挂 5 秒太久，3 秒内没完成就放弃（失败会进缓冲补报） */
var REQUEST_TIMEOUT = 3;
/** DNS 解析失败占位：不是真实命中，上报只会污染计数，跳过 */
var DNS_FAILED_PLACEHOLDER = "Unresolved Domain (DNS Failed)";

function trim(value) {
    return value ? String(value).trim() : "";
}

function inferTypeFromHost(host) {
    if (!host) return "";
    if (host.indexOf(":") > -1) return "IP-CIDR6";
    if (/^(\d{1,3}\.){3}\d{1,3}(\/\d{1,3})?$/.test(host)) return "IP-CIDR";
    return "DOMAIN-SUFFIX";
}

/** 解析 argument=：竖线分隔时保留空位（按位取参），空格分隔时丢弃空段（旧式参数） */
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

function deviceSource() {
    try {
        if (typeof $environment !== "undefined" && $environment) {
            return trim($environment["device-model"]);
        }
    } catch (e) {}
    return "";
}

/** 面板模块写入的配置键：显式 key 跨脚本共享（官方 $persistentStore 语义） */
function readStore(key) {
    try {
        if (typeof $persistentStore === "undefined" || !$persistentStore) return null;
        return $persistentStore.read(key);
    } catch (error) {
        return null;
    }
}

function writeStore(key, value) {
    try {
        if (typeof $persistentStore === "undefined" || !$persistentStore) return;
        $persistentStore.write(value, key);
    } catch (error) {}
}

function readStoreConfig() {
    var raw = readStore(CONFIG_KEY);
    if (!raw) return null;
    try {
        var config = JSON.parse(raw);
        if (config && typeof config === "object") return config;
    } catch (error) {}
    return null;
}

/** 读取命中缓冲：{v, hits: {hostname: {count, type, value, source, policy, params, since}}} */
function readBuffer() {
    var raw = readStore(BUFFER_KEY);
    if (!raw) return { v: BUFFER_VERSION, hits: {} };
    try {
        var parsed = JSON.parse(raw);
        if (parsed && parsed.v === BUFFER_VERSION && parsed.hits && typeof parsed.hits === "object") {
            return parsed;
        }
    } catch (error) {}
    // 半写入或旧格式：直接重置，宁可少一批也不带着脏结构跑
    return { v: BUFFER_VERSION, hits: {} };
}

/** 缓冲 → 上报条目列表：hostname 存在键上，展开进条目本身 */
function bufferEntries(buffer) {
    var entries = [];
    for (var host in buffer.hits) {
        if (Object.prototype.hasOwnProperty.call(buffer.hits, host)) {
            var entry = buffer.hits[host];
            entry.hostname = host;
            entries.push(entry);
        }
    }
    return entries;
}

function oldestSince(buffer) {
    var oldest = 0;
    for (var host in buffer.hits) {
        if (!Object.prototype.hasOwnProperty.call(buffer.hits, host)) continue;
        var since = Number(buffer.hits[host].since) || 0;
        if (!oldest || since < oldest) oldest = since;
    }
    return oldest;
}

/** 把一批条目合并回缓冲（上报失败补报用）：同主机名次数相加 */
function mergeEntriesBack(buffer, entries) {
    for (var i = 0; i < entries.length; i++) {
        var entry = entries[i];
        var existing = buffer.hits[entry.hostname];
        if (existing) {
            existing.count += entry.count;
        } else {
            buffer.hits[entry.hostname] = entry;
        }
    }
}

/** 版本握手：响应捎带 latestLoggerVersion 时落盘，面板据此提示「重新另存本地脚本」。
  * 版本信息（version/latest）未变化时不重复落盘，时间戳只在内容变化时刷新。
  */
function noteLoggerVersion(rawBody) {
    try {
        var body = JSON.parse(rawBody);
        var latest = body && body.data && body.data.latestLoggerVersion;
        if (!latest) return;
        latest = String(latest);
        var existing = null;
        try {
            existing = JSON.parse(readStore(LOGGER_META_KEY) || "null");
        } catch (error) {}
        if (existing && existing.version === SCRIPT_VERSION && existing.latest === latest) return;
        writeStore(LOGGER_META_KEY, JSON.stringify({ version: SCRIPT_VERSION, latest: latest, at: Date.now() }));
        if (latest !== SCRIPT_VERSION) {
            console.log("[FINAL] 捕获脚本有新版本 " + latest + "（当前 " + SCRIPT_VERSION + "），请在脚本编辑器重新另存本地脚本");
        }
    } catch (error) {}
}

/** 批量上报：POST /api/logger/hits，一次请求提交整组命中 */
function flushHits(endpoint, authToken, entries, device) {
    var hits = [];
    for (var i = 0; i < entries.length; i++) {
        hits.push({
            hostname: entries[i].hostname,
            count: entries[i].count,
            type: entries[i].type,
            value: entries[i].value,
            source: entries[i].source,
            policy: entries[i].policy,
            params: entries[i].params,
            username: device.username
        });
    }
    var headers = {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + authToken,
        // 设备上下文随请求头捎带：clientId 复用面板下发的标识（同设备两脚本一致），
        // 来源 IP 由服务端从请求连接捕获，设备注册表据此维护在线状态与配置告警
        "X-Final-Client": device.clientId || "",
        "X-Final-Device": device.name || "",
        "X-Final-User": device.username || "",
        "X-Final-Logger": SCRIPT_VERSION
    };
    var body = JSON.stringify({ hits: hits, username: device.username || "" });

    try {
        // 官方 HTTP 客户端是 $httpClient，回调签名 (error, response, data)，状态码在 response.status
        $httpClient.post({ url: endpoint + "/hits", headers: headers, body: body, timeout: REQUEST_TIMEOUT }, function (error, response, data) {
            var status = response ? response.status : 0;
            if (error || status < 200 || status >= 300) {
                // 上报失败：整批放回缓冲，下次命中或下次触发窗口时自动补报
                var buffer = readBuffer();
                mergeEntriesBack(buffer, entries);
                writeStore(BUFFER_KEY, JSON.stringify(buffer));
                console.log("[FINAL] 批量写库失败（已进缓冲待补报，共 " + hits.length + " 项）：" + (error || status));
            } else {
                console.log("[FINAL] 已批量记录：" + hits.length + " 个主机名 / " + entries.reduce(function (sum, e) { return sum + e.count; }, 0) + " 次命中");
                noteLoggerVersion(data);
            }
            $done({ matched: true });
        });
    } catch (error) {
        // 请求构造失败也要放行，不能因为写库异常打断代理链路
        var buffer = readBuffer();
        mergeEntriesBack(buffer, entries);
        writeStore(BUFFER_KEY, JSON.stringify(buffer));
        console.log("[FINAL] 写库异常（已进缓冲待补报）：" + error);
        $done({ matched: true });
    }
}

function main() {
    // 规则脚本输入只有 $request（hostname/destPort/protocol 等请求字段），
    // 没有 matched/rule 字段：FINAL 兜底规则本身没有匹配值，以主机名代指命中目标
    var request = (typeof $request !== "undefined" && $request) ? $request : {};
    var target = trim(request.hostname);

    var stored = readStoreConfig();
    var args = parseArgument(typeof $argument === "undefined" ? "" : $argument);
    var rawUrl = (stored && trim(stored.dbUrl)) || args[0] || "";
    var authToken = (stored && trim(stored.dbToken)) || args[1] || "";
    var policy = (stored && trim(stored.policy)) || args[2] || "PROXY";
    var username = (stored && trim(stored.username)) || args[3] || "";
    var sourceName = deviceSource() || "Unknown";
    // 设备上下文：clientId 复用面板写入持久化的标识（两脚本同设备同标识），
    // 用户名来自模块参数 FINAL_USER（经面板下发），型号取 $environment
    var device = {
        clientId: (stored && trim(stored.clientId)) || "",
        name: sourceName,
        username: username
    };

    if (!rawUrl) {
        console.log("[FINAL] 未读到后端配置（先安装并配置面板模块，面板刷新一次即写入持久化），跳过写库");
        $done({ matched: true });
        return;
    }

    if (!/^https:\/\//.test(rawUrl)) {
        console.log("[FINAL] 后端地址格式不正确（应为网页面板地址或 /api/logger 接口地址），跳过写库");
        $done({ matched: true });
        return;
    }

    if (!authToken) {
        console.log("[FINAL] 未读到上报令牌（模块参数 FINAL_DB_TOKEN，与后端 PANEL_HIT_TOKEN 一致），跳过写库");
        $done({ matched: true });
        return;
    }

    // DNS 解析失败的占位串不是真实命中：入库只会以域名后缀类型污染导出与计数
    if (!target || target === DNS_FAILED_PLACEHOLDER) {
        console.log("[FINAL] 无有效主机名（DNS 解析失败或为空），跳过写库");
        $done({ matched: true });
        return;
    }

    // 统一走中转后端：网页面板地址自动补全 /api/logger，写库用其 /hits 批量子路径
    var clean = rawUrl.replace(/\/+$/, "");
    var endpoint = clean.indexOf("/api/logger") > -1 ? clean : clean + "/api/logger";

    // 去重窗口：同主机名在窗口内只累计次数；攒满条数或窗口到期才真正发请求
    var now = Date.now();
    var buffer = readBuffer();
    var existing = buffer.hits[target];
    if (existing) {
        existing.count += 1;
    } else {
        buffer.hits[target] = {
            count: 1,
            type: inferTypeFromHost(target),
            value: target,
            source: sourceName,
            policy: policy,
            params: "",
            since: now
        };
    }

    var entryCount = bufferEntries(buffer).length;
    var windowExpired = oldestSince(buffer) > 0 && now - oldestSince(buffer) >= FLUSH_WINDOW_MS;

    if (!windowExpired && entryCount < FLUSH_MAX_ENTRIES) {
        // 窗口未到：只落缓冲，不发网络请求，代理连接立即放行
        writeStore(BUFFER_KEY, JSON.stringify(buffer));
        $done({ matched: true });
        return;
    }

    // 到期上报：先取走这批条目并清出缓冲（在发请求前写回），失败再合并回来补报
    var pending = bufferEntries(buffer);
    buffer.hits = {};
    writeStore(BUFFER_KEY, JSON.stringify(buffer));
    flushHits(endpoint, authToken, pending, device);
}

main();

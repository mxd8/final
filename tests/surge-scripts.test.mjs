/**
 * Surge 客户端脚本单测：用 node:vm 沙箱模拟 Surge 脚本环境
 * （$done / $httpClient / $argument / $environment / $request / $persistentStore），
 * 按官方脚本 API 契约断言行为：
 *   - HTTP 客户端为 $httpClient.get/post(options, cb)，回调 (error, response, data)，状态码 response.status
 *   - 面板模块（final-panel.js）经 argument= 收到配置，写入持久化键 final_db_config 下发
 *   - 捕获脚本（final-logger.js）优先从持久化读配置，argument= 兜底
 *   - 持久化为显式 key 的 $persistentStore.write(data, key) / read(key)，官方支持跨脚本共享
 *   - 两端脚本统一走中转后端：地址由 FINAL_WEB_URL 智能补全 /api/logger，上报令牌必填
 * 不联网、不依赖真实数据库。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import assert from 'node:assert/strict';
// vm 沙箱里创建的对象/数组原型与宿主 realm 不同，deepStrictEqual 会因原型不一致误报，
// 跨 realm 的结构比较用宽松 deepEqual
import assertLoose from 'node:assert';

const here = fileURLToPath(new URL('.', import.meta.url));
const loggerSrc = readFileSync(`${here}/../surge/final-logger.js`, 'utf8');
const panelSrc = readFileSync(`${here}/../surge/final-panel.js`, 'utf8');
const sgmoduleSrc = readFileSync(`${here}/../surge/final.sgmodule`, 'utf8');

/** 从脚本源码提取注入的版本常量：测试不硬编码，注入怎么变测试都不用改 */
const scriptVersion = (source) => source.match(/var SCRIPT_VERSION = "([^"]+)";/)[1];
const PANEL_V = scriptVersion(panelSrc);
const LOGGER_V = scriptVersion(loggerSrc);
const nextVersion = (v) => {
  const [major, minor, patch] = v.split('.').map(Number);
  return `${major}.${minor}.${patch + 1}`;
};

/** 记录式 $httpClient：请求先入队，测试再手动派发回调 */
function makeHttp() {
  const calls = [];
  const http = {
    post: (opts, cb) => calls.push({ method: 'POST', opts, cb }),
    get: (opts, cb) => calls.push({ method: 'GET', opts: typeof opts === 'string' ? { url: opts } : opts, cb }),
  };
  return { http, calls };
}

/** 记录式 $persistentStore：内存 KV，write(data, key) 签名与官方一致，null 删除 */
function makeStore(seed) {
  const map = new Map(Object.entries(seed || {}));
  const writes = [];
  const store = {
    read: (key) => (map.has(key) ? map.get(key) : null),
    write: (data, key) => {
      writes.push({ key, data: String(data) });
      if (data === null) map.delete(key); else map.set(key, String(data));
      return true;
    },
  };
  return { store, writes };
}

function runLogger({ argument = '', request = null, environment = null, storeSeed = null } = {}) {
  const { http, calls } = makeHttp();
  const { store, writes } = makeStore(storeSeed);
  const done = [];
  const logs = [];
  const sandbox = {
    console: { log: (...a) => logs.push(a.join(' ')) },
    $argument: argument,
    $httpClient: http,
    $persistentStore: store,
    $done: (r) => done.push(r),
  };
  if (request !== null) sandbox.$request = request;
  if (environment !== null) sandbox.$environment = environment;
  vm.runInContext(loggerSrc, vm.createContext(sandbox));
  return { calls, done, logs, writes };
}

function runPanel({ argument = '', storeSeed = null } = {}) {
  const { http, calls } = makeHttp();
  const { store, writes } = makeStore(storeSeed);
  const done = [];
  const logs = [];
  const sandbox = {
    console: { log: (...a) => logs.push(a.join(' ')) },
    $argument: argument,
    $httpClient: http,
    $persistentStore: store,
    $done: (r) => done.push(r),
  };
  vm.runInContext(panelSrc, vm.createContext(sandbox));
  return { calls, done, logs, writes };
}

// ---------- final-panel.js（面板脚本 + 配置下发） ----------

// 面板刷新把配置写入持久化：网页面板地址自动补全 /api/logger 后下发
{
  const { calls, writes } = runPanel({
    argument: 'https://final.pages.dev|ST|DIRECT',
  });
  assert.equal(calls.length, 1, '配置有效时应发起统计请求');
  assert.equal(calls[0].method, 'GET');
  assert.equal(calls[0].opts.url, 'https://final.pages.dev/api/logger/stats', '中转地址由面板地址补全 /api/logger 后读 /stats');
  assert.equal(writes.length, 1, '配置变更应写入持久化');
  assert.equal(writes[0].key, 'final_db_config');
  const stored = JSON.parse(writes[0].data);
  assert.equal(stored.dbUrl, 'https://final.pages.dev/api/logger');
  assert.equal(stored.dbToken, 'ST');
  assert.equal(stored.policy, 'DIRECT');
  assert.match(stored.clientId, /^panel-[0-9a-f]{12}$/, '客户端标识随配置一并持久化（心跳用，不采集个人信息）');
}

// 心跳捎带：既有 /stats 请求附带客户端标识、自身版本与上报令牌（零新增请求）
{
  const { calls } = runPanel({ argument: 'https://final.pages.dev|ST|PROXY' });
  const headers = calls[0].opts.headers;
  assert.equal(headers.Authorization, 'Bearer ST', '心跳走上报令牌鉴权面');
  assert.match(headers['X-Final-Client'], /^panel-[0-9a-f]{12}$/);
  assert.equal(headers['X-Final-Version'], PANEL_V, '面板脚本自身版本随心跳上报');
}

// 用户组 / 用户名与刷新间隔（v1.2 多设备识别）：随配置持久化并随心跳上报
{
  const { calls, writes } = runPanel({ argument: 'https://final.pages.dev|ST|PROXY|boss|300' });
  const headers = calls[0].opts.headers;
  assert.equal(headers['X-Final-User'], 'boss', '用户名随心跳上报');
  assert.equal(headers['X-Final-Refresh'], '300', '刷新间隔随心跳上报（服务端在线判定用）');
  assert.ok('X-Final-Device' in headers, '设备型号头存在（无 $environment 时为空串）');
  const stored = JSON.parse(writes[0].data);
  assert.equal(stored.username, 'boss', '用户名写入持久化下发给捕获脚本');
  assert.equal(stored.refreshSeconds, undefined, '刷新间隔只走心跳头，不进持久化键（键结构稳定）');

  // 省略后两段：回落默认刷新间隔 600，用户名为空
  const fallback = runPanel({ argument: 'https://final.pages.dev|ST|PROXY' });
  assert.equal(fallback.calls[0].opts.headers['X-Final-Refresh'], '600', '未传刷新间隔回落 600');
  assert.equal(JSON.parse(fallback.writes[0].data).username, undefined, '用户名为空不写入持久化');
}

// 智能识别：FINAL_WEB_URL 误填接口地址也能识别，GET 不重复拼路径
{
  const { calls, done } = runPanel({ argument: 'https://final.pages.dev/api/logger/|ST|PROXY' });
  assert.equal(calls[0].opts.url, 'https://final.pages.dev/api/logger/stats', '尾斜杠与已有 /api/logger 被识别');
  calls[0].cb(null, { status: 200 }, JSON.stringify({ data: [] }));
  assert.ok(done[0].content.includes('网页面板: https://final.pages.dev'), '展示用网页地址剥掉接口路径');
}

// 配置未变化不重复落盘；变化时更新
{
  const same = {
    dbUrl: 'https://final.pages.dev/api/logger',
    dbToken: 'ST',
    policy: 'DIRECT',
    clientId: 'panel-0123456789ab',
  };
  const { writes: noWrite } = runPanel({
    argument: 'https://final.pages.dev|ST|DIRECT',
    storeSeed: { final_db_config: JSON.stringify(same) },
  });
  assert.equal(noWrite.length, 0, '配置未变化不应重复写入（含 clientId）');

  const { writes: changed } = runPanel({
    argument: 'https://final2.pages.dev|ST2|PROXY',
    storeSeed: { final_db_config: JSON.stringify(same) },
  });
  assert.equal(changed.length, 1);
  const merged = JSON.parse(changed[0].data);
  assert.equal(merged.dbUrl, 'https://final2.pages.dev/api/logger');
  assert.equal(merged.clientId, 'panel-0123456789ab', '合并写入保留已有客户端标识');
}

// 未配置：不写持久化（不得用空配置覆盖已有下发），面板明确提示
{
  const { calls, writes, done } = runPanel({ argument: '' });
  assert.equal(calls.length, 0);
  assert.equal(writes.length, 0);
  assert.ok(done[0].title.includes('FINAL'));
  assert.ok(done[0].content.includes('未配置'));
}

// 上报令牌必填：缺失时不发请求、不落持久化，提示补 FINAL_DB_TOKEN
{
  const { calls, done, writes } = runPanel({ argument: 'https://final.pages.dev||PROXY' });
  assert.equal(calls.length, 0, '缺令牌不得发请求');
  assert.equal(writes.length, 0, '配置不完整不得落持久化');
  assert.ok(done[0].content.includes('FINAL_DB_TOKEN'));
}

// 非 https 格式不正确：不发请求，明确提示
{
  const { calls, done } = runPanel({ argument: 'ftp://x|T|PROXY' });
  assert.equal(calls.length, 0);
  assert.ok(done[0].content.includes('格式不正确'));
}

// 中转后端：GET /stats 聚合接口，按聚合结果渲染统计
{
  const { calls, done } = runPanel({
    argument: 'https://final.pages.dev|ST|PROXY',
  });
  assert.equal(calls[0].method, 'GET');
  assert.equal(calls[0].opts.url, 'https://final.pages.dev/api/logger/stats', '面板读 stats 聚合端点而非整份列表');
  const data = JSON.stringify({
    data: {
      totalRules: 2,
      totalHits: 5,
      proxyCount: 1,
      directCount: 1,
      rejectCount: 0,
      emptyCommentCount: 2,
      todayNew: 2,
      types: [
        { name: 'DOMAIN-SUFFIX', count: 1 },
        { name: 'IP-CIDR', count: 1 },
      ],
      sources: [
        { name: 'iPhone15,3', count: 1 },
        { name: '未标注', count: 1 },
      ],
    },
  });
  calls[0].cb(null, { status: 200 }, data);
  assert.equal(done.length, 1);
  assert.ok(done[0].content.includes('规则总数: 2 条'), '应统计到 2 条规则');
  assert.ok(done[0].content.includes('🟢 直连: 1'), 'DIRECT 计数正确');
  assert.ok(done[0].content.includes('命中来源'), '有来源数据时展示命中来源行');
  assert.ok(done[0].content.includes('网页面板: https://final.pages.dev'));
  assert.ok(done[0].content.includes('后端: final.pages.dev'), '底部显示后端主机名');
  assert.equal(done[0].icon, 'chart.bar.fill');
  assert.equal(done[0]['icon-color'], '#0071e3', '面板图标颜色字段是官方 icon-color');
}

// 设备在线统计与告警（v1.2）：deviceSummary 携带 n/m 在线与分级告警，面板正文直接渲染
{
  const { calls, done } = runPanel({ argument: 'https://final.pages.dev|ST|PROXY' });
  calls[0].cb(null, { status: 200 }, JSON.stringify({
    data: {
      totalRules: 3,
      types: [],
      sources: [{ name: 'iPhone15,3', count: 2 }],
      deviceSummary: {
        total: 2,
        online: 1,
        alertCount: 2,
        alerts: [
          { name: 'iPhone15,3', username: 'boss', type: 'failed', level: 'danger', message: '配置校验失败' },
          { name: 'iPad Pro', username: '', type: 'offline', level: 'secondary', message: '设备离线' },
        ],
      },
    },
  }));
  assert.ok(done[0].content.includes('设备在线: 1/2'), '在线统计 n/m 进入面板正文');
  assert.ok(done[0].content.includes('配置校验失败'), '告警消息进入面板正文');
  assert.ok(done[0].content.includes('设备离线'), '离线告警进入面板正文');
  assert.ok(done[0].content.includes('boss'), '告警设备名可见');

  // 无告警时正文不含告警行
  const clean = runPanel({ argument: 'https://final.pages.dev|ST|PROXY' });
  clean.calls[0].cb(null, { status: 200 }, JSON.stringify({
    data: { totalRules: 1, deviceSummary: { total: 1, online: 1, alertCount: 0, alerts: [] } },
  }));
  assert.ok(clean.done[0].content.includes('设备在线: 1/1'));
  assert.ok(!clean.done[0].content.includes('设备离线') && !clean.done[0].content.includes('配置过期') && !clean.done[0].content.includes('配置校验失败'), '无告警时不出现告警行');
}

// 全部来源都是「未标注」时不展示命中来源行
{
  const { calls, done } = runPanel({ argument: 'https://final.pages.dev|ST|PROXY' });
  calls[0].cb(null, { status: 200 }, JSON.stringify({
    data: { totalRules: 1, sources: [{ name: '未标注', count: 1 }], types: [] },
  }));
  assert.ok(!done[0].content.includes('命中来源'), '未标注桶不算设备来源');
}

// 版本看板行：默认渲染自身版本；服务端 latest 更新时给出升级提示
{
  const { calls, done } = runPanel({ argument: 'https://final.pages.dev|ST|PROXY' });
  calls[0].cb(null, { status: 200 }, JSON.stringify({ data: { totalRules: 1, latest: { panel: nextVersion(PANEL_V) } } }));
  assert.ok(done[0].content.includes(`版本: 面板 ${PANEL_V}`), '面板版本行进入面板正文');
  assert.ok(done[0].content.includes(nextVersion(PANEL_V)), '落后时展示服务端最新版本');
  assert.ok(done[0].content.includes('更新模块'), '面板脚本落后给出更新指引');

  const same = runPanel({ argument: 'https://final.pages.dev|ST|PROXY' });
  same.calls[0].cb(null, { status: 200 }, JSON.stringify({ data: { totalRules: 1, latest: { panel: PANEL_V } } }));
  assert.ok(!same.done[0].content.includes('更新模块'), '版本一致时不显示更新提示');
}

// 捕获脚本版本提示：读 final_logger_meta，落后时提示重新另存本地脚本
{
  const { calls, done } = runPanel({
    argument: 'https://final.pages.dev|ST|PROXY',
    storeSeed: {
      final_logger_meta: JSON.stringify({ version: LOGGER_V, latest: nextVersion(LOGGER_V), at: Date.now() }),
    },
  });
  assert.equal(calls[0].opts.headers['X-Final-Logger'], LOGGER_V, '捕获脚本自报版本随心跳上报');
  calls[0].cb(null, { status: 200 }, JSON.stringify({ data: { totalRules: 1 } }));
  assert.ok(done[0].content.includes(`捕获 ${LOGGER_V}`), '捕获脚本版本进入面板正文');
  assert.ok(done[0].content.includes('重新另存本地脚本'), '捕获脚本落后提示重新另存');
}

// 查询失败：面板给失败提示而非抛错
{
  const { calls, done } = runPanel({ argument: 'https://final.pages.dev|ST|PROXY' });
  calls[0].cb(null, { status: 500 }, '');
  assert.ok(done[0].content.includes('查询失败'));
}

// ---------- final-logger.js（捕获脚本，配置从持久化读取 + 去重窗口缓冲） ----------

/** 构造一个已过期的缓冲种子：下一次命中会立刻触发批量上报（空表也会塞一条种子命中） */
function expiredSeed(entries) {
  const hits = {
    'flush-seed.com': { count: 1, type: 'DOMAIN-SUFFIX', value: 'flush-seed.com', source: 'S', policy: 'PROXY', params: '', since: Date.now() - 6000 },
  };
  for (const [hostname, extra] of Object.entries(entries || {})) {
    hits[hostname] = { count: 1, type: 'DOMAIN-SUFFIX', value: hostname, source: 'S', policy: 'PROXY', params: '', since: Date.now() - 6000, ...extra };
  }
  return { final_hit_buffer: JSON.stringify({ v: 1, hits }) };
}

// 窗口未到期：命中只进缓冲，不发网络请求，连接立即放行
{
  const { calls, done, writes } = runLogger({
    request: { hostname: 'example.com' },
    environment: { 'device-model': 'iPhone15,3' },
    storeSeed: { final_db_config: JSON.stringify({ dbUrl: 'https://final.pages.dev', dbToken: 'ST', policy: 'REJECT' }) },
  });
  assert.equal(calls.length, 0, '窗口内不发请求');
  assertLoose.deepEqual(done, [{ matched: true }]);
  assert.equal(writes.length, 1, '命中进缓冲');
  const buffer = JSON.parse(writes[0].data);
  assert.equal(buffer.v, 1);
  assert.equal(buffer.hits['example.com'].count, 1);
  assert.equal(buffer.hits['example.com'].policy, 'REJECT');
  assert.equal(buffer.hits['example.com'].source, 'iPhone15,3');
}

// 窗口到期：一次性批量上报整组命中，POST /hits，成功后清空缓冲
{
  const { calls, done, writes } = runLogger({
    request: { hostname: 'example.com' },
    environment: { 'device-model': 'iPhone15,3' },
    storeSeed: {
      final_db_config: JSON.stringify({ dbUrl: 'https://final.pages.dev', dbToken: 'ST', policy: 'REJECT' }),
      ...expiredSeed({ 'old.com': { count: 2 } }),
    },
  });
  assert.equal(calls.length, 1, '窗口到期触发批量上报');
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].opts.url, 'https://final.pages.dev/api/logger/hits', '批量上报走 /hits 子路径');
  assert.equal(calls[0].opts.headers.Authorization, 'Bearer ST');
  const body = JSON.parse(calls[0].opts.body);
  const old = body.hits.find((h) => h.hostname === 'old.com');
  const fresh = body.hits.find((h) => h.hostname === 'example.com');
  assert.ok(old && old.count === 2, '缓冲中的旧命中一并上报');
  assertLoose.deepEqual(
    fresh && { type: fresh.type, value: fresh.value, policy: fresh.policy, source: fresh.source },
    { type: 'DOMAIN-SUFFIX', value: 'example.com', policy: 'REJECT', source: 'iPhone15,3' },
  );
  assert.equal(writes.filter((w) => w.key === 'final_hit_buffer').length >= 1, true, '上报前先清出缓冲');
  calls[0].cb(null, { status: 200, headers: {} }, '');
  assertLoose.deepEqual(done, [{ matched: true }]);
  const cleared = JSON.parse(writes[writes.length - 1].data);
  assert.equal(Object.keys(cleared.hits).length, 0, '成功后缓冲为空（上报前已清出，无合并写回）');
}

// 版本握手：响应捎带 latestLoggerVersion 时写入 final_logger_meta；版本一致不重复落盘
{
  const { calls, writes } = runLogger({
    request: { hostname: 'example.com' },
    storeSeed: {
      final_db_config: JSON.stringify({ dbUrl: 'https://final.pages.dev', dbToken: 'ST', policy: 'PROXY' }),
      ...expiredSeed({}),
    },
  });
  calls[0].cb(null, { status: 200 }, JSON.stringify({ success: true, data: { accepted: 1, latestLoggerVersion: nextVersion(LOGGER_V) } }));
  const metaWrite = writes.find((w) => w.key === 'final_logger_meta');
  assert.ok(metaWrite, 'latestLoggerVersion 存在时写版本自报键');
  assertLoose.deepEqual(JSON.parse(metaWrite.data), { version: LOGGER_V, latest: nextVersion(LOGGER_V), at: JSON.parse(metaWrite.data).at });

  const noRepeat = runLogger({
    request: { hostname: 'example.com' },
    storeSeed: {
      final_db_config: JSON.stringify({ dbUrl: 'https://final.pages.dev', dbToken: 'ST', policy: 'PROXY' }),
      final_logger_meta: JSON.stringify({ version: LOGGER_V, latest: nextVersion(LOGGER_V), at: 1 }),
      ...expiredSeed({}),
    },
  });
  noRepeat.calls[0].cb(null, { status: 200 }, JSON.stringify({ success: true, data: { accepted: 1, latestLoggerVersion: nextVersion(LOGGER_V) } }));
  assert.ok(!noRepeat.writes.some((w) => w.key === 'final_logger_meta'), '内容未变化不重复写入');
}

// 响应体不是 JSON 或没有 latestLoggerVersion 字段时静默跳过（老后端兼容）
{
  const { calls, writes } = runLogger({
    request: { hostname: 'example.com' },
    storeSeed: {
      final_db_config: JSON.stringify({ dbUrl: 'https://final.pages.dev', dbToken: 'ST', policy: 'PROXY' }),
      ...expiredSeed({}),
    },
  });
  calls[0].cb(null, { status: 200 }, '');
  assert.ok(!writes.some((w) => w.key === 'final_logger_meta'), '空响应体不写版本键');
}

// 同主机名去重：缓冲里已有的主机名重复命中只累加次数，上报为一条
{
  const { calls } = runLogger({
    request: { hostname: 'old.com' },
    storeSeed: {
      final_db_config: JSON.stringify({ dbUrl: 'https://final.pages.dev', dbToken: 'ST', policy: 'PROXY' }),
      final_hit_buffer: JSON.stringify({
        v: 1,
        hits: { 'old.com': { count: 2, type: 'DOMAIN-SUFFIX', value: 'old.com', source: 'S', policy: 'PROXY', params: '', since: Date.now() - 6000 } },
      }),
    },
  });
  const body = JSON.parse(calls[0].opts.body);
  assert.equal(body.hits.length, 1, '同主机名合并为一条');
  assert.equal(body.hits[0].count, 3, '次数 2 + 1 累加');
}

// 上报失败：整批合并回缓冲，等待下次命中补报
{
  const { calls, writes } = runLogger({
    request: { hostname: 'example.com' },
    storeSeed: {
      final_db_config: JSON.stringify({ dbUrl: 'https://final.pages.dev', dbToken: 'ST', policy: 'PROXY' }),
      ...expiredSeed({ 'old.com': { count: 2 } }),
    },
  });
  calls[0].cb(new Error('timeout'), null, '');
  const lastWrite = writes[writes.length - 1];
  const restored = JSON.parse(lastWrite.data);
  assert.ok(restored.hits['old.com'] && restored.hits['old.com'].count === 2, '失败的旧命中放回缓冲');
  assert.ok(restored.hits['example.com'] && restored.hits['example.com'].count === 1, '本次命中同样放回缓冲');
}

// 用户名与设备上下文（v1.2）：持久化里的 username / clientId 随批量上报携带
{
  const { calls } = runLogger({
    request: { hostname: 'example.com' },
    environment: { 'device-model': 'iPhone15,3' },
    storeSeed: {
      final_db_config: JSON.stringify({
        dbUrl: 'https://final.pages.dev', dbToken: 'ST', policy: 'PROXY',
        username: 'boss', clientId: 'panel-0123456789ab',
      }),
      ...expiredSeed({}),
    },
  });
  const headers = calls[0].opts.headers;
  assert.equal(headers['X-Final-User'], 'boss', '用户名随请求头上报');
  assert.equal(headers['X-Final-Client'], 'panel-0123456789ab', 'clientId 复用面板下发的标识（同设备两脚本一致）');
  assert.equal(headers['X-Final-Device'], 'iPhone15,3', '设备型号随请求头上报');
  assert.equal(headers['X-Final-Logger'], LOGGER_V, '捕获脚本自报版本随请求头上报');
  const body = JSON.parse(calls[0].opts.body);
  assert.equal(body.username, 'boss', '请求体顶层带用户名（服务端兜底字段）');
  assert.ok(body.hits.every((h) => h.username === 'boss'), '每条命中携带用户名');
}

// 从持久化读取面板下发的配置；持久化里已是 /api/logger 完整接口地址时也不重复补全
{
  const { calls } = runLogger({
    argument: 'https://arg.pages.dev|AT|PROXY',
    request: { hostname: 'example.com' },
    storeSeed: {
      final_db_config: JSON.stringify({ dbUrl: 'https://store.pages.dev/api/logger', dbToken: 'ST', table: 'store_logs', policy: 'DIRECT' }),
      ...expiredSeed({}),
    },
  });
  assert.equal(calls[0].opts.url, 'https://store.pages.dev/api/logger/hits');
  assert.equal(calls[0].opts.headers.Authorization, 'Bearer ST');
  assert.equal(JSON.parse(calls[0].opts.body).hits.find((h) => h.hostname === 'example.com').policy, 'DIRECT');
}

// argument= 兜底（无持久化）：三段参数 面板地址|令牌|策略
{
  const { calls, done } = runLogger({
    argument: 'https://final.pages.dev|TOKEN|PROXY',
    request: { hostname: 'example.com' },
    environment: { 'device-model': 'iPhone15,3' },
    storeSeed: expiredSeed({}),
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].opts.url, 'https://final.pages.dev/api/logger/hits');
  assert.equal(calls[0].opts.headers.Authorization, 'Bearer TOKEN');
  assert.equal(JSON.parse(calls[0].opts.body).hits.find((h) => h.hostname === 'example.com').policy, 'PROXY');
  calls[0].cb(null, { status: 200, headers: {} }, '');
  assertLoose.deepEqual(done, [{ matched: true }]);
}

// 上报令牌必填：地址有效但缺令牌时静默放行不发请求、不落缓冲
{
  const { calls, done, logs, writes } = runLogger({
    request: { hostname: 'example.com' },
    storeSeed: { final_db_config: JSON.stringify({ dbUrl: 'https://final.pages.dev', policy: 'PROXY' }) },
  });
  assert.equal(calls.length, 0, '缺令牌不得发请求');
  assertLoose.deepEqual(done, [{ matched: true }]);
  assert.ok(logs.join('').includes('上报令牌'));
  assert.equal(writes.length, 0, '缺配置不落命中缓冲');
}

// 旧式空格分隔参数兼容
{
  const { calls } = runLogger({
    argument: 'https://final.pages.dev TOKEN PROXY',
    request: { hostname: 'example.com' },
    storeSeed: expiredSeed({}),
  });
  assert.equal(calls[0].opts.headers.Authorization, 'Bearer TOKEN');
  assert.equal(JSON.parse(calls[0].opts.body).hits.find((h) => h.hostname === 'example.com').policy, 'PROXY');
}

// 无持久化、无 argument：静默放行不发请求，提示先配置面板模块
{
  const { calls, done, logs } = runLogger({ argument: '' });
  assert.equal(calls.length, 0);
  assertLoose.deepEqual(done, [{ matched: true }]);
  assert.ok(logs.join('').includes('未读到后端配置'));
}

// 持久化内容损坏（非 JSON）：配置回落 argument、命中缓冲重置，不影响放行
{
  const { calls, done } = runLogger({
    argument: 'https://final.pages.dev|T|PROXY',
    request: { hostname: 'example.com' },
    storeSeed: { final_db_config: '{broken json', final_hit_buffer: '{broken json' },
  });
  assert.equal(calls.length, 0, '缓冲损坏重置后本次只进缓冲');
  const { calls: calls2 } = runLogger({
    argument: 'https://final.pages.dev|T|PROXY',
    request: { hostname: 'example.com' },
    storeSeed: {
      final_db_config: '{broken json',
      final_hit_buffer: JSON.stringify({ v: 1, hits: { 'x.com': { count: 1, since: Date.now() - 6000 } } }),
    },
  });
  assert.equal(calls2.length, 1, '配置损坏回落 argument 后仍能上报');
  assert.equal(calls2[0].opts.url, 'https://final.pages.dev/api/logger/hits');
}

// 非法地址：静默放行不发请求
{
  for (const argument of ['ftp://x|t|PROXY', 'libsql://db-example.turso.io|T|PROXY']) {
    const { calls, done } = runLogger({ argument, request: { hostname: 'example.com' } });
    assert.equal(calls.length, 0, `${argument} 不应发请求`);
    assertLoose.deepEqual(done, [{ matched: true }]);
  }
}

// 网络失败：仍必须 $done 放行（条目已在失败回调里放回缓冲，见上报失败用例）
{
  const { calls, done } = runLogger({
    argument: 'https://final.pages.dev|T|PROXY',
    request: { hostname: 'example.com' },
    storeSeed: expiredSeed({}),
  });
  calls[0].cb(new Error('timeout'), null, '');
  assertLoose.deepEqual(done, [{ matched: true }]);
}

// DNS 解析失败占位：不是真实命中，跳过上报也不污染缓冲
{
  const { calls, writes, done } = runLogger({
    argument: 'https://final.pages.dev|T|PROXY',
    request: {},
  });
  assert.equal(calls.length, 0, 'DNS 失败占位不再上报');
  assert.equal(writes.length, 0, '占位不进缓冲');
  assertLoose.deepEqual(done, [{ matched: true }]);
}

// ---------- final.sgmodule（模块契约） ----------

// 模块同时引用面板脚本与捕获脚本模板，占位符与参数表一一对应
{
  assert.ok(sgmoduleSrc.includes('#!name=FINAL 统计与捕获'), '模块名为 FINAL 统计与捕获');
  // 三件套改由自家 Pages 域名托管（绕开 GitHub raw 边缘缓存与可达性问题），带版本参数发版即失效
  const { PANEL_ORIGIN } = await import('../functions/_utils/build-meta.js');
  const originPattern = PANEL_ORIGIN.replaceAll('.', '\\.');
  assert.ok(sgmoduleSrc.match(new RegExp(`final-stats = type=generic, script-path=${originPattern}\\/surge\\/final-panel\\.js\\?v=[\\w.]+`)), '面板脚本自托管引用带版本参数');
  assert.ok(sgmoduleSrc.match(new RegExp(`final-logger-src = type=rule, script-path=${originPattern}\\/surge\\/final-logger\\.js\\?v=[\\w.]+`)), '捕获脚本模板自托管引用带版本参数');
  assert.ok(/^#!version=.+$/m.test(sgmoduleSrc), '模块头带版本注释');
  assert.ok(!/final-logger-src[^\n]*argument=/.test(sgmoduleSrc), '模板条目自身不传参、不参与分流（配置走持久化）');
  assert.ok(sgmoduleSrc.includes('update-interval={{{FINAL_REFRESH}}}'), '刷新间隔用参数占位符');
  assert.ok(
    sgmoduleSrc.includes('argument="{{{FINAL_WEB_URL}}}|{{{FINAL_DB_TOKEN}}}|{{{FINAL_POLICY}}}|{{{FINAL_USER}}}|{{{FINAL_REFRESH}}}"'),
    '面板 argument 五段占位符与参数表顺序一致（地址|令牌|策略|用户名|刷新间隔）',
  );
  assert.ok(sgmoduleSrc.includes('FINAL_USER'), '参数表声明用户组 / 用户名配置项（多设备区分）');
  assert.ok(sgmoduleSrc.includes('final_db_config'), '模块注释声明持久化键');
  assert.ok(loggerSrc.includes('var CONFIG_KEY = "final_db_config"'), '捕获脚本读同一持久化键');
  assert.ok(panelSrc.includes('var CONFIG_KEY = "final_db_config"'), '面板脚本写同一持久化键');
}

// 契约收紧：不再有数据库地址参数，两端令牌必填、地址智能补全
{
  assert.ok(!sgmoduleSrc.includes('FINAL_DB_URL'), '数据库地址参数已移除，由 FINAL_WEB_URL 智能补全');
  assert.ok(!sgmoduleSrc.includes('FINAL_TABLE'), 'FINAL_TABLE 已随直连移除');
  assert.ok(!sgmoduleSrc.includes('Turso'), '模块不再面向直连 Turso');
  assert.ok(panelSrc.includes('/api/logger'), '面板脚本含地址补全逻辑');
  assert.ok(loggerSrc.includes('/api/logger'), '捕获脚本含地址补全逻辑');
  assert.ok(panelSrc.includes('未配置上报令牌'), '面板对缺令牌给明确提示');
  assert.ok(loggerSrc.includes('未读到上报令牌'), '捕获脚本缺令牌时提示并放行');
  assert.ok(!loggerSrc.includes('INSERT INTO'), '捕获脚本不再直写 SQL');
  assert.ok(!loggerSrc.includes('statements'), '捕获脚本不再使用 Turso 管道协议');
  assert.ok(!panelSrc.includes('statements'), '面板脚本不再使用 Turso 管道协议');
  assert.ok(!panelSrc.includes('libsql'), '面板脚本不再转换 libsql:// 协议');
  assert.ok(!loggerSrc.includes('libsql'), '捕获脚本不再转换 libsql:// 协议');
  assert.match(panelSrc, /var SCRIPT_VERSION = "[\w.]+";/, '面板脚本带版本常量（心跳上报用）');
  assert.match(loggerSrc, /var SCRIPT_VERSION = "[\w.]+";/, '捕获脚本带版本常量（latestLoggerVersion 比对用）');
}

console.log('surge-scripts: all assertions passed');

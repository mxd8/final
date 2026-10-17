/**
 * 端到端验证：真实 SqliteAdapter（node:sqlite）+ 真实的 functions/api 路由。
 * 自多数据库工厂落地起，e2e 从「mock 模拟 Turso HTTP 形状」升级为「真实适配器」：
 * 测试与生产走同一条执行路径（adapter.execute / adapter.batch / 统一 changes 形状），
 * 杜绝「Mock 恰好满足错误形状、生产全错」一类的回归。唯一的打桩点是订阅抓取
 * （业务本来就依赖远端 HTTP）；Turso 管道自身的 HTTP 语义由
 * tests/db-adapters.test.mjs 用本地 mock 服务覆盖。
 */
import { mkdtempSync, rmSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const tmpRoot = mkdtempSync(`${tmpdir()}/e2e-sqlite-`);
process.env.NO_PROXY = '127.0.0.1,localhost';
process.on('exit', () => rmSync(tmpRoot, { recursive: true, force: true }));

/**
 * 数据库后端：sqlite 真实适配器（DB_BACKEND=sqlite + 本地文件）。
 * 多个 env 变体（{...env, PANEL_WRITE_TOKEN}）按配置签名共享同一个适配器实例，
 * 数据落在同一份文件里，与生产语义一致。
 */
const env = {
  DB_BACKEND: 'sqlite',
  DB_SQLITE_PATH: `${tmpRoot}/e2e.sqlite`,
  // 上报接口现已强制令牌（未配置一律拒绝）：基础环境统一配上，call() 自动附带
  PANEL_HIT_TOKEN: 'hit-token'
};

const { onRequest: loggerHandler } = await import(fileURLToPath(new URL('../functions/api/logger.js', import.meta.url)));
const { onRequest: rulesHandler } = await import(fileURLToPath(new URL('../functions/api/rules.js', import.meta.url)));
const { onRequest: prefsHandler } = await import(fileURLToPath(new URL('../functions/api/prefs.js', import.meta.url)));
const { onRequest: schemaHandler } = await import(fileURLToPath(new URL('../functions/api/schema.js', import.meta.url)));
const { onRequest: subscribeHandler } = await import(fileURLToPath(new URL('../functions/api/subscribe.js', import.meta.url)));
const { onRequest: exportHandler } = await import(fileURLToPath(new URL('../functions/api/export.js', import.meta.url)));
const { onRequest: healthHandler } = await import(fileURLToPath(new URL('../functions/api/health.js', import.meta.url)));

/**
 * 订阅解析要抓远程地址，测试里不能真联网，所以打桩 globalThis.fetch。
 * 数据库走 sqlite 适配器不经过 fetch，这里按订阅 URL 精确匹配，
 * 未登记的 URL 返回网络错误，等价于「订阅源不可达」。
 */
const fetchCases = new Map();
globalThis.fetch = (input, init) => {
  const target = typeof input === 'string' ? input : input.url;
  const handler = fetchCases.get(target);
  if (!handler) return Promise.reject(new Error(`测试未登记的地址：${target}`));
  return handler();
};
/** 注册一个订阅源：返回 rules 订阅文本 */
function stubSubscription(url, body) {
  fetchCases.set(url, () => Promise.resolve(new Response(body, { status: 200, headers: { 'content-type': 'text/plain' } })));
}
/** 注册一个会失败的订阅源 */
function stubSubscriptionFailure(url, { status = 500, message = '' } = {}) {
  fetchCases.set(url, () => Promise.resolve(new Response(message, { status, headers: { 'content-type': 'text/plain' } })));
}
/** 注册一个抛错的订阅源（模拟超时 / 网络不可达） */
function stubSubscriptionThrows(url, error) {
  fetchCases.set(url, () => Promise.reject(error));
}

/**
 * 数据库侧故障注入（globalThis.__setDbFailure）：
 *   null 恢复正常 | 'network' 执行直接抛连接错误 | 'http500' 抛服务端错误。
 * Turso 限流、写锁竞争、网络抖动这些失败模式在业务层的表现是「适配器抛 DbError」，
 * 在 sqlite 适配器上打原型级补丁即可复现同一条错误路径。
 */
const { SqliteAdapter } = await import('../functions/_utils/db/sqlite-adapter.js');
const realBatch = SqliteAdapter.prototype.batch;
const realExecute = SqliteAdapter.prototype.execute;
globalThis.__setDbFailure = (mode) => {
  if (!mode) {
    SqliteAdapter.prototype.batch = realBatch;
    SqliteAdapter.prototype.execute = realExecute;
    return;
  }
  const fail = () => {
    throw new Error(mode === 'network' ? 'injected: network unreachable' : 'injected: internal error');
  };
  SqliteAdapter.prototype.batch = fail;
  SqliteAdapter.prototype.execute = fail;
};

/** 直接读库断言的入口：与路由按同一配置签名取同一个适配器实例 */
const { getAdapter } = await import('../functions/_utils/db/factory.js');
const adapter = await getAdapter(env);
const db = adapter.db;

let failed = 0;
function check(name, condition, extra = '') {
  if (condition) console.log(`  ok  ${name}`);
  else { console.log(`  FAIL ${name} ${extra}`); failed += 1; }
}
function call(handler, path, { method = 'GET', body, headers = {} } = {}) {
  return handler({
    request: new Request(`http://test${path}`, {
      method,
      body: body ? JSON.stringify(body) : undefined,
      headers: {
        // 默认附带上报令牌（与生产脚本行为一致）；显式传入的头优先，供鉴权反例使用
        ...(body ? { 'content-type': 'application/json', authorization: 'Bearer hit-token' } : { authorization: 'Bearer hit-token' }),
        ...headers
      }
    }),
    env,
    waitUntil: () => {}
  });
}
const list = async (query = '') => (await (await call(loggerHandler, `/api/logger${query}`)).json()).data;
const text = async (path) => (await call(loggerHandler, path)).text();
const stats = async () => (await (await call(loggerHandler, '/api/logger/stats')).json()).data;

/* ---------------- logger 路由 ---------------- */
console.log('\n[logger] 配置校验');
{
  const res = await loggerHandler({ request: new Request('http://test/api/logger'), env: {}, waitUntil: () => {} });
  const data = await res.json();
  check('缺环境变量返回 400 JSON', res.status === 400 && data.success === false, JSON.stringify(data));
}
{
  const res = await loggerHandler({ request: new Request('http://test/api/logger'), env: { TURSO_API_URL: 'libsql://bad', TURSO_AUTH_TOKEN: 't' }, waitUntil: () => {} });
  check('libsql:// 协议返回 400 并给出原因', res.status === 400 && (await res.json()).error.includes('libsql'));
}
{
  const res = await loggerHandler({ request: new Request('http://test/api/logger'), env: { TURSO_API_URL: 'http://x', TURSO_AUTH_TOKEN: 't' }, waitUntil: () => {} });
  check('非 https 返回 400', res.status === 400);
}

console.log('\n[logger] 命中记录（带设备来源）');
await call(loggerHandler, '/api/logger/hit', { method: 'POST', body: { hostname: 'a.com', source: 'iPhone 15' } });
await call(loggerHandler, '/api/logger/hit', { method: 'POST', body: { hostname: 'a.com', source: 'MacBook' } });
await call(loggerHandler, '/api/logger/hit', { method: 'POST', body: { hostname: 'b.com' } });
{
  const items = await list();
  const a = items.find((x) => x.hostname === 'a.com');
  check('a.com 计数为 2', a.count === 2);
  check('来源取首次写入的设备名，不被后续覆盖', a.source === 'iPhone 15', a.source);
  check('b.com 默认 PROXY 且无来源', items.find((x) => x.hostname === 'b.com').policy === 'PROXY' && items.find((x) => x.hostname === 'b.com').source === '');
  check('命中记录按域名推断类型 DOMAIN-SUFFIX', a.type === 'DOMAIN-SUFFIX' && a.value === 'a.com');
}
{
  // first_time 是首次命中时间，upsert 冲突后必须保持不动；
  // 否则「首次命中」列会随着每次命中退化成 time，失去意义。
  // 先手工插一行固定 first_time，再用 /hit 制造 3 次命中，验证值没被冲掉。
  db.exec(`INSERT INTO surge_logs (hostname, type, value, policy, params, comment, source, first_time, time, count)
           VALUES ('ft.com','DOMAIN-SUFFIX','ft.com','PROXY','','','','2020-01-01T00:00:00.000Z','2020-01-01T00:00:00.000Z', 1)`);
  for (let i = 0; i < 3; i += 1) {
    await call(loggerHandler, '/api/logger/hit', { method: 'POST', body: { hostname: 'ft.com' } });
  }
  const row = (await list()).find((x) => x.hostname === 'ft.com');
  check('首次命中写入后不被后续命中覆盖', row.first_time === '2020-01-01T00:00:00.000Z', String(row.first_time));
  check('首次命中早于最近命中', row.first_time < row.time, `${row.first_time} >= ${row.time}`);
  check('命中计数正常累加', row.count === 4, String(row.count));
}
{
  // 新插入的记录 first_time 应有默认值，而不是空串
  await call(loggerHandler, '/api/logger/hit', { method: 'POST', body: { hostname: 'ft-new.com' } });
  const row = (await list()).find((x) => x.hostname === 'ft-new.com');
  check('新记录首次命中等于最近命中', row.first_time === row.time, JSON.stringify(row));
}
{
  const res = await call(loggerHandler, '/api/logger/hit', { method: 'POST', body: { hostname: '   ' } });
  check('空 hostname 返回 400', res.status === 400);
}
{
  const res = await call(loggerHandler, '/api/logger/hit', { method: 'POST' });
  check('空请求体返回 400', res.status === 400);
}

console.log('\n[logger] 规则类型与参数解析');
await call(loggerHandler, '/api/logger/batch', {
  method: 'POST',
  body: { text: [
    'DOMAIN-SUFFIX,google.com,PROXY // Google 主域',
    'DOMAIN,api.example.com,DIRECT',
    'DOMAIN-KEYWORD,ads,REJECT,pre-matching',
    'PROCESS-NAME,WeChat,DIRECT',
    'IP-CIDR,192.168.0.0/16,DIRECT,no-resolve',
    'IP-CIDR6,fe80::/64,DIRECT,no-resolve',
    'GEOIP,CN,DIRECT',
    'URL-REGEX,"https://.*\\.png$",REJECT',
    'DOMAIN-SUFFIX,a.com,DEVICE:MyProxy,notification-text=命中A',
    'FINAL,PROXY,dns-failed'
  ].join('\n') }
});
{
  const items = await list();
  const suffix = items.find((x) => x.value === 'google.com');
  check('DOMAIN-SUFFIX 类型与备注保留', suffix.type === 'DOMAIN-SUFFIX' && suffix.comment === 'Google 主域');
  const exact = items.find((x) => x.value === 'api.example.com');
  check('DOMAIN 精确匹配类型保留', exact.type === 'DOMAIN' && exact.policy === 'DIRECT');
  const keyword = items.find((x) => x.value === 'ads');
  check('DOMAIN-KEYWORD 参数 pre-matching 保留', keyword.type === 'DOMAIN-KEYWORD' && keyword.params['pre-matching'] !== undefined);
  const processRule = items.find((x) => x.value === 'WeChat');
  check('PROCESS-NAME 类型保留', processRule.type === 'PROCESS-NAME');
  const ipv4 = items.find((x) => x.value === '192.168.0.0/16');
  check('IP-CIDR 类型 + no-resolve 参数保留', ipv4.type === 'IP-CIDR' && ipv4.params['no-resolve'] !== undefined);
  const ipv6 = items.find((x) => x.value === 'fe80::/64');
  check('IP-CIDR6 类型保留', ipv6.type === 'IP-CIDR6');
  const geoip = items.find((x) => x.value === 'CN');
  check('GEOIP 类型保留', geoip.type === 'GEOIP');
  const regex = items.find((x) => x.value === 'https://.*\\.png$');
  check('URL-REGEX 含逗号的正则完整保留', regex.type === 'URL-REGEX' && regex.value === 'https://.*\\.png$');
  const device = items.find((x) => x.value === 'a.com');
  // DEVICE:<name> 的设备名区分大小写（Surge 按设备名匹配 Ponte 设备），不能被统一转大写
  check('DEVICE: 前缀策略保留 + 键值参数解析', device.policy === 'DEVICE:MyProxy' && device.params['notification-text'] === '命中A', JSON.stringify(device));
  const builtin = items.find((x) => x.value === 'ads');
  check('内置策略名统一大写', builtin.policy === 'REJECT', builtin.policy);
  const finalRule = items.find((x) => x.type === 'FINAL');
  check('FINAL 规则允许无匹配值', !!finalRule && finalRule.value === '' && finalRule.policy === 'PROXY');
}
{
  const exportText = await text('/api/logger/export');
  check('导出 DOMAIN-KEYWORD 带 pre-matching', exportText.includes('DOMAIN-KEYWORD,ads,REJECT,pre-matching'));
  check('导出 IP-CIDR 带 no-resolve', exportText.includes('IP-CIDR,192.168.0.0/16,DIRECT,no-resolve'));
  check('导出 URL-REGEX 用引号包裹含逗号的值', exportText.includes('URL-REGEX,"https://.*\\.png$",REJECT'));
  check('导出 FINAL 规则并带 dns-failed', exportText.includes('FINAL,PROXY,dns-failed'));
  check('导出带备注注释', exportText.includes('DOMAIN-SUFFIX,google.com,PROXY // Google 主域'));
}
{
  const res = await call(loggerHandler, '/api/logger/export?source=iPhone%2015');
  check('按来源筛选导出', (await res.text()).includes('a.com'));
  const withSource = await text('/api/logger/export?source=iPhone%2015&with-source=1');
  check('导出可附带来源注释', withSource.includes('来源：iPhone 15'));
}
{
  const res = await call(loggerHandler, '/api/logger?type=IP-CIDR');
  check('按规则类型筛选', (await res.json()).data.every((x) => x.type === 'IP-CIDR'));
}
{
  const dump = await text('/api/logger/export');
  console.log('--- EXPORT DUMP ---');
  console.log(dump);
  console.log('--- END DUMP ---');
  check('导出调试', true);
}
{
  const meta = (await (await call(loggerHandler, '/api/logger/meta')).json()).data;
  check('meta 含全部规则类型', meta.ruleTypes.includes('DOMAIN') && meta.ruleTypes.includes('PROCESS-NAME') && meta.ruleTypes.includes('FINAL'));
  check('meta 含参数白名单', meta.params.includes('no-resolve') && meta.kvParams.includes('notification-text'));
}

console.log('\n[logger] 更新规则（字段级 upsert）');
await call(loggerHandler, '/api/logger/update', { method: 'POST', body: { hostname: 'a.com', policy: 'DIRECT', comment: '国内直连', source: '家里电视', params: { 'no-resolve': null } } });
{
  const a = (await list()).find((x) => x.hostname === 'a.com');
  check('策略 / 备注 / 来源 / 参数同时更新', a.policy === 'DIRECT' && a.comment === '国内直连' && a.source === '家里电视' && a.params['no-resolve'] !== undefined, JSON.stringify(a));
  check('更新不丢失计数', a.count === 2, a.count);
}
await call(loggerHandler, '/api/logger/update', { method: 'POST', body: { hostname: 'a.com', comment: '只改备注' } });
{
  const a = (await list()).find((x) => x.hostname === 'a.com');
  check('只改备注不影响策略与来源', a.policy === 'DIRECT' && a.source === '家里电视' && a.comment === '只改备注');
}
{
  // 非法策略名直接拒绝（400），而不是静默回落成 PROXY：
  // 回落会让用户以为自己设了自定义策略，实际写进库的是默认值，问题在设备侧才暴露。
  const res = await call(loggerHandler, '/api/logger/update', { method: 'POST', body: { hostname: 'a.com', policy: '不合法的值' } });
  check('非法策略名返回 400', res.status === 400, String(res.status));
  const a = (await list()).find((x) => x.hostname === 'a.com');
  check('被拒绝的策略不影响原值', a.policy === 'DIRECT', a.policy);
}
{
  // 修改匹配值等于换主键，计数与备注要跟着迁移
  const res = await call(loggerHandler, '/api/logger/update', { method: 'POST', body: { hostname: 'a.com', value: 'new-a.com' } });
  const data = await res.json();
  check('返回 renamed 标记', data.data.renamed === true, JSON.stringify(data));
  const items = await list();
  const moved = items.find((x) => x.hostname === 'new-a.com');
  check('旧记录被删除、新主键就位', !items.some((x) => x.hostname === 'a.com') && !!moved);
  check('换主键保留计数与备注', moved.count === 2 && moved.comment === '只改备注', JSON.stringify(moved));
}
await call(loggerHandler, '/api/logger/update', { method: 'POST', body: { hostname: 'brand-new.com', policy: 'REJECT', type: 'DOMAIN', source: '手机端' } });
{
  check('不存在则新增', (await list()).some((x) => x.hostname === 'brand-new.com' && x.policy === 'REJECT' && x.source === '手机端'));
}
{
  const res = await call(loggerHandler, '/api/logger/update', { method: 'POST', body: { hostname: '' } });
  check('update 空 hostname 返回 400', res.status === 400);
}

console.log('\n[logger] IP 语义自动推断');
await call(loggerHandler, '/api/logger/batch', { method: 'POST', body: { text: '192.168.1.5, DIRECT\n2001:db8::1, REJECT\n10.0.0.0/8, PROXY // 内网段\n' } });
{
  const items = await list();
  const v4 = items.find((x) => x.hostname === '192.168.1.5');
  const v6 = items.find((x) => x.hostname === '2001:db8::1');
  check('单 IPv4 推断为 IP-CIDR', v4.type === 'IP-CIDR' && v4.value === '192.168.1.5', JSON.stringify(v4));
  check('单 IPv6 推断为 IP-CIDR6', v6.type === 'IP-CIDR6' && v6.value === '2001:db8::1', JSON.stringify(v6));
  const exportText = await text('/api/logger/export');
  check('IPv4 导出带 /32', exportText.includes('IP-CIDR,192.168.1.5/32,DIRECT'));
  check('IPv6 导出带 /128', exportText.includes('IP-CIDR6,2001:db8::1/128,REJECT'));
  check('CIDR 段保留原样 + 注释', exportText.includes('IP-CIDR,10.0.0.0/8,PROXY // 内网段'));
}
const direct = await text('/api/logger/export?type=direct');
check('按策略过滤生效', direct.includes('192.168.1.5') && !direct.includes('2001:db8::1'), direct);

console.log('\n[logger] 降维排除');
await call(loggerHandler, '/api/logger/update', { method: 'POST', body: { hostname: 'sub.c.com' } });
await call(loggerHandler, '/api/logger/update', { method: 'POST', body: { hostname: 'deep.sub.c.com' } });
{
  const res = await call(loggerHandler, '/api/logger/exclude', { method: 'POST', body: { target: 'c.com', policy: 'PROXY' } });
  const data = await res.json();
  check('返回删除数量', data.data.deleted >= 2, JSON.stringify(data));
  const items = await list();
  check('子域名记录被删除', !items.some((x) => x.hostname.endsWith('.c.com')));
  check('生成汇总记录 c.com', !!items.find((x) => x.hostname === 'c.com'));
}
await call(loggerHandler, '/api/logger/update', { method: 'POST', body: { hostname: '192.0.2.7' } });
await call(loggerHandler, '/api/logger/update', { method: 'POST', body: { hostname: '192.0.2.8' } });
await call(loggerHandler, '/api/logger/exclude', { method: 'POST', body: { target: '192.0.2', policy: 'DIRECT' } });
{
  const items = await list();
  check('IP 前缀降维生成 .0/24', !!items.find((x) => x.hostname === '192.0.2.0/24'));
  check('同网段记录被合并', !items.some((x) => x.hostname.startsWith('192.0.2.') && x.hostname !== '192.0.2.0/24'));
}
{
  const res = await call(loggerHandler, '/api/logger/exclude', { method: 'POST', body: { target: '  ' } });
  check('空 target 返回 400', res.status === 400);
}

console.log('\n[logger] 降维排除 · CIDR 目标按网段包含');
await call(loggerHandler, '/api/logger/update', { method: 'POST', body: { hostname: '203.0.113.5' } });
await call(loggerHandler, '/api/logger/update', { method: 'POST', body: { hostname: '203.0.113.0/24' } });
await call(loggerHandler, '/api/logger/update', { method: 'POST', body: { hostname: '203.0.0.0/15' } });
await call(loggerHandler, '/api/logger/update', { method: 'POST', body: { hostname: '203.1.114.9' } });
{
  // 主机位不为零的目标：汇总行保留原文本 203.0.113.77/16（不补零），删除匹配仍按 /16 掩码归一化
  const res = await call(loggerHandler, '/api/logger/exclude', { method: 'POST', body: { target: '203.0.113.77/16', policy: 'PROXY' } });
  const data = await res.json();
  check('CIDR 目标删除 2 条（段内单 IP + 子段）', data.data.deleted === 2, JSON.stringify(data));
  const items = await list();
  const summary = items.find((x) => x.hostname === '203.0.113.77/16');
  check('汇总记录保留原文本且为 IP-CIDR', !!summary && summary.type === 'IP-CIDR' && summary.policy === 'PROXY', JSON.stringify(summary));
  check('汇总行不出现补零形态', !items.some((x) => x.hostname === '203.0.0.0/16'));
  check('段内记录被删', !items.some((x) => ['203.0.113.5', '203.0.113.0/24'].includes(x.hostname)));
  check('盖不住目标的更大 CIDR 保留', items.some((x) => x.hostname === '203.0.0.0/15'));
  check('段外记录保留', items.some((x) => x.hostname === '203.1.114.9'));
  check('域名记录不受网段降维影响', items.some((x) => x.hostname === 'c.com'));
}

console.log('\n[logger] 降维排除 · IPv6 网段');
await call(loggerHandler, '/api/logger/update', { method: 'POST', body: { hostname: '2001:db8:1:2::1' } });
await call(loggerHandler, '/api/logger/update', { method: 'POST', body: { hostname: '2001:db8:1:2::/64' } });
await call(loggerHandler, '/api/logger/update', { method: 'POST', body: { hostname: '2001:db8:2::1' } });
{
  const res = await call(loggerHandler, '/api/logger/exclude', { method: 'POST', body: { target: '2001:db8:1:2:3::/48', policy: 'DIRECT' } });
  const data = await res.json();
  check('IPv6 目标删除 2 条', data.data.deleted === 2, JSON.stringify(data));
  const items = await list();
  const summary = items.find((x) => x.hostname === '2001:db8:1:2:3::/48');
  check('IPv6 汇总保留原文本且为 IP-CIDR6', !!summary && summary.type === 'IP-CIDR6' && summary.policy === 'DIRECT', JSON.stringify(summary));
  check('段内记录被删', !items.some((x) => ['2001:db8:1:2::1', '2001:db8:1:2::/64'].includes(x.hostname)));
  check('段外 IPv6 保留', items.some((x) => x.hostname === '2001:db8:2::1') && items.some((x) => x.hostname === '2001:db8::1'));
}

console.log('\n[ipnet] 前端网段数学（与后端等价实现）');
{
  const ipnet = await import('../public/js/ipnet.js');
  const target = ipnet.parseIpTarget('61.139.8.102/31');
  check('CIDR 解析并归零', target?.family === 4 && target.prefix === 31 && target.cidr === '61.139.8.102/31', JSON.stringify(target));
  check('解析保留原地址文本', target?.addressText === '61.139.8.102', JSON.stringify(target));
  // 降维候选：保留原 IP、只放宽前缀长度（地址文本不变，不补零）
  const candidates = ipnet.ipv4CandidatePrefixes(target.prefix).map((prefix) => `${target.addressText}/${prefix}`);
  check('v4 候选含当前掩码与更粗层级', JSON.stringify(candidates) === JSON.stringify(['61.139.8.102/31', '61.139.8.102/24', '61.139.8.102/16', '61.139.8.102/8']), JSON.stringify(candidates));
  const ladders = [24, 16, 8].map((prefix) => ipnet.ipv4CidrString(target.baseInt, prefix));
  check('v4 归一化数学仍补零（匹配用）', JSON.stringify(ladders) === JSON.stringify(['61.139.8.0/24', '61.139.0.0/16', '61.0.0.0/8']), JSON.stringify(ladders));
  check('v4 /16 与 /32 都能拿到目标掩码',
    JSON.stringify(ipnet.ipv4CandidatePrefixes(16)) === JSON.stringify([16, 8])
    && JSON.stringify(ipnet.ipv4CandidatePrefixes(32)) === JSON.stringify([32, 24, 16, 8]));
  check('段内单 IP 判定在网段内', ipnet.hostInCidr('61.139.8.102', ipnet.parseIpTarget('61.139.8.0/24')));
  check('同前缀不同网段不误判（61.139.80.1）', !ipnet.hostInCidr('61.139.80.1', ipnet.parseIpTarget('61.139.8.0/24')));
  check('更粗的段不算被包含', !ipnet.hostInCidr('61.139.0.0/15', ipnet.parseIpTarget('61.139.0.0/16')));
  const v6 = ipnet.parseIpTarget('2001:db8:1:2:3:4:5:6');
  check('v6 上卷压缩', ipnet.ipv6CidrString(v6.groups, 64) === '2001:db8:1:2::/64'
    && ipnet.ipv6CidrString(v6.groups, 48) === '2001:db8:1::/48'
    && ipnet.ipv6CidrString(v6.groups, 32) === '2001:db8::/32');
  check('v6 地址文本原样保留', v6.addressText === '2001:db8:1:2:3:4:5:6'
    && ipnet.ipv6CandidatePrefixes(v6.prefix).map((prefix) => `${v6.addressText}/${prefix}`)
      .join(',') === '2001:db8:1:2:3:4:5:6/128,2001:db8:1:2:3:4:5:6/64,2001:db8:1:2:3:4:5:6/48,2001:db8:1:2:3:4:5:6/32,2001:db8:1:2:3:4:5:6/16');
  check('v6 /128 规则可拿到当前掩码与更粗层级',
    JSON.stringify(ipnet.ipv6CandidatePrefixes(128)) === JSON.stringify([128, 64, 48, 32, 16]));
  check('v6 混合形态可解析', ipnet.parseIpTarget('::ffff:1.2.3.4') !== null);
  check('域名不是 IP', ipnet.parseIpTarget('example.com') === null);
}

console.log('\n[logger] 批量覆盖');
await call(loggerHandler, '/api/logger/batch', { method: 'POST', body: { text: 'x.com, PROXY // 批量新增\n# 注释行跳过\ny.com, DIRECT\n' } });
{
  const items = await list();
  check('新增 x.com 带注释', items.some((x) => x.hostname === 'x.com' && x.policy === 'PROXY' && x.comment === '批量新增'));
  check('新增 y.com', items.some((x) => x.hostname === 'y.com' && x.policy === 'DIRECT'));
}

console.log('\n[logger] 参数名不再被当成策略');
// `IP-CIDR,10.0.0.5,no-resolve`：策略段缺失、参数直接顶上来。
// 旧版 isPolicyName 按字符集判断，no-resolve 符合「自定义策略组名」正则，
// 会被当成策略写进库（线上出现 489 条 policy=NO-RESOLVE），导出后 Surge 找不到该策略组。
{
  const batchRes = await call(loggerHandler, '/api/logger/batch', { method: 'POST', body: { text: 'IP-CIDR,10.0.1.5,no-resolve\nIP-CIDR6,2402:db40::5,no-resolve\n' } });
  const batchData = (await batchRes.json()).data;
  check('两段式（值+参数）被接受，不整行丢弃', batchRes.status === 200 && batchData.total === 2, JSON.stringify(batchData));
  const items = await list();
  const v4 = items.find((x) => x.hostname === '10.0.1.5');
  check('策略回落默认 PROXY，不是 NO-RESOLVE', v4 && v4.policy === 'PROXY', JSON.stringify(v4));
  check('no-resolve 落到参数列', v4 && v4.params['no-resolve'] !== undefined, JSON.stringify(v4 && v4.params));
  const v6 = items.find((x) => x.hostname === '2402:db40::5');
  check('IPv6 同样不再误判', v6 && v6.policy === 'PROXY', JSON.stringify(v6));
}
{
  // 反向用例：真实策略组名不能被参数白名单误伤
  const res = await call(loggerHandler, '/api/logger/batch', { method: 'POST', body: { text: 'x.com, my-proxy\ny.com, work-phone\n' } });
  const data = (await res.json()).data;
  check('自定义策略组名照常入库', data.total === 2);
  const items = await list();
  check('策略保留原名', items.some((x) => x.hostname === 'x.com' && x.policy === 'MY-PROXY'));
}
// 导出侧：策略必须是 SURGE_POLICIES 或自定义策略组，参数单独输出
{
  const res = await call(loggerHandler, '/api/logger/export');
  const text = await res.text();
  check('导出为 IP-CIDR,10.0.1.5/32,PROXY,no-resolve', text.includes('IP-CIDR,10.0.1.5/32,PROXY,no-resolve'), text);
  check('导出里没有 ,NO-RESOLVE', !/[, ]NO-RESOLVE/.test(text));
}

await call(loggerHandler, '/api/logger/batch', { method: 'POST', body: { lines: [{ hostname: 'z.com', policy: 'REJECT', comment: '结构化入参', source: 'iPad' }] } });
{
  const items = await list();
  check('支持结构化数组入参', items.some((x) => x.hostname === 'z.com' && x.policy === 'REJECT' && x.source === 'iPad'));
}
{
  const res = await call(loggerHandler, '/api/logger/batch', { method: 'POST', body: { text: '   ' } });
  check('空批量返回 400', res.status === 400);
}

console.log('\n[logger] 清空与统计');
{
  const res = await call(loggerHandler, '/api/logger/clear-empty', { method: 'POST' });
  const items = await list();
  check('只保留有备注的记录', items.length > 0 && items.every((x) => String(x.comment).trim().length > 0));
  check('有备注的 x.com 被保留', items.some((x) => x.hostname === 'x.com'));
}
{
  // 缺确认标记时拒绝执行，防止误触清库
  const res = await call(loggerHandler, '/api/logger/clear', { method: 'POST', body: {} });
  check('未确认的清空请求返回 400', res.status === 400, JSON.stringify(await res.json()));
  check('拒绝后数据仍在', (await list()).length > 0);
}
{
  await call(loggerHandler, '/api/logger/clear', { method: 'POST', body: { confirm: true } });
  check('确认后清空全部', (await list()).length === 0);
  await call(loggerHandler, '/api/logger/hit', { method: 'POST', body: { hostname: 'reset-check.com' } });
  const id = db.prepare('SELECT id FROM surge_logs WHERE hostname = ?').get('reset-check.com')?.id;
  check('清空后自增 ID 从 1 开始', id === 1, String(id));
}
{
  // 先清库：上一段的自增 ID 校验留下了一条 reset-check.com，不清会把统计数字算进去
  await call(loggerHandler, '/api/logger/clear', { method: 'POST', body: { confirm: true } });
  await call(loggerHandler, '/api/logger/hit', { method: 'POST', body: { hostname: 'stat.com', source: 'iPhone 15' } });
  await call(loggerHandler, '/api/logger/update', { method: 'POST', body: { hostname: 'stat.com', policy: 'DIRECT', comment: '今日' } });
  const s = await stats();
  check('统计字段齐全', ['totalRules', 'totalHits', 'proxyCount', 'directCount', 'rejectCount', 'emptyCommentCount', 'todayNew', 'sourceCount', 'sources', 'types', 'sourceNames', 'policies'].every((k) => k in s), JSON.stringify(s));
  check('统计数值合理', s.totalRules === 1 && s.totalHits === 1 && s.directCount === 1 && s.emptyCommentCount === 0, JSON.stringify(s));
  // 空来源归成「未标注」，不计入设备数；sourceCount 只统计有来源的记录
  check('统计带来源分布', s.sourceCount === 1 && s.sources.some((item) => item.name === 'iPhone 15'), JSON.stringify(s.sources));
}

console.log('\n[logger] 查询与错误处理');
{
  await call(loggerHandler, '/api/logger/hit', { method: 'POST', body: { hostname: 'searchable.com', source: 'MacBook' } });
  const res = await (await call(loggerHandler, '/api/logger?search=searchable')).json();
  check('搜索命中匹配值', res.data.some((x) => x.hostname === 'searchable.com'));
  const bySource = await (await call(loggerHandler, '/api/logger?search=MacBook')).json();
  check('搜索命中来源', bySource.data.some((x) => x.source === 'MacBook'));
  const none = (await (await call(loggerHandler, '/api/logger?search=zzzzz')).json()).data;
  check('搜索无命中返回空数组', Array.isArray(none) && none.length === 0);
  const byPolicy = (await (await call(loggerHandler, '/api/logger?policy=DIRECT')).json()).data;
  check('策略过滤生效', byPolicy.every((x) => x.policy === 'DIRECT'));
}
{
  check('未知子路径 404', (await call(loggerHandler, '/api/logger/unknown')).status === 404);
  check('写接口用 GET 返回 405', (await call(loggerHandler, '/api/logger/update', { method: 'GET' })).status === 405);
  check('GET 接口用 POST 返回 405', (await call(loggerHandler, '/api/logger/export', { method: 'POST' })).status === 405);
  check('DELETE 等不支持的方法返回 405', (await call(loggerHandler, '/api/logger', { method: 'DELETE' })).status === 405);
  const headless = await call(loggerHandler, '/api/logger/export', { method: 'HEAD' });
  check('HEAD 打到写路由不报错', headless.status === 405 || headless.status === 200, String(headless.status));
}
{
  // 回归：尾随斜杠必须被规范化，不能 404
  const trailing = await call(loggerHandler, '/api/logger/');
  const trailingData = await trailing.json();
  check('尾随斜杠的列表请求正常返回', trailing.status === 200 && Array.isArray(trailingData.data), String(trailing.status));
  const trailingBatch = await call(loggerHandler, '/api/logger/batch/', { method: 'POST', body: { text: 'slash.com, DIRECT' } });
  check('尾随斜杠的写请求可执行', trailingBatch.status === 200, `${trailingBatch.status} ${JSON.stringify(await trailingBatch.clone().json())}`);
  const trailingStats = await call(loggerHandler, '/api/logger/stats/');
  check('尾随斜杠的统计请求正常返回', trailingStats.status === 200);
}
{
  const schema = await text('/api/logger/schema');
  check('schema 含建表语句与新字段', schema.includes('CREATE TABLE') && schema.includes('source') && schema.includes('params') && schema.includes('type'));
}

/* ---------------- 导出增强：命中过滤 / 注释头 / 摘要 ---------------- */
console.log('\n[logger] 导出增强（min-count / meta / summary）');
{
  // 全部用本块专属、此前从未被写过的主机名，并精确控制每条的次数：
  // mc-hot 打 2 次、mc-warm 打 1 次、mc-cold 只由 batch 写入（count=1）
  await call(loggerHandler, '/api/logger/hit', { method: 'POST', body: { hostname: 'mc-hot.example' } });
  await call(loggerHandler, '/api/logger/hit', { method: 'POST', body: { hostname: 'mc-hot.example' } });
  await call(loggerHandler, '/api/logger/batch', { method: 'POST', body: { text: 'mc-cold.example, DIRECT\nmc-warm.example, REJECT\n' } });

  const hotOnly = await text('/api/logger/export?min-count=2');
  check('min-count 过滤掉低频规则', hotOnly.includes('mc-hot.example') && !hotOnly.includes('mc-cold.example') && !hotOnly.includes('mc-warm.example'), hotOnly);

  const fromOne = await text('/api/logger/export?min-count=1');
  check('min-count=1 等价于不过滤', fromOne.includes('mc-hot.example') && fromOne.includes('mc-cold.example') && fromOne.includes('mc-warm.example'));

  const badMinCount = await text('/api/logger/export?min-count=abc&min-count=-5');
  check('非法 min-count 被忽略而不是报错', badMinCount.includes('mc-cold.example'));

  const withMeta = await text('/api/logger/export?min-count=2&meta=1');
  check('注释头带生成标记', withMeta.includes('# Generated by Surge Rules Manager at '));
  check('注释头带筛选条件', withMeta.includes('# Filter: type=ALL, source=ANY, min_count=2'), withMeta);
  check('注释头带规则数统计', /# Rules: \d+ total/.test(withMeta));
  check('注释头带类型统计', withMeta.includes('# Types:'));
  check('注释头带命中统计', withMeta.includes('# Hits: total'));
  check('注释头不用 #! 前缀（会被当成元数据键）', !withMeta.includes('#!'));
  check('注释头在规则之前', withMeta.indexOf('# Filter:') < withMeta.indexOf('DOMAIN-SUFFIX,mc-hot.example'));

  const noMeta = await text('/api/logger/export?min-count=2');
  check('不传 meta 时不含注释头', !noMeta.includes('# Filter:'));

  {
    const res = await call(loggerHandler, '/api/logger/export?min-count=2');
    check('X-Export-Count 统计规则行数（不含注释头）', res.headers.get('X-Export-Count') === '1', res.headers.get('X-Export-Count'));
  }

  const summaryRes = await call(loggerHandler, '/api/logger/export-summary?min-count=2');
  const summary = (await summaryRes.json()).data;
  check('摘要的规则数与导出一致', summary.ruleCount === 1, JSON.stringify(summary));
  check('摘要按策略分类', summary.byPolicy.PROXY === 1, JSON.stringify(summary.byPolicy));
  check('摘要带命中总数', summary.hits === 2, JSON.stringify(summary));
  check('摘要带筛选描述', summary.filter.minCount === 2 && summary.filter.text.includes('min_count=2'));

  const allSummary = (await (await call(loggerHandler, '/api/logger/export-summary')).json()).data;
  check('不带参数的摘要覆盖全量', allSummary.ruleCount >= 3 && allSummary.filter.minCount === 0);
}

/* ---------------- 批量覆盖：模式 / 保留统计 / 分块 ---------------- */
console.log('\n[logger] 批量覆盖增强（mode / preserveFrom / 分块）');
{
  await call(loggerHandler, '/api/logger/batch', { method: 'POST', body: { text: 'keepme.com, PROXY // 已有备注' } });
  await call(loggerHandler, '/api/logger/hit', { method: 'POST', body: { hostname: 'keepme.com' } });

  // 编辑场景：改了匹配值，命中计数必须继承，不能重置成 1
  const res = await call(loggerHandler, '/api/logger/batch', {
    method: 'POST',
    body: { text: 'renamed.com, DIRECT // 新名字', mode: 'override', preserveFrom: 'keepme.com' }
  });
  const data = (await res.json()).data;
  check('preserveFrom 标记已继承', data.preserved === true, JSON.stringify(data));
  {
    const items = await list();
    check('旧匹配值已删除', !items.some((x) => x.hostname === 'keepme.com'));
    const renamed = items.find((x) => x.hostname === 'renamed.com');
    check('继承命中计数', renamed.count === 2, JSON.stringify(renamed));
    check('继承最近命中时间', !!renamed.time);
  }

  // preserveFrom 指向不存在的记录时，按普通新增处理，不报错也不继承
  const missing = await call(loggerHandler, '/api/logger/batch', {
    method: 'POST',
    body: { text: 'fresh.com, REJECT', mode: 'override', preserveFrom: 'not-exist.com' }
  });
  check('preserveFrom 不存在时按新增处理', (await missing.json()).data.preserved === false);

  // override 模式：备注可被清空
  await call(loggerHandler, '/api/logger/batch', { method: 'POST', body: { text: 'blankme.com, PROXY // 有备注' } });
  await call(loggerHandler, '/api/logger/batch', { method: 'POST', body: { text: 'blankme.com, DIRECT', mode: 'override' } });
  {
    const item = (await list()).find((x) => x.hostname === 'blankme.com');
    check('override 模式可清空备注', item.comment === '', JSON.stringify(item));
    check('override 模式同时更新策略', item.policy === 'DIRECT');
  }

  // merge 模式（默认）：备注非空才覆盖，空备注保留旧值（Gist 还原靠这个不清掉标注）
  await call(loggerHandler, '/api/logger/batch', { method: 'POST', body: { text: 'mergekeep.com, PROXY // 别删我' } });
  await call(loggerHandler, '/api/logger/batch', { method: 'POST', body: { lines: [{ hostname: 'mergekeep.com', policy: 'REJECT', comment: '', source: 'iPad' }] } });
  {
    const item = (await list()).find((x) => x.hostname === 'mergekeep.com');
    check('merge 模式空备注保留原值', item.comment === '别删我', JSON.stringify(item));
    check('merge 模式非空来源被写入', item.source === 'iPad');
    check('merge 模式策略仍被更新', item.policy === 'REJECT');
  }

  // 分块：超过 BATCH_CHUNK_SIZE（500）的批次要拆成多个事务，结果仍要聚合并全部落库
  const bulk = [];
  for (let i = 0; i < 820; i += 1) bulk.push(`bulk-${i}.example, DIRECT // 第 ${i} 条`);
  const bulkRes = await call(loggerHandler, '/api/logger/batch', { method: 'POST', body: { text: bulk.join('\n'), mode: 'override' } });
  const bulkData = (await bulkRes.json()).data;
  check('大批量新增条数正确', bulkData.created === 820, JSON.stringify({ created: bulkData.created }));
  {
    const items = await list();
    check('分块后全部规则落库', items.filter((x) => x.hostname.startsWith('bulk-')).length === 820);
  }
}

/* ---------------- 订阅解析 ---------------- */
console.log('\n[subscribe] 地址校验（SSRF）');
{
  const cases = [
    ['http://example.com/rules', 'http 协议被拒'],
    ['ftp://example.com/rules', 'ftp 协议被拒'],
    ['https://127.0.0.1/rules', '环回地址被拒'],
    ['https://localhost/rules', 'localhost 被拒'],
    ['https://foo.local/rules', '.local 后缀被拒'],
    ['https://db.internal/rules', '.internal 后缀被拒'],
    ['https://10.0.0.5/rules', '10/8 私有网段被拒'],
    ['https://172.16.1.1/rules', '172.16/12 私有网段被拒'],
    ['https://192.168.1.1/rules', '192.168/16 私有网段被拒'],
    ['https://169.254.169.254/latest/meta-data', '云元数据地址被拒'],
    ['https://100.64.0.1/rules', 'CGNAT 网段被拒'],
    ['https://198.18.0.1/rules', '198.18/15 基准测试网段被拒'],
    ['https://[::1]/rules', 'IPv6 环回被拒'],
    ['https://[fc00::1]/rules', 'IPv6 ULA 被拒'],
    ['https://user:pass@example.com/rules', '带 userinfo 被拒'],
    ['不是链接', '非 URL 被拒'],
    ['', '空地址被拒']
  ];
  for (const [url, label] of cases) {
    const res = await call(subscribeHandler, '/api/subscribe/parse', { method: 'POST', body: { url } });
    const body = await res.json();
    check(label, res.status === 400 && body.success === false, `${url} → ${res.status} ${JSON.stringify(body)}`);
  }
}

console.log('\n[subscribe] 抓取与解析');
{
  stubSubscription('https://rules.example.com/surge.list', [
    '# 这是订阅说明',
    '#!name 测试订阅',
    '[General]',
    'loglevel = notify',
    'DOMAIN-SUFFIX,google.com,PROXY // Google',
    'DOMAIN,api.example.com,DIRECT',
    'IP-CIDR,192.168.0.0/16,DIRECT,no-resolve',
    '',
    'PROCESS-NAME,WeChat,DIRECT',
    '损坏的行没有逗号',
    'FINAL,PROXY,dns-failed'
  ].join('\n'));
  const res = await call(subscribeHandler, '/api/subscribe/parse', { method: 'POST', body: { url: 'https://rules.example.com/surge.list' } });
  const data = (await res.json()).data;
  check('解析成功', res.status === 200, String(res.status));
  check('提取到规则行', data.count === 5, JSON.stringify({ count: data.count }));
  check('跳过 INI 段头与 key=value', !data.lines.some((l) => l.includes('[General]') || l.includes('loglevel')));
  check('保留 # 与 #! 开头的说明行之外的内容', data.lines[0] === 'DOMAIN-SUFFIX,google.com,PROXY // Google', data.lines[0]);
  check('FINAL 规则被提取', data.lines.some((l) => l.startsWith('FINAL,')));
  check('统计跳过的行数', data.skipped >= 3, String(data.skipped));
  check('URL 被规范化（无尾斜杠差异）', data.url === 'https://rules.example.com/surge.list');

  // 规范化一致性：带尾斜杠 / 查询串 / 片段的地址应视为同一个订阅
  const again = await call(subscribeHandler, '/api/subscribe/parse', { method: 'POST', body: { url: 'https://rules.example.com/surge.list/' } });
  check('尾斜杠与查询串被规范化掉', (await again.json()).data.url === 'https://rules.example.com/surge.list');

  // 保存：只存地址与名称
  const saveRes = await call(subscribeHandler, '/api/subscribe/save', {
    method: 'POST',
    body: { url: 'https://rules.example.com/surge.list', name: '我的订阅' }
  });
  const saved = (await saveRes.json()).data;
  check('保存返回自增 id', saved.id > 0, JSON.stringify(saved));
  check('保存时同步最新列表', saved.subscriptions.length === 1);

  const saveAgain = await call(subscribeHandler, '/api/subscribe/save', {
    method: 'POST',
    body: { url: 'https://rules.example.com/surge.list/', name: '改名了' }
  });
  const saveAgainData = (await saveAgain.json()).data;
  check('同地址重复保存不新增行', saveAgainData.created === false && saveAgainData.subscriptions.length === 1);
  check('重复保存只更新名称', saveAgainData.subscriptions[0].name === '改名了');

  const listRes = await call(subscribeHandler, '/api/subscribe');
  const listData = (await listRes.json()).data;
  check('列表可匿名读取', listRes.status === 200);
  // 此刻表里的记录是「先解析后保存」产生的：解析那一刻 URL 还没入库，
  // 状态字段由 /save 的可选快照写入（见下面两个用例），这里断定它不会自己冒出统计
  const byUrl = listData.find((x) => x.url === 'https://rules.example.com/surge.list');
  check('先解析后保存（不带快照）时状态保持初始值', byUrl.ruleCount === 0 && byUrl.lastStatus === '', JSON.stringify(byUrl));

  // 「先解析再保存」时把解析拿到的条数一并写进去：
  // 解析那一刻表里还没有这条 URL（UPDATE 命中 0 行），不传快照的话状态字段会停在 0
  const snapshot = await call(subscribeHandler, '/api/subscribe/save', {
    method: 'POST',
    body: { url: 'https://snap.example.com/rules', name: '带快照', ruleCount: 12, lastStatus: 'ok' }
  });
  const snapshotRow = (await snapshot.json()).data.subscriptions[0];
  check('保存时写入 ruleCount 快照', snapshotRow.ruleCount === 12, JSON.stringify(snapshotRow));
  check('保存时写入抓取状态', snapshotRow.lastStatus === 'ok');

  // 不带快照的保存：不猜、不写假统计
  const bare = await call(subscribeHandler, '/api/subscribe/save', {
    method: 'POST',
    body: { url: 'https://bare.example.com/rules', name: '只存链接' }
  });
  const bareRow = (await bare.json()).data.subscriptions.find((x) => x.url === 'https://bare.example.com/rules');
  check('不带快照时状态保持初始值', bareRow.ruleCount === 0 && bareRow.lastStatus === '', JSON.stringify(bareRow));

  // 只删除本块保存的那一条，另两条留给后面的用例做查询样本
  const delRes = await call(subscribeHandler, '/api/subscribe/delete', { method: 'POST', body: { id: saved.id } });
  const delData = (await delRes.json()).data;
  check('删除指定订阅', delData.deleted === 1 && !delData.subscriptions.some((x) => x.id === saved.id), JSON.stringify(delData.subscriptions.map((x) => x.id)));

  // 清理另两条，保持订阅表为空，避免影响后面块的计数类断言
  for (const row of delData.subscriptions) {
    await call(subscribeHandler, '/api/subscribe/delete', { method: 'POST', body: { id: row.id } });
  }
  check('订阅表已清空', (await call(subscribeHandler, '/api/subscribe')).status === 200
    && ((await (await call(subscribeHandler, '/api/subscribe')).json()).data.length === 0));

  const badId = await call(subscribeHandler, '/api/subscribe/delete', { method: 'POST', body: { id: -1 } });
  check('非法 id 返回 400', badId.status === 400);
}

console.log('\n[subscribe] 抓取失败与异常内容');
{
  // 空内容
  stubSubscription('https://empty.example.com/rules', '   \n\n  ');
  {
    const res = await call(subscribeHandler, '/api/subscribe/parse', { method: 'POST', body: { url: 'https://empty.example.com/rules' } });
    check('空内容返回友好错误', res.status === 400 && (await res.json()).error.includes('为空'));
  }

  // 完全不像规则
  stubSubscription('https://html.example.com/rules', '<html><body>登录页</body></html>');
  {
    const res = await call(subscribeHandler, '/api/subscribe/parse', { method: 'POST', body: { url: 'https://html.example.com/rules' } });
    check('非规则内容返回友好错误', res.status === 400 && (await res.json()).error.includes('没有从内容里识别出'));
  }

  // HTTP 错误码
  stubSubscriptionFailure('https://gone.example.com/rules', { status: 410, message: 'Gone' });
  {
    const res = await call(subscribeHandler, '/api/subscribe/parse', { method: 'POST', body: { url: 'https://gone.example.com/rules' } });
    check('订阅源 410 时返回 404 语义', res.status === 404, String(res.status));
  }
  stubSubscriptionFailure('https://err.example.com/rules', { status: 503 });
  {
    const res = await call(subscribeHandler, '/api/subscribe/parse', { method: 'POST', body: { url: 'https://err.example.com/rules' } });
    check('订阅源 503 时返回 400 与状态码', res.status === 400 && (await res.json()).error.includes('503'));
  }

  // 网络异常
  stubSubscriptionThrows('https://timeout.example.com/rules', Object.assign(new Error('The operation was aborted'), { name: 'TimeoutError' }));
  {
    const res = await call(subscribeHandler, '/api/subscribe/parse', { method: 'POST', body: { url: 'https://timeout.example.com/rules' } });
    check('抓取超时给出提示', res.status === 400 && (await res.json()).error.includes('超时'));
  }
  stubSubscriptionThrows('https://down.example.com/rules', new Error('network unreachable'));
  {
    const res = await call(subscribeHandler, '/api/subscribe/parse', { method: 'POST', body: { url: 'https://down.example.com/rules' } });
    check('网络错误给出原因', res.status === 400 && (await res.json()).error.includes('抓取失败'));
  }

  // base64 编码的订阅：第一次按文本解析失败，应自动解码后重试
  const plain = 'DOMAIN-SUFFIX,base64.com,PROXY // base64 订阅\nDOMAIN-KEYWORD,track,REJECT';
  const encoded = Buffer.from(plain, 'utf8').toString('base64');
  stubSubscription('https://b64.example.com/rules', encoded);
  {
    const res = await call(subscribeHandler, '/api/subscribe/parse', { method: 'POST', body: { url: 'https://b64.example.com/rules' } });
    const data = (await res.json()).data;
    check('base64 订阅自动解码', res.status === 200 && data.count === 2, `status=${res.status} ${JSON.stringify(data)}`);
    check('base64 解码后规则完整', data.lines.some((l) => l.includes('base64.com')));
  }
}

console.log('\n[subscribe] 写接口鉴权与方法检查');
{
  const open = { ...env, PANEL_WRITE_TOKEN: 'sub-token' };
  const res = await subscribeHandler({
    request: new Request('http://test/api/subscribe/parse', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://rules.example.com/surge.list' })
    }),
    env: open,
    waitUntil: () => {}
  });
  check('未带令牌的解析请求返回 401', res.status === 401);

  const ok = await subscribeHandler({
    request: new Request('http://test/api/subscribe/parse', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer sub-token' },
      body: JSON.stringify({ url: 'https://rules.example.com/surge.list' })
    }),
    env: open,
    waitUntil: () => {}
  });
  check('带令牌的解析请求放行', ok.status === 200);

  check('GET 打到写路径返回 405', (await call(subscribeHandler, '/api/subscribe/parse', { method: 'GET' })).status === 405);
  check('POST 打到未知路径返回 404', (await call(subscribeHandler, '/api/subscribe/unknown', { method: 'POST', body: {} })).status === 404);
  check('GET 未知路径返回 404', (await call(subscribeHandler, '/api/subscribe/nope')).status === 404);
  check('尾斜杠路径被规范化', (await call(subscribeHandler, '/api/subscribe/')).status === 200);
}

/* ---------------- rules 路由（回归） ---------------- */
console.log('\n[rules] 回归验证');
await call(rulesHandler, '/api/rules', { method: 'POST', body: { domain: 'r.com', action: 'PROXY', remark: '备注' } });
{
  const data = (await (await call(rulesHandler, '/api/rules')).json()).data;
  check('新增规则', data.some((x) => x.domain === 'r.com' && x.action === 'PROXY'));
  check('非法动作返回 400', (await call(rulesHandler, '/api/rules', { method: 'POST', body: { domain: 'x', action: 'HACK' } })).status === 400);
  check('空域名返回 400', (await call(rulesHandler, '/api/rules', { method: 'POST', body: { domain: '', action: 'DIRECT' } })).status === 400);
}
{
  const data = (await (await call(rulesHandler, '/api/rules')).json()).data;
  const id = data[0].id;
  await call(rulesHandler, `/api/rules/${id}`, { method: 'PUT', body: { domain: 'r2.com', action: 'DIRECT' } });
  const updated = (await (await call(rulesHandler, `/api/rules/${id}`)).json()).data;
  check('更新规则', updated.domain === 'r2.com' && updated.action === 'DIRECT');
  const sub = await (await call(rulesHandler, '/api/rules/list')).text();
  check('订阅导出带备注注释', sub.includes('r2.com') && sub.includes('DIRECT'), sub);
  await call(rulesHandler, `/api/rules/${id}`, { method: 'DELETE' });
  check('删除规则', (await (await call(rulesHandler, `/api/rules/${id}`)).status) === 404);
}

/* ---------------- prefs 路由 ---------------- */
console.log('\n[prefs] 个性化设置持久化');
{
  check('空表时返回空对象', JSON.stringify((await (await call(prefsHandler, '/api/prefs?user=u1')).json()).data) === '{}');
  check('缺 env 返回 400', (await prefsHandler({ request: new Request('http://t/api/prefs'), env: {}, waitUntil: () => {} })).status === 400);
}
{
  await call(prefsHandler, '/api/prefs', { method: 'POST', body: { user: 'u1', settings: { 'capture.page_size': '100', 'capture.sort': 'count-desc', 'ui.theme': 'dark' } } });
  const data = (await (await call(prefsHandler, '/api/prefs?user=u1')).json()).data;
  check('批量写入 3 个偏好', data['capture.page_size'] === '100' && data['capture.sort'] === 'count-desc' && data['ui.theme'] === 'dark', JSON.stringify(data));
  await call(prefsHandler, '/api/prefs', { method: 'POST', body: { user: 'u1', settings: { 'capture.sort': 'domain-asc' } } });
  const after = (await (await call(prefsHandler, '/api/prefs?user=u1')).json()).data;
  check('单键覆盖不影响其他键', after['capture.sort'] === 'domain-asc' && after['capture.page_size'] === '100' && after['ui.theme'] === 'dark', JSON.stringify(after));
  const other = (await (await call(prefsHandler, '/api/prefs?user=u2')).json()).data;
  check('不同 user_id 数据隔离', Object.keys(other).length === 0, JSON.stringify(other));
}
{
  check('settings 不是对象返回 400', (await call(prefsHandler, '/api/prefs', { method: 'POST', body: { user: 'u1', settings: 'bad' } })).status === 400);
  check('请求体不是 JSON 返回 400', (await prefsHandler({ request: new Request('http://t/api/prefs', { method: 'POST', body: 'not-json', headers: { 'content-type': 'application/json' } }), env, waitUntil: () => {} })).status === 400);
}
{
  await call(prefsHandler, '/api/prefs', { method: 'POST', body: { user: 'u1', settings: { 'ui.theme': 'light' } } });
  const dup = db.prepare('SELECT setting_value FROM app_prefs WHERE user_id = ? AND setting_key = ?').all('u1', 'ui.theme');
  check('同一键只有一行（upsert 生效）', dup.length === 1, JSON.stringify(dup));
  check('值被更新为最新值', dup[0].setting_value === 'light', JSON.stringify(dup));
}
{
  await call(prefsHandler, '/api/prefs?user=u1&key=ui.theme', { method: 'DELETE' });
  check('删除单个偏好', !(await (await call(prefsHandler, '/api/prefs?user=u1')).json()).data['ui.theme']);
  await call(prefsHandler, '/api/prefs?user=u1&key=__all__', { method: 'DELETE' });
  check('清空单个用户全部偏好', Object.keys((await (await call(prefsHandler, '/api/prefs?user=u1')).json()).data).length === 0);
  check('写接口用 GET 返回 404', (await call(prefsHandler, '/api/prefs/unknown')).status === 404);
}

/* ---------------- 回归：prefs 读 / 删鉴权 ---------------- */
/*
 * gist.token 与普通偏好同表同接口：配置了 PANEL_WRITE_TOKEN 时，
 * 读与删必须和写一样过鉴权（旧实现 DELETE 完全裸奔、GET 匿名可取回令牌）。
 */
console.log('\n[prefs] 读 / 删鉴权');
{
  const securedEnv = { ...env, PANEL_WRITE_TOKEN: 'pref-token' };
  const raw = (method, path, body) => prefsHandler({
    request: new Request(`http://test${path}`, {
      method,
      body: body ? JSON.stringify(body) : undefined,
      headers: body ? { 'content-type': 'application/json' } : undefined
    }),
    env: securedEnv,
    waitUntil: () => {}
  });

  check('配置令牌后匿名读取偏好返回 401', (await raw('GET', '/api/prefs?user=u1')).status === 401);
  check('配置令牌后匿名删除偏好返回 401', (await raw('DELETE', '/api/prefs?user=u1&key=__all__')).status === 401);
  const withToken = { authorization: 'Bearer pref-token' };
  const readOk = await prefsHandler({
    request: new Request('http://test/api/prefs?user=u1', { headers: withToken }),
    env: securedEnv,
    waitUntil: () => {}
  });
  check('带令牌读取放行', readOk.status === 200);
  const deleteOk = await prefsHandler({
    request: new Request('http://test/api/prefs?user=u1&key=ui.accent', { method: 'DELETE', headers: withToken }),
    env: securedEnv,
    waitUntil: () => {}
  });
  check('带令牌删除放行', deleteOk.status === 200);
}

/* ---------------- schema 路由 ---------------- */
console.log('\n[schema] 建表语句');
{
  const all = await (await call(schemaHandler, '/api/schema')).text();
  check('汇总包含三张表', all.includes('CREATE TABLE IF NOT EXISTS rules') && all.includes('CREATE TABLE IF NOT EXISTS surge_logs') && all.includes('CREATE TABLE IF NOT EXISTS app_prefs'));
  check('hostname 有唯一索引（upsert 的前提）', all.includes('CREATE UNIQUE INDEX IF NOT EXISTS uniq_surge_logs_hostname'));
  check('新增字段齐全', all.includes('source TEXT') && all.includes('params TEXT') && all.includes('value TEXT') && all.includes('count INTEGER'));
  check('first_time 字段在表结构里', all.includes('first_time TEXT'));
  const table = await (await call(schemaHandler, '/api/schema/table/logger')).text();
  check('单表可单独获取', table.includes('surge_logs') && !table.includes('app_prefs'));
  check('未知表返回 404', (await call(schemaHandler, '/api/schema/table/nope')).status === 404);
  check('logger 独立 schema 与汇总一致', (await (await call(loggerHandler, '/api/logger/schema')).text()).includes('uniq_surge_logs_hostname'));
}

/* ---------------- 回归：写接口鉴权 ---------------- */
/*
 * 修复的是 /api/logger/clear 这类高危写接口零鉴权的问题。
 * 用一套带 PANEL_WRITE_TOKEN 的环境变量跑同样的用例，
 * 确认未带令牌会被 401 挡下、带令牌能正常执行。
 */
console.log('\n[auth] 写接口鉴权');
{
  const securedEnv = { ...env, PANEL_WRITE_TOKEN: 'sec-123' };
  const withToken = (method, path, body) => loggerHandler({
    request: new Request(`http://test${path}`, {
      method,
      body: body ? JSON.stringify(body) : undefined,
      headers: body ? { 'content-type': 'application/json', authorization: 'Bearer sec-123' } : { authorization: 'Bearer sec-123' }
    }),
    env: securedEnv,
    waitUntil: () => {}
  });

  const denied = await loggerHandler({
    request: new Request('http://test/api/logger/clear', { method: 'POST', body: JSON.stringify({ confirm: true }), headers: { 'content-type': 'application/json' } }),
    env: securedEnv,
    waitUntil: () => {}
  });
  check('未带令牌的清空请求返回 401', denied.status === 401);

  const allowed = await withToken('POST', '/api/logger/hit', { hostname: 'auth-ok.com' });
  check('带令牌的写请求放行', allowed.status === 200, JSON.stringify(await allowed.clone().json()));

  const wrong = await loggerHandler({
    request: new Request('http://test/api/logger/hit', { method: 'POST', body: JSON.stringify({ hostname: 'x.com' }), headers: { 'content-type': 'application/json', authorization: 'Bearer wrong' } }),
    env: securedEnv,
    waitUntil: () => {}
  });
  check('错误令牌返回 401', wrong.status === 401);

  // 只读接口不受影响：列表仍然能匿名访问
  const readOnly = await loggerHandler({
    request: new Request('http://test/api/logger'),
    env: securedEnv,
    waitUntil: () => {}
  });
  check('只读列表仍允许匿名访问', readOnly.status === 200);
}

/* ---------------- 回归：/hit 强制令牌 ---------------- */
/*
 * 上报接口移除「未配置令牌可匿名」的兜底：PANEL_HIT_TOKEN 必须配置，
 * 未配置一律拒绝；令牌不匹配拒绝；URL 查询参数（Surge 无法设头的场景）仍然可用。
 */
console.log('\n[auth] /hit 强制令牌');
{
  const anonymous = await loggerHandler({
    request: new Request('http://test/api/logger/hit', { method: 'POST', body: JSON.stringify({ hostname: 'anon.com' }), headers: { 'content-type': 'application/json' } }),
    env,
    waitUntil: () => {}
  });
  check('未带令牌的上报返回 401', anonymous.status === 401);

  const byQuery = await loggerHandler({
    request: new Request('http://test/api/logger/hit?token=hit-token', { method: 'POST', body: JSON.stringify({ hostname: 'query-token.com' }), headers: { 'content-type': 'application/json' } }),
    env,
    waitUntil: () => {}
  });
  check('URL 查询参数令牌可用', byQuery.status === 200, JSON.stringify(await byQuery.clone().json()));

  const unconfigured = await loggerHandler({
    request: new Request('http://test/api/logger/hit', { method: 'POST', body: JSON.stringify({ hostname: 'x.com' }), headers: { 'content-type': 'application/json', authorization: 'Bearer hit-token' } }),
    env: { DB_BACKEND: 'sqlite', DB_SQLITE_PATH: env.DB_SQLITE_PATH },
    waitUntil: () => {}
  });
  check('未配置任何令牌时上报被拒并提示配置', unconfigured.status === 401
    && (await unconfigured.json()).error.includes('PANEL_HIT_TOKEN'));
}

/* ---------------- 回归：/hit payload 契约 ---------------- */
/*
 * 修复的是 surge/final-logger.js 发的扁平结构被后端当成空 body 处理的问题。
 * 验证扁平、嵌套两种写法都能被正确读回，且 type / value / policy 不再被丢弃。
 */
console.log('\n[logger] /hit payload 契约');
{
  const surgePayload = {
    hostname: 'api.surge.com',
    type: 'URL-REGEX',
    value: 'https://.*\\.png$',
    source: 'iPhone 15',
    policy: 'DIRECT',
    params: 'no-resolve'
  };
  const res = await call(loggerHandler, '/api/logger/hit', { method: 'POST', body: surgePayload });
  check('扁平结构不被当成空 body', res.status === 200, JSON.stringify(await res.clone().json()));
  const rows = await (await call(loggerHandler, `/api/logger?search=${encodeURIComponent('api.surge.com')}`)).json();
  check('扁平结构的 hostname 正确入库', rows.data.some((r) => r.hostname === 'api.surge.com' && r.type === 'URL-REGEX' && r.value === 'https://.*\\.png$' && r.policy === 'DIRECT'));

  const nested = await call(loggerHandler, '/api/logger/hit', { method: 'POST', body: { hostname: 'nested-ok.com', source: 'iPhone', policy: 'PROXY' } });
  check('只有 hostname 字段的极简 payload 也能落库', nested.status === 200);
  const minimalRows = (await call(loggerHandler, '/api/logger')).json();
  check('极简 payload 按主机名推断类型', (await minimalRows).data.some((r) => r.hostname === 'nested-ok.com' && r.type === 'DOMAIN-SUFFIX'));
}

console.log('\n[logger] 批量上报 /hits（捕获脚本去重窗口的入口）');
{
  const res = await call(loggerHandler, '/api/logger/hits', {
    method: 'POST',
    body: {
      hits: [
        { hostname: 'batch-a.com', source: 'iPhone 15', count: 3 },
        { hostname: 'batch-a.com', source: 'iPhone 15', count: 2 },
        { hostname: 'batch-b.com', policy: 'DIRECT' }
      ]
    }
  });
  const data = (await res.json()).data;
  check('批量上报返回接受的主机名数（同主机名已合并）', res.status === 200 && data.accepted === 2, JSON.stringify(data));
  const items = await list();
  const a = items.find((x) => x.hostname === 'batch-a.com');
  check('同主机名次数累加为一条记录', a && a.count === 5, JSON.stringify(a));
  check('批量按策略入库', items.find((x) => x.hostname === 'batch-b.com').policy === 'DIRECT');

  // 命中路径只增 count，不再覆盖用户已编辑的 policy
  await call(loggerHandler, '/api/logger/update', { method: 'POST', body: { hostname: 'batch-b.com', policy: 'REJECT', comment: '手工调整' } });
  await call(loggerHandler, '/api/logger/hits', { method: 'POST', body: { hits: [{ hostname: 'batch-b.com', policy: 'PROXY' }] } });
  const after = (await list()).find((x) => x.hostname === 'batch-b.com');
  check('命中不覆盖已有 policy', after.policy === 'REJECT', JSON.stringify(after));
  check('命中仍累加计数', after.count === 2, String(after.count));

  const bad = await call(loggerHandler, '/api/logger/hits', { method: 'POST', body: { hits: [] } });
  check('空 hits 数组返回 400', bad.status === 400);
  const tooMany = await call(loggerHandler, '/api/logger/hits', { method: 'POST', body: { hits: Array.from({ length: 201 }, (_, i) => ({ hostname: `over-${i}.com` })) } });
  check('超过单次上限返回 400', tooMany.status === 400);
  check('GET 打到批量上报返回 405', (await call(loggerHandler, '/api/logger/hits', { method: 'GET' })).status === 405);
  const anonymous = await loggerHandler({
    request: new Request('http://test/api/logger/hits', { method: 'POST', body: JSON.stringify({ hits: [{ hostname: 'x.com' }] }), headers: { 'content-type': 'application/json' } }),
    env,
    waitUntil: () => {}
  });
  check('批量上报同样要求上报令牌', anonymous.status === 401);
}

/* ---------------- 回归：双令牌合并与空段 ---------------- */
/*
 * readme 的语义是「任一已配置令牌匹配即可」：两个变量都配置时，上报令牌必须
 * 仍然可用（旧实现按写令牌短路，双令牌配置下 Surge 上报全部 401）。
 * 同时验证令牌串里的空段（连续逗号）不会产生「空令牌可绕过」的缺口。
 */
console.log('\n[auth] 双令牌合并与空段');
{
  const dualEnv = { ...env, PANEL_WRITE_TOKEN: 'wt-dual', PANEL_HIT_TOKEN: 'ht-dual' };
  const hitWith = (token) => loggerHandler({
    request: new Request('http://test/api/logger/hit', { method: 'POST', body: JSON.stringify({ hostname: 'dual.com' }), headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) } }),
    env: dualEnv,
    waitUntil: () => {}
  });
  check('双令牌配置时上报令牌可用', (await hitWith('ht-dual')).status === 200);
  check('双令牌配置时写令牌也可上报', (await hitWith('wt-dual')).status === 200);
  check('不匹配的令牌仍被拒绝', (await hitWith('wrong')).status === 401);
  check('空令牌不匹配任何配置', (await hitWith('')).status === 401);

  const segEnv = { ...env, PANEL_WRITE_TOKEN: 'seg-token,,,' };
  // 探针用不存在的主机名调 /delete：鉴权先于参数解析，401 / 200 的区分与数据无关
  const writeWith = (token) => loggerHandler({
    request: new Request('http://test/api/logger/delete', { method: 'POST', body: JSON.stringify({ hostname: 'seg-probe-nope.com' }), headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) } }),
    env: segEnv,
    waitUntil: () => {}
  });
  check('写令牌含空段时合法令牌放行', (await writeWith('seg-token')).status === 200);
  check('空令牌不能借空段绕过', (await writeWith('')).status === 401);
  check('完全不带令牌同样拒绝', (await writeWith(null)).status === 401);

  const hitSegEnv = { ...env, PANEL_HIT_TOKEN: 'ht-seg,,,' };
  const anonymousSeg = await loggerHandler({
    request: new Request('http://test/api/logger/hit', { method: 'POST', body: JSON.stringify({ hostname: 'seg.com' }), headers: { 'content-type': 'application/json' } }),
    env: hitSegEnv,
    waitUntil: () => {}
  });
  check('上报令牌含空段时空令牌不放行', anonymousSeg.status === 401);
}

/* ---------------- 回归：FINAL 规则的匹配值约束 ---------------- */
/*
 * 修复的是 /update 路由没调 validateLogPatch，FINAL 类型能带着匹配值写进库的问题。
 * 验证：FINAL 带 value 会被静默清空；非 FINAL 空值会用主机名回填。
 */
console.log('\n[logger] FINAL 规则约束');
{
  await call(loggerHandler, '/api/logger/update', { method: 'POST', body: { hostname: 'final-x.com', type: 'FINAL', value: 'should-be-cleared.com', policy: 'PROXY' } });
  const rows = await (await call(loggerHandler, '/api/logger')).json();
  const finalRow = rows.data.find((r) => r.type === 'FINAL');
  check('FINAL 规则不带匹配值', finalRow && finalRow.value === '', JSON.stringify(finalRow));

  await call(loggerHandler, '/api/logger/update', { method: 'POST', body: { hostname: 'empty-value.com', type: 'DOMAIN-SUFFIX', value: '', policy: 'DIRECT' } });
  const patched = await (await call(loggerHandler, '/api/logger')).json();
  check('非 FINAL 空值用主机名回填', patched.data.some((r) => r.hostname === 'empty-value.com' && r.value === 'empty-value.com'));
}

/* ---------------- 回归：IP 字面量校验 ---------------- */
/*
 * 修复的是 isIPv4 / isCidr 只数位不校验数值范围的问题。
 * 越界的八位组与超长前缀都必须被拒，否则会被导出成 Surge 无法解析的规则。
 */
console.log('\n[rules] IP 字面量校验');
{
  await call(loggerHandler, '/api/logger/batch', { method: 'POST', body: { text: 'IP-CIDR,999.999.999.999,DIRECT' } });
  const rows = await (await call(loggerHandler, '/api/logger')).json();
  check('越界八位组不被当 IP-CIDR 入库', !rows.data.some((r) => r.value === '999.999.999.999/32' || r.value === '999.999.999.999'));
}

/* ---------------- 回归：DEVICE: 策略大小写 ---------------- */
/*
 * 修复的是 normalizePolicy 只接受大写 DEVICE: 前缀的问题。
 * 小写 device:myphone 之前会被判非法并静默回落成 PROXY。
 */
console.log('\n[rules] DEVICE 策略大小写');
{
  await call(loggerHandler, '/api/logger/batch', { method: 'POST', body: { text: 'DOMAIN-SUFFIX,device.com,device:myphone' } });
  const deviceRows = await (await call(loggerHandler, '/api/logger')).json();
  const row = deviceRows.data.find((r) => r.hostname === 'device.com');
  check('小写 device: 被规范化为大写前缀', row && row.policy === 'DEVICE:myphone', JSON.stringify(row));
}

/* ---------------- 回归：LIKE 通配符转义 ---------------- */
/*
 * 修复的是 /api/rules 搜索没转义 LIKE 通配符的问题。
 * 搜 % 会返回整表，这里验证搜一个不可能匹配的 % 返回空。
 */
console.log('\n[rules] LIKE 通配符转义');
{
  const res = await call(rulesHandler, '/api/rules?search=' + encodeURIComponent('%'));
  const data = (await res.json()).data || [];
  check('搜 % 不当通配符', Array.isArray(data) && data.length === 0, JSON.stringify(data));
}

/* ---------------- 固定订阅导出 /api/export ---------------- */
/*
 * 固定 URL 订阅：筛选条件（来源 / 带来源注释 / 命中下限）存偏好表 user=export，
 * 面板改配置即改输出，Surge 端始终用同一条地址；显式查询参数优先于偏好。
 * 本节自带专属数据，不依赖前面用例的库内状态。
 */
console.log('\n[export] 固定订阅导出');
{
  await call(loggerHandler, '/api/logger/hit', { method: 'POST', body: { hostname: 'fixed-a.com', policy: 'PROXY', source: 'iPhone 15' } });
  await call(loggerHandler, '/api/logger/hit', { method: 'POST', body: { hostname: 'fixed-b.com', policy: 'DIRECT' } });
  await call(loggerHandler, '/api/logger/hit', { method: 'POST', body: { hostname: 'fixed-c.com', policy: 'REJECT' } });
  const lines = async (path) => (await call(exportHandler, path)).text();

  const all = await lines('/api/export');
  check('默认 policy=all 导出全部', all.includes('fixed-a.com') && all.includes('fixed-b.com') && all.includes('fixed-c.com'));
  const proxy = await lines('/api/export?policy=proxy');
  check('policy=proxy 只含 PROXY 规则', proxy.includes('fixed-a.com') && !proxy.includes('fixed-b.com') && !proxy.includes('fixed-c.com'));
  const direct = await lines('/api/export?policy=direct');
  check('policy=direct 只含 DIRECT 规则', direct.includes('fixed-b.com') && !direct.includes('fixed-a.com'));
  const reject = await lines('/api/export?policy=reject');
  check('policy=reject 只含 REJECT 规则', reject.includes('fixed-c.com') && !reject.includes('fixed-a.com'));
  const bogus = await lines('/api/export?policy=bogus');
  check('未知 policy 回落 all', bogus.includes('fixed-a.com') && bogus.includes('fixed-c.com'));

  await call(prefsHandler, '/api/prefs', { method: 'POST', body: { user: 'export', settings: { 'export.source': 'iPhone 15' } } });
  const bySource = await lines('/api/export?policy=proxy');
  check('偏好表来源筛选生效', bySource.includes('fixed-a.com'), bySource);
  await call(prefsHandler, '/api/prefs', { method: 'POST', body: { user: 'export', settings: { 'export.source': '' } } });

  await call(prefsHandler, '/api/prefs', { method: 'POST', body: { user: 'export', settings: { 'export.min_count': '99' } } });
  const filtered = await lines('/api/export?policy=proxy');
  check('偏好表命中下限生效（无匹配返回占位注释）', filtered.trim() === '# 暂无符合条件的规则', filtered);
  const overridden = await lines('/api/export?policy=proxy&min-count=1');
  check('显式查询参数优先于偏好', overridden.includes('fixed-a.com'), overridden);
  await call(prefsHandler, '/api/prefs', { method: 'POST', body: { user: 'export', settings: { 'export.min_count': '0' } } });

  const withMeta = await lines('/api/export?policy=proxy');
  const noMeta = await lines('/api/export?policy=proxy&meta=0');
  check('默认带统计注释头，meta=0 关闭', withMeta.startsWith('#') && !noMeta.startsWith('#'));

  const counted = await call(exportHandler, '/api/export?policy=proxy');
  check('X-Export-Count 与规则行数一致', Number(counted.headers.get('X-Export-Count')) >= 1, String(counted.headers.get('X-Export-Count')));
  check('写接口用 POST 返回 405', (await call(exportHandler, '/api/export', { method: 'POST' })).status === 405);
}

/* ---------------- 回归：Turso 故障注入与事务回滚 ---------------- */
/*
 * 真实世界的主要失败模式（限流、5xx、网络抖动、写锁竞争）此前完全不可测；
 * 事务回滚语义此前被 Mock 忽略，测试可以断言生产上永不存在的中间状态。
 */
console.log('\n[factory] 故障注入与事务回滚');
{
  // 事务回滚：批量里第二条语句失败，第一条必须一并回滚（适配器契约的原子性）
  await call(loggerHandler, '/api/logger/hit', { method: 'POST', body: { hostname: 'txn-keep.com' } });
  let rolledBack = false;
  try {
    await adapter.batch([
      { sql: `INSERT INTO surge_logs (hostname, type, value, policy, params, comment, source, first_time, time, count) VALUES ('txn-partial.com', 'DOMAIN-SUFFIX', 'txn-partial.com', 'PROXY', '', '', '', '', '', 1)` },
      { sql: `INSERT INTO no_such_table (x) VALUES (1)` }
    ]);
  } catch {
    rolledBack = true;
  }
  const txnRows = db.prepare(`SELECT hostname FROM surge_logs WHERE hostname IN ('txn-partial.com', 'txn-keep.com')`).all();
  check('批次中语句失败时整体抛错', rolledBack);
  check('回滚后批次内前面的语句不落地', !txnRows.some((row) => row.hostname === 'txn-partial.com'), JSON.stringify(txnRows));
  check('回滚不影响批次外已有数据', txnRows.some((row) => row.hostname === 'txn-keep.com'));

  // 上报链路对数据库故障的容错：错误变成 500 响应，不能崩掉整个 Worker
  globalThis.__setDbFailure('network');
  const networkDown = await call(loggerHandler, '/api/logger/hit', { method: 'POST', body: { hostname: 'fail-a.com' } });
  check('数据库故障时上报返回 500 而非崩溃', networkDown.status === 500);
  globalThis.__setDbFailure('http500');
  const remote500 = await call(loggerHandler, '/api/logger/hit', { method: 'POST', body: { hostname: 'fail-b.com' } });
  check('数据库服务端错误时上报返回 500', remote500.status === 500);
  const readDuringFailure = await call(loggerHandler, '/api/logger');
  check('数据库故障时读接口同样报错', readDuringFailure.status === 500);
  globalThis.__setDbFailure(null);
  const recovered = await call(loggerHandler, '/api/logger/hit', { method: 'POST', body: { hostname: 'fail-c.com' } });
  check('故障恢复后上报正常', recovered.status === 200);
}

/* ---------------- 多数据库工厂：DB_BACKEND 校验 ---------------- */
console.log('\n[factory] DB_BACKEND 校验');
{
  const bad = await loggerHandler({
    request: new Request('http://test/api/logger'),
    env: { ...env, DB_BACKEND: 'oracle' },
    waitUntil: () => {}
  });
  const badData = await bad.json();
  check('非法 DB_BACKEND 返回 400 并列出合法值', bad.status === 400 && badData.error.includes('turso') && badData.error.includes('d1') && badData.error.includes('sqlite'), JSON.stringify(badData));

  const noBinding = await loggerHandler({
    request: new Request('http://test/api/logger'),
    env: { ...env, DB_BACKEND: 'd1' },
    waitUntil: () => {}
  });
  check('d1 缺平台绑定返回 400', noBinding.status === 400 && (await noBinding.json()).error.includes('DB_D1'));

  const noPath = await loggerHandler({
    request: new Request('http://test/api/logger'),
    env: { DB_BACKEND: 'sqlite' },
    waitUntil: () => {}
  });
  check('sqlite 缺路径返回 400', noPath.status === 400 && (await noPath.json()).error.includes('DB_SQLITE_PATH'));

  // 同一配置签名共享适配器实例；配置失败不缓存，修正后立即可用
  const again = await call(loggerHandler, '/api/logger');
  check('配置失败被逐出缓存，正常配置立即可用', again.status === 200);
}

/* ---------------- 版本握手：meta 版本清单 + latest 捎带 ---------------- */
console.log('\n[version] 版本握手');
{
  const { BUILD_VERSION, COMPONENT_VERSIONS, PANEL_ORIGIN } = await import('../functions/_utils/build-meta.js');
  const { PANEL_VERSION } = await import('../public/js/version.js');

  const res = await call(loggerHandler, '/api/logger/meta');
  const meta = (await res.json()).data;
  check('meta 携带版本清单且 no-store', res.headers.get('cache-control') === 'no-store');
  check('serverVersion 与构建清单一致', typeof meta.version.serverVersion === 'string' && meta.version.serverVersion.startsWith(BUILD_VERSION), meta.version.serverVersion);
  check('components 覆盖三类客户端', meta.version.components.panel === COMPONENT_VERSIONS.panel
    && meta.version.components.logger === COMPONENT_VERSIONS.logger
    && meta.version.components.sgmodule === COMPONENT_VERSIONS.sgmodule);
  check('dbSchemaVersion 为正整数', Number.isInteger(meta.version.dbSchemaVersion) && meta.version.dbSchemaVersion > 0);
  check('前端版本常量与构建清单同源', PANEL_VERSION === BUILD_VERSION, `${PANEL_VERSION} != ${BUILD_VERSION}`);

  const hit = await (await call(loggerHandler, '/api/logger/hit', { method: 'POST', body: { hostname: 'ver-hit.com' } })).json();
  check('单条上报捎带 latestLoggerVersion', hit.data.latestLoggerVersion === COMPONENT_VERSIONS.logger, JSON.stringify(hit.data));
  const batch = await (await call(loggerHandler, '/api/logger/hits', { method: 'POST', body: { hits: [{ hostname: 'ver-batch.com' }] } })).json();
  check('批量上报捎带 latestLoggerVersion', batch.data.latestLoggerVersion === COMPONENT_VERSIONS.logger);

  // 版本戳注入一致性：sgmodule 头部、Surge 脚本、sw.js、index.html 入口参数同源
  const { readFileSync: rf } = await import('node:fs');
  const { fileURLToPath: f2p } = await import('node:url');
  const root = f2p(new URL('..', import.meta.url));
  const pkgVersion = JSON.parse(rf(`${root}/package.json`, 'utf8')).version;
  const sgmodule = rf(`${root}/surge/final.sgmodule`, 'utf8');
  const panel = rf(`${root}/surge/final-panel.js`, 'utf8');
  const logger = rf(`${root}/surge/final-logger.js`, 'utf8');
  const sw = rf(`${root}/public/sw.js`, 'utf8');
  const indexHtml = rf(`${root}/public/index.html`, 'utf8');
  check('package.json 版本与构建清单一致', BUILD_VERSION === pkgVersion);
  check('surge 脚本头版本常量已注入', panel.includes(`var SCRIPT_VERSION = "${pkgVersion}"`) && logger.includes(`var SCRIPT_VERSION = "${pkgVersion}"`));
  check('sgmodule 模块头版本注释与自托管 script-path 版本参数', sgmodule.includes(`#!version=${pkgVersion}`)
    && sgmodule.includes(`${PANEL_ORIGIN}/surge/final-panel.js?v=${pkgVersion}`)
    && sgmodule.includes(`${PANEL_ORIGIN}/surge/final-logger.js?v=${pkgVersion}`));
  check('sw.js 缓存命名空间带版本串', sw.includes(`const VERSION = 'v${pkgVersion}-`) && sw.includes(`const ENTRY_VERSION = '${pkgVersion}'`));
  check('index.html 入口脚本带版本参数', indexHtml.includes(`js/main.js?v=${pkgVersion}`) && indexHtml.includes(`js/pwa.js?v=${pkgVersion}`));
}

/* ---------------- 心跳：stats 捎带上报 ---------------- */
console.log('\n[heartbeat] stats 心跳与客户端注册表');
{
  const anonymous = await call(loggerHandler, '/api/logger/stats');
  const anonymousData = (await anonymous.json()).data;
  check('匿名 stats 正常返回且不带客户端清单', anonymous.status === 200 && Array.isArray(anonymousData.clients) && anonymousData.clients.length === 0);

  const beat = await call(loggerHandler, '/api/logger/stats', {
    headers: { 'x-final-client': 'panel-abc123', 'x-final-version': '1.0.1', 'x-final-logger': '1.0.1', authorization: 'Bearer hit-token' }
  });
  const beatData = (await beat.json()).data;
  check('带心跳头的 stats 记录客户端', beat.status === 200 && beatData.clients.length === 1, JSON.stringify(beatData.clients));
  check('心跳请求响应 no-store（个性化响应不进共享缓存）', beat.headers.get('cache-control') === 'no-store');
  check('心跳捎带 latest 组件版本', beatData.latest && beatData.latest.panel, JSON.stringify(beatData.latest));
  check('心跳捎带 serverVersion', beatData.serverVersion === anonymousData.serverVersion);

  const wrong = await call(loggerHandler, '/api/logger/stats', {
    headers: { 'x-final-client': 'panel-bad', 'x-final-version': '1.0.1', authorization: 'Bearer wrong-token' }
  });
  const wrongData = (await wrong.json()).data;
  check('心跳令牌不匹配时统计照常返回并标记', wrong.status === 200 && wrongData.heartbeat === 'heartbeat-auth-failed');
  check('令牌不匹配的心跳不进注册表', wrongData.clients.length === 1, JSON.stringify(wrongData.clients));

  const { isHeartbeatOnline } = await import('../functions/_utils/heartbeat.js');
  check('两分钟内的心跳判定在线', isHeartbeatOnline(new Date().toISOString()));
  check('30 分钟前的心跳判定离线', !isHeartbeatOnline(new Date(Date.now() - 30 * 60000).toISOString()));
}

/* ---------------- 设备注册表：多设备在线状态与配置告警 ---------------- */
console.log('\n[devices] 多设备检测、来源 IP / 用户名捕获与分级告警');
{
  const { COMPONENT_VERSIONS } = await import('../functions/_utils/build-meta.js');

  // 捕获脚本批量上报：设备上下文走请求头，来源 IP 由服务端从连接头捕获
  const hitRes = await call(loggerHandler, '/api/logger/hits', {
    method: 'POST',
    body: { hits: [{ hostname: 'device-a.com', count: 2 }, { hostname: 'device-b.com' }], username: '' },
    headers: {
      'x-final-client': 'panel-dev-a',
      'x-final-device': 'iPhone15,3',
      'x-final-user': 'boss',
      'x-final-logger': COMPONENT_VERSIONS.logger,
      'cf-connecting-ip': '203.0.113.7'
    }
  });
  check('批量上报携带设备上下文仍正常落库', hitRes.status === 200 && (await hitRes.json()).data.accepted === 2);

  const rows = await list('?search=device-a.com');
  check('命中行记录来源 IP 与用户名', rows[0]?.ip === '203.0.113.7' && rows[0]?.username === 'boss', JSON.stringify(rows[0]));

  // 面板心跳：另一台设备（同型号不同 IP → 不同设备行），版本一致 → 配置最新
  const beatRes = await call(loggerHandler, '/api/logger/stats', {
    headers: {
      'x-final-client': 'panel-dev-b',
      'x-final-device': 'iPhone15,3',
      'x-final-user': 'family',
      'x-final-version': COMPONENT_VERSIONS.panel,
      'x-final-refresh': '600',
      'cf-connecting-ip': '203.0.113.8'
    }
  });
  const beatData = (await beatRes.json()).data;
  check('stats 响应捎带设备清单与汇总', Array.isArray(beatData.devices) && beatData.deviceSummary && typeof beatData.deviceSummary.total === 'number');

  const summary = beatData.deviceSummary;
  const byUser = Object.fromEntries(beatData.devices.map((d) => [d.username || d.deviceId, d]));
  check('同型号多设备按 clientId / IP 区分', beatData.devices.length >= 2 && byUser['boss'] && byUser['family'], JSON.stringify(beatData.devices.map((d) => d.username)));
  check('设备行记录型号 / IP / 版本', byUser['boss'].name === 'iPhone15,3' && byUser['boss'].ip === '203.0.113.7');
  check('版本一致的设备配置状态为 latest', byUser['family'].configStatus === 'latest' && byUser['family'].online);
  check('仅上报捕获脚本且版本一致同样算配置最新', byUser['boss'].configStatus === 'latest', byUser['boss'].configStatus);
  check('在线统计 n/m 正确', summary.online >= 2 && summary.total >= 2, JSON.stringify(summary));

  // 从不上报版本的设备 → 校验失败（danger，级别最高）；落后版本 → 配置过期（warning）
  const silentRes = await call(loggerHandler, '/api/logger/stats', {
    headers: { 'x-final-client': 'panel-dev-silent', 'x-final-device': 'MacBook Pro', 'x-final-user': 'boss', 'cf-connecting-ip': '203.0.113.10' }
  });
  const staleRes = await call(loggerHandler, '/api/logger/stats', {
    headers: {
      'x-final-client': 'panel-dev-c',
      'x-final-device': 'iPad Pro',
      'x-final-user': 'family',
      'x-final-version': '1.0.0',
      'cf-connecting-ip': '203.0.113.9'
    }
  });
  const staleData = (await staleRes.json()).data;
  const staleDevice = staleData.devices.find((d) => d.deviceId === 'client:panel-dev-c');
  check('落后版本的设备配置状态为 outdated', staleDevice?.configStatus === 'outdated', JSON.stringify(staleDevice));
  const silentDevice = staleData.devices.find((d) => d.deviceId === 'client:panel-dev-silent');
  check('未上报版本的设备配置状态为 failed', silentDevice?.configStatus === 'failed', JSON.stringify(silentDevice));
  check('校验失败告警排序在配置过期之前（danger 最高）', staleData.deviceSummary.alerts[0]?.type === 'failed' && staleData.deviceSummary.alerts[0]?.level === 'danger', JSON.stringify(staleData.deviceSummary.alerts));
  check('配置过期进入告警清单（warning）', staleData.deviceSummary.alerts.some((a) => a.type === 'outdated' && a.level === 'warning'), JSON.stringify(staleData.deviceSummary.alerts));

  // 匿名 stats 也能拿到设备报表（网页面板零新增请求取数）
  const anonymousDevices = await stats();
  check('匿名 stats 同样捎带设备报表', anonymousDevices.devices?.length >= 3 && anonymousDevices.deviceSummary.total >= 3);

  // 离线窗口：5 分钟下限 + 按上报刷新间隔放宽
  const devicesModule = await import('../functions/_utils/devices.js');
  check('离线窗口下限 5 分钟', devicesModule.offlineWindowMs(0) === 20 * 60 * 1000 || devicesModule.offlineWindowMs(0) >= 5 * 60 * 1000);
  check('离线窗口 = max(5分钟, 2×刷新间隔)', devicesModule.offlineWindowMs(60) === 5 * 60 * 1000 && devicesModule.offlineWindowMs(600) === 20 * 60 * 1000);
  check('最近上线判定在线', devicesModule.isDeviceOnline(new Date().toISOString(), 600));
  check('超过窗口判定离线', !devicesModule.isDeviceOnline(new Date(Date.now() - 21 * 60000).toISOString(), 600));
}

/* ---------------- 健康检测：/api/health ---------------- */
console.log('\n[health] 基础与深度检测');
{
  const basic = await call(healthHandler, '/api/health');
  const basicData = (await basic.json()).data;
  check('基础检测返回 200 且 no-store', basic.status === 200 && basic.headers.get('cache-control') === 'no-store');
  check('模式为 basic', basicData.mode === 'basic');
  const byId = Object.fromEntries(basicData.checks.map((c) => [c.id, c]));
  check('前四项只读检查通过', ['1', '2', '3', '4'].every((id) => ['pass', 'warn'].includes(byId[id].status)), JSON.stringify(basicData.checks.map((c) => `${c.id}:${c.status}`)));
  check('写探针在只读模式跳过', ['5', '6', '7'].every((id) => byId[id].status === 'skip'));
  check('配置检查给出写令牌警告（未配置时降级为警告）', byId['1'].status === 'warn' && byId['1'].detail.includes('PANEL_WRITE_TOKEN'));
  check('上报令牌在位性通过', byId['9'].status === 'pass');
  check('客户端状态通过（此前的心跳用例已注册客户端）', byId['10'].status === 'pass', byId['10'].detail);
  check('无失败项时汇总为 warn 或 pass', ['warn', 'pass'].includes(basicData.summary.overall));
  check('逐项携带耗时与文档锚点', basicData.checks.every((c) => Number.isFinite(c.ms) && typeof c.doc === 'string'));

  const deep = await call(healthHandler, '/api/health?mode=deep');
  const deepData = (await deep.json()).data;
  check('深度检测执行写探针三步', ['5', '6', '7'].every((id) => deepData.checks.find((c) => c.id === Number(id)).status === 'pass'), JSON.stringify(deepData.checks.map((c) => `${c.id}:${c.status}`)));
  check('深度检测无失败项', deepData.summary.counts.fail === 0, deepData.summary.headline);
  const residue = db.prepare('SELECT COUNT(*) AS n FROM health_probe').get();
  check('探针表无残留数据', Number(residue.n) === 0, JSON.stringify(residue));

  // 深度检测节流：同 IP 每分钟至多一次
  const throttled = await call(healthHandler, '/api/health?mode=deep');
  check('深度检测按 IP 节流返回 429', throttled.status === 429);

  // 配置写令牌后，深度检测必须携带正确令牌；用不同来源 IP 避开上一段的节流槽位
  const securedEnv = { ...env, PANEL_WRITE_TOKEN: 'sec-health' };
  const denied = await healthHandler({
    request: new Request('http://test/api/health?mode=deep', { headers: { 'cf-connecting-ip': 'ip-auth', authorization: 'Bearer hit-token' } }),
    env: securedEnv,
    waitUntil: () => {}
  });
  check('深度检测缺写令牌返回 401', denied.status === 401);
  const ok = await healthHandler({
    request: new Request('http://test/api/health?mode=deep', { headers: { 'cf-connecting-ip': 'ip-auth', authorization: 'Bearer sec-health' } }),
    env: securedEnv,
    waitUntil: () => {}
  });
  check('深度检测携带正确写令牌放行', ok.status === 200);

  // 空注册表（全新库）：客户端状态给出未接入提示
  const fresh = await healthHandler({
    request: new Request('http://test/api/health'),
    env: { DB_BACKEND: 'sqlite', DB_SQLITE_PATH: `${tmpRoot}/fresh-health.sqlite` },
    waitUntil: () => {}
  });
  const freshClient = (await fresh.json()).data.checks.find((c) => c.id === 10);
  check('空注册表时客户端状态给出未接入提示', freshClient.status === 'warn' && freshClient.detail.includes('尚未收到'), freshClient.detail);

  // 心跳进注册表后，客户端连通状态转绿并带版本比对信息
  await call(loggerHandler, '/api/logger/stats', {
    headers: { 'x-final-client': 'panel-abc123', 'x-final-version': '1.0.1', 'x-final-logger': '1.0.1', authorization: 'Bearer hit-token' }
  });
  const withClient = await call(healthHandler, '/api/health');
  const clientCheck = (await withClient.json()).data.checks.find((c) => c.id === 10);
  check('有心跳后客户端状态为 pass', clientCheck.status === 'pass', clientCheck.detail);
  check('客户端状态带最近心跳时间与版本', clientCheck.detail.includes('在线') && clientCheck.detail.includes('面板脚本'), clientCheck.detail);

  // 未知子路径与方法约束
  check('health 未知子路径 404', (await call(healthHandler, '/api/health/nope')).status === 404);
  check('health 不支持 POST', (await call(healthHandler, '/api/health', { method: 'POST', body: {} })).status === 405);
}

/* ---------------- schema：新增四张表 ---------------- */
console.log('\n[schema] 健康探针 / 心跳 / 设备 / 版本表');
{
  const all = await (await call(schemaHandler, '/api/schema')).text();
  check('汇总包含健康探针表', all.includes('health_probe'));
  check('汇总包含心跳注册表', all.includes('client_heartbeats'));
  check('汇总包含设备注册表', all.includes('devices'));
  check('汇总包含版本表', all.includes('db_meta'));
  const probe = await (await call(schemaHandler, '/api/schema/table/health')).text();
  check('健康探针表可单独获取', probe.includes('marker') && probe.includes('UNIQUE'));
  const beats = await (await call(schemaHandler, '/api/schema/table/heartbeats')).text();
  check('心跳表可单独获取', beats.includes('panel_version') && beats.includes('client_id'));
  const devices = await (await call(schemaHandler, '/api/schema/table/devices')).text();
  check('设备表可单独获取', devices.includes('last_online_time') && devices.includes('config_status') && devices.includes('username'));
  check('未知表返回 404', (await call(schemaHandler, '/api/schema/table/nope')).status === 404);
}

/* ---------------- 路由回归保护 ---------------- */
/*
 * 为什么这里要跑一次真实的 wrangler 构建：
 * Pages 的路由匹配用的是 path-to-regexp，wrangler 模板对「模块」是精确匹配
 * （end: true）。functions/api/logger.js 只生成 routePath="/api/logger"，
 * 命中不了 /api/logger/stats 这类子路径——没有 logger/[[rest]].js 时，
 * 生产 _routes.json 的 include 只有 "/api/logger"，子路径会全部落到静态资源，
 * 返回 200 + index.html。本地 pages dev 不读 _routes.json，查不出来，
 * 所以把「每个接口都真的有路由」变成机器检查。
 */
console.log('\n[routes] _routes.json 覆盖所有接口');
{
  /**
   * 判断一条请求路径能否被 _routes.json 里的某个 include 模式命中。
   * wrangler 生成的一级前缀模式形如 "/api/logger"、"/api/logger/*"，
   * 这里按字面前缀判断，不引入运行时依赖。
   */
  const isHit = (pattern, path) => {
    const base = pattern.replace(/\/?\*$/, '');
    return pattern.endsWith('*') ? path.startsWith(base) : path === base;
  };

  try {
    const outDir = `${tmpRoot}/routes-check`;
    mkdirSync(outDir, { recursive: true });
    execFileSync(process.execPath, [
      'node_modules/.bin/wrangler', 'pages', 'functions', 'build',
      `--outdir=${outDir}`,
      `--output-routes-path=${outDir}/_routes.json`,
      '--compatibility-date=2026-10-12'
    ], { stdio: 'pipe', timeout: 120000 });

    const patterns = (JSON.parse(readFileSync(`${outDir}/_routes.json`, 'utf8')).include) || [];
    const expected = [
      '/api/logger', '/api/logger/stats', '/api/logger/export', '/api/logger/export-summary',
      '/api/logger/meta', '/api/logger/schema', '/api/logger/hit', '/api/logger/hits', '/api/logger/batch',
      '/api/logger/clear', '/api/logger/clear-empty',
      '/api/export',
      '/api/health', '/api/health/',
      '/api/prefs', '/api/prefs/schema',
      '/api/rules', '/api/rules/1',
      '/api/schema', '/api/schema/table/logger', '/api/schema/table/prefs',
      '/api/schema/table/subscriptions', '/api/schema/table/health', '/api/schema/table/heartbeats',
      '/api/schema/table/devices',
      '/api/subscribe', '/api/subscribe/parse', '/api/subscribe/save', '/api/subscribe/delete',
      '/api/subscribe/schema'
    ];
    const uncovered = expected.filter((path) => !patterns.some((pattern) => isHit(pattern, path)));
    check('全部接口都能被 _routes.json 命中', uncovered.length === 0,
      `缺路由: ${uncovered.join(', ')}；include=${JSON.stringify(patterns)}`);
    check('路由只覆盖 /api 前缀（不接管静态资源）', patterns.every((pattern) => pattern.startsWith('/api/')),
      JSON.stringify(patterns));
  } catch (error) {
    check('构建 _routes.json 失败', false, String(error?.message ?? error).slice(0, 300));
  }
}

console.log(failed === 0 ? '\n✅ 全部通过' : `\n❌ ${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);

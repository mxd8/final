/**
 * 适配器契约测试：同一组断言跑全部后端（turso mock、D1 本地模拟、node:sqlite 真实库）。
 *
 * 这是新后端的准入门槛（docs/feature-requirements.md 优化建议 3）：任何新适配器
 * （Upstash、Supabase 等）通过全部契约断言才算接入。约束特定后端的错误文案与
 * 结果形状绝不上抛到业务层——业务层只见 { rows, changes } 与 DbError。
 *
 *   - Turso：本地 https mock 复刻真实 HTTP 管道（rows_written 形状、语句槽位错误、
 *     整体回滚），覆盖 HTTP 客户端语义；
 *   - D1：用 node:sqlite 模拟绑定 API（prepare / bind / batch 原子事务），
 *     覆盖结果归一（meta.changes → changes）；
 *   - SQLite：真实 node:sqlite 文件库；
 *   - factory：DB_BACKEND 校验、缓存签名、失败逐出。
 */
import { createServer } from 'node:https';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const tmpRoot = mkdtempSync(`${tmpdir()}/db-adapter-test-`);
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
process.env.NO_PROXY = '127.0.0.1,localhost';
process.on('exit', () => rmSync(tmpRoot, { recursive: true, force: true }));

let failed = 0;
function check(name, condition, extra = '') {
  if (condition) console.log(`  ok  ${name}`);
  else { console.log(`  FAIL ${name} ${extra}`); failed += 1; }
}

/* ================================================================
 * Turso：本地 https mock，复刻真实 HTTP 管道契约
 * ================================================================ */
function makeCert() {
  const key = `${tmpRoot}/key.pem`;
  const cert = `${tmpRoot}/cert.pem`;
  try {
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
      '-keyout', key, '-out', cert, '-subj', '/CN=localhost'
    ], { stdio: 'ignore' });
    return { key: readFileSync(key), cert: readFileSync(cert) };
  } catch (error) {
    console.error('生成测试证书失败（需要系统安装 openssl）:', error.message);
    process.exit(2);
  }
}

/** 与真实 Turso 一致：写语句受影响行数放在 results.rows_written，顶层没有 changes */
function toTursoResult(sql, params) {
  const clean = sql.replace(/\s+/g, ' ').trim();
  const stmt = tursoDb.prepare(clean);
  const cols = stmt.columns().map((col) => col.name);
  if (/^(select|pragma)/i.test(clean)) {
    const objects = stmt.all(...(params || []));
    return { results: { columns: cols, rows: objects.map((o) => cols.map((c) => o[c])) } };
  }
  const r = stmt.run(...(params || []));
  const written = Number(r.changes);
  return { results: { columns: [], rows: [], rows_written: written, affected_row_count: written } };
}

/** 一个批量 = 一个事务：任何一条失败整体回滚（契约核心） */
function runStatements(statements) {
  tursoDb.exec('BEGIN IMMEDIATE');
  try {
    const out = statements.map((statement) => toTursoResult(statement.q, statement.params));
    tursoDb.exec('COMMIT');
    return out;
  } catch (error) {
    tursoDb.exec('ROLLBACK');
    throw error;
  }
}

const tursoDb = new DatabaseSync(':memory:');
tursoDb.exec(`CREATE TABLE t (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL)`);

const { key, cert } = makeCert();
const server = createServer({ key, cert }, (req, res) => {
  let body = '';
  req.on('data', (chunk) => (body += chunk));
  req.on('end', () => {
    if (req.headers.authorization !== 'Bearer tk-test') {
      res.writeHead(401);
      return res.end(JSON.stringify({ error: 'unauthorized' }));
    }
    try {
      const { statements } = JSON.parse(body);
      const out = runStatements(statements);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(out));
    } catch (error) {
      // 语句失败（已回滚）：按管道约定把错误放进对应语句槽位
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify([{ error: error.message }]));
    }
  });
});
await new Promise((resolve) => server.listen(0, resolve));

console.log('\n[turso-adapter] 契约（本地 https mock）');
{
  const { TursoAdapter } = await import('../functions/_utils/db/turso-adapter.js');
  const { ConfigError, DbError } = await import('../functions/_utils/db/contract.js');
  const adapter = new TursoAdapter();
  adapter.init({ TURSO_API_URL: `https://127.0.0.1:${server.address().port}`, TURSO_AUTH_TOKEN: 'tk-test' });

  check('execute 返回对象数组', JSON.stringify(await adapter.execute('SELECT 1 AS one')) === '[{"one":1}]');
  await adapter.execute('INSERT INTO t (name) VALUES (?)', ['a']);
  await adapter.execute('INSERT INTO t (name) VALUES (?)', ['b']);
  const results = await adapter.batch([
    { sql: 'UPDATE t SET name = ? WHERE name = ?', params: ['a2', 'a'] },
    { sql: 'DELETE FROM t WHERE name = ?', params: ['b'] },
    { sql: 'SELECT COUNT(*) AS n FROM t' }
  ]);
  check('batch 归一 changes（rows_written 形状）', results[0].changes === 1 && results[1].changes === 1, JSON.stringify(results));
  check('batch 归一 rows（对象数组）', results[2].rows.length === 1 && results[2].rows[0].n === 1, JSON.stringify(results[2].rows));

  let threw = false;
  try {
    await adapter.batch([
      { sql: 'INSERT INTO t (name) VALUES (?)', params: ['rollback'] },
      { sql: 'INSERT INTO missing_table (x) VALUES (1)' }
    ]);
  } catch (error) {
    threw = error instanceof DbError;
  }
  check('语句失败抛 DbError', threw);
  check('回滚后批次内语句不落地', tursoDb.prepare(`SELECT COUNT(*) AS n FROM t WHERE name = 'rollback'`).get().n === 0);

  await adapter.ping();
  check('ping 通过', true);

  const bad = new TursoAdapter();
  let configError = false;
  try {
    bad.init({});
  } catch (error) {
    configError = error instanceof ConfigError && error.message.includes('TURSO_API_URL');
  }
  check('缺配置抛 ConfigError（路由 400 语义）', configError);

  const down = new TursoAdapter();
  down.init({ TURSO_API_URL: 'https://127.0.0.1:9/', TURSO_AUTH_TOKEN: 'tk' });
  let kind = '';
  try {
    await down.ping();
  } catch (error) {
    kind = error.kind;
  }
  check('不可达归类为连接类', kind === 'connection', kind);

  check('describe 只暴露主机名（脱敏）', !adapter.describe().includes('tk-test') && adapter.describe().includes('127.0.0.1'), adapter.describe());
}
server.close();

/* ================================================================
 * D1：node:sqlite 模拟绑定 API（prepare / bind / batch 原子事务）
 * ================================================================ */
console.log('\n[d1-adapter] 契约（本地模拟绑定）');
{
  const { D1Adapter } = await import('../functions/_utils/db/d1-adapter.js');
  const { ConfigError, DbError } = await import('../functions/_utils/db/contract.js');
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`CREATE TABLE t (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL)`);

  /** 最小 D1Database 仿真：batch 顺序执行、一个事务、结果 meta.changes */
  const binding = {
    prepare(sql) {
      return {
        bind(...params) { this.params = params; return this; },
        async all() {
          const clean = sql.replace(/\s+/g, ' ').trim();
          const stmt = sqlite.prepare(clean);
          if (/^(select|pragma)/i.test(clean)) return { results: stmt.all(...(this.params || [])) };
          const info = stmt.run(...(this.params || []));
          return { results: [], meta: { changes: Number(info.changes) } };
        }
      };
    },
    async batch(statements) {
      sqlite.exec('BEGIN IMMEDIATE');
      try {
        const out = [];
        for (const statement of statements) out.push(await statement.all());
        sqlite.exec('COMMIT');
        return out;
      } catch (error) {
        sqlite.exec('ROLLBACK');
        throw error;
      }
    }
  };

  const adapter = new D1Adapter();
  adapter.init({ DB_D1: binding });
  check('execute 返回对象数组', JSON.stringify(await adapter.execute('SELECT 1 AS one')) === '[{"one":1}]');
  await adapter.execute('INSERT INTO t (name) VALUES (?)', ['a']);
  const results = await adapter.batch([
    { sql: 'UPDATE t SET name = ? WHERE name = ?', params: ['a2', 'a'] },
    { sql: 'SELECT name FROM t WHERE name = ?', params: ['a2'] }
  ]);
  check('batch 归一 meta.changes → changes', results[0].changes === 1, JSON.stringify(results));
  check('batch 归一 results → rows', results[1].rows.length === 1 && results[1].rows[0].name === 'a2');

  let threw = false;
  try {
    await adapter.batch([
      { sql: 'INSERT INTO t (name) VALUES (?)', params: ['rollback'] },
      { sql: 'INSERT INTO missing_table (x) VALUES (1)' }
    ]);
  } catch (error) {
    threw = error instanceof DbError;
  }
  check('语句失败抛 DbError 且整体回滚', threw && sqlite.prepare(`SELECT COUNT(*) AS n FROM t WHERE name = 'rollback'`).get().n === 0);

  const noBinding = new D1Adapter();
  let configError = false;
  try {
    noBinding.init({});
  } catch (error) {
    configError = error instanceof ConfigError && error.message.includes('DB_D1');
  }
  check('缺绑定抛 ConfigError', configError);

  await adapter.ping();
  check('ping 通过', true);
}

/* ================================================================
 * SQLite：真实 node:sqlite
 * ================================================================ */
console.log('\n[sqlite-adapter] 契约（真实库）');
{
  const { SqliteAdapter } = await import('../functions/_utils/db/sqlite-adapter.js');
  const { ConfigError, DbError } = await import('../functions/_utils/db/contract.js');
  const dbPath = `${tmpRoot}/contract.sqlite`;
  const adapter = new SqliteAdapter();
  await adapter.init({ DB_SQLITE_PATH: dbPath });

  check('execute 返回对象数组', JSON.stringify(await adapter.execute('SELECT 1 AS one')) === '[{"one":1}]');
  await adapter.execute('CREATE TABLE t (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL)');
  await adapter.execute('INSERT INTO t (name) VALUES (?)', ['a']);
  const results = await adapter.batch([
    { sql: 'UPDATE t SET name = ? WHERE name = ?', params: ['a2', 'a'] },
    { sql: 'SELECT name FROM t' }
  ]);
  check('batch 归一 changes', results[0].changes === 1, JSON.stringify(results));
  check('batch 归一 rows', results[1].rows.length === 1 && results[1].rows[0].name === 'a2');

  let threw = false;
  try {
    await adapter.batch([
      { sql: 'INSERT INTO t (name) VALUES (?)', params: ['rollback'] },
      { sql: 'INSERT INTO missing_table (x) VALUES (1)' }
    ]);
  } catch (error) {
    threw = error instanceof DbError;
  }
  check('语句失败抛 DbError 且整体回滚', threw
    && adapter.db.prepare(`SELECT COUNT(*) AS n FROM t WHERE name = 'rollback'`).get().n === 0);

  await adapter.ping();
  check('ping 通过', true);
  check('describe 不含路径细节', adapter.describe().includes('sqlite'));

  const noPath = new SqliteAdapter();
  let configError = false;
  try {
    await noPath.init({});
  } catch (error) {
    configError = error instanceof ConfigError && error.message.includes('DB_SQLITE_PATH');
  }
  check('缺路径抛 ConfigError', configError);
}

/* ================================================================
 * ensureSchema：全新库 / 历史库 / 版本推进
 * ================================================================ */
console.log('\n[ensureSchema] 版本表迁移机制');
{
  const { ensureSchema, DB_SCHEMA_VERSION } = await import('../functions/_utils/db/ddl.js');
  const { SqliteAdapter } = await import('../functions/_utils/db/sqlite-adapter.js');

  // 全新库：BASE_DDL 一次到位 + 版本号写入
  const fresh = new SqliteAdapter();
  await fresh.init({ DB_SQLITE_PATH: `${tmpRoot}/schema-fresh.sqlite` });
  await ensureSchema(fresh);
  const version = fresh.db.prepare(`SELECT value FROM db_meta WHERE key = 'schema_version'`).get();
  check('全新库写入当前版本号', Number(version.value) === DB_SCHEMA_VERSION, JSON.stringify(version));
  check('全新库包含业务表与健康设施', fresh.db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all()
    .map((row) => row.name)
    .toString()
    .includes('surge_logs'));
  const tables = fresh.db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all().map((row) => row.name);
  check('全新库包含健康探针 / 心跳 / 版本表', ['health_probe', 'client_heartbeats', 'db_meta'].every((t) => tables.includes(t)));
  await ensureSchema(fresh);
  check('重复执行幂等（_schemaReady 短路）', true);

  // 历史库：有 surge_logs 无版本表 → 补列 + 补新表 + 写版本号
  const legacyPath = `${tmpRoot}/schema-legacy.sqlite`;
  const legacyRaw = new DatabaseSync(legacyPath);
  legacyRaw.exec(`CREATE TABLE surge_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT, hostname TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'DOMAIN-SUFFIX', value TEXT NOT NULL DEFAULT '',
    policy TEXT NOT NULL DEFAULT 'PROXY', params TEXT NOT NULL DEFAULT '',
    comment TEXT NOT NULL DEFAULT '', source TEXT NOT NULL DEFAULT '',
    time TEXT NOT NULL, count INTEGER NOT NULL DEFAULT 1
  )`);
  legacyRaw.exec(`INSERT INTO surge_logs (hostname, time) VALUES ('old.com', '2020-01-01T00:00:00.000Z')`);
  legacyRaw.close();
  const legacy = new SqliteAdapter();
  await legacy.init({ DB_SQLITE_PATH: legacyPath });
  await ensureSchema(legacy);
  check('历史库补齐 first_time 列', legacy.db.prepare(`SELECT first_time FROM surge_logs LIMIT 1`) !== null);
  const legacyTables = legacy.db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all().map((row) => row.name);
  check('历史库补建新表', ['health_probe', 'client_heartbeats', 'db_meta'].every((t) => legacyTables.includes(t)));
  const legacyVersion = legacy.db.prepare(`SELECT value FROM db_meta WHERE key = 'schema_version'`).get();
  check('历史库写入当前版本号', Number(legacyVersion.value) === DB_SCHEMA_VERSION);

  // 未来库：版本号比代码新 → 放行不降级
  const futurePath = `${tmpRoot}/schema-future.sqlite`;
  const futureRaw = new DatabaseSync(futurePath);
  futureRaw.exec(`CREATE TABLE db_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  futureRaw.exec(`INSERT INTO db_meta VALUES ('schema_version', '99')`);
  futureRaw.close();
  const future = new SqliteAdapter();
  await future.init({ DB_SQLITE_PATH: futurePath });
  let warned = false;
  const originalWarn = console.warn;
  console.warn = () => { warned = true; };
  try {
    await ensureSchema(future);
  } finally {
    console.warn = originalWarn;
  }
  check('数据库比代码新时放行并告警', warned && future.db.prepare(`SELECT value FROM db_meta WHERE key='schema_version'`).get().value === '99');
}

/* ================================================================
 * factory：DB_BACKEND 校验、缓存签名、失败逐出
 * ================================================================ */
console.log('\n[factory] 适配器工厂');
{
  const { resolveDbBackend, getAdapter } = await import('../functions/_utils/db/factory.js');
  const { ConfigError } = await import('../functions/_utils/db/contract.js');

  check('未配置默认 turso', resolveDbBackend({}) === 'turso');
  check('大小写归一', resolveDbBackend({ DB_BACKEND: ' SQLITE ' }) === 'sqlite');
  let invalid = false;
  try {
    resolveDbBackend({ DB_BACKEND: 'oracle' });
  } catch (error) {
    invalid = error instanceof ConfigError && error.message.includes('oracle');
  }
  check('非法后端抛 ConfigError 并列出合法值', invalid);

  const path = `${tmpRoot}/factory-cache.sqlite`;
  const envA = { DB_BACKEND: 'sqlite', DB_SQLITE_PATH: path };
  const envB = { ...envA };
  const a = await getAdapter(envA);
  const b = await getAdapter(envB);
  check('同配置签名共享实例（env 变体不重复建库）', a === b);

  // 失败逐出：坏配置抛错后，修正配置立即可用（不必等 isolate 重启）
  const broken = { DB_BACKEND: 'sqlite' };
  let threw = false;
  try {
    await getAdapter(broken);
  } catch (error) {
    threw = error instanceof ConfigError;
  }
  check('缺路径抛 ConfigError', threw);
  const fixed = await getAdapter({ DB_BACKEND: 'sqlite', DB_SQLITE_PATH: `${tmpRoot}/factory-fixed.sqlite` });
  check('失败实例被逐出缓存，修正后立即可用', !!fixed.db);
}

console.log(failed === 0 ? '\n✅ db-adapters: 全部通过' : `\n❌ db-adapters: ${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);

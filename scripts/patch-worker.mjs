/**
 * 构建后处理：移除 dist/_worker.js 里 unenv polyfill 类的 keepNames static 块。
 *
 * 背景：`wrangler pages functions build`（4.x）给 polyfill 类生成
 *   static { __name(this, "X"); }
 * 而 Cloudflare Pages Git 构建的上传阶段用旧版 wrangler 重新编译 _worker.js，
 * 对该模式二次转换后在 workerd 启动时崩溃：
 *   Uncaught TypeError: Object.defineProperty called on non-object at __name in <static_initializer>
 * 类名只影响堆栈可读性（unenv 逻辑依赖 prototype 属性名而非类名），删除无功能影响。
 * 本地 wrangler 4.x 的 workerd 跑同一 bundle 正常，问题仅在旧版重编译路径。
 */
import { readFileSync, writeFileSync } from 'node:fs';

const WORKER_FILE = new URL('../dist/_worker.js', import.meta.url);
const PATTERN = /static \{\s*__name\(this, "[^"]*"\);\s*\}/g;

const source = readFileSync(WORKER_FILE, 'utf8');
const matches = source.match(PATTERN) ?? [];

if (matches.length === 0) {
  console.log('patch-worker: 未发现 static 初始化块（wrangler 产物格式可能已变化），跳过');
  process.exit(0);
}

writeFileSync(WORKER_FILE, source.replace(PATTERN, ''));
console.log(`patch-worker: 已移除 ${matches.length} 个 static 初始化块`);

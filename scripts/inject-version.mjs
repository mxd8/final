/**
 * 版本注入：把「构建清单」这一唯一事实来源落到全部运行产物。
 *
 * 事实来源：package.json 的 version（语义化版本）+ git 短哈希 + 构建时间，
 * 展示形式 X.Y.Z（短哈希）。注入面（与 docs/feature-requirements.md 1.1.2 一致）：
 *
 *   functions/_utils/build-meta.js   后端版本常量 → /api/logger/meta 的 version 字段
 *   public/js/version.js             前端版本常量 → 版本看板、页面横幅
 *   surge/final-panel.js             文件头 SCRIPT_VERSION（上报心跳捎带）
 *   surge/final-logger.js            文件头 SCRIPT_VERSION（上报响应比对 + final_logger_meta）
 *   surge/final.sgmodule             模块头版本注释 + script-path 查询参数（发版即失效）
 *   public/sw.js                     缓存命名空间版本串（activate 时整体清旧缓存）
 *   public/index.html                入口脚本 ?v= 参数（整张模块图随入口一起失效）
 *
 * 幂等：内容无变化不写盘，重复构建不产生噪音 diff。
 * 注入时机：npm run build 第一步 + 发布流程在提交前手动执行一次。
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const pkg = JSON.parse(readFileSync(`${root}/package.json`, 'utf8'));
const version = pkg.version;

let hash = 'nogit';
try {
  hash = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
} catch {
  console.warn('inject-version: 无法读取 git 短哈希（非 git 环境），使用 nogit');
}
const buildTime = new Date().toISOString();

/** Surge 三件套的自托管源：Pages 部署域名（绕开 GitHub raw 的边缘缓存与可达性问题） */
const PANEL_ORIGIN = (process.env.FINAL_PANEL_ORIGIN || 'https://final-axx.pages.dev').replace(/\/+$/, '');

const changes = [];
function safeRead(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null; // 首次生成：目标文件尚不存在
  }
}

/**
 * 同版本已注入则跳过（幂等的关键）：git 短哈希随每次提交变化，若按内容差异
 * 重写，发布流程里「提交 → 构建 → 注入」会互相追着改哈希。语义定为
 * 「哈希 = 该版本首次打戳时的 HEAD」，同一版本重复构建零 diff，发新版才重写。
 */
function alreadyStamped(before, version) {
  if (before == null) return false;
  const patterns = [
    `BUILD_VERSION = '${version}'`,
    `PANEL_VERSION = '${version}'`,
    `var SCRIPT_VERSION = "${version}"`,
    `#!version=${version}`,
    `const VERSION = 'v${version}-`,
    `?v=${version}`
  ];
  return patterns.some((pattern) => before.includes(pattern));
}

/** 同版本但自托管源变了（换域名部署）时 sgmodule 必须重打 */
function sgmoduleNeedsRestamp(before) {
  return before != null && !before.includes(`script-path=${PANEL_ORIGIN}/surge/`);
}

function stamp(file, transform, label, version = null, force = null) {
  const path = resolve(root, file);
  const before = safeRead(path);
  if (version && alreadyStamped(before, version) && !(force && force(before))) return;
  const after = transform(before ?? '');
  if (after !== before) {
    writeFileSync(path, after);
    changes.push(`${file}（${label}）`);
  }
}

// 1. 后端构建清单（/api/logger/meta 的 version 字段与 latest 捎带字段的来源）
const buildMeta = `/**
 * 构建清单（由 scripts/inject-version.mjs 生成 —— 请勿手改）。
 * /api/logger/meta 的 version 字段与各响应的 latest 捎带字段都从这里取值：
 * 版本比对的唯一基准是服务端部署版本，字段只增不删（向后兼容根基）。
 */
export const BUILD_VERSION = '${version}';
export const BUILD_HASH = '${hash}';
export const BUILD_LABEL = '${version} (${hash})';
export const BUILD_TIME = '${buildTime}';
/** 各分发组件的最新版本（同一构建清单，整体发布） */
export const COMPONENT_VERSIONS = { panel: '${version}', logger: '${version}', sgmodule: '${version}' };
/** Surge 三件套自托管源（发版时 script-path 查询参数随之更新） */
export const PANEL_ORIGIN = '${PANEL_ORIGIN}';
`;

// 2. 前端版本常量（设置页版本看板、页面横幅、Sw 更新联动）
const frontendVersion = `/**
 * 面板版本常量（由 scripts/inject-version.mjs 生成 —— 请勿手改）。
 * 启动时与 /api/logger/meta 返回的 serverVersion 比对，驱动版本看板与更新横幅。
 */
export const PANEL_VERSION = '${version}';
export const PANEL_BUILD = '${version} (${hash})';
export const PANEL_BUILD_TIME = '${buildTime}';
`;

// 3. Surge 脚本文件头版本常量（独立注释行 + 固定锚点，幂等可重复注入）
const stampSurgeScript = (source) => {
  const line = `var SCRIPT_VERSION = "${version}";`;
  if (/var SCRIPT_VERSION = "[^"]*";/.test(source)) {
    return source.replace(/var SCRIPT_VERSION = "[^"]*";/, line);
  }
  const block = `/** 脚本版本：随仓库发版注入（scripts/inject-version.mjs），上报与版本比对以此为准 */\n${line}\n`;
  return source.replace(/var CONFIG_KEY = "final_db_config";/, `${block}var CONFIG_KEY = "final_db_config";`);
};

// 4. sgmodule：模块头版本注释 + script-path 查询参数
const stampSgmodule = (source) => {
  let out = source;
  // script-path 切到自托管源并追加版本参数（?v= 变更即发版失效）
  out = out.replace(
    /script-path=https:\/\/[^\s,"]+\/surge\/(final-panel|final-logger)\.js(\?v=[\w.]+)?/g,
    (_m, name) => `script-path=${PANEL_ORIGIN}/surge/${name}.js?v=${version}`
  );
  // 模块头版本注释（不存在则插在 #!desc 之后）
  const versionLine = `#!version=${version} (${hash})`;
  if (/^#!version=.*$/m.test(out)) {
    out = out.replace(/^#!version=.*$/m, versionLine);
  } else {
    out = out.replace(/(^#!desc=.*$)/m, `$1\n${versionLine}`);
  }
  return out;
};

// 5. sw.js：缓存命名空间带版本串 + 入口脚本预缓存参数与 index.html 一致
const stampSw = (source) => {
  let out = source
    .replace(/const VERSION = '[^']*';/, `const VERSION = 'v${version}-${hash}';`)
    .replace(/const ENTRY_VERSION = '[^']*';/, `const ENTRY_VERSION = '${version}';`);
  return out;
};

// 6. index.html：入口脚本引用附带版本参数
const stampIndex = (source) => source
  .replace(/js\/main\.js\?v=[\w.]+/g, `js/main.js?v=${version}`)
  .replace(/js\/pwa\.js\?v=[\w.]+/g, `js/pwa.js?v=${version}`);

stamp('functions/_utils/build-meta.js', () => buildMeta, '构建清单', version);
stamp('public/js/version.js', () => frontendVersion, '前端版本常量', version);
stamp('surge/final-panel.js', stampSurgeScript, '面板脚本版本', version);
stamp('surge/final-logger.js', stampSurgeScript, '捕获脚本版本', version);
stamp('surge/final.sgmodule', stampSgmodule, '模块版本与自托管地址', version, sgmoduleNeedsRestamp);
stamp('public/sw.js', stampSw, 'SW 缓存版本', version);
stamp('public/index.html', stampIndex, '入口脚本版本参数', version);

if (changes.length) {
  console.log(`inject-version: 已更新 ${changes.join('、')}`);
} else {
  console.log('inject-version: 版本戳无变化，跳过写入');
}

/**
 * Cloudflare Pages Functions 的环境变量类型声明。
 *
 * 本项目源码是 JavaScript（不是 TS），所以这个文件不参与构建、不进 bundle，
 * 只给编辑器与 `npm run typecheck` 用：把 env 的可选结构固定下来，
 * 以后新增环境变量时 IDE 会立刻提示这里没声明，避免拼错名字而静默失效。
 *
 * 声明的变量必须与以下两处保持一致：
 *   1. .dev.vars.example（本地调试模板）
 *   2. Cloudflare 控制台 → Pages → Environment Variables and Secrets
 */

export type { Env };

/** Turso 连接所需的变量清单，与 turso.js 的 REQUIRED_VARS 一致 */
export interface Env {
  /** Turso 数据库地址，必须 https://（libsql:// 是客户端协议，Workers 无法解析） */
  readonly TURSO_API_URL: string;

  /** Turso 访问令牌 */
  readonly TURSO_AUTH_TOKEN: string;

  /**
   * 以下字段由 Pages 运行时自动注入，代码不依赖它们，
   * 声明出来是为了避免编辑器把它们当成未声明属性。
   */
  readonly CF_PAGES?: '1' | undefined;
  readonly CF_PAGES_BRANCH?: string;
  readonly CF_PAGES_COMMIT_SHA?: string;
  readonly CF_PAGES_URL?: string;
  readonly CF_PAGES_PROJECT_ID?: string;

  /** 允许其他未声明变量，便于灰度新增配置 */
  readonly [key: string]: string | undefined;
}

/**
 * 构建清单（由 scripts/inject-version.mjs 生成 —— 请勿手改）。
 * /api/logger/meta 的 version 字段与各响应的 latest 捎带字段都从这里取值：
 * 版本比对的唯一基准是服务端部署版本，字段只增不删（向后兼容根基）。
 */
export const BUILD_VERSION = '1.3.0';
export const BUILD_HASH = '1fdc95b';
export const BUILD_LABEL = '1.3.0 (1fdc95b)';
export const BUILD_TIME = '2026-10-17T21:49:53.223Z';
/** 各分发组件的最新版本（同一构建清单，整体发布） */
export const COMPONENT_VERSIONS = { panel: '1.3.0', logger: '1.3.0', sgmodule: '1.3.0' };
/** Surge 三件套自托管源（发版时 script-path 查询参数随之更新） */
export const PANEL_ORIGIN = 'https://final-axx.pages.dev';

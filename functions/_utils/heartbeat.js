/**
 * 客户端心跳：Surge 面板脚本每次刷新捎带的存活信号（零新增请求、零新增配置）。
 *
 * 面板脚本（final-panel.js）在既有 /stats 请求上附带心跳头：
 *   Authorization      上报令牌（与面板数据请求同一鉴权面，PANEL_HIT_TOKEN）
 *   x-final-client     客户端标识（首次生成随机标识并持久化于 final_db_config）
 *   x-final-version    面板脚本自身版本（文件头 SCRIPT_VERSION）
 *   x-final-logger     捕获脚本本地副本自报的版本（读自 final_logger_meta，可为空）
 *
 * 服务端 upsert 进 client_heartbeats 注册表；网页端健康检测与版本看板据此展示
 * 「最近在线时间 / 客户端版本 / 版本比对结果」。离线判定：两个刷新周期（默认
 * 刷新间隔 600 秒）内无心跳即视为离线，约 20 分钟。
 */

import { HEARTBEATS_TABLE } from './db/ddl.js';

export const HEARTBEAT_OFFLINE_MS = 20 * 60 * 1000;

const MAX_VERSION_LENGTH = 32;
const MAX_CLIENT_ID_LENGTH = 64;

/** 心跳头 → 记录对象；缺客户端标识视为非心跳请求，返回 null */
export function parseHeartbeatHeaders(request) {
  const clientId = String(request.headers.get('x-final-client') ?? '').trim();
  if (!clientId) return null;
  const clean = (value) => String(value ?? '').trim().slice(0, MAX_VERSION_LENGTH);
  return {
    clientId: clientId.slice(0, MAX_CLIENT_ID_LENGTH),
    panelVersion: clean(request.headers.get('x-final-version')),
    loggerVersion: clean(request.headers.get('x-final-logger'))
  };
}

/** 心跳落库：upsert 客户端最近一次存活（失败由调用方吞掉，绝不能拖垮 stats） */
export async function recordHeartbeat(db, { clientId, panelVersion = '', loggerVersion = '' }) {
  const now = new Date().toISOString();
  await db.batch([
    {
      sql: `INSERT INTO ${HEARTBEATS_TABLE} (client_id, panel_version, logger_version, last_seen, updated_at)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(client_id) DO UPDATE SET
              panel_version = excluded.panel_version,
              logger_version = excluded.logger_version,
              last_seen = excluded.last_seen,
              updated_at = excluded.updated_at`,
      params: [clientId, panelVersion, loggerVersion, now, now]
    }
  ]);
}

/** 最近心跳列表（新的在前）：供健康检测与版本看板共用 */
export async function listHeartbeats(db, { limit = 5 } = {}) {
  const rows = await db.execute(
    `SELECT client_id, panel_version, logger_version, last_seen, updated_at
     FROM ${HEARTBEATS_TABLE} ORDER BY updated_at DESC LIMIT ?`,
    [Math.max(1, Math.min(Number(limit) || 5, 50))]
  );
  return rows.map((row) => ({
    clientId: String(row.client_id ?? ''),
    panelVersion: String(row.panel_version ?? ''),
    loggerVersion: String(row.logger_version ?? ''),
    lastSeen: String(row.last_seen ?? ''),
    updatedAt: String(row.updated_at ?? '')
  }));
}

/** 在线判定：两个刷新周期内有心跳即在线 */
export function isHeartbeatOnline(lastSeenIso, nowMs = Date.now()) {
  const stamp = Date.parse(String(lastSeenIso ?? ''));
  return Number.isFinite(stamp) && nowMs - stamp < HEARTBEAT_OFFLINE_MS;
}

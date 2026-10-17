/**
 * surge_logs 数据访问层公共出口。
 */

export { LOGS_SCHEMA } from './schema.js';

export {
  listLogs,
  getAllLogs,
  getStats
} from './query.js';

export { recordHit, recordHits, HIT_BATCH_MAX_ITEMS } from './hit.js';

export { updateLog, renameLog, validateLogPatch } from './edit.js';

export {
  deleteLog,
  clearAllLogs,
  clearEmptyCommentLogs,
  reduceExclude
} from './admin.js';

export { batchOverride } from './batch.js';

export {
  formatLogRule,
  markExportIpVersion,
  markIpVersionFromCanonical,
  canonicalizeLogItem,
  describeExportFilter,
  buildExportHeader,
  summarizeExport
} from './export.js';

export { normalizeSource } from './normalize.js';

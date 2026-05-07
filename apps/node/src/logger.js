const LEVEL_PRIORITY = {
  DEBUG: 10,
  INFO: 20,
  WARN: 30,
  ERROR: 40
};
const LOG_BUFFER_MAX = 5000;
const recentLogs = new Array(LOG_BUFFER_MAX);
let recentLogsCount = 0;
let recentLogsWriteIndex = 0;

function appendRecentLog(line) {
  recentLogs[recentLogsWriteIndex] = line;
  recentLogsWriteIndex = (recentLogsWriteIndex + 1) % LOG_BUFFER_MAX;
  if (recentLogsCount < LOG_BUFFER_MAX) {
    recentLogsCount += 1;
  }
}

function normalizeLevel(level) {
  const key = String(level || 'INFO').toUpperCase();
  return LEVEL_PRIORITY[key] ? key : 'INFO';
}

function createLogger(moduleName, configuredLevel) {
  const currentLevel = normalizeLevel(process.env.LOG_LEVEL || configuredLevel || 'INFO');
  const currentPriority = LEVEL_PRIORITY[currentLevel];
  function enabled(level) {
    return LEVEL_PRIORITY[normalizeLevel(level)] >= currentPriority;
  }

  function output(level, message, extra) {
    if (LEVEL_PRIORITY[level] < currentPriority) return;
    const line = `[${moduleName}][${new Date().toISOString()}][${level}] ${message}`;
    appendRecentLog(line + (extra === undefined ? '' : ` ${String(extra)}`));
    if (extra === undefined) {
      console.log(line);
      return;
    }
    console.log(line, extra);
  }

  return {
    debug: (message, extra) => output('DEBUG', message, extra),
    info: (message, extra) => output('INFO', message, extra),
    warn: (message, extra) => output('WARN', message, extra),
    error: (message, extra) => output('ERROR', message, extra),
    enabled,
    level: currentLevel
  };
}

function getRecentLogs(limit) {
  const n = Number(limit);
  const take = Number.isFinite(n) && n > 0 ? Math.floor(n) : 200;
  const size = recentLogsCount;
  const actualTake = Math.min(take, size);
  if (actualTake <= 0) {
    return [];
  }
  const out = new Array(actualTake);
  let start = (recentLogsWriteIndex - actualTake + LOG_BUFFER_MAX) % LOG_BUFFER_MAX;
  for (let i = 0; i < actualTake; i += 1) {
    out[i] = recentLogs[start];
    start = (start + 1) % LOG_BUFFER_MAX;
  }
  return out;
}

module.exports = {
  createLogger,
  getRecentLogs
};

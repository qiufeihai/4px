const LEVEL_PRIORITY = {
  DEBUG: 10,
  INFO: 20,
  WARN: 30,
  ERROR: 40
};
const LOG_BUFFER_MAX = 5000;
const recentLogs = [];

function normalizeLevel(level) {
  const key = String(level || 'INFO').toUpperCase();
  return LEVEL_PRIORITY[key] ? key : 'INFO';
}

function createLogger(moduleName, configuredLevel) {
  const currentLevel = normalizeLevel(process.env.LOG_LEVEL || configuredLevel || 'INFO');
  const currentPriority = LEVEL_PRIORITY[currentLevel];

  function output(level, message, extra) {
    if (LEVEL_PRIORITY[level] < currentPriority) return;
    const line = `[${moduleName}][${new Date().toISOString()}][${level}] ${message}`;
    recentLogs.push(line + (extra === undefined ? '' : ` ${String(extra)}`));
    if (recentLogs.length > LOG_BUFFER_MAX) {
      recentLogs.splice(0, recentLogs.length - LOG_BUFFER_MAX);
    }
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
    level: currentLevel
  };
}

function getRecentLogs(limit) {
  const n = Number(limit);
  const take = Number.isFinite(n) && n > 0 ? Math.floor(n) : 200;
  if (take >= recentLogs.length) {
    return recentLogs.slice();
  }
  return recentLogs.slice(recentLogs.length - take);
}

module.exports = {
  createLogger,
  getRecentLogs
};

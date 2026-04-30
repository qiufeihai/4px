const LEVEL_PRIORITY = {
  DEBUG: 10,
  INFO: 20,
  WARN: 30,
  ERROR: 40
};

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

module.exports = {
  createLogger
};

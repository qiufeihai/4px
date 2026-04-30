const fs = require('fs');
const path = require('path');

function parseConfigPathFromArgv() {
  const idx = process.argv.indexOf('-c');
  if (idx >= 0 && idx + 1 < process.argv.length) {
    return path.resolve(process.argv[idx + 1]);
  }
  return null;
}

function loadConfig(defaultPath) {
  const configPath =
    parseConfigPathFromArgv() ||
    path.resolve(process.cwd(), path.basename(defaultPath));
  const text = fs.readFileSync(configPath, 'utf8');
  const cfg = JSON.parse(text);
  cfg.__configPath = configPath;
  cfg.__configDir = path.dirname(configPath);
  return cfg;
}

function resolvePath(baseDir, filePath) {
  if (!filePath) return filePath;
  if (path.isAbsolute(filePath)) return filePath;
  return path.resolve(baseDir, filePath);
}

module.exports = {
  loadConfig,
  resolvePath
};

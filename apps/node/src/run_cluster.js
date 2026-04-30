const cluster = require('cluster');
const os = require('os');
const path = require('path');

const workers = Math.max(1, Number(process.env.WORKERS || os.cpus().length));
const targetScript = process.env.TARGET_SCRIPT;

if (!targetScript) {
  console.error('TARGET_SCRIPT is required');
  process.exit(1);
}

if (cluster.isPrimary) {
  console.log(`[cluster] primary pid=${process.pid} workers=${workers} target=${targetScript}`);
  for (let i = 0; i < workers; i += 1) {
    cluster.fork();
  }
  cluster.on('exit', (worker, code, signal) => {
    console.warn(`[cluster] worker exit pid=${worker.process.pid} code=${code} signal=${signal}, restarting`);
    cluster.fork();
  });
} else {
  require(path.resolve(targetScript));
}

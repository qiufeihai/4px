const path = require('path');
const { loadConfig, resolvePath } = require('./config');
const { createLogger } = require('./logger');
const { UserStore } = require('./user_store');
const { startAdminServer } = require('./admin/server');
const { createDeviceLeaseStore } = require('./device_lease_store');

const cfg = loadConfig(path.resolve(__dirname, '../config/server.json'));
const logger = createLogger('admin', cfg.logLevel);

let deviceLeaseStore = null;
let closeDeviceLeaseStore = async () => {};
let activeDeviceIpcEnabled = false;
let activeDeviceIpcReqSeq = 1;
const pendingActiveDeviceIpc = new Map();

function buildUserStore() {
  const usersFilePath = cfg.authUsersFile ? resolvePath(cfg.__configDir, cfg.authUsersFile) : '';
  const staticAuthTokens = Array.isArray(cfg.authTokens)
    ? cfg.authTokens.map((v) => String(v || '').trim()).filter((v) => v)
    : [];
  const defaultMaxDevices = Math.max(1, Math.floor(Number(cfg.defaultMaxDevices || 1)));
  return new UserStore({
    filePath: usersFilePath,
    authTokens: staticAuthTokens,
    logger,
    reloadIntervalMs: cfg.authUsersReloadIntervalMs || 5000,
    defaultMaxDevices
  });
}

async function initDeviceLeaseStoreForAdmin() {
  const deviceLeaseStoreCfg = cfg.deviceLeaseStore && typeof cfg.deviceLeaseStore === 'object' ? cfg.deviceLeaseStore : {};
  const mode = String(deviceLeaseStoreCfg.mode || 'memory').trim().toLowerCase() === 'redis' ? 'redis' : 'memory';
  if (mode !== 'redis') {
    if (typeof process.send === 'function') {
      activeDeviceIpcEnabled = true;
      logger.info('admin activeDevices use IPC from data-plane (memory mode)');
    } else {
      logger.warn('admin activeDevices in memory mode may not reflect data-plane runtime leases');
    }
    return;
  }
  const redisCfg = deviceLeaseStoreCfg.redis && typeof deviceLeaseStoreCfg.redis === 'object'
    ? deviceLeaseStoreCfg.redis
    : {};
  const ttlMs = Math.max(5000, Math.floor(Number(cfg.deviceLeaseTtlMs || 90000)));
  const initialized = await createDeviceLeaseStore({
    mode: 'redis',
    ttlMs,
    prefix: String(deviceLeaseStoreCfg.prefix || '4px:device_lease'),
    redisUrl: redisCfg.url,
    redisPassword: redisCfg.password,
    redisDatabase: redisCfg.database,
    redisConnectTimeoutMs: redisCfg.connectTimeoutMs,
    logger
  });
  deviceLeaseStore = initialized.store;
  closeDeviceLeaseStore = typeof initialized.close === 'function' ? initialized.close : async () => {};
}

async function getUserActiveDeviceStats(userIds = []) {
  if (deviceLeaseStore) {
    return deviceLeaseStore.getActiveDeviceCountsByUsers(userIds);
  }
  if (!activeDeviceIpcEnabled) return {};
  if (typeof process.send !== 'function') return {};
  const reqId = `${Date.now()}_${activeDeviceIpcReqSeq++}`;
  const ids = Array.isArray(userIds) ? userIds.slice(0, 5000) : [];
  return await new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingActiveDeviceIpc.delete(reqId);
      resolve({});
    }, 2000);
    pendingActiveDeviceIpc.set(reqId, { resolve, timer });
    process.send({ type: 'admin_get_active_device_counts', requestId: reqId, userIds: ids });
  });
}

async function getSystemResourcesSnapshot() {
  if (!activeDeviceIpcEnabled) return null;
  if (typeof process.send !== 'function') return null;
  const reqId = `${Date.now()}_${activeDeviceIpcReqSeq++}`;
  return await new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingActiveDeviceIpc.delete(reqId);
      resolve(null);
    }, 2000);
    pendingActiveDeviceIpc.set(reqId, { resolve, timer });
    process.send({ type: 'admin_get_system_resources', requestId: reqId });
  });
}

async function getSystemLogs(limit = 200) {
  if (!activeDeviceIpcEnabled) return null;
  if (typeof process.send !== 'function') return null;
  const reqId = `${Date.now()}_${activeDeviceIpcReqSeq++}`;
  const safeLimit = Number.isFinite(Number(limit)) ? Math.max(1, Math.min(1000, Math.floor(Number(limit)))) : 200;
  return await new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingActiveDeviceIpc.delete(reqId);
      resolve(null);
    }, 2000);
    pendingActiveDeviceIpc.set(reqId, { resolve, timer });
    process.send({ type: 'admin_get_system_logs', requestId: reqId, limit: safeLimit });
  });
}

async function bootstrap() {
  const adminCfg = cfg.admin && typeof cfg.admin === 'object' ? cfg.admin : {};
  if (adminCfg.enabled !== true) {
    return;
  }
  await initDeviceLeaseStoreForAdmin();
  const userStore = buildUserStore();
  startAdminServer({ cfg, userStore, logger, getUserActiveDeviceStats, getSystemResourcesSnapshot, getSystemLogs });
}

process.on('SIGTERM', async () => {
  await closeDeviceLeaseStore();
  process.exit(0);
});

process.on('SIGINT', async () => {
  await closeDeviceLeaseStore();
  process.exit(0);
});

process.on('message', (msg) => {
  if (!msg || typeof msg !== 'object') return;
  const type = String(msg.type || '');
  const requestId = String(msg.requestId || '').trim();
  if (!requestId) return;
  const pending = pendingActiveDeviceIpc.get(requestId);
  if (!pending) return;
  pendingActiveDeviceIpc.delete(requestId);
  clearTimeout(pending.timer);
  if (type === 'admin_active_device_counts') {
    const counts = msg.counts && typeof msg.counts === 'object' ? msg.counts : {};
    pending.resolve(counts);
    return;
  }
  if (type === 'admin_system_resources') {
    const resources = msg.resources && typeof msg.resources === 'object' ? msg.resources : null;
    pending.resolve(resources);
    return;
  }
  if (type === 'admin_system_logs') {
    const lines = Array.isArray(msg.lines) ? msg.lines : null;
    pending.resolve(lines);
    return;
  }
  pending.resolve(null);
});

void bootstrap();

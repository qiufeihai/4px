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
    logger.warn('admin activeDevices in memory mode may not reflect data-plane runtime leases');
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
  if (!deviceLeaseStore) return {};
  return deviceLeaseStore.getActiveDeviceCountsByUsers(userIds);
}

async function bootstrap() {
  const adminCfg = cfg.admin && typeof cfg.admin === 'object' ? cfg.admin : {};
  if (adminCfg.enabled !== true) {
    return;
  }
  await initDeviceLeaseStoreForAdmin();
  const userStore = buildUserStore();
  startAdminServer({ cfg, userStore, logger, getUserActiveDeviceStats });
}

process.on('SIGTERM', async () => {
  await closeDeviceLeaseStore();
  process.exit(0);
});

process.on('SIGINT', async () => {
  await closeDeviceLeaseStore();
  process.exit(0);
});

void bootstrap();

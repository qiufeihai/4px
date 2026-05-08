const fs = require('fs');
const dns = require('dns');
const net = require('net');
const path = require('path');
const http2 = require('http2');
const { monitorEventLoopDelay } = require('perf_hooks');
const { loadConfig, resolvePath } = require('./config');
const { createLogger } = require('./logger');
const { UserStore } = require('./user_store');
const { startAdminServer } = require('./admin/server');

const cfg = loadConfig(path.resolve(__dirname, '../config/server.json'));
const key = fs.readFileSync(resolvePath(cfg.__configDir, cfg.tls.keyFile));
const cert = fs.readFileSync(resolvePath(cfg.__configDir, cfg.tls.certFile));
const logger = createLogger('server', cfg.logLevel);
const remoteConnectTimeoutMs = cfg.remoteConnectTimeoutMs || cfg.connectTimeoutMs || 10000;
const remoteIdleTimeoutMs = Number.isFinite(Number(cfg.remoteIdleTimeoutMs)) ? Number(cfg.remoteIdleTimeoutMs) : 300000;
const remoteKeepAliveInitialDelayMs = cfg.remoteKeepAliveInitialDelayMs || 30000;
const remoteAutoSelectFamily = cfg.remoteAutoSelectFamily !== false;
const remoteAutoSelectFamilyAttemptTimeoutMs = Math.max(
  10,
  Number(cfg.remoteAutoSelectFamilyAttemptTimeoutMs || 300)
);
const streamIdleTimeoutMs = Number.isFinite(Number(cfg.streamIdleTimeoutMs)) ? Number(cfg.streamIdleTimeoutMs) : 300000;
const maxBufferedBytes = cfg.maxBufferedBytes || 4 * 1024 * 1024;
const metricsIntervalMs = cfg.metricsIntervalMs || 30000;
const listenBacklog = cfg.listenBacklog || 4096;
const remoteConnectMaxInFlight = Math.max(1, Math.floor(Number(cfg.remoteConnectMaxInFlight || 4096)));
const remoteConnectMaxInFlightPerHost = Math.max(0, Math.floor(Number(cfg.remoteConnectMaxInFlightPerHost || 1024)));
const remoteConnectOverloadLogMinIntervalMs = Math.max(0, Number(cfg.remoteConnectOverloadLogMinIntervalMs || 3000));
const remoteConnectOverloadWaitMs = Math.max(0, Math.floor(Number(cfg.remoteConnectOverloadWaitMs || 20)));
const remoteConnectOverloadMaxWaiters = Math.max(0, Math.floor(Number(cfg.remoteConnectOverloadMaxWaiters || 1024)));
const remoteDnsCacheEnabled = cfg.remoteDnsCacheEnabled !== false;
const remoteDnsCacheTtlMs = Math.max(1000, Math.floor(Number(cfg.remoteDnsCacheTtlMs || 60000)));
const remoteDnsNegativeCacheTtlMs = Math.max(200, Math.floor(Number(cfg.remoteDnsNegativeCacheTtlMs || 5000)));
const remoteDnsCacheMaxEntries = Math.max(64, Math.floor(Number(cfg.remoteDnsCacheMaxEntries || 4096)));
const remoteCircuitEnabled = cfg.remoteCircuitEnabled !== false;
const remoteCircuitFailureThreshold = Math.max(1, Math.floor(Number(cfg.remoteCircuitFailureThreshold || 8)));
const remoteCircuitOpenMs = Math.max(1000, Math.floor(Number(cfg.remoteCircuitOpenMs || 15000)));
const remoteCircuitLogMinIntervalMs = Math.max(0, Math.floor(Number(cfg.remoteCircuitLogMinIntervalMs || 3000)));
const remoteCircuitMaxTargets = Math.max(64, Math.floor(Number(cfg.remoteCircuitMaxTargets || 4096)));
const establishWarnThresholdMs = Math.max(200, Number(cfg.establishWarnThresholdMs || 1500));
const establishWarnMinIntervalMs = Math.max(200, Number(cfg.establishWarnMinIntervalMs || 5000));
const slowEstablishEnabled = cfg.slowEstablishEnabled === true;
const slowEstablishTopN = Math.max(1, Math.floor(Number(cfg.slowEstablishTopN || 5)));
const remoteErrorLogMinIntervalMs = Math.max(0, Number(cfg.remoteErrorLogMinIntervalMs || 3000));
const h2HeaderTableSize = Number(cfg.h2HeaderTableSize || 4096);
const h2InitialWindowSize = Number(cfg.h2InitialWindowSize || 1024 * 1024);
const h2MaxConcurrentStreams = Number(cfg.h2MaxConcurrentStreams || 1024);
const h2MaxFrameSize = Number(cfg.h2MaxFrameSize || 64 * 1024);
const h2MaxHeaderListSize = Number(cfg.h2MaxHeaderListSize || 64 * 1024);
const h2EnableConnectProtocol = cfg.h2EnableConnectProtocol === true;
const h2SessionNoDelay = cfg.h2SessionNoDelay !== false;
const h2SessionKeepAlive = cfg.h2SessionKeepAlive !== false;
const h2SessionKeepAliveInitialDelayMs = Math.max(
  0,
  Number(cfg.h2SessionKeepAliveInitialDelayMs || 30000)
);
const userRuntimeTrackingEnabled = cfg.userRuntimeTrackingEnabled === true;
const userActivityUpdateIntervalMs = Math.max(1000, Number(cfg.userActivityUpdateIntervalMs || 60000));
const defaultMaxDevices = Math.max(1, Math.floor(Number(cfg.defaultMaxDevices || 1)));
const deviceLeaseTtlMs = Math.max(5000, Math.floor(Number(cfg.deviceLeaseTtlMs || 90000)));
const deviceLimitPolicy = String(cfg.deviceLimitPolicy || 'reject').trim().toLowerCase() === 'kick_oldest' ? 'kick_oldest' : 'reject';
const usersFilePath = cfg.authUsersFile ? resolvePath(cfg.__configDir, cfg.authUsersFile) : '';
const staticAuthTokens = Array.isArray(cfg.authTokens)
  ? cfg.authTokens.map((v) => String(v || '').trim()).filter((v) => v)
  : [];
const userStore = new UserStore({
  filePath: usersFilePath,
  authTokens: staticAuthTokens,
  logger,
  reloadIntervalMs: cfg.authUsersReloadIntervalMs || 5000,
  defaultMaxDevices
});
const userRuntime = new Map();
const userDeviceLeases = new Map();
const slowEstablishLastWarnAt = new Map();
const slowEstablishSummary = new Map();
const remoteErrorLastLogAt = new Map();
let remoteAutoSelectFamilyRuntimeEnabled = remoteAutoSelectFamily;
let remoteAutoSelectFamilyFallbackWarned = false;
let remoteConnectInFlight = 0;
let remoteConnectInFlightPeak = 0;
let remoteConnectInFlightPerHostPeak = 0;
let remoteConnectOverloadLastLogAt = 0;
let remoteConnectOverloadWaiters = 0;
const remoteConnectHostInFlight = new Map();
const remoteDnsCache = new Map();
const remoteCircuitState = new Map();
const remoteCircuitLastLogAt = new Map();
const dnsSummaryLast = {
  hit: 0,
  miss: 0,
  negativeHit: 0,
  resolveError: 0
};
let h2SessionSocketTuneSupported = true;
let h2SessionSocketTuneWarned = false;

function shouldEmitOverloadLog() {
  if (remoteConnectOverloadLogMinIntervalMs <= 0) return true;
  const now = Date.now();
  if (now - remoteConnectOverloadLastLogAt < remoteConnectOverloadLogMinIntervalMs) {
    return false;
  }
  remoteConnectOverloadLastLogAt = now;
  return true;
}

function createRemoteConnection(host, port, family) {
  const baseOptions = {};
  if (family === 4 || family === 6) {
    baseOptions.family = family;
  }
  if (baseOptions.family) {
    return net.createConnection({ host, port, ...baseOptions });
  }
  if (!remoteAutoSelectFamilyRuntimeEnabled) {
    return net.createConnection({ host, port, ...baseOptions });
  }
  try {
    return net.createConnection({
      host,
      port,
      ...baseOptions,
      autoSelectFamily: true,
      autoSelectFamilyAttemptTimeout: remoteAutoSelectFamilyAttemptTimeoutMs
    });
  } catch (err) {
    remoteAutoSelectFamilyRuntimeEnabled = false;
    if (!remoteAutoSelectFamilyFallbackWarned) {
      remoteAutoSelectFamilyFallbackWarned = true;
      logger.warn(
        `remote autoSelectFamily unsupported, fallback to default connect behavior, err=${String(
          err && (err.code || err.message || err)
        )}`
      );
    }
    return net.createConnection({ host, port, ...baseOptions });
  }
}

function pruneDnsCacheIfNeeded() {
  if (remoteDnsCache.size <= remoteDnsCacheMaxEntries) return;
  const now = Date.now();
  for (const [key, value] of remoteDnsCache.entries()) {
    if (!value || Number(value.expiresAt || 0) <= now) {
      remoteDnsCache.delete(key);
    }
    if (remoteDnsCache.size <= remoteDnsCacheMaxEntries) {
      return;
    }
  }
  while (remoteDnsCache.size > remoteDnsCacheMaxEntries) {
    const firstKey = remoteDnsCache.keys().next().value;
    if (!firstKey) break;
    remoteDnsCache.delete(firstKey);
  }
}

function chooseDnsAddressFromEntry(entry) {
  if (!entry || !Array.isArray(entry.addresses) || entry.addresses.length === 0) return null;
  const index = entry.nextIndex % entry.addresses.length;
  const addr = entry.addresses[index];
  entry.nextIndex = (entry.nextIndex + 1) % entry.addresses.length;
  return addr;
}

async function resolveRemoteAddress(host) {
  const normalizedHost = String(host || '').trim();
  if (!normalizedHost) {
    throw new Error('empty target host');
  }
  const ipFamily = net.isIP(normalizedHost);
  if (ipFamily > 0 || !remoteDnsCacheEnabled) {
    return { host: normalizedHost, family: ipFamily > 0 ? ipFamily : undefined };
  }
  const now = Date.now();
  const cached = remoteDnsCache.get(normalizedHost);
  if (cached && Number(cached.expiresAt || 0) > now) {
    if (cached.type === 'negative') {
      stats.remoteDnsNegativeCacheHitTotal += 1;
      const err = new Error(cached.message || 'DNS lookup failed (cached)');
      err.code = cached.code || 'EAI_AGAIN';
      throw err;
    }
    const selected = chooseDnsAddressFromEntry(cached);
    if (selected) {
      stats.remoteDnsCacheHitTotal += 1;
      return { host: selected.address, family: selected.family };
    }
  } else if (cached) {
    remoteDnsCache.delete(normalizedHost);
  }

  stats.remoteDnsCacheMissTotal += 1;
  try {
    const records = await dns.promises.lookup(normalizedHost, { all: true, verbatim: true });
    const addresses = Array.isArray(records)
      ? records
          .map((item) => ({
            address: String(item && item.address ? item.address : '').trim(),
            family: Number(item && item.family)
          }))
          .filter((item) => item.address && (item.family === 4 || item.family === 6))
      : [];
    if (addresses.length === 0) {
      const err = new Error(`DNS lookup returned empty for ${normalizedHost}`);
      err.code = 'ENOTFOUND';
      throw err;
    }
    const entry = {
      type: 'positive',
      expiresAt: now + remoteDnsCacheTtlMs,
      addresses,
      nextIndex: 0
    };
    remoteDnsCache.set(normalizedHost, entry);
    pruneDnsCacheIfNeeded();
    const selected = chooseDnsAddressFromEntry(entry);
    return { host: selected.address, family: selected.family };
  } catch (err) {
    stats.remoteDnsResolveErrorTotal += 1;
    remoteDnsCache.set(normalizedHost, {
      type: 'negative',
      expiresAt: now + remoteDnsNegativeCacheTtlMs,
      code: String((err && err.code) || 'EAI_AGAIN'),
      message: String((err && err.message) || 'dns lookup failed')
    });
    pruneDnsCacheIfNeeded();
    throw err;
  }
}

function targetKey(host, port) {
  return `${String(host || '').trim().toLowerCase()}:${Number(port || 0)}`;
}

function shouldEmitCircuitLog(key) {
  if (remoteCircuitLogMinIntervalMs <= 0) return true;
  const now = Date.now();
  const last = Number(remoteCircuitLastLogAt.get(key) || 0);
  if (now - last < remoteCircuitLogMinIntervalMs) {
    return false;
  }
  remoteCircuitLastLogAt.set(key, now);
  if (remoteCircuitLastLogAt.size > 8192) {
    remoteCircuitLastLogAt.clear();
  }
  return true;
}

function getOrCreateCircuitState(key) {
  if (!remoteCircuitState.has(key)) {
    remoteCircuitState.set(key, {
      failures: 0,
      openUntilMs: 0
    });
  }
  if (remoteCircuitState.size > remoteCircuitMaxTargets) {
    const firstKey = remoteCircuitState.keys().next().value;
    if (firstKey) {
      remoteCircuitState.delete(firstKey);
    }
  }
  return remoteCircuitState.get(key);
}

function isCircuitOpen(key, nowMs) {
  if (!remoteCircuitEnabled) return false;
  const state = remoteCircuitState.get(key);
  if (!state) return false;
  const now = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now();
  if (state.openUntilMs > now) {
    return true;
  }
  if (state.openUntilMs > 0 && state.openUntilMs <= now) {
    state.openUntilMs = 0;
    state.failures = 0;
  }
  return false;
}

function markCircuitSuccess(key) {
  if (!remoteCircuitEnabled) return;
  const state = remoteCircuitState.get(key);
  if (!state) return;
  if (state.failures === 0 && state.openUntilMs === 0) return;
  state.failures = 0;
  state.openUntilMs = 0;
}

function markCircuitFailure(key, reason) {
  if (!remoteCircuitEnabled) return;
  const state = getOrCreateCircuitState(key);
  state.failures += 1;
  if (state.failures < remoteCircuitFailureThreshold) {
    return;
  }
  state.failures = 0;
  state.openUntilMs = Date.now() + remoteCircuitOpenMs;
  stats.remoteCircuitOpenTotal += 1;
  if (shouldEmitCircuitLog(key)) {
    logger.warn(
      `remote circuit opened, target=${key}, open_ms=${remoteCircuitOpenMs}, threshold=${remoteCircuitFailureThreshold}, reason=${reason}`
    );
  }
}

function acquireHostConnectSlot(key) {
  if (remoteConnectMaxInFlightPerHost <= 0) return true;
  const current = Number(remoteConnectHostInFlight.get(key) || 0);
  if (current >= remoteConnectMaxInFlightPerHost) {
    return false;
  }
  const next = current + 1;
  remoteConnectHostInFlight.set(key, next);
  if (next > remoteConnectInFlightPerHostPeak) {
    remoteConnectInFlightPerHostPeak = next;
  }
  return true;
}

function releaseHostConnectSlot(key) {
  if (remoteConnectMaxInFlightPerHost <= 0) return;
  const current = Number(remoteConnectHostInFlight.get(key) || 0);
  if (current <= 1) {
    remoteConnectHostInFlight.delete(key);
    return;
  }
  remoteConnectHostInFlight.set(key, current - 1);
}

function shouldEmitSlowWarn(kind, host, port) {
  if (!slowEstablishEnabled) return false;
  const key = `${kind}|${String(host || '').toLowerCase()}:${Number(port || 0)}`;
  const now = Date.now();
  const last = Number(slowEstablishLastWarnAt.get(key) || 0);
  if (now - last < establishWarnMinIntervalMs) {
    return false;
  }
  slowEstablishLastWarnAt.set(key, now);
  if (slowEstablishLastWarnAt.size > 2048) {
    slowEstablishLastWarnAt.clear();
  }
  return true;
}

function recordSlowEstablish(kind, host, port, ttfbMs, connectMs) {
  if (!slowEstablishEnabled) return;
  const h = String(host || '').toLowerCase();
  const p = Number(port || 0);
  const key = `${kind}|${h}:${p}`;
  const current = slowEstablishSummary.get(key) || {
    kind,
    host: h,
    port: p,
    count: 0,
    ttfbMaxMs: 0,
    connectMaxMs: 0
  };
  current.count += 1;
  if (Number.isFinite(Number(ttfbMs)) && Number(ttfbMs) > current.ttfbMaxMs) {
    current.ttfbMaxMs = Number(ttfbMs);
  }
  if (Number.isFinite(Number(connectMs)) && Number(connectMs) > current.connectMaxMs) {
    current.connectMaxMs = Number(connectMs);
  }
  slowEstablishSummary.set(key, current);
  if (slowEstablishSummary.size > 4096) {
    slowEstablishSummary.clear();
  }
}

function shouldEmitRemoteErrorLog(host, port) {
  if (remoteErrorLogMinIntervalMs <= 0) return true;
  const key = `${String(host || '').toLowerCase()}:${Number(port || 0)}`;
  const now = Date.now();
  const last = Number(remoteErrorLastLogAt.get(key) || 0);
  if (now - last < remoteErrorLogMinIntervalMs) {
    return false;
  }
  remoteErrorLastLogAt.set(key, now);
  if (remoteErrorLastLogAt.size > 2048) {
    remoteErrorLastLogAt.clear();
  }
  return true;
}

const stats = {
  streamTotal: 0,
  activeStreams: 0,
  routeRejectedTotal: 0,
  authRejectedTotal: 0,
  targetParseFailTotal: 0,
  remoteConnectSuccessTotal: 0,
  remoteConnectErrorTotal: 0,
  remoteConnectTimeoutTotal: 0,
  remoteConnectOverloadRejectTotal: 0,
  remoteConnectOverloadRejectByHostTotal: 0,
  remoteConnectOverloadWaitTotal: 0,
  remoteDnsCacheHitTotal: 0,
  remoteDnsCacheMissTotal: 0,
  remoteDnsNegativeCacheHitTotal: 0,
  remoteDnsResolveErrorTotal: 0,
  remoteCircuitRejectTotal: 0,
  remoteCircuitOpenTotal: 0,
  remoteIdleTimeoutTotal: 0,
  bufferOverflowTotal: 0,
  retryableErrorTotal: 0,
  nonRetryableErrorTotal: 0
};
const loopDelay = monitorEventLoopDelay({ resolution: 20 });
loopDelay.enable();

setInterval(() => {
  logger.info(
    `metrics stream_total=${stats.streamTotal} active_streams=${stats.activeStreams} route_reject=${stats.routeRejectedTotal} auth_reject=${stats.authRejectedTotal} target_parse_fail=${stats.targetParseFailTotal} remote_ok=${stats.remoteConnectSuccessTotal} remote_error=${stats.remoteConnectErrorTotal} remote_connect_timeout=${stats.remoteConnectTimeoutTotal} remote_connect_overload_reject=${stats.remoteConnectOverloadRejectTotal} remote_connect_overload_reject_by_host=${stats.remoteConnectOverloadRejectByHostTotal} remote_connect_overload_wait_total=${stats.remoteConnectOverloadWaitTotal} remote_connect_overload_waiters=${remoteConnectOverloadWaiters} remote_dns_cache_hit=${stats.remoteDnsCacheHitTotal} remote_dns_cache_miss=${stats.remoteDnsCacheMissTotal} remote_dns_negative_cache_hit=${stats.remoteDnsNegativeCacheHitTotal} remote_dns_resolve_error=${stats.remoteDnsResolveErrorTotal} remote_dns_cache_size=${remoteDnsCache.size} remote_circuit_reject=${stats.remoteCircuitRejectTotal} remote_circuit_open_total=${stats.remoteCircuitOpenTotal} remote_circuit_targets=${remoteCircuitState.size} remote_connect_inflight=${remoteConnectInFlight} remote_connect_inflight_peak=${remoteConnectInFlightPeak} remote_connect_inflight_host_peak=${remoteConnectInFlightPerHostPeak} remote_idle_timeout=${stats.remoteIdleTimeoutTotal} buffer_overflow=${stats.bufferOverflowTotal} retryable_err=${stats.retryableErrorTotal} non_retryable_err=${stats.nonRetryableErrorTotal} eventloop_p95_ms=${(loopDelay.percentile(95) / 1e6).toFixed(2)}`
  );
  if (remoteDnsCacheEnabled) {
    const hitDelta = Math.max(0, stats.remoteDnsCacheHitTotal - dnsSummaryLast.hit);
    const missDelta = Math.max(0, stats.remoteDnsCacheMissTotal - dnsSummaryLast.miss);
    const negativeHitDelta = Math.max(0, stats.remoteDnsNegativeCacheHitTotal - dnsSummaryLast.negativeHit);
    const resolveErrorDelta = Math.max(0, stats.remoteDnsResolveErrorTotal - dnsSummaryLast.resolveError);
    const totalLookups = hitDelta + missDelta + negativeHitDelta;
    const cacheHitRate = totalLookups > 0 ? (((hitDelta + negativeHitDelta) / totalLookups) * 100).toFixed(1) : '0.0';
    const negativeShare = totalLookups > 0 ? ((negativeHitDelta / totalLookups) * 100).toFixed(1) : '0.0';
    logger.info(
      `dns summary interval_ms=${metricsIntervalMs} lookups=${totalLookups} hit=${hitDelta} miss=${missDelta} negative_hit=${negativeHitDelta} resolve_error=${resolveErrorDelta} hit_rate_pct=${cacheHitRate} negative_share_pct=${negativeShare}`
    );
    dnsSummaryLast.hit = stats.remoteDnsCacheHitTotal;
    dnsSummaryLast.miss = stats.remoteDnsCacheMissTotal;
    dnsSummaryLast.negativeHit = stats.remoteDnsNegativeCacheHitTotal;
    dnsSummaryLast.resolveError = stats.remoteDnsResolveErrorTotal;
  }
  remoteConnectInFlightPeak = remoteConnectInFlight;
  if (remoteConnectMaxInFlightPerHost > 0) {
    remoteConnectInFlightPerHostPeak = 0;
  }
  loopDelay.reset();
}, metricsIntervalMs).unref();

setInterval(() => {
  if (!slowEstablishEnabled) return;
  if (slowEstablishSummary.size === 0) return;
  const items = Array.from(slowEstablishSummary.values())
    .sort((a, b) => {
      if (b.ttfbMaxMs !== a.ttfbMaxMs) return b.ttfbMaxMs - a.ttfbMaxMs;
      return b.count - a.count;
    })
    .slice(0, slowEstablishTopN);
  const summaryText = items
    .map((v) => `${v.kind}:${v.host}:${v.port}#${v.count}(ttfb_max=${v.ttfbMaxMs},connect_max=${v.connectMaxMs})`)
    .join(', ');
  logger.warn(`slow establish summary top=${items.length}/${slowEstablishSummary.size}, ${summaryText}`);
  slowEstablishSummary.clear();
}, metricsIntervalMs).unref();

function classifyServerError(err, fallback = 'retryable') {
  const msg = String((err && (err.code || err.message)) || err || '').toLowerCase();
  if (!msg) return fallback;
  if (msg.includes('unauthorized') || msg.includes('forbidden') || msg.includes('auth') || msg.includes('status=401') || msg.includes('status=403')) {
    return 'non-retryable';
  }
  if (msg.includes('econnreset') || msg.includes('etimedout') || msg.includes('timeout') || msg.includes('econnrefused') || msg.includes('eai_again') || msg.includes('enetunreach') || msg.includes('broken pipe')) {
    return 'retryable';
  }
  return fallback;
}

function markServerError(kind) {
  if (kind === 'non-retryable') {
    stats.nonRetryableErrorTotal += 1;
    return;
  }
  stats.retryableErrorTotal += 1;
}

function getUserRuntimeRecord(authUser) {
  const id = String(authUser && authUser.id ? authUser.id : '').trim() || 'unknown';
  if (!userRuntime.has(id)) {
    userRuntime.set(id, {
      userId: id,
      username: String(authUser && authUser.username ? authUser.username : ''),
      activeConnections: 0,
      activeDevices: 0,
      lastSeenAtMs: 0,
      lastActiveAtMs: 0
    });
  }
  const record = userRuntime.get(id);
  if (authUser && authUser.username) {
    record.username = String(authUser.username);
  }
  return record;
}

function normalizeClientInstanceId(value, remotePeer) {
  const raw = String(value || '').trim();
  if (raw) {
    return raw.slice(0, 128);
  }
  const remoteIp = String(remotePeer || '').split(':')[0] || 'unknown';
  return `legacy:${remoteIp}`;
}

function pruneUserDeviceLeases(userId, now) {
  const uid = String(userId || '').trim();
  if (!uid || !userDeviceLeases.has(uid)) return;
  const leases = userDeviceLeases.get(uid);
  leases.forEach((lastSeenAtMs, clientId) => {
    if (now - Number(lastSeenAtMs || 0) > deviceLeaseTtlMs) {
      leases.delete(clientId);
    }
  });
  if (leases.size === 0) {
    userDeviceLeases.delete(uid);
  }
}

function getUserDeviceMap(userId) {
  const uid = String(userId || '').trim();
  if (!uid) return null;
  if (!userDeviceLeases.has(uid)) {
    userDeviceLeases.set(uid, new Map());
  }
  return userDeviceLeases.get(uid);
}

function calcMaxDevices(authUser) {
  const fromUser = Number(authUser && authUser.maxDevices);
  if (Number.isFinite(fromUser) && fromUser >= 1) {
    return Math.floor(fromUser);
  }
  return defaultMaxDevices;
}

function touchDeviceLease(authUser, clientId) {
  const uid = String(authUser && authUser.id ? authUser.id : '').trim();
  if (!uid || !clientId) return { ok: true, activeDevices: 0, maxDevices: calcMaxDevices(authUser) };
  const now = Date.now();
  pruneUserDeviceLeases(uid, now);
  const leases = getUserDeviceMap(uid);
  const maxDevices = calcMaxDevices(authUser);
  if (leases.has(clientId)) {
    leases.set(clientId, now);
    return { ok: true, activeDevices: leases.size, maxDevices };
  }
  if (leases.size < maxDevices) {
    leases.set(clientId, now);
    return { ok: true, activeDevices: leases.size, maxDevices };
  }
  if (deviceLimitPolicy === 'kick_oldest') {
    let oldestId = '';
    let oldestSeen = Number.POSITIVE_INFINITY;
    leases.forEach((lastSeenAtMs, existingClientId) => {
      const t = Number(lastSeenAtMs || 0);
      if (t < oldestSeen) {
        oldestSeen = t;
        oldestId = existingClientId;
      }
    });
    if (oldestId) {
      leases.delete(oldestId);
      leases.set(clientId, now);
      return { ok: true, activeDevices: leases.size, maxDevices };
    }
  }
  return { ok: false, activeDevices: leases.size, maxDevices };
}

function releaseDeviceLease(authUser, clientId) {
  const uid = String(authUser && authUser.id ? authUser.id : '').trim();
  if (!uid || !clientId || !userDeviceLeases.has(uid)) return;
  const leases = userDeviceLeases.get(uid);
  leases.delete(clientId);
  if (leases.size === 0) {
    userDeviceLeases.delete(uid);
  }
}

function markUserSeen(authUser) {
  if (!userRuntimeTrackingEnabled) return;
  const record = getUserRuntimeRecord(authUser);
  record.lastSeenAtMs = Date.now();
  pruneUserDeviceLeases(record.userId, record.lastSeenAtMs);
  record.activeDevices = userDeviceLeases.get(record.userId)?.size || 0;
}

function markUserConnectionOpen(authUser) {
  if (!userRuntimeTrackingEnabled) return;
  const record = getUserRuntimeRecord(authUser);
  record.activeConnections += 1;
  const now = Date.now();
  record.lastSeenAtMs = now;
  record.lastActiveAtMs = now;
}

function markUserConnectionActive(authUser, nowMs) {
  if (!userRuntimeTrackingEnabled) return;
  const record = getUserRuntimeRecord(authUser);
  const now = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now();
  if (!record.lastActiveAtMs || now - record.lastActiveAtMs >= userActivityUpdateIntervalMs) {
    record.lastActiveAtMs = now;
  }
}

function markUserConnectionClose(authUser) {
  if (!userRuntimeTrackingEnabled) return;
  const record = getUserRuntimeRecord(authUser);
  if (record.activeConnections > 0) record.activeConnections -= 1;
  record.lastActiveAtMs = Date.now();
}

function getUserRuntimeStats() {
  if (!userRuntimeTrackingEnabled) return {};
  const now = Date.now();
  userDeviceLeases.forEach((_, userId) => pruneUserDeviceLeases(userId, now));
  const out = {};
  userRuntime.forEach((value, key) => {
    out[key] = {
      userId: value.userId,
      username: value.username,
      activeConnections: value.activeConnections,
      activeDevices: userDeviceLeases.get(key)?.size || 0,
      online: value.activeConnections > 0,
      lastSeenAt: value.lastSeenAtMs ? new Date(value.lastSeenAtMs).toISOString() : null,
      lastActiveAt: value.lastActiveAtMs ? new Date(value.lastActiveAtMs).toISOString() : null
    };
  });
  return out;
}

function parseTarget(headers) {
  const hostFromHeader = String(headers['x-target-host'] || '').trim();
  const portFromHeader = Number(headers['x-target-port']);
  if (hostFromHeader && Number.isInteger(portFromHeader) && portFromHeader > 0 && portFromHeader <= 65535) {
    return {
      host: hostFromHeader,
      port: portFromHeader
    };
  }
  const decoded = Buffer.from(String(headers['x-target'] || ''), 'base64url').toString('utf8');
  const split = decoded.lastIndexOf(':');
  if (split <= 0 || split >= decoded.length - 1) {
    throw new Error('Invalid x-target');
  }
  const port = Number(decoded.slice(split + 1));
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error('Invalid x-target port');
  }
  return {
    host: decoded.slice(0, split),
    port
  };
}

const server = http2.createSecureServer({
  key,
  cert,
  allowHTTP1: false,
  ALPNProtocols: ['h2'],
  minVersion: 'TLSv1.2',
  settings: {
    headerTableSize: h2HeaderTableSize,
    initialWindowSize: h2InitialWindowSize,
    maxConcurrentStreams: h2MaxConcurrentStreams,
    maxFrameSize: h2MaxFrameSize,
    maxHeaderListSize: h2MaxHeaderListSize,
    enableConnectProtocol: h2EnableConnectProtocol
  }
});

server.on('session', (session) => {
  if (!h2SessionSocketTuneSupported) return;
  try {
    const socket = session && session.socket;
    if (!socket) return;
    if (h2SessionNoDelay) {
      socket.setNoDelay(true);
    }
    if (h2SessionKeepAlive) {
      socket.setKeepAlive(true, h2SessionKeepAliveInitialDelayMs);
    }
  } catch (err) {
    const code = String(err && err.code ? err.code : '');
    if (code === 'ERR_HTTP2_NO_SOCKET_MANIPULATION') {
      h2SessionSocketTuneSupported = false;
      if (!h2SessionSocketTuneWarned) {
        h2SessionSocketTuneWarned = true;
        logger.warn(
          'h2 session socket tuning disabled: current Node runtime does not allow HTTP/2 socket manipulation'
        );
      }
      return;
    }
    if (!h2SessionSocketTuneWarned) {
      h2SessionSocketTuneWarned = true;
      logger.warn(`h2 session socket tuning failed and disabled: ${String((err && (err.code || err.message)) || err)}`);
    }
    h2SessionSocketTuneSupported = false;
  }
});

function renderCamouflagePage() {
  const now = new Date().toISOString();
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Service Online</title>
  <style>
    body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #f7f8fb; color: #111827; }
    .wrap { min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 16px; }
    .card { width: 100%; max-width: 520px; background: #fff; border: 1px solid #e5e7eb; border-radius: 10px; padding: 18px; }
    h1 { margin: 0 0 8px; font-size: 20px; }
    p { margin: 6px 0; color: #4b5563; }
    .ok { color: #047857; }
    .meta { margin-top: 12px; font-size: 12px; color: #6b7280; }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="card">
      <h1>Service Online</h1>
      <p class="ok">Status: running</p>
      <p>This endpoint is available.</p>
      <div class="meta">timestamp: ${now}</div>
    </div>
  </div>
</body>
</html>`;
}

server.on('stream', async (stream, headers) => {
  stats.streamTotal += 1;
  stats.activeStreams += 1;
  const remotePeer = `${stream.session.socket.remoteAddress || '-'}:${stream.session.socket.remotePort || '-'}`;
  const streamId = stream.id;
  const traceId = String(headers['x-trace-id'] || '').trim() || `srv-${streamId}`;
  const acceptedAtMs = Date.now();
  let remoteConnectedAtMs = 0;
  let firstRemoteDataAtMs = 0;
  let establishWarnLogged = false;
  let authUser = null;
  let clientInstanceId = '';
  let leaseAcquired = false;
  const releaseLeaseOnce = () => {
    if (!leaseAcquired || !authUser || !clientInstanceId) return;
    leaseAcquired = false;
    releaseDeviceLease(authUser, clientInstanceId);
  };
  try {
    const reqMethod = String(headers[':method'] || '');
    const reqPath = String(headers[':path'] || '');
    if (reqMethod === 'GET' && reqPath === '/') {
      stream.respond({
        ':status': 200,
        'content-type': 'text/html; charset=utf-8'
      });
      stream.end(renderCamouflagePage());
      return;
    }
    const isProxyV1 = reqMethod === 'POST' && reqPath === '/proxy';
    if (!isProxyV1) {
      stats.routeRejectedTotal += 1;
      markServerError('non-retryable');
      logger.warn(`reject invalid route, trace_id=${traceId}, peer=${remotePeer}, stream=${streamId}, method=${reqMethod}, path=${reqPath}, err_class=non-retryable`);
      stream.respond({ ':status': 404 });
      stream.end();
      return;
    }
    const authResult = userStore.authenticate(headers['x-auth-token']);
    if (!authResult.ok) {
      stats.authRejectedTotal += 1;
      markServerError('non-retryable');
      logger.warn(`reject unauthorized request, trace_id=${traceId}, peer=${remotePeer}, stream=${streamId}, path=${reqPath}, reason=${authResult.reason}, err_class=non-retryable`);
      stream.respond({
        ':status': 401,
        'x-auth-reason': String(authResult.reason || '')
      });
      stream.end();
      return;
    }
    authUser = authResult.user;
    markUserSeen(authUser);
    clientInstanceId = normalizeClientInstanceId(headers['x-client-instance-id'], remotePeer);
    const leaseResult = touchDeviceLease(authUser, clientInstanceId);
    if (!leaseResult.ok) {
      stats.authRejectedTotal += 1;
      markServerError('non-retryable');
      logger.warn(
        `reject device limit exceeded, trace_id=${traceId}, peer=${remotePeer}, stream=${streamId}, path=${reqPath}, user=${authUser.username}, active_devices=${leaseResult.activeDevices}, max_devices=${leaseResult.maxDevices}, client_id=${clientInstanceId}, policy=${deviceLimitPolicy}, err_class=non-retryable`
      );
      stream.respond({
        ':status': 409,
        'content-type': 'application/json; charset=utf-8'
      });
      stream.end(JSON.stringify({
        ok: false,
        error: 'device_limit_exceeded',
        activeDevices: leaseResult.activeDevices,
        maxDevices: leaseResult.maxDevices
      }));
      return;
    }
    leaseAcquired = true;
    markUserSeen(authUser);
    const { host, port } = parseTarget(headers);
    let nextUserActiveUpdateAtMs = 0;
    const markActiveFast = () => {
      if (!userRuntimeTrackingEnabled) return;
      const now = Date.now();
      if (now < nextUserActiveUpdateAtMs) return;
      nextUserActiveUpdateAtMs = now + userActivityUpdateIntervalMs;
      markUserConnectionActive(authUser, now);
    };
    markUserConnectionOpen(authUser);
    if (logger.enabled('INFO')) {
      logger.info(`stream accepted, trace_id=${traceId}, peer=${remotePeer}, stream=${streamId}, user=${authUser.username}, target=${host}:${port}`);
    }
    const connectTargetKey = targetKey(host, port);
    if (isCircuitOpen(connectTargetKey, Date.now())) {
      stats.remoteCircuitRejectTotal += 1;
      markServerError('retryable');
      if (shouldEmitCircuitLog(connectTargetKey)) {
        const state = remoteCircuitState.get(connectTargetKey);
        const remainMs = Math.max(0, Number(state && state.openUntilMs ? state.openUntilMs - Date.now() : 0));
        logger.warn(
          `remote circuit reject, trace_id=${traceId}, stream=${streamId}, target=${host}:${port}, remain_ms=${remainMs}, err_class=retryable`
        );
      }
      stream.respond({ ':status': 503 });
      stream.end();
      markUserConnectionClose(authUser);
      releaseLeaseOnce();
      if (stats.activeStreams > 0) stats.activeStreams -= 1;
      return;
    }
    let connectHost = host;
    let connectFamily;
    try {
      const resolved = await resolveRemoteAddress(host);
      connectHost = resolved.host;
      connectFamily = resolved.family;
    } catch (e) {
      markServerError('retryable');
      markCircuitFailure(connectTargetKey, 'dns_lookup_error');
      if (shouldEmitRemoteErrorLog(host, port)) {
        logger.warn(
          `remote dns resolve failed, trace_id=${traceId}, stream=${streamId}, target=${host}:${port}, err=${String(
            (e && (e.code || e.message)) || e
          )}, err_class=retryable`
        );
      }
      stream.respond({ ':status': 502 });
      stream.end();
      markUserConnectionClose(authUser);
      releaseLeaseOnce();
      if (stats.activeStreams > 0) stats.activeStreams -= 1;
      return;
    }
    const hasGlobalConnectSlot = () => remoteConnectInFlight < remoteConnectMaxInFlight;
    const hasHostConnectSlot = () => {
      if (remoteConnectMaxInFlightPerHost <= 0) return true;
      return Number(remoteConnectHostInFlight.get(connectTargetKey) || 0) < remoteConnectMaxInFlightPerHost;
    };
    let waitedForOverloadRelief = false;
    if ((!hasGlobalConnectSlot() || !hasHostConnectSlot()) && remoteConnectOverloadWaitMs > 0 && remoteConnectOverloadWaiters < remoteConnectOverloadMaxWaiters) {
      waitedForOverloadRelief = true;
      stats.remoteConnectOverloadWaitTotal += 1;
      remoteConnectOverloadWaiters += 1;
      try {
        await new Promise((resolve) => setTimeout(resolve, remoteConnectOverloadWaitMs));
      } finally {
        if (remoteConnectOverloadWaiters > 0) {
          remoteConnectOverloadWaiters -= 1;
        }
      }
      if (stream.destroyed) {
        markUserConnectionClose(authUser);
        releaseLeaseOnce();
        if (stats.activeStreams > 0) stats.activeStreams -= 1;
        return;
      }
    }
    if (!hasGlobalConnectSlot()) {
      stats.remoteConnectOverloadRejectTotal += 1;
      markServerError('retryable');
      if (shouldEmitOverloadLog()) {
        logger.warn(
          `remote connect overload reject, trace_id=${traceId}, stream=${streamId}, target=${host}:${port}, inflight=${remoteConnectInFlight}, max_inflight=${remoteConnectMaxInFlight}, waited=${waitedForOverloadRelief}, err_class=retryable`
        );
      }
      stream.respond({ ':status': 503 });
      stream.end();
      markUserConnectionClose(authUser);
      releaseLeaseOnce();
      if (stats.activeStreams > 0) stats.activeStreams -= 1;
      return;
    }
    if (!acquireHostConnectSlot(connectTargetKey)) {
      stats.remoteConnectOverloadRejectByHostTotal += 1;
      markServerError('retryable');
      if (shouldEmitOverloadLog()) {
        logger.warn(
          `remote connect overload reject by host, trace_id=${traceId}, stream=${streamId}, target=${host}:${port}, host_inflight=${Number(remoteConnectHostInFlight.get(connectTargetKey) || 0)}, max_host_inflight=${remoteConnectMaxInFlightPerHost}, waited=${waitedForOverloadRelief}, err_class=retryable`
        );
      }
      stream.respond({ ':status': 503 });
      stream.end();
      markUserConnectionClose(authUser);
      releaseLeaseOnce();
      if (stats.activeStreams > 0) stats.activeStreams -= 1;
      return;
    }
    remoteConnectInFlight += 1;
    if (remoteConnectInFlight > remoteConnectInFlightPeak) {
      remoteConnectInFlightPeak = remoteConnectInFlight;
    }
    let connectInflightReleased = false;
    const releaseConnectInflight = () => {
      if (connectInflightReleased) return;
      connectInflightReleased = true;
      if (remoteConnectInFlight > 0) {
        remoteConnectInFlight -= 1;
      }
      releaseHostConnectSlot(connectTargetKey);
    };
    const remote = createRemoteConnection(connectHost, port, connectFamily);
    remote.setNoDelay(true);
    remote.setKeepAlive(true, remoteKeepAliveInitialDelayMs);

    const connectTimeoutTimer = setTimeout(() => {
      stats.remoteConnectTimeoutTotal += 1;
      markServerError('retryable');
      markCircuitFailure(connectTargetKey, 'connect_timeout');
      logger.warn(`remote connect timeout, trace_id=${traceId}, stream=${streamId}, target=${host}:${port}, mode=${reqPath}, err_class=retryable`);
      remote.destroy(new Error('connect timeout'));
    }, remoteConnectTimeoutMs);

    let responded = false;
    remote.once('connect', () => {
      releaseConnectInflight();
      clearTimeout(connectTimeoutTimer);
      responded = true;
      markCircuitSuccess(connectTargetKey);
      remoteConnectedAtMs = Date.now();
      stats.remoteConnectSuccessTotal += 1;
      if (logger.enabled('INFO')) {
        logger.info(`remote connected, trace_id=${traceId}, stream=${streamId}, target=${host}:${port}`);
      }
      const connectMs = remoteConnectedAtMs - acceptedAtMs;
      if (connectMs >= establishWarnThresholdMs) {
        recordSlowEstablish('connect', host, port, 0, connectMs);
      }
      if (!establishWarnLogged && connectMs >= establishWarnThresholdMs && shouldEmitSlowWarn('connect', host, port)) {
        establishWarnLogged = true;
        logger.warn(
          `slow establish connect, trace_id=${traceId}, stream=${streamId}, peer=${remotePeer}, target=${host}:${port}, connect_ms=${connectMs}, threshold_ms=${establishWarnThresholdMs}`
        );
      }
      if (remoteIdleTimeoutMs > 0) {
        remote.setTimeout(remoteIdleTimeoutMs, () => {
          stats.remoteIdleTimeoutTotal += 1;
          markServerError('retryable');
          logger.warn(`remote idle timeout, trace_id=${traceId}, stream=${streamId}, target=${host}:${port}, mode=${reqPath}, err_class=retryable`);
          remote.destroy(new Error('idle timeout'));
        });
      }
      stream.respond({ ':status': 200 });
    });

    if (streamIdleTimeoutMs > 0) {
      stream.setTimeout(streamIdleTimeoutMs, () => {
        logger.warn(`stream idle timeout, trace_id=${traceId}, stream=${streamId}, target=${host}:${port}`);
        stream.close();
      });
    }

    stream.on('data', (chunk) => {
      markActiveFast();
      const ok = remote.write(chunk);
      if (!ok) stream.pause();
      if (remote.writableLength > maxBufferedBytes) {
        stats.bufferOverflowTotal += 1;
        logger.warn(`remote buffer overflow, trace_id=${traceId}, stream=${streamId}, bytes=${remote.writableLength}, limit=${maxBufferedBytes}`);
        closeBoth();
      }
    });
    remote.on('drain', () => stream.resume());

    remote.on('data', (chunk) => {
      if (firstRemoteDataAtMs === 0) {
        firstRemoteDataAtMs = Date.now();
        const ttfbMs = firstRemoteDataAtMs - acceptedAtMs;
        const connectMs = remoteConnectedAtMs > 0 ? remoteConnectedAtMs - acceptedAtMs : -1;
        if (ttfbMs >= establishWarnThresholdMs) {
          recordSlowEstablish('first_byte', host, port, ttfbMs, connectMs);
        }
        if (!establishWarnLogged && ttfbMs >= establishWarnThresholdMs && shouldEmitSlowWarn('first_byte', host, port)) {
          establishWarnLogged = true;
          logger.warn(
            `slow establish first_byte, trace_id=${traceId}, stream=${streamId}, peer=${remotePeer}, target=${host}:${port}, ttfb_ms=${ttfbMs}, connect_ms=${connectMs}, threshold_ms=${establishWarnThresholdMs}`
          );
        }
      }
      markActiveFast();
      const ok = stream.write(chunk);
      if (!ok) remote.pause();
      if (stream.writableLength > maxBufferedBytes) {
        stats.bufferOverflowTotal += 1;
        logger.warn(`stream buffer overflow, trace_id=${traceId}, stream=${streamId}, bytes=${stream.writableLength}, limit=${maxBufferedBytes}`);
        closeBoth();
      }
    });
    stream.on('drain', () => remote.resume());

    const closeBoth = () => {
      clearTimeout(connectTimeoutTimer);
      if (!remote.destroyed) remote.destroy();
      if (!stream.destroyed) stream.close();
    };

    stream.on('end', () => {
      if (!remote.destroyed) remote.end();
    });
    remote.on('end', () => {
      if (!stream.destroyed) stream.end();
    });
    stream.on('error', closeBoth);
    remote.on('error', () => {
      releaseConnectInflight();
      stats.remoteConnectErrorTotal += 1;
      markServerError('retryable');
      if (!responded) {
        markCircuitFailure(connectTargetKey, 'connect_error');
      }
      if (shouldEmitRemoteErrorLog(host, port)) {
        logger.error(`remote connection error, trace_id=${traceId}, stream=${streamId}, target=${host}:${port}, mode=${reqPath}, err_class=retryable`);
      }
      if (!responded && !stream.destroyed) {
        stream.respond({ ':status': 502 });
        stream.end();
      }
      closeBoth();
    });
    stream.on('close', () => {
      if (stats.activeStreams > 0) stats.activeStreams -= 1;
      markUserConnectionClose(authUser);
      releaseLeaseOnce();
      if (!remote.destroyed) remote.destroy();
    });
    remote.on('close', () => {
      releaseConnectInflight();
      if (logger.enabled('INFO')) {
        logger.info(`remote closed, trace_id=${traceId}, stream=${streamId}, target=${host}:${port}`);
      }
      if (!stream.destroyed) stream.end();
    });
  } catch (e) {
    stats.targetParseFailTotal += 1;
    const errClass = classifyServerError(e, 'non-retryable');
    markServerError(errClass);
    logger.error(`bad request on stream, trace_id=${traceId}, peer=${remotePeer}, stream=${streamId}, err_class=${errClass}`, e.message);
    stream.respond({ ':status': 400 });
    stream.end();
    releaseLeaseOnce();
    if (stats.activeStreams > 0) stats.activeStreams -= 1;
  }
});

server.listen(cfg.listenPort, cfg.listenHost, listenBacklog, () => {
  logger.info(`H2 server listening on ${cfg.listenHost}:${cfg.listenPort}`);
  logger.info(`log level=${logger.level}`);
  logger.info(`listen backlog=${listenBacklog}`);
  logger.info(
    `h2 settings header_table_size=${h2HeaderTableSize} initial_window_size=${h2InitialWindowSize} max_concurrent_streams=${h2MaxConcurrentStreams} max_frame_size=${h2MaxFrameSize} max_header_list_size=${h2MaxHeaderListSize}`
  );
  logger.info(
    `h2 session socket no_delay=${h2SessionNoDelay} keep_alive=${h2SessionKeepAlive} keep_alive_initial_delay_ms=${h2SessionKeepAliveInitialDelayMs} supported=${h2SessionSocketTuneSupported}`
  );
  logger.info('proxy routes v1=/proxy');
  logger.info(`user runtime tracking enabled=${userRuntimeTrackingEnabled}`);
  logger.info(`slow establish enabled=${slowEstablishEnabled} threshold_ms=${establishWarnThresholdMs} min_interval_ms=${establishWarnMinIntervalMs} top_n=${slowEstablishTopN}`);
  logger.info(`remote error log min interval ms=${remoteErrorLogMinIntervalMs}`);
  logger.info(`remote connect max in flight=${remoteConnectMaxInFlight}`);
  logger.info(`remote connect max in flight per host=${remoteConnectMaxInFlightPerHost}`);
  logger.info(`remote connect overload wait ms=${remoteConnectOverloadWaitMs} max_waiters=${remoteConnectOverloadMaxWaiters}`);
  logger.info(`remote connect overload log min interval ms=${remoteConnectOverloadLogMinIntervalMs}`);
  logger.info(
    `remote dns cache enabled=${remoteDnsCacheEnabled} ttl_ms=${remoteDnsCacheTtlMs} negative_ttl_ms=${remoteDnsNegativeCacheTtlMs} max_entries=${remoteDnsCacheMaxEntries}`
  );
  logger.info(
    `remote circuit enabled=${remoteCircuitEnabled} failure_threshold=${remoteCircuitFailureThreshold} open_ms=${remoteCircuitOpenMs} log_min_interval_ms=${remoteCircuitLogMinIntervalMs} max_targets=${remoteCircuitMaxTargets}`
  );
  logger.info(
    `remote auto select family enabled=${remoteAutoSelectFamily} attempt_timeout_ms=${remoteAutoSelectFamilyAttemptTimeoutMs}`
  );
  logger.info(`device limit default_max_devices=${defaultMaxDevices} lease_ttl_ms=${deviceLeaseTtlMs} policy=${deviceLimitPolicy}`);
  if (userStore.enabled) {
    logger.info(`multi-user auth enabled, users_file=${usersFilePath}`);
  }
  logger.info(`static auth tokens enabled, count=${staticAuthTokens.length}`);
  startAdminServer({ cfg, userStore, logger, getUserRuntimeStats });
});

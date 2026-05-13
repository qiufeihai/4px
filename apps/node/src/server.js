const fs = require('fs');
const os = require('os');
const dns = require('dns');
const net = require('net');
const path = require('path');
const http2 = require('http2');
const { fork } = require('child_process');
const { monitorEventLoopDelay } = require('perf_hooks');
const crypto = require('crypto');
const { loadConfig, resolvePath } = require('./config');
const { createLogger, getRecentLogs } = require('./logger');
const { UserStore } = require('./user_store');
const { createDeviceLeaseStore } = require('./device_lease_store');

const cfg = loadConfig(path.resolve(__dirname, '../config/server.json'));
const key = fs.readFileSync(resolvePath(cfg.__configDir, cfg.tls.keyFile));
const cert = fs.readFileSync(resolvePath(cfg.__configDir, cfg.tls.certFile));
const logger = createLogger('server', cfg.logLevel);
const remoteConnectTimeoutMs = cfg.remoteConnectTimeoutMs || cfg.connectTimeoutMs || 10000;
const remoteIdleTimeoutMs = Number.isFinite(Number(cfg.remoteIdleTimeoutMs)) ? Number(cfg.remoteIdleTimeoutMs) : 300000;
const remoteKeepAliveInitialDelayMs = cfg.remoteKeepAliveInitialDelayMs || 30000;
const remoteAutoSelectFamilyAttemptTimeoutMs = 300;
const streamIdleTimeoutMs = Number.isFinite(Number(cfg.streamIdleTimeoutMs)) ? Number(cfg.streamIdleTimeoutMs) : 300000;
const maxBufferedBytes = cfg.maxBufferedBytes || 4 * 1024 * 1024;
const metricsIntervalMs = cfg.metricsIntervalMs || 60000;
const listenBacklog = cfg.listenBacklog || 4096;
const remoteConnectMaxInFlight = Math.max(1, Math.floor(Number(cfg.remoteConnectMaxInFlight || 4096)));
const remoteConnectMaxInFlightPerHost = Math.max(0, Math.floor(Number(cfg.remoteConnectMaxInFlightPerHost || 1024)));
const remoteConnectOverloadLogMinIntervalMs = Math.max(0, Number(cfg.remoteConnectOverloadLogMinIntervalMs || 3000));
const remoteConnectOverloadWaitMs = Math.max(0, Math.floor(Number(cfg.remoteConnectOverloadWaitMs || 20)));
const remoteConnectOverloadMaxWaiters = Math.max(0, Math.floor(Number(cfg.remoteConnectOverloadMaxWaiters || 1024)));
const remoteDnsCacheTtlMs = Math.max(1000, Math.floor(Number(cfg.remoteDnsCacheTtlMs || 60000)));
const remoteDnsNegativeCacheTtlMs = Math.max(200, Math.floor(Number(cfg.remoteDnsNegativeCacheTtlMs || 5000)));
const remoteDnsCacheMaxEntries = Math.max(64, Math.floor(Number(cfg.remoteDnsCacheMaxEntries || 4096)));
const remoteCircuitFailureThreshold = Math.max(1, Math.floor(Number(cfg.remoteCircuitFailureThreshold || 8)));
const remoteCircuitOpenMs = Math.max(1000, Math.floor(Number(cfg.remoteCircuitOpenMs || 15000)));
const remoteCircuitLogMinIntervalMs = Math.max(0, Math.floor(Number(cfg.remoteCircuitLogMinIntervalMs || 3000)));
const remoteCircuitMaxTargets = Math.max(64, Math.floor(Number(cfg.remoteCircuitMaxTargets || 4096)));
const establishWarnThresholdMs = Math.max(200, Number(cfg.establishWarnThresholdMs || 1500));
const slowEstablishEnabled = cfg.slowEstablishEnabled === true;
const slowEstablishTopN = Math.max(1, Math.floor(Number(cfg.slowEstablishTopN || 5)));
const slowEstablishSummaryIntervalMs = Math.max(
  metricsIntervalMs,
  Math.floor(Number(cfg.slowEstablishSummaryIntervalMs || Math.max(metricsIntervalMs * 2, 120000)))
);
const remoteErrorLogMinIntervalMs = Math.max(0, Number(cfg.remoteErrorLogMinIntervalMs || 3000));
const h2HeaderTableSize = Number(cfg.h2HeaderTableSize || 4096);
const h2InitialWindowSize = Number(cfg.h2InitialWindowSize || 1024 * 1024);
const h2MaxConcurrentStreams = Number(cfg.h2MaxConcurrentStreams || 1024);
const h2MaxFrameSize = Number(cfg.h2MaxFrameSize || 64 * 1024);
const h2MaxHeaderListSize = Number(cfg.h2MaxHeaderListSize || 64 * 1024);
const h2EnableConnectProtocol = false;
const h2SessionKeepAliveInitialDelayMs = 30000;
const defaultMaxDevices = Math.max(1, Math.floor(Number(cfg.defaultMaxDevices || 1)));
const deviceLeaseTtlMs = Math.max(5000, Math.floor(Number(cfg.deviceLeaseTtlMs || 90000)));
const deviceLimitPolicy = String(cfg.deviceLimitPolicy || 'reject').trim().toLowerCase() === 'kick_oldest' ? 'kick_oldest' : 'reject';
const deviceTicketCfg = cfg.deviceTicket && typeof cfg.deviceTicket === 'object' ? cfg.deviceTicket : {};
const deviceIdHeader = 'x-device-id';
const deviceTicketHeader = 'x-device-ticket';
const deviceTicketSecret = String(deviceTicketCfg.secret || '').trim();
const deviceTicketTtlMs = Math.max(
  60000,
  Math.floor(Number(deviceTicketCfg.ttlMs || Math.max(deviceLeaseTtlMs * 4, 300000)))
);
const deviceLeaseStoreCfg = cfg.deviceLeaseStore && typeof cfg.deviceLeaseStore === 'object' ? cfg.deviceLeaseStore : {};
const deviceLeaseStoreMode = String(
  deviceLeaseStoreCfg.mode || (deviceLeaseStoreCfg.redis && deviceLeaseStoreCfg.redis.enabled === true ? 'redis' : 'memory')
).trim().toLowerCase() === 'redis'
  ? 'redis'
  : 'memory';
const deviceLeaseTouchMinIntervalMs = Math.max(
  0,
  Math.floor(Number(cfg.deviceLeaseTouchMinIntervalMs || (deviceLeaseStoreMode === 'redis' ? 5000 : 0)))
);
const camouflageRateLimitCfg = cfg.camouflageRateLimit && typeof cfg.camouflageRateLimit === 'object'
  ? cfg.camouflageRateLimit
  : {};
const camouflageRateLimitWindowMs = Math.max(1000, Math.floor(Number(camouflageRateLimitCfg.windowMs || 10000)));
const camouflageRateLimitMaxRequests = Math.max(1, Math.floor(Number(camouflageRateLimitCfg.maxRequests || 30)));
const adminCfg = cfg.admin && typeof cfg.admin === 'object' ? cfg.admin : {};
const metricsReporterCfg = cfg.metricsReporter && typeof cfg.metricsReporter === 'object' ? cfg.metricsReporter : {};
const metricsReporterEnabled = metricsReporterCfg.enabled === true;
const runningInClusterWorker = Boolean(process.env.NODE_UNIQUE_ID);
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
let deviceLeaseStore = null;
let deviceLeaseStoreResolvedMode = 'memory';
let closeDeviceLeaseStore = async () => {};
let adminChild = null;
let metricsReporterChild = null;
const recentDeviceLeaseTouchAt = new Map();
const camouflageRateLimitState = new Map();
const slowEstablishSummary = new Map();
const remoteErrorLastLogAt = new Map();
let remoteAutoSelectFamilyRuntimeEnabled = true;
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
  const length = entry.addresses.length;
  const startIndex = entry.nextIndex % length;
  for (let i = 0; i < length; i += 1) {
    const index = (startIndex + i) % length;
    const candidate = entry.addresses[index];
    if (candidate && candidate.family === 4) {
      entry.nextIndex = (index + 1) % length;
      stats.remoteDnsPreferIpv4PickTotal += 1;
      return candidate;
    }
  }
  const selected = entry.addresses[startIndex];
  entry.nextIndex = (startIndex + 1) % length;
  return selected;
}

async function resolveRemoteAddress(host) {
  const normalizedHost = String(host || '').trim();
  if (!normalizedHost) {
    throw new Error('empty target host');
  }
  const ipFamily = net.isIP(normalizedHost);
  if (ipFamily > 0 || remoteAutoSelectFamilyRuntimeEnabled) {
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
  const state = remoteCircuitState.get(key);
  if (!state) return;
  if (state.failures === 0 && state.openUntilMs === 0) return;
  state.failures = 0;
  state.openUntilMs = 0;
}

function markCircuitFailure(key) {
  const state = getOrCreateCircuitState(key);
  state.failures += 1;
  if (state.failures < remoteCircuitFailureThreshold) {
    return;
  }
  state.failures = 0;
  state.openUntilMs = Date.now() + remoteCircuitOpenMs;
  stats.remoteCircuitOpenTotal += 1;
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
  remoteDnsPreferIpv4PickTotal: 0,
  remoteCircuitRejectTotal: 0,
  remoteCircuitOpenTotal: 0,
  remoteIdleTimeoutTotal: 0,
  bufferOverflowTotal: 0,
  retryableErrorTotal: 0,
  nonRetryableErrorTotal: 0
};
const loopDelay = monitorEventLoopDelay({ resolution: 20 });
loopDelay.enable();

function formatMetricsLine(snapshot) {
  return `metrics stream_total=${snapshot.streamTotal} active_streams=${snapshot.activeStreams} route_reject=${snapshot.routeRejectedTotal} auth_reject=${snapshot.authRejectedTotal} target_parse_fail=${snapshot.targetParseFailTotal} remote_ok=${snapshot.remoteConnectSuccessTotal} remote_error=${snapshot.remoteConnectErrorTotal} remote_connect_timeout=${snapshot.remoteConnectTimeoutTotal} remote_connect_overload_reject=${snapshot.remoteConnectOverloadRejectTotal} remote_connect_overload_reject_by_host=${snapshot.remoteConnectOverloadRejectByHostTotal} remote_connect_overload_wait_total=${snapshot.remoteConnectOverloadWaitTotal} remote_connect_overload_waiters=${snapshot.remoteConnectOverloadWaiters} remote_dns_cache_hit=${snapshot.remoteDnsCacheHitTotal} remote_dns_cache_miss=${snapshot.remoteDnsCacheMissTotal} remote_dns_negative_cache_hit=${snapshot.remoteDnsNegativeCacheHitTotal} remote_dns_resolve_error=${snapshot.remoteDnsResolveErrorTotal} remote_dns_prefer_ipv4_pick=${snapshot.remoteDnsPreferIpv4PickTotal} remote_dns_cache_size=${snapshot.remoteDnsCacheSize} remote_circuit_reject=${snapshot.remoteCircuitRejectTotal} remote_circuit_open_total=${snapshot.remoteCircuitOpenTotal} remote_circuit_targets=${snapshot.remoteCircuitTargets} remote_connect_inflight=${snapshot.remoteConnectInFlight} remote_connect_inflight_peak=${snapshot.remoteConnectInFlightPeak} remote_connect_inflight_host_peak=${snapshot.remoteConnectInFlightHostPeak} remote_idle_timeout=${snapshot.remoteIdleTimeoutTotal} buffer_overflow=${snapshot.bufferOverflowTotal} retryable_err=${snapshot.retryableErrorTotal} non_retryable_err=${snapshot.nonRetryableErrorTotal} eventloop_p95_ms=${snapshot.eventLoopP95Ms}`;
}

function formatDnsSummaryLine(summary) {
  return `dns summary interval_ms=${summary.intervalMs} lookups=${summary.totalLookups} hit=${summary.hitDelta} miss=${summary.missDelta} negative_hit=${summary.negativeHitDelta} resolve_error=${summary.resolveErrorDelta} hit_rate_pct=${summary.cacheHitRate} negative_share_pct=${summary.negativeShare}`;
}

function formatSlowSummaryLine(items, totalItems) {
  const summaryText = items
    .map((v) => `${v.kind}:${v.host}:${v.port}#${v.count}(ttfb_max=${v.ttfbMaxMs},connect_max=${v.connectMaxMs})`)
    .join(', ');
  return `slow establish summary top=${items.length}/${totalItems}, ${summaryText}`;
}

function isCamouflageRateLimited(remoteIp) {
  const ip = normalizeRemoteIp(remoteIp);
  const now = Date.now();
  const current = camouflageRateLimitState.get(ip);
  if (!current || now - Number(current.windowStartMs || 0) >= camouflageRateLimitWindowMs) {
    camouflageRateLimitState.set(ip, {
      windowStartMs: now,
      count: 1
    });
    return false;
  }
  if (Number(current.count || 0) >= camouflageRateLimitMaxRequests) {
    return true;
  }
  current.count = Number(current.count || 0) + 1;
  return false;
}

function sendMetricsReporterMessage(type, payload) {
  if (!metricsReporterEnabled) return false;
  if (runningInClusterWorker && typeof process.send === 'function') {
    try {
      process.send({ type: 'metrics_report', kind: type, payload });
      return true;
    } catch (err) {
      return false;
    }
  }
  if (!metricsReporterChild || !metricsReporterChild.connected || typeof metricsReporterChild.send !== 'function') {
    return false;
  }
  try {
    metricsReporterChild.send({ type, payload });
    return true;
  } catch (err) {
    if (logger.enabled('DEBUG')) {
      logger.debug(`metrics reporter send failed: ${String((err && (err.code || err.message)) || err)}`);
    }
    return false;
  }
}

function snapshotCpuTimes() {
  const cpus = os.cpus() || [];
  let idle = 0;
  let total = 0;
  cpus.forEach((cpu) => {
    const times = cpu.times || {};
    const user = Number(times.user || 0);
    const nice = Number(times.nice || 0);
    const sys = Number(times.sys || 0);
    const irq = Number(times.irq || 0);
    const idleTime = Number(times.idle || 0);
    idle += idleTime;
    total += user + nice + sys + irq + idleTime;
  });
  return { idle, total };
}

function formatBytes(n) {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = n;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(unitIndex === 0 ? 0 : 2)} ${units[unitIndex]}`;
}

function safePercent(numerator, denominator) {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) return 0;
  return Number(((numerator / denominator) * 100).toFixed(2));
}

let lastResourceCpu = snapshotCpuTimes();
let lastResourceProcCpuUsage = process.cpuUsage();
let lastResourceProcSampleAt = Date.now();

function buildSystemResourcesSnapshot() {
  const currentCpu = snapshotCpuTimes();
  const totalDelta = currentCpu.total - lastResourceCpu.total;
  const idleDelta = currentCpu.idle - lastResourceCpu.idle;
  lastResourceCpu = currentCpu;
  const cpuUsagePercent = totalDelta > 0 ? Math.max(0, Math.min(100, (1 - idleDelta / totalDelta) * 100)) : 0;
  const now = Date.now();
  const elapsedMs = Math.max(1, now - lastResourceProcSampleAt);
  const procCpuUsage = process.cpuUsage();
  const procCpuDelta = process.cpuUsage(lastResourceProcCpuUsage);
  const procCpuMicros = Number(procCpuDelta.user || 0) + Number(procCpuDelta.system || 0);
  const cpuCores = (os.cpus() || []).length || 1;
  const processCpuPercentHost = Math.max(
    0,
    Math.min(100, Number(((procCpuMicros / 1000) / (elapsedMs * cpuCores) * 100).toFixed(2)))
  );
  lastResourceProcCpuUsage = procCpuUsage;
  lastResourceProcSampleAt = now;
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = totalMem - freeMem;
  const processMem = process.memoryUsage();
  const processMemRssPercentOfTotal = safePercent(processMem.rss, totalMem);
  const processMemRssPercentOfUsed = safePercent(processMem.rss, usedMem);
  return {
    osType: os.type(),
    osRelease: os.release(),
    cpuCores,
    cpuUsagePercent: Number(cpuUsagePercent.toFixed(2)),
    loadAvg1m: Number((os.loadavg()[0] || 0).toFixed(2)),
    memory: {
      totalBytes: totalMem,
      usedBytes: usedMem,
      freeBytes: freeMem,
      usagePercent: totalMem > 0 ? Number(((usedMem / totalMem) * 100).toFixed(2)) : 0,
      totalText: formatBytes(totalMem),
      usedText: formatBytes(usedMem),
      freeText: formatBytes(freeMem)
    },
    process: {
      pid: process.pid,
      uptimeSec: Math.floor(process.uptime()),
      cpuPercentOfHost: processCpuPercentHost,
      rssBytes: processMem.rss,
      heapUsedBytes: processMem.heapUsed,
      rssPercentOfTotalMem: processMemRssPercentOfTotal,
      rssPercentOfUsedMem: processMemRssPercentOfUsed,
      rssText: formatBytes(processMem.rss),
      heapUsedText: formatBytes(processMem.heapUsed)
    }
  };
}

setInterval(() => {
  const metricsSnapshot = {
    streamTotal: stats.streamTotal,
    activeStreams: stats.activeStreams,
    routeRejectedTotal: stats.routeRejectedTotal,
    authRejectedTotal: stats.authRejectedTotal,
    targetParseFailTotal: stats.targetParseFailTotal,
    remoteConnectSuccessTotal: stats.remoteConnectSuccessTotal,
    remoteConnectErrorTotal: stats.remoteConnectErrorTotal,
    remoteConnectTimeoutTotal: stats.remoteConnectTimeoutTotal,
    remoteConnectOverloadRejectTotal: stats.remoteConnectOverloadRejectTotal,
    remoteConnectOverloadRejectByHostTotal: stats.remoteConnectOverloadRejectByHostTotal,
    remoteConnectOverloadWaitTotal: stats.remoteConnectOverloadWaitTotal,
    remoteConnectOverloadWaiters: remoteConnectOverloadWaiters,
    remoteDnsCacheHitTotal: stats.remoteDnsCacheHitTotal,
    remoteDnsCacheMissTotal: stats.remoteDnsCacheMissTotal,
    remoteDnsNegativeCacheHitTotal: stats.remoteDnsNegativeCacheHitTotal,
    remoteDnsResolveErrorTotal: stats.remoteDnsResolveErrorTotal,
    remoteDnsPreferIpv4PickTotal: stats.remoteDnsPreferIpv4PickTotal,
    remoteDnsCacheSize: remoteDnsCache.size,
    remoteCircuitRejectTotal: stats.remoteCircuitRejectTotal,
    remoteCircuitOpenTotal: stats.remoteCircuitOpenTotal,
    remoteCircuitTargets: remoteCircuitState.size,
    remoteConnectInFlight: remoteConnectInFlight,
    remoteConnectInFlightPeak: remoteConnectInFlightPeak,
    remoteConnectInFlightHostPeak: remoteConnectInFlightPerHostPeak,
    remoteIdleTimeoutTotal: stats.remoteIdleTimeoutTotal,
    bufferOverflowTotal: stats.bufferOverflowTotal,
    retryableErrorTotal: stats.retryableErrorTotal,
    nonRetryableErrorTotal: stats.nonRetryableErrorTotal,
    eventLoopP95Ms: (loopDelay.percentile(95) / 1e6).toFixed(2)
  };
  if (!sendMetricsReporterMessage('metrics_snapshot', metricsSnapshot)) {
    logger.info(formatMetricsLine(metricsSnapshot));
  }
  const hitDelta = Math.max(0, stats.remoteDnsCacheHitTotal - dnsSummaryLast.hit);
  const missDelta = Math.max(0, stats.remoteDnsCacheMissTotal - dnsSummaryLast.miss);
  const negativeHitDelta = Math.max(0, stats.remoteDnsNegativeCacheHitTotal - dnsSummaryLast.negativeHit);
  const resolveErrorDelta = Math.max(0, stats.remoteDnsResolveErrorTotal - dnsSummaryLast.resolveError);
  const totalLookups = hitDelta + missDelta + negativeHitDelta;
  const cacheHitRate = totalLookups > 0 ? (((hitDelta + negativeHitDelta) / totalLookups) * 100).toFixed(1) : '0.0';
  const negativeShare = totalLookups > 0 ? ((negativeHitDelta / totalLookups) * 100).toFixed(1) : '0.0';
  const dnsSummary = {
    intervalMs: metricsIntervalMs,
    totalLookups,
    hitDelta,
    missDelta,
    negativeHitDelta,
    resolveErrorDelta,
    cacheHitRate,
    negativeShare
  };
  if (!sendMetricsReporterMessage('dns_summary', dnsSummary)) {
    logger.info(formatDnsSummaryLine(dnsSummary));
  }
  dnsSummaryLast.hit = stats.remoteDnsCacheHitTotal;
  dnsSummaryLast.miss = stats.remoteDnsCacheMissTotal;
  dnsSummaryLast.negativeHit = stats.remoteDnsNegativeCacheHitTotal;
  dnsSummaryLast.resolveError = stats.remoteDnsResolveErrorTotal;
  remoteConnectInFlightPeak = remoteConnectInFlight;
  if (remoteConnectMaxInFlightPerHost > 0) {
    remoteConnectInFlightPerHostPeak = 0;
  }
  if (recentDeviceLeaseTouchAt.size > 0) {
    const expireBefore = Date.now() - Math.max(deviceLeaseTtlMs, deviceLeaseTouchMinIntervalMs);
    for (const [k, touchedAt] of recentDeviceLeaseTouchAt.entries()) {
      if (Number(touchedAt || 0) <= expireBefore) {
        recentDeviceLeaseTouchAt.delete(k);
      }
    }
  }
  if (camouflageRateLimitState.size > 0) {
    const expireBefore = Date.now() - camouflageRateLimitWindowMs;
    for (const [ip, state] of camouflageRateLimitState.entries()) {
      if (Number(state && state.windowStartMs ? state.windowStartMs : 0) <= expireBefore) {
        camouflageRateLimitState.delete(ip);
      }
    }
  }
  loopDelay.reset();
}, metricsIntervalMs).unref();

setInterval(() => {
  if (!slowEstablishEnabled) return;
  if (slowEstablishSummary.size === 0) return;
  const sourceItems = Array.from(slowEstablishSummary.values());
  const totalItems = sourceItems.length;
  if (!sendMetricsReporterMessage('slow_summary', { topN: slowEstablishTopN, items: sourceItems })) {
    const items = sourceItems
      .sort((a, b) => {
        if (b.ttfbMaxMs !== a.ttfbMaxMs) return b.ttfbMaxMs - a.ttfbMaxMs;
        return b.count - a.count;
      })
      .slice(0, slowEstablishTopN);
    logger.warn(formatSlowSummaryLine(items, totalItems));
  }
  slowEstablishSummary.clear();
}, slowEstablishSummaryIntervalMs).unref();

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

function normalizeRemoteIp(value) {
  const ip = String(value || '').trim();
  if (!ip) return 'unknown';
  if (ip.startsWith('::ffff:')) {
    return ip.slice('::ffff:'.length);
  }
  return ip;
}

function hashText(input, length = 32) {
  return crypto.createHash('sha256').update(String(input || '')).digest('hex').slice(0, length);
}

function encodeBase64Url(value) {
  return Buffer.from(String(value || ''), 'utf8').toString('base64url');
}

function decodeBase64Url(value) {
  return Buffer.from(String(value || ''), 'base64url').toString('utf8');
}

function signDeviceTicketPayload(payloadText) {
  return crypto.createHmac('sha256', deviceTicketSecret).update(payloadText).digest('base64url');
}

function normalizeClientDeviceId(headers) {
  const raw = String(headers && headers[deviceIdHeader] ? headers[deviceIdHeader] : '').trim();
  if (!raw || raw.length > 128) return '';
  if (!/^[A-Za-z0-9._:-]+$/.test(raw)) return '';
  return raw.toLowerCase();
}

function issueDeviceTicket(userId, deviceId) {
  const nowSec = Math.floor(Date.now() / 1000);
  const expSec = nowSec + Math.max(60, Math.floor(deviceTicketTtlMs / 1000));
  const payload = {
    v: 1,
    uid: String(userId || ''),
    did: String(deviceId || ''),
    iat: nowSec,
    exp: expSec
  };
  const payloadText = JSON.stringify(payload);
  const encodedPayload = encodeBase64Url(payloadText);
  const signature = signDeviceTicketPayload(encodedPayload);
  return `${encodedPayload}.${signature}`;
}

function verifyDeviceTicket(ticketText, userId) {
  const token = String(ticketText || '').trim();
  if (!token || !deviceTicketSecret) {
    return { ok: false, reason: 'empty' };
  }
  const dot = token.lastIndexOf('.');
  if (dot <= 0 || dot >= token.length - 1) {
    return { ok: false, reason: 'format' };
  }
  const encodedPayload = token.slice(0, dot);
  const signature = token.slice(dot + 1);
  const expectedSignature = signDeviceTicketPayload(encodedPayload);
  const a = Buffer.from(signature, 'utf8');
  const b = Buffer.from(expectedSignature, 'utf8');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { ok: false, reason: 'signature' };
  }
  let payload;
  try {
    payload = JSON.parse(decodeBase64Url(encodedPayload));
  } catch (_) {
    return { ok: false, reason: 'payload_json' };
  }
  const uid = String(payload && payload.uid ? payload.uid : '');
  const did = String(payload && payload.did ? payload.did : '');
  const exp = Number(payload && payload.exp ? payload.exp : 0);
  const nowSec = Math.floor(Date.now() / 1000);
  if (!uid || !did || !Number.isFinite(exp) || exp <= nowSec) {
    return { ok: false, reason: 'expired_or_invalid' };
  }
  if (uid !== String(userId || '')) {
    return { ok: false, reason: 'user_mismatch' };
  }
  return { ok: true, deviceId: did };
}

function buildDeviceLeaseKey(deviceId) {
  const text = String(deviceId || '').trim();
  return hashText(text, 32);
}

function resolveDeviceIdentity(authUser, headers) {
  const userId = String(authUser && authUser.id ? authUser.id : '').trim();
  if (!userId) {
    return { ok: false, reason: 'empty_user_id' };
  }
  const clientDeviceId = normalizeClientDeviceId(headers);
  if (!clientDeviceId) {
    return { ok: false, reason: 'missing_device_id' };
  }
  const incomingTicket = String(headers && headers[deviceTicketHeader] ? headers[deviceTicketHeader] : '').trim();
  if (incomingTicket) {
    const verified = verifyDeviceTicket(incomingTicket, userId);
    if (verified.ok) {
      return {
        ok: true,
        source: 'ticket',
        deviceId: verified.deviceId,
        nextTicket: ''
      };
    }
    const deviceId = `client-${hashText(`client|${clientDeviceId}`, 24)}`;
    const nextTicket = issueDeviceTicket(userId, deviceId);
    return {
      ok: true,
      source: 'client_device_id',
      deviceId,
      nextTicket
    };
  }

  const deviceId = `client-${hashText(`client|${clientDeviceId}`, 24)}`;
  const nextTicket = issueDeviceTicket(userId, deviceId);
  return {
    ok: true,
    source: 'client_device_id',
    deviceId,
    nextTicket
  };
}

function calcMaxDevices(authUser) {
  const fromUser = Number(authUser && authUser.maxDevices);
  if (Number.isFinite(fromUser) && fromUser >= 1) {
    return Math.floor(fromUser);
  }
  return defaultMaxDevices;
}

function buildSessionStatus(authUser) {
  const nowMs = Date.now();
  const expireAtMs = Number(authUser && authUser.expireAtMs ? authUser.expireAtMs : 0);
  if (!Number.isFinite(expireAtMs) || expireAtMs <= 0) {
    return {
      expireAt: null,
      remainingDays: -1,
      expired: false
    };
  }
  const diffMs = expireAtMs - nowMs;
  const expired = diffMs <= 0;
  const remainingDays = expired ? 0 : Math.max(1, Math.ceil(diffMs / 86400000));
  return {
    expireAt: new Date(expireAtMs).toISOString(),
    remainingDays,
    expired
  };
}

async function touchDeviceLease(authUser, deviceKey, options = {}) {
  const uid = String(authUser && authUser.id ? authUser.id : '').trim();
  if (!uid || !deviceKey) return { ok: true, activeDevices: 0, maxDevices: calcMaxDevices(authUser) };
  const maxDevices = calcMaxDevices(authUser);
  if (!deviceLeaseStore) {
    return { ok: false, activeDevices: 0, maxDevices };
  }
  const forceStoreTouch = options.forceStoreTouch === true;
  const allowCacheBypass = options.allowCacheBypass === true;
  const now = Date.now();
  const cacheKey = `${uid}|${deviceKey}`;
  const lastTouchAt = Number(recentDeviceLeaseTouchAt.get(cacheKey) || 0);
  const canBypassWrite =
    !forceStoreTouch &&
    deviceLeaseTouchMinIntervalMs > 0 &&
    lastTouchAt > 0 &&
    now - lastTouchAt < deviceLeaseTouchMinIntervalMs &&
    (deviceLeaseStoreResolvedMode === 'redis' || allowCacheBypass);
  if (canBypassWrite) {
    return { ok: true, activeDevices: 0, maxDevices };
  }
  const result = await deviceLeaseStore.acquireLease({
    userId: uid,
    deviceKey,
    maxDevices,
    policy: deviceLimitPolicy
  });
  if (result.ok) {
    recentDeviceLeaseTouchAt.set(cacheKey, now);
  }
  return result;
}

async function releaseDeviceLease(authUser, deviceKey) {
  const uid = String(authUser && authUser.id ? authUser.id : '').trim();
  if (!uid || !deviceKey || !deviceLeaseStore) return;
  const cacheKey = `${uid}|${deviceKey}`;
  recentDeviceLeaseTouchAt.delete(cacheKey);
  try {
    await deviceLeaseStore.releaseLease({
      userId: uid,
      deviceKey
    });
  } catch (err) {
    logger.warn(
      `release device lease failed, user=${uid}, err=${String((err && err.message) || err)}`
    );
  }
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
  throw new Error('Invalid x-target-host or x-target-port');
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
    socket.setNoDelay(true);
    socket.setKeepAlive(true, h2SessionKeepAliveInitialDelayMs);
  } catch (err) {
    const code = String(err && err.code ? err.code : '');
    if (code === 'ERR_HTTP2_NO_SOCKET_MANIPULATION') {
      h2SessionSocketTuneSupported = false;
      if (!h2SessionSocketTuneWarned) {
        h2SessionSocketTuneWarned = true;
      }
      return;
    }
    if (!h2SessionSocketTuneWarned) {
      h2SessionSocketTuneWarned = true;
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
  let authUser = null;
  let deviceTicket = '';
  let deviceLeaseKey = '';
  const getAuthResponseHeaders = (statusCode, extraHeaders = {}) => {
    const headersOut = { ':status': statusCode, ...extraHeaders };
    if (deviceTicket) {
      headersOut[deviceTicketHeader] = deviceTicket;
    }
    return headersOut;
  };
  try {
    const reqMethod = String(headers[':method'] || '');
    const reqPath = String(headers[':path'] || '');
    if (reqMethod === 'GET' && reqPath === '/') {
      if (isCamouflageRateLimited(stream.session && stream.session.socket && stream.session.socket.remoteAddress)) {
        stream.respond({
          ':status': 429,
          'content-type': 'text/plain; charset=utf-8'
        });
        stream.end('Too Many Requests');
        return;
      }
      stream.respond({
        ':status': 200,
        'content-type': 'text/html; charset=utf-8'
      });
      stream.end(renderCamouflagePage());
      return;
    }
    const isProxyV1 = reqMethod === 'POST' && reqPath === '/proxy';
    const isSessionOffline = reqMethod === 'POST' && reqPath === '/session/offline';
    const isSessionStatus = reqMethod === 'GET' && reqPath === '/session/status';
    const isSessionPing = reqMethod === 'POST' && reqPath === '/session/ping';
    if (!isProxyV1 && !isSessionOffline && !isSessionStatus && !isSessionPing) {
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
    if (isSessionStatus) {
      const sessionStatus = buildSessionStatus(authUser);
      stream.respond(getAuthResponseHeaders(200, {
        'content-type': 'application/json; charset=utf-8'
      }));
      stream.end(JSON.stringify({
        ok: true,
        ...sessionStatus,
        serverTime: new Date().toISOString()
      }));
      return;
    }
    const deviceIdentity = resolveDeviceIdentity(authUser, headers);
    if (!deviceIdentity.ok) {
      stats.authRejectedTotal += 1;
      markServerError('non-retryable');
      logger.warn(
        `reject invalid device identity, trace_id=${traceId}, peer=${remotePeer}, stream=${streamId}, path=${reqPath}, user=${authUser.username}, reason=${deviceIdentity.reason}, err_class=non-retryable`
      );
      const authReason = deviceIdentity.reason === 'missing_device_id' ? 'missing_device_id' : 'invalid_device_ticket';
      stream.respond({
        ':status': 401,
        'x-auth-reason': authReason
      });
      stream.end();
      return;
    }
    deviceTicket = deviceIdentity.nextTicket || '';
    deviceLeaseKey = buildDeviceLeaseKey(deviceIdentity.deviceId);
    if (isSessionOffline) {
      await releaseDeviceLease(authUser, deviceLeaseKey);
      stream.respond(getAuthResponseHeaders(200, {
        'content-type': 'application/json; charset=utf-8'
      }));
      stream.end(JSON.stringify({ ok: true }));
      return;
    }
    const leaseResult = await touchDeviceLease(authUser, deviceLeaseKey, {
      // Keep /proxy as final gate, but avoid frequent lease writes on the hot path.
      allowCacheBypass: isProxyV1,
      // session/ping should be the primary lease refresh path.
      forceStoreTouch: isSessionPing
    });
    if (!leaseResult.ok) {
      stats.authRejectedTotal += 1;
      markServerError('non-retryable');
      logger.warn(
        `reject device limit exceeded, trace_id=${traceId}, peer=${remotePeer}, stream=${streamId}, path=${reqPath}, user=${authUser.username}, active_devices=${leaseResult.activeDevices}, max_devices=${leaseResult.maxDevices}, policy=${deviceLimitPolicy}, identity=${deviceIdentity.source}, err_class=non-retryable`
      );
      stream.respond(getAuthResponseHeaders(409, {
        'content-type': 'application/json; charset=utf-8',
        'x-auth-reason': 'device_limit_exceeded'
      }));
      stream.end(JSON.stringify({
        ok: false,
        error: 'device_limit_exceeded',
        activeDevices: leaseResult.activeDevices,
        maxDevices: leaseResult.maxDevices
      }));
      return;
    }
    if (isSessionPing) {
      stream.respond(getAuthResponseHeaders(200, {
        'content-type': 'application/json; charset=utf-8'
      }));
      stream.end(JSON.stringify({
        ok: true,
        activeDevices: leaseResult.activeDevices,
        maxDevices: leaseResult.maxDevices,
        serverTime: new Date().toISOString()
      }));
      return;
    }
    const { host, port } = parseTarget(headers);
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
      stream.respond(getAuthResponseHeaders(503));
      stream.end();
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
      stream.respond(getAuthResponseHeaders(502));
      stream.end();
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
      stream.respond(getAuthResponseHeaders(503));
      stream.end();
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
      stream.respond(getAuthResponseHeaders(503));
      stream.end();
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
    let remoteErrorSuppressed = false;
    let remoteErrorSuppressReason = '';

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
      const connectMs = remoteConnectedAtMs - acceptedAtMs;
      if (connectMs >= establishWarnThresholdMs) {
        recordSlowEstablish('connect', host, port, 0, connectMs);
      }
      if (remoteIdleTimeoutMs > 0) {
        remote.setTimeout(remoteIdleTimeoutMs, () => {
          stats.remoteIdleTimeoutTotal += 1;
          markServerError('retryable');
          logger.warn(`remote idle timeout, trace_id=${traceId}, stream=${streamId}, target=${host}:${port}, mode=${reqPath}, err_class=retryable`);
          remoteErrorSuppressed = true;
          remoteErrorSuppressReason = 'remote_idle_timeout';
          remote.destroy(new Error('idle timeout'));
        });
      }
      stream.respond(getAuthResponseHeaders(200));
    });

    if (streamIdleTimeoutMs > 0) {
      stream.setTimeout(streamIdleTimeoutMs, () => {
        stream.close();
      });
    }

    stream.on('data', (chunk) => {
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
      }
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
    remote.on('error', (err) => {
      releaseConnectInflight();
      stats.remoteConnectErrorTotal += 1;
      markServerError('retryable');
      if (!responded) {
        markCircuitFailure(connectTargetKey, 'connect_error');
      }
      if (!remoteErrorSuppressed && shouldEmitRemoteErrorLog(host, port)) {
        const errCode = String((err && err.code) || '');
        const errMsg = String((err && err.message) || '');
        const phase = responded ? 'relay' : 'connect';
        logger.error(
          `remote connection error, trace_id=${traceId}, stream=${streamId}, target=${host}:${port}, mode=${reqPath}, phase=${phase}, err_code=${errCode}, err_msg=${errMsg}, err_class=retryable`
        );
      } else if (remoteErrorSuppressed && logger.enabled('DEBUG')) {
        logger.debug(
          `remote error suppressed, trace_id=${traceId}, stream=${streamId}, target=${host}:${port}, reason=${remoteErrorSuppressReason}, err=${String(
            (err && (err.code || err.message)) || err
          )}`
        );
      }
      if (!responded && !stream.destroyed) {
        stream.respond(getAuthResponseHeaders(502));
        stream.end();
      }
      closeBoth();
    });
    stream.on('close', () => {
      if (stats.activeStreams > 0) stats.activeStreams -= 1;
      if (!remote.destroyed) remote.destroy();
    });
    remote.on('close', () => {
      releaseConnectInflight();
      if (!stream.destroyed) stream.end();
    });
  } catch (e) {
    stats.targetParseFailTotal += 1;
    const errClass = classifyServerError(e, 'non-retryable');
    markServerError(errClass);
    logger.error(`bad request on stream, trace_id=${traceId}, peer=${remotePeer}, stream=${streamId}, err_class=${errClass}`, e.message);
    stream.respond({ ':status': 400 });
    stream.end();
    if (stats.activeStreams > 0) stats.activeStreams -= 1;
  }
});

async function initDeviceLeaseStore() {
  if (deviceTicketCfg.enabled === false) {
    throw new Error('deviceTicket.enabled=false is no longer supported');
  }
  if (!deviceTicketSecret) {
    throw new Error('deviceTicket.secret is required');
  }
  const redisCfg = deviceLeaseStoreCfg.redis && typeof deviceLeaseStoreCfg.redis === 'object'
    ? deviceLeaseStoreCfg.redis
    : {};
  const initialized = await createDeviceLeaseStore({
    mode: deviceLeaseStoreMode,
    ttlMs: deviceLeaseTtlMs,
    prefix: String(deviceLeaseStoreCfg.prefix || '4px:device_lease'),
    redisUrl: redisCfg.url,
    redisPassword: redisCfg.password,
    redisDatabase: redisCfg.database,
    redisConnectTimeoutMs: redisCfg.connectTimeoutMs,
    logger
  });
  deviceLeaseStore = initialized.store;
  deviceLeaseStoreResolvedMode = initialized.mode || 'memory';
  closeDeviceLeaseStore = typeof initialized.close === 'function' ? initialized.close : async () => {};
  logger.info(
    `device lease store ready, mode=${deviceLeaseStoreResolvedMode}, ttl_ms=${deviceLeaseTtlMs}, bind_peer_ip=${deviceLeaseBindPeerIp}`
  );
}

async function bootstrap() {
  try {
    await initDeviceLeaseStore();
  } catch (err) {
    logger.error(`init device lease store failed: ${String((err && err.message) || err)}`);
    process.exit(1);
  }

  server.listen(cfg.listenPort, cfg.listenHost, listenBacklog, () => {
    logger.info(`H2 server listening on ${cfg.listenHost}:${cfg.listenPort}`);
    if (metricsReporterEnabled) {
      if (!runningInClusterWorker) {
        const cfgArgv = cfg.__configPath ? ['-c', cfg.__configPath] : [];
        metricsReporterChild = fork(path.resolve(__dirname, 'metrics_reporter.js'), cfgArgv, {
          stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
          env: process.env
        });
        metricsReporterChild.on('exit', () => {
          logger.warn('metrics reporter exited');
          metricsReporterChild = null;
        });
      }
    }
    if (adminCfg.enabled === true) {
      if (!process.env.NODE_UNIQUE_ID) {
        const cfgArgv = cfg.__configPath ? ['-c', cfg.__configPath] : [];
        adminChild = fork(path.resolve(__dirname, 'admin_entry.js'), cfgArgv, {
          stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
          env: {
            ...process.env,
            FOURPX_ADMIN_STANDALONE: '1'
          }
        });
        adminChild.on('message', async (msg) => {
          if (!msg || typeof msg !== 'object') return;
          const type = String(msg.type || '');
          const requestId = String(msg.requestId || '').trim();
          if (!requestId) return;
          if (type === 'admin_get_active_device_counts') {
            const sourceUserIds = Array.isArray(msg.userIds) ? msg.userIds : [];
            const userIds = sourceUserIds.slice(0, 5000);
            try {
              const counts = await deviceLeaseStore.getActiveDeviceCountsByUsers(userIds);
              if (adminChild && adminChild.connected) {
                adminChild.send({ type: 'admin_active_device_counts', requestId, counts });
              }
            } catch (err) {
              if (adminChild && adminChild.connected) {
                adminChild.send({
                  type: 'admin_active_device_counts',
                  requestId,
                  counts: {},
                  error: String((err && err.message) || err)
                });
              }
            }
            return;
          }
          if (type === 'admin_get_system_resources') {
            if (adminChild && adminChild.connected) {
              adminChild.send({
                type: 'admin_system_resources',
                requestId,
                resources: buildSystemResourcesSnapshot()
              });
            }
            return;
          }
          if (type === 'admin_get_system_logs') {
            const limitRaw = Number(msg.limit || 200);
            const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(1000, Math.floor(limitRaw))) : 200;
            if (adminChild && adminChild.connected) {
              adminChild.send({
                type: 'admin_system_logs',
                requestId,
                lines: getRecentLogs(limit)
              });
            }
          }
        });
        adminChild.on('exit', () => {
          logger.warn('admin process exited');
          adminChild = null;
        });
      }
    }
  });
}

process.on('SIGTERM', async () => {
  if (metricsReporterChild && !metricsReporterChild.killed) {
    metricsReporterChild.kill('SIGTERM');
  }
  if (adminChild && !adminChild.killed) {
    adminChild.kill('SIGTERM');
  }
  await closeDeviceLeaseStore();
  process.exit(0);
});

process.on('SIGINT', async () => {
  if (metricsReporterChild && !metricsReporterChild.killed) {
    metricsReporterChild.kill('SIGTERM');
  }
  if (adminChild && !adminChild.killed) {
    adminChild.kill('SIGTERM');
  }
  await closeDeviceLeaseStore();
  process.exit(0);
});

void bootstrap();

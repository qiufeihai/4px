const fs = require('fs');
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
const streamIdleTimeoutMs = Number.isFinite(Number(cfg.streamIdleTimeoutMs)) ? Number(cfg.streamIdleTimeoutMs) : 300000;
const maxBufferedBytes = cfg.maxBufferedBytes || 4 * 1024 * 1024;
const metricsIntervalMs = cfg.metricsIntervalMs || 30000;
const listenBacklog = cfg.listenBacklog || 4096;
const establishWarnThresholdMs = Math.max(200, Number(cfg.establishWarnThresholdMs || 1500));
const establishWarnMinIntervalMs = Math.max(200, Number(cfg.establishWarnMinIntervalMs || 5000));
const slowEstablishTopN = Math.max(1, Math.floor(Number(cfg.slowEstablishTopN || 5)));
const videoFirstByteTimeoutMs = Math.max(0, Number(cfg.videoFirstByteTimeoutMs || 0));
const videoFirstByteTimeoutDomains = (() => {
  const raw = cfg.videoFirstByteTimeoutDomains;
  const list = Array.isArray(raw)
    ? raw
    : (typeof raw === 'string' ? raw.split(',') : []);
  return list
    .map((v) => String(v || '').trim().toLowerCase())
    .filter((v) => v);
})();
const h2HeaderTableSize = Number(cfg.h2HeaderTableSize || 4096);
const h2InitialWindowSize = Number(cfg.h2InitialWindowSize || 1024 * 1024);
const h2MaxConcurrentStreams = Number(cfg.h2MaxConcurrentStreams || 1024);
const h2MaxFrameSize = Number(cfg.h2MaxFrameSize || 64 * 1024);
const h2MaxHeaderListSize = Number(cfg.h2MaxHeaderListSize || 64 * 1024);
const h2EnableConnectProtocol = cfg.h2EnableConnectProtocol === true;
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

function shouldEmitSlowWarn(kind, host, port) {
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

function hostMatchesDomain(host, domain) {
  const normalizedHost = String(host || '').trim().toLowerCase();
  const normalizedDomain = String(domain || '').trim().toLowerCase();
  if (!normalizedHost || !normalizedDomain) return false;
  return normalizedHost === normalizedDomain || normalizedHost.endsWith(`.${normalizedDomain}`);
}

function shouldApplyVideoFirstByteTimeout(host, port) {
  if (videoFirstByteTimeoutMs <= 0) return false;
  if (Number(port) !== 443) return false;
  if (videoFirstByteTimeoutDomains.length === 0) return false;
  return videoFirstByteTimeoutDomains.some((domain) => hostMatchesDomain(host, domain));
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
  remoteIdleTimeoutTotal: 0,
  videoFirstByteTimeoutTotal: 0,
  bufferOverflowTotal: 0,
  retryableErrorTotal: 0,
  nonRetryableErrorTotal: 0
};
const loopDelay = monitorEventLoopDelay({ resolution: 20 });
loopDelay.enable();

setInterval(() => {
  logger.info(
    `metrics stream_total=${stats.streamTotal} active_streams=${stats.activeStreams} route_reject=${stats.routeRejectedTotal} auth_reject=${stats.authRejectedTotal} target_parse_fail=${stats.targetParseFailTotal} remote_ok=${stats.remoteConnectSuccessTotal} remote_error=${stats.remoteConnectErrorTotal} remote_connect_timeout=${stats.remoteConnectTimeoutTotal} remote_idle_timeout=${stats.remoteIdleTimeoutTotal} video_first_byte_timeout=${stats.videoFirstByteTimeoutTotal} buffer_overflow=${stats.bufferOverflowTotal} retryable_err=${stats.retryableErrorTotal} non_retryable_err=${stats.nonRetryableErrorTotal} eventloop_p95_ms=${(loopDelay.percentile(95) / 1e6).toFixed(2)}`
  );
  loopDelay.reset();
}, metricsIntervalMs).unref();

setInterval(() => {
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
  const record = getUserRuntimeRecord(authUser);
  record.lastSeenAtMs = Date.now();
  pruneUserDeviceLeases(record.userId, record.lastSeenAtMs);
  record.activeDevices = userDeviceLeases.get(record.userId)?.size || 0;
}

function markUserConnectionOpen(authUser) {
  const record = getUserRuntimeRecord(authUser);
  record.activeConnections += 1;
  const now = Date.now();
  record.lastSeenAtMs = now;
  record.lastActiveAtMs = now;
}

function markUserConnectionActive(authUser) {
  const record = getUserRuntimeRecord(authUser);
  const now = Date.now();
  if (!record.lastActiveAtMs || now - record.lastActiveAtMs >= userActivityUpdateIntervalMs) {
    record.lastActiveAtMs = now;
  }
}

function markUserConnectionClose(authUser) {
  const record = getUserRuntimeRecord(authUser);
  if (record.activeConnections > 0) record.activeConnections -= 1;
  record.lastActiveAtMs = Date.now();
}

function getUserRuntimeStats() {
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

server.on('stream', (stream, headers) => {
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
    const enableVideoFirstByteTimeout = shouldApplyVideoFirstByteTimeout(host, port);
    let firstByteTimeoutTimer = null;
    const clearFirstByteTimeout = () => {
      if (firstByteTimeoutTimer) {
        clearTimeout(firstByteTimeoutTimer);
        firstByteTimeoutTimer = null;
      }
    };
    markUserConnectionOpen(authUser);
    if (logger.enabled('INFO')) {
      logger.info(`stream accepted, trace_id=${traceId}, peer=${remotePeer}, stream=${streamId}, user=${authUser.username}, target=${host}:${port}`);
    }
    const remote = net.createConnection({ host, port });
    remote.setNoDelay(true);
    remote.setKeepAlive(true, remoteKeepAliveInitialDelayMs);

    const connectTimeoutTimer = setTimeout(() => {
      stats.remoteConnectTimeoutTotal += 1;
      markServerError('retryable');
      logger.warn(`remote connect timeout, trace_id=${traceId}, stream=${streamId}, target=${host}:${port}, mode=${reqPath}, err_class=retryable`);
      remote.destroy(new Error('connect timeout'));
    }, remoteConnectTimeoutMs);

    let responded = false;
    remote.once('connect', () => {
      clearTimeout(connectTimeoutTimer);
      responded = true;
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
      if (enableVideoFirstByteTimeout) {
        firstByteTimeoutTimer = setTimeout(() => {
          if (firstRemoteDataAtMs > 0) return;
          stats.videoFirstByteTimeoutTotal += 1;
          markServerError('retryable');
          logger.warn(
            `video first_byte timeout, trace_id=${traceId}, stream=${streamId}, peer=${remotePeer}, target=${host}:${port}, timeout_ms=${videoFirstByteTimeoutMs}`
          );
          if (!remote.destroyed) remote.destroy(new Error('video first-byte timeout'));
          if (!stream.destroyed) stream.close();
        }, videoFirstByteTimeoutMs);
      }
    });

    if (streamIdleTimeoutMs > 0) {
      stream.setTimeout(streamIdleTimeoutMs, () => {
        logger.warn(`stream idle timeout, trace_id=${traceId}, stream=${streamId}, target=${host}:${port}`);
        stream.close();
      });
    }

    stream.on('data', (chunk) => {
      markUserConnectionActive(authUser);
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
        clearFirstByteTimeout();
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
      markUserConnectionActive(authUser);
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
      clearFirstByteTimeout();
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
      stats.remoteConnectErrorTotal += 1;
      markServerError('retryable');
      logger.error(`remote connection error, trace_id=${traceId}, stream=${streamId}, target=${host}:${port}, mode=${reqPath}, err_class=retryable`);
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
  logger.info('proxy routes v1=/proxy');
  logger.info(`video first-byte timeout enabled=${videoFirstByteTimeoutMs > 0} timeout_ms=${videoFirstByteTimeoutMs} domains=${videoFirstByteTimeoutDomains.join(',') || '-'}`);
  logger.info(`device limit default_max_devices=${defaultMaxDevices} lease_ttl_ms=${deviceLeaseTtlMs} policy=${deviceLimitPolicy}`);
  if (userStore.enabled) {
    logger.info(`multi-user auth enabled, users_file=${usersFilePath}`);
  }
  logger.info(`static auth tokens enabled, count=${staticAuthTokens.length}`);
  startAdminServer({ cfg, userStore, logger, getUserRuntimeStats });
});

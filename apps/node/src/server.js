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
const remoteIdleTimeoutMs = cfg.remoteIdleTimeoutMs || 0;
const remoteKeepAliveInitialDelayMs = cfg.remoteKeepAliveInitialDelayMs || 30000;
const streamIdleTimeoutMs = cfg.streamIdleTimeoutMs || 0;
const maxBufferedBytes = cfg.maxBufferedBytes || 4 * 1024 * 1024;
const metricsIntervalMs = cfg.metricsIntervalMs || 30000;
const listenBacklog = cfg.listenBacklog || 4096;
const h2HeaderTableSize = Number(cfg.h2HeaderTableSize || 4096);
const h2InitialWindowSize = Number(cfg.h2InitialWindowSize || 1024 * 1024);
const h2MaxConcurrentStreams = Number(cfg.h2MaxConcurrentStreams || 1024);
const h2MaxFrameSize = Number(cfg.h2MaxFrameSize || 64 * 1024);
const h2MaxHeaderListSize = Number(cfg.h2MaxHeaderListSize || 64 * 1024);
const h2EnableConnectProtocol = cfg.h2EnableConnectProtocol === true;
const enableProxyV2 = cfg.enableProxyV2 === true;
const userActivityUpdateIntervalMs = Math.max(1000, Number(cfg.userActivityUpdateIntervalMs || 60000));
const usersFilePath = cfg.authUsersFile ? resolvePath(cfg.__configDir, cfg.authUsersFile) : '';
const staticAuthTokens = Array.isArray(cfg.authTokens)
  ? cfg.authTokens.map((v) => String(v || '').trim()).filter((v) => v)
  : [];
const userStore = new UserStore({
  filePath: usersFilePath,
  authTokens: staticAuthTokens,
  logger,
  reloadIntervalMs: cfg.authUsersReloadIntervalMs || 5000
});
const userRuntime = new Map();

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
  bufferOverflowTotal: 0
};
const loopDelay = monitorEventLoopDelay({ resolution: 20 });
loopDelay.enable();

setInterval(() => {
  logger.info(
    `metrics stream_total=${stats.streamTotal} active_streams=${stats.activeStreams} route_reject=${stats.routeRejectedTotal} auth_reject=${stats.authRejectedTotal} target_parse_fail=${stats.targetParseFailTotal} remote_ok=${stats.remoteConnectSuccessTotal} remote_error=${stats.remoteConnectErrorTotal} remote_connect_timeout=${stats.remoteConnectTimeoutTotal} remote_idle_timeout=${stats.remoteIdleTimeoutTotal} buffer_overflow=${stats.bufferOverflowTotal} eventloop_p95_ms=${(loopDelay.percentile(95) / 1e6).toFixed(2)}`
  );
  loopDelay.reset();
}, metricsIntervalMs).unref();

function getUserRuntimeRecord(authUser) {
  const id = String(authUser && authUser.id ? authUser.id : '').trim() || 'unknown';
  if (!userRuntime.has(id)) {
    userRuntime.set(id, {
      userId: id,
      username: String(authUser && authUser.username ? authUser.username : ''),
      activeConnections: 0,
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

function markUserSeen(authUser) {
  const record = getUserRuntimeRecord(authUser);
  record.lastSeenAtMs = Date.now();
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
  const out = {};
  userRuntime.forEach((value, key) => {
    out[key] = {
      userId: value.userId,
      username: value.username,
      activeConnections: value.activeConnections,
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

function parseTargetV2(headers) {
  const host = String(headers['x-target-host'] || '').trim();
  const port = Number(headers['x-target-port']);
  if (!host || !Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error('Invalid v2 target headers');
  }
  return { host, port };
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
  const sock = session && session.socket;
  if (!sock) return;
  sock.setNoDelay(true);
  sock.setKeepAlive(true, remoteKeepAliveInitialDelayMs);
});

server.on('stream', (stream, headers) => {
  stats.streamTotal += 1;
  stats.activeStreams += 1;
  const remotePeer = `${stream.session.socket.remoteAddress || '-'}:${stream.session.socket.remotePort || '-'}`;
  const streamId = stream.id;
  try {
    const reqMethod = String(headers[':method'] || '');
    const reqPath = String(headers[':path'] || '');
    const isProxyV1 = reqMethod === 'POST' && reqPath === '/proxy';
    const isProxyV2 = reqMethod === 'POST' && reqPath === '/proxy-v2' && enableProxyV2;
    if (!isProxyV1 && !isProxyV2) {
      stats.routeRejectedTotal += 1;
      logger.warn(`reject invalid route, peer=${remotePeer}, stream=${streamId}`);
      stream.respond({ ':status': 404 });
      stream.end();
      return;
    }
    const authResult = userStore.authenticate(headers['x-auth-token']);
    if (!authResult.ok) {
      stats.authRejectedTotal += 1;
      logger.warn(`reject unauthorized request, peer=${remotePeer}, stream=${streamId}, reason=${authResult.reason}`);
      stream.respond({ ':status': 401 });
      stream.end();
      return;
    }
    const authUser = authResult.user;
    markUserSeen(authUser);

    const { host, port } = isProxyV2 ? parseTargetV2(headers) : parseTarget(headers);
    markUserConnectionOpen(authUser);
    logger.info(`stream accepted, peer=${remotePeer}, stream=${streamId}, user=${authUser.username}, target=${host}:${port}`);
    const remote = net.createConnection({ host, port });
    remote.setNoDelay(true);
    remote.setKeepAlive(true, remoteKeepAliveInitialDelayMs);

    const connectTimeoutTimer = setTimeout(() => {
      stats.remoteConnectTimeoutTotal += 1;
      logger.warn(`remote connect timeout, stream=${streamId}, target=${host}:${port}`);
      remote.destroy(new Error('connect timeout'));
    }, remoteConnectTimeoutMs);

    let responded = false;
    remote.once('connect', () => {
      clearTimeout(connectTimeoutTimer);
      responded = true;
      stats.remoteConnectSuccessTotal += 1;
      logger.info(`remote connected, stream=${streamId}, target=${host}:${port}`);
      if (remoteIdleTimeoutMs > 0) {
        remote.setTimeout(remoteIdleTimeoutMs, () => {
          stats.remoteIdleTimeoutTotal += 1;
          logger.warn(`remote idle timeout, stream=${streamId}, target=${host}:${port}`);
          remote.destroy(new Error('idle timeout'));
        });
      }
      stream.respond({ ':status': 200 });
    });

    if (streamIdleTimeoutMs > 0) {
      stream.setTimeout(streamIdleTimeoutMs, () => {
        logger.warn(`stream idle timeout, stream=${streamId}, target=${host}:${port}`);
        stream.close();
      });
    }

    stream.on('data', (chunk) => {
      markUserConnectionActive(authUser);
      const ok = remote.write(chunk);
      if (!ok) stream.pause();
      if (remote.writableLength > maxBufferedBytes) {
        stats.bufferOverflowTotal += 1;
        logger.warn(`remote buffer overflow, stream=${streamId}, bytes=${remote.writableLength}, limit=${maxBufferedBytes}`);
        closeBoth();
      }
    });
    remote.on('drain', () => stream.resume());

    remote.on('data', (chunk) => {
      markUserConnectionActive(authUser);
      const ok = stream.write(chunk);
      if (!ok) remote.pause();
      if (stream.writableLength > maxBufferedBytes) {
        stats.bufferOverflowTotal += 1;
        logger.warn(`stream buffer overflow, stream=${streamId}, bytes=${stream.writableLength}, limit=${maxBufferedBytes}`);
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
      stats.remoteConnectErrorTotal += 1;
      logger.error(`remote connection error, stream=${streamId}, target=${host}:${port}`);
      if (!responded && !stream.destroyed) {
        stream.respond({ ':status': 502 });
        stream.end();
      }
      closeBoth();
    });
    stream.on('close', () => {
      if (stats.activeStreams > 0) stats.activeStreams -= 1;
      markUserConnectionClose(authUser);
      if (!remote.destroyed) remote.destroy();
    });
    remote.on('close', () => {
      logger.info(`remote closed, stream=${streamId}, target=${host}:${port}`);
      if (!stream.destroyed) stream.end();
    });
  } catch (e) {
    stats.targetParseFailTotal += 1;
    logger.error(`bad request on stream, peer=${remotePeer}, stream=${streamId}`, e.message);
    stream.respond({ ':status': 400 });
    stream.end();
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
  logger.info(`proxy routes v1=/proxy v2=${enableProxyV2 ? '/proxy-v2(enabled)' : 'disabled'}`);
  if (userStore.enabled) {
    logger.info(`multi-user auth enabled, users_file=${usersFilePath}`);
  }
  logger.info(`static auth tokens enabled, count=${staticAuthTokens.length}`);
  startAdminServer({ cfg, userStore, logger, getUserRuntimeStats });
});

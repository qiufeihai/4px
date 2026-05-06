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
  muxChannelOpenTotal: 0,
  muxChannelActive: 0,
  muxFrameInTotal: 0,
  muxFrameOutTotal: 0,
  muxBackpressurePauseTotal: 0,
  routeRejectedTotal: 0,
  authRejectedTotal: 0,
  targetParseFailTotal: 0,
  remoteConnectSuccessTotal: 0,
  remoteConnectErrorTotal: 0,
  remoteConnectTimeoutTotal: 0,
  remoteIdleTimeoutTotal: 0,
  bufferOverflowTotal: 0,
  retryableErrorTotal: 0,
  nonRetryableErrorTotal: 0
};
const MUX_FRAME_OPEN = 1;
const MUX_FRAME_DATA = 2;
const MUX_FRAME_CLOSE = 3;
const MUX_FRAME_OPEN_RESULT = 4;
const MUX_FRAME_OPEN_ERROR = 5;
const EMPTY_BUFFER = Buffer.alloc(0);
const loopDelay = monitorEventLoopDelay({ resolution: 20 });
loopDelay.enable();

setInterval(() => {
  logger.info(
    `metrics stream_total=${stats.streamTotal} active_streams=${stats.activeStreams} mux_channel_open_total=${stats.muxChannelOpenTotal} mux_channel_active=${stats.muxChannelActive} mux_frame_in_total=${stats.muxFrameInTotal} mux_frame_out_total=${stats.muxFrameOutTotal} mux_backpressure_pause_total=${stats.muxBackpressurePauseTotal} route_reject=${stats.routeRejectedTotal} auth_reject=${stats.authRejectedTotal} target_parse_fail=${stats.targetParseFailTotal} remote_ok=${stats.remoteConnectSuccessTotal} remote_error=${stats.remoteConnectErrorTotal} remote_connect_timeout=${stats.remoteConnectTimeoutTotal} remote_idle_timeout=${stats.remoteIdleTimeoutTotal} buffer_overflow=${stats.bufferOverflowTotal} retryable_err=${stats.retryableErrorTotal} non_retryable_err=${stats.nonRetryableErrorTotal} eventloop_p95_ms=${(loopDelay.percentile(95) / 1e6).toFixed(2)}`
  );
  loopDelay.reset();
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

function parseTargetText(targetText) {
  const text = String(targetText || '').trim();
  const split = text.lastIndexOf(':');
  if (split <= 0 || split >= text.length - 1) {
    throw new Error('Invalid mux target');
  }
  let host = text.slice(0, split);
  if (host.startsWith('[') && host.endsWith(']')) {
    host = host.slice(1, -1);
  }
  const port = Number(text.slice(split + 1));
  if (!host || !Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error('Invalid mux target port');
  }
  return { host, port };
}

function muxWriteFrame(stream, frameType, streamID, payload) {
  const body = payload == null ? EMPTY_BUFFER : (Buffer.isBuffer(payload) ? payload : Buffer.from(payload));
  const header = Buffer.allocUnsafe(9);
  header.writeUInt8(frameType, 0);
  header.writeUInt32BE(streamID >>> 0, 1);
  header.writeUInt32BE(body.length >>> 0, 5);
  stats.muxFrameOutTotal += 1;
  stream.cork();
  const okHeader = stream.write(header);
  const okBody = body.length > 0 ? stream.write(body) : true;
  stream.uncork();
  return okHeader && okBody;
}

function handleProxyV2MuxStream(stream, authUser, remotePeer, streamId) {
  logger.info(`mux stream accepted, peer=${remotePeer}, stream=${streamId}, user=${authUser.username}`);
  stream.respond({ ':status': 200 });
  const remotes = new Map();
  const incomingChunks = [];
  let incomingOffset = 0;
  let incomingTotal = 0;
  let writableBlocked = false;
  const pausedRemotes = new Set();
  const outboundQueue = [];
  let outboundQueueHead = 0;
  let outboundQueuedBytes = 0;
  let flushScheduled = false;
  const MAX_INCOMING_BUFFER = Math.max(maxBufferedBytes * 2, 1024 * 1024);
  const MAX_OUTGOING_BUFFER = Math.max(maxBufferedBytes * 2, 1024 * 1024);

  const setWritableBlocked = (blocked) => {
    if (blocked) {
      if (!writableBlocked) {
        writableBlocked = true;
        stats.muxBackpressurePauseTotal += 1;
      }
      remotes.forEach((remote, rid) => {
        if (!remote.destroyed) pauseRemote(rid);
      });
      return;
    }
    writableBlocked = false;
    resumePausedRemotes();
  };

  const queueIncoming = (chunk) => {
    if (!chunk || chunk.length === 0) return;
    incomingChunks.push(chunk);
    incomingTotal += chunk.length;
  };

  const compactIncoming = () => {
    if (incomingOffset === 0) return;
    if (incomingOffset >= incomingChunks.length) {
      incomingChunks.length = 0;
      incomingOffset = 0;
      return;
    }
    incomingChunks.splice(0, incomingOffset);
    incomingOffset = 0;
  };

  const discardIncoming = (n) => {
    if (incomingTotal < n) return false;
    let remain = n;
    while (remain > 0) {
      const head = incomingChunks[incomingOffset];
      if (head.length <= remain) {
        remain -= head.length;
        incomingOffset += 1;
      } else {
        incomingChunks[incomingOffset] = head.subarray(remain);
        remain = 0;
      }
    }
    incomingTotal -= n;
    if (incomingOffset > 64 || incomingOffset >= incomingChunks.length) {
      compactIncoming();
    }
    return true;
  };

  const readIncoming = (n) => {
    if (n === 0) return EMPTY_BUFFER;
    if (incomingTotal < n) return null;
    const first = incomingChunks[incomingOffset];
    if (first.length >= n) {
      const out = first.subarray(0, n);
      if (first.length === n) {
        incomingOffset += 1;
      } else {
        incomingChunks[incomingOffset] = first.subarray(n);
      }
      incomingTotal -= n;
      if (incomingOffset > 64 || incomingOffset >= incomingChunks.length) {
        compactIncoming();
      }
      return out;
    }
    const out = Buffer.allocUnsafe(n);
    let written = 0;
    while (written < n) {
      const head = incomingChunks[incomingOffset];
      const need = n - written;
      if (head.length <= need) {
        head.copy(out, written);
        written += head.length;
        incomingOffset += 1;
      } else {
        head.copy(out, written, 0, need);
        incomingChunks[incomingOffset] = head.subarray(need);
        written += need;
      }
    }
    incomingTotal -= n;
    if (incomingOffset > 64 || incomingOffset >= incomingChunks.length) {
      compactIncoming();
    }
    return out;
  };

  const peekIncoming = (n) => {
    if (incomingTotal < n) return null;
    const first = incomingChunks[incomingOffset];
    if (first.length >= n) {
      return first.subarray(0, n);
    }
    const out = Buffer.allocUnsafe(n);
    let copied = 0;
    for (let i = incomingOffset; i < incomingChunks.length && copied < n; i += 1) {
      const chunk = incomingChunks[i];
      const need = n - copied;
      if (chunk.length <= need) {
        chunk.copy(out, copied);
        copied += chunk.length;
      } else {
        chunk.copy(out, copied, 0, need);
        copied += need;
      }
    }
    return out;
  };

  const pauseRemote = (id) => {
    const remote = remotes.get(id);
    if (!remote || remote.destroyed) return;
    remote.pause();
    pausedRemotes.add(id);
  };

  const resumePausedRemotes = () => {
    pausedRemotes.forEach((id) => {
      const remote = remotes.get(id);
      if (remote && !remote.destroyed) remote.resume();
    });
    pausedRemotes.clear();
  };

  const closeRemote = (id) => {
    const remote = remotes.get(id);
    if (!remote) return;
    if (stats.muxChannelActive > 0) stats.muxChannelActive -= 1;
    remotes.delete(id);
    pausedRemotes.delete(id);
    markUserConnectionClose(authUser);
    if (!remote.destroyed) remote.destroy();
  };

  const closeAll = () => {
    remotes.forEach((remote, id) => {
      remotes.delete(id);
      pausedRemotes.delete(id);
      markUserConnectionClose(authUser);
      if (!remote.destroyed) remote.destroy();
    });
  };

  const outboundQueueSize = () => outboundQueue.length - outboundQueueHead;

  const compactOutboundQueue = () => {
    if (outboundQueueHead === 0) return;
    if (outboundQueueHead >= outboundQueue.length) {
      outboundQueue.length = 0;
      outboundQueueHead = 0;
      return;
    }
    if (outboundQueueHead < 128 && outboundQueueHead * 2 < outboundQueue.length) return;
    outboundQueue.splice(0, outboundQueueHead);
    outboundQueueHead = 0;
  };

  const pendingOutboundBytes = () => stream.writableLength + outboundQueuedBytes;

  const sendFrame = (frameType, id, payload) => {
    if (stream.destroyed) return false;
    const body = payload == null ? EMPTY_BUFFER : (Buffer.isBuffer(payload) ? payload : Buffer.from(payload));
    const frameBytes = 9 + body.length;
    outboundQueue.push({ frameType, id, body, frameBytes });
    outboundQueuedBytes += frameBytes;
    if (pendingOutboundBytes() > MAX_OUTGOING_BUFFER) {
      stats.bufferOverflowTotal += 1;
      logger.warn(`mux stream buffer overflow, stream=${streamId}, bytes=${pendingOutboundBytes()}, limit=${MAX_OUTGOING_BUFFER}`);
      closeAll();
      if (!stream.destroyed) stream.close();
      return false;
    }
    scheduleFlush();
    return !writableBlocked;
  };

  const flushOutboundQueue = () => {
    if (stream.destroyed || outboundQueueSize() === 0) return;
    stream.cork();
    let ok = true;
    while (outboundQueueHead < outboundQueue.length) {
      const item = outboundQueue[outboundQueueHead];
      outboundQueueHead += 1;
      outboundQueuedBytes -= item.frameBytes;
      ok = muxWriteFrame(stream, item.frameType, item.id, item.body) && ok;
      if (!ok) break;
    }
    compactOutboundQueue();
    stream.uncork();
    if (!ok) {
      setWritableBlocked(true);
      return;
    }
    setWritableBlocked(false);
    if (outboundQueueSize() > 0) {
      scheduleFlush();
    }
  };

  const scheduleFlush = () => {
    if (stream.destroyed) return;
    if (flushScheduled) return;
    flushScheduled = true;
    setImmediate(() => {
      flushScheduled = false;
      flushOutboundQueue();
    });
  };

  const openRemote = (id, payload) => {
    try {
      const { host, port } = parseTargetText(payload.toString('utf8'));
      const remote = net.createConnection({ host, port });
      remotes.set(id, remote);
      markUserConnectionOpen(authUser);
      stats.muxChannelOpenTotal += 1;
      stats.muxChannelActive += 1;

      remote.setNoDelay(true);
      remote.setKeepAlive(true, remoteKeepAliveInitialDelayMs);
      if (remoteIdleTimeoutMs > 0) {
        remote.setTimeout(remoteIdleTimeoutMs, () => {
          stats.remoteIdleTimeoutTotal += 1;
          markServerError('retryable');
          logger.warn(`mux remote idle timeout, stream=${streamId}, channel=${id}, target=${host}:${port}, mode=proxy-v2, err_class=retryable`);
          closeRemote(id);
          sendFrame(MUX_FRAME_CLOSE, id, null);
        });
      }

      const connectTimeoutTimer = setTimeout(() => {
        stats.remoteConnectTimeoutTotal += 1;
        markServerError('retryable');
        logger.warn(`mux remote connect timeout, stream=${streamId}, channel=${id}, target=${host}:${port}, mode=proxy-v2, err_class=retryable`);
        closeRemote(id);
        sendFrame(MUX_FRAME_OPEN_ERROR, id, Buffer.from('connect timeout'));
      }, remoteConnectTimeoutMs);

      remote.once('connect', () => {
        clearTimeout(connectTimeoutTimer);
        stats.remoteConnectSuccessTotal += 1;
        sendFrame(MUX_FRAME_OPEN_RESULT, id, null);
      });
      remote.on('data', (chunk) => {
        markUserConnectionActive(authUser);
        if (writableBlocked) pauseRemote(id);
        const ok = sendFrame(MUX_FRAME_DATA, id, chunk);
        if (!ok) pauseRemote(id);
      });
      remote.on('drain', () => {
        if (!stream.destroyed && stream.isPaused()) stream.resume();
      });
      remote.on('close', () => {
        closeRemote(id);
        sendFrame(MUX_FRAME_CLOSE, id, null);
      });
      remote.on('error', (err) => {
        stats.remoteConnectErrorTotal += 1;
        const errClass = classifyServerError(err);
        markServerError(errClass);
        logger.warn(`mux remote error, stream=${streamId}, channel=${id}, target=${host}:${port}, mode=proxy-v2, err_class=${errClass}, err=${err.message}`);
        closeRemote(id);
        sendFrame(MUX_FRAME_CLOSE, id, null);
      });
    } catch (e) {
      sendFrame(MUX_FRAME_OPEN_ERROR, id, Buffer.from(String(e.message || e)));
    }
  };

  const onFrame = (frameType, id, payload) => {
    if (frameType === MUX_FRAME_OPEN) {
      openRemote(id, payload);
      return;
    }
    const remote = remotes.get(id);
    if (!remote) return;
    if (frameType === MUX_FRAME_DATA) {
      markUserConnectionActive(authUser);
      const ok = remote.write(payload);
      if (!ok) stream.pause();
      return;
    }
    if (frameType === MUX_FRAME_CLOSE) {
      closeRemote(id);
    }
  };

  stream.on('data', (chunk) => {
    queueIncoming(chunk);
    if (incomingTotal > MAX_INCOMING_BUFFER) {
      stats.bufferOverflowTotal += 1;
      logger.warn(`mux incoming buffer overflow, stream=${streamId}, bytes=${incomingTotal}, limit=${MAX_INCOMING_BUFFER}`);
      closeAll();
      if (!stream.destroyed) stream.close();
      return;
    }
    while (incomingTotal >= 9) {
      const header = peekIncoming(9);
      if (!header) break;
      const frameType = header.readUInt8(0);
      const id = header.readUInt32BE(1);
      const payloadLen = header.readUInt32BE(5);
      if (incomingTotal < 9 + payloadLen) {
        break;
      }
      if (!discardIncoming(9)) break;
      const payload = readIncoming(payloadLen);
      if (payloadLen > 0 && !payload) break;
      stats.muxFrameInTotal += 1;
      onFrame(frameType, id, payload);
    }
  });
  stream.on('drain', () => {
    setWritableBlocked(false);
    flushOutboundQueue();
  });

  stream.on('close', () => {
    if (stats.activeStreams > 0) stats.activeStreams -= 1;
    outboundQueue.length = 0;
    outboundQueueHead = 0;
    outboundQueuedBytes = 0;
    setWritableBlocked(false);
    closeAll();
  });
  stream.on('error', () => closeAll());
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
    const isProxyV2Mux = isProxyV2 && String(headers['x-4px-v2-mode'] || '') === 'mux';
    if (!isProxyV1 && !isProxyV2) {
      stats.routeRejectedTotal += 1;
      markServerError('non-retryable');
      logger.warn(`reject invalid route, peer=${remotePeer}, stream=${streamId}, method=${reqMethod}, path=${reqPath}, err_class=non-retryable`);
      stream.respond({ ':status': 404 });
      stream.end();
      return;
    }
    const authResult = userStore.authenticate(headers['x-auth-token']);
    if (!authResult.ok) {
      stats.authRejectedTotal += 1;
      markServerError('non-retryable');
      logger.warn(`reject unauthorized request, peer=${remotePeer}, stream=${streamId}, path=${reqPath}, reason=${authResult.reason}, err_class=non-retryable`);
      stream.respond({ ':status': 401 });
      stream.end();
      return;
    }
    const authUser = authResult.user;
    markUserSeen(authUser);
    if (isProxyV2 && String(headers['x-4px-v2'] || '') !== '1') {
      stats.routeRejectedTotal += 1;
      markServerError('non-retryable');
      logger.warn(`reject v2 handshake, peer=${remotePeer}, stream=${streamId}, path=${reqPath}, err_class=non-retryable`);
      stream.respond({ ':status': 426 });
      stream.end();
      return;
    }
    if (isProxyV2Mux) {
      handleProxyV2MuxStream(stream, authUser, remotePeer, streamId);
      return;
    }

    const { host, port } = isProxyV2 ? parseTargetV2(headers) : parseTarget(headers);
    markUserConnectionOpen(authUser);
    logger.info(`stream accepted, peer=${remotePeer}, stream=${streamId}, user=${authUser.username}, target=${host}:${port}`);
    const remote = net.createConnection({ host, port });
    remote.setNoDelay(true);
    remote.setKeepAlive(true, remoteKeepAliveInitialDelayMs);

    const connectTimeoutTimer = setTimeout(() => {
      stats.remoteConnectTimeoutTotal += 1;
      markServerError('retryable');
      logger.warn(`remote connect timeout, stream=${streamId}, target=${host}:${port}, mode=${reqPath}, err_class=retryable`);
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
          markServerError('retryable');
          logger.warn(`remote idle timeout, stream=${streamId}, target=${host}:${port}, mode=${reqPath}, err_class=retryable`);
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
      markServerError('retryable');
      logger.error(`remote connection error, stream=${streamId}, target=${host}:${port}, mode=${reqPath}, err_class=retryable`);
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
    const errClass = classifyServerError(e, 'non-retryable');
    markServerError(errClass);
    logger.error(`bad request on stream, peer=${remotePeer}, stream=${streamId}, err_class=${errClass}`, e.message);
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

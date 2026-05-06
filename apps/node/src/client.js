const fs = require('fs');
const net = require('net');
const path = require('path');
const http2 = require('http2');
const { Duplex } = require('stream');
const { monitorEventLoopDelay } = require('perf_hooks');
const { loadConfig, resolvePath } = require('./config');
const { createLogger } = require('./logger');
const { createSocks5Server } = require('./socks5');

const cfg = loadConfig(path.resolve(__dirname, '../config/client.json'));
const logger = createLogger('client', cfg.logLevel);
const upstreamConnectTimeoutMs = cfg.upstreamConnectTimeoutMs || cfg.connectTimeoutMs || 10000;
const streamResponseTimeoutMs = cfg.streamResponseTimeoutMs || cfg.requestTimeoutMs || 30000;
const streamIdleTimeoutMs = Number.isFinite(Number(cfg.streamIdleTimeoutMs)) ? Number(cfg.streamIdleTimeoutMs) : 300000;
const localSocketKeepAliveInitialDelayMs = cfg.localSocketKeepAliveInitialDelayMs || 30000;
const localSocketIdleTimeoutMs = cfg.localSocketIdleTimeoutMs || 0;
const httpListen = cfg.httpListen || '';
const httpListenBacklog = cfg.httpListenBacklog || 4096;
const maxBufferedBytes = cfg.maxBufferedBytes || 4 * 1024 * 1024;
const metricsIntervalMs = cfg.metricsIntervalMs || 30000;
const h2SessionPoolSize = Math.max(1, cfg.h2SessionPoolSize || 2);
const socksListenBacklog = cfg.socksListenBacklog || 4096;
const upstreamAuthToken = String((cfg.upstream && cfg.upstream.authToken) || '').trim();
const upstreamPathRaw = String((cfg.upstream && cfg.upstream.path) || '/proxy-v2').trim();
const upstreamPath = upstreamPathRaw.startsWith('/') ? upstreamPathRaw : `/${upstreamPathRaw}`;
const useProxyV2Headers = upstreamPath === '/proxy-v2';
const MUX_FRAME_OPEN = 1;
const MUX_FRAME_DATA = 2;
const MUX_FRAME_CLOSE = 3;
const MUX_FRAME_OPEN_RESULT = 4;
const MUX_FRAME_OPEN_ERROR = 5;

if (!upstreamAuthToken) {
  throw new Error('client config invalid: upstream.authToken is required');
}

const sessionPool = Array.from({ length: h2SessionPoolSize }, () => ({
  session: null,
  pending: null
}));
let rrIndex = 0;

const stats = {
  socksConnectTotal: 0,
  socksConnectFailed: 0,
  activeStreams: 0,
  streamOpenedTotal: 0,
  streamClosedTotal: 0,
  streamRejectedTotal: 0,
  bufferOverflowTotal: 0,
  upstreamConnectFailTotal: 0,
  upstreamConnectTimeoutTotal: 0,
  streamResponseTimeoutTotal: 0,
  streamIdleTimeoutTotal: 0
};
const muxState = {
  req: null,
  connecting: null,
  incoming: Buffer.alloc(0),
  channels: new Map(),
  nextChannelID: 1,
  writeQueue: [],
  flushScheduled: false
};

class MuxChannelStream extends Duplex {
  constructor(channelID, targetHost, targetPort) {
    super();
    this.id = `mux-${channelID}`;
    this.channelID = channelID;
    this.targetHost = targetHost;
    this.targetPort = targetPort;
    this.opened = false;
    this.openErr = null;
    // OPEN 阶段超时时 stream 可能在业务层绑定 error 监听前被销毁，避免触发进程级未捕获异常。
    this.on('error', () => {});
  }

  _read() {}

  _write(chunk, _enc, cb) {
    if (!this.opened) {
      cb(new Error('mux channel not opened'));
      return;
    }
    muxSendFrame(MUX_FRAME_DATA, this.channelID, chunk, cb);
  }

  _final(cb) {
    muxSendFrame(MUX_FRAME_CLOSE, this.channelID, Buffer.alloc(0), () => cb());
  }

  close() {
    if (this.destroyed) return;
    this.end();
  }

  _destroy(err, cb) {
    const ch = muxState.channels.get(this.channelID);
    if (ch && ch.stream === this) {
      muxState.channels.delete(this.channelID);
    }
    if (this.opened && muxState.req && !muxState.req.destroyed) {
      muxSendFrame(MUX_FRAME_CLOSE, this.channelID, Buffer.alloc(0), () => cb(err));
      return;
    }
    cb(err);
  }
}
const loopDelay = monitorEventLoopDelay({ resolution: 20 });
loopDelay.enable();

setInterval(() => {
  logger.info(
    `metrics socks_total=${stats.socksConnectTotal} socks_fail=${stats.socksConnectFailed} active_streams=${stats.activeStreams} stream_opened=${stats.streamOpenedTotal} stream_closed=${stats.streamClosedTotal} stream_rejected=${stats.streamRejectedTotal} upstream_fail=${stats.upstreamConnectFailTotal} upstream_timeout=${stats.upstreamConnectTimeoutTotal} buffer_overflow=${stats.bufferOverflowTotal} stream_resp_timeout=${stats.streamResponseTimeoutTotal} stream_idle_timeout=${stats.streamIdleTimeoutTotal} eventloop_p95_ms=${(loopDelay.percentile(95) / 1e6).toFixed(2)}`
  );
  loopDelay.reset();
}, metricsIntervalMs).unref();

function pickPoolIndex() {
  const index = rrIndex % h2SessionPoolSize;
  rrIndex += 1;
  return index;
}

function getH2Session(poolIndex) {
  const slot = sessionPool[poolIndex];
  if (slot.session && !slot.session.closed && !slot.session.destroyed) {
    return Promise.resolve(slot.session);
  }
  if (slot.pending) return slot.pending;

  slot.pending = new Promise((resolve, reject) => {
    const ca = cfg.upstream.caFile
      ? fs.readFileSync(resolvePath(cfg.__configDir, cfg.upstream.caFile))
      : undefined;

    const session = http2.connect(
      `https://${cfg.upstream.host}:${cfg.upstream.port}`,
      {
        ca,
        rejectUnauthorized: cfg.upstream.rejectUnauthorized !== false,
        servername: cfg.upstream.serverName || cfg.upstream.host,
        ALPNProtocols: ['h2'],
        minVersion: 'TLSv1.2'
      }
    );
    const connectTimeoutTimer = setTimeout(() => {
      stats.upstreamConnectTimeoutTotal += 1;
      logger.error(`upstream h2 connect timeout ${cfg.upstream.host}:${cfg.upstream.port}`);
      session.destroy(new Error('upstream connect timeout'));
    }, upstreamConnectTimeoutMs);

    session.once('connect', () => {
      clearTimeout(connectTimeoutTimer);
      slot.session = session;
      slot.pending = null;
      logger.info(`connected upstream h2 idx=${poolIndex} ${cfg.upstream.host}:${cfg.upstream.port}`);
      resolve(session);
    });
    session.once('error', (err) => {
      clearTimeout(connectTimeoutTimer);
      stats.upstreamConnectFailTotal += 1;
      slot.pending = null;
      logger.error(`failed connect upstream h2 ${cfg.upstream.host}:${cfg.upstream.port}`, err.message);
      reject(err);
    });
    session.on('close', () => {
      logger.warn(`upstream h2 session closed idx=${poolIndex}`);
      slot.session = null;
    });
    session.on('error', (err) => {
      stats.upstreamConnectFailTotal += 1;
      logger.error('upstream h2 session error', err.message);
      slot.session = null;
    });
  });

  return slot.pending;
}

function muxEncodeFrame(frameType, channelID, payload) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload || '');
  const header = Buffer.allocUnsafe(9);
  header.writeUInt8(frameType, 0);
  header.writeUInt32BE(channelID >>> 0, 1);
  header.writeUInt32BE(body.length >>> 0, 5);
  return body.length > 0 ? [header, body] : [header];
}

function muxFlushQueue() {
  const req = muxState.req;
  if (!req || req.destroyed) return;
  while (muxState.writeQueue.length > 0) {
    const item = muxState.writeQueue[0];
    const ok = req.write(item.buf);
    if (!ok) return;
    muxState.writeQueue.shift();
    if (typeof item.cb === 'function') item.cb();
  }
}

function muxScheduleFlush() {
  if (muxState.flushScheduled) return;
  muxState.flushScheduled = true;
  setImmediate(() => {
    muxState.flushScheduled = false;
    muxFlushQueue();
  });
}

function muxSendFrame(frameType, channelID, payload, cb) {
  const parts = muxEncodeFrame(frameType, channelID, payload);
  if (parts.length === 1) {
    muxState.writeQueue.push({ buf: parts[0], cb });
  } else {
    muxState.writeQueue.push({ buf: parts[0], cb: null });
    muxState.writeQueue.push({ buf: parts[1], cb });
  }
  muxScheduleFlush();
}

function muxHandleIncomingFrame(frameType, channelID, payload) {
  const ch = muxState.channels.get(channelID);
  if (!ch) return;
  if (frameType === MUX_FRAME_OPEN_RESULT) {
    if (ch.openTimer) {
      clearTimeout(ch.openTimer);
      ch.openTimer = null;
    }
    ch.stream.opened = true;
    ch.resolve(ch.stream);
    return;
  }
  if (frameType === MUX_FRAME_OPEN_ERROR) {
    if (ch.openTimer) {
      clearTimeout(ch.openTimer);
      ch.openTimer = null;
    }
    const msg = payload.length > 0 ? payload.toString('utf8') : 'mux open failed';
    ch.stream.openErr = new Error(msg);
    ch.reject(ch.stream.openErr);
    muxState.channels.delete(channelID);
    ch.stream.destroy(ch.stream.openErr);
    return;
  }
  if (frameType === MUX_FRAME_DATA) {
    ch.stream.push(payload);
    return;
  }
  if (frameType === MUX_FRAME_CLOSE) {
    muxState.channels.delete(channelID);
    ch.stream.push(null);
    ch.stream.end();
  }
}

function muxProcessIncoming(chunk) {
  muxState.incoming = muxState.incoming.length > 0 ? Buffer.concat([muxState.incoming, chunk]) : chunk;
  while (muxState.incoming.length >= 9) {
    const frameType = muxState.incoming.readUInt8(0);
    const channelID = muxState.incoming.readUInt32BE(1);
    const payloadLen = muxState.incoming.readUInt32BE(5);
    if (muxState.incoming.length < 9 + payloadLen) return;
    const payload = payloadLen > 0 ? muxState.incoming.subarray(9, 9 + payloadLen) : Buffer.alloc(0);
    muxState.incoming = muxState.incoming.subarray(9 + payloadLen);
    muxHandleIncomingFrame(frameType, channelID, payload);
  }
}

function muxReset(err) {
  const reason = err || new Error('mux disconnected');
  const pending = Array.from(muxState.channels.values());
  muxState.channels.clear();
  muxState.incoming = Buffer.alloc(0);
  muxState.writeQueue.length = 0;
  muxState.req = null;
  muxState.connecting = null;
  for (const ch of pending) {
    if (ch.openTimer) {
      clearTimeout(ch.openTimer);
      ch.openTimer = null;
    }
    if (!ch.stream.opened) ch.reject(reason);
    ch.stream.destroy(reason);
  }
}

async function ensureMuxConnection() {
  if (muxState.req && !muxState.req.closed && !muxState.req.destroyed) return muxState.req;
  if (muxState.connecting) return muxState.connecting;

  muxState.connecting = (async () => {
    const session = await getH2Session(0);
    const req = session.request({
      ':method': 'POST',
      ':path': upstreamPath,
      'x-auth-token': upstreamAuthToken,
      'x-4px-v2': '1',
      'x-4px-v2-mode': 'mux'
    });
    const established = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        req.close();
        reject(new Error('mux upstream response timeout'));
      }, streamResponseTimeoutMs);
      req.once('response', (headers) => {
        clearTimeout(timer);
        if (headers[':status'] !== 200) {
          reject(new Error(`mux upstream status=${headers[':status']}`));
          return;
        }
        resolve(true);
      });
      req.once('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
    if (!established) {
      throw new Error('mux establish failed');
    }

    req.on('data', muxProcessIncoming);
    req.on('drain', () => muxFlushQueue());
    req.on('close', () => muxReset(new Error('mux stream closed')));
    req.on('error', (err) => muxReset(err));
    muxState.req = req;
    muxState.connecting = null;
    logger.info('mux tunnel established');
    return req;
  })();

  try {
    return muxState.connecting;
  } catch (err) {
    muxState.connecting = null;
    throw err;
  }
}

async function openProxyStreamMux(targetHost, targetPort) {
  await ensureMuxConnection();
  const channelID = muxState.nextChannelID;
  muxState.nextChannelID += 1;
  const target = `${targetHost}:${targetPort}`;
  const stream = new MuxChannelStream(channelID, targetHost, targetPort);
  return new Promise((resolve, reject) => {
    const openTimer = setTimeout(() => {
      muxState.channels.delete(channelID);
      const err = new Error('mux open response timeout');
      reject(err);
      stream.destroy(err);
    }, streamResponseTimeoutMs);
    muxState.channels.set(channelID, { stream, resolve, reject, openTimer });
    muxSendFrame(MUX_FRAME_OPEN, channelID, Buffer.from(target, 'utf8'));
    logger.info(`open mux channel id=${channelID} target=${target}`);
  });
}

async function openProxyStream(targetHost, targetPort) {
  if (useProxyV2Headers) {
    return openProxyStreamMux(targetHost, targetPort);
  }
  const poolIndex = pickPoolIndex();
  const session = await getH2Session(poolIndex);
  const reqHeaders = {
    ':method': 'POST',
    ':path': upstreamPath,
    'x-auth-token': upstreamAuthToken,
    'x-target-host': targetHost,
    'x-target-port': String(targetPort)
  };
  if (useProxyV2Headers) {
    reqHeaders['x-4px-v2'] = '1';
  }
  if (!useProxyV2Headers) {
    reqHeaders['x-target'] = Buffer.from(`${targetHost}:${targetPort}`, 'utf8').toString('base64url');
  }
  const stream = session.request(reqHeaders);
  logger.info(`open stream idx=${poolIndex} target=${targetHost}:${targetPort}`);

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      stats.streamResponseTimeoutTotal += 1;
      stream.close();
      reject(new Error('upstream response timeout'));
    }, streamResponseTimeoutMs);

    if (streamIdleTimeoutMs > 0) {
      stream.setTimeout(streamIdleTimeoutMs, () => {
        stats.streamIdleTimeoutTotal += 1;
        logger.warn(`stream idle timeout target=${targetHost}:${targetPort}`);
        stream.close();
      });
    }

    stream.once('response', (headers) => {
      clearTimeout(timer);
      if (headers[':status'] !== 200) {
        stats.streamRejectedTotal += 1;
        logger.warn(`stream rejected by server status=${headers[':status']} target=${targetHost}:${targetPort}`);
        reject(new Error(`upstream status=${headers[':status']}`));
        return;
      }
      logger.info(`stream established id=${stream.id} idx=${poolIndex} target=${targetHost}:${targetPort}`);
      resolve(stream);
    });
    stream.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function bridgeDuplex(left, right, onOverflow) {
  left.on('data', (chunk) => {
    const ok = right.write(chunk);
    if (!ok) left.pause();
    if (typeof onOverflow === 'function') onOverflow(left, right);
  });
  right.on('drain', () => left.resume());
}

const socksServer = createSocks5Server(
  cfg,
  async ({ socket, host, port, pending, successReply, failReply }) => {
    const clientPeer = `${socket.remoteAddress || '-'}:${socket.remotePort || '-'}`;
    stats.socksConnectTotal += 1;
    try {
      logger.info(`new socks connect ${clientPeer} -> ${host}:${port}`);
      socket.setNoDelay(true);
      socket.setKeepAlive(true, localSocketKeepAliveInitialDelayMs);
      if (localSocketIdleTimeoutMs > 0) {
        socket.setTimeout(localSocketIdleTimeoutMs, () => {
          logger.warn(`local socket idle timeout ${clientPeer} -> ${host}:${port}`);
          socket.destroy(new Error('local socket idle timeout'));
        });
      }
      const stream = await openProxyStream(host, port);
      stats.streamOpenedTotal += 1;
      stats.activeStreams += 1;
      socket.write(successReply());

      const closeBoth = () => {
        if (!socket.destroyed) socket.destroy();
        if (!stream.destroyed) stream.close();
      };

      bridgeDuplex(socket, stream, () => {
        if (stream.writableLength > maxBufferedBytes) {
          stats.bufferOverflowTotal += 1;
          logger.warn(`stream buffer overflow id=${stream.id} bytes=${stream.writableLength} limit=${maxBufferedBytes}`);
          closeBoth();
        }
      });
      bridgeDuplex(stream, socket, () => {
        if (socket.writableLength > maxBufferedBytes) {
          stats.bufferOverflowTotal += 1;
          logger.warn(`socket buffer overflow peer=${clientPeer} bytes=${socket.writableLength} limit=${maxBufferedBytes}`);
          closeBoth();
        }
      });

      socket.on('close', () => {
        if (!stream.destroyed) stream.end();
      });
      socket.on('error', closeBoth);
      stream.on('close', closeBoth);
      stream.on('error', closeBoth);
      stream.on('end', () => {
        if (!socket.destroyed) socket.end();
      });
      stream.on('close', () => {
        stats.streamClosedTotal += 1;
        if (stats.activeStreams > 0) stats.activeStreams -= 1;
        logger.info(`stream closed id=${stream.id} target=${host}:${port}`);
      });

      if (pending && pending.length > 0) {
        stream.write(pending);
      }
      socket.resume();
    } catch (err) {
      stats.socksConnectFailed += 1;
      logger.error(`socks connect failed ${clientPeer} -> ${host}:${port}`, err.message);
      socket.end(failReply(0x01));
    }
  }
);

socksServer.on('error', (err) => {
  logger.error('socks server error', err.message);
});

socksServer.listen(cfg.socksListenPort, cfg.socksListenHost, socksListenBacklog, () => {
  logger.info(`SOCKS5 listening on ${cfg.socksListenHost}:${cfg.socksListenPort}`);
  logger.info(`log level=${logger.level}`);
  logger.info(`h2 session pool size=${h2SessionPoolSize}, maxBufferedBytes=${maxBufferedBytes}, socks backlog=${socksListenBacklog}`);
});

function parseProxyHeader(headerText) {
  const lines = headerText.split('\r\n');
  if (!lines.length) return null;
  const first = lines[0].trim();
  const parts = first.split(' ');
  if (parts.length < 3) return null;
  const method = parts[0].toUpperCase();
  const target = parts[1];
  const version = parts[2];
  const headers = {};
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line) continue;
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    headers[key] = value;
  }
  return { method, target, version, headers };
}

function buildOriginRequest(parsed, pendingBody) {
  let host = '';
  let port = 80;
  let pathAndQuery = parsed.target;

  if (/^https?:\/\//i.test(parsed.target)) {
    const url = new URL(parsed.target);
    host = url.hostname;
    port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
    pathAndQuery = `${url.pathname || '/'}${url.search || ''}`;
  } else {
    const hostHeader = parsed.headers.host || '';
    if (!hostHeader) return null;
    if (hostHeader.includes(':')) {
      const [h, p] = hostHeader.split(':');
      host = h;
      port = Number(p || 80);
    } else {
      host = hostHeader;
      port = 80;
    }
  }

  if (!host || Number.isNaN(port) || port <= 0) return null;

  const headerLines = [];
  for (const [k, v] of Object.entries(parsed.headers)) {
    if (k === 'proxy-connection') continue;
    headerLines.push(`${k}: ${v}`);
  }
  const raw = Buffer.concat([
    Buffer.from(`${parsed.method} ${pathAndQuery} ${parsed.version}\r\n${headerLines.join('\r\n')}\r\n\r\n`, 'utf8'),
    pendingBody
  ]);
  return { host, port, raw };
}

function startHttpProxyIfEnabled() {
  if (!httpListen) return;

  const parseListenAddress = (addr) => {
    if (typeof addr !== 'string' || addr.trim() === '') return null;
    const trimmed = addr.trim();
    const idx = trimmed.lastIndexOf(':');
    if (idx <= 0 || idx === trimmed.length - 1) return null;
    const host = trimmed.slice(0, idx);
    const port = Number(trimmed.slice(idx + 1));
    if (!host || Number.isNaN(port) || port <= 0 || port > 65535) return null;
    return { host, port };
  };

  const listenAddr = parseListenAddress(httpListen);
  if (!listenAddr) {
    logger.error(`invalid httpListen="${httpListen}", expected format host:port, e.g. 127.0.0.1:7788`);
    return;
  }

  const httpProxy = net.createServer((socket) => {
    const peer = `${socket.remoteAddress || '-'}:${socket.remotePort || '-'}`;
    socket.setNoDelay(true);
    socket.setKeepAlive(true, localSocketKeepAliveInitialDelayMs);
    if (localSocketIdleTimeoutMs > 0) {
      socket.setTimeout(localSocketIdleTimeoutMs, () => {
        logger.warn(`http socket idle timeout ${peer}`);
        socket.destroy(new Error('http socket idle timeout'));
      });
    }

    let buffered = Buffer.alloc(0);
    let handled = false;

    const handleHeader = async (chunk) => {
      if (handled) return;
      buffered = Buffer.concat([buffered, chunk]);
      const end = buffered.indexOf('\r\n\r\n');
      if (end < 0) return;
      handled = true;
      socket.removeListener('data', handleHeader);

      const head = buffered.slice(0, end + 4).toString('utf8');
      const pending = buffered.slice(end + 4);
      const parsed = parseProxyHeader(head);
      if (!parsed) {
        socket.end('HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n');
        return;
      }

      let targetHost = '';
      let targetPort = 0;
      let initialPayload = Buffer.alloc(0);

      if (parsed.method === 'CONNECT') {
        const idx = parsed.target.lastIndexOf(':');
        targetHost = idx > 0 ? parsed.target.slice(0, idx) : parsed.target;
        targetPort = idx > 0 ? Number(parsed.target.slice(idx + 1)) : 443;
        if (!targetHost || Number.isNaN(targetPort) || targetPort <= 0) {
          socket.end('HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n');
          return;
        }
      } else {
        const originReq = buildOriginRequest(parsed, pending);
        if (!originReq) {
          socket.end('HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n');
          return;
        }
        targetHost = originReq.host;
        targetPort = originReq.port;
        initialPayload = originReq.raw;
      }

      try {
        logger.info(`new http connect ${peer} -> ${targetHost}:${targetPort}`);
        const stream = await openProxyStream(targetHost, targetPort);
        stats.streamOpenedTotal += 1;
        stats.activeStreams += 1;

        const closeBoth = () => {
          if (!socket.destroyed) socket.destroy();
          if (!stream.destroyed) stream.close();
        };

        if (parsed.method === 'CONNECT') {
          socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
          if (pending.length > 0) stream.write(pending);
        } else if (initialPayload.length > 0) {
          stream.write(initialPayload);
        }

        bridgeDuplex(socket, stream, () => {
          if (stream.writableLength > maxBufferedBytes) {
            stats.bufferOverflowTotal += 1;
            logger.warn(`http stream buffer overflow id=${stream.id} bytes=${stream.writableLength} limit=${maxBufferedBytes}`);
            closeBoth();
          }
        });
        bridgeDuplex(stream, socket, () => {
          if (socket.writableLength > maxBufferedBytes) {
            stats.bufferOverflowTotal += 1;
            logger.warn(`http socket buffer overflow peer=${peer} bytes=${socket.writableLength} limit=${maxBufferedBytes}`);
            closeBoth();
          }
        });

        socket.on('close', () => {
          if (!stream.destroyed) stream.end();
        });
        socket.on('error', closeBoth);
        stream.on('error', (err) => {
          logger.warn(`http stream error ${peer} -> ${targetHost}:${targetPort} ${err.message}`);
          closeBoth();
        });
        stream.on('close', () => {
          stats.streamClosedTotal += 1;
          if (stats.activeStreams > 0) stats.activeStreams -= 1;
        });
      } catch (err) {
        stats.socksConnectFailed += 1;
        logger.error(`http connect failed ${peer} -> ${targetHost}:${targetPort}`, err.message);
        socket.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n');
      }
    };

    socket.on('data', handleHeader);
    socket.on('error', (err) => {
      logger.warn(`http socket error ${peer}: ${err.message}`);
    });
  });

  httpProxy.on('error', (err) => {
    logger.error('http proxy server error', err.message);
  });

  httpProxy.listen(listenAddr.port, listenAddr.host, httpListenBacklog, () => {
    logger.info(`HTTP proxy listening on ${listenAddr.host}:${listenAddr.port} backlog=${httpListenBacklog}`);
  });
}

startHttpProxyIfEnabled();

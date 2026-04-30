const fs = require('fs');
const net = require('net');
const path = require('path');
const http2 = require('http2');
const { monitorEventLoopDelay } = require('perf_hooks');
const { loadConfig, resolvePath } = require('./config');
const { createLogger } = require('./logger');

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

function parseTarget(encoded) {
  const decoded = Buffer.from(String(encoded || ''), 'base64url').toString('utf8');
  const split = decoded.lastIndexOf(':');
  if (split <= 0 || split >= decoded.length - 1) {
    throw new Error('Invalid x-target');
  }
  return {
    host: decoded.slice(0, split),
    port: Number(decoded.slice(split + 1))
  };
}

const server = http2.createSecureServer({
  key,
  cert,
  allowHTTP1: false,
  ALPNProtocols: ['h2'],
  minVersion: 'TLSv1.2'
});

server.on('stream', (stream, headers) => {
  stats.streamTotal += 1;
  stats.activeStreams += 1;
  const remotePeer = `${stream.session.socket.remoteAddress || '-'}:${stream.session.socket.remotePort || '-'}`;
  const streamId = stream.id;
  try {
    if (headers[':method'] !== 'POST' || headers[':path'] !== '/proxy') {
      stats.routeRejectedTotal += 1;
      logger.warn(`reject invalid route, peer=${remotePeer}, stream=${streamId}`);
      stream.respond({ ':status': 404 });
      stream.end();
      return;
    }
    if (headers['x-auth-token'] !== cfg.authToken) {
      stats.authRejectedTotal += 1;
      logger.warn(`reject unauthorized request, peer=${remotePeer}, stream=${streamId}`);
      stream.respond({ ':status': 401 });
      stream.end();
      return;
    }

    const { host, port } = parseTarget(headers['x-target']);
    logger.info(`stream accepted, peer=${remotePeer}, stream=${streamId}, target=${host}:${port}`);
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
});

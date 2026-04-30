const net = require('net');
const { createLogger } = require('./logger');

function parseSocks5ConnectRequest(buf) {
  if (buf.length < 7) return null;
  if (buf[0] !== 0x05) throw new Error('Only SOCKS5 is supported');
  if (buf[1] !== 0x01) throw new Error('Only CONNECT command is supported');
  if (buf[2] !== 0x00) throw new Error('Invalid RSV');

  const atyp = buf[3];
  if (atyp === 0x01) {
    if (buf.length < 10) return null;
    const host = `${buf[4]}.${buf[5]}.${buf[6]}.${buf[7]}`;
    const port = buf.readUInt16BE(8);
    return { host, port, used: 10 };
  }
  if (atyp === 0x03) {
    const nameLen = buf[4];
    if (buf.length < 7 + nameLen) return null;
    const host = buf.slice(5, 5 + nameLen).toString('utf8');
    const port = buf.readUInt16BE(5 + nameLen);
    return { host, port, used: 7 + nameLen };
  }
  throw new Error('ATYP not supported');
}

function socks5SuccessReply() {
  return Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]);
}

function socks5FailReply(code = 0x01) {
  return Buffer.from([0x05, code, 0x00, 0x01, 0, 0, 0, 0, 0, 0]);
}

function createSocks5Server(cfg, onConnect) {
  const logger = createLogger('socks5', cfg.logLevel);
  const authEnabled = !!(cfg.localAuth && cfg.localAuth.enabled);
  const username = (cfg.localAuth && cfg.localAuth.username) || '';
  const password = (cfg.localAuth && cfg.localAuth.password) || '';
  const socketKeepAliveInitialDelayMs = cfg.localSocketKeepAliveInitialDelayMs || 30000;

  return net.createServer((socket) => {
    let stage = 'greeting';
    let cache = Buffer.alloc(0);
    const peer = `${socket.remoteAddress || '-'}:${socket.remotePort || '-'}`;
    socket.setNoDelay(true);
    socket.setKeepAlive(true, socketKeepAliveInitialDelayMs);

    socket.on('data', async (chunk) => {
      if (stage === 'streaming') return;
      cache = Buffer.concat([cache, chunk]);

      try {
        if (stage === 'greeting') {
          if (cache.length < 2) return;
          const methodsLen = cache[1];
          if (cache.length < 2 + methodsLen) return;
          const methods = cache.slice(2, 2 + methodsLen);
          const selectedMethod = authEnabled ? 0x02 : 0x00;
          if (!methods.includes(selectedMethod)) {
            logger.warn(`method not supported by client ${peer}, need=${selectedMethod}`);
            return socket.end();
          }
          socket.write(Buffer.from([0x05, selectedMethod]));
          cache = cache.slice(2 + methodsLen);
          stage = authEnabled ? 'auth' : 'request';
        }

        if (stage === 'auth') {
          if (cache.length < 2) return;
          if (cache[0] !== 0x01) return socket.end();
          const uLen = cache[1];
          if (cache.length < 2 + uLen + 1) return;
          const user = cache.slice(2, 2 + uLen).toString('utf8');
          const pLen = cache[2 + uLen];
          if (cache.length < 3 + uLen + pLen) return;
          const pass = cache.slice(3 + uLen, 3 + uLen + pLen).toString('utf8');
          cache = cache.slice(3 + uLen + pLen);
          if (user !== username || pass !== password) {
            logger.warn(`auth failed from ${peer}, username=${user}`);
            socket.write(Buffer.from([0x01, 0x01]));
            return socket.end();
          }
          logger.info(`auth success from ${peer}, username=${user}`);
          socket.write(Buffer.from([0x01, 0x00]));
          stage = 'request';
        }

        if (stage === 'request') {
          const req = parseSocks5ConnectRequest(cache);
          if (!req) return;
          logger.info(`connect request from ${peer} to ${req.host}:${req.port}`);
          cache = cache.slice(req.used);
          stage = 'streaming';
          socket.pause();
          await onConnect({
            socket,
            host: req.host,
            port: req.port,
            pending: cache,
            successReply: socks5SuccessReply,
            failReply: socks5FailReply
          });
          cache = Buffer.alloc(0);
        }
      } catch (err) {
        logger.error(`socks5 parse/handshake failed from ${peer}`, err.message);
        socket.end(socks5FailReply(0x01));
      }
    });

    socket.on('error', () => {
      logger.error(`socket error from ${peer}`);
      socket.destroy();
    });
    socket.on('close', () => {
      logger.info(`socket closed ${peer}`);
    });
  });
}

module.exports = {
  createSocks5Server
};

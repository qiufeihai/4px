const http = require('http');
const os = require('os');
const fs = require('fs');
const { renderAdminPage, renderLoginPage } = require('./page');

function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (!text) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(text));
      } catch (err) {
        reject(new Error('invalid json body'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

function parseCookies(req) {
  const cookieText = String(req.headers.cookie || '');
  if (!cookieText) return {};
  const out = {};
  cookieText.split(';').forEach((part) => {
    const idx = part.indexOf('=');
    if (idx <= 0) return;
    const key = part.slice(0, idx).trim();
    const value = decodeURIComponent(part.slice(idx + 1).trim());
    out[key] = value;
  });
  return out;
}

function setAuthCookie(res, token) {
  const cookie = `admin_auth=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict`;
  res.setHeader('Set-Cookie', cookie);
}

function clearAuthCookie(res) {
  res.setHeader('Set-Cookie', 'admin_auth=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0');
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

function startAdminServer(options) {
  const cfg = options.cfg || {};
  const userStore = options.userStore;
  const logger = options.logger;
  const admin = cfg.admin || {};
  if (admin.enabled !== true) return;
  if (!userStore || !userStore.enabled) {
    logger.error('admin enabled but authUsersFile is missing');
    return;
  }
  const adminToken = String(admin.token || '').trim();
  if (!adminToken) {
    logger.error('admin enabled but admin.token is missing');
    return;
  }
  const adminListenHost = admin.listenHost || '127.0.0.1';
  const adminListenPort = Number(admin.listenPort || 6688);
  let lastCpu = snapshotCpuTimes();
  let lastProcCpuUsage = process.cpuUsage();
  let lastProcSampleAt = Date.now();

  const isAuthorized = (req) => {
    const authHeader = String(req.headers.authorization || '');
    const expected = `Bearer ${adminToken}`;
    if (authHeader === expected) return true;
    const cookies = parseCookies(req);
    return String(cookies.admin_auth || '') === adminToken;
  };

  const adminServer = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (url.pathname === '/health') {
      sendJson(res, 200, { ok: true });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/admin/login') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(renderLoginPage());
      return;
    }
    if (req.method === 'POST' && url.pathname === '/admin/login') {
      try {
        const body = await parseJsonBody(req);
        if (String(body.token || '').trim() !== adminToken) {
          sendJson(res, 401, { ok: false, error: 'invalid_token' });
          return;
        }
        setAuthCookie(res, adminToken);
        sendJson(res, 200, { ok: true });
      } catch (err) {
        sendJson(res, 400, { ok: false, error: err.message });
      }
      return;
    }
    if (req.method === 'POST' && url.pathname === '/admin/logout') {
      clearAuthCookie(res);
      sendJson(res, 200, { ok: true });
      return;
    }
    if (!isAuthorized(req)) {
      if (req.method === 'GET' && url.pathname === '/admin') {
        res.writeHead(302, { location: '/admin/login' });
        res.end();
        return;
      }
      sendJson(res, 401, { ok: false, error: 'unauthorized' });
      return;
    }
    try {
      if (req.method === 'GET' && url.pathname === '/api/system/resources') {
        const currentCpu = snapshotCpuTimes();
        const totalDelta = currentCpu.total - lastCpu.total;
        const idleDelta = currentCpu.idle - lastCpu.idle;
        lastCpu = currentCpu;
        const cpuUsagePercent = totalDelta > 0 ? Math.max(0, Math.min(100, (1 - idleDelta / totalDelta) * 100)) : 0;
        const now = Date.now();
        const elapsedMs = Math.max(1, now - lastProcSampleAt);
        const procCpuUsage = process.cpuUsage();
        const procCpuDelta = process.cpuUsage(lastProcCpuUsage);
        const procCpuMicros = Number(procCpuDelta.user || 0) + Number(procCpuDelta.system || 0);
        const cpuCores = (os.cpus() || []).length || 1;
        const processCpuPercentHost = Math.max(
          0,
          Math.min(100, Number(((procCpuMicros / 1000) / (elapsedMs * cpuCores) * 100).toFixed(2)))
        );
        lastProcCpuUsage = procCpuUsage;
        lastProcSampleAt = now;
        const totalMem = os.totalmem();
        const freeMem = os.freemem();
        const usedMem = totalMem - freeMem;
        const processMem = process.memoryUsage();
        const processMemRssPercentOfTotal = safePercent(processMem.rss, totalMem);
        const processMemRssPercentOfUsed = safePercent(processMem.rss, usedMem);
        sendJson(res, 200, {
          ok: true,
          resources: {
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
          }
        });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/config/server') {
        if (!cfg.__configPath) {
          sendJson(res, 500, { ok: false, error: 'server config path is missing' });
          return;
        }
        const text = fs.readFileSync(cfg.__configPath, 'utf8');
        sendJson(res, 200, { ok: true, configPath: cfg.__configPath, text });
        return;
      }
      if (req.method === 'PUT' && url.pathname === '/api/config/server') {
        if (!cfg.__configPath) {
          sendJson(res, 500, { ok: false, error: 'server config path is missing' });
          return;
        }
        const body = await parseJsonBody(req);
        const text = String(body.text || '').trim();
        if (!text) {
          sendJson(res, 400, { ok: false, error: 'config text is required' });
          return;
        }
        let parsed;
        try {
          parsed = JSON.parse(text);
        } catch (err) {
          sendJson(res, 400, { ok: false, error: `invalid json: ${err.message}` });
          return;
        }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          sendJson(res, 400, { ok: false, error: 'server config must be a JSON object' });
          return;
        }
        fs.writeFileSync(cfg.__configPath, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8');
        sendJson(res, 200, { ok: true, configPath: cfg.__configPath, message: 'saved, restart server to apply changes' });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/users') {
        sendJson(res, 200, { ok: true, users: userStore.list() });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/users/export') {
        sendJson(res, 200, {
          ok: true,
          exportedAt: new Date().toISOString(),
          schemaVersion: 1,
          users: userStore.list()
        });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/users/import') {
        const body = await parseJsonBody(req);
        const summary = userStore.importUsers(body.users, body.mode);
        sendJson(res, 200, { ok: true, ...summary });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/users/import/preview') {
        const body = await parseJsonBody(req);
        const summary = userStore.previewImport(body.users, body.mode);
        sendJson(res, 200, { ok: true, ...summary });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/users') {
        const body = await parseJsonBody(req);
        const user = userStore.upsert(body);
        sendJson(res, 200, { ok: true, user });
        return;
      }
      if (req.method === 'POST' && url.pathname.startsWith('/api/users/') && url.pathname.endsWith('/status')) {
        const id = url.pathname.replace('/api/users/', '').replace('/status', '').replace(/\//g, '');
        const body = await parseJsonBody(req);
        const user = userStore.setEnabled(id, body.enabled === true);
        sendJson(res, 200, { ok: true, user });
        return;
      }
      if (req.method === 'DELETE' && url.pathname.startsWith('/api/users/')) {
        const id = url.pathname.replace('/api/users/', '').replace(/\//g, '');
        const user = userStore.remove(id);
        sendJson(res, 200, { ok: true, user });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/admin') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(renderAdminPage(userStore.list()));
        return;
      }
      sendJson(res, 404, { ok: false, error: 'not_found' });
    } catch (err) {
      sendJson(res, 400, { ok: false, error: err.message });
    }
  });

  adminServer.listen(adminListenPort, adminListenHost, () => {
    logger.info(`admin server listening on http://${adminListenHost}:${adminListenPort}`);
    logger.info('admin page path=/admin');
  });
}

module.exports = {
  startAdminServer
};

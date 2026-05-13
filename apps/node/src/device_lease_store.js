class MemoryDeviceLeaseStore {
  constructor(options = {}) {
    this.ttlMs = Math.max(5000, Math.floor(Number(options.ttlMs || 90000)));
    this.leases = new Map();
  }

  pruneUser(userId, nowMs) {
    const uid = String(userId || '').trim();
    if (!uid || !this.leases.has(uid)) return;
    const now = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now();
    const userLeases = this.leases.get(uid);
    userLeases.forEach((lastSeenAtMs, deviceKey) => {
      if (now - Number(lastSeenAtMs || 0) > this.ttlMs) {
        userLeases.delete(deviceKey);
      }
    });
    if (userLeases.size === 0) {
      this.leases.delete(uid);
    }
  }

  acquireLease(params = {}) {
    const uid = String(params.userId || '').trim();
    const deviceKey = String(params.deviceKey || '').trim();
    const maxDevices = Math.max(1, Math.floor(Number(params.maxDevices || 1)));
    const policy = String(params.policy || 'reject').trim().toLowerCase() === 'kick_oldest' ? 'kick_oldest' : 'reject';
    if (!uid || !deviceKey) {
      return { ok: true, activeDevices: 0, maxDevices };
    }
    const now = Date.now();
    this.pruneUser(uid, now);
    if (!this.leases.has(uid)) {
      this.leases.set(uid, new Map());
    }
    const userLeases = this.leases.get(uid);
    if (userLeases.has(deviceKey)) {
      userLeases.set(deviceKey, now);
      return { ok: true, activeDevices: userLeases.size, maxDevices };
    }
    if (userLeases.size < maxDevices) {
      userLeases.set(deviceKey, now);
      return { ok: true, activeDevices: userLeases.size, maxDevices };
    }
    if (policy === 'kick_oldest') {
      let oldestKey = '';
      let oldestSeenAtMs = Number.POSITIVE_INFINITY;
      userLeases.forEach((lastSeenAtMs, existingDeviceKey) => {
        const seenAtMs = Number(lastSeenAtMs || 0);
        if (seenAtMs < oldestSeenAtMs) {
          oldestSeenAtMs = seenAtMs;
          oldestKey = existingDeviceKey;
        }
      });
      if (oldestKey) {
        userLeases.delete(oldestKey);
        userLeases.set(deviceKey, now);
        return { ok: true, activeDevices: userLeases.size, maxDevices };
      }
    }
    return { ok: false, activeDevices: userLeases.size, maxDevices };
  }

  releaseLease(params = {}) {
    const uid = String(params.userId || '').trim();
    const deviceKey = String(params.deviceKey || '').trim();
    if (!uid || !deviceKey || !this.leases.has(uid)) return;
    const userLeases = this.leases.get(uid);
    userLeases.delete(deviceKey);
    if (userLeases.size === 0) {
      this.leases.delete(uid);
    }
  }

  async getActiveDeviceCountsByUsers(userIds = []) {
    const now = Date.now();
    const out = {};
    for (const userId of userIds) {
      const uid = String(userId || '').trim();
      if (!uid) continue;
      this.pruneUser(uid, now);
      out[uid] = Number(this.leases.get(uid)?.size || 0);
    }
    return out;
  }
}

class RedisDeviceLeaseStore {
  constructor(options = {}) {
    this.ttlMs = Math.max(5000, Math.floor(Number(options.ttlMs || 90000)));
    this.prefix = String(options.prefix || '4px:device_lease').trim() || '4px:device_lease';
    this.redis = options.redisClient;
    this.logger = options.logger;
    this.acquireScript = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local ttl = tonumber(ARGV[2])
local max = tonumber(ARGV[3])
local policy = ARGV[4]
local device = ARGV[5]
local expireBefore = now - ttl
redis.call('ZREMRANGEBYSCORE', key, '-inf', expireBefore)
local exists = redis.call('ZSCORE', key, device)
if exists then
  redis.call('ZADD', key, now, device)
  redis.call('PEXPIRE', key, ttl * 2)
  local count = redis.call('ZCARD', key)
  return {1, count}
end
local count = redis.call('ZCARD', key)
if count < max then
  redis.call('ZADD', key, now, device)
  redis.call('PEXPIRE', key, ttl * 2)
  return {1, count + 1}
end
if policy == 'kick_oldest' then
  local oldest = redis.call('ZRANGE', key, 0, 0)
  if oldest[1] then
    redis.call('ZREM', key, oldest[1])
    redis.call('ZADD', key, now, device)
    redis.call('PEXPIRE', key, ttl * 2)
    local nextCount = redis.call('ZCARD', key)
    return {1, nextCount}
  end
end
return {0, count}
`;
    this.releaseScript = `
local key = KEYS[1]
local device = ARGV[1]
local ttl = tonumber(ARGV[2])
redis.call('ZREM', key, device)
local count = redis.call('ZCARD', key)
if count <= 0 then
  redis.call('DEL', key)
  return 0
end
redis.call('PEXPIRE', key, ttl * 2)
return count
`;
    this.countScript = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local ttl = tonumber(ARGV[2])
local expireBefore = now - ttl
redis.call('ZREMRANGEBYSCORE', key, '-inf', expireBefore)
local count = redis.call('ZCARD', key)
if count <= 0 then
  redis.call('DEL', key)
  return 0
end
redis.call('PEXPIRE', key, ttl * 2)
return count
`;
  }

  keyForUser(userId) {
    const uid = String(userId || '').trim();
    return `${this.prefix}:${uid}`;
  }

  async acquireLease(params = {}) {
    const uid = String(params.userId || '').trim();
    const deviceKey = String(params.deviceKey || '').trim();
    const maxDevices = Math.max(1, Math.floor(Number(params.maxDevices || 1)));
    const policy = String(params.policy || 'reject').trim().toLowerCase() === 'kick_oldest' ? 'kick_oldest' : 'reject';
    if (!uid || !deviceKey) {
      return { ok: true, activeDevices: 0, maxDevices };
    }
    const key = this.keyForUser(uid);
    const now = Date.now();
    const result = await this.redis.eval(this.acquireScript, {
      keys: [key],
      arguments: [String(now), String(this.ttlMs), String(maxDevices), policy, deviceKey]
    });
    const ok = Number(Array.isArray(result) ? result[0] : 0) === 1;
    const activeDevices = Number(Array.isArray(result) ? result[1] : 0);
    return {
      ok,
      activeDevices: Number.isFinite(activeDevices) ? activeDevices : 0,
      maxDevices
    };
  }

  async releaseLease(params = {}) {
    const uid = String(params.userId || '').trim();
    const deviceKey = String(params.deviceKey || '').trim();
    if (!uid || !deviceKey) return;
    const key = this.keyForUser(uid);
    try {
      await this.redis.eval(this.releaseScript, {
        keys: [key],
        arguments: [deviceKey, String(this.ttlMs)]
      });
    } catch (err) {
      if (this.logger) {
        this.logger.warn(`release redis device lease failed user=${uid} err=${String((err && err.message) || err)}`);
      }
    }
  }

  async getActiveDeviceCountsByUsers(userIds = []) {
    const now = Date.now();
    const out = {};
    for (const userId of userIds) {
      const uid = String(userId || '').trim();
      if (!uid) continue;
      const key = this.keyForUser(uid);
      try {
        const count = await this.redis.eval(this.countScript, {
          keys: [key],
          arguments: [String(now), String(this.ttlMs)]
        });
        out[uid] = Number.isFinite(Number(count)) ? Number(count) : 0;
      } catch (err) {
        out[uid] = 0;
        if (this.logger) {
          this.logger.warn(`query redis device count failed user=${uid} err=${String((err && err.message) || err)}`);
        }
      }
    }
    return out;
  }
}

async function createDeviceLeaseStore(options = {}) {
  const mode = String(options.mode || 'memory').trim().toLowerCase() === 'redis' ? 'redis' : 'memory';
  if (mode !== 'redis') {
    return {
      mode: 'memory',
      store: new MemoryDeviceLeaseStore(options)
    };
  }

  let redisModule;
  try {
    redisModule = require('redis');
  } catch {
    throw new Error('device lease store redis mode requires dependency "redis"');
  }

  const redis = redisModule.createClient({
    password: typeof options.redisPassword === 'string' && options.redisPassword ? options.redisPassword : undefined,
    database: Number.isFinite(Number(options.redisDatabase)) ? Number(options.redisDatabase) : undefined,
    url: options.redisUrl || undefined,
    socket: {
      connectTimeout: Math.max(1000, Number(options.redisConnectTimeoutMs || 5000))
    }
  });
  if (options.logger) {
    redis.on('error', (err) => {
      options.logger.error(`device lease redis error: ${String((err && err.message) || err)}`);
    });
  }
  await redis.connect();
  return {
    mode: 'redis',
    store: new RedisDeviceLeaseStore({
      ...options,
      redisClient: redis
    }),
    close: async () => {
      try {
        await redis.quit();
      } catch {
        try {
          redis.disconnect();
        } catch {}
      }
    }
  };
}

module.exports = {
  createDeviceLeaseStore
};

const fs = require('fs');
const crypto = require('crypto');

function isObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function toIsoOrNull(input) {
  if (!input) return null;
  const d = new Date(input);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

function toExpireAtMs(expireAt) {
  if (!expireAt) return 0;
  const ms = Date.parse(expireAt);
  return Number.isFinite(ms) ? ms : 0;
}

function normalizeMaxDevices(value, fallback = 1) {
  const n = Number(value);
  if (!Number.isFinite(n)) return Math.max(1, Math.floor(fallback || 1));
  return Math.max(1, Math.floor(n));
}

function normalizeUser(raw, index, defaultMaxDevices = 1) {
  if (!isObject(raw)) return null;
  const id = String(raw.id || `u_${index + 1}`).trim();
  const username = String(raw.username || '').trim();
  const authToken = String(raw.authToken || '').trim();
  if (!id || !username || !authToken) return null;
  const expireAt = toIsoOrNull(raw.expireAt);
  return {
    id,
    username,
    authToken,
    enabled: raw.enabled !== false,
    expireAt,
    expireAtMs: toExpireAtMs(expireAt),
    note: String(raw.note || '').trim(),
    maxDevices: normalizeMaxDevices(raw.maxDevices, defaultMaxDevices)
  };
}

function toStoredUser(user) {
  return {
    id: user.id,
    username: user.username,
    authToken: user.authToken,
    enabled: user.enabled !== false,
    expireAt: user.expireAt || null,
    note: String(user.note || '').trim(),
    maxDevices: normalizeMaxDevices(user.maxDevices, 1)
  };
}

function parseUsersPayload(payload, defaultMaxDevices) {
  if (!isObject(payload) || !Array.isArray(payload.users)) {
    return [];
  }
  return payload.users
    .map((item, i) => normalizeUser(item, i, defaultMaxDevices))
    .filter((item) => item);
}

function staticUserIdFromToken(token) {
  const digest = crypto.createHash('sha256').update(String(token || '')).digest('hex').slice(0, 12);
  return `static_${digest}`;
}

function assertUniqueUsers(users) {
  const idSet = new Set();
  const usernameSet = new Set();
  const tokenSet = new Set();
  for (const user of users) {
    if (idSet.has(user.id)) throw new Error(`duplicate user id: ${user.id}`);
    idSet.add(user.id);

    const usernameKey = String(user.username || '').trim().toLowerCase();
    if (usernameSet.has(usernameKey)) throw new Error(`duplicate username: ${user.username}`);
    usernameSet.add(usernameKey);

    if (tokenSet.has(user.authToken)) throw new Error(`duplicate authToken: ${user.authToken}`);
    tokenSet.add(user.authToken);
  }
}

function normalizeUsersInput(nextUsers, defaultMaxDevices) {
  if (!Array.isArray(nextUsers)) throw new Error('users must be an array');
  const normalized = [];
  for (let i = 0; i < nextUsers.length; i += 1) {
    const user = normalizeUser(nextUsers[i], i, defaultMaxDevices);
    if (!user) throw new Error(`invalid user at index ${i}`);
    normalized.push(user);
  }
  assertUniqueUsers(normalized);
  return normalized;
}

class UserStore {
  constructor(options) {
    this.filePath = options.filePath || '';
    this.authTokens = Array.isArray(options.authTokens)
      ? options.authTokens.map((v) => String(v || '').trim()).filter((v) => v)
      : [];
    this.authTokenSet = new Set(this.authTokens);
    this.reloadIntervalMs = Math.max(1000, Number(options.reloadIntervalMs || 5000));
    this.logger = options.logger;
    this.defaultMaxDevices = normalizeMaxDevices(options.defaultMaxDevices, 1);
    this.users = [];
    this.userByToken = new Map();
    this.lastMtimeMs = 0;
    this.lastReloadAt = 0;
    this.reloadInProgress = false;
    this.enabled = Boolean(this.filePath);
    if (this.enabled) {
      this.ensureFile();
      this.reload(true);
      setInterval(() => {
        this.reloadAsync(false);
      }, this.reloadIntervalMs).unref();
    }
  }

  ensureFile() {
    if (!this.filePath) return;
    if (fs.existsSync(this.filePath)) return;
    fs.writeFileSync(this.filePath, JSON.stringify({ users: [] }, null, 2), 'utf8');
  }

  reload(force) {
    if (!this.enabled || !this.filePath) return;
    try {
      const stat = fs.statSync(this.filePath);
      if (!force && stat.mtimeMs <= this.lastMtimeMs) {
        this.lastReloadAt = Date.now();
        return;
      }
      const text = fs.readFileSync(this.filePath, 'utf8');
      const parsed = JSON.parse(text);
      const users = parseUsersPayload(parsed, this.defaultMaxDevices);
      assertUniqueUsers(users);
      this.users = users;
      this.rebuildUserIndexes();
      this.lastMtimeMs = stat.mtimeMs;
      this.lastReloadAt = Date.now();
      this.logger.info(`loaded users file: ${this.filePath}, users=${this.users.length}`);
    } catch (err) {
      this.lastReloadAt = Date.now();
      this.logger.error(`failed load users file: ${this.filePath}`, err.message);
    }
  }

  async reloadAsync(force) {
    if (!this.enabled || !this.filePath) return;
    if (this.reloadInProgress) return;
    this.reloadInProgress = true;
    try {
      const stat = await fs.promises.stat(this.filePath);
      if (!force && stat.mtimeMs <= this.lastMtimeMs) {
        this.lastReloadAt = Date.now();
        return;
      }
      const text = await fs.promises.readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(text);
      const users = parseUsersPayload(parsed, this.defaultMaxDevices);
      assertUniqueUsers(users);
      this.users = users;
      this.rebuildUserIndexes();
      this.lastMtimeMs = stat.mtimeMs;
      this.lastReloadAt = Date.now();
      this.logger.info(`loaded users file: ${this.filePath}, users=${this.users.length}`);
    } catch (err) {
      this.lastReloadAt = Date.now();
      this.logger.error(`failed load users file: ${this.filePath}`, err.message);
    } finally {
      this.reloadInProgress = false;
    }
  }

  save() {
    if (!this.enabled || !this.filePath) {
      throw new Error('users file is not enabled');
    }
    fs.writeFileSync(this.filePath, JSON.stringify({ users: this.users.map((item) => toStoredUser(item)) }, null, 2), 'utf8');
    try {
      const stat = fs.statSync(this.filePath);
      this.lastMtimeMs = stat.mtimeMs;
    } catch (err) {
      this.logger.warn(`failed stat users file after save: ${this.filePath}`, err.message);
    }
    this.lastReloadAt = Date.now();
  }

  rebuildUserIndexes() {
    const next = new Map();
    for (const user of this.users) {
      if (user && user.authToken) {
        next.set(user.authToken, user);
      }
    }
    this.userByToken = next;
  }

  createToken() {
    return crypto.randomBytes(18).toString('base64url');
  }

  authenticate(token) {
    const value = String(token || '').trim();
    if (!value) return { ok: false, reason: 'missing_token' };

    if (this.enabled) {
      const user = this.userByToken.get(value);
      if (user) {
        if (!user.enabled) return { ok: false, reason: 'disabled_user', user };
        if (user.expireAtMs > 0 && Date.now() > user.expireAtMs) {
          return { ok: false, reason: 'expired_user', user };
        }
        return { ok: true, mode: 'multi_user', user };
      }
    }

    if (this.authTokenSet.has(value)) {
      return {
        ok: true,
        mode: 'static',
        user: { id: staticUserIdFromToken(value), username: 'static', maxDevices: this.defaultMaxDevices }
      };
    }
    return { ok: false, reason: 'invalid_token' };
  }

  list() {
    return this.users.map((item) => ({ ...toStoredUser(item) }));
  }

  upsert(input) {
    if (!this.enabled) throw new Error('multi-user mode is disabled');
    const id = String(input.id || '').trim() || `u_${Date.now()}`;
    const username = String(input.username || '').trim();
    if (!username) throw new Error('username is required');
    const note = String(input.note || '').trim();
    const authToken = String(input.authToken || '').trim() || this.createToken();
    const enabled = input.enabled !== false;
    const expireAt = input.expireAt ? toIsoOrNull(input.expireAt) : null;
    const expireAtMs = toExpireAtMs(expireAt);
    const maxDevices = normalizeMaxDevices(input.maxDevices, this.defaultMaxDevices);
    if (input.expireAt && !expireAt) throw new Error('expireAt is invalid');

    const next = { id, username, authToken, enabled, expireAt, expireAtMs, note, maxDevices };
    const index = this.users.findIndex((item) => item.id === id);
    const snapshot = this.users.slice();
    if (index >= 0) {
      snapshot[index] = next;
    } else {
      snapshot.push(next);
    }
    assertUniqueUsers(snapshot);
    this.users = snapshot;
    this.rebuildUserIndexes();
    this.save();
    return { ...toStoredUser(next) };
  }

  setEnabled(id, enabled) {
    if (!this.enabled) throw new Error('multi-user mode is disabled');
    const uid = String(id || '').trim();
    const index = this.users.findIndex((item) => item.id === uid);
    if (index < 0) throw new Error('user not found');
    this.users[index].enabled = Boolean(enabled);
    this.save();
    return { ...toStoredUser(this.users[index]) };
  }

  regenerateToken(id) {
    if (!this.enabled) throw new Error('multi-user mode is disabled');
    const uid = String(id || '').trim();
    const index = this.users.findIndex((item) => item.id === uid);
    if (index < 0) throw new Error('user not found');

    let nextToken = '';
    do {
      nextToken = this.createToken();
    } while (this.users.some((item, i) => i !== index && item.authToken === nextToken));

    this.users[index].authToken = nextToken;
    this.rebuildUserIndexes();
    this.save();
    return { ...toStoredUser(this.users[index]) };
  }

  remove(id) {
    if (!this.enabled) throw new Error('multi-user mode is disabled');
    const uid = String(id || '').trim();
    const index = this.users.findIndex((item) => item.id === uid);
    if (index < 0) throw new Error('user not found');
    const removed = this.users[index];
    this.users.splice(index, 1);
    this.rebuildUserIndexes();
    this.save();
    return { ...toStoredUser(removed) };
  }

  replaceAll(nextUsers) {
    if (!this.enabled) throw new Error('multi-user mode is disabled');
    const normalized = normalizeUsersInput(nextUsers, this.defaultMaxDevices);
    this.users = normalized;
    this.rebuildUserIndexes();
    this.save();
    return this.list();
  }

  previewImport(nextUsers, mode) {
    if (!this.enabled) throw new Error('multi-user mode is disabled');
    const importMode = mode === 'replace' ? 'replace' : 'merge';
    const normalized = normalizeUsersInput(nextUsers, this.defaultMaxDevices);
    if (importMode === 'replace') {
      const incomingIdSet = new Set(normalized.map((item) => item.id));
      const removed = this.users.filter((item) => !incomingIdSet.has(item.id)).length;
      return {
        mode: importMode,
        added: normalized.length,
        updated: 0,
        removed,
        finalCount: normalized.length
      };
    }

    const currentById = new Map(this.users.map((item) => [item.id, item]));
    let added = 0;
    let updated = 0;
    const nextById = new Map(this.users.map((item) => [item.id, item]));
    normalized.forEach((item) => {
      if (currentById.has(item.id)) {
        updated += 1;
      } else {
        added += 1;
      }
      nextById.set(item.id, item);
    });
    const merged = Array.from(nextById.values());
    assertUniqueUsers(merged);
    return {
      mode: importMode,
      added,
      updated,
      removed: 0,
      finalCount: merged.length
    };
  }

  importUsers(nextUsers, mode) {
    if (!this.enabled) throw new Error('multi-user mode is disabled');
    const preview = this.previewImport(nextUsers, mode);
    const importMode = preview.mode;
    const normalized = normalizeUsersInput(nextUsers, this.defaultMaxDevices);
    if (importMode === 'replace') {
      this.users = normalized;
      this.rebuildUserIndexes();
      this.save();
      return { ...preview };
    }

    const nextById = new Map(this.users.map((item) => [item.id, item]));
    normalized.forEach((item) => {
      nextById.set(item.id, item);
    });
    const merged = Array.from(nextById.values());
    assertUniqueUsers(merged);
    this.users = merged;
    this.rebuildUserIndexes();
    this.save();
    return { ...preview };
  }
}

module.exports = {
  UserStore
};

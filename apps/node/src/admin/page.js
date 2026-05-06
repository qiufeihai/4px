function renderLoginPage() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <title>4px 管理员登录</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 24px; }
    .card { max-width: 420px; margin: 48px auto; padding: 18px; border: 1px solid #e5e5e5; border-radius: 8px; }
    h2 { margin-top: 0; }
    .line { margin-top: 12px; }
    input { width: 100%; box-sizing: border-box; padding: 8px; }
    button { padding: 8px 14px; }
    .err { color: #c53030; min-height: 20px; }
  </style>
</head>
<body>
  <div class="card">
    <h2>管理员登录</h2>
    <div class="line"><input id="token" type="password" placeholder="请输入 admin.token" /></div>
    <div class="line"><button id="login-btn">登录</button></div>
    <div class="line err" id="err"></div>
  </div>
  <script>
    document.getElementById('login-btn').addEventListener('click', async () => {
      const errEl = document.getElementById('err');
      errEl.textContent = '';
      const token = (document.getElementById('token').value || '').trim();
      try {
        const resp = await fetch('/admin/login', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ token })
        });
        if (!resp.ok) {
          throw new Error('登录失败，请检查 token');
        }
        location.href = '/admin';
      } catch (err) {
        errEl.textContent = err.message;
      }
    });
    document.getElementById('token').addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        document.getElementById('login-btn').click();
      }
    });
  </script>
</body>
</html>`;
}

function renderAdminPage(users) {
  const initialUsers = JSON.stringify(users || []).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <title>4px 用户管理</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 24px; }
    table { width: 100%; border-collapse: collapse; margin-top: 16px; }
    th, td { border: 1px solid #e5e5e5; padding: 8px; text-align: left; font-size: 13px; }
    input { width: 100%; box-sizing: border-box; }
    .row { display: flex; gap: 12px; margin-top: 12px; }
    .row > input { flex: 1; }
    .toolbar { display: flex; gap: 12px; margin-top: 12px; align-items: center; }
    .toolbar input, .toolbar select { width: auto; min-width: 140px; }
    .pager { display: flex; gap: 10px; margin-top: 12px; align-items: center; }
    .pager button { padding: 4px 10px; }
    .resource-card { margin-top: 12px; border: 1px solid #e5e5e5; border-radius: 8px; padding: 12px; }
    .resource-grid { display: grid; grid-template-columns: repeat(4, minmax(120px, 1fr)); gap: 10px; margin-top: 8px; }
    .resource-item { background: #fafafa; border-radius: 6px; padding: 8px; }
    .resource-title { font-size: 12px; color: #666; }
    .resource-value { font-size: 15px; margin-top: 4px; }
    .metric-ok { color: #15803d; }
    .metric-warn { color: #b45309; }
    .metric-danger { color: #b91c1c; font-weight: 600; }
    .resource-section { margin-top: 10px; }
    .resource-section-title { font-size: 13px; font-weight: 600; color: #333; margin-top: 6px; }
    .log-box {
      margin-top: 8px;
      border: 1px solid #e5e5e5;
      border-radius: 6px;
      background: #0f172a;
      color: #e2e8f0;
      padding: 10px;
      min-height: 220px;
      max-height: 360px;
      overflow: auto;
      font-size: 12px;
      line-height: 1.45;
      white-space: pre-wrap;
      word-break: break-word;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Courier New", monospace;
    }
    textarea { width: 100%; box-sizing: border-box; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace; }
    .tabs { display: flex; gap: 8px; margin-top: 12px; }
    .tab-btn { border: 1px solid #ddd; background: #fff; border-radius: 6px; padding: 6px 12px; cursor: pointer; }
    .tab-btn.active { background: #111; color: #fff; border-color: #111; }
    .panel { display: none; margin-top: 12px; }
    .panel.active { display: block; }
  </style>
</head>
<body>
  <h2>4px 多用户管理</h2>
  <p>当前通过登录态访问管理接口。</p>
  <p><button id="logout-btn">退出登录</button></p>
  <div class="tabs">
    <button class="tab-btn" data-tab="users" id="tab-users">用户管理</button>
    <button class="tab-btn" data-tab="resources" id="tab-resources">服务器资源</button>
    <button class="tab-btn" data-tab="config" id="tab-config">配置管理</button>
  </div>
  <div class="panel" id="panel-users">
    <div class="row">
      <input id="new-username" placeholder="用户名" />
      <input id="new-auth-token" placeholder="AuthToken（留空自动生成）" />
      <input id="new-expireAt" type="datetime-local" />
      <input id="new-note" placeholder="备注" />
      <button id="create-btn">新增用户</button>
      <button id="export-users-btn">导出备份</button>
      <button id="import-users-btn">导入恢复</button>
      <input id="import-users-file" type="file" accept="application/json,.json" style="display:none;" />
    </div>
    <div class="toolbar">
      <input id="filter-keyword" placeholder="搜索 ID/用户名/备注/AuthToken" />
      <select id="filter-status">
        <option value="all">全部状态</option>
        <option value="enabled">仅启用</option>
        <option value="disabled">仅禁用</option>
        <option value="expired">仅已过期</option>
      </select>
      <select id="page-size">
        <option value="10">每页 10</option>
        <option value="20" selected>每页 20</option>
        <option value="50">每页 50</option>
      </select>
    </div>
    <table>
      <thead>
        <tr><th>ID</th><th>用户名</th><th>在线</th><th>连接数</th><th>最近活跃</th><th>AuthToken</th><th>启用</th><th>到期时间</th><th>备注</th><th>操作</th></tr>
      </thead>
      <tbody id="user-rows"></tbody>
    </table>
    <div class="pager">
      <button id="prev-page">上一页</button>
      <span id="page-info">第 1 / 1 页</span>
      <button id="next-page">下一页</button>
      <span id="total-info">共 0 条</span>
    </div>
  </div>
  <div class="panel" id="panel-resources">
    <div class="resource-card">
    <div class="toolbar">
      <strong>服务器资源</strong>
      <button id="refresh-resource-btn">刷新</button>
      <span id="resource-time">-</span>
    </div>
    <div class="resource-section">
      <div class="resource-section-title">服务器整体资源</div>
      <div class="resource-grid">
        <div class="resource-item"><div class="resource-title">CPU 使用率</div><div class="resource-value" id="res-server-cpu">-</div></div>
        <div class="resource-item"><div class="resource-title">CPU 核心数</div><div class="resource-value" id="res-server-core">-</div></div>
        <div class="resource-item"><div class="resource-title">内存使用率</div><div class="resource-value" id="res-server-mem-usage">-</div></div>
        <div class="resource-item"><div class="resource-title">内存已用/总量</div><div class="resource-value" id="res-server-mem-size">-</div></div>
        <div class="resource-item"><div class="resource-title">1分钟负载</div><div class="resource-value" id="res-server-load">-</div></div>
      </div>
    </div>
    <div class="resource-section">
      <div class="resource-section-title">本进程资源占用</div>
      <div class="resource-grid">
        <div class="resource-item"><div class="resource-title">进程 CPU 占整机</div><div class="resource-value" id="res-proc-cpu">-</div></div>
        <div class="resource-item"><div class="resource-title">进程 RSS</div><div class="resource-value" id="res-proc-rss">-</div></div>
        <div class="resource-item"><div class="resource-title">RSS 占整机内存</div><div class="resource-value" id="res-proc-rss-total">-</div></div>
        <div class="resource-item"><div class="resource-title">RSS 占已用内存</div><div class="resource-value" id="res-proc-rss-used">-</div></div>
        <div class="resource-item"><div class="resource-title">进程 Heap</div><div class="resource-value" id="res-proc-heap">-</div></div>
        <div class="resource-item"><div class="resource-title">进程运行时长</div><div class="resource-value" id="res-proc-uptime">-</div></div>
      </div>
    </div>
    <div class="resource-section">
      <div class="toolbar">
        <strong>服务端日志（最近 300 行）</strong>
        <button id="refresh-log-btn">刷新日志</button>
        <span id="log-time">-</span>
      </div>
      <div id="server-log-box" class="log-box">加载中...</div>
    </div>
  </div>
  </div>
  <div class="panel" id="panel-config">
    <div class="resource-card">
    <div class="toolbar">
      <strong>Server 配置管理（server.json）</strong>
      <button id="load-config-btn">加载配置</button>
      <button id="save-config-btn">保存配置</button>
      <button id="restart-server-btn">重启服务</button>
      <span id="config-path">-</span>
    </div>
    <div style="margin-top:8px;">
      <textarea id="server-config-text" rows="16" placeholder="点击“加载配置”后编辑，再保存"></textarea>
    </div>
    <div style="margin-top:6px;color:#666;" id="config-tip">保存后需要重启 server 才会生效。</div>
  </div>
  </div>
  <script>
    const state = {
      allUsers: ${initialUsers},
      activeTab: 'users',
      page: 1,
      pageSize: 20
    };

    function initStateFromUrl() {
      const params = new URLSearchParams(location.search || '');
      const q = String(params.get('q') || '');
      const status = String(params.get('status') || 'all');
      const tab = String(params.get('tab') || 'users');
      const page = Number(params.get('page') || 1);
      const pageSize = Number(params.get('pageSize') || 20);
      document.getElementById('filter-keyword').value = q;
      document.getElementById('filter-status').value = ['all', 'enabled', 'disabled', 'expired'].includes(status) ? status : 'all';
      state.activeTab = ['users', 'resources', 'config'].includes(tab) ? tab : 'users';
      state.page = Number.isFinite(page) && page > 0 ? Math.floor(page) : 1;
      state.pageSize = [10, 20, 50].includes(pageSize) ? pageSize : 20;
      document.getElementById('page-size').value = String(state.pageSize);
    }

    function syncUrlState() {
      const params = new URLSearchParams();
      const q = (document.getElementById('filter-keyword').value || '').trim();
      const status = document.getElementById('filter-status').value;
      if (state.activeTab && state.activeTab !== 'users') params.set('tab', state.activeTab);
      if (q) params.set('q', q);
      if (status && status !== 'all') params.set('status', status);
      if (state.page > 1) params.set('page', String(state.page));
      if (state.pageSize !== 20) params.set('pageSize', String(state.pageSize));
      const query = params.toString();
      const nextUrl = query ? (location.pathname + '?' + query) : location.pathname;
      history.replaceState(null, '', nextUrl);
    }

    function switchTab(tab) {
      const next = ['users', 'resources', 'config'].includes(tab) ? tab : 'users';
      state.activeTab = next;
      ['users', 'resources', 'config'].forEach((name) => {
        const panel = document.getElementById('panel-' + name);
        const btn = document.getElementById('tab-' + name);
        if (panel) panel.classList.toggle('active', name === next);
        if (btn) btn.classList.toggle('active', name === next);
      });
      syncUrlState();
    }

    function formatUptime(sec) {
      const s = Math.max(0, Number(sec || 0));
      const h = Math.floor(s / 3600);
      const m = Math.floor((s % 3600) / 60);
      const r = Math.floor(s % 60);
      return h + 'h ' + m + 'm ' + r + 's';
    }

    function setPercentMetric(id, value) {
      const el = document.getElementById(id);
      if (!el) return;
      const v = Number(value);
      el.classList.remove('metric-ok', 'metric-warn', 'metric-danger');
      if (!Number.isFinite(v)) {
        el.textContent = '-';
        return;
      }
      el.textContent = v + '%';
      if (v >= 70) {
        el.classList.add('metric-danger');
      } else if (v >= 50) {
        el.classList.add('metric-warn');
      } else {
        el.classList.add('metric-ok');
      }
    }

    async function loadResources() {
      try {
        const data = await request('/api/system/resources', { method: 'GET' });
        const r = data.resources || {};
        const mem = r.memory || {};
        const proc = r.process || {};
        setPercentMetric('res-server-cpu', r.cpuUsagePercent);
        document.getElementById('res-server-core').textContent = String(r.cpuCores ?? '-');
        setPercentMetric('res-server-mem-usage', mem.usagePercent);
        document.getElementById('res-server-mem-size').textContent = (mem.usedText || '-') + ' / ' + (mem.totalText || '-');
        document.getElementById('res-server-load').textContent = String(r.loadAvg1m ?? '-');
        setPercentMetric('res-proc-cpu', proc.cpuPercentOfHost);
        document.getElementById('res-proc-rss').textContent = proc.rssText || '-';
        setPercentMetric('res-proc-rss-total', proc.rssPercentOfTotalMem);
        setPercentMetric('res-proc-rss-used', proc.rssPercentOfUsedMem);
        document.getElementById('res-proc-heap').textContent = proc.heapUsedText || '-';
        document.getElementById('res-proc-uptime').textContent = formatUptime(proc.uptimeSec || 0);
        document.getElementById('resource-time').textContent = '更新时间：' + new Date().toLocaleTimeString();
      } catch (err) {
        document.getElementById('resource-time').textContent = '资源加载失败';
      }
    }

    function formatLogLine(line) {
      const text = String(line || '');
      if (!text) return '';
      return text;
    }

    async function loadServerLogs() {
      try {
        const data = await request('/api/system/logs?limit=300', { method: 'GET' });
        const lines = Array.isArray(data.lines) ? data.lines : [];
        const box = document.getElementById('server-log-box');
        if (box) {
          box.textContent = lines.map(formatLogLine).join('\\n') || '暂无日志';
          box.scrollTop = box.scrollHeight;
        }
        const logTime = document.getElementById('log-time');
        if (logTime) {
          logTime.textContent = '日志更新时间：' + new Date().toLocaleTimeString();
        }
      } catch (err) {
        const box = document.getElementById('server-log-box');
        if (box) box.textContent = '日志加载失败';
        const logTime = document.getElementById('log-time');
        if (logTime) logTime.textContent = '日志加载失败';
      }
    }

    async function loadServerConfig() {
      const data = await request('/api/config/server', { method: 'GET' });
      document.getElementById('server-config-text').value = String(data.text || '');
      document.getElementById('config-path').textContent = data.configPath || '-';
      document.getElementById('config-tip').textContent = '已加载配置，保存后需要重启 server 才会生效。';
    }

    async function saveServerConfig() {
      const text = String(document.getElementById('server-config-text').value || '');
      const data = await request('/api/config/server', {
        method: 'PUT',
        body: JSON.stringify({ text })
      });
      document.getElementById('config-path').textContent = data.configPath || '-';
      document.getElementById('config-tip').textContent = data.message || '保存成功，重启 server 后生效。';
    }

    async function restartServerService() {
      const data = await request('/api/system/restart', { method: 'POST' });
      document.getElementById('config-tip').textContent = (data.message || '已触发重启') + '，请稍后刷新页面。';
    }

    function buildBackupFilename() {
      const d = new Date();
      const p = (n) => String(n).padStart(2, '0');
      const ts = d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
      return 'server-users-backup-' + ts + '.json';
    }

    async function exportUsersBackup() {
      const data = await request('/api/users/export', { method: 'GET' });
      const text = JSON.stringify(data, null, 2);
      const blob = new Blob([text], { type: 'application/json;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = buildBackupFilename();
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    }

    async function parseUsersFromBackupFile(file) {
      if (!file) return;
      const text = await file.text();
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch (err) {
        throw new Error('导入文件不是合法 JSON');
      }
      if (!parsed || !Array.isArray(parsed.users)) {
        throw new Error('导入文件缺少 users 数组');
      }
      return parsed.users;
    }

    function buildImportPreviewText(summary) {
      const modeText = summary.mode === 'replace' ? '覆盖（replace）' : '合并（merge）';
      const lines = [
        '导入预览：',
        '模式：' + modeText,
        '新增：' + Number(summary.added || 0),
        '更新：' + Number(summary.updated || 0),
        '删除：' + Number(summary.removed || 0),
        '导入后总用户数：' + Number(summary.finalCount || 0)
      ];
      return lines.join('\\n');
    }

    async function importUsersWithMode(file) {
      const users = await parseUsersFromBackupFile(file);
      const useReplace = confirm('导入模式：点击“确定”使用覆盖 replace；点击“取消”使用合并 merge（推荐）');
      const mode = useReplace ? 'replace' : 'merge';
      const preview = await request('/api/users/import/preview', {
        method: 'POST',
        body: JSON.stringify({ users, mode })
      });
      const ok = confirm(buildImportPreviewText(preview) + '\\n\\n是否执行导入？');
      if (!ok) return { ok: false, reason: 'cancelled' };
      if (mode === 'replace') {
        const text = prompt('覆盖模式将删除导入文件中不存在的用户。请输入 REPLACE 确认执行：');
        if (text !== 'REPLACE') {
          throw new Error('已取消导入：未输入 REPLACE');
        }
      }
      const result = await request('/api/users/import', {
        method: 'POST',
        body: JSON.stringify({ users, mode })
      });
      return { ok: true, result };
    }

    async function request(url, options) {
      const resp = await fetch(url, {
        ...options,
        headers: { 'content-type': 'application/json', ...(options && options.headers ? options.headers : {}) }
      });
      if (!resp.ok) {
        if (resp.status === 401) {
          location.href = '/admin/login';
          throw new Error('未登录或登录已过期');
        }
        const text = await resp.text();
        throw new Error(text || ('HTTP ' + resp.status));
      }
      return resp.json();
    }
    function rowValue(id, field) {
      const el = document.querySelector('[data-field="' + field + '"][data-id="' + id + '"]');
      if (!el) return '';
      if (el.type === 'checkbox') return !!el.checked;
      return (el.value || '').trim();
    }

    function formatLocalInput(isoText) {
      if (!isoText) return '';
      const date = new Date(isoText);
      if (Number.isNaN(date.getTime())) return '';
      return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
    }

    function formatDateTime(isoText) {
      if (!isoText) return '-';
      const date = new Date(isoText);
      if (Number.isNaN(date.getTime())) return '-';
      return date.toLocaleString();
    }

    function isExpired(user) {
      if (!user.expireAt) return false;
      const t = Date.parse(user.expireAt);
      if (Number.isNaN(t)) return false;
      return Date.now() > t;
    }

    function getFilteredUsers() {
      const keyword = (document.getElementById('filter-keyword').value || '').trim().toLowerCase();
      const status = document.getElementById('filter-status').value;
      return state.allUsers.filter((u) => {
        if (keyword) {
          const hit = [u.id, u.username, u.note, u.authToken]
            .map((v) => String(v || '').toLowerCase())
            .some((v) => v.includes(keyword));
          if (!hit) return false;
        }
        if (status === 'enabled' && !u.enabled) return false;
        if (status === 'disabled' && u.enabled) return false;
        if (status === 'expired' && !isExpired(u)) return false;
        return true;
      });
    }

    function addDuration(baseDate, amount, unit) {
      const d = new Date(baseDate.getTime());
      if (unit === 'day') {
        d.setDate(d.getDate() + amount);
      } else if (unit === 'week') {
        d.setDate(d.getDate() + amount * 7);
      } else if (unit === 'month') {
        d.setMonth(d.getMonth() + amount);
      }
      return d;
    }

    function renderRowsAndPager() {
      const filtered = getFilteredUsers();
      const total = filtered.length;
      const totalPage = Math.max(1, Math.ceil(total / state.pageSize));
      if (state.page > totalPage) state.page = totalPage;
      if (state.page < 1) state.page = 1;
      const start = (state.page - 1) * state.pageSize;
      const pageUsers = filtered.slice(start, start + state.pageSize);

      const html = pageUsers.map((u) => {
        const checked = u.enabled ? 'checked' : '';
        const expireAt = formatLocalInput(u.expireAt);
        return '<tr>'
          + '<td>' + u.id + '</td>'
          + '<td><input data-field="username" data-id="' + u.id + '" value="' + (u.username || '') + '" /></td>'
          + '<td>' + (u.online ? '在线' : '离线') + '</td>'
          + '<td>' + Number(u.activeConnections || 0) + '</td>'
          + '<td>' + formatDateTime(u.lastActiveAt || u.lastSeenAt) + '</td>'
          + '<td><input data-field="authToken" data-id="' + u.id + '" value="' + (u.authToken || '') + '" /></td>'
          + '<td><input type="checkbox" data-field="enabled" data-id="' + u.id + '" ' + checked + ' /></td>'
          + '<td><input type="datetime-local" data-field="expireAt" data-id="' + u.id + '" value="' + expireAt + '" /></td>'
          + '<td><input data-field="note" data-id="' + u.id + '" value="' + (u.note || '') + '" /></td>'
          + '<td>'
          + '<button data-action="save" data-id="' + u.id + '">保存</button> <button data-action="delete" data-id="' + u.id + '">删除</button> <button data-action="export-client" data-id="' + u.id + '">导出client.json</button>'
          + '<div style="margin-top:6px;display:flex;gap:6px;align-items:center;">'
          + '<input data-field="extendValue" data-id="' + u.id + '" value="30" style="width:56px;" />'
          + '<select data-field="extendUnit" data-id="' + u.id + '" style="width:64px;">'
          + '<option value="day">天</option><option value="week">周</option><option value="month">月</option>'
          + '</select>'
          + '<button data-action="extend" data-id="' + u.id + '">续期</button>'
          + '<button data-action="extend7" data-id="' + u.id + '">+7天</button>'
          + '<button data-action="extend30" data-id="' + u.id + '">+30天</button>'
          + '</div>'
          + '</td>'
          + '</tr>';
      }).join('');
      document.getElementById('user-rows').innerHTML = html;
      document.getElementById('page-info').textContent = '第 ' + state.page + ' / ' + totalPage + ' 页';
      document.getElementById('total-info').textContent = '共 ' + total + ' 条';
      document.getElementById('prev-page').disabled = state.page <= 1;
      document.getElementById('next-page').disabled = state.page >= totalPage;
      syncUrlState();
    }

    async function reload() {
      const data = await request('/api/users', { method: 'GET' });
      state.allUsers = Array.isArray(data.users) ? data.users : [];
      renderRowsAndPager();
    }

    async function downloadClientConfig(id) {
      const resp = await fetch('/api/users/' + encodeURIComponent(id) + '/client-config', { method: 'GET' });
      if (!resp.ok) {
        if (resp.status === 401) {
          location.href = '/admin/login';
          throw new Error('未登录或登录已过期');
        }
        const text = await resp.text();
        throw new Error(text || ('HTTP ' + resp.status));
      }
      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const disposition = String(resp.headers.get('content-disposition') || '');
      const match = /filename="([^"]+)"/.exec(disposition);
      a.download = match && match[1] ? match[1] : ('client.' + id + '.json');
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    }
    document.addEventListener('click', async (event) => {
      const target = event.target;
      if (!target || !target.dataset) return;
      const action = target.dataset.action;
      const id = target.dataset.id;
      try {
        if (action === 'save') {
          await request('/api/users', {
            method: 'POST',
            body: JSON.stringify({
              id,
              username: rowValue(id, 'username'),
              authToken: rowValue(id, 'authToken'),
              enabled: rowValue(id, 'enabled'),
              expireAt: rowValue(id, 'expireAt') || null,
              note: rowValue(id, 'note')
            })
          });
          await reload();
        } else if (action === 'delete') {
          await request('/api/users/' + id, { method: 'DELETE' });
          await reload();
        } else if (action === 'export-client') {
          await downloadClientConfig(id);
        } else if (action === 'extend' || action === 'extend7' || action === 'extend30') {
          const quickAmount = action === 'extend7' ? 7 : (action === 'extend30' ? 30 : null);
          const rawValue = quickAmount === null ? Number(rowValue(id, 'extendValue')) : quickAmount;
          const amount = Number.isFinite(rawValue) ? Math.floor(rawValue) : 0;
          if (amount <= 0) {
            throw new Error('续期数值必须大于 0');
          }
          const unit = quickAmount === null ? (rowValue(id, 'extendUnit') || 'day') : 'day';
          const currentExpireText = rowValue(id, 'expireAt');
          const now = new Date();
          const currentExpire = currentExpireText ? new Date(currentExpireText) : null;
          const base = currentExpire && !Number.isNaN(currentExpire.getTime()) && currentExpire.getTime() > now.getTime()
            ? currentExpire
            : now;
          const nextExpire = addDuration(base, amount, unit);
          if (Number.isNaN(nextExpire.getTime())) {
            throw new Error('续期失败：计算到期时间错误');
          }
          await request('/api/users', {
            method: 'POST',
            body: JSON.stringify({
              id,
              username: rowValue(id, 'username'),
              authToken: rowValue(id, 'authToken'),
              enabled: rowValue(id, 'enabled'),
              expireAt: nextExpire.toISOString(),
              note: rowValue(id, 'note')
            })
          });
          await reload();
        }
      } catch (err) {
        alert(err.message);
      }
    });
    document.getElementById('filter-keyword').addEventListener('input', () => {
      state.page = 1;
      renderRowsAndPager();
    });
    document.getElementById('filter-status').addEventListener('change', () => {
      state.page = 1;
      renderRowsAndPager();
    });
    document.getElementById('page-size').addEventListener('change', () => {
      state.pageSize = Math.max(1, Number(document.getElementById('page-size').value || 20));
      state.page = 1;
      renderRowsAndPager();
    });
    document.getElementById('prev-page').addEventListener('click', () => {
      state.page -= 1;
      renderRowsAndPager();
    });
    document.getElementById('next-page').addEventListener('click', () => {
      state.page += 1;
      renderRowsAndPager();
    });
    document.getElementById('create-btn').addEventListener('click', async () => {
      try {
        await request('/api/users', {
          method: 'POST',
          body: JSON.stringify({
            username: (document.getElementById('new-username').value || '').trim(),
            authToken: (document.getElementById('new-auth-token').value || '').trim(),
            enabled: true,
            expireAt: (document.getElementById('new-expireAt').value || '').trim() || null,
            note: (document.getElementById('new-note').value || '').trim()
          })
        });
        document.getElementById('new-username').value = '';
        document.getElementById('new-auth-token').value = '';
        document.getElementById('new-expireAt').value = '';
        document.getElementById('new-note').value = '';
        await reload();
      } catch (err) {
        alert(err.message);
      }
    });
    document.getElementById('logout-btn').addEventListener('click', async () => {
      await fetch('/admin/logout', { method: 'POST' });
      location.href = '/admin/login';
    });
    document.getElementById('export-users-btn').addEventListener('click', async () => {
      try {
        await exportUsersBackup();
      } catch (err) {
        alert(err.message);
      }
    });
    document.getElementById('import-users-btn').addEventListener('click', () => {
      const input = document.getElementById('import-users-file');
      if (input) input.click();
    });
    document.getElementById('import-users-file').addEventListener('change', async (event) => {
      const input = event.target;
      const file = input && input.files && input.files[0] ? input.files[0] : null;
      if (!file) return;
      try {
        const data = await importUsersWithMode(file);
        if (!data || data.ok !== true) return;
        await reload();
        alert('导入成功');
      } catch (err) {
        alert(err.message);
      } finally {
        input.value = '';
      }
    });
    document.getElementById('refresh-resource-btn').addEventListener('click', () => {
      loadResources();
    });
    document.getElementById('refresh-log-btn').addEventListener('click', () => {
      loadServerLogs();
    });
    document.getElementById('load-config-btn').addEventListener('click', async () => {
      try {
        await loadServerConfig();
      } catch (err) {
        alert(err.message);
      }
    });
    document.getElementById('save-config-btn').addEventListener('click', async () => {
      try {
        await saveServerConfig();
      } catch (err) {
        alert(err.message);
      }
    });
    document.getElementById('restart-server-btn').addEventListener('click', async () => {
      const ok = confirm('确认重启 server 服务？连接会短暂中断。');
      if (!ok) return;
      try {
        await restartServerService();
      } catch (err) {
        alert(err.message);
      }
    });
    document.querySelectorAll('.tab-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        switchTab(btn.dataset.tab || 'users');
      });
    });
    initStateFromUrl();
    switchTab(state.activeTab);
    renderRowsAndPager();
    loadResources();
    loadServerLogs();
    loadServerConfig();
    setInterval(loadResources, 5000);
    reload();
  </script>
</body>
</html>`;
}

module.exports = {
  renderAdminPage,
  renderLoginPage
};

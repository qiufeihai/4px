const cluster = require('cluster');
const os = require('os');
const path = require('path');
const { loadConfig } = require('./config');
const { createLogger } = require('./logger');

const workers = Math.max(1, Number(process.env.WORKERS || os.cpus().length));
const targetScript = process.env.TARGET_SCRIPT;

if (!targetScript) {
  console.error('TARGET_SCRIPT is required');
  process.exit(1);
}

if (cluster.isPrimary) {
  const cfg = loadConfig(path.resolve(__dirname, '../config/server.json'));
  const logger = createLogger('cluster', cfg.logLevel);
  const metricsIntervalMs = Number(cfg.metricsIntervalMs || 60000);
  const slowEstablishEnabled = cfg.slowEstablishEnabled === true;
  const slowEstablishTopN = Math.max(1, Math.floor(Number(cfg.slowEstablishTopN || 5)));
  const slowEstablishSummaryIntervalMs = Math.max(
    metricsIntervalMs,
    Math.floor(Number(cfg.slowEstablishSummaryIntervalMs || Math.max(metricsIntervalMs * 2, 120000)))
  );
  const perWorkerMetrics = new Map();
  const perWorkerDns = new Map();
  const slowSummary = new Map();

  function formatMetricsLine(snapshot) {
    return `metrics stream_total=${snapshot.streamTotal} active_streams=${snapshot.activeStreams} route_reject=${snapshot.routeRejectedTotal} auth_reject=${snapshot.authRejectedTotal} target_parse_fail=${snapshot.targetParseFailTotal} remote_ok=${snapshot.remoteConnectSuccessTotal} remote_error=${snapshot.remoteConnectErrorTotal} remote_connect_timeout=${snapshot.remoteConnectTimeoutTotal} remote_connect_overload_reject=${snapshot.remoteConnectOverloadRejectTotal} remote_connect_overload_reject_by_host=${snapshot.remoteConnectOverloadRejectByHostTotal} remote_connect_overload_wait_total=${snapshot.remoteConnectOverloadWaitTotal} remote_connect_overload_waiters=${snapshot.remoteConnectOverloadWaiters} remote_dns_cache_hit=${snapshot.remoteDnsCacheHitTotal} remote_dns_cache_miss=${snapshot.remoteDnsCacheMissTotal} remote_dns_negative_cache_hit=${snapshot.remoteDnsNegativeCacheHitTotal} remote_dns_resolve_error=${snapshot.remoteDnsResolveErrorTotal} remote_dns_prefer_ipv4_pick=${snapshot.remoteDnsPreferIpv4PickTotal} remote_dns_cache_size=${snapshot.remoteDnsCacheSize} remote_circuit_reject=${snapshot.remoteCircuitRejectTotal} remote_circuit_open_total=${snapshot.remoteCircuitOpenTotal} remote_circuit_targets=${snapshot.remoteCircuitTargets} remote_connect_inflight=${snapshot.remoteConnectInFlight} remote_connect_inflight_peak=${snapshot.remoteConnectInFlightPeak} remote_connect_inflight_host_peak=${snapshot.remoteConnectInFlightHostPeak} remote_idle_timeout=${snapshot.remoteIdleTimeoutTotal} buffer_overflow=${snapshot.bufferOverflowTotal} retryable_err=${snapshot.retryableErrorTotal} non_retryable_err=${snapshot.nonRetryableErrorTotal} eventloop_p95_ms=${snapshot.eventLoopP95Ms}`;
  }

  function formatDnsSummaryLine(summary) {
    return `dns summary interval_ms=${summary.intervalMs} lookups=${summary.totalLookups} hit=${summary.hitDelta} miss=${summary.missDelta} negative_hit=${summary.negativeHitDelta} resolve_error=${summary.resolveErrorDelta} hit_rate_pct=${summary.cacheHitRate} negative_share_pct=${summary.negativeShare}`;
  }

  function formatSlowSummaryLine(items, totalItems) {
    const summaryText = items
      .map((v) => `${v.kind}:${v.host}:${v.port}#${v.count}(ttfb_max=${v.ttfbMaxMs},connect_max=${v.connectMaxMs})`)
      .join(', ');
    return `slow establish summary top=${items.length}/${totalItems}, ${summaryText}`;
  }

  logger.info(`[cluster] primary pid=${process.pid} workers=${workers} target=${targetScript}`);

  cluster.on('message', (worker, msg) => {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type !== 'metrics_report') return;
    const kind = String(msg.kind || '');
    if (kind === 'metrics_snapshot') {
      perWorkerMetrics.set(worker.id, msg.payload || {});
      return;
    }
    if (kind === 'dns_summary') {
      perWorkerDns.set(worker.id, msg.payload || {});
      return;
    }
    if (kind === 'slow_summary') {
      const payload = msg.payload || {};
      const sourceItems = Array.isArray(payload.items) ? payload.items : [];
      for (const v of sourceItems) {
        const kind0 = String(v && v.kind ? v.kind : '');
        const host0 = String(v && v.host ? v.host : '');
        const port0 = Number(v && v.port ? v.port : 0);
        if (!kind0 || !host0 || !Number.isFinite(port0) || port0 <= 0) continue;
        const key = `${kind0}|${host0}|${port0}`;
        const current = slowSummary.get(key);
        if (!current) {
          slowSummary.set(key, {
            kind: kind0,
            host: host0,
            port: port0,
            count: Number(v.count || 0),
            ttfbMaxMs: Number(v.ttfbMaxMs || 0),
            connectMaxMs: Number(v.connectMaxMs || 0)
          });
          continue;
        }
        current.count += Number(v.count || 0);
        current.ttfbMaxMs = Math.max(current.ttfbMaxMs, Number(v.ttfbMaxMs || 0));
        current.connectMaxMs = Math.max(current.connectMaxMs, Number(v.connectMaxMs || 0));
      }
    }
  });

  setInterval(() => {
    if (perWorkerMetrics.size === 0) return;
    const agg = {
      streamTotal: 0,
      activeStreams: 0,
      routeRejectedTotal: 0,
      authRejectedTotal: 0,
      targetParseFailTotal: 0,
      remoteConnectSuccessTotal: 0,
      remoteConnectErrorTotal: 0,
      remoteConnectTimeoutTotal: 0,
      remoteConnectOverloadRejectTotal: 0,
      remoteConnectOverloadRejectByHostTotal: 0,
      remoteConnectOverloadWaitTotal: 0,
      remoteConnectOverloadWaiters: 0,
      remoteDnsCacheHitTotal: 0,
      remoteDnsCacheMissTotal: 0,
      remoteDnsNegativeCacheHitTotal: 0,
      remoteDnsResolveErrorTotal: 0,
      remoteDnsPreferIpv4PickTotal: 0,
      remoteDnsCacheSize: 0,
      remoteCircuitRejectTotal: 0,
      remoteCircuitOpenTotal: 0,
      remoteCircuitTargets: 0,
      remoteConnectInFlight: 0,
      remoteConnectInFlightPeak: 0,
      remoteConnectInFlightHostPeak: 0,
      remoteIdleTimeoutTotal: 0,
      bufferOverflowTotal: 0,
      retryableErrorTotal: 0,
      nonRetryableErrorTotal: 0,
      eventLoopP95Ms: '0.00'
    };
    let maxEventLoop = 0;
    for (const snapshot of perWorkerMetrics.values()) {
      agg.streamTotal += Number(snapshot.streamTotal || 0);
      agg.activeStreams += Number(snapshot.activeStreams || 0);
      agg.routeRejectedTotal += Number(snapshot.routeRejectedTotal || 0);
      agg.authRejectedTotal += Number(snapshot.authRejectedTotal || 0);
      agg.targetParseFailTotal += Number(snapshot.targetParseFailTotal || 0);
      agg.remoteConnectSuccessTotal += Number(snapshot.remoteConnectSuccessTotal || 0);
      agg.remoteConnectErrorTotal += Number(snapshot.remoteConnectErrorTotal || 0);
      agg.remoteConnectTimeoutTotal += Number(snapshot.remoteConnectTimeoutTotal || 0);
      agg.remoteConnectOverloadRejectTotal += Number(snapshot.remoteConnectOverloadRejectTotal || 0);
      agg.remoteConnectOverloadRejectByHostTotal += Number(snapshot.remoteConnectOverloadRejectByHostTotal || 0);
      agg.remoteConnectOverloadWaitTotal += Number(snapshot.remoteConnectOverloadWaitTotal || 0);
      agg.remoteConnectOverloadWaiters += Number(snapshot.remoteConnectOverloadWaiters || 0);
      agg.remoteDnsCacheHitTotal += Number(snapshot.remoteDnsCacheHitTotal || 0);
      agg.remoteDnsCacheMissTotal += Number(snapshot.remoteDnsCacheMissTotal || 0);
      agg.remoteDnsNegativeCacheHitTotal += Number(snapshot.remoteDnsNegativeCacheHitTotal || 0);
      agg.remoteDnsResolveErrorTotal += Number(snapshot.remoteDnsResolveErrorTotal || 0);
      agg.remoteDnsPreferIpv4PickTotal += Number(snapshot.remoteDnsPreferIpv4PickTotal || 0);
      agg.remoteDnsCacheSize += Number(snapshot.remoteDnsCacheSize || 0);
      agg.remoteCircuitRejectTotal += Number(snapshot.remoteCircuitRejectTotal || 0);
      agg.remoteCircuitOpenTotal += Number(snapshot.remoteCircuitOpenTotal || 0);
      agg.remoteCircuitTargets += Number(snapshot.remoteCircuitTargets || 0);
      agg.remoteConnectInFlight += Number(snapshot.remoteConnectInFlight || 0);
      agg.remoteConnectInFlightPeak = Math.max(agg.remoteConnectInFlightPeak, Number(snapshot.remoteConnectInFlightPeak || 0));
      agg.remoteConnectInFlightHostPeak = Math.max(
        agg.remoteConnectInFlightHostPeak,
        Number(snapshot.remoteConnectInFlightHostPeak || 0)
      );
      agg.remoteIdleTimeoutTotal += Number(snapshot.remoteIdleTimeoutTotal || 0);
      agg.bufferOverflowTotal += Number(snapshot.bufferOverflowTotal || 0);
      agg.retryableErrorTotal += Number(snapshot.retryableErrorTotal || 0);
      agg.nonRetryableErrorTotal += Number(snapshot.nonRetryableErrorTotal || 0);
      const ev = Number(snapshot.eventLoopP95Ms || 0);
      if (Number.isFinite(ev)) {
        maxEventLoop = Math.max(maxEventLoop, ev);
      }
    }
    agg.eventLoopP95Ms = maxEventLoop.toFixed(2);
    logger.info(formatMetricsLine(agg));

    if (perWorkerDns.size > 0) {
      let hitDelta = 0;
      let missDelta = 0;
      let negativeHitDelta = 0;
      let resolveErrorDelta = 0;
      for (const s of perWorkerDns.values()) {
        hitDelta += Number(s.hitDelta || 0);
        missDelta += Number(s.missDelta || 0);
        negativeHitDelta += Number(s.negativeHitDelta || 0);
        resolveErrorDelta += Number(s.resolveErrorDelta || 0);
      }
      const totalLookups = hitDelta + missDelta + negativeHitDelta;
      const cacheHitRate = totalLookups > 0 ? (((hitDelta + negativeHitDelta) / totalLookups) * 100).toFixed(1) : '0.0';
      const negativeShare = totalLookups > 0 ? ((negativeHitDelta / totalLookups) * 100).toFixed(1) : '0.0';
      logger.info(
        formatDnsSummaryLine({
          intervalMs: metricsIntervalMs,
          totalLookups,
          hitDelta,
          missDelta,
          negativeHitDelta,
          resolveErrorDelta,
          cacheHitRate,
          negativeShare
        })
      );
    }
  }, metricsIntervalMs).unref();

  setInterval(() => {
    if (!slowEstablishEnabled) return;
    if (slowSummary.size === 0) return;
    const sourceItems = Array.from(slowSummary.values());
    const items = sourceItems
      .sort((a, b) => {
        if (Number(b.ttfbMaxMs || 0) !== Number(a.ttfbMaxMs || 0)) {
          return Number(b.ttfbMaxMs || 0) - Number(a.ttfbMaxMs || 0);
        }
        return Number(b.count || 0) - Number(a.count || 0);
      })
      .slice(0, slowEstablishTopN);
    logger.warn(formatSlowSummaryLine(items, sourceItems.length));
    slowSummary.clear();
  }, slowEstablishSummaryIntervalMs).unref();

  for (let i = 0; i < workers; i += 1) {
    cluster.fork();
  }
  cluster.on('exit', (worker, code, signal) => {
    perWorkerMetrics.delete(worker.id);
    perWorkerDns.delete(worker.id);
    logger.warn(`[cluster] worker exit pid=${worker.process.pid} code=${code} signal=${signal}, restarting`);
    cluster.fork();
  });
} else {
  require(path.resolve(targetScript));
}

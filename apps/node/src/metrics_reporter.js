const path = require('path');
const { loadConfig } = require('./config');
const { createLogger } = require('./logger');

const cfg = loadConfig(path.resolve(__dirname, '../config/server.json'));
const logger = createLogger('metrics', cfg.logLevel);

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

process.on('message', (msg) => {
  if (!msg || typeof msg !== 'object') return;
  const type = String(msg.type || '');
  const payload = msg.payload || {};
  if (type === 'metrics_snapshot') {
    logger.info(formatMetricsLine(payload));
    return;
  }
  if (type === 'dns_summary') {
    logger.info(formatDnsSummaryLine(payload));
    return;
  }
  if (type === 'slow_summary') {
    const sourceItems = Array.isArray(payload.items) ? payload.items : [];
    if (sourceItems.length === 0) return;
    const topN = Math.max(1, Math.floor(Number(payload.topN || 5)));
    const items = sourceItems
      .sort((a, b) => {
        if (Number(b.ttfbMaxMs || 0) !== Number(a.ttfbMaxMs || 0)) {
          return Number(b.ttfbMaxMs || 0) - Number(a.ttfbMaxMs || 0);
        }
        return Number(b.count || 0) - Number(a.count || 0);
      })
      .slice(0, topN);
    logger.warn(formatSlowSummaryLine(items, sourceItems.length));
  }
});

process.on('disconnect', () => {
  process.exit(0);
});


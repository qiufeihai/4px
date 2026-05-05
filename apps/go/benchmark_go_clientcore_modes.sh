#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
CONFIG_PATH="$ROOT_DIR/config/client.json"
TEST_URL="https://206.119.179.201:8080/"
REQUESTS=1000
CONCURRENCY=120
CONCURRENCY_LIST=""
WARMUP=20
MAX_TIME=30
MODES="proxy,proxy-v2"
OUT_DIR=""
SUCCESS_THRESHOLD=""
P95_THRESHOLD_MS=""
KILL_LISTENERS=0

usage() {
  cat <<'EOF'
Usage:
  ./benchmark_go_clientcore_modes.sh [options]

Options:
  --config <path>            config path (default: ./config/client.json)
  --url <url>                target url (default: https://206.119.179.201:8080/)
  --requests <n>             requests per mode (default: 1000)
  --concurrency <n>          concurrency (default: 120)
  --concurrency-list <list>  e.g. 80,120,160,200 (overrides --concurrency)
  --warmup <n>               warmup requests per mode (default: 20)
  --max-time <sec>           curl max time (default: 30)
  --modes <list>             proxy,proxy-v2 (default: proxy,proxy-v2)
  --success-threshold <n>    success threshold percent, e.g. 99
  --p95-threshold-ms <n>     p95 threshold ms, e.g. 8000
  --kill-listeners           auto kill processes listening on client ports before each run
  --out <dir>                output dir (default: ./benchmarks_go/<timestamp>)
  -h, --help                 show help
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --config) CONFIG_PATH="$2"; shift 2 ;;
    --url) TEST_URL="$2"; shift 2 ;;
    --requests) REQUESTS="$2"; shift 2 ;;
    --concurrency) CONCURRENCY="$2"; shift 2 ;;
    --concurrency-list) CONCURRENCY_LIST="$2"; shift 2 ;;
    --warmup) WARMUP="$2"; shift 2 ;;
    --max-time) MAX_TIME="$2"; shift 2 ;;
    --modes) MODES="$2"; shift 2 ;;
    --success-threshold) SUCCESS_THRESHOLD="$2"; shift 2 ;;
    --p95-threshold-ms) P95_THRESHOLD_MS="$2"; shift 2 ;;
    --kill-listeners) KILL_LISTENERS=1; shift 1 ;;
    --out) OUT_DIR="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage; exit 1 ;;
  esac
done

if [[ -z "$OUT_DIR" ]]; then
  OUT_DIR="$ROOT_DIR/benchmarks_go/$(date +%Y%m%d_%H%M%S)"
fi
mkdir -p "$OUT_DIR"

if [[ ! -f "$CONFIG_PATH" ]]; then
  echo "Config not found: $CONFIG_PATH" >&2
  exit 1
fi
if ! command -v python3 >/dev/null 2>&1; then
  echo "python3 is required" >&2
  exit 1
fi
if ! command -v curl >/dev/null 2>&1; then
  echo "curl is required" >&2
  exit 1
fi
if ! command -v go >/dev/null 2>&1; then
  echo "go is required" >&2
  exit 1
fi

BACKUP_CONFIG="$OUT_DIR/client.json.backup"
cp "$CONFIG_PATH" "$BACKUP_CONFIG"

CLIENT_PID=""
BENCH_BIN="$OUT_DIR/4px_bench"
cleanup() {
  if [[ -n "${CLIENT_PID:-}" ]] && kill -0 "$CLIENT_PID" >/dev/null 2>&1; then
    kill "$CLIENT_PID" >/dev/null 2>&1 || true
    for _ in {1..30}; do
      if ! kill -0 "$CLIENT_PID" >/dev/null 2>&1; then
        break
      fi
      sleep 0.1
    done
    if kill -0 "$CLIENT_PID" >/dev/null 2>&1; then
      kill -9 "$CLIENT_PID" >/dev/null 2>&1 || true
    fi
    wait "$CLIENT_PID" 2>/dev/null || true
  fi
  cp "$BACKUP_CONFIG" "$CONFIG_PATH" || true
}
trap cleanup EXIT

set_mode() {
  local mode="$1"
  local path=""
  if [[ "$mode" == "proxy" ]]; then
    path="/proxy"
  elif [[ "$mode" == "proxy-v2" ]]; then
    path="/proxy-v2"
  else
    echo "Unsupported mode: $mode" >&2
    exit 1
  fi
  python3 - "$CONFIG_PATH" "$path" <<'PY'
import json, sys
cfg_path, mode_path = sys.argv[1], sys.argv[2]
cfg = json.load(open(cfg_path, "r", encoding="utf-8"))
cfg["upstream_path"] = mode_path
with open(cfg_path, "w", encoding="utf-8") as f:
    json.dump(cfg, f, ensure_ascii=False, indent=2)
    f.write("\n")
PY
}

read_http_proxy() {
  python3 - "$CONFIG_PATH" <<'PY'
import json, sys
cfg = json.load(open(sys.argv[1], "r", encoding="utf-8"))
listen = str(cfg.get("http_listen", "127.0.0.1:7788")).strip() or "127.0.0.1:7788"
print("http://" + listen)
PY
}

read_listen_addrs() {
  python3 - "$CONFIG_PATH" <<'PY'
import json, sys
cfg = json.load(open(sys.argv[1], "r", encoding="utf-8"))
socks = str(cfg.get("socks_listen", "127.0.0.1:7777")).strip() or "127.0.0.1:7777"
http = str(cfg.get("http_listen", "127.0.0.1:7788")).strip() or "127.0.0.1:7788"
print(socks)
print(http)
PY
}

wait_port_free() {
  local addr="$1"
  local port="${addr##*:}"
  for _ in {1..50}; do
    if ! lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.1
  done
  return 1
}

kill_port_listener() {
  local addr="$1"
  local port="${addr##*:}"
  local pids
  pids="$(lsof -t -iTCP:"$port" -sTCP:LISTEN 2>/dev/null | xargs || true)"
  [[ -z "$pids" ]] && return 0
  echo "Killing listeners on :$port -> $pids"
  kill $pids >/dev/null 2>&1 || true
  sleep 0.3
  local still
  still="$(lsof -t -iTCP:"$port" -sTCP:LISTEN 2>/dev/null | xargs || true)"
  if [[ -n "$still" ]]; then
    kill -9 $still >/dev/null 2>&1 || true
  fi
}

start_go_client() {
  local mode="$1"
  local c="$2"
  local log_file="$OUT_DIR/go_client_${mode}_c${c}.log"
  : > "$log_file"
  (cd "$ROOT_DIR" && exec "$BENCH_BIN" -c "$CONFIG_PATH" run >>"$log_file" 2>&1) &
  CLIENT_PID=$!
  sleep 1.2
  if ! kill -0 "$CLIENT_PID" >/dev/null 2>&1; then
    echo "Go client failed to start, check $log_file" >&2
    exit 1
  fi
}

stop_go_client() {
  if [[ -n "${CLIENT_PID:-}" ]] && kill -0 "$CLIENT_PID" >/dev/null 2>&1; then
    kill "$CLIENT_PID" >/dev/null 2>&1 || true
    for _ in {1..30}; do
      if ! kill -0 "$CLIENT_PID" >/dev/null 2>&1; then
        break
      fi
      sleep 0.1
    done
    if kill -0 "$CLIENT_PID" >/dev/null 2>&1; then
      kill -9 "$CLIENT_PID" >/dev/null 2>&1 || true
    fi
    wait "$CLIENT_PID" 2>/dev/null || true
  fi
  CLIENT_PID=""
}

run_requests() {
  local total="$1"
  local result_file="$2"
  local proxy_url="$3"
  : > "$result_file"
  export BENCH_URL="$TEST_URL"
  export BENCH_PROXY="$proxy_url"
  export BENCH_MAX_TIME="$MAX_TIME"
  export BENCH_RESULT_FILE="$result_file"
  seq "$total" | xargs -n1 -P "$CONCURRENCY" -I{} bash -c '
tmpf="$(mktemp)"
if out="$(curl -sS -o /dev/null -w "%{time_total},%{http_code}" -x "$BENCH_PROXY" "$BENCH_URL" --max-time "$BENCH_MAX_TIME" 2>"$tmpf")"; then
  t="${out%%,*}"
  code="${out##*,}"
  echo "$t,1,$code," >> "$BENCH_RESULT_FILE"
else
  rc="$?"
  err="$(tr "\n" " " < "$tmpf" | tr "," ";" | sed "s/[[:space:]]\+/ /g")"
  echo "0,0,0,exit_${rc}:${err}" >> "$BENCH_RESULT_FILE"
fi
rm -f "$tmpf"
'
}

summarize() {
  local mode="$1"
  local c="$2"
  local result_file="$3"
  local summary_file="$4"
  python3 - "$mode" "$c" "$result_file" "$summary_file" <<'PY'
import json, sys
mode, c, result_file, summary_file = sys.argv[1], int(sys.argv[2]), sys.argv[3], sys.argv[4]
ok_times = []
total = 0
ok = 0
errors = {}
with open(result_file, "r", encoding="utf-8") as f:
    for line in f:
        line = line.strip()
        if not line:
            continue
        total += 1
        t, ok_flag, _code, err = line.split(",", 3)
        if ok_flag == "1":
            ok += 1
            ok_times.append(float(t) * 1000.0)
        else:
            key = err[:160] if err else "unknown"
            errors[key] = errors.get(key, 0) + 1

def pct(arr, p):
    if not arr:
        return 0.0
    s = sorted(arr)
    k = (len(s)-1) * p
    f = int(k)
    n = min(f + 1, len(s)-1)
    if f == n:
        return s[f]
    return s[f] + (s[n] - s[f]) * (k - f)

summary = {
    "mode": mode,
    "concurrency": c,
    "total": total,
    "ok": ok,
    "failed": total - ok,
    "success_rate": round((ok / total * 100.0) if total else 0.0, 3),
    "latency_ms_avg": round((sum(ok_times) / len(ok_times)) if ok_times else 0.0, 3),
    "latency_ms_p50": round(pct(ok_times, 0.50), 3),
    "latency_ms_p95": round(pct(ok_times, 0.95), 3),
    "latency_ms_p99": round(pct(ok_times, 0.99), 3),
    "top_errors": sorted(errors.items(), key=lambda x: x[1], reverse=True)[:5],
}
with open(summary_file, "w", encoding="utf-8") as f:
    json.dump(summary, f, ensure_ascii=False, indent=2)
print(json.dumps(summary, ensure_ascii=False))
PY
}

write_compare_report() {
  python3 - "$OUT_DIR" <<'PY'
import json, os, sys
out_dir = sys.argv[1]
rows = []
for name in os.listdir(out_dir):
    if name.startswith("summary_") and name.endswith(".json"):
        rows.append(json.load(open(os.path.join(out_dir, name), "r", encoding="utf-8")))
rows.sort(key=lambda x: (x.get("concurrency", 0), x.get("mode", "")))

path = os.path.join(out_dir, "compare.md")
with open(path, "w", encoding="utf-8") as f:
    f.write("# Go Clientcore Mode Benchmark\n\n")
    f.write("| concurrency | mode | total | ok | failed | success_rate(%) | avg(ms) | p50(ms) | p95(ms) | p99(ms) |\n")
    f.write("|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|\n")
    for r in rows:
        f.write(f"| {r['concurrency']} | {r['mode']} | {r['total']} | {r['ok']} | {r['failed']} | {r['success_rate']} | {r['latency_ms_avg']} | {r['latency_ms_p50']} | {r['latency_ms_p95']} | {r['latency_ms_p99']} |\n")
print(path)
PY
}

write_verdict_report() {
  python3 - "$OUT_DIR" "$SUCCESS_THRESHOLD" "$P95_THRESHOLD_MS" <<'PY'
import json, os, sys
out_dir, succ_raw, p95_raw = sys.argv[1], sys.argv[2], sys.argv[3]
succ_thr = float(succ_raw) if succ_raw.strip() else None
p95_thr = float(p95_raw) if p95_raw.strip() else None
rows = []
for name in os.listdir(out_dir):
    if name.startswith("summary_") and name.endswith(".json"):
        rows.append(json.load(open(os.path.join(out_dir, name), "r", encoding="utf-8")))

group = {}
for r in rows:
    c = int(r["concurrency"])
    group.setdefault(c, {})[r["mode"]] = r

path = os.path.join(out_dir, "verdict.md")
with open(path, "w", encoding="utf-8") as f:
    f.write("# Benchmark Verdict\n\n")
    f.write(f"- success threshold: {succ_thr if succ_thr is not None else 'not set'}\n")
    f.write(f"- p95 threshold(ms): {p95_thr if p95_thr is not None else 'not set'}\n\n")
    f.write("| concurrency | proxy_success(%) | v2_success(%) | proxy_p95(ms) | v2_p95(ms) | v2_vs_proxy_p95(ms) | status |\n")
    f.write("|---:|---:|---:|---:|---:|---:|---|\n")
    for c in sorted(group.keys()):
        p = group[c].get("proxy")
        v = group[c].get("proxy-v2")
        if not p or not v:
            f.write(f"| {c} | - | - | - | - | - | INCOMPLETE |\n")
            continue
        status = "PASS"
        if succ_thr is not None and v["success_rate"] < succ_thr:
            status = "FAIL"
        if p95_thr is not None and v["latency_ms_p95"] > p95_thr:
            status = "FAIL"
        delta = round(v["latency_ms_p95"] - p["latency_ms_p95"], 3)
        f.write(f"| {c} | {p['success_rate']} | {v['success_rate']} | {p['latency_ms_p95']} | {v['latency_ms_p95']} | {delta} | {status} |\n")
print(path)
PY
}

HTTP_PROXY_URL="$(read_http_proxy)"
SOCKS_LISTEN="$(read_listen_addrs | sed -n '1p')"
HTTP_LISTEN="$(read_listen_addrs | sed -n '2p')"
echo "Output dir: $OUT_DIR"
echo "HTTP proxy listen: $HTTP_PROXY_URL"
echo "Test URL: $TEST_URL"
if [[ -n "$CONCURRENCY_LIST" ]]; then
  echo "Requests: $REQUESTS, ConcurrencyList: $CONCURRENCY_LIST, Warmup: $WARMUP"
else
  echo "Requests: $REQUESTS, Concurrency: $CONCURRENCY, Warmup: $WARMUP"
fi

echo "Building bench binary..."
(cd "$ROOT_DIR" && go build -o "$BENCH_BIN" ./cmd/4px)

IFS=',' read -r -a mode_arr <<< "$MODES"
if [[ -n "$CONCURRENCY_LIST" ]]; then
  IFS=',' read -r -a conc_arr <<< "$CONCURRENCY_LIST"
else
  conc_arr=("$CONCURRENCY")
fi

for c in "${conc_arr[@]}"; do
  c="$(echo "$c" | xargs)"
  [[ -z "$c" ]] && continue
  CONCURRENCY="$c"
  echo "==== Concurrency: $CONCURRENCY ===="
  for mode in "${mode_arr[@]}"; do
    mode="$(echo "$mode" | xargs)"
    [[ -z "$mode" ]] && continue
    echo "==== Mode: $mode ===="
    if [[ "$KILL_LISTENERS" == "1" ]]; then
      kill_port_listener "$SOCKS_LISTEN"
      kill_port_listener "$HTTP_LISTEN"
    fi
    wait_port_free "$SOCKS_LISTEN" || { echo "Port still busy: $SOCKS_LISTEN" >&2; exit 1; }
    wait_port_free "$HTTP_LISTEN" || { echo "Port still busy: $HTTP_LISTEN" >&2; exit 1; }
    set_mode "$mode"
    start_go_client "$mode" "$CONCURRENCY"
    if [[ "$WARMUP" -gt 0 ]]; then
      echo "Warmup $WARMUP..."
      run_requests "$WARMUP" "$OUT_DIR/warmup_${mode}_c${CONCURRENCY}.csv" "$HTTP_PROXY_URL"
    fi
    echo "Benchmark $REQUESTS..."
    run_requests "$REQUESTS" "$OUT_DIR/result_${mode}_c${CONCURRENCY}.csv" "$HTTP_PROXY_URL"
    summarize "$mode" "$CONCURRENCY" "$OUT_DIR/result_${mode}_c${CONCURRENCY}.csv" "$OUT_DIR/summary_${mode}_c${CONCURRENCY}.json"
    stop_go_client
    wait_port_free "$SOCKS_LISTEN" || { echo "Port release timeout: $SOCKS_LISTEN" >&2; exit 1; }
    wait_port_free "$HTTP_LISTEN" || { echo "Port release timeout: $HTTP_LISTEN" >&2; exit 1; }
  done
done

REPORT_PATH="$(write_compare_report)"
VERDICT_PATH="$(write_verdict_report)"
echo "Done. Report: $REPORT_PATH"
echo "Done. Verdict: $VERDICT_PATH"

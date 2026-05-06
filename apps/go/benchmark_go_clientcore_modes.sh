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
PROFILE=""
STARTUP_WAIT_SEC=12
REPEAT=1

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
  --profile <name>           preset: smoke|gradient|soak
  --repeat <n>               repeat each mode/concurrency run n times (default: 1)
  --startup-wait-sec <n>     max wait for proxy ready after client start (default: 12)
  --success-threshold <n>    success threshold percent, e.g. 99
  --p95-threshold-ms <n>     p95 threshold ms, e.g. 8000
  --kill-listeners           auto kill processes listening on client ports before each run
  --out <dir>                output dir (default: ./benchmarks_go/<timestamp>)
  -h, --help                 show help
EOF
}

apply_profile() {
  local profile="$1"
  case "$profile" in
    smoke)
      REQUESTS=300
      CONCURRENCY=80
      CONCURRENCY_LIST="40,80"
      WARMUP=10
      MAX_TIME=30
      ;;
    gradient)
      REQUESTS=500
      CONCURRENCY=160
      CONCURRENCY_LIST="80,120,160"
      WARMUP=20
      MAX_TIME=30
      ;;
    soak)
      REQUESTS=5000
      CONCURRENCY=120
      CONCURRENCY_LIST=""
      WARMUP=50
      MAX_TIME=30
      ;;
    *)
      echo "Unsupported profile: $profile (expected smoke|gradient|soak)" >&2
      exit 1
      ;;
  esac
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
    --profile) PROFILE="$2"; apply_profile "$PROFILE"; shift 2 ;;
    --repeat) REPEAT="$2"; shift 2 ;;
    --startup-wait-sec) STARTUP_WAIT_SEC="$2"; shift 2 ;;
    --success-threshold) SUCCESS_THRESHOLD="$2"; shift 2 ;;
    --p95-threshold-ms) P95_THRESHOLD_MS="$2"; shift 2 ;;
    --kill-listeners) KILL_LISTENERS=1; shift 1 ;;
    --out) OUT_DIR="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage; exit 1 ;;
  esac
done

if ! [[ "$REPEAT" =~ ^[0-9]+$ ]] || [[ "$REPEAT" -lt 1 ]]; then
  echo "--repeat must be a positive integer" >&2
  exit 1
fi

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
SAMPLER_PID=""
BENCH_BIN="$OUT_DIR/4px_bench"
cleanup() {
  if [[ -n "${SAMPLER_PID:-}" ]] && kill -0 "$SAMPLER_PID" >/dev/null 2>&1; then
    kill "$SAMPLER_PID" >/dev/null 2>&1 || true
    wait "$SAMPLER_PID" 2>/dev/null || true
  fi
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
  CLIENT_LOG_FILE="$log_file"
  : > "$log_file"
  (cd "$ROOT_DIR" && exec "$BENCH_BIN" -c "$CONFIG_PATH" run >>"$log_file" 2>&1) &
  CLIENT_PID=$!
  sleep 1.2
  if ! kill -0 "$CLIENT_PID" >/dev/null 2>&1; then
    echo "Go client failed to start, check $log_file" >&2
    exit 1
  fi
}

wait_proxy_ready() {
  local proxy_url="$1"
  local timeout_sec="$2"
  local start_ts now_ts
  start_ts="$(date +%s)"
  while true; do
    if curl -s -o /dev/null -x "$proxy_url" "$TEST_URL" --max-time 3 2>/dev/null; then
      return 0
    fi
    if [[ -n "${CLIENT_PID:-}" ]] && ! kill -0 "$CLIENT_PID" >/dev/null 2>&1; then
      echo "Go client exited before proxy became ready, check ${CLIENT_LOG_FILE:-unknown}" >&2
      return 1
    fi
    now_ts="$(date +%s)"
    if (( now_ts - start_ts >= timeout_sec )); then
      echo "Proxy not ready within ${timeout_sec}s: $proxy_url (log: ${CLIENT_LOG_FILE:-unknown})" >&2
      return 1
    fi
    sleep 0.2
  done
}

start_resource_sampler() {
  local resource_file="$1"
  : > "$resource_file"
  if [[ -z "${CLIENT_PID:-}" ]] || ! kill -0 "$CLIENT_PID" >/dev/null 2>&1; then
    return 0
  fi
  (
    while kill -0 "$CLIENT_PID" >/dev/null 2>&1; do
      local sample
      sample="$(ps -p "$CLIENT_PID" -o %cpu= -o rss= 2>/dev/null | awk 'NF >= 2 {print $1","$2; exit}')"
      if [[ -n "$sample" ]]; then
        echo "$sample" >> "$resource_file"
      fi
      sleep 1
    done
  ) &
  SAMPLER_PID=$!
}

stop_resource_sampler() {
  if [[ -n "${SAMPLER_PID:-}" ]] && kill -0 "$SAMPLER_PID" >/dev/null 2>&1; then
    kill "$SAMPLER_PID" >/dev/null 2>&1 || true
    wait "$SAMPLER_PID" 2>/dev/null || true
  fi
  SAMPLER_PID=""
}

stop_go_client() {
  stop_resource_sampler
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
  local resource_file="$5"
  python3 - "$mode" "$c" "$result_file" "$summary_file" "$resource_file" <<'PY'
import json, sys
mode, c, result_file, summary_file, resource_file = sys.argv[1], int(sys.argv[2]), sys.argv[3], sys.argv[4], sys.argv[5]
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

cpu_samples = []
rss_samples_kb = []
try:
    with open(resource_file, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            parts = line.split(",", 1)
            if len(parts) != 2:
                continue
            try:
                cpu_samples.append(float(parts[0]))
                rss_samples_kb.append(float(parts[1]))
            except ValueError:
                continue
except FileNotFoundError:
    pass

if cpu_samples:
    summary["cpu_pct_avg"] = round(sum(cpu_samples) / len(cpu_samples), 3)
    summary["cpu_pct_max"] = round(max(cpu_samples), 3)
else:
    summary["cpu_pct_avg"] = 0.0
    summary["cpu_pct_max"] = 0.0

if rss_samples_kb:
    summary["rss_mb_avg"] = round((sum(rss_samples_kb) / len(rss_samples_kb)) / 1024.0, 3)
    summary["rss_mb_max"] = round(max(rss_samples_kb) / 1024.0, 3)
else:
    summary["rss_mb_avg"] = 0.0
    summary["rss_mb_max"] = 0.0

summary["resource_samples"] = len(cpu_samples)
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
rows.sort(key=lambda x: (x.get("concurrency", 0), x.get("mode", ""), x.get("repeat", 1)))

path = os.path.join(out_dir, "compare.md")
with open(path, "w", encoding="utf-8") as f:
    f.write("# Go Clientcore Mode Benchmark\n\n")
    f.write("| repeat | concurrency | mode | total | ok | failed | success_rate(%) | avg(ms) | p50(ms) | p95(ms) | p99(ms) | cpu_avg(%) | cpu_max(%) | rss_avg(MB) | rss_max(MB) |\n")
    f.write("|---:|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|\n")
    for r in rows:
        f.write(f"| {r.get('repeat', 1)} | {r['concurrency']} | {r['mode']} | {r['total']} | {r['ok']} | {r['failed']} | {r['success_rate']} | {r['latency_ms_avg']} | {r['latency_ms_p50']} | {r['latency_ms_p95']} | {r['latency_ms_p99']} | {r.get('cpu_pct_avg', 0.0)} | {r.get('cpu_pct_max', 0.0)} | {r.get('rss_mb_avg', 0.0)} | {r.get('rss_mb_max', 0.0)} |\n")
print(path)
PY
}

write_median_report() {
  python3 - "$OUT_DIR" <<'PY'
import json, os, statistics, sys
out_dir = sys.argv[1]
rows = []
for name in os.listdir(out_dir):
    if name.startswith("summary_") and name.endswith(".json"):
        rows.append(json.load(open(os.path.join(out_dir, name), "r", encoding="utf-8")))

def median(vals):
    return round(float(statistics.median(vals)), 3) if vals else 0.0

group = {}
for r in rows:
    key = (int(r["concurrency"]), r["mode"])
    group.setdefault(key, []).append(r)

path = os.path.join(out_dir, "compare_median.md")
with open(path, "w", encoding="utf-8") as f:
    f.write("# Go Clientcore Mode Benchmark (Median)\n\n")
    f.write("| concurrency | mode | repeats | success_rate_med(%) | p50_med(ms) | p95_med(ms) | p99_med(ms) | cpu_avg_med(%) | rss_avg_med(MB) |\n")
    f.write("|---:|---|---:|---:|---:|---:|---:|---:|---:|\n")
    for (c, mode) in sorted(group.keys(), key=lambda x: (x[0], x[1])):
        items = group[(c, mode)]
        f.write(
            f"| {c} | {mode} | {len(items)} | {median([x['success_rate'] for x in items])} | {median([x['latency_ms_p50'] for x in items])} | {median([x['latency_ms_p95'] for x in items])} | {median([x['latency_ms_p99'] for x in items])} | {median([x.get('cpu_pct_avg', 0.0) for x in items])} | {median([x.get('rss_mb_avg', 0.0) for x in items])} |\n"
        )
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
    key = (int(r["concurrency"]), int(r.get("repeat", 1)))
    group.setdefault(key, {})[r["mode"]] = r

path = os.path.join(out_dir, "verdict.md")
with open(path, "w", encoding="utf-8") as f:
    f.write("# Benchmark Verdict\n\n")
    f.write(f"- success threshold: {succ_thr if succ_thr is not None else 'not set'}\n")
    f.write(f"- p95 threshold(ms): {p95_thr if p95_thr is not None else 'not set'}\n\n")
    f.write("| repeat | concurrency | proxy_success(%) | v2_success(%) | proxy_p95(ms) | v2_p95(ms) | v2_vs_proxy_p95(ms) | status |\n")
    f.write("|---:|---:|---:|---:|---:|---:|---:|---|\n")
    for key in sorted(group.keys()):
        c, repeat = key
        p = group[key].get("proxy")
        v = group[key].get("proxy-v2")
        if not p or not v:
            f.write(f"| {repeat} | {c} | - | - | - | - | - | INCOMPLETE |\n")
            continue
        status = "PASS"
        if succ_thr is not None and v["success_rate"] < succ_thr:
            status = "FAIL"
        if p95_thr is not None and v["latency_ms_p95"] > p95_thr:
            status = "FAIL"
        delta = round(v["latency_ms_p95"] - p["latency_ms_p95"], 3)
        f.write(f"| {repeat} | {c} | {p['success_rate']} | {v['success_rate']} | {p['latency_ms_p95']} | {v['latency_ms_p95']} | {delta} | {status} |\n")
print(path)
PY
}

write_median_verdict_report() {
  python3 - "$OUT_DIR" "$SUCCESS_THRESHOLD" "$P95_THRESHOLD_MS" <<'PY'
import json, os, statistics, sys
out_dir, succ_raw, p95_raw = sys.argv[1], sys.argv[2], sys.argv[3]
succ_thr = float(succ_raw) if succ_raw.strip() else None
p95_thr = float(p95_raw) if p95_raw.strip() else None
rows = []
for name in os.listdir(out_dir):
    if name.startswith("summary_") and name.endswith(".json"):
        rows.append(json.load(open(os.path.join(out_dir, name), "r", encoding="utf-8")))

def median(vals):
    return round(float(statistics.median(vals)), 3) if vals else 0.0

group = {}
for r in rows:
    c = int(r["concurrency"])
    group.setdefault(c, {}).setdefault(r["mode"], []).append(r)

path = os.path.join(out_dir, "verdict_median.md")
with open(path, "w", encoding="utf-8") as f:
    f.write("# Benchmark Verdict (Median)\n\n")
    f.write(f"- success threshold: {succ_thr if succ_thr is not None else 'not set'}\n")
    f.write(f"- p95 threshold(ms): {p95_thr if p95_thr is not None else 'not set'}\n\n")
    f.write("| concurrency | repeats | proxy_success_med(%) | v2_success_med(%) | proxy_p95_med(ms) | v2_p95_med(ms) | v2_vs_proxy_p95(ms) | status |\n")
    f.write("|---:|---:|---:|---:|---:|---:|---:|---|\n")
    for c in sorted(group.keys()):
        p = group[c].get("proxy", [])
        v = group[c].get("proxy-v2", [])
        repeats = min(len(p), len(v))
        if not p or not v:
            f.write(f"| {c} | {repeats} | - | - | - | - | - | INCOMPLETE |\n")
            continue
        p_succ = median([x["success_rate"] for x in p])
        v_succ = median([x["success_rate"] for x in v])
        p_p95 = median([x["latency_ms_p95"] for x in p])
        v_p95 = median([x["latency_ms_p95"] for x in v])
        delta = round(v_p95 - p_p95, 3)
        status = "PASS"
        if succ_thr is not None and v_succ < succ_thr:
            status = "FAIL"
        if p95_thr is not None and v_p95 > p95_thr:
            status = "FAIL"
        f.write(f"| {c} | {repeats} | {p_succ} | {v_succ} | {p_p95} | {v_p95} | {delta} | {status} |\n")
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
echo "Repeats: $REPEAT"

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
    for r in $(seq 1 "$REPEAT"); do
      echo "==== Mode: $mode (repeat $r/$REPEAT) ===="
      if [[ "$KILL_LISTENERS" == "1" ]]; then
        kill_port_listener "$SOCKS_LISTEN"
        kill_port_listener "$HTTP_LISTEN"
      fi
      wait_port_free "$SOCKS_LISTEN" || { echo "Port still busy: $SOCKS_LISTEN" >&2; exit 1; }
      wait_port_free "$HTTP_LISTEN" || { echo "Port still busy: $HTTP_LISTEN" >&2; exit 1; }
      set_mode "$mode"
      start_go_client "$mode" "$CONCURRENCY"
      wait_proxy_ready "$HTTP_PROXY_URL" "$STARTUP_WAIT_SEC"
      resource_file="$OUT_DIR/resource_${mode}_c${CONCURRENCY}_r${r}.csv"
      start_resource_sampler "$resource_file"
      if [[ "$WARMUP" -gt 0 ]]; then
        echo "Warmup $WARMUP..."
        run_requests "$WARMUP" "$OUT_DIR/warmup_${mode}_c${CONCURRENCY}_r${r}.csv" "$HTTP_PROXY_URL"
      fi
      echo "Benchmark $REQUESTS..."
      run_requests "$REQUESTS" "$OUT_DIR/result_${mode}_c${CONCURRENCY}_r${r}.csv" "$HTTP_PROXY_URL"
      stop_resource_sampler
      summary_file="$OUT_DIR/summary_${mode}_c${CONCURRENCY}_r${r}.json"
      summarize "$mode" "$CONCURRENCY" "$OUT_DIR/result_${mode}_c${CONCURRENCY}_r${r}.csv" "$summary_file" "$resource_file"
      python3 - "$summary_file" "$r" <<'PY'
import json, sys
path, repeat = sys.argv[1], int(sys.argv[2])
obj = json.load(open(path, "r", encoding="utf-8"))
obj["repeat"] = repeat
with open(path, "w", encoding="utf-8") as f:
    json.dump(obj, f, ensure_ascii=False, indent=2)
PY
      stop_go_client
      wait_port_free "$SOCKS_LISTEN" || { echo "Port release timeout: $SOCKS_LISTEN" >&2; exit 1; }
      wait_port_free "$HTTP_LISTEN" || { echo "Port release timeout: $HTTP_LISTEN" >&2; exit 1; }
    done
  done
done

REPORT_PATH="$(write_compare_report)"
VERDICT_PATH="$(write_verdict_report)"
MEDIAN_REPORT_PATH="$(write_median_report)"
MEDIAN_VERDICT_PATH="$(write_median_verdict_report)"
echo "Done. Report: $REPORT_PATH"
echo "Done. Verdict: $VERDICT_PATH"
echo "Done. Median report: $MEDIAN_REPORT_PATH"
echo "Done. Median verdict: $MEDIAN_VERDICT_PATH"

#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
CONFIG_PATH="$ROOT_DIR/config/client.json"
TEST_URL="https://example.com/"
REQUESTS=300
CONCURRENCY=80
CONCURRENCY_LIST=""
WARMUP=20
MAX_TIME=15
MODES="proxy,proxy-v2"
JOURNAL_UNIT=""
OUT_DIR=""
SUCCESS_THRESHOLD=""
P95_THRESHOLD_MS=""

usage() {
  cat <<'EOF'
Usage:
  ./benchmark_proxy_modes.sh [options]

Options:
  --config <path>         client.json path (default: ./config/client.json)
  --url <url>             test url (default: https://example.com/)
  --requests <n>          requests per mode (default: 300)
  --concurrency <n>       parallel workers (default: 80)
  --concurrency-list <l>  comma list, e.g. 80,120,160,200 (overrides --concurrency)
  --warmup <n>            warmup requests per mode (default: 20)
  --max-time <sec>        curl max time (default: 15)
  --modes <list>          comma list: proxy,proxy-v2 (default: proxy,proxy-v2)
  --success-threshold <n> pass threshold for success_rate(%), e.g. 99
  --p95-threshold-ms <n>  pass threshold for p95 latency(ms), e.g. 8000
  --journal-unit <name>   optional systemd unit for log counts (e.g. 4px)
  --out <dir>             output dir (default: ./benchmarks/<timestamp>)
  -h, --help              show this help

Examples:
  ./benchmark_proxy_modes.sh
  ./benchmark_proxy_modes.sh --requests 1000 --concurrency 200 --journal-unit 4px
  ./benchmark_proxy_modes.sh --concurrency-list 80,120,160,200 --success-threshold 99 --p95-threshold-ms 8000
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
    --journal-unit) JOURNAL_UNIT="$2"; shift 2 ;;
    --out) OUT_DIR="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage; exit 1 ;;
  esac
done

if [[ -z "$OUT_DIR" ]]; then
  OUT_DIR="$ROOT_DIR/benchmarks/$(date +%Y%m%d_%H%M%S)"
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

BACKUP_CONFIG="$OUT_DIR/client.json.backup"
cp "$CONFIG_PATH" "$BACKUP_CONFIG"

CLIENT_PID=""
cleanup() {
  if [[ -n "${CLIENT_PID:-}" ]] && kill -0 "$CLIENT_PID" >/dev/null 2>&1; then
    kill "$CLIENT_PID" >/dev/null 2>&1 || true
    wait "$CLIENT_PID" 2>/dev/null || true
  fi
  cp "$BACKUP_CONFIG" "$CONFIG_PATH" || true
}
trap cleanup EXIT

read_http_proxy() {
  python3 - "$CONFIG_PATH" <<'PY'
import json, sys
p = sys.argv[1]
cfg = json.load(open(p, "r", encoding="utf-8"))
http_listen = str(cfg.get("httpListen", "127.0.0.1:7788")).strip()
if not http_listen:
    http_listen = "127.0.0.1:7788"
print("http://" + http_listen)
PY
}

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
up = cfg.setdefault("upstream", {})
up["path"] = mode_path
with open(cfg_path, "w", encoding="utf-8") as f:
    json.dump(cfg, f, ensure_ascii=False, indent=2)
    f.write("\n")
PY
}

start_client() {
  local mode="$1"
  local log_file="$OUT_DIR/client_${mode}.log"
  : > "$log_file"
  (cd "$ROOT_DIR" && exec node src/client.js -c "$CONFIG_PATH" >>"$log_file" 2>&1) &
  CLIENT_PID=$!
  sleep 1.2
  if ! kill -0 "$CLIENT_PID" >/dev/null 2>&1; then
    echo "Client failed to start, check $log_file" >&2
    exit 1
  fi
}

stop_client() {
  if [[ -n "${CLIENT_PID:-}" ]] && kill -0 "$CLIENT_PID" >/dev/null 2>&1; then
    kill "$CLIENT_PID" >/dev/null 2>&1 || true
    for _ in {1..20}; do
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
  local concurrency="$2"
  local result_file="$3"
  local summary_file="$4"
  python3 - "$mode" "$concurrency" "$result_file" "$summary_file" <<'PY'
import csv, json, statistics, sys
mode, concurrency, result_file, summary_file = sys.argv[1], int(sys.argv[2]), sys.argv[3], sys.argv[4]
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
        t, ok_flag, code, err = line.split(",", 3)
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
    c = min(f + 1, len(s)-1)
    if f == c:
        return s[f]
    return s[f] + (s[c] - s[f]) * (k - f)

summary = {
    "mode": mode,
    "concurrency": concurrency,
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

collect_journal_counts() {
  local mode="$1"
  local concurrency="$2"
  local start_epoch="$3"
  local end_epoch="$4"
  local out_file="$OUT_DIR/journal_${mode}_c${concurrency}.log"
  local stat_file="$OUT_DIR/journal_${mode}_c${concurrency}_counts.txt"
  if [[ -z "$JOURNAL_UNIT" ]] || ! command -v journalctl >/dev/null 2>&1; then
    return 0
  fi
  journalctl -u "$JOURNAL_UNIT" --since "@$start_epoch" --until "@$end_epoch" > "$out_file" || true
  {
    echo "Invalid v2 target headers: $(grep -c 'Invalid v2 target headers' "$out_file" || true)"
    echo "mux remote error: $(grep -c 'mux remote error' "$out_file" || true)"
    echo "stream idle timeout: $(grep -c 'stream idle timeout' "$out_file" || true)"
    echo "remote idle timeout: $(grep -c 'remote idle timeout' "$out_file" || true)"
  } > "$stat_file"
}

write_compare_report() {
  python3 - "$OUT_DIR" <<'PY'
import json, os, sys
out_dir = sys.argv[1]
summary_files = []
for name in os.listdir(out_dir):
    if name.startswith("summary_") and name.endswith(".json"):
        summary_files.append(name)
rows = []
for name in summary_files:
    path = os.path.join(out_dir, name)
    rows.append(json.load(open(path, "r", encoding="utf-8")))
rows.sort(key=lambda x: (x.get("concurrency", 0), x.get("mode", "")))

report = os.path.join(out_dir, "compare.md")
with open(report, "w", encoding="utf-8") as f:
    f.write("# Proxy Mode Benchmark\n\n")
    f.write("| concurrency | mode | total | ok | failed | success_rate(%) | avg(ms) | p50(ms) | p95(ms) | p99(ms) |\n")
    f.write("|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|\n")
    for r in rows:
        f.write(f"| {r.get('concurrency', 0)} | {r['mode']} | {r['total']} | {r['ok']} | {r['failed']} | {r['success_rate']} | {r['latency_ms_avg']} | {r['latency_ms_p50']} | {r['latency_ms_p95']} | {r['latency_ms_p99']} |\n")
    f.write("\n")
    for r in rows:
        f.write(f"## c={r.get('concurrency', 0)} {r['mode']} top errors\n\n")
        if not r["top_errors"]:
            f.write("- none\n\n")
        else:
            for msg, cnt in r["top_errors"]:
                f.write(f"- {cnt}x `{msg}`\n")
            f.write("\n")
print(report)
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
    c = int(r.get("concurrency", 0))
    group.setdefault(c, {})[r["mode"]] = r

report = os.path.join(out_dir, "verdict.md")
with open(report, "w", encoding="utf-8") as f:
    f.write("# Benchmark Verdict\n\n")
    if succ_thr is None and p95_thr is None:
        f.write("- No threshold configured. Use `--success-threshold` and/or `--p95-threshold-ms`.\n")
    else:
        f.write(f"- success threshold: {succ_thr if succ_thr is not None else 'not set'}\n")
        f.write(f"- p95 threshold(ms): {p95_thr if p95_thr is not None else 'not set'}\n")
    f.write("\n")
    f.write("| concurrency | proxy_success(%) | v2_success(%) | proxy_p95(ms) | v2_p95(ms) | v2_vs_proxy_p95(ms) | status |\n")
    f.write("|---:|---:|---:|---:|---:|---:|---|\n")
    for c in sorted(group.keys()):
        proxy = group[c].get("proxy")
        v2 = group[c].get("proxy-v2")
        if not proxy or not v2:
            f.write(f"| {c} | - | - | - | - | - | INCOMPLETE |\n")
            continue
        status = "PASS"
        if succ_thr is not None and v2["success_rate"] < succ_thr:
            status = "FAIL"
        if p95_thr is not None and v2["latency_ms_p95"] > p95_thr:
            status = "FAIL"
        delta = round(v2["latency_ms_p95"] - proxy["latency_ms_p95"], 3)
        f.write(
            f"| {c} | {proxy['success_rate']} | {v2['success_rate']} | {proxy['latency_ms_p95']} | {v2['latency_ms_p95']} | {delta} | {status} |\n"
        )
print(report)
PY
}

HTTP_PROXY_URL="$(read_http_proxy)"
echo "Output dir: $OUT_DIR"
echo "HTTP proxy listen: $HTTP_PROXY_URL"
echo "Test URL: $TEST_URL"
if [[ -n "$CONCURRENCY_LIST" ]]; then
  echo "Requests: $REQUESTS, ConcurrencyList: $CONCURRENCY_LIST, Warmup: $WARMUP"
else
  echo "Requests: $REQUESTS, Concurrency: $CONCURRENCY, Warmup: $WARMUP"
fi

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
    set_mode "$mode"
    start_epoch="$(date +%s)"
    start_client "${mode}_c${CONCURRENCY}"
    if [[ "$WARMUP" -gt 0 ]]; then
      echo "Warmup $WARMUP..."
      run_requests "$WARMUP" "$OUT_DIR/warmup_${mode}_c${CONCURRENCY}.csv" "$HTTP_PROXY_URL"
    fi
    echo "Benchmark $REQUESTS..."
    run_requests "$REQUESTS" "$OUT_DIR/result_${mode}_c${CONCURRENCY}.csv" "$HTTP_PROXY_URL"
    summary_file="$OUT_DIR/summary_${mode}_c${CONCURRENCY}.json"
    summarize "$mode" "$CONCURRENCY" "$OUT_DIR/result_${mode}_c${CONCURRENCY}.csv" "$summary_file"
    stop_client
    end_epoch="$(date +%s)"
    collect_journal_counts "$mode" "$CONCURRENCY" "$start_epoch" "$end_epoch"
  done
done

REPORT_PATH="$(write_compare_report)"
VERDICT_PATH="$(write_verdict_report)"
echo "Done. Report: $REPORT_PATH"
echo "Done. Verdict: $VERDICT_PATH"

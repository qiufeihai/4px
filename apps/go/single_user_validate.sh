#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
BENCH_SCRIPT="$ROOT_DIR/benchmark_go_clientcore_modes.sh"

PROFILE="smoke"
REPEAT=2
SUCCESS_THRESHOLD=99
P95_THRESHOLD_MS=3000
OUT_DIR="$ROOT_DIR/benchmarks_go/single_user_$(date +%Y%m%d_%H%M%S)"
EXTRA_ARGS=()

usage() {
  cat <<'EOF'
Usage:
  ./single_user_validate.sh [options]

Options:
  --profile <name>           benchmark profile (default: smoke)
  --repeat <n>               repeat times (default: 2)
  --success-threshold <n>    v2 success threshold percent (default: 99)
  --p95-threshold-ms <n>     v2 p95 threshold ms (default: 3000)
  --out <dir>                output dir

Forward options to benchmark script:
  --config <path>
  --url <url>
  --requests <n>
  --concurrency <n>
  --concurrency-list <list>
  --warmup <n>
  --max-time <sec>
  --modes <list>
  --startup-wait-sec <sec>
  --kill-listeners

  -h, --help                 show help
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --profile) PROFILE="$2"; shift 2 ;;
    --repeat) REPEAT="$2"; shift 2 ;;
    --success-threshold) SUCCESS_THRESHOLD="$2"; shift 2 ;;
    --p95-threshold-ms) P95_THRESHOLD_MS="$2"; shift 2 ;;
    --out) OUT_DIR="$2"; shift 2 ;;
    --config|--url|--requests|--concurrency|--concurrency-list|--warmup|--max-time|--modes|--startup-wait-sec)
      EXTRA_ARGS+=("$1" "$2")
      shift 2
      ;;
    --kill-listeners)
      EXTRA_ARGS+=("$1")
      shift 1
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage
      exit 1
      ;;
  esac
done

if [[ ! -f "$BENCH_SCRIPT" ]]; then
  echo "Benchmark script not found: $BENCH_SCRIPT" >&2
  exit 1
fi

if ! [[ "$REPEAT" =~ ^[0-9]+$ ]] || [[ "$REPEAT" -lt 1 ]]; then
  echo "--repeat must be a positive integer" >&2
  exit 1
fi

mkdir -p "$OUT_DIR"

echo "== Single User Validate =="
echo "profile: $PROFILE"
echo "repeat: $REPEAT"
echo "success threshold: $SUCCESS_THRESHOLD"
echo "p95 threshold(ms): $P95_THRESHOLD_MS"
echo "out: $OUT_DIR"

bash "$BENCH_SCRIPT" \
  --profile "$PROFILE" \
  --repeat "$REPEAT" \
  --success-threshold "$SUCCESS_THRESHOLD" \
  --p95-threshold-ms "$P95_THRESHOLD_MS" \
  --kill-listeners \
  --out "$OUT_DIR" \
  "${EXTRA_ARGS[@]}"

SUMMARY_MD="$OUT_DIR/single_user_verdict.md"
python3 - "$OUT_DIR" "$SUCCESS_THRESHOLD" "$P95_THRESHOLD_MS" "$SUMMARY_MD" <<'PY'
import json
import os
import statistics
import sys

out_dir, succ_raw, p95_raw, out_md = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
succ_thr = float(succ_raw)
p95_thr = float(p95_raw)

rows = []
for name in os.listdir(out_dir):
    if name.startswith("summary_") and name.endswith(".json"):
        with open(os.path.join(out_dir, name), "r", encoding="utf-8") as f:
            rows.append(json.load(f))

if not rows:
    raise SystemExit("No summary_*.json found; benchmark may have failed.")

group = {}
for r in rows:
    c = int(r.get("concurrency", 0))
    mode = r.get("mode", "")
    group.setdefault(c, {}).setdefault(mode, []).append(r)

def med(values):
    return round(float(statistics.median(values)), 3) if values else 0.0

status_all = "PASS"
lines = []
lines.append("# Single User Validation Verdict\n")
lines.append(f"- success threshold: {succ_thr}")
lines.append(f"- p95 threshold(ms): {p95_thr}\n")
lines.append("| concurrency | repeats | v2_success_med(%) | v2_p95_med(ms) | status |")
lines.append("|---:|---:|---:|---:|---|")

for c in sorted(group.keys()):
    v2 = group[c].get("proxy-v2", [])
    repeats = len(v2)
    if repeats == 0:
        status = "INCOMPLETE"
        status_all = "FAIL"
        lines.append(f"| {c} | 0 | - | - | {status} |")
        continue
    v2_succ = med([x.get("success_rate", 0.0) for x in v2])
    v2_p95 = med([x.get("latency_ms_p95", 0.0) for x in v2])
    status = "PASS"
    if v2_succ < succ_thr or v2_p95 > p95_thr:
        status = "FAIL"
        status_all = "FAIL"
    lines.append(f"| {c} | {repeats} | {v2_succ} | {v2_p95} | {status} |")

lines.append("")
lines.append(f"- overall: **{status_all}**")
lines.append("- note: 当前版本暂不支持移动端；移动端支持后再补测前后台切换/锁屏唤醒/手动断网恢复。")
content = "\n".join(lines) + "\n"

with open(out_md, "w", encoding="utf-8") as f:
    f.write(content)

print(content)
PY

echo "Single-user summary: $SUMMARY_MD"
echo "Bench verdict: $OUT_DIR/verdict.md"
echo "Bench median verdict: $OUT_DIR/verdict_median.md"

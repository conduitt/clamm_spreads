#!/usr/bin/env bash
set -euo pipefail
DAY="data/daily/$(date -u +%F)"
OUT="$DAY/all.csv"
first=$(find "$DAY" -name '*.csv' | head -n1) || true
[ -z "$first" ] && { echo "no csv"; exit 0; }
head -n1 "$first" > "$OUT"
find "$DAY" -name '*.csv' -print0 | xargs -0 -I{} tail -n +2 "{}" >> "$OUT"
echo "merged -> $OUT"

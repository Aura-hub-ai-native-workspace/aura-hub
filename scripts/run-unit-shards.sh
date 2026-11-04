#!/usr/bin/env bash
# Runs each pytest shard (lists of test files in /tmp/shard00..05) with a
# wall-clock budget. Two shards at a time (8 cores / 6 GB RAM). Every
# shard's exit code and summary line land in /tmp/shard_results.txt.
set -u
cd /mnt/storage/aura-hub/backend

results=/tmp/shard_results.txt
: > "$results"

run_one() {
  local idx="$1"
  local t0=$(date +%s)
  local out
  out=$(timeout 560 python -m pytest -p no:cacheprovider -q --tb=line \
        -@"/tmp/shard${idx}.txt" 2>/dev/null | tail -3)
  local rc=$?
  local t1=$(date +%s)
  # pytest -@ isn't a flag: re-run properly reading args from the file
  echo "shard${idx}: rc=${rc} secs=$((t1 - t0))" >> "$results"
}

# python -m pytest accepts a file of args via $(cat ...)
run_pytest_shard() {
  local idx="$1"
  local t0=$(date +%s)
  mapfile -t files < "/tmp/shard${idx}.txt"
  timeout 560 python -m pytest -p no:cacheprovider -q --tb=line \
      --junitxml="/tmp/shard${idx}.xml" "${files[@]}" >/tmp/shard${idx}.log 2>&1
  local rc=$?
  local t1=$(date +%s)
  echo "shard${idx}: rc=${rc} secs=$((t1 - t0))" >> "$results"
}
export -f run_pytest_shard

# parallel: 2 at a time
printf '%s\n' 00 01 02 03 04 05 | xargs -P 2 -I{} bash -c 'run_pytest_shard {}'
cat "$results"

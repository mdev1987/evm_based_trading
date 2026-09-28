#!/bin/sh
# oxmgr health probe for evm-trading-bot (v2.0.0).
# The status loop prints every STATUS_INTERVAL_MS (default 10s) and rewrites
# per-chain state files (.data/<mode>/<chain>.json) on each status cycle and
# on every trade, so a fresh mtime means the event loop is alive.
# Stale state (>3 min) means the loop is stuck or wedged on I/O.
# Missing files = fresh boot (no state written yet), pass so the first check
# does not kill startup.
BASE_DIR="/home/mdev/Programming/evm_based_trading/.data"
# No state dir yet -> fresh boot, pass.
test ! -d "$BASE_DIR" && exit 0
# No state files yet -> fresh boot, pass.
if test -z "$(/usr/bin/find "$BASE_DIR" -name '*.json' -print -quit 2>/dev/null)"; then
  exit 0
fi
# Fail if every state file is older than 3 minutes.
test -n "$(/usr/bin/find "$BASE_DIR" -name '*.json' -mmin -3 -print -quit 2>/dev/null)"

#!/usr/bin/env bash
# App and data backtest entry point; see tools/backtest/app/README.md.
#   tools/backtest/app/run.sh [--base origin/master] [--export <dump.json>] [--skip-rules] [--e2e]
export PATH="$HOME/.local/bin:$HOME/development/flutter/bin:$PATH"
cd "$(dirname "$0")/../../.." && exec node tools/backtest/app/run.mjs "$@"

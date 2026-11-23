#!/usr/bin/env bash
# Background watcher intended to be run as a WebStorm startup task (.idea/startup.xml).
# Polls for new real CLAUDE.md files every few seconds and
# captures them immediately via capture-scan.sh, so a file created interactively
# (e.g. by an editor or an agent session) gets redirected without waiting for the
# next branch switch or commit.
set -uo pipefail

ROOT="$(git rev-parse --show-toplevel)"
INTERVAL="${JSR_WATCH_INTERVAL:-3}"

echo "[claude-sync] watching for new CLAUDE.md files (interval: ${INTERVAL}s)"

while true; do
    "$ROOT/.claude-sync/capture-scan.sh"
    sleep "$INTERVAL"
done

#!/usr/bin/env bash
set -uo pipefail

REPO_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$REPO_DIR"

npm ci
npx @biomejs/biome check --reporter=github --max-diagnostics=100
echo "biome-check-exit=$?"

#!/usr/bin/env bash

set -eu -o pipefail

# Mount .plain-agent/ as read-only over the writable project root, then
# re-overlay the agent's scratch directories as writable. This prevents
# in-sandbox modification of host-executed scripts (sandbox/run.sh,
# setup.sh) and agent config (config.json, prompts/, agents/, ...).
project_root=$(git rev-parse --show-toplevel 2> /dev/null || pwd)
metadata_dir="$project_root/.plain-agent"
mkdir -p \
  "$metadata_dir/memory" \
  "$metadata_dir/tmp" \
  "$metadata_dir/claude-code-plugins"

plain-sandbox --dockerfile .plain-agent/sandbox/Dockerfile \
  --volume plain-sandbox--global--home-npm:/home/node/.npm \
  --volume node_modules \
  --allow-write \
  --mount-readonly "$metadata_dir:$metadata_dir" \
  --mount-writable "$metadata_dir/memory:$metadata_dir/memory" \
  --mount-writable "$metadata_dir/tmp:$metadata_dir/tmp" \
  --mount-writable "$metadata_dir/claude-code-plugins:$metadata_dir/claude-code-plugins" \
  --mount-readonly ~/.gitconfig:/home/node/.gitconfig \
  --allow-net bedrock-runtime.ap-northeast-1.amazonaws.com \
  "$@"

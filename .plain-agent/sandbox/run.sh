#!/usr/bin/env bash

set -eu -o pipefail

# Mount .plain-agent/ as read-only over the writable project root, then
# re-overlay only memory/ and tmp/ as writable scratch space. claude-code-plugins/
# is populated by `plain install-claude-code-plugins` on the host, so it does
# not need write access from inside the sandbox.
working_dir=$(pwd)
metadata_dir="$working_dir/.plain-agent"
mkdir -p \
  "$metadata_dir/memory" \
  "$metadata_dir/tmp"

plain-sandbox --dockerfile .plain-agent/sandbox/Dockerfile \
  --volume plain-sandbox--global--home-npm:/home/node/.npm \
  --volume node_modules \
  --allow-write \
  --mount-readonly "$metadata_dir:$metadata_dir" \
  --mount-writable "$metadata_dir/memory:$metadata_dir/memory" \
  --mount-writable "$metadata_dir/tmp:$metadata_dir/tmp" \
  --mount-readonly ~/.gitconfig:/home/node/.gitconfig \
  --allow-net bedrock-runtime.ap-northeast-1.amazonaws.com \
  "$@"

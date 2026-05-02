#!/usr/bin/env bash

set -eu -o pipefail

script_path=$(realpath "${BASH_SOURCE[0]}")

plain-sandbox --dockerfile .plain-agent/sandbox/Dockerfile \
  --volume plain-sandbox--global--home-npm:/home/node/.npm \
  --volume node_modules \
  --allow-write \
  --mount-readonly "$script_path:$script_path" \
  --mount-readonly ~/.gitconfig:/home/node/.gitconfig \
  --allow-net bedrock-runtime.ap-northeast-1.amazonaws.com \
  "$@"

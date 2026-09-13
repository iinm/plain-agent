#!/bin/sh
# Usage: route-keeper.sh <gateway-ip>
# Shares the netns of the target container (network_mode: service:<target>) and
# holds NET_ADMIN so the target itself never needs it.
set -eu
GW="$1"
while :; do
  if ! ip route show default 2>/dev/null | grep -q "via ${GW}"; then
    ip route replace default via "$GW"
    echo "[route-keeper] default via ${GW} set" >&2
  fi
  sleep 5
done

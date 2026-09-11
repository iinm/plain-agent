#!/bin/sh
# gateway readiness: all setup finished + dnsmasq answering
set -eu
[ -f /gateway-ready ]
dig @127.0.0.1 "${HEALTHCHECK_DOMAIN:-example.com}" +short +time=2 +tries=1 \
  | grep -qE '^[0-9]+(\.[0-9]+){3}$'

#!/usr/bin/env bash
# ============================================================
# agent-sandbox verification. Prerequisite: docker compose up -d
# Multiple instances: export the variables used for docker compose
# (COMPOSE_PROJECT_NAME, GATEWAY_IP, ...). See README.md
# ============================================================
set -u -o pipefail

# Same variables/defaults as docker-compose.yml
COMPOSE_PROJECT_NAME=${COMPOSE_PROJECT_NAME:-agent}
GATEWAY_IP=${GATEWAY_IP:-172.28.200.100}
DIND_IP=${DIND_IP:-172.28.200.20}
HEALTHCHECK_DOMAIN=${HEALTHCHECK_DOMAIN:-example.com}


INTERNAL_SUBNET=${INTERNAL_SUBNET:-172.28.200.0/24}
INTERNAL_GW=${INTERNAL_GW:-172.28.200.1}

# per-run temp file (concurrent runs must not collide)
ERR=$(mktemp "${COMPOSE_PROJECT_NAME}-verify.XXXXXX")
trap 'rm -f "$ERR"' EXIT

ALLOW_HOST=${ALLOW_HOST:-github.com}  # in ALLOWED_HTTPS_DOMAINS (positive test)
HTTP_ALLOW_HOST=${HTTP_ALLOW_HOST:-archive.ubuntu.com}  # in ALLOWED_HTTP_HOSTS (positive test)
DENY_HOST=${DENY_HOST:-example.org}  # in no allow list

PASS=0 FAIL=0
pass() { echo "  OK   $*"; PASS=$((PASS + 1)); }
fail() { echo "  NG   $*"; FAIL=$((FAIL + 1)); }
info() { echo "  INFO $*"; }
section() { echo; echo "== $* =="; }

section "Startup check"
for s in gateway envoy sandbox dind route-keeper-sandbox route-keeper-dind; do
  c="${COMPOSE_PROJECT_NAME}-${s}"
  st=$(docker inspect -f '{{.State.Status}}' "$c" 2>/dev/null || echo missing)
  if [ "$st" = "running" ]; then
    pass "$c is running"
  else
    fail "$c is not running (${st}). Check docker compose up -d"
  fi
done

# dockerd may still be starting after the port forward opens, so poll
section "Waiting for dind"
ok=""
for _ in $(seq 1 30); do
  if docker exec "${COMPOSE_PROJECT_NAME}-sandbox" docker info >/dev/null 2>&1; then ok=1; break; fi
  sleep 2
done
if [ -n "$ok" ]; then
  pass "docker info from sandbox succeeded (dind dockerd is ready)"
else
  fail "docker info did not succeed (check dind logs and TLS certs)"
fi

section "Capabilities"
sandbox_caps=$(docker inspect "${COMPOSE_PROJECT_NAME}-sandbox" --format '{{.HostConfig.CapAdd}}')
if [ "$sandbox_caps" = "[]" ] || [ "$sandbox_caps" = "<no value>" ]; then
  pass "sandbox has no extra capabilities (${sandbox_caps})"
else
  fail "sandbox has unexpected capabilities: ${sandbox_caps}"
fi
internal=$(docker network inspect "${COMPOSE_PROJECT_NAME}-internal" --format '{{.Internal}}')
if [ "$internal" = "true" ]; then
  pass "internal network is internal (no route out of the network itself; a gateway failure blocks traffic instead of bypassing it)"
else
  fail "internal network is not internal"
fi
privileged=$(docker inspect "${COMPOSE_PROJECT_NAME}-dind" --format '{{.HostConfig.Privileged}}')
if [ "$privileged" = "false" ]; then
  pass "dind runs unprivileged (cap_drop is honored; no kernel guardrails removed)"
else
  fail "dind is privileged (cap_drop is silently ignored on privileged containers)"
fi
info "Only gateway and route-keeper-* hold NET_ADMIN (they set sandbox/dind routes from outside)"

section "Default gateway"
for s in sandbox dind; do
  c="${COMPOSE_PROJECT_NAME}-${s}"
  route=$(docker exec "$c" ip route show default 2>/dev/null)
  if echo "$route" | grep -q "via $GATEWAY_IP"; then
    pass "$c default gateway points at gateway (${route})"
  else
    fail "$c default gateway is unexpected: ${route}"
  fi
done

section "Gateway filter rules"
# grep -q exits early and kills the docker exec upstream with SIGPIPE (141);
# a full-read grep avoids it
if docker exec "${COMPOSE_PROJECT_NAME}-gateway" iptables -S FORWARD 2>/dev/null | grep -- '-P FORWARD DROP' >/dev/null; then
  pass "FORWARD policy is DROP"
else
  fail "FORWARD policy is not DROP"
fi
if docker exec "${COMPOSE_PROJECT_NAME}-gateway" iptables -t nat -S PREROUTING 2>/dev/null | grep 'REDIRECT.*10443' >/dev/null; then
  pass "443 is redirected to Envoy (10443)"
else
  fail "no redirect rule for 443"
fi
if docker exec "${COMPOSE_PROJECT_NAME}-gateway" iptables -t nat -S PREROUTING 2>/dev/null | grep 'REDIRECT.*10080' >/dev/null; then
  pass "80 is redirected to Envoy (10080)"
else
  fail "no redirect rule for 80"
fi

section "Allowed domain (HTTPS)"
code=$(docker exec "${COMPOSE_PROJECT_NAME}-sandbox" curl -sS -o /dev/null -m 8 -w '%{http_code}' "https://${ALLOW_HOST}" 2>/dev/null || echo fail)
if echo "$code" | grep -qE '^[23]'; then
  pass "sandbox -> https://${ALLOW_HOST} reachable (passed Envoy filter_chain_match)"
else
  fail "sandbox -> https://${ALLOW_HOST} failed (${code}). Check ALLOWED_HTTPS_DOMAINS and envoy logs"
fi

section "Denied domain (HTTPS)"
# DENY_HOST is in no allow list, so the resolver refuses it before any connection
if docker exec "${COMPOSE_PROJECT_NAME}-sandbox" curl -sS -o /dev/null -m 8 "https://${DENY_HOST}" >/dev/null 2>"$ERR"; then
  fail "sandbox -> https://${DENY_HOST} went through. Check the dnsmasq allow-list"
else
  pass "sandbox -> https://${DENY_HOST} is rejected (not in the DNS allow-list)"
  head -1 "$ERR" | sed 's/^/    /'
fi
# HEALTHCHECK_DOMAIN resolves (canary rule) but is in no SNI list: isolates the Envoy check
if docker exec "${COMPOSE_PROJECT_NAME}-sandbox" curl -sS -o /dev/null -m 8 "https://${HEALTHCHECK_DOMAIN}" >/dev/null 2>"$ERR"; then
  fail "sandbox -> https://${HEALTHCHECK_DOMAIN} went through. Check the Envoy allow list"
else
  pass "sandbox -> https://${HEALTHCHECK_DOMAIN} is rejected (resolves, then SNI mismatch)"
  head -1 "$ERR" | sed 's/^/    /'
fi


section "DNS lockdown"
# timeout kills dig with SIGTERM and dig exits 0; use dig's own +time/+tries (rc=9)
if docker exec "${COMPOSE_PROJECT_NAME}-sandbox" dig @8.8.8.8 "$ALLOW_HOST" +short +time=2 +tries=1 >/dev/null 2>&1; then
  fail "sandbox can query an arbitrary DNS server (8.8.8.8) directly"
else
  pass "sandbox -> 8.8.8.8:53 direct query fails (dropped by FORWARD)"
fi
ans=$(docker exec "${COMPOSE_PROJECT_NAME}-sandbox" dig "@$GATEWAY_IP" "$ALLOW_HOST" +short 2>/dev/null | grep -E '^[0-9]+\.' | head -1)
if [ -n "$ans" ]; then
  pass "gateway dnsmasq resolves (${ALLOW_HOST} -> ${ans})"
else
  fail "gateway dnsmasq cannot resolve"
fi
if docker exec "${COMPOSE_PROJECT_NAME}-sandbox" dig "@$GATEWAY_IP" "$DENY_HOST" +short +time=2 +tries=1 2>/dev/null | grep -qE '^[0-9]+\.'; then
  fail "gateway dnsmasq resolves non-allowed ${DENY_HOST} (allow-list not applied)"
else
  pass "gateway dnsmasq refuses non-allowed names (${DENY_HOST} gets no answer)"
fi

section "Plain HTTP (port 80)"
# ALLOW_HOST resolves (it is in the DNS allow-list) but is not an HTTP vhost:
# a direct-IP request isolates the Host-header check from name resolution
deny_ip=$(docker exec "${COMPOSE_PROJECT_NAME}-sandbox" dig "@$GATEWAY_IP" "$ALLOW_HOST" +short 2>/dev/null | grep -E '^[0-9]+\.' | head -1)
code=$(docker exec "${COMPOSE_PROJECT_NAME}-sandbox" curl -sS -o /dev/null -m 8 -w '%{http_code}' "http://${deny_ip}" 2>/dev/null || echo fail)
if [ "$code" = "403" ]; then
  pass "sandbox -> http://${deny_ip} (80, Host header not allow-listed) gets 403 from Envoy"
else
  fail "sandbox -> http://${deny_ip} (80) returned ${code} (expected 403)"
fi

code=$(docker exec "${COMPOSE_PROJECT_NAME}-sandbox" curl -sS -o /dev/null -m 8 -w '%{http_code}' "http://${ALLOW_HOST}" 2>/dev/null || echo fail)
if [ "$code" = "403" ]; then
  pass "sandbox -> http://${ALLOW_HOST} (80, resolvable but not in ALLOWED_HTTP_HOSTS) gets 403"
else
  fail "sandbox -> http://${ALLOW_HOST} (80) returned ${code} (expected 403)"
fi

code=$(docker exec "${COMPOSE_PROJECT_NAME}-sandbox" curl -sS -o /dev/null -m 8 -w '%{http_code}' "http://${HTTP_ALLOW_HOST}" 2>/dev/null || echo fail)
if echo "$code" | grep -qE '^[23]'; then
  pass "sandbox -> http://${HTTP_ALLOW_HOST} (Host-header allow) is reachable"
else
  fail "port-80 allow for http://${HTTP_ALLOW_HOST} is not working (${code})"
fi

section "IPv6"
if docker exec "${COMPOSE_PROJECT_NAME}-sandbox" sh -c "ip -6 addr show scope global 2>/dev/null | grep -q inet6"; then
  fail "sandbox has a global IPv6 address"
else
  pass "sandbox has no global IPv6 address"
fi

section "Docker API (sandbox -> dind)"
ver=$(docker exec "${COMPOSE_PROJECT_NAME}-sandbox" docker version --format '{{.Server.Version}}' 2>/dev/null || true)
if [ -n "$ver" ]; then
  pass "sandbox talks to the dind docker daemon via DOCKER_HOST (TLS) (server=${ver})"
else
  fail "sandbox -> dind Docker API failed. Check DOCKER_HOST/TLS settings"
fi

section "Image pull via dind"
if docker exec "${COMPOSE_PROJECT_NAME}-sandbox" docker run --rm hello-world 2>/dev/null | grep "Hello from Docker" >/dev/null; then
  pass "sandbox -> dind pulled and ran hello-world (registry traffic passed Envoy's SNI allow)"
else
  fail "docker run hello-world on dind failed (pull: registry allow-list; start: proc mount). Check dind logs"
fi

section "L2/L3 bypass countermeasures"

for s in sandbox dind route-keeper-sandbox route-keeper-dind; do
  c="${COMPOSE_PROJECT_NAME}-${s}"
  # CapBnd, not CapEff: exec'd dind processes run as uid 1000 and have CapEff=0
  # even when cap_drop is ignored, so only the bounding set proves the drop
  cap=$(docker exec "$c" sh -c 'grep CapBnd /proc/self/status' 2>/dev/null | awk '{print $2}')
  if [ -n "$cap" ] && [ "$((16#$cap & 16#2000))" -eq 0 ]; then
    pass "$c has no CAP_NET_RAW (cannot spoof L2 frames via AF_PACKET)"
  else
    fail "$c holds CAP_NET_RAW (can spoof L2 frames)"
  fi
done

if docker exec "${COMPOSE_PROJECT_NAME}-gateway" ip6tables -S FORWARD 2>/dev/null | grep -- '-P FORWARD DROP' >/dev/null; then
  pass "gateway ip6tables FORWARD policy is DROP (IPv6 side closed too)"
else
  fail "gateway ip6tables FORWARD policy is not DROP"
fi

# internal: true is implemented by the host DOCKER-INTERNAL chain (see README)
brname="br-$(docker network inspect "${COMPOSE_PROJECT_NAME}-internal" --format '{{.Id}}' | cut -c1-12)"
# iptables -S option order varies by version; match 3 conditions instead of exact text
host_rule=$(docker run --rm --net host --cap-add NET_ADMIN \
  --entrypoint iptables "${COMPOSE_PROJECT_NAME}/gateway:latest" -S DOCKER-INTERNAL 2>/dev/null \
  | grep -- "-i ${brname}" | grep -- "! -d ${INTERNAL_SUBNET}" | grep -- '-j DROP')
if [ -n "$host_rule" ]; then
  pass "host DOCKER-INTERNAL blocks the internal bridge -> outside (second layer against L2/L3 direct hits)"
else
  fail "host-side internal block rule not found (check Docker behavior)"
fi

# deliberately point the route at the host: the block must still hold, and route-keeper must repair it
docker exec "${COMPOSE_PROJECT_NAME}-route-keeper-sandbox" ip route replace default via "${INTERNAL_GW}" 2>/dev/null
route_at=$(docker exec "${COMPOSE_PROJECT_NAME}-sandbox" ip route show default 2>/dev/null)
dns_rc=0
docker exec "${COMPOSE_PROJECT_NAME}-sandbox" dig @8.8.8.8 "$ALLOW_HOST" +short +time=2 +tries=1 >/dev/null 2>&1 || dns_rc=$?
web_rc=0
docker exec "${COMPOSE_PROJECT_NAME}-sandbox" curl -sS -m 3 -o /dev/null "http://${DENY_HOST}/" >/dev/null 2>&1 || web_rc=$?
sleep 8
route_after=$(docker exec "${COMPOSE_PROJECT_NAME}-sandbox" ip route show default 2>/dev/null)
if [ "$dns_rc" -ne 0 ] && [ "$web_rc" -ne 0 ]; then
  pass "denied traffic still fails with the route pointed at the host (DOCKER-INTERNAL blocks it)"
  info "route during test: ${route_at}"
  info "route after test: ${route_after} <- repaired by route-keeper"
else
  fail "the route change let denied traffic through (check the host-side block rule)"
fi

# known limitation: the bridge IP is the host itself, reached via INPUT, bypassing the gateway
info "Known limitation: traffic to ${INTERNAL_GW} (bridge gw IP = host) bypasses the gateway filter"
info "  (straight to host INPUT. Host service exposure is outside this compose's scope)"

echo
echo "Verification done: OK=${PASS} NG=${FAIL}"
[ "$FAIL" -eq 0 ] || exit 1

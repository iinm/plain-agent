#!/bin/bash
# gateway: the only exit from the sandbox internal network
set -euo pipefail

log() { echo "[gateway] $*" >&2; }

: "${ALLOWED_HTTPS_DOMAINS:?ALLOWED_HTTPS_DOMAINS is not set}"
: "${ALLOWED_HTTP_HOSTS:?ALLOWED_HTTP_HOSTS is not set}"

: "${DNS_UPSTREAM:=8.8.8.8 8.8.4.4}"
: "${INTERNAL_SUBNET:?INTERNAL_SUBNET is not set}"
: "${EGRESS_GW:?EGRESS_GW is not set}"
: "${HEALTHCHECK_DOMAIN:=example.com}"

# egress = the interface on a non-internal subnet. ip link names (eth0@ifN) are
# hard to parse, so decide from link-scope routes; the internal side may win the
# default route, so replace it explicitly
find_egress_if() {
  ip -o -4 route show scope link 2>/dev/null \
    | awk -v internal="$INTERNAL_SUBNET" '$3 != "lo" && $1 != internal {print $3; exit}'
}

EGRESS_IF=""
for _ in $(seq 1 30); do
  EGRESS_IF=$(find_egress_if 2>/dev/null || true)
  if [ -n "$EGRESS_IF" ]; then break; fi
  sleep 1
done
if [ -z "$EGRESS_IF" ]; then
  log "ERROR: egress interface not found (check INTERNAL_SUBNET=${INTERNAL_SUBNET})"
  exit 1
fi
ip route replace default via "$EGRESS_GW" dev "$EGRESS_IF"
log "egress: ${EGRESS_IF} (default via ${EGRESS_GW})"

{
  # caution: 0.0.0.0 in dnsmasq is not a wildcard; it answers only queries addressed
  # to 0.0.0.0 and silently drops the rest. Do not set listen-address
  echo "no-resolv"
  echo "no-poll"
  echo "log-queries"
  echo "log-facility=-"
  # allow-only DNS: listed names are forwarded, anything else gets SERVFAIL.
  # The list comes from the same env vars as the connection filters, so queries
  # can never name an attacker-controlled zone (closes DNS exfiltration)
  for d in $ALLOWED_HTTPS_DOMAINS $ALLOWED_HTTP_HOSTS $HEALTHCHECK_DOMAIN; do
    for s in $DNS_UPSTREAM; do echo "server=/${d}/${s}"; done
  done
} > /etc/dnsmasq.conf
dnsmasq -k -C /etc/dnsmasq.conf &
log "dnsmasq started (allow-only, upstream: ${DNS_UPSTREAM})"

for _ in $(seq 1 20); do
  if dig @127.0.0.1 "$HEALTHCHECK_DOMAIN" +short +time=2 +tries=1 2>/dev/null \
      | grep -qE '^[0-9]+(\.[0-9]+){3}$'; then
    break
  fi
  sleep 1
done
iptables -t nat -A POSTROUTING -o "$EGRESS_IF" -j MASQUERADE
# Envoy's own upstream connections leave via OUTPUT, so this REDIRECT cannot recurse
iptables -t nat -A PREROUTING -p tcp --dport 443 -j REDIRECT --to-port 10443
iptables -t nat -A PREROUTING -p tcp --dport 80 -j REDIRECT --to-port 10080
iptables -A FORWARD -p udp --dport 53 -j DROP
iptables -A FORWARD -p tcp --dport 53 -j DROP
iptables -A FORWARD -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
iptables -P FORWARD DROP
# IPv6 is disabled; this DROP is a fail-closed backstop against a future leak
ip6tables -P FORWARD DROP
log "iptables configured (FORWARD policy DROP)"

# envoy shares the gateway netns and reads the generated config from the shared volume
cluster_name() { printf '%s' "$1" | tr '.' '_'; }

generate_envoy_config() {
  local out="$1" domain cluster
  {
    printf '%s\n' \
      'admin:' \
      '  address:' \
      '    socket_address: { address: 127.0.0.1, port_value: 9901 }' \
      '' \
      'static_resources:' \
      '  listeners:' \
      '  - name: https_listener' \
      '    address:' \
      '      socket_address: { address: 0.0.0.0, port_value: 10443 }' \
      '    listener_filters:' \
      '    - name: envoy.filters.listener.tls_inspector' \
      '      typed_config:' \
      '        "@type": type.googleapis.com/envoy.extensions.filters.listener.tls_inspector.v3.TlsInspector' \
      '    filter_chains:'
    for domain in $ALLOWED_HTTPS_DOMAINS; do
      cluster="$(cluster_name "$domain")_cluster"
      printf '%s\n' \
        "    - filter_chain_match:" \
        "        server_names: [\"${domain}\"]" \
        "      filters:" \
        "      - name: envoy.filters.network.tcp_proxy" \
        "        typed_config:" \
        '          "@type": type.googleapis.com/envoy.extensions.filters.network.tcp_proxy.v3.TcpProxy' \
        "          stat_prefix: ${cluster}" \
        "          cluster: ${cluster}"
    done
    # port 80 is plain HTTP: match the request Host header
    printf '%s\n' \
      '  - name: http_listener' \
      '    address:' \
      '      socket_address: { address: 0.0.0.0, port_value: 10080 }' \
      '    filter_chains:' \
      '    - filters:' \
      '      - name: envoy.filters.network.http_connection_manager' \
      '        typed_config:' \
      '          "@type": type.googleapis.com/envoy.extensions.filters.network.http_connection_manager.v3.HttpConnectionManager' \
      '          stat_prefix: http80' \
      '          codec_type: AUTO' \
      '          route_config:' \
      '            virtual_hosts:'
    for domain in $ALLOWED_HTTP_HOSTS; do
      cluster="$(cluster_name "$domain")_http_cluster"
      printf '%s\n' \
        "            - name: ${cluster}" \
        "              domains: [\"${domain}\"]" \
        "              routes:" \
        "              - match: { prefix: \"/\" }" \
        "                route: { cluster: ${cluster} }"
    done
    printf '%s\n' \
      '            - name: deny' \
      '              domains: ["*"]' \
      '              routes:' \
      '              - match: { prefix: "/" }' \
      '                direct_response:' \
      '                  status: 403' \
      '                  body: { inline_string: "host not allowed" }' \
      '          http_filters:' \
      '          - name: envoy.filters.http.router' \
      '            typed_config:' \
      '              "@type": type.googleapis.com/envoy.extensions.filters.http.router.v3.Router'
    printf '%s\n' '  clusters:'
    for domain in $ALLOWED_HTTPS_DOMAINS; do
      cluster="$(cluster_name "$domain")_cluster"
      printf '%s\n' \
        "  - name: ${cluster}" \
        '    type: STRICT_DNS' \
        '    connect_timeout: 5s' \
        '    dns_lookup_family: V4_ONLY' \
        '    lb_policy: ROUND_ROBIN' \
        '    load_assignment:' \
        "      cluster_name: ${cluster}" \
        '      endpoints:' \
        '      - lb_endpoints:' \
        '        - endpoint:' \
        '            address:' \
        "              socket_address: { address: ${domain}, port_value: 443 }"
    done
    for domain in $ALLOWED_HTTP_HOSTS; do
      cluster="$(cluster_name "$domain")_http_cluster"
      printf '%s\n' \
        "  - name: ${cluster}" \
        '    type: STRICT_DNS' \
        '    connect_timeout: 5s' \
        '    dns_lookup_family: V4_ONLY' \
        '    lb_policy: ROUND_ROBIN' \
        '    load_assignment:' \
        "      cluster_name: ${cluster}" \
        '      endpoints:' \
        '      - lb_endpoints:' \
        '        - endpoint:' \
        '            address:' \
        "              socket_address: { address: ${domain}, port_value: 80 }"
    done
  } > "$out"
}

generate_envoy_config /envoy-shared/envoy.yaml
log "envoy.yaml generated (https: ${ALLOWED_HTTPS_DOMAINS} / http: ${ALLOWED_HTTP_HOSTS})"

touch /gateway-ready
log "ready"

exec sleep infinity

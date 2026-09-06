FROM alpine:3.24@sha256:28bd5fe8b56d1bd048e5babf5b10710ebe0bae67db86916198a6eec434943f8b
RUN apk add --no-cache iptables ipset dnsmasq bind-tools iproute2 bash
COPY entrypoint.sh healthcheck.sh route-keeper.sh /
RUN chmod +x /entrypoint.sh /healthcheck.sh /route-keeper.sh
ENTRYPOINT ["/entrypoint.sh"]

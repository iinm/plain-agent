FROM alpine:3@sha256:294b683cb724975bec92580e1e685676bd4b50bda910ddb8c51d4cabeaec77e6
RUN apk add --no-cache iptables dnsmasq bind-tools iproute2 bash
COPY entrypoint.sh healthcheck.sh route-keeper.sh /
RUN chmod +x /entrypoint.sh /healthcheck.sh /route-keeper.sh
ENTRYPOINT ["/entrypoint.sh"]

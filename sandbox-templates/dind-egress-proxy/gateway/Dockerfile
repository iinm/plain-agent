FROM alpine:3@sha256:be2656061b536c1883c4034790e21d0a09c5aaaf51968b89368a3c0371ea2c9a
RUN apk add --no-cache nftables dnsmasq bind-tools iproute2 bash
COPY entrypoint.sh healthcheck.sh route-keeper.sh /
RUN chmod +x /entrypoint.sh /healthcheck.sh /route-keeper.sh
ENTRYPOINT ["/entrypoint.sh"]

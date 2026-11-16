FROM alpine:3@sha256:f59abe656b692d901e184be3445e084786602108599d2a51d229c0f5a48c71bf
RUN apk add --no-cache nftables dnsmasq bind-tools iproute2 bash
COPY entrypoint.sh healthcheck.sh route-keeper.sh /
RUN chmod +x /entrypoint.sh /healthcheck.sh /route-keeper.sh
ENTRYPOINT ["/entrypoint.sh"]

FROM docker:29-cli@sha256:eccaacfeed644c7de222ff047483568cb988dde95476fbaaf10ea2d04921bb66 AS docker-cli


FROM ubuntu:24.10@sha256:cdf755952ed117f6126ff4e65810bf93767d4c38f5c7185b50ec1f1078b464cc
# docker CLI is copied from the dind base image so client/daemon versions stay locked
# (apt's docker-ce-cli would drift). Ubuntu base: agents install glibc toolchains, and
# apt (archive.ubuntu.com) is already in the default HTTP allow list.
COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl bind9-dnsutils iproute2 \
 && rm -rf /var/lib/apt/lists/*
CMD ["sleep", "infinity"]

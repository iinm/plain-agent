FROM docker:29-cli@sha256:eccaacfeed644c7de222ff047483568cb988dde95476fbaaf10ea2d04921bb66 AS docker-cli


FROM ubuntu:25.10@sha256:7cc5e35f6567ee8c66d2abb4aab0fd866669e6207c237c3a8f0947a5c7f17092
# docker CLI is copied from the dind base image so client/daemon versions stay locked
# (apt's docker-ce-cli would drift). Ubuntu base: agents install glibc toolchains, and
# apt (archive.ubuntu.com) is already in the default HTTP allow list.
COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl bind9-dnsutils iproute2 \
 && rm -rf /var/lib/apt/lists/*
CMD ["sleep", "infinity"]

FROM docker:29-cli@sha256:eccaacfeed644c7de222ff047483568cb988dde95476fbaaf10ea2d04921bb66 AS docker-cli


FROM ubuntu:24.04@sha256:33ceb71981b602c1a7443a53469e4dba065f7503eab3078a2d7a57a2ab987517
# docker CLI is copied from the dind base image so client/daemon versions stay locked
# (apt's docker-ce-cli would drift). Ubuntu base: agents install glibc toolchains, and
# apt (archive.ubuntu.com) is already in the default HTTP allow list.
COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl bind9-dnsutils iproute2 \
 && rm -rf /var/lib/apt/lists/*
CMD ["sleep", "infinity"]

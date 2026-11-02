FROM docker:29-cli@sha256:5e6baf67325a79f64ed3bed6863954d5e05d0f3d4e57cbdb14809346814bbfdb AS docker-cli


FROM debian:stable-slim@sha256:eb593cf2c358cacef45ca0a424bbc7d30cfa3466265fc2662b9466a0ca6ba1c5
# docker CLI is copied from the dind base image so client/daemon versions stay locked
# (apt's docker-ce-cli would drift). Debian base: agents install glibc toolchains, and
# apt (deb.debian.org) is already in the default HTTP allow list.
COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl bind9-dnsutils iproute2 \
 && rm -rf /var/lib/apt/lists/*
CMD ["sleep", "infinity"]

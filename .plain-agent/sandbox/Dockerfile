FROM node:lts-slim@sha256:e6bedef217677b276c591795e169840edd9096dbf13f29df8ef8d1856b8820bc

RUN apt update && apt install -y \
      busybox bash \
      nftables dnsmasq dnsutils \
      ripgrep fd-find jq \
      git tmux \
    && bash -c 'ln -s $(which fdfind) /usr/local/bin/fd'

USER node:node

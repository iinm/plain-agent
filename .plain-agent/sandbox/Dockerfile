FROM node:25@sha256:78839ac448c23517f8eab2e8f7943d9b4f73979eb7f8bed2c73dbf72ff869e7b

RUN apt update && apt install -y \
      busybox bash \
      iptables ipset dnsmasq dnsutils \
      ripgrep fd-find jq \
      git tmux \
    && bash -c 'ln -s $(which fdfind) /usr/local/bin/fd'

USER node:node

FROM node:24@sha256:64af3819f9275802414d7cdc38c27e9d82bd564dec4d4da87d008255d36c63b4

RUN apt update && apt install -y \
      busybox bash \
      iptables ipset dnsmasq dnsutils \
      ripgrep fd-find jq \
      git tmux \
    && bash -c 'ln -s $(which fdfind) /usr/local/bin/fd'

USER node:node

FROM node:25@sha256:78839ac448c23517f8eab2e8f7943d9b4f73979eb7f8bed2c73dbf72ff869e7b

RUN apt update && apt install -y \
      busybox bash locales \
      iptables ipset dnsmasq dnsutils curl \
      fd-find ripgrep jq \
      git tmux make shellcheck \
    && bash -c 'ln -s $(which fdfind) /usr/local/bin/fd' \
    && echo 'en_US.UTF-8 UTF-8' >> /etc/locale.gen \
    && echo 'ja_JP.UTF-8 UTF-8' >> /etc/locale.gen \
    && locale-gen \
    && npm install -g npm@latest

USER node:node

FROM node:24@sha256:64af3819f9275802414d7cdc38c27e9d82bd564dec4d4da87d008255d36c63b4

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

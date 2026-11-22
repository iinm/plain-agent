FROM node:lts-slim@sha256:e6bedef217677b276c591795e169840edd9096dbf13f29df8ef8d1856b8820bc

RUN apt update && apt install -y \
      busybox bash locales \
      nftables dnsmasq dnsutils curl \
      fd-find ripgrep jq \
      git tmux make shellcheck \
    && bash -c 'ln -s $(which fdfind) /usr/local/bin/fd' \
    && echo 'en_US.UTF-8 UTF-8' >> /etc/locale.gen \
    && echo 'ja_JP.UTF-8 UTF-8' >> /etc/locale.gen \
    && locale-gen \
    && npm install -g npm@latest

USER node:node

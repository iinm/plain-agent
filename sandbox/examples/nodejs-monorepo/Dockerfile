FROM node:lts-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6

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

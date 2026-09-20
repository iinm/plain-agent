FROM node:23@sha256:9a25b5a6f9a90218b73a62205f111e71de5e4289aee952b4dd7e86f7498f2544

RUN apt update && apt install -y \
      busybox bash \
      iptables ipset dnsmasq dnsutils \
      ripgrep fd-find jq \
      git tmux \
    && bash -c 'ln -s $(which fdfind) /usr/local/bin/fd'

USER node:node

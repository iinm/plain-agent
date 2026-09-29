# Agent Sandbox (DinD and egress proxy)

A runtime environment for coding agents with default-deny network egress.
The agent (sandbox) can reach only explicitly allowed external resources.

```
sandbox ─┐
dind ────┼─ internal network ── gateway ── egress network ── external
                            (envoy shares the gateway netns)
```

## Security model

- The agent runs code only inside the sandbox and dind containers. The gateway and
  Envoy share nothing writable with it: only the generated `envoy.yaml` (one-way,
  mounted read-only into Envoy), so agent input cannot change the egress rules
- The sandbox and dind sit on the internal network only. If the gateway is down,
  traffic is blocked, not bypassed.
- The only exit is the gateway: 443 is matched by SNI (Envoy), 80 by Host header
  (Envoy), DNS only via the gateway's dnsmasq (allow-only)

## How it works

- The sandbox and dind have no NET_ADMIN; route-keeper-* sidecars hold it and keep
  the default route pointed at the gateway
- The gateway generates `envoy.yaml` from the allow list. The sandbox talks to the dind
  docker daemon over `DOCKER_HOST=tcp://<dind IP>:2376` (TLS), so image pulls also pass
  the SNI check

## Usage

```sh
docker compose up -d --build --wait   # start (waits until all containers are healthy)
./verify.sh                           # verify (healthy when NG=0)
```

```sh
docker compose down        # stop (images and volumes are kept)
docker compose down -v     # full removal (dind images and certs are also deleted)
```

## Running multiple instances

All fixed values (names, subnets, IPs, allow lists) are variables with defaults in
docker-compose.yml. A second instance only needs a different name and subnets.
Write them in an env file (any path; the examples below use agent2.env) and pass
the same file to docker compose and verify.sh:

```sh
# agent2.env: each instance takes the next free /24 pair (default stack: 200/201,
# a second one: 202/203). The .1 gateway must match its subnet. Nothing may overlap
# the host LAN or other docker networks
COMPOSE_PROJECT_NAME=agent2
INTERNAL_SUBNET=172.28.202.0/24
INTERNAL_GW=172.28.202.1
EGRESS_SUBNET=172.28.203.0/24
EGRESS_GW=172.28.203.1
GATEWAY_IP=172.28.202.100
SANDBOX_IP=172.28.202.10
DIND_IP=172.28.202.20
```

```sh
docker compose --env-file agent2.env up -d --build --wait
set -a; . agent2.env; set +a; ./verify.sh   # set -a exports the vars so verify.sh sees them
docker compose --env-file agent2.env down -v
```

| Variable | Default | Meaning |
|---|---|---|
| `COMPOSE_PROJECT_NAME` | `agent` | compose project name; prefix for containers, networks and images (lowercase). |
| `INTERNAL_SUBNET` / `INTERNAL_GW` | `172.28.200.0/24` / `172.28.200.1` | internal network |
| `EGRESS_SUBNET` / `EGRESS_GW` | `172.28.201.0/24` / `172.28.201.1` | egress network |
| `GATEWAY_IP` / `SANDBOX_IP` / `DIND_IP` | `.100` / `.10` / `.20` | static IPs on the internal network |

Each instance only needs its own project name and subnets:

- Docker hands out new networks from 172.17.0.0/16 to 172.31.0.0/16, so 172.28.0.0/16
  can be taken by other projects first. If `up` fails with `Pool overlaps`, prune
  unused networks or renumber.
- All IPs are static and verify.sh assumes them.

## Editing the allow list

Defaults are in `docker-compose.yml`; override them per instance via an env file.
Domains are separated by spaces on one line:

```sh
# .env example
ALLOWED_HTTPS_DOMAINS=github.com api.github.com
ALLOWED_HTTP_HOSTS=deb.debian.org
```

Then `docker compose up -d --wait` (recreates the gateway with the new list).

| Variable | Scope | How it matches |
|---|---|---|
| `ALLOWED_HTTPS_DOMAINS` | HTTPS (443) | Envoy matches by SNI. |
| `ALLOWED_HTTP_HOSTS` | Plain HTTP (80) | Envoy matches the Host header. |

Both lists also drive the gateway's dnsmasq (allow-only DNS): one edit updates the
connection filters and name resolution together. Names outside the lists get SERVFAIL,
which closes DNS exfiltration.

## Threat mitigations

- **No L2/L3 escape**. `internal: true` is enforced by a Docker-managed chain in
  the host filter table: traffic from the internal bridge is dropped unless its
  destination is inside the internal subnet. The chain name depends on the Docker
  version (`DOCKER-INTERNAL` on 29+, `DOCKER-ISOLATION-STAGE-1` on 28 and earlier).
  A container cannot escape by re-pointing its route at the host, or by sending
  raw frames (AF_PACKET)
- **CAP_NET_RAW removed** from sandbox/dind/route-keeper containers. AF_PACKET needs
  this capability, so removing it closes L2 spoofing (e.g. ARP spoofing). dind runs
  unprivileged, so `cap_drop` is effective; rootless dockerd does not need the
  capability
- **dind runs under rootless dockerd** (its own userns via rootlesskit). It only adds
  what rootless dockerd needs: `/dev/net/tun`, seccomp/AppArmor relaxed for userns
  creation and mounts, and `/proc` unmasked (`systempaths=unconfined`; the default
  masking blocks the proc mount runc needs to start containers). Agent containers
  still run under rootless dockerd (userns) and all egress stays filtered
- **gateway ip6tables FORWARD is also DROP**. IPv6 is disabled, but if that ever
  stops being true, egress is still blocked (fail-closed backstop)

## Limitations

- **Traffic to the host's bridge IP (the .1 address) bypasses the gateway**.
  It is answered by the host itself, via the INPUT chain that this compose
  cannot filter. Audit the host's own exposure separately: services bound to
  the bridge IP may be reachable from sandboxes (e.g. LLMNR/mDNS responders,
  common on distros where systemd-resolved runs). Verify on your host.
- **DNS queries for allow-listed zones are visible to those zones' operators** (the
  gateway resolver forwards them upstream; inherent to using DNS at all)
- **Kernel userns bugs remain** because dind runs rootless; inherent to any
  rootless-docker setup

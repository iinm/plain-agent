#!/usr/bin/env bash

set -eu -o pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
export PATH=$SCRIPT_DIR/bin:$PATH

cd "$SCRIPT_DIR"

on_exit() {
  status=$?
  # shellcheck disable=2046
  kill $(jobs -p) &> /dev/null || true
  return "$status"
}

trap 'on_exit' EXIT


echo "case: --help option displays help message"
# when/then:
plain-sandbox --help | grep -qE "^Usage"


echo "case: no arguments display help message to stderr"
# when:
out=$(plain-sandbox 3>&1 1>/dev/null 2>&3) || status=$?
# then:
test "$status" -ne 0
grep -qE "^Usage" <<< "$out"


echo "case: unknown option causes an error"
# when:
out=$(plain-sandbox --no-such-option 3>&1 1>/dev/null 2>&3) || status=$?
# then:
test "$status" -ne 0
grep -qE "^Error: Unknown option: --no-such-option" <<< "$out"


echo "case: run basic command with minimum Dockerfile"
# when/then:
plain-sandbox --dockerfile Dockerfile.minimum --rebuild echo hello | grep -qE "^hello$"


echo "case: receive stdin"
# when/then:
echo hello | plain-sandbox --dockerfile Dockerfile.minimum --rebuild cat | grep -qE "^hello$"


echo "case: --dry-run option displays the command that would be executed"
# when:
out=$(plain-sandbox --dry-run --dockerfile Dockerfile.minimum touch test)
# then:
grep -qE "DRY_RUN: docker exec .+ touch test" <<< "$out"
# then:
test ! -e test


echo "case: --platform option specifies the platform for the container"
# when:
out=$(plain-sandbox --dry-run --dockerfile Dockerfile.minimum --platform linux/amd64 true)
# then:
grep -qE "DRY_RUN: docker build .+ --platform linux/amd64" <<< "$out"
grep -qE "DRY_RUN: docker run .+ --platform linux/amd64" <<< "$out"


echo "case: --tty option enables tty allocation"
# when:
out=$(plain-sandbox --dry-run --dockerfile Dockerfile.minimum --tty true)
# then:
grep -qE "DRY_RUN: docker exec .+ --tty" <<< "$out"


echo "case: --no-cache option disables the cache during the image build"
# when:
out=$(plain-sandbox --dry-run --dockerfile Dockerfile.minimum --no-cache true)
# then:
grep -qE "DRY_RUN: docker build .+ --no-cache" <<< "$out"


echo "case: host timezone is applied to the container"
# when:
out=$(env TZ="Asia/Tokyo" plain-sandbox --dry-run --dockerfile Dockerfile.minimum --no-cache true)
# then:
grep -qE "DRY_RUN: docker run .+ --env TZ=Asia/Tokyo" <<< "$out"


echo "case: host TERM is forwarded to the container"
# when:
out=$(env TERM="xterm-256color" plain-sandbox --dry-run --dockerfile Dockerfile.minimum --no-cache true)
# then:
grep -qE "DRY_RUN: docker run .+ --env TERM=xterm-256color" <<< "$out"


echo "case: --env-file option passes env file to docker run"
# when:
out=$(plain-sandbox --dry-run --dockerfile Dockerfile.minimum --env-file .env true)
# then:
grep -qE "DRY_RUN: docker run .+ --env-file .env" <<< "$out"

echo "case: --env option passes environment variables to docker run"
# when:
out=$(plain-sandbox --dry-run --dockerfile Dockerfile.minimum --env FOO=bar true)
# then:
grep -qE "DRY_RUN: docker run .+ --env FOO=bar" <<< "$out"

echo "case: --env option can be specified multiple times"
# when:
out=$(plain-sandbox --dry-run --dockerfile Dockerfile.minimum --env FOO=bar --env BAZ=qux true)
# then:
grep -qE "DRY_RUN: docker run .+ --env FOO=bar" <<< "$out"
grep -qE "DRY_RUN: docker run .+ --env BAZ=qux" <<< "$out"

echo "case: --volume option creates and mounts volume"
# when:
out=$(plain-sandbox --dry-run --dockerfile Dockerfile.minimum --volume bin true)
# then:
grep -qE " --mount type=volume,source=plain-sandbox--sandbox-.+--bin,target=/.+/sandbox/bin,consistency=delegated" <<< "$out"


echo "case: --volume-each option creates and mounts volume"
# when:
out=$(plain-sandbox --dry-run --dockerfile Dockerfile.minimum --volume-each package.json:node_modules true)
# then:
grep -qE " --mount type=volume,source=plain-sandbox--sandbox-.+--examples-nodejs-monorepo-node_modules,target=/.+/nodejs-monorepo/node_modules,consistency=delegated" <<< "$out"


echo "case: --volume-each option creates and mounts volume (omit manifest)"
# when:
out=$(plain-sandbox --dry-run --dockerfile Dockerfile.minimum --volume-each node_modules true)
# then:
grep -qE " --mount type=volume,source=plain-sandbox--sandbox-.+--examples-nodejs-monorepo-node_modules,target=/.+/nodejs-monorepo/node_modules,consistency=delegated" <<< "$out"


echo "case: --mount-* option mounts host path with explicit container path"
# when:
out=$(plain-sandbox --dry-run --dockerfile Dockerfile.minimum --mount-readonly bin:/mnt/bin-readonly --mount-writable bin:/mnt/bin-writable true)
# then:
grep -qE " --mount type=bind,source=/.+/sandbox/bin,target=/mnt/bin-readonly,readonly,consistency=delegated" <<< "$out"
grep -qE " --mount type=bind,source=/.+/sandbox/bin,target=/mnt/bin-writable,consistency=delegated" <<< "$out"


echo "case: --mount-* option resolves relative container path from working directory"
# when:
out=$(plain-sandbox --dry-run --dockerfile Dockerfile.minimum --mount-readonly bin:mnt/bin-readonly --mount-writable bin:mnt/bin-writable true)
# then:
grep -qE " --mount type=bind,source=/.+/sandbox/bin,target=/.+/sandbox/mnt/bin-readonly,readonly,consistency=delegated" <<< "$out"
grep -qE " --mount type=bind,source=/.+/sandbox/bin,target=/.+/sandbox/mnt/bin-writable,consistency=delegated" <<< "$out"


echo "case: --mount-* option uses resolved host path as container path when container path is omitted"
# when:
out=$(plain-sandbox --dry-run --dockerfile Dockerfile.minimum --mount-readonly bin --mount-writable bin true)
# then:
grep -qE " --mount type=bind,source=/.+/sandbox/bin,target=/.+/sandbox/bin,readonly,consistency=delegated" <<< "$out"
grep -qE " --mount type=bind,source=/.+/sandbox/bin,target=/.+/sandbox/bin,consistency=delegated" <<< "$out"


echo "case: --publish option publish port to host"
# when:
out=$(plain-sandbox --dry-run --dockerfile Dockerfile.minimum --publish 8000:8000 true)
# then:
grep -qE "DRY_RUN: docker run .+ --publish 127.0.0.1:8000:8000" <<< "$out"


echo "case: container user/group id matches host user/group id"
# shellcheck disable=SC2016
plain-sandbox --dockerfile Dockerfile.minimum --rebuild bash -c 'echo $(id -u):$(id -g)' | grep -qE "$(id -u):$(id -g)"


echo "case: working directory is mounted and readable"
# when/then:
plain-sandbox --dockerfile Dockerfile.minimum --rebuild cat Dockerfile.minimum | grep -qE "FROM debian"


echo "case: working directory owner is sandbox user"
# when/then:
plain-sandbox --dockerfile Dockerfile.minimum --rebuild ls -ld . | grep -qE sandbox


echo "case: working directory is read-only by default"
# when:
out=$(plain-sandbox --dockerfile Dockerfile.minimum touch test 2>&1) || status=$?
# then:
test "$status" -ne 0
grep -qE "Read-only file system" <<< "$out"


echo "case: --allow-write makes working directory writable"
# when/then:
plain-sandbox --allow-write --dockerfile Dockerfile.minimum --rebuild touch test && test -e test
rm -f test


echo "case: network is disabled by default"
# given:
if test "$(uname)" = "Darwin"; then
  nc -l 18080 &> /dev/null &
else
  nc -l -p 18080 &> /dev/null &
fi
nc_pid=$!
# when:
out=$(plain-sandbox --dockerfile Dockerfile.minimum --rebuild busybox nc -w 2 host.docker.internal 18080 < /dev/null 2>&1) || status=$?
# then:
test "$status" -ne 0
grep -qE "nc: bad address" <<< "$out"
# cleanup:
if lsof -i:18080 | grep -q "$nc_pid"; then
  kill "$nc_pid"
fi


echo "case: --allow-net allows access to domain but only 443"
# given:
if test "$(uname)" = "Darwin"; then
  nc -l 18080 &> /dev/null &
else
  nc -l -p 18080 &> /dev/null &
fi
nc_pid=$!
# when:
out=$(plain-sandbox --dockerfile Dockerfile.minimum --rebuild --allow-net host.docker.internal busybox nc -w 2 host.docker.internal 18080 < /dev/null 2>&1) || status=$?
# then:
grep -qE "Connection refused" <<< "$out"
# cleanup:
if lsof -i:18080 | grep -q "$nc_pid"; then
  kill "$nc_pid"
fi


echo "case: --allow-net allows access to host:port"
# given:
if test "$(uname)" = "Darwin"; then
  nc -l 18080 &> /dev/null &
else
  nc -l -p 18080 &> /dev/null &
fi
nc_pid=$!
# when:
plain-sandbox --dockerfile Dockerfile.minimum --rebuild --allow-net host.docker.internal:18080 busybox nc -w 2 host.docker.internal 18080 < /dev/null
# cleanup:
if lsof -i:18080 | grep -q "$nc_pid"; then
  kill "$nc_pid"
fi


echo "case: --allow-net allows access to ip range"
# given:
if test "$(uname)" = "Darwin"; then
  nc -l 18080 &> /dev/null &
else
  nc -l -p 18080 &> /dev/null &
fi
nc_pid=$!
# when:
plain-sandbox --dockerfile Dockerfile.minimum --rebuild --allow-net 0.0.0.0/0 busybox nc -w 2 8.8.8.8 443 < /dev/null
# cleanup:
if lsof -i:18080 | grep -q "$nc_pid"; then
  kill "$nc_pid"
fi


echo "case: --allow-net allows DNS resolution of allowed domains"
# when/then:
plain-sandbox --dockerfile Dockerfile.minimum --rebuild --allow-net example.com dig +time=3 +tries=1 +short example.com | grep -qE "([0-9]{1,3}\.){3}[0-9]{1,3}"


echo "case: --allow-net rejects DNS resolution of non-allowed domains"
# when:
out=$(plain-sandbox --dockerfile Dockerfile.minimum --rebuild --allow-net example.com dig +time=3 +tries=1 google.com 2>&1) || status=$?
# then:
grep -qE "status: NXDOMAIN" <<< "$out"


echo "case: --allow-net blocks direct queries to DNS servers"
# when:
out=$(plain-sandbox --dockerfile Dockerfile.minimum --rebuild --allow-net example.com bash -c 'dig +time=3 +tries=1 @127.0.0.11 google.com; dig +time=3 +tries=1 @8.8.8.8 google.com' 2>&1) || status=$?
# then:
test "$status" -ne 0
test "$(grep -c "connection refused" <<< "$out")" -eq 2


echo "case: reuse existing container (image and container reuse on second run)"
# given:
plain-sandbox --dockerfile Dockerfile.minimum --rebuild --keep-alive 5 --verbose true &> /dev/null
# when:
out=$(plain-sandbox --dockerfile Dockerfile.minimum --keep-alive 5 --verbose true 2>&1)
# then:
grep -qE "Image already exists, skipping build:" <<< "$out"
grep -qE "Container is already running. Reusing" <<< "$out"
# given:
sleep 5
# when:
out=$(plain-sandbox --dockerfile Dockerfile.minimum --keep-alive 5 --verbose true 2>&1)
# then:
grep -qE "Image already exists, skipping build:" <<< "$out"
grep -qE "Stopping any existing container:" <<< "$out"
grep -qE "Remove any existing network:" <<< "$out"


echo "case: --rebuild forces image rebuild even if it already exists"
# given:
plain-sandbox --dockerfile Dockerfile.minimum --verbose true &> /dev/null
# when:
out=$(plain-sandbox --dockerfile Dockerfile.minimum --rebuild --verbose --dry-run true 2>&1)
# then:
grep -qE "Building docker image" <<< "$out"


echo "case: --no-cache forces image rebuild without cache"
# given:
plain-sandbox --dockerfile Dockerfile.minimum --verbose true &> /dev/null
# when:
out=$(plain-sandbox --dockerfile Dockerfile.minimum --no-cache --verbose --dry-run true 2>&1)
# then:
grep -qE "Building docker image" <<< "$out"
grep -qE "DRY_RUN: docker build .+ --no-cache" <<< "$out"


echo "case: remove network if it fails to start container"
# when:
out=$(plain-sandbox --dockerfile Dockerfile.minimum --rebuild --env-file no-such-file --allow-net --verbose true 2>&1) || status=$?
# then:
test "$status" -ne 0
grep -qE "Removing network" <<< "$out"


echo "case: run basic command with preset configuration"
# when/then:
plain-sandbox --rebuild echo hello | grep -qE "^hello$"

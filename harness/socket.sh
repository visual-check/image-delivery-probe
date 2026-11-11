#!/bin/bash
# Runs inside a GitHub job container on another image (node), which has the runner's Docker socket mounted. A server on
# the job container's own 127.0.0.1 stands in for the Storybook. The browser container is started through the socket
# in several ways, and each records whether it reaches that server. Then a short real capture on the way that works.
#   socket.sh <storybook-static dir> <out dir>      env: JOB_CONTAINER_ID, JOB_NETWORK (from the job context)
set -uo pipefail
H=$(cd "$(dirname "$0")" && pwd)
. "$H/lib.sh"
SB=$1; OUT=$2
mkdir -p "$OUT"
P=meta/pins.json
IMG=$(jq -r '.images["full-gzip"]' "$P")
EXE=$(jq -r .ourExe "$P")
BARGS=meta/browser-args.json
F="$OUT/facts.txt"
fact() { echo "## $1" >> "$F"; shift; { "$@" 2>&1 || echo "(exit $?)"; } >> "$F"; echo >> "$F"; }

# ---- Who and where am I ----
SELF_HOST=$(hostname)
SELF_MOUNT=$(grep -oE '/containers/[0-9a-f]{64}/' /proc/self/mountinfo | head -1 | cut -d/ -f3)
fact 'id' id
fact 'hostname' hostname
fact 'job.container.id from the job context' echo "${JOB_CONTAINER_ID:-unset}"
fact 'job.container.network from the job context' echo "${JOB_NETWORK:-unset}"
fact 'container ID from /proc/self/mountinfo' echo "${SELF_MOUNT:-none}"
fact '/.dockerenv' ls -la /.dockerenv
fact '/proc/self/cgroup' cat /proc/self/cgroup
fact '/etc/hosts' cat /etc/hosts
fact 'docker.sock owner, group, mode' stat -c '%u:%g %a' /var/run/docker.sock
fact 'docker version' docker version
fact 'docker info: OperatingSystem | OSType | Name' docker info --format '{{.OperatingSystem}} | {{.OSType}} | {{.Name}}'
fact 'docker inspect <hostname>' docker inspect "$SELF_HOST" --format '{{.Id}} | {{.Config.Image}} | {{.HostConfig.NetworkMode}} | {{json .NetworkSettings.Networks}}'
fact 'docker inspect <mountinfo id>' docker inspect "$SELF_MOUNT" --format '{{.Id}} | {{.Config.Hostname}}'
SOCK_GID=$(stat -c %g /var/run/docker.sock)
fact 'docker version as uid 1001, no groups' setpriv --reuid=1001 --regid=1001 --clear-groups docker version --format '{{.Server.Version}}'
fact 'docker version as uid 1001, in the socket group' setpriv --reuid=1001 --regid=1001 --groups="$SOCK_GID" docker version --format '{{.Server.Version}}'

SELF=${SELF_MOUNT:-$SELF_HOST}
JOB_IP=$(docker inspect "$SELF" --format "{{(index .NetworkSettings.Networks \"$JOB_NETWORK\").IPAddress}}")
fact 'job container IP on the job network' echo "$JOB_IP"
fact 'joined: /etc/hosts, /etc/resolv.conf and hostname seen by a container on --network container:<self>' \
  docker run --rm --pull never --network "container:$SELF" "$IMG" sh -c 'cat /etc/hosts; echo ---; cat /etc/resolv.conf; echo ---; hostname'
fact 'joined with --add-host as well' docker run --rm --pull never --network "container:$SELF" --add-host x.test:1.2.3.4 "$IMG" true
fact 'host network: /etc/hosts seen by the browser container' docker run --rm --pull never --network host "$IMG" cat /etc/hosts

# ---- The stand-in Storybook: a page on the job container's 127.0.0.1 only ----
node -e "require('http').createServer((q, s) => s.end('<title>reached the job container</title>')).listen(6500, '127.0.0.1', () => console.log('up'))" > "$OUT/page.log" 2>&1 &
until grep -q up "$OUT/page.log"; do sleep 0.1; done
URLS=http://127.0.0.1:6500/,http://localhost:6500/,http://sb.vc.test:6500/
PROXY_ARGS='["--proxy-server=socks5://host.docker.internal:1080", "--proxy-bypass-list=<-loopback>"]'
JOBNET_PROXY_ARGS="[\"--proxy-server=socks5://$JOB_IP:1080\", \"--proxy-bypass-list=<-loopback>\"]"
D='["--init", "--ipc=host", "--pull", "never"]'
arm() { # arm <label> <docker args json> <browser args json> [reach args...]
  local label=$1 dargs=$2 bargs=$3; shift 3
  local d; d=$(jq -cn --argjson a "$D" --argjson b "$dargs" '$a + $b')
  echo "### $label $(date -u +%T)"
  node "$H/reach.mjs" --label "$label" --urls "$URLS" --out "$OUT/reach.jsonl" \
    --spawn "$(docker_argv "$BARGS" "$IMG" "$EXE" "$d" "$bargs")" "$@" | cut -c1-1500
}
arm host-network '["--network", "host"]' '[]'
arm proxy-host-gateway '["--add-host=host.docker.internal:host-gateway"]' "$PROXY_ARGS" --socks 127.0.0.1:1080
arm proxy-host-gateway-any '["--add-host=host.docker.internal:host-gateway"]' "$PROXY_ARGS" --socks 0.0.0.0:1080
arm proxy-job-network "[\"--network\", \"$JOB_NETWORK\"]" "$JOBNET_PROXY_ARGS" --socks 0.0.0.0:1080
arm join-own-network "[\"--network\", \"container:$SELF\"]" '[]'
arm join-by-job-context-id "[\"--network\", \"container:$JOB_CONTAINER_ID\"]" '[]'

# ---- A real capture through the way that joins: the first 60 HeroUI stories ----
node "$H/serve.mjs" "$SB" 6400 127.0.0.1 > "$OUT/serve.log" 2>&1 &
until grep -q serving "$OUT/serve.log" 2> /dev/null; do sleep 0.1; done
OFFLINE='["--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1"]'
d=$(jq -cn --argjson a "$D" --arg n "container:$SELF" '$a + ["--cpus=2", "--memory=7g", "--network", $n]')
echo "### capture through join $(date -u +%T)"
CPUS=2 node "$H/bench.mjs" --engine raw --spawn "$(docker_argv "$BARGS" "$IMG" "$EXE" "$d" "$OFFLINE")" --storybook "$SB" \
  --stories 60 --area viewport --viewport 1280x720 --css 'html>:not(head):not(body){display:none!important}' \
  --fonts meta/fonts.json --workers 2 --label capture-join --out "$OUT/capture.jsonl" 2>&1 | cut -c1-1500 | tail -2

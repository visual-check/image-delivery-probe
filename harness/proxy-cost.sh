#!/bin/bash
# The proxy's cost, as Raw CDP for Chromium measured it: 300 stories, 2 workers, Node and the Storybook server on the
# runner, only the browser in visual-check's image, external requests failing. Four arms in round robin per pass:
#   hostnet-2cpu, proxy-2cpu: Node, the server and the browser container all pinned to CPUs 0-1, like a 2-vCPU runner
#   hostnet-4cpu, proxy-4cpu: the browser container limited to 2 CPUs, Node and the server free on a 4-vCPU runner
# Host networking shares the runner's network. The proxy runs in Node on the docker0 bridge address, and the browser
# reaches it through host.docker.internal mapped to host-gateway.
#   proxy-cost.sh <rotation> <storybook-static dir> <out dir> [passes]
set -euo pipefail
H=$(cd "$(dirname "$0")" && pwd)
. "$H/lib.sh"
ROT=$1; SB=$2; OUT=$3; PASSES=${4:-3}
mkdir -p "$OUT"
P=meta/pins.json
IMG=$(jq -r '.images["full-gzip"]' "$P")
EXE=$(jq -r .ourExe "$P")
BARGS=meta/browser-args.json
GW=$(ip -4 -o addr show docker0 | awk '{print $4}' | cut -d/ -f1)
{ nproc; lscpu | grep -E 'Model name|^CPU\(s\)'; free -m | head -2; docker version --format '{{.Server.Version}}'; echo "docker0 $GW"; } > "$OUT/machine.txt"
OFFLINE='["--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1"]'
PROXY='["--proxy-server=socks5://host.docker.internal:1080", "--proxy-bypass-list=<-loopback>"]'
ARMS=(hostnet-2cpu proxy-2cpu hostnet-4cpu proxy-4cpu)
n=${#ARMS[@]}
for pass in $(seq 1 "$PASSES"); do
  for i in $(seq 0 $((n - 1))); do
    arm=${ARMS[$(( (i + ROT) % n ))]}
    pin=(); limit=(--cpus=2)
    if [[ $arm == *-2cpu ]]; then pin=(taskset -c 0,1); limit=(--cpuset-cpus=0,1); fi
    if [[ $arm == proxy-* ]]; then
      net=(--add-host=host.docker.internal:host-gateway); bargs=$PROXY
      sargs=(--socks "$GW:1080" --socks-allow 127.0.0.1:6400,localhost:6400)
    else
      net=(--network host); bargs=$OFFLINE; sargs=()
    fi
    d=$(printf '%s\n' --init --ipc=host --memory=7g --pull never "${limit[@]}" "${net[@]}" | jq -R . | jq -sc .)
    "${pin[@]}" node "$H/serve.mjs" "$SB" 6400 127.0.0.1 > "$OUT/serve.log" 2>&1 &
    SP=$!
    until grep -q serving "$OUT/serve.log" 2> /dev/null; do sleep 0.1; done
    label=$arm-p$pass
    echo "### $label $(date -u +%T)"
    CPUS=2 "${pin[@]}" node "$H/bench.mjs" --engine raw --spawn "$(docker_argv "$BARGS" "$IMG" "$EXE" "$d" "$bargs")" \
      "${sargs[@]}" --storybook "$SB" --stories 300 --area viewport --viewport 1280x720 \
      --css 'html>:not(head):not(body){display:none!important}' --fonts meta/fonts.json --workers 2 \
      --label "$label" --out "$OUT/timed.jsonl" 2>&1 | cut -c1-800 | tail -2
    kill $SP; wait $SP 2> /dev/null || true
  done
done

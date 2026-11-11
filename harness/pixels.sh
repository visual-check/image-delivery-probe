#!/bin/bash
# Captures the first 300 stories twice in each image: Playwright's (its own headless shell), full, and base with the
# CfT zip bind-mounted. Node and the Storybook server on the host, only the browser in the container (--network host,
# external hosts unresolvable). PNGs are kept content-addressed (sha1) in <out>/store; hashes per run in <out>/pixels.jsonl.
#   pixels.sh <rotation> <storybook-static dir> <out dir> <chs dir> [passes]
#   IMAGES='pw full base' (default) or a subset; PLATFORM=linux/amd64 to force it (macOS); LABEL_PREFIX to tag runs;
#   SERVE=container to run the server in a host-network container instead of on the host.
set -euo pipefail
H=$(cd "$(dirname "$0")" && pwd)
. "$H/lib.sh"
ROT=$1; SB=$2; OUT=$3; CHS=$4; PASSES=${5:-2}
P=meta/pins.json
BARGS=meta/browser-args.json
read -r -a IMGS <<< "${IMAGES:-pw full base}"
mkdir -p "$OUT/store" "$OUT/runs"
if [ "${SERVE:-host}" = container ]; then
  # macOS: the server runs in a host-network container (Node from Playwright's image), so that 127.0.0.1 in the
  # browser's host-network container reaches it as on a Linux runner
  SC=$(docker run -d --rm --network host --pull never ${PLATFORM:+--platform "$PLATFORM"} -v "$H:/h:ro" -v "$SB:/sb:ro" \
    "$(jq -r .playwright "$P")" node /h/serve.mjs /sb 6400 127.0.0.1)
  trap 'docker rm -f $SC > /dev/null 2>&1 || true' EXIT
  until docker logs "$SC" 2>&1 | grep -q serving; do sleep 0.2; done
else
  node "$H/serve.mjs" "$SB" 6400 127.0.0.1 > "$OUT/serve.log" 2>&1 &
  SP=$!
  trap 'kill $SP 2> /dev/null || true' EXIT
  until grep -q serving "$OUT/serve.log" 2> /dev/null; do sleep 0.1; done
fi
sha1() { if command -v sha1sum > /dev/null; then sha1sum "$1"; else shasum -a 1 "$1"; fi | cut -d' ' -f1; }
OFFLINE='["--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1"]'
D=(--init --ipc=host --cpus=2 --memory=7g --network host --pull never ${PLATFORM:+--platform "$PLATFORM"})
n=${#IMGS[@]}
for pass in $(seq 1 "$PASSES"); do
  for i in $(seq 0 $((n - 1))); do
    img=${IMGS[$(( (i + ROT) % n ))]}
    d=("${D[@]}")
    case $img in
      pw) ref=$(jq -r .playwright "$P"); exe=$(jq -r .playwrightExe "$P") ;;
      full) ref=$(jq -r '.images["full-gzip"]' "$P"); exe=$(jq -r .ourExe "$P") ;;
      base) ref=$(jq -r '.images["base-gzip"]' "$P"); exe=$(jq -r .ourExe "$P"); d+=(-v "$CHS:/opt/chrome-headless-shell:ro") ;;
    esac
    label=${LABEL_PREFIX:-}$img-p$pass
    argv=$(docker_argv "$BARGS" "$ref" "$exe" "$(printf '%s\n' "${d[@]}" | jq -R . | jq -sc .)" "$OFFLINE")
    echo "### $label $(date -u +%T)"
    CPUS=2 node "$H/bench.mjs" --engine raw --spawn "$argv" --storybook "$SB" --stories 300 --area viewport --viewport 1280x720 \
      --css 'html>:not(head):not(body){display:none!important}' --fonts meta/fonts.json --workers 2 \
      --label "$label" --out "$OUT/pixels.jsonl" --save "$OUT/runs/$label" 2>&1 | cut -c1-600 | tail -2
    for f in "$OUT/runs/$label"/*.png; do
      h=$(sha1 "$f")
      [ -e "$OUT/store/$h.png" ] && rm "$f" || mv "$f" "$OUT/store/$h.png"
    done
    rm -rf "$OUT/runs/$label"
  done
done

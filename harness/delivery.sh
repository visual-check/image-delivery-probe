#!/bin/bash
# Time to a runnable browser on this runner, per delivery option, each from a clean Docker and dropped page cache.
# Reads meta/pins.json and meta/browser-args.json (prepare's output). Appends one JSON line per variant to out/variants.jsonl.
#   delivery.sh machine
#   delivery.sh pulls <shard>               variants a-e (registry pulls, CfT zip download), order rotated by shard
#   delivery.sh cache-before <slot> <shard> clean, then name the cache entries for this slot's variant (step outputs)
#   delivery.sh cache-mid                   between the two restores
#   delivery.sh cache-after                 load, unzip, first reply
# Variants: a Playwright from MCR, b/c full gzip/zstd from GHCR, d/e base gzip/zstd + CfT zip from Google,
#           f Playwright tar from actions/cache, g full tar from cache, h base tar + CfT zip from cache.
set -euo pipefail
H=$(cd "$(dirname "$0")" && pwd)
. "$H/lib.sh"
P=meta/pins.json
BARGS=meta/browser-args.json
OUT=out
W=$RUNNER_TEMP/vc
S=$RUNNER_TEMP/vc-state
mkdir -p "$OUT" "$S"
pin() { jq -r "$1" "$P"; }
PW=$(pin .playwright); PW_EXE=$(pin .playwrightExe); EXE=$(pin .ourExe)
CFT_URL=$(pin .cftUrl); CFT_SHA=$(pin .cftSha256)
RUN=$(pin .prepareRun)

clean() {
  docker ps -aq | xargs -r docker rm -f > /dev/null
  docker system prune -af > /dev/null
  rm -rf "$W" vc-cache
  mkdir -p "$W"
  sync
  echo 3 | sudo tee /proc/sys/vm/drop_caches > /dev/null
}
# First reply twice: cold (just delivered) and warm (page cache filled by the first start)
replies() {
  local img=$1 exe=$2 d=$3 a b
  a=$(node "$H/first-reply.mjs" "$(docker_argv "$BARGS" "$img" "$exe" "$d" '[]')")
  b=$(node "$H/first-reply.mjs" "$(docker_argv "$BARGS" "$img" "$exe" "$d" '[]')")
  jq -cn --argjson a "$a" --argjson b "$b" '{first: $a, warm: $b}'
}
NET='["--network", "host", "--pull", "never"]'
MOUNT() { jq -cn --arg w "$W/chs" '["--network", "host", "--pull", "never", "-v", "\($w):/opt/chrome-headless-shell:ro"]'; }
record() { # <variant> <startedAt> <parts json> <replies json>
  jq -cn --arg v "$1" --arg at "$2" --argjson parts "$3" --argjson r "$4" --arg runner "$RUNNER_LABEL" --arg shard "$SHARD" '
    ($parts | to_entries | map(.value) | add) as $runnable
    | {variant: $v, runner: $runner, shard: ($shard | tonumber), startedAt: $at, parts: $parts, runnableS: ($runnable * 1000 | round / 1000),
       firstReplyMs: $r.first.ms, warmReplyMs: $r.warm.ms, product: $r.first.product,
       totalS: (if $r.first.ms then (($runnable + $r.first.ms / 1000) * 1000 | round / 1000) else null end), replies: $r}' | tee -a "$OUT/variants.jsonl"
}
iso() { date -u +%FT%T.%3NZ; }
cft() { # download + sha256 + unzip → parts json fragment
  local t0 t1 t2 t3
  t0=$(now); curl -fsSL --retry 3 -o "$W/chs.zip" "$CFT_URL"; t1=$(now)
  echo "$CFT_SHA  $W/chs.zip" | sha256sum -c --quiet; t2=$(now)
  unzip -q "$W/chs.zip" -d "$W/chs"; t3=$(now)
  jq -cn --arg a "$(since "$t0" "$t1")" --arg b "$(since "$t1" "$t2")" --arg c "$(since "$t2" "$t3")" \
    '{download: ($a | tonumber), sha256: ($b | tonumber), unzip: ($c | tonumber)}'
}
pull() { local t0 t1; t0=$(now); docker pull -q "$1" > /dev/null; t1=$(now); since "$t0" "$t1"; }

variant() {
  local v=$1 at p
  clean
  at=$(iso)
  echo "::group::variant $v"
  case $v in
    a) p=$(pull "$PW"); record a "$at" "{\"pull\": $p}" "$(replies "$PW" "$PW_EXE" "$NET")" ;;
    b|c) local ref; ref=$(pin ".images[\"full-$([ "$v" = b ] && echo gzip || echo zstd)\"]")
         p=$(pull "$ref"); record "$v" "$at" "{\"pull\": $p}" "$(replies "$ref" "$EXE" "$NET")" ;;
    d|e) local ref; ref=$(pin ".images[\"base-$([ "$v" = d ] && echo gzip || echo zstd)\"]")
         p=$(pull "$ref"); local c; c=$(cft)
         record "$v" "$at" "$(jq -cn --argjson p "$p" --argjson c "$c" '{pull: $p} + $c')" "$(replies "$ref" "$EXE" "$(MOUNT)")" ;;
  esac
  echo "::endgroup::"
}

case $1 in
  machine)
    jq -cn --arg runner "$RUNNER_LABEL" --arg image "${ImageOS:-}/${ImageVersion:-}" --arg nproc "$(nproc)" \
      --arg cpu "$(lscpu | sed -n 's/^Model name: *//p' | head -1)" --arg mem "$(free -m | awk '/^Mem:/ {print $2}')" \
      --arg kernel "$(uname -r)" --arg docker "$(docker version --format '{{.Server.Version}}')" \
      --arg driver "$(docker info --format '{{.Driver}}')" --argjson status "$(docker info --format '{{json .DriverStatus}}')" \
      --arg free "$(df -B1 --output=avail / | tail -1)" --arg conc "$(jq -r '."max-concurrent-downloads" // "default (3)"' /etc/docker/daemon.json 2>/dev/null || echo 'no daemon.json')" \
      '{runner: $runner, image: $image, nproc: ($nproc | tonumber), cpu: $cpu, memMb: ($mem | tonumber), kernel: $kernel,
        docker: $docker, storageDriver: $driver, driverStatus: $status,
        containerdSnapshotter: ($status | tostring | test("io.containerd.snapshotter")), maxConcurrentDownloads: $conc,
        diskFreeGb: (($free | tonumber) / 1e9 * 10 | round / 10)}' | tee "$OUT/machine.json"
    cat /etc/docker/daemon.json 2>/dev/null || true
    ;;
  pulls)
    order=(a b c d e)
    k=$(( ($2 - 1) % 5 ))
    for i in 0 1 2 3 4; do variant "${order[$(( (i + k) % 5 ))]}"; done
    ;;
  cache-before)
    order=(f g h)
    v=${order[$(( ($2 - 1 + $3 - 1) % 3 ))]}
    clean
    mkdir -p vc-cache
    echo "$v" > "$S/variant"; iso > "$S/at"; now > "$S/t0"; rm -f "$S/t1"
    case $v in
      f) k1=pw-tar; p1=vc-cache/pw.tar; k2=; p2= ;;
      g) k1=full-tar; p1=vc-cache/full.tar; k2=; p2= ;;
      h) k1=base-tar; p1=vc-cache/base.tar; k2=cft-zip; p2=vc-cache/chs.zip ;;
    esac
    {
      echo "variant=$v"
      echo "key1=vc-probe-$k1-$RUN"; echo "path1=$p1"
      echo "key2=${k2:+vc-probe-$k2-$RUN}"; echo "path2=$p2"
    } | tee -a "$GITHUB_OUTPUT"
    ;;
  cache-mid) now > "$S/t1" ;;
  cache-after)
    t2=$(now)
    v=$(cat "$S/variant"); t0=$(cat "$S/t0"); t1=$(cat "$S/t1")
    restore=$(since "$t0" "$t1"); restore2=$(since "$t1" "$t2")
    case $v in f) tar=pw; tag=vc-probe/playwright:cached ;; g) tar=full; tag=vc-probe/full:cached ;; h) tar=base; tag=vc-probe/base:cached ;; esac
    ls -l vc-cache
    l0=$(now); docker load -q -i "vc-cache/$tar.tar"; l1=$(now)
    id=$(docker image inspect -f '{{.Id}}' "$tag")
    parts=$(jq -cn --arg r "$restore" --arg l "$(since "$l0" "$l1")" '{restore: ($r | tonumber), load: ($l | tonumber)}')
    case $v in
      f) r=$(replies "$id" "$PW_EXE" "$NET") ;;
      g) r=$(replies "$id" "$EXE" "$NET") ;;
      h) mkdir -p "$W"; mv vc-cache/chs.zip "$W/chs.zip"
         u0=$(now); echo "$CFT_SHA  $W/chs.zip" | sha256sum -c --quiet; u1=$(now); unzip -q "$W/chs.zip" -d "$W/chs"; u2=$(now)
         parts=$(jq -cn --argjson p "$parts" --arg r2 "$restore2" --arg s "$(since "$u0" "$u1")" --arg u "$(since "$u1" "$u2")" \
           '$p + {restoreZip: ($r2 | tonumber), sha256: ($s | tonumber), unzip: ($u | tonumber)}')
         r=$(replies "$id" "$EXE" "$(MOUNT)") ;;
    esac
    record "$v" "$(cat "$S/at")" "$parts" "$r"
    ;;
esac

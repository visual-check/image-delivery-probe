#!/bin/bash
# Builds the base stage with apt pinned to the snapshot in several ways, in order, and keeps the first that works.
# The last way is unpinned, so a build always comes out. Writes what each way did to <out json>.
#   snapshot-attempts.sh <snapshot id> <out json> [--add-host flags...]
set -uo pipefail
ID=$1; OUT=$2; shift 2
H=$(cd "$(dirname "$0")" && pwd)
ARCH=$(uname -m)
http='-o Acquire::Snapshots::URI::Host::archive.ubuntu.com=http://snapshot.ubuntu.com/@PATH@/@SNAPSHOTID@/ -o Acquire::Snapshots::URI::Host::security.ubuntu.com=http://snapshot.ubuntu.com/@PATH@/@SNAPSHOTID@/ -o Acquire::Snapshots::URI::Host::ports.ubuntu.com=http://snapshot.ubuntu.com/@PATH@/@SNAPSHOTID@/'
ports='-o Acquire::Snapshots::URI::Host::ports.ubuntu.com=https://snapshot.ubuntu.com/@PATH@/@SNAPSHOTID@/'
# name | SNAPSHOT | APT_OPTS | CA_FIRST
ways=(
  "apt-defaults|$ID||0"
  "apt-defaults-ca-first|$ID||1"
  "http-snapshot-hosts|$ID|$http|0"
)
if [ "$ARCH" = aarch64 ]; then ways+=("ports-host-https-ca-first|$ID|$ports|1"); fi
ways+=("unpinned|||0")
# Is the snapshot service reachable at all? (Canonical had a DNS and service outage on 2026-11-11.)
snapip=$(printf '%s\n' "$@" | sed -n 's/^--add-host=snapshot.ubuntu.com://p')
reach() { curl -4 -s -m 20 -o /dev/null -w '%{http_code}' ${snapip:+--resolve "snapshot.ubuntu.com:${2:-443}:$snapip"} "$1"; }
reachable=$(jq -n --arg u "$(reach "https://snapshot.ubuntu.com/ubuntu/$ID/dists/noble/InRelease")" \
  --arg p "$(reach "https://snapshot.ubuntu.com/ubuntu-ports/$ID/dists/noble/InRelease")" \
  --arg a "$(reach "https://snapshot.ubuntu.com/ubuntu/$ID/dists/noble/main/binary-arm64/Release")" \
  --arg h "$(reach "http://snapshot.ubuntu.com/ubuntu/$ID/dists/noble/InRelease" 80)" \
  '{"https ubuntu": $u, "https ubuntu-ports": $p, "https ubuntu binary-arm64": $a, "http ubuntu": $h}')
echo "snapshot service: $reachable"
up=$(jq -r '[.[]] | any(. == "200")' <<< "$reachable")
echo '[]' > "$OUT.tmp"
chosen=
for w in "${ways[@]}"; do
  IFS='|' read -r name snap opts ca <<< "$w"
  echo "### $name"
  # With the service down, only the way that never contacts it on arm64 (no snapshot server for ports) says anything
  if [ "$up" != true ] && [ -n "$snap" ] && ! { [ "$ARCH" = aarch64 ] && [ "$name" = apt-defaults ]; }; then
    jq --arg n "$name" '. + [{name: $n, skipped: "snapshot service unreachable"}]' "$OUT.tmp" > "$OUT.tmp2" && mv "$OUT.tmp2" "$OUT.tmp"
    echo skipped; continue
  fi
  timeout 900 docker buildx build --builder probe --target base --progress plain "$@" \
    --build-arg "SNAPSHOT=$snap" --build-arg "APT_OPTS=$opts" --build-arg "CA_FIRST=$ca" \
    --output type=cacheonly "$H" > "/tmp/attempt-$name.log" 2>&1
  rc=$?
  grep -E 'index sources|snapshot.ubuntu.com|archive.ubuntu.com|ports.ubuntu.com|security.ubuntu.com|SNAPSHOT NOT USED|NO PACKAGE|Certificate|ERROR' "/tmp/attempt-$name.log" \
    | grep -vE '^#[0-9]+ (sha256|DONE|CACHED)' | cut -c1-200 | sort -u | head -20 > "/tmp/attempt-$name.brief"
  cat "/tmp/attempt-$name.brief"
  echo "exit $rc"
  jq --arg n "$name" --arg s "$snap" --arg o "$opts" --arg c "$ca" --argjson rc "$rc" --rawfile b "/tmp/attempt-$name.brief" \
    '. + [{name: $n, snapshot: $s, aptOpts: $o, caFirst: $c, ok: ($rc == 0), exit: $rc, log: $b}]' "$OUT.tmp" > "$OUT.tmp2" && mv "$OUT.tmp2" "$OUT.tmp"
  if [ $rc = 0 ]; then chosen=$name; break; fi
done
jq --arg id "$ID" --arg arch "$ARCH" --arg chosen "$chosen" --argjson reach "$reachable" \
  '{snapshot: $id, arch: $arch, serviceReachable: $reach, pinned: ($chosen != "unpinned" and $chosen != ""), chosen: $chosen, attempts: .,
    buildArgs: (map(select(.name == $chosen))[0] | {SNAPSHOT: .snapshot, APT_OPTS: .aptOpts, CA_FIRST: .caFirst})}' "$OUT.tmp" > "$OUT"
rm -f "$OUT.tmp"
jq '{snapshot, arch, pinned, chosen, buildArgs}' "$OUT"
[ -n "$chosen" ]

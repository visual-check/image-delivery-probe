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
echo '[]' > "$OUT.tmp"
chosen=
for w in "${ways[@]}"; do
  IFS='|' read -r name snap opts ca <<< "$w"
  echo "### $name"
  docker buildx build --builder probe --target base --progress plain "$@" \
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
jq --arg id "$ID" --arg arch "$ARCH" --arg chosen "$chosen" \
  '{snapshot: $id, arch: $arch, pinned: ($chosen != "unpinned" and $chosen != ""), chosen: $chosen, attempts: .,
    buildArgs: (map(select(.name == $chosen))[0] | {SNAPSHOT: .snapshot, APT_OPTS: .aptOpts, CA_FIRST: .caFirst})}' "$OUT.tmp" > "$OUT"
rm -f "$OUT.tmp"
jq '{snapshot, arch, pinned, chosen, buildArgs}' "$OUT"
[ -n "$chosen" ]

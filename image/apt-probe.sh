#!/bin/bash
# Tries ways to pin apt to an Ubuntu snapshot in a fresh ubuntu:24.04 container, one container per way.
#   apt-probe.sh <ubuntu image ref> <snapshot id>
# Prints, per way, which hosts apt fetched indexes from: pinned means only snapshot.ubuntu.com.
set -uo pipefail
IMG=$1; ID=$2
H=$(cd "$(dirname "$0")" && pwd)
ARCH=$(uname -m)
mapfile -t ADD < <("$H/hosts.sh")
echo "pinned hosts: ${ADD[*]}"
http_hosts='-o Acquire::Snapshots::URI::Host::archive.ubuntu.com=http://snapshot.ubuntu.com/@PATH@/@SNAPSHOTID@/ -o Acquire::Snapshots::URI::Host::security.ubuntu.com=http://snapshot.ubuntu.com/@PATH@/@SNAPSHOTID@/'
ports_https='-o Acquire::Snapshots::URI::Host::ports.ubuntu.com=https://snapshot.ubuntu.com/@PATH@/@SNAPSHOTID@/'
ports_http='-o Acquire::Snapshots::URI::Host::ports.ubuntu.com=http://snapshot.ubuntu.com/@PATH@/@SNAPSHOTID@/'
way() {
  local name=$1 pre=$2 opts=$3
  echo "### $name ($ARCH)"
  docker run --rm "${ADD[@]}" -e ID="$ID" "$IMG" bash -c "
    $pre
    apt-get $opts -o APT::Snapshot=\$ID update > /tmp/u.log 2>&1; rc=\$?
    echo \"update exit \$rc\"
    grep -E '^(Get|Hit|Err|Ign|W:|E:)' /tmp/u.log | cut -c1-160 | head -12
    echo \"sources: \$(grep -oE '^(Get|Hit):[0-9]+ https?://[^ ]+' /tmp/u.log | sed -E 's#^[^ ]+ (https?://[^/]+/[^/]+(/[0-9]{8}T[0-9]{6}Z)?).*#\\1#' | sort -u | tr '\n' ' ')\"
    echo \"index sources: \$(apt-cache policy | grep -E 'Packages\$' | awk '{print \$2}' | sort -u | tr '\n' ' ')\"
    grep -iE 'certif|tls|gnutls' /tmp/u.log | head -3
    apt-cache policy libnss3 | sed -n '2,4p'
  "
}
docker run --rm "$IMG" bash -c 'apt --version; dpkg-query -W ca-certificates 2>&1; cat /etc/apt/sources.list.d/ubuntu.sources | grep -E "^(URIs|Suites)"'
way default-config '' ''
way ca-certificates-first 'apt-get update -qq > /dev/null && apt-get install -y -qq --no-install-recommends ca-certificates > /dev/null 2>&1' ''
way http-override '' "$http_hosts $ports_http"
ca='apt-get update -qq > /dev/null && apt-get install -y -qq --no-install-recommends ca-certificates > /dev/null 2>&1'
way ports-host-https-ca-first "$ca" "$ports_https"
way ports-host-https-ca-first-fresh-lists "$ca && rm -rf /var/lib/apt/lists/*" "$ports_https"
way origin-override-ports-ca-first "$ca" '-o Acquire::Snapshots::URI::Override::Origin::Ubuntu=https://snapshot.ubuntu.com/ubuntu-ports/@SNAPSHOTID@/'

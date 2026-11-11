#!/bin/sh
# Installs packages, with apt pinned to an Ubuntu snapshot when SNAPSHOT is set. Fails if any package index then
# still comes from a live archive, since apt silently skips the snapshot for a source it has no snapshot server for.
#   SNAPSHOT=<id> APT_OPTS='<extra -o options>' CA_FIRST=0|1 apt-install.sh <packages...>
set -eu
opts="-o Acquire::Retries=5 -o Acquire::ForceIPv4=true ${APT_OPTS:-}"
if [ "${CA_FIRST:-0}" = 1 ]; then
  # The snapshot service is https only and the base image has no CA certificates: take them from the live archive.
  apt-get $opts update
  apt-get $opts install -y --no-install-recommends ca-certificates
  rm -rf /var/lib/apt/lists/*
fi
if [ -n "${SNAPSHOT:-}" ]; then
  opts="$opts -o APT::Snapshot=$SNAPSHOT"
fi
apt-get $opts update
sources=$(apt-cache policy | awk '/Packages$/ {print $2 " " $3}' | sort -u)
printf 'index sources:\n%s\n' "$sources"
[ -n "$sources" ] || { echo "NO PACKAGE INDEXES" >&2; exit 4; }
if [ -n "${SNAPSHOT:-}" ] && echo "$sources" | grep -qv "^https\?://snapshot.ubuntu.com/[^/]*/$SNAPSHOT"; then
  echo "SNAPSHOT NOT USED for every source" >&2
  exit 3
fi
apt-get $opts install -y --no-install-recommends "$@"
# What came from the live archive goes again, so everything left is from the snapshot
[ "${CA_FIRST:-0}" = 1 ] && apt-get $opts purge -y --auto-remove ca-certificates
rm -rf /var/lib/apt/lists/*

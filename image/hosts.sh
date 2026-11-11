#!/bin/bash
# Prints --add-host flags for the Ubuntu archive hosts apt needs, resolved here with retries (IPv4 only).
# Canonical's DNS answered SERVFAIL for most lookups on 2026-11-11; a build's own lookups then fail at random.
set -uo pipefail
for h in archive.ubuntu.com security.ubuntu.com ports.ubuntu.com snapshot.ubuntu.com; do
  ip=
  for _ in $(seq 1 60); do
    ip=$(getent ahostsv4 "$h" | awk 'NR == 1 {print $1}')
    [ -n "$ip" ] && break
    sleep 1
  done
  [ -n "$ip" ] && printf -- '--add-host=%s:%s\n' "$h" "$ip" || echo "unresolved $h" >&2
done

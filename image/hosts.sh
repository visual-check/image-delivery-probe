#!/bin/bash
# Prints --add-host flags for the Ubuntu archive hosts apt needs (IPv4). Canonical's DNS answered SERVFAIL for most
# lookups on 2026-11-11, so a build's own lookups failed at random: tries the system resolver a few times, then
# DNS over HTTPS (Cloudflare, then Google), whose caches still answered.
set -uo pipefail
doh() { curl -4 -s -m 10 -H 'accept: application/dns-json' "$1?name=$2&type=A" | jq -r '[.Answer[]? | select(.type == 1) | .data][0] // empty'; }
for h in archive.ubuntu.com security.ubuntu.com ports.ubuntu.com snapshot.ubuntu.com; do
  ip=
  for _ in 1 2 3; do
    ip=$(timeout 5 getent ahostsv4 "$h" | awk 'NR == 1 {print $1}')
    [ -n "$ip" ] && break
  done
  [ -z "$ip" ] && ip=$(doh https://cloudflare-dns.com/dns-query "$h")
  [ -z "$ip" ] && ip=$(doh https://dns.google/resolve "$h")
  if [ -n "$ip" ]; then printf -- '--add-host=%s:%s\n' "$h" "$ip"; else echo "unresolved $h" >&2; fi
done

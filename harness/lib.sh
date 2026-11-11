# Sourced. The docker run argv that starts headless shell with CDP on the container's stdin (fd 3) and stdout (fd 4).
# No Node in the image: sh moves the fds, then execs the browser.
#   docker_argv <browser args json file> <image> <exe> <docker args json> <extra browser args json>
docker_argv() {
  jq -cn --slurpfile f "$1" --arg img "$2" --arg exe "$3" --argjson d "$4" --argjson x "$5" \
    '["docker", "run", "-i", "--rm"] + $d + [$img, "sh", "-c", "exec \"$0\" \"$@\" 3<&0 4>&1 1>&2", $exe]
     + $f[0] + ["--user-data-dir=/tmp/u", "--remote-debugging-pipe"] + $x + ["about:blank"]'
}
# Seconds since the epoch, with nanoseconds
now() { date +%s.%N; }
# b - a, in seconds with 3 decimals
since() { awk -v a="$1" -v b="$2" 'BEGIN { printf "%.3f", b - a }'; }

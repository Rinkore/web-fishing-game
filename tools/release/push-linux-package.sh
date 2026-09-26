#!/usr/bin/env bash
# Push one release package to the deployment account over bounded, resumable
# SSH streams.
#
# The runner reaches the release host over a long-haul path (~245 ms, ~13%
# loss): a single TCP flow collapses to roughly 25 KB/s, so the previous
# sequential 4 MiB slice uploader needed about three minutes per slice and was
# killed by its own budget on every release. This tool spreads the archive over
# several independent flows instead:
#
#   * one connection per chunk, with session multiplexing disabled: a control
#     socket shares one TCP window for every channel, which is the bottleneck;
#   * each chunk lands at an absolute offset, so a stall costs one retry rather
#     than the whole transfer and every retry is idempotent;
#   * every chunk is hashed on both sides. Chunks that already match are not
#     uploaded again, so a rerun after a failure resumes from the verified
#     chunks instead of starting over;
#   * the whole archive is re-hashed remotely before this tool reports success.
#
# The caller still gates the deployer on the archive SHA-256 as well.
set -euo pipefail

usage() {
  cat <<'USAGE' >&2
Usage: push-linux-package.sh --host HOST --port PORT --user USER --key FILE
         --known-hosts FILE --local FILE --remote PATH --sha256 HEX
         [--streams N] [--deadline SECONDS] [--chunk-bytes BYTES] [--attempts N]
         [--chunk-timeout SECONDS] [--helper-timeout SECONDS] [--control-path SOCKET]
USAGE
}

host=''
port=''
user=''
key=''
known_hosts=''
local_package=''
remote_path=''
sha256=''
# The deploy host keeps the default sshd MaxStartups (10:30:100) and every chunk
# opens its own connection, so eight flows stay below the point where sshd starts
# dropping unauthenticated sessions while still multiplying the per-flow rate.
streams=8
deadline_seconds=1200
chunk=$((4 * 1024 * 1024))
attempts=3
chunk_timeout=300
helper_timeout=120
control_path=''

while (($#)); do
  case "$1" in
    --host) host="${2:?--host needs a value}"; shift 2 ;;
    --port) port="${2:?--port needs a value}"; shift 2 ;;
    --user) user="${2:?--user needs a value}"; shift 2 ;;
    --key) key="${2:?--key needs a value}"; shift 2 ;;
    --known-hosts) known_hosts="${2:?--known-hosts needs a value}"; shift 2 ;;
    --local) local_package="${2:?--local needs a value}"; shift 2 ;;
    --remote) remote_path="${2:?--remote needs a value}"; shift 2 ;;
    --sha256) sha256="${2:?--sha256 needs a value}"; shift 2 ;;
    --streams) streams="${2:?--streams needs a value}"; shift 2 ;;
    --deadline) deadline_seconds="${2:?--deadline needs a value}"; shift 2 ;;
    --chunk-bytes) chunk="${2:?--chunk-bytes needs a value}"; shift 2 ;;
    --attempts) attempts="${2:?--attempts needs a value}"; shift 2 ;;
    --chunk-timeout) chunk_timeout="${2:?--chunk-timeout needs a value}"; shift 2 ;;
    --helper-timeout) helper_timeout="${2:?--helper-timeout needs a value}"; shift 2 ;;
    --control-path) control_path="${2:?--control-path needs a value}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage; exit 2 ;;
  esac
done

[[ $host =~ ^[A-Za-z0-9][A-Za-z0-9.-]*$ ]] || { echo 'Pass --host with the deployment host name.' >&2; exit 2; }
[[ $port =~ ^[0-9]{1,5}$ ]] && ((10#$port > 0 && 10#$port <= 65535)) || { echo 'Pass --port with the SSH port.' >&2; exit 2; }
[[ $user =~ ^[A-Za-z0-9_.-]+$ ]] || { echo 'Pass --user with the deployment account.' >&2; exit 2; }
[[ -n $key && -f $key ]] || { echo 'Pass --key with the private key file.' >&2; exit 2; }
[[ -n $known_hosts && -f $known_hosts ]] || { echo 'Pass --known-hosts with the verified host keys.' >&2; exit 2; }
[[ -n $local_package && -f $local_package ]] || { echo 'Pass --local with the package to upload.' >&2; exit 2; }
[[ $remote_path =~ ^/[A-Za-z0-9_./-]+$ ]] || { echo 'Pass --remote as an absolute path without spaces.' >&2; exit 2; }
[[ $sha256 =~ ^[0-9a-f]{64}$ ]] || { echo 'Pass --sha256 with the lowercase archive SHA-256.' >&2; exit 2; }
[[ $streams =~ ^[0-9]+$ ]] && ((streams >= 1 && streams <= 8)) || { echo 'Pass --streams between 1 and 8.' >&2; exit 2; }
[[ $deadline_seconds =~ ^[0-9]+$ ]] && ((deadline_seconds >= 60)) || { echo 'Pass --deadline of at least 60 seconds.' >&2; exit 2; }
[[ $chunk =~ ^[0-9]+$ ]] && ((chunk >= 1048576 && chunk % 1048576 == 0)) \
  || { echo 'Pass --chunk-bytes as a whole number of MiB.' >&2; exit 2; }
[[ $attempts =~ ^[0-9]+$ ]] && ((attempts >= 1 && attempts <= 10)) || { echo 'Pass --attempts between 1 and 10.' >&2; exit 2; }
[[ $chunk_timeout =~ ^[0-9]+$ ]] && ((chunk_timeout >= 30)) || { echo 'Pass --chunk-timeout of at least 30 seconds.' >&2; exit 2; }
[[ $helper_timeout =~ ^[0-9]+$ ]] && ((helper_timeout >= 30)) || { echo 'Pass --helper-timeout of at least 30 seconds.' >&2; exit 2; }

destination="$user@$host"
size="$(stat -c %s -- "$local_package")"
((size > 0)) || { echo 'The package is empty.' >&2; exit 2; }
chunks=$(((size + chunk - 1) / chunk))
started=$(date +%s)
deadline=$((started + deadline_seconds))
work="$(mktemp -d)"
trap 'rm -rf -- "$work"' EXIT
hash_file="$work/chunks.txt"

export local_package size chunk chunks attempts chunk_timeout deadline_seconds deadline
export remote_path destination port key known_hosts control_path helper_timeout hash_file

# One dedicated connection per chunk. Compression is off because the package is
# already gzip, and the interactive low-delay QoS of a normal session is not
# wanted for bulk data.
stream_ssh() {
  timeout "$chunk_timeout" ssh \
    -i "$key" -o BatchMode=yes -o IdentitiesOnly=yes \
    -o StrictHostKeyChecking=yes -o "UserKnownHostsFile=$known_hosts" \
    -o ConnectTimeout=20 -o ConnectionAttempts=2 \
    -o ServerAliveInterval=10 -o ServerAliveCountMax=4 -o TCPKeepAlive=yes \
    -o ControlMaster=no -o ControlPath=none -o Compression=no -o IPQoS=throughput \
    -p "$port" "$destination" "$1"
}

# Short helpers may reuse one multiplexed connection: they never carry the
# package, and the mux keeps the per-call handshake out of the critical path.
helper_ssh() {
  if [[ -n $control_path ]]; then
    timeout "$helper_timeout" ssh \
      -i "$key" -o BatchMode=yes -o IdentitiesOnly=yes \
      -o StrictHostKeyChecking=yes -o "UserKnownHostsFile=$known_hosts" \
      -o ConnectTimeout=15 -o ServerAliveInterval=15 -o ServerAliveCountMax=3 \
      -o ControlMaster=auto -o "ControlPath=$control_path" -o ControlPersist=60 \
      -p "$port" "$destination" "$1"
  else
    timeout "$helper_timeout" ssh \
      -i "$key" -o BatchMode=yes -o IdentitiesOnly=yes \
      -o StrictHostKeyChecking=yes -o "UserKnownHostsFile=$known_hosts" \
      -o ConnectTimeout=15 -o ServerAliveInterval=15 -o ServerAliveCountMax=3 \
      -o ControlMaster=no -o ControlPath=none \
      -p "$port" "$destination" "$1"
  fi
}

# Digest of one 1 MiB aligned region on the server. dd reads to EOF, so the last
# chunk is hashed over exactly its own bytes.
remote_chunk_digest() {
  local offset=$(( $1 * chunk ))
  local length=$((size - offset))
  ((length <= chunk)) || length=$chunk
  helper_ssh "dd if='$remote_path' bs=1M skip=$((offset / 1048576)) count=$(((length + 1048575) / 1048576)) 2>/dev/null | sha256sum | cut -d' ' -f1"
}

upload_chunk() {
  local index="$1"
  local offset=$((index * chunk))
  local length=$((size - offset))
  ((length <= chunk)) || length=$chunk
  local seek=$((offset / 1048576))
  local want got attempt
  want="$(sed -n "$((index + 1))p" "$hash_file" | cut -d' ' -f2)"
  for ((attempt = 1; attempt <= attempts; attempt++)); do
    if (($(date +%s) + chunk_timeout > deadline)); then
      printf 'Chunk %d/%d at offset %d was not attempted: the %d second upload budget is spent.\n' \
        "$((index + 1))" "$chunks" "$offset" "$deadline_seconds" >&2
      return 1
    fi
    if dd if="$local_package" bs=256K iflag=skip_bytes,count_bytes skip="$offset" count="$length" status=none \
      | stream_ssh "dd of='$remote_path' bs=1M seek=$seek conv=notrunc 2>/dev/null"; then
      got="$(remote_chunk_digest "$index")"
      if [[ $got == "$want" ]]; then
        printf 'Chunk %d/%d verified (%d bytes at offset %d).\n' \
          "$((index + 1))" "$chunks" "$length" "$offset"
        return 0
      fi
      printf 'Chunk %d/%d landed with a different digest on attempt %d; uploading it again.\n' \
        "$((index + 1))" "$chunks" "$attempt" >&2
    else
      printf 'Chunk %d/%d at offset %d stalled on attempt %d; retrying on a fresh connection.\n' \
        "$((index + 1))" "$chunks" "$offset" "$attempt" >&2
    fi
    sleep 3
  done
  return 1
}
export -f stream_ssh helper_ssh remote_chunk_digest upload_chunk

# Local digests first, so the remote pass can tell which chunks are already in
# place. This is one sequential read of the package on the runner, not a round
# trip.
index=0
while ((index < chunks)); do
  offset=$((index * chunk))
  length=$((size - offset))
  ((length <= chunk)) || length=$chunk
  dd if="$local_package" bs=256K iflag=skip_bytes,count_bytes skip="$offset" count="$length" status=none \
    | sha256sum | cut -d' ' -f1 \
    | sed "s/^/$index /" >>"$hash_file"
  index=$((index + 1))
done

printf 'Package %s bytes as %d chunks of %d bytes over up to %d connections.\n' \
  "$size" "$chunks" "$chunk" "$streams"
helper_ssh "mkdir -p -- '$(dirname -- "$remote_path")' && truncate -s $size '$remote_path'"

# One round trip returns every chunk digest the server already holds, so a rerun
# after a failure only sends the chunks that are missing or wrong.
if ! helper_ssh "sh -s -- '$remote_path' $size $chunk $chunks" >"$work/remote.txt" <<'REMOTE'
f=$1
s=$2
c=$3
n=$4
i=0
while [ "$i" -lt "$n" ]; do
  off=$((i * c))
  len=$((s - off))
  [ "$len" -le "$c" ] || len=$c
  printf '%s ' "$i"
  dd if="$f" bs=1M skip=$((off / 1048576)) count=$(((len + 1048575) / 1048576)) 2>/dev/null \
    | sha256sum | cut -d' ' -f1
  i=$((i + 1))
done
REMOTE
then
  echo 'Could not read the chunk digests already stored on the server.' >&2
  exit 1
fi

declare -A verified=()
while read -r remote_index remote_digest; do
  [[ -n $remote_index && -n $remote_digest ]] && verified[$remote_index]="$remote_digest"
done <"$work/remote.txt"

missing=()
index=0
while ((index < chunks)); do
  want="$(sed -n "$((index + 1))p" "$hash_file" | cut -d' ' -f2)"
  [[ ${verified[$index]:-} == "$want" ]] || missing+=("$index")
  index=$((index + 1))
done

if ((${#missing[@]})); then
  (( ${#missing[@]} == chunks )) || printf 'Reusing %d chunks the server already verified.\n' "$((chunks - ${#missing[@]}))"
  status=0
  printf '%s\n' "${missing[@]}" | xargs -P "$streams" -I{} bash -o pipefail -c 'upload_chunk "$1"' _ {} || status=$?
  ((status == 0)) || { echo 'Chunk upload failed; rerun the deployment job to resume it.' >&2; exit 1; }
else
  printf 'Every chunk already matches; nothing to upload.\n'
fi

helper_ssh "test -f '$remote_path' && printf '%s  %s\n' '$sha256' '$remote_path' | sha256sum --check --status" \
  || { echo 'Remote package SHA-256 mismatch; refusing to hand the package to the deployer.' >&2; exit 1; }
printf 'Uploaded and verified %d bytes in %d seconds.\n' "$size" "$(($(date +%s) - started))"

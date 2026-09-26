#!/usr/bin/env bash
# Regression suite for tools/release/push-linux-package.sh.
#
# That tool carries the ~43 MB release archive to the deployment host over a
# long-haul link where one TCP flow collapses, so the properties worth pinning
# are all about connections and bytes: several flows at once, a stalled chunk
# costing one retry instead of the archive, a rerun keeping the chunks that
# already landed, and no path that hands the deployer unverified bytes. None of
# it is observable during a release, so the remote side is faked: the stub `ssh`
# runs the remote command on this host, which lets the suite assert on real
# files, real retries and real connection concurrency.
set -euo pipefail

script_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
pusher="$script_root/tools/release/push-linux-package.sh"
asset='web-fishing-game-linux-amd64.tar.gz'
commit="$(printf 'c%.0s' {1..40})"
failures=0

ok() { printf 'ok   - %s\n' "$1"; }
bad() {
  printf 'FAIL - %s\n' "$1"
  failures=$((failures + 1))
}
expect_eq() { # description expected actual
  if [[ "$2" == "$3" ]]; then ok "$1"; else bad "$1 (expected '$2', got '$3')"; fi
}
expect_zero() { if (($2 == 0)); then ok "$1"; else bad "$1 (exit $2)"; fi }
expect_nonzero() { if (($2 != 0)); then ok "$1"; else bad "$1 (unexpected exit 0)"; fi }

sandbox=''
package_size=$((7 * 512 * 1024)) # 3.5 MiB: four 1 MiB chunks with a short tail
stub_env=()

cleanup() {
  if [[ -n "$sandbox" && -d "$sandbox" ]]; then rm -rf -- "$sandbox"; fi
}
trap cleanup EXIT

write_ssh_stub() {
  cat > "$sandbox/bin/ssh" <<'STUB'
#!/usr/bin/env bash
# Stand-in for ssh: record the call, then run the remote command on this host so
# the suite can inspect the bytes that would have landed on the server.
set -uo pipefail
arguments=("$@")
printf '%s\n' "${arguments[*]}" >> "$STUB_ARGS"
for value in "${arguments[@]}"; do
  [[ "$value" == '-O' ]] && exit 0
done
command_line="${arguments[${#arguments[@]}-1]}"
if [[ "$command_line" != *'dd of='* ]]; then exec bash -c "$command_line"; fi
seek="$(printf '%s' "$command_line" | sed -n 's/.*seek=\([0-9]*\).*/\1/p')"
printf 'A %s %s\n' "$(date +%s%N)" "$seek" >> "$STUB_EVENTS"
if [[ -n "${STUB_SLEEP:-}" ]]; then sleep "$STUB_SLEEP"; fi
if [[ -n "${STUB_STALL_SEEK:-}" && "$seek" == "$STUB_STALL_SEEK" && ! -e "$STUB_STALLS/$seek" ]]; then
  mkdir -p "$STUB_STALLS"
  : > "$STUB_STALLS/$seek"
  printf 'B %s %s\n' "$(date +%s%N)" "$seek" >> "$STUB_EVENTS"
  exit 1
fi
status=0
bash -c "$command_line" || status=$?
printf 'B %s %s\n' "$(date +%s%N)" "$seek" >> "$STUB_EVENTS"
exit "$status"
STUB
  chmod +x "$sandbox/bin/ssh"
}

new_sandbox() {
  cleanup
  stub_env=()
  sandbox="$(mktemp -d)"
  mkdir -p "$sandbox/bin" "$sandbox/runner" "$sandbox/stalls" "$sandbox/remote/incoming/$commit"
  head -c "$package_size" /dev/urandom > "$sandbox/runner/$asset"
  sha="$(sha256sum "$sandbox/runner/$asset" | cut -d' ' -f1)"
  remote="$sandbox/remote/incoming/$commit/$asset"
  : > "$sandbox/runner/key"
  : > "$sandbox/runner/known_hosts"
  : > "$sandbox/ssh.args"
  : > "$sandbox/ssh.events"
  write_ssh_stub
}

run_pusher() { # digest [extra arguments...]
  local digest="$1"
  shift
  local status=0
  env -u STUB_STALL_SEEK -u STUB_SLEEP \
    PATH="$sandbox/bin:$PATH" \
    STUB_ARGS="$sandbox/ssh.args" STUB_EVENTS="$sandbox/ssh.events" STUB_STALLS="$sandbox/stalls" \
    ${stub_env[@]+"${stub_env[@]}"} \
    bash "$pusher" --host deploy.invalid --port 22 --user fishing-deploy \
    --key "$sandbox/runner/key" --known-hosts "$sandbox/runner/known_hosts" \
    --local "$sandbox/runner/$asset" --remote "$remote" --sha256 "$digest" \
    --control-path "$sandbox/runner/control" "$@" > "$sandbox/out" 2>&1 || status=$?
  printf '%s' "$status"
}

count_calls() { # pattern
  local count
  count="$(grep -c -- "$1" "$sandbox/ssh.args" || true)"
  printf '%s' "${count:-0}"
}

distinct_chunks() {
  awk '$1 == "A" { print $3 }' "$sandbox/ssh.events" | sort -n -u | wc -l | tr -d ' '
}

max_connections() {
  sort -k2,2n -k1,1 "$sandbox/ssh.events" |
    awk '$1 == "A" { live++; if (live > peak) peak = live } $1 == "B" { live-- } END { print peak + 0 }'
}

remote_sha() { sha256sum "$remote" | cut -d' ' -f1; }

echo '== parallel chunk upload'
new_sandbox
stub_env=(STUB_SLEEP=0.4)
status="$(run_pusher "$sha" --streams 4 --chunk-bytes 1048576 --chunk-timeout 120 --deadline 1200)"
expect_zero 'a healthy link transfers the package' "$status"
expect_eq 'the remote package is byte-identical' "$sha" "$(remote_sha)"
expect_eq 'the remote package keeps the exact size' "$package_size" "$(stat -c %s "$remote")"
expect_eq 'one chunk per archive block' '4' "$(distinct_chunks)"
expect_eq 'every chunk travels on its own TCP flow' '4' "$(count_calls '-o ControlMaster=no')"
expect_eq 'the payload never reuses the multiplexed socket' '4' "$(count_calls '-o ControlPath=none')"
if (($(max_connections) >= 2)); then
  ok 'chunks transfer concurrently'
else
  bad "chunks transfer concurrently (peak $(max_connections))"
fi
if grep -q "Uploaded and verified $package_size bytes" "$sandbox/out"; then
  ok 'a verified transfer reports success'
else
  bad 'a verified transfer reports success'
fi

echo '== stalled chunk is retried instead of restarting the archive'
new_sandbox
stub_env=(STUB_STALL_SEEK=1)
status="$(run_pusher "$sha" --streams 1 --attempts 3 --chunk-bytes 1048576 --chunk-timeout 120 --deadline 1200)"
expect_zero 'the transfer survives one stalled chunk' "$status"
expect_eq 'the retried transfer is still byte-identical' "$sha" "$(remote_sha)"
expect_eq 'the stalled chunk was sent again' '2' "$(count_calls 'seek=1 conv=notrunc')"
expect_eq 'finished chunks were not resent' '1' "$(count_calls 'seek=0 conv=notrunc')"

echo '== digest mismatch is refused'
new_sandbox
status="$(run_pusher "$(printf '0%.0s' {1..64})" --streams 2 --chunk-bytes 1048576 --chunk-timeout 120 --deadline 1200)"
expect_nonzero 'a wrong archive digest fails the transfer' "$status"
if grep -q 'Uploaded and verified' "$sandbox/out"; then
  bad 'a wrong archive digest must not report success'
else
  ok 'a wrong archive digest must not report success'
fi

echo '== a rerun keeps the chunks that already landed'
new_sandbox
stub_env=(STUB_STALL_SEEK=3)
status="$(run_pusher "$sha" --streams 1 --attempts 1 --chunk-bytes 1048576 --chunk-timeout 120 --deadline 1200)"
expect_nonzero 'a run that loses its last chunk reports failure' "$status"
: > "$sandbox/ssh.args"
stub_env=()
status="$(run_pusher "$sha" --streams 1 --chunk-bytes 1048576 --chunk-timeout 120 --deadline 1200)"
expect_zero 'the rerun finishes the transfer' "$status"
expect_eq 'the rerun lands byte-identical content' "$sha" "$(remote_sha)"
expect_eq 'the rerun only sends the missing chunk' '1' "$(count_calls 'dd of=')"
if grep -q 'Reusing 3 chunks the server already verified.' "$sandbox/out"; then
  ok 'the rerun reports the chunks it reused'
else
  bad 'the rerun reports the chunks it reused'
fi
: > "$sandbox/ssh.args"
status="$(run_pusher "$sha" --streams 1 --chunk-bytes 1048576 --chunk-timeout 120 --deadline 1200)"
expect_zero 'an already transferred package still verifies' "$status"
expect_eq 'an already transferred package is not sent again' '0' "$(count_calls 'dd of=')"

echo '== invalid invocations never reach the network'
new_sandbox
for case in '--streams 0' '--streams 9' '--chunk-bytes 1000' '--deadline 30' '--attempts 0' '--nonexistent-flag'; do
  # shellcheck disable=SC2086
  status="$(run_pusher "$sha" $case)"
  expect_eq "rejects '$case'" '2' "$status"
done
status="$(run_pusher "$sha" --remote 'incoming/relative.tar.gz')"
expect_eq 'rejects a relative remote path' '2' "$status"
status="$(run_pusher "$sha" --local "$sandbox/runner/missing.tar.gz")"
expect_eq 'rejects a missing local package' '2' "$status"
expect_eq 'failed validation opened no connection' '0' "$(wc -l < "$sandbox/ssh.args" | tr -d ' ')"
status="$(run_pusher "$sha" --streams 2)"
expect_zero 'accepts the defaults for the optional flags' "$status"

echo
if ((failures)); then
  printf 'Release upload checks failed: %d check(s).\n' "$failures"
  exit 1
fi
printf 'Release upload checks passed: chunk geometry, byte identity, parallel flows, stall retry, digest rejection, rerun resume and argument validation.\n'

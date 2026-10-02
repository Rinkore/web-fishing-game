#!/usr/bin/env bash
# Best-effort sender-side tuning for the release transfer.
#
# The release host sits behind a ~245 ms, ~13% loss international path, and that
# loss is what collapses a single CUBIC flow to roughly 25 KB/s. The uploader
# answers the collapse with parallel flows; this script removes the other half
# of the problem on the runner, which otherwise sends with whatever congestion
# control its image happens to ship:
#
#   * BBR stops reading loss as congestion, which is exactly what this path
#     punishes, so a paced flow keeps most of its rate;
#   * fq gives BBR the pacing it expects;
#   * PMTU probing recovers a path whose ICMP replies are filtered.
#
# Every change is best effort. A runner image that refuses any of them must not
# fail a release, so the script reports what the kernel ended up with instead of
# asserting that the tuning took effect.
set -euo pipefail

sudo -n modprobe tcp_bbr >/dev/null 2>&1 || true
sudo -n sysctl -q -w net.core.default_qdisc=fq >/dev/null 2>&1 || true
sudo -n sysctl -q -w net.ipv4.tcp_congestion_control=bbr >/dev/null 2>&1 || true
sudo -n sysctl -q -w net.ipv4.tcp_mtu_probing=1 >/dev/null 2>&1 || true
if command -v ip >/dev/null 2>&1 && command -v tc >/dev/null 2>&1; then
  interface="$(ip -o route show default 2>/dev/null | awk '{print $5; exit}' || true)"
  if [[ -n "$interface" ]]; then
    sudo -n tc qdisc replace dev "$interface" root fq >/dev/null 2>&1 || true
  fi
fi
printf 'Release transfer path: congestion control %s, default qdisc %s, MTU probing %s.\n' \
  "$(cat /proc/sys/net/ipv4/tcp_congestion_control 2>/dev/null || echo unknown)" \
  "$(cat /proc/sys/net/core/default_qdisc 2>/dev/null || echo unknown)" \
  "$(cat /proc/sys/net/ipv4/tcp_mtu_probing 2>/dev/null || echo unknown)"

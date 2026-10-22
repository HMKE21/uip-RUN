#!/usr/bin/env bash
# Blocks sandbox containers from reaching private networks, the cloud metadata service and the HOST itself (every address of it,
# not only the bridge gateway). They keep normal Internet access (npm, Packagist, PyPI). Run as root; the systemd unit runs it
# before every start. Docker evaluates DOCKER-USER before its own rules.
set -euo pipefail
NET=${SANDBOX_NETWORK:-uip-sandbox}
docker network inspect "$NET" >/dev/null 2>&1 \
  || docker network create --opt com.docker.network.bridge.enable_icc=false "$NET" >/dev/null
SUBNET=$(docker network inspect "$NET" -f '{{(index .IPAM.Config 0).Subnet}}')
NETID=$(docker network inspect "$NET" -f '{{.Id}}' | cut -c1-12)
BRIDGE="br-$NETID"
CHAIN=UIP-SANDBOX

iptables -N "$CHAIN" 2>/dev/null || iptables -F "$CHAIN"
iptables -C DOCKER-USER -s "$SUBNET" -j "$CHAIN" 2>/dev/null || iptables -I DOCKER-USER -s "$SUBNET" -j "$CHAIN"

iptables -A "$CHAIN" -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN
iptables -A "$CHAIN" -d "$SUBNET" -j DROP                 # containers can't talk to each other
for NETWORK in 0.0.0.0/8 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 100.64.0.0/10 169.254.0.0/16 127.0.0.0/8 192.0.0.0/24 198.18.0.0/15 224.0.0.0/3; do
  iptables -A "$CHAIN" -d "$NETWORK" -j DROP              # private ranges, cloud metadata (169.254.169.254), multicast, reserved
done
for PORT in 25 465 587 2525; do iptables -A "$CHAIN" -p tcp --dport "$PORT" -j DROP; done   # no outgoing mail
for PORT in 22 23 445 3389; do iptables -A "$CHAIN" -p tcp --dport "$PORT" -j DROP; done    # no SSH / telnet / SMB / RDP
iptables -A "$CHAIN" -p tcp --syn -m connlimit --connlimit-above 300 -j DROP   # no connection floods / port scans
iptables -A "$CHAIN" -j RETURN

# Container -> HOST (INPUT): replies to connections the host opened are allowed, everything else is dropped on ANY host address.
iptables -C INPUT -s "$SUBNET" -j DROP 2>/dev/null || iptables -I INPUT -s "$SUBNET" -j DROP
iptables -C INPUT -s "$SUBNET" -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT 2>/dev/null \
  || iptables -I INPUT -s "$SUBNET" -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT

if command -v ip6tables >/dev/null 2>&1; then
  ip6tables -C FORWARD -i "$BRIDGE" -j DROP 2>/dev/null || ip6tables -I FORWARD -i "$BRIDGE" -j DROP 2>/dev/null || true
fi
echo "egress rules installed for $NET ($SUBNET, $BRIDGE)"

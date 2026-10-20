#!/usr/bin/env bash
# Blocks sandbox containers from reaching private networks, the cloud metadata service and the host itself.
# They keep normal Internet access (npm, Packagist, PyPI). Run once as root, and again after every reboot
# (or put it in a systemd unit). Docker evaluates the DOCKER-USER chain before its own rules.
set -euo pipefail
NET=${SANDBOX_NETWORK:-uip-sandbox}
docker network inspect "$NET" >/dev/null 2>&1 || docker network create "$NET" >/dev/null
SUBNET=$(docker network inspect "$NET" -f '{{(index .IPAM.Config 0).Subnet}}')
GW=$(docker network inspect "$NET" -f '{{(index .IPAM.Config 0).Gateway}}')
CHAIN=UIP-SANDBOX
iptables -N "$CHAIN" 2>/dev/null || iptables -F "$CHAIN"
iptables -C DOCKER-USER -s "$SUBNET" -j "$CHAIN" 2>/dev/null || iptables -I DOCKER-USER -s "$SUBNET" -j "$CHAIN"
iptables -A "$CHAIN" -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN
iptables -A "$CHAIN" -d "$SUBNET" -j DROP                # containers can't talk to each other
for NETWORK in 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 100.64.0.0/10 169.254.0.0/16 127.0.0.0/8; do
  iptables -A "$CHAIN" -d "$NETWORK" -j DROP             # private ranges + cloud metadata (169.254.169.254)
done
iptables -A "$CHAIN" -p tcp --dport 25 -j DROP           # no outgoing mail
iptables -A "$CHAIN" -p tcp --dport 22 -j DROP           # no SSH from the sandbox
iptables -A "$CHAIN" -j RETURN
# the host itself (gateway, SSH, Docker API …) is reached through the bridge gateway address
iptables -C INPUT -s "$SUBNET" -d "$GW" -j DROP 2>/dev/null || iptables -I INPUT -s "$SUBNET" -d "$GW" -j DROP
echo "egress rules installed for $NET ($SUBNET)"

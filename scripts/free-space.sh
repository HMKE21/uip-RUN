#!/usr/bin/env bash
# Shows what fills the server disk and (optionally) removes the safe stuff.
#   bash scripts/free-space.sh            # report only
#   bash scripts/free-space.sh --clean    # + remove Docker build cache, dangling images, stopped containers, old journal logs
# It never removes running containers, tagged images or volumes.
set -u
D() { if docker info >/dev/null 2>&1; then docker "$@"; else sudo docker "$@"; fi; }
echo "== disk ==";            df -h / | sed -n '1,2p'
echo; echo "== docker usage =="; D system df 2>/dev/null || echo "(docker not reachable)"
echo; echo "== images (largest first) =="; D images --format '{{.Size}}\t{{.Repository}}:{{.Tag}}\t{{.ID}}' 2>/dev/null | sort -hr | head -15
echo; echo "== biggest folders in your home =="; du -xh --max-depth=2 "$HOME" 2>/dev/null | sort -hr | head -12
echo; echo "== system logs =="; sudo du -sh /var/log /var/lib/docker/containers 2>/dev/null
if [ "${1:-}" = "--clean" ]; then
  echo; echo "== cleaning =="
  D builder prune -af
  D image prune -f
  D container prune -f
  sudo journalctl --vacuum-size=100M 2>/dev/null || true
  command -v dnf >/dev/null && sudo dnf clean all >/dev/null 2>&1 || true
  echo; df -h / | sed -n '1,2p'
else
  echo; echo "Run with --clean to remove the build cache / dangling images / stopped containers."
  echo "Still short on space? Enlarge the EBS volume (AWS console → Volumes → Modify → 40 GB+), then:"
  echo "  lsblk; sudo growpart /dev/nvme0n1 1; sudo xfs_growfs -d /     (ext4: sudo resize2fs /dev/nvme0n1p1)"
fi

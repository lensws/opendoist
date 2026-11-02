#!/bin/bash
# Installed as /usr/local/sbin/opendoist-deploy, owned by root.
# This trusted installed copy is not updated automatically from application commits.
set -Eeuo pipefail
export PATH=/usr/sbin:/usr/bin:/sbin:/bin
if [[ $# != 2 || ! $2 =~ ^[0-9a-f]{40}$ ]]; then exit 64; fi
case "$1" in
  main) tier=prod; project=opendoist-prod; domain=do.lensws.be ;;
  beta) tier=beta; project=opendoist-beta; domain=beta.lensws.be ;;
  *) exit 64 ;;
esac
[[ $EUID == 0 ]] || exit 77
branch=$1
commit=$2
# A single lock serializes builds on the 1 GB VPS, including different branches.
exec 9>/run/lock/opendoist-deploy.lock
flock -w 1200 9
cd "/opt/opendoist/$tier"
# Never source .env or print resolved Compose configuration (contains credentials).
compose() { docker compose --project-name "$project" "$@"; }
git fetch --quiet origin "+refs/heads/$branch:refs/remotes/origin/$branch"
if [[ $(git rev-parse "refs/remotes/origin/$branch") != "$commit" ]]; then
  echo "Skipping superseded $branch commit $commit"
  exit 0
fi
previous_commit=$(git rev-parse HEAD)
container=$(compose ps -q opendoist)
[[ -n $container ]] || { echo 'Existing installation required'; exit 1; }
previous_image=$(docker inspect --format '{{.Image}}' "$container")
rollback() {
  code=$?
  trap - ERR
  echo "Deployment failed ($code); restoring previous code/image. Database is not overwritten."
  git checkout --quiet --detach "$previous_commit"
  docker image tag "$previous_image" "$project-opendoist:latest"
  if compose up -d --no-build --wait --wait-timeout 120; then
    echo "Previous version restored: $previous_commit"
  else
    echo 'Rollback healthcheck failed: administrator action required.' >&2
  fi
  exit "$code"
}
trap rollback ERR
# Build first, while the existing container continues serving requests.
git checkout --quiet --detach "$commit"
compose build
# Backup the currently running database before activating the new version.
backup_name="$(date -u +%Y%m%dT%H%M%S)-${commit:0:12}.sqlite"
backup_dir="/var/backups/opendoist/$tier"
install -d -m 700 "$backup_dir"
compose exec -T opendoist node server/backup.js "/app/data/$backup_name"
compose cp "opendoist:/app/data/$backup_name" "$backup_dir/$backup_name"
chmod 600 "$backup_dir/$backup_name"
compose exec -T opendoist rm -- "/app/data/$backup_name"
compose up -d --no-build --wait --wait-timeout 120
curl --fail --silent --show-error --retry 3 --retry-delay 3 "https://$domain/healthz"
printf '\nDeployed %s to %s (%s)\n' "$commit" "$domain" "$tier"
trap - ERR

#!/usr/bin/env bash
# CI-only: isolated Compose project; never run against a user's installation.
set -euo pipefail
[[ ${GITHUB_ACTIONS:-} == true ]] || { echo 'This smoke test runs only in GitHub Actions.' >&2; exit 1; }
install_test_dir=$(mktemp -d /tmp/opendoist-install-test-XXXXXXXX)
rmdir "$install_test_dir"
install_test_password=$(mktemp)
cleanup() {
  if [[ -f $install_test_dir/compose.yaml ]]; then sudo docker compose --project-directory "$install_test_dir" --env-file "$install_test_dir/.env" -f "$install_test_dir/compose.yaml" down -v >/dev/null 2>&1 || true; fi
  sudo rm -rf "$install_test_dir"
  rm -f "$install_test_password"
}
trap cleanup EXIT
printf '%s' 'CI-only $literal ${VALUE} "quoted" \backslash password' > "$install_test_password"
chmod 600 "$install_test_password"
sudo bash install/install.sh --local --dir "$install_test_dir" --ref "$GITHUB_SHA" --port 32991 --password-file "$install_test_password"
node install/smoke-check.mjs create "$install_test_password"
config_before=$(sudo sha256sum "$install_test_dir/.env")
sudo bash install/install.sh --local --dir "$install_test_dir" --ref main --port 32992 --password-file "$install_test_password"
[[ $config_before == "$(sudo sha256sum "$install_test_dir/.env")" ]]
[[ $(sudo git -C "$install_test_dir/source" rev-parse HEAD) == "$GITHUB_SHA" ]]
node install/smoke-check.mjs verify "$install_test_password"
# An unrelated directory must remain untouched.
unrelated=$(mktemp -d /tmp/opendoist-unrelated-XXXXXXXX)
if sudo bash install/install.sh --local --dir "$unrelated" --password-file "$install_test_password"; then exit 1; fi
rmdir "$unrelated"

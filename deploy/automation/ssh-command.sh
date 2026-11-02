#!/bin/sh
# Installed root-owned; SSH keys each have a fixed allowed branch.
set -eu
[ "$#" -eq 1 ] || exit 64
case "$1" in main|beta) ;; *) exit 64 ;; esac
commit=${SSH_ORIGINAL_COMMAND:-}
[ "${#commit}" -eq 40 ] || exit 64
case "$commit" in *[!0-9a-f]*) exit 64 ;; esac
exec sudo -n /usr/local/sbin/opendoist-deploy "$1" "$commit"

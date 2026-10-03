#!/usr/bin/env bash
#
# cleanup.sh — remove temporary deployment artifacts.
#
# Invoked as:
#   LD_ROOT=/www/wwwroot/example.com \
#   LD_RELEASE=20261003-101530 \
#   LD_REMOVE_RELEASE=1 \
#   LD_KEEP_ARCHIVE=0 \
#   bash cleanup.sh
#
# Only ever removes:
#   * the incoming archive for this release
#   * the staging directory for this release
#   * the release itself, and only when LD_REMOVE_RELEASE=1 AND it is not current
#
# It never touches the active release, `shared/`, or database backups.
#
set -Eeuo pipefail

: "${LD_ROOT:?LD_ROOT is required}"
: "${LD_RELEASE:?LD_RELEASE is required}"
LD_REMOVE_RELEASE="${LD_REMOVE_RELEASE:-0}"
LD_KEEP_ARCHIVE="${LD_KEEP_ARCHIVE:-0}"

case "$LD_ROOT" in /*) ;; *) echo "LD_ROOT must be absolute" >&2; exit 2 ;; esac
case "$LD_RELEASE" in
  [0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]-[0-9][0-9][0-9][0-9][0-9][0-9]|-*[A-Za-z0-9._-]*) ;;
  *) echo "Refusing to use malformed release id: $LD_RELEASE" >&2; exit 2 ;;
esac

DEPLOY_DIR="$LD_ROOT/.deploy"
INCOMING="$DEPLOY_DIR/incoming/$LD_RELEASE.tar.gz"
STAGING="$DEPLOY_DIR/staging/$LD_RELEASE"
RELEASE_DIR="$LD_ROOT/releases/$LD_RELEASE"
# Compare unresolved link targets: readlink -f would rewrite /tmp -> /private/tmp
# on macOS and could make an active release look safe to delete.
CURRENT_TARGET="$(readlink "$LD_ROOT/current" 2>/dev/null || true)"

removed=0

if [ "$LD_KEEP_ARCHIVE" != "1" ] && [ -f "$INCOMING" ]; then
  rm -f "$INCOMING" && echo "removed archive: $INCOMING" && removed=$((removed + 1))
fi

if [ -d "$STAGING" ]; then
  rm -rf "$STAGING" && echo "removed staging: $STAGING" && removed=$((removed + 1))
fi

if [ "$LD_REMOVE_RELEASE" = "1" ]; then
  # Never delete what is currently live — this is the guarantee that a failed
  # deploy cannot take down the running site (SPEC §34).
  if [ -n "$CURRENT_TARGET" ] && [ "$CURRENT_TARGET" = "$RELEASE_DIR" ]; then
    echo "Refusing to delete the active release: $RELEASE_DIR" >&2
  elif [ -d "$RELEASE_DIR" ]; then
    rm -rf "$RELEASE_DIR" && echo "removed release: $RELEASE_DIR" && removed=$((removed + 1))
  fi
fi

# Remove the staging parent when it is empty.
rmdir "$DEPLOY_DIR/staging" 2>/dev/null || true

echo "cleanup complete: $removed item(s) removed"
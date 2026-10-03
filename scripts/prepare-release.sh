#!/usr/bin/env bash
#
# prepare-release.sh — extract and prepare a release directory.
#
# Invoked as:
#   LD_ROOT=/www/wwwroot/example.com \
#   LD_RELEASE=20261003-101530-a1b2c3d \
#   LD_ARCHIVE=/www/wwwroot/example.com/.deploy/incoming/20261003-101530.tar.gz \
#   LD_STRATEGY=public \
#   LD_MAIN_DIR=main \
#   LD_PHP=php \
#   bash prepare-release.sh
#
# Guarantees:
#   * `set -Eeuo pipefail` with a line-numbered failure trap
#   * every variable is referenced through ${VAR:?} so a missing input fails loudly
#   * nothing is written outside LD_ROOT
#   * idempotent: re-running replaces the release in place, never duplicates it
#
set -Eeuo pipefail

trap 'echo "prepare-release.sh failed at line $LINENO" >&2' ERR

: "${LD_ROOT:?LD_ROOT is required}"
: "${LD_RELEASE:?LD_RELEASE is required}"
: "${LD_ARCHIVE:?LD_ARCHIVE is required}"
LD_STRATEGY="${LD_STRATEGY:-public}"
LD_MAIN_DIR="${LD_MAIN_DIR:-main}"
LD_FORMAT="${LD_FORMAT:-tar.gz}"

# Validate the release id so a malformed value can never escape its directory.
case "$LD_RELEASE" in
  [0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]-[0-9][0-9][0-9][0-9][0-9][0-9]|-*[A-Za-z0-9._-]*) ;;
  *) echo "Refusing to use malformed release id: $LD_RELEASE" >&2; exit 2 ;;
esac

case "$LD_ROOT" in
  /*) ;;
  *) echo "LD_ROOT must be an absolute path: $LD_ROOT" >&2; exit 2 ;;
esac

umask 022

RELEASES_DIR="$LD_ROOT/releases"
SHARED_DIR="$LD_ROOT/shared"
SHARED_STORAGE="$SHARED_DIR/storage"
DEPLOY_DIR="$LD_ROOT/.deploy"
LEGACY_PRESERVE="${LD_LEGACY_PRESERVE:-.user.ini .well-known}"

mkdir -p "$RELEASES_DIR" "$SHARED_DIR" "$SHARED_STORAGE" "$DEPLOY_DIR"

echo "==> Verifying archive"
if [ ! -s "$LD_ARCHIVE" ]; then
  echo "Archive missing or empty: $LD_ARCHIVE" >&2
  exit 3
fi

# Confirm the archive is intact before touching anything on disk.
if ! tar -tzf "$LD_ARCHIVE" >/dev/null 2>&1; then
  echo "Archive is corrupt: $LD_ARCHIVE" >&2
  exit 4
fi

# A release must contain artisan; anything else is not a Laravel app.
if ! tar -tzf "$LD_ARCHIVE" | grep -qE '(^|/)artisan$'; then
  echo "Archive does not contain artisan; refusing to extract." >&2
  exit 5
fi

# Never extract into the live tree. Extract to a staging dir, then move.
STAGE="$DEPLOY_DIR/staging/$LD_RELEASE"
rm -rf "$STAGE"
mkdir -p "$STAGE"

echo "==> Extracting"
tar -xzf "$LD_ARCHIVE" -C "$STAGE"

# Archives are created with the project root as the base, so entries may be
# nested one level deep. Normalise to a flat application directory.
if [ ! -f "$STAGE/artisan" ]; then
  inner="$(find "$STAGE" -maxdepth 2 -name artisan -type f | head -1)"
  if [ -n "$inner" ]; then
    inner_dir="$(dirname "$inner")"
    tmp_flat="$STAGE.__flat"
    mv "$inner_dir" "$tmp_flat"
    rm -rf "$STAGE"
    mv "$tmp_flat" "$STAGE"
  fi
fi

if [ ! -f "$STAGE/artisan" ]; then
  echo "Extracted archive does not contain artisan." >&2
  rm -rf "$STAGE"
  exit 6
fi

# Idempotent: replacing an existing release of the same id is allowed.
if [ "$LD_STRATEGY" = "legacy-root-copy" ]; then
  TARGET="$LD_ROOT/$LD_MAIN_DIR"
else
  TARGET="$RELEASES_DIR/$LD_RELEASE"
fi

echo "==> Installing release into $TARGET"
rm -rf "$TARGET"
mkdir -p "$(dirname "$TARGET")"
mv "$STAGE" "$TARGET"
rmdir "$DEPLOY_DIR/staging" 2>/dev/null || true

# --- shared storage -------------------------------------------------------
mkdir -p \
  "$SHARED_STORAGE/app/public" \
  "$SHARED_STORAGE/app/private" \
  "$SHARED_STORAGE/framework/cache/data" \
  "$SHARED_STORAGE/framework/sessions" \
  "$SHARED_STORAGE/framework/views" \
  "$SHARED_STORAGE/logs" \
  "$SHARED_DIR/logs"

if [ "$LD_STRATEGY" != "legacy-root-copy" ]; then
  # storage/ inside the release is a symlink into shared storage, so uploads
  # and generated files survive every deploy.
  rm -rf "$TARGET/storage"
  ln -s "$SHARED_STORAGE" "$TARGET/storage"
fi

# bootstrap/cache must be writable by the web user but is per-release.
mkdir -p "$TARGET/bootstrap/cache"

echo "==> Release prepared: $TARGET"
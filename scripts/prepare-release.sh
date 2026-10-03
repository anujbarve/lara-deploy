#!/usr/bin/env bash
#
# prepare-release.sh — extract and prepare a release directory.
#
# Invoked as:
#   LD_ROOT=/www/wwwroot/example.com \
#   LD_RELEASE=20261003-101530-a1b2c3d \
#   LD_ARCHIVE=/www/wwwroot/example.com/.deploy/incoming/20261003-101530.tar.gz \
#   LD_FORMAT=tar.gz \
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
#
# The shape is exactly what the CLI produces in buildReleaseId():
#   YYYYMMDD-HHMMSS              (a deployment with no git SHA)
#   YYYYMMDD-HHMMSS-<sha7>       (a deployment from a git repository)
# The optional suffix is what this guard used to reject, which broke every
# deployment from a git repo.
#
# Matched with a regex, not a `case` glob: in a glob `*` also matches '/', so
# `[A-Za-z0-9._-]*` happily accepted "...-../../etc/evil". Anchored, and the
# suffix class excludes '/', so the id can never traverse out of releases/.
if [[ ! "$LD_RELEASE" =~ ^[0-9]{8}-[0-9]{6}(-[A-Za-z0-9._-]+)?$ ]]; then
  echo "Refusing to use malformed release id: $LD_RELEASE" >&2
  exit 2
fi

case "$LD_ROOT" in
  /*) ;;
  *) echo "LD_ROOT must be an absolute path: $LD_ROOT" >&2; exit 2 ;;
esac

# Only the two formats the CLI can produce. Anything else must fail here rather
# than reach tar, which would treat a zip as corrupt with a misleading message.
case "$LD_FORMAT" in
  tar.gz) ;;
  zip) ;;
  *) echo "Unsupported LD_FORMAT: '$LD_FORMAT' (expected tar.gz or zip)" >&2; exit 2 ;;
esac

# zip needs an unzip binary, which a minimal aaPanel install may not have.
if [ "$LD_FORMAT" = zip ] && ! command -v unzip >/dev/null 2>&1; then
  echo "LD_FORMAT=zip requires 'unzip' on the server; it is not installed." >&2
  echo "Install it (yum install unzip / apt-get install -y unzip), or set packaging.format to tar.gz." >&2
  exit 8
fi

# List the archive contents, one entry per line, whatever the format.
list_archive() {
  if [ "$LD_FORMAT" = zip ]; then
    unzip -Z1 "$LD_ARCHIVE"
  else
    tar -tzf "$LD_ARCHIVE"
  fi
}

# Extract into the directory given as $1.
extract_archive() {
  if [ "$LD_FORMAT" = zip ]; then
    # -o overwrite: re-running replaces the release in place, never fails on a
    # pre-existing file. unzip restores unix modes and symlinks from the archive.
    unzip -qq -o "$LD_ARCHIVE" -d "$1"
  else
    tar -xzf "$LD_ARCHIVE" -C "$1"
  fi
}

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
if ! list_archive >/dev/null 2>&1; then
  echo "Archive is corrupt: $LD_ARCHIVE" >&2
  exit 4
fi

# A release must contain artisan; anything else is not a Laravel app.
if ! list_archive | grep -qE '(^|/)artisan$'; then
  echo "Archive does not contain artisan; refusing to extract." >&2
  exit 5
fi

# Never extract into the live tree. Extract to a staging dir, then move.
STAGE="$DEPLOY_DIR/staging/$LD_RELEASE"
rm -rf "$STAGE"
mkdir -p "$STAGE"

echo "==> Extracting"
extract_archive "$STAGE"

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
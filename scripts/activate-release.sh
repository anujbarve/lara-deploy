#!/usr/bin/env bash
#
# activate-release.sh — atomically switch `current` to a prepared release.
#
# Invoked as:
#   LD_ROOT=/www/wwwroot/example.com \
#   LD_RELEASE=20261003-101530-a1b2c3d \
#   LD_STRATEGY=public \
#   bash activate-release.sh
#
# The switch is a single `ln -sfn` against a temporary link, then `mv -T`, so a
# request either sees the old release or the new one — never a partial tree.
# The new release is verified *before* the switch, so an incomplete release can
# never become live (SPEC §31).
#
set -Eeuo pipefail

trap 'echo "activate-release.sh failed at line $LINENO" >&2' ERR

: "${LD_ROOT:?LD_ROOT is required}"
: "${LD_RELEASE:?LD_RELEASE is required}"
LD_STRATEGY="${LD_STRATEGY:-public}"
LD_MAIN_DIR="${LD_MAIN_DIR:-main}"

if [[ ! "$LD_RELEASE" =~ ^[0-9]{8}-[0-9]{6}(-[A-Za-z0-9._-]+)?$ ]]; then
  echo "Refusing to use malformed release id: $LD_RELEASE" >&2
  exit 2
fi

CURRENT="$LD_ROOT/current"

if [ "$LD_STRATEGY" = "legacy-root-copy" ]; then
  # Legacy mode has no symlink: the app already lives in main/ and public
  # assets were copied by prepare-release.sh.
  echo "==> Legacy mode: no symlink switch required"
  exit 0
fi

TARGET="$LD_ROOT/releases/$LD_RELEASE"

# --- verify before activating --------------------------------------------
echo "==> Verifying release $LD_RELEASE"
if [ ! -d "$TARGET" ]; then
  echo "Release directory does not exist: $TARGET" >&2
  exit 3
fi

for required in artisan composer.json vendor/autoload.php bootstrap/app.php public/index.php; do
  if [ ! -e "$TARGET/$required" ]; then
    echo "Incomplete release: missing $required" >&2
    exit 4
  fi
done

if [ ! -e "$LD_ROOT/shared/.env" ]; then
  echo "Refusing to activate: $LD_ROOT/shared/.env is missing." >&2
  exit 5
fi

# storage must be a live symlink into shared storage.
if [ ! -d "$TARGET/storage" ]; then
  echo "Refusing to activate: $TARGET/storage is missing." >&2
  exit 6
fi

# --- atomic switch --------------------------------------------------------
echo "==> Activating $LD_RELEASE"
PREVIOUS="$(readlink -f "$CURRENT" 2>/dev/null || true)"

# Build the new link beside the old one, then move it into place.
#
# `mv -T` (GNU coreutils) is a plain rename(2) and is fully atomic. It does not
# exist on BusyBox/BSD, and a plain `mv` there is worse than useless: when the
# destination is a symlink to a directory, mv follows it and moves the source
# *inside* the release, leaving `current` pointing at the old one. So the
# fallback unlinks first, which costs a sub-millisecond window but is correct
# everywhere. The verification below catches any residual failure.
TEMP_LINK="$LD_ROOT/.current.new.$$"
ln -sfn "$TARGET" "$TEMP_LINK"

if mv -T "$TEMP_LINK" "$CURRENT" 2>/dev/null; then
  :
else
  if [ -d "$CURRENT" ] && [ ! -L "$CURRENT" ]; then
    echo "Refusing to replace the real directory $CURRENT" >&2
    rm -f "$TEMP_LINK"
    exit 8
  fi
  rm -f "$CURRENT"
  mv -f "$TEMP_LINK" "$CURRENT"
fi

# Confirm the switch took effect. Compare the link's own target, not its fully
# resolved path: readlink -f would rewrite /tmp -> /private/tmp on macOS (and
# through any other symlinked mount) and wrongly report a mismatch.
NOW="$(readlink "$CURRENT" 2>/dev/null || true)"
if [ "$NOW" != "$TARGET" ]; then
  echo "Activation failed: current points at ${NOW:-<nothing>}, expected $TARGET" >&2
  exit 7
fi

if [ -n "$PREVIOUS" ] && [ "$PREVIOUS" != "$TARGET" ]; then
  echo "==> Previous release: $PREVIOUS"
fi

echo "==> Active release: $LD_RELEASE"
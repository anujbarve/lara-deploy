#!/usr/bin/env bash
#
# permissions.sh — apply the deployment permission policy.
#
# Invoked as:
#   LD_RELEASE_PATH=/www/wwwroot/example.com/releases/20261003-101530 \
#   LD_SHARED_PATH=/www/wwwroot/example.com/shared \
#   LD_WEB_USER=www \
#   LD_WEB_GROUP=www \
#   LD_WRITABLE="storage bootstrap/cache" \
#   bash permissions.sh
#
# Policy (SPEC §17, §39):
#   * application code is owned by root and NOT writable by the web user
#   * shared storage and bootstrap/cache are group-writable by the web user
#   * never `chmod -R 777`, unless LD_CHMOD777=1, which is loudly reported
#
set -Eeuo pipefail

trap 'echo "permissions.sh failed at line $LINENO" >&2' ERR

: "${LD_RELEASE_PATH:?LD_RELEASE_PATH is required}"
: "${LD_SHARED_PATH:?LD_SHARED_PATH is required}"
LD_WEB_USER="${LD_WEB_USER:-www}"
LD_WEB_GROUP="${LD_WEB_GROUP:-$LD_WEB_USER}"
LD_WRITABLE="${LD_WRITABLE:-storage bootstrap/cache}"
LD_DIR_MODE="${LD_DIR_MODE:-0755}"
LD_FILE_MODE="${LD_FILE_MODE:-0644}"
LD_CHMOD777="${LD_CHMOD777:-0}"
LD_CHOWN="${LD_CHOWN:-1}"
LD_CHOWN_SHARED="${LD_CHOWN_SHARED:-1}"

for path in "$LD_RELEASE_PATH" "$LD_SHARED_PATH"; do
  case "$path" in
    /*) ;;
    *) echo "Path must be absolute: $path" >&2; exit 2 ;;
  esac
done

echo "==> Applying permissions (web user: $LD_WEB_USER:$LD_WEB_GROUP)"

if [ "$LD_CHOWN" = "1" ]; then
  # Code is owned by root. The web user can read and execute, never write.
  chown -R "root:$LD_WEB_GROUP" "$LD_RELEASE_PATH"
  find "$LD_RELEASE_PATH" -type d -exec chmod "$LD_DIR_MODE" {} +
  find "$LD_RELEASE_PATH" -type f -exec chmod "$LD_FILE_MODE" {} +
  # Keep the entry point readable even if the tree was packed oddly.
  [ -f "$LD_RELEASE_PATH/artisan" ] && chmod 0755 "$LD_RELEASE_PATH/artisan" || true
  [ -f "$LD_RELEASE_PATH/public/index.php" ] && chmod 0644 "$LD_RELEASE_PATH/public/index.php" || true
fi

if [ "$LD_CHOWN_SHARED" = "1" ]; then
  # Everything under shared/ is owned by the web user: uploads and logs.
  chown -R "$LD_WEB_USER:$LD_WEB_GROUP" "$LD_SHARED_PATH"
fi

# Writable directories: group-writable, never world-writable.
for rel in $LD_WRITABLE; do
  case "$rel" in
    /*) target="$rel" ;;
    storage|storage/*) target="$LD_SHARED_PATH/storage" ;;
    bootstrap/cache|bootstrap/*) target="$LD_RELEASE_PATH/bootstrap/cache" ;;
    *) target="$LD_RELEASE_PATH/$rel" ;;
  esac
  mkdir -p "$target"
  chown -R "$LD_WEB_USER:$LD_WEB_GROUP" "$target"
  if [ "$LD_CHMOD777" = "1" ]; then
    echo "WARNING: LD_CHMOD777 is set; applying 0777 to $target" >&2
    chmod -R 0777 "$target"
  else
    # u+rwx g+rwx o+rx: writable by owner and group, readable by all.
    chmod -R 0775 "$target"
  fi
  echo "    writable: $target"
done

# bootstrap/cache lives inside the release and must also be group-writable.
if [ -d "$LD_RELEASE_PATH/bootstrap/cache" ]; then
  chown -R "$LD_WEB_USER:$LD_WEB_GROUP" "$LD_RELEASE_PATH/bootstrap/cache"
  chmod -R 0775 "$LD_RELEASE_PATH/bootstrap/cache"
fi

echo "==> Permissions applied"
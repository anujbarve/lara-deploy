#!/usr/bin/env bash
#
# health-check.sh — server-side health probe for a release.
#
# Invoked as:
#   LD_APP_DIR=/www/wwwroot/example.com/current \
#   LD_PHP=php \
#   LD_CHECK_APP=1 \
#   LD_CHECK_STORAGE=1 \
#   bash health-check.sh
#
# Prints one `KEY=VALUE` line per check, then `OVERALL=PASS|FAIL`. Never exits
# non-zero for a failing check: the CLI decides how to react, because a failing
# candidate check must not abort the script before every check has run.
#
set -Eeuo pipefail

: "${LD_APP_DIR:?LD_APP_DIR is required}"
LD_PHP="${LD_PHP:-php}"
LD_CHECK_APP="${LD_CHECK_APP:-1}"
LD_CHECK_STORAGE="${LD_CHECK_STORAGE:-1}"
LD_CHECK_DB="${LD_CHECK_DB:-1}"

echo "APP_DIR=$LD_APP_DIR"

# --- application bootstrap -------------------------------------------------
if [ "$LD_CHECK_APP" = "1" ]; then
  if [ -f "$LD_APP_DIR/artisan" ]; then
    # `about` is read-only on every supported Laravel version.
    if (cd "$LD_APP_DIR" && "$LD_PHP" artisan about --only=environment >/dev/null 2>&1); then
      echo "APP=ok"
    else
      echo "APP=fail"
      (cd "$LD_APP_DIR" && "$LD_PHP" artisan about --only=environment 2>&1 | head -20) || true
    fi
  else
    echo "APP=fail:artisan missing"
  fi
fi

# --- database --------------------------------------------------------------
if [ "$LD_CHECK_DB" = "1" ]; then
  # Delegate to artisan: the app already knows how to reach its database.
  if (cd "$LD_APP_DIR" && "$LD_PHP" artisan migrate:status >/dev/null 2>&1); then
    echo "DB=ok"
  else
    echo "DB=fail"
  fi
fi

# --- storage ---------------------------------------------------------------
if [ "$LD_CHECK_STORAGE" = "1" ]; then
  storage_ok=1
  storage_dir="$LD_APP_DIR/storage"
  if [ ! -d "$storage_dir" ]; then
    echo "STORAGE=fail:storage directory missing"
    storage_ok=0
  else
    for sub in framework/cache framework/sessions framework/views logs; do
      if [ ! -d "$storage_dir/$sub" ]; then
        mkdir -p "$storage_dir/$sub" 2>/dev/null || true
      fi
    done
    if ! (cd "$LD_APP_DIR" && "$LD_PHP" -r '
      $candidates = ["storage/framework/views", "storage/logs"];
      foreach ($candidates as $path) {
          $full = __DIR__ . "/" . $path;
          if (!is_dir($full) || !is_writable($full)) { exit(1); }
      }
      exit(0);
    ' 2>/dev/null); then
      echo "STORAGE=fail:not writable by the current user"
      storage_ok=0
    fi
  fi
  [ "$storage_ok" = "1" ] && echo "STORAGE=ok"
fi

# --- caches ----------------------------------------------------------------
if [ -f "$LD_APP_DIR/bootstrap/cache/config.php" ]; then
  echo "CONFIG_CACHE=warm"
else
  echo "CONFIG_CACHE=cold"
fi

OVERALL=PASS
for line in $(grep -E '^(APP|DB|STORAGE)=' || true); do
  case "$line" in
    *=ok) ;;
    *) OVERALL=FAIL ;;
  esac
done

echo "OVERALL=$OVERALL"
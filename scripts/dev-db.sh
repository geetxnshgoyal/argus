#!/bin/sh
# Local development Postgres, no Docker. Data lives in ./.devdb (git-ignored).
# Uses whatever Postgres 16+ binaries are on PATH (e.g. `brew install postgresql@18`).
set -eu
# Postgres on macOS refuses to start without a valid locale in the environment.
export LC_ALL="${LC_ALL:-C}"
cd "$(dirname "$0")/.."
DATA=.devdb/data
PORT="${ARGUS_DEV_DB_PORT:-55432}"
SOCK="$(pwd)/.devdb"

start() {
  if [ ! -d "$DATA" ]; then
    mkdir -p .devdb
    initdb -D "$DATA" -U argus --auth=trust --encoding=UTF8 --locale=C >/dev/null
    echo "Initialised dev database cluster in $DATA"
  fi
  if pg_ctl -D "$DATA" status >/dev/null 2>&1; then
    echo "Dev Postgres already running on port $PORT"
  else
    pg_ctl -D "$DATA" -l .devdb/postgres.log -o "-p $PORT -k $SOCK -c listen_addresses=localhost" -w start >/dev/null
    echo "Dev Postgres started on port $PORT"
  fi
  for db in argus argus_test; do
    psql -h localhost -p "$PORT" -U argus -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='$db'" | grep -q 1 \
      || createdb -h localhost -p "$PORT" -U argus "$db"
  done
}

stop() { pg_ctl -D "$DATA" -w stop >/dev/null 2>&1 && echo "Dev Postgres stopped" || echo "Dev Postgres not running"; }

case "${1:-start}" in
  start) start ;;
  stop) stop ;;
  reset) stop; rm -rf .devdb; start ;;
  *) echo "usage: $0 start|stop|reset"; exit 2 ;;
esac

#!/usr/bin/env bash
# Silence a Postgres container so a later log dump cannot leak row text.
# ALTER SYSTEM cannot run inside a transaction — one statement per call.
# Never print server logs. Retry: pg_isready can win before ALTER SYSTEM
# is accepted on a freshly initdb'd official image.
set -euo pipefail
container="${1:?container name or id}"
user="${2:-postgres}"
# Official image always has `postgres`. POSTGRES_USER's default db may not exist.
db="${3:-postgres}"

pin_once() {
  for sql in \
    'ALTER SYSTEM SET log_min_messages = panic' \
    'ALTER SYSTEM SET log_min_error_statement = panic' \
    'ALTER SYSTEM SET log_error_verbosity = terse' \
    'SELECT pg_reload_conf()'
  do
    docker exec "${container}" psql -v ON_ERROR_STOP=1 -U "${user}" -d "${db}" -c "${sql}" >/dev/null 2>&1
  done
}

n=0
while [ "${n}" -lt 15 ]; do
  n=$((n + 1))
  if pin_once; then
    exit 0
  fi
  sleep 1
done
echo "pin-postgres-container-logs: ALTER SYSTEM failed" >&2
exit 1

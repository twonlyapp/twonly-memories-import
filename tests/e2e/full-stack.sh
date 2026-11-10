#!/usr/bin/env bash
# End-to-end test of the memories import against the dev infrastructure:
# this page (served locally), dev-api.twonly.eu and its S3, and the app.
#
#   1. a synthetic Snapchat export   (tests/helpers/make-snapchat-fixture.mjs)
#   2. this page on http://127.0.0.1:3141, pointed at the dev API and S3
#   3. CORS and header checks against the dev API
#   4. the app side: twonly-app's Rust test `memories_importer_end_to_end`
#      registers a fresh account, drives the page in a headless browser
#      (tests/e2e/page-driver.mjs), and decrypts and checks every imported memory
#   5. tests/e2e/static-page.mjs: stylesheet, CSP and conversion worker
#
# The page must be served on port 3141: the dev API allows
# http://127.0.0.1:3141 through CORS besides its own importer origin.
#
# Requirements: node ≥ 22, python3, cargo, ffmpeg with libx264, a
# Chromium-based browser (CHROME_PATH), and twonly-app next to this repo.
#
# Usage: tests/e2e/full-stack.sh
#
# Environment (all optional):
#   E2E_API          API under test      https://dev-api.twonly.eu
#                    (otherwise a loopback server; the app refuses other hosts)
#   E2E_S3           its S3 endpoint     https://s3.dev-api.twonly.eu
#   TWONLY_APP_REPO  the app repo        ../twonly-app
#   KEEP=1           keep the page running and the work dir after the test

set -euo pipefail

PAGE_REPO="$(cd "$(dirname "$0")/../.." && pwd)"
APP_REPO="${TWONLY_APP_REPO:-$PAGE_REPO/../twonly-app}"
API="${E2E_API:-https://dev-api.twonly.eu}"
S3="${E2E_S3:-https://s3.dev-api.twonly.eu}"
PAGE_ORIGIN="http://127.0.0.1:3141"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/twonly-importer-e2e.XXXXXX")"
PIDS=()

log() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }

cleanup() {
  local status=$?
  if [[ "${KEEP:-0}" == "1" ]]; then
    log "KEEP=1: page left running on $PAGE_ORIGIN (work dir $WORK)"
    return
  fi
  for pid in "${PIDS[@]:-}"; do [[ -n "$pid" ]] && kill "$pid" 2>/dev/null || true; done
  rm -rf "$WORK"
  exit $status
}
trap cleanup EXIT

wait_for() {
  local what="$1" command="$2"
  for _ in $(seq 1 60); do
    if eval "$command" >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  echo "timed out waiting for $what" >&2
  return 1
}

if curl -s -o /dev/null "$PAGE_ORIGIN/" 2>/dev/null; then
  echo "port 3141 is already in use; stop what runs there" >&2
  exit 1
fi

log "Synthetic Snapchat export"
node "$PAGE_REPO/tests/helpers/make-snapchat-fixture.mjs" --out "$WORK/fixture"

log "Importer page on $PAGE_ORIGIN (API $API, S3 $S3)"
mkdir "$WORK/page"
cp -R "$PAGE_REPO/src" "$PAGE_REPO/assets" "$WORK/page/"
sed \
  -e "s|https://api.twonly.eu|$API|g" \
  -e "s|https://s3.twonly.eu|$S3|g" \
  "$PAGE_REPO/index.html" >"$WORK/page/index.html"
python3 -m http.server 3141 --bind 127.0.0.1 --directory "$WORK/page" >"$WORK/serve.log" 2>&1 &
PIDS+=($!)
wait_for "the page" "curl -sf $PAGE_ORIGIN/"

log "CORS: the page's origin, never with credentials, only on importer routes"
preflight() {
  curl -s -o /dev/null -D - -X OPTIONS "$API$1" \
    -H "Origin: $2" -H "Access-Control-Request-Method: POST" \
    -H "Access-Control-Request-Headers: authorization,content-type,x-twonly-importer-version"
}
allowed="$(preflight /api/importer/uploads "$PAGE_ORIGIN")"
grep -qi "^access-control-allow-origin: $PAGE_ORIGIN" <<<"$allowed" || {
  echo "the API does not allow $PAGE_ORIGIN:"
  echo "$allowed"
  exit 1
}
! grep -qi "^access-control-allow-credentials" <<<"$allowed" || { echo "credentials must never be allowed"; exit 1; }
! grep -qi "^access-control-allow-origin" <<<"$(preflight /api/importer/uploads https://evil.example)" || { echo "another origin was allowed"; exit 1; }
! grep -qi "^access-control-allow-origin" <<<"$(preflight /api/feedback "$PAGE_ORIGIN")" || { echo "CORS leaked onto other routes"; exit 1; }
status="$(curl -s -o /dev/null -w '%{http_code}' -X POST "$API/api/importer/pairings" -H 'Content-Type: application/json' -d '{"poll_hash":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA","version":0}')"
[[ "$status" == "426" ]] || { echo "an outdated page must get 426, got $status"; exit 1; }
headers="$(curl -s -D - -o /dev/null -X POST "$API/api/importer/pairings" -H 'Content-Type: application/json' -d '{"poll_hash":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA","version":1}')"
grep -qi "^cache-control: no-store" <<<"$headers" || { echo "pairing responses must be no-store"; exit 1; }
echo "ok"

log "Full flow: page in a browser, $API, app"
# The app's debug build talks to dev-api.twonly.eu by default and accepts only
# a loopback TWONLY_TEST_API_ORIGIN, so that is set only for a local server.
(
  cd "$APP_REPO/rust"
  [[ "$API" == "https://dev-api.twonly.eu" ]] || export TWONLY_TEST_API_ORIGIN="$API"
  TWONLY_IMPORTER_E2E_PAGE_URL="$PAGE_ORIGIN/" \
  TWONLY_IMPORTER_E2E_FIXTURE="$WORK/fixture" \
  TWONLY_IMPORTER_E2E_DRIVER="$PAGE_REPO/tests/e2e/page-driver.mjs" \
  cargo test --test api memories_importer_end_to_end -- --nocapture
)

log "Static page: stylesheet, CSP and conversion worker"
node "$PAGE_REPO/tests/e2e/static-page.mjs" --url "$PAGE_ORIGIN/"

log "End-to-end test passed"

#!/usr/bin/env bash
#
# Post-deploy smoke test for bl-site-package.
# Checks the key endpoints respond correctly after a deploy. Dependency-light:
# only needs bash + curl. Exits non-zero if ANY check fails, so it can gate a
# release (see RELEASE.md).
#
# Usage:
#   scripts/smoke-test.sh <base-url>
#   scripts/smoke-test.sh https://prueba.shoroban.com
#   scripts/smoke-test.sh http://localhost:3000
#
set -u

BASE="${1:-}"
if [ -z "$BASE" ]; then
  echo "Usage: $0 <base-url>" >&2
  echo "  e.g. $0 https://prueba.shoroban.com" >&2
  exit 2
fi

# Strip a trailing slash so we can concatenate paths cleanly.
BASE="${BASE%/}"

fails=0

# check <method-desc> <path> <expected-codes-regex> [require-json]
# expected-codes-regex: extended-regex the HTTP status must fully match.
# require-json: if "json", the Content-Type must contain "application/json".
check() {
  desc="$1"; path="$2"; expect="$3"; want_json="${4:-}"
  url="$BASE$path"
  # -s silent, -S show errors, -L follow redirects for the body fetch of the
  # homepage; but for status assertions we want the FIRST response code, so we
  # do NOT follow redirects here (a 302 on /panel is a valid "route wired"
  # signal). Separate content-type read for JSON checks.
  read -r code ctype < <(curl -s -o /dev/null -w '%{http_code} %{content_type}' --max-time 15 "$url" 2>/dev/null || echo "000 -")

  if ! printf '%s' "$code" | grep -Eq "^($expect)$"; then
    echo "FAIL  $desc — $path → HTTP $code (expected $expect)"
    fails=$((fails + 1))
    return
  fi

  if [ "$want_json" = "json" ] && ! printf '%s' "$ctype" | grep -q "application/json"; then
    echo "FAIL  $desc — $path → 200 but Content-Type is '$ctype' (expected application/json)"
    fails=$((fails + 1))
    return
  fi

  echo "OK    $desc — $path → HTTP $code"
}

# check_absent <desc> <path>
# Security gate: the path must NOT be downloadable. A 200 is a hard fail — it
# means the web docroot is exposing an app-internal file (the Shoroban incident:
# nginx served the app root, so GET /data/app.db returned the whole SQLite DB —
# panel password, JWT secret, contact messages). Anything non-200 (404/403/000)
# passes.
check_absent() {
  desc="$1"; path="$2"
  url="$BASE$path"
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "$url" 2>/dev/null || echo "000")
  if [ "$code" = "200" ]; then
    echo "FAIL  $desc — $path → HTTP 200 (MUST NOT be downloadable — docroot is exposing app internals)"
    fails=$((fails + 1))
    return
  fi
  echo "OK    $desc — $path → HTTP $code (not downloadable)"
}

# check_catalog_floor
# Guards against a deploy that empties or collapses the catalogue.
#
# Every other check here answers "did it boot". None of them notices a site
# that boots perfectly and serves nothing, which is a failure a customer sees
# immediately and a smoke test would otherwise wave through. It is not
# hypothetical: during development an Eleventy build executed a stray test
# file whose fixture teardown ran against the live database and took a
# 14,487-product catalogue down to a single row. Every endpoint stayed 200.
#
# Compares against the last count seen for this host, kept in a local file
# (gitignored — it is per-instance state, not repo content), and fails if the
# catalogue lost more than CATALOG_TOLERANCE_PCT of it. The first run for a
# host records a baseline and passes; a run that finds MORE products raises
# the bar, so the guard ratchets upward and never drifts down quietly.
#
# Set MIN_PRODUCTS to assert an absolute floor instead — better in CI, where
# the baseline file will not survive between runs.
check_catalog_floor() {
  tolerance="${CATALOG_TOLERANCE_PCT:-90}"
  body=$(curl -s --max-time 15 "$BASE/api/products/count" 2>/dev/null || echo "")
  count=$(printf '%s' "$body" | sed -nE 's/.*"count"[[:space:]]*:[[:space:]]*([0-9]+).*/\1/p')

  if [ -z "$count" ]; then
    echo "FAIL  catalogue size — /api/products/count returned no usable count"
    fails=$((fails + 1))
    return
  fi

  if [ -n "${MIN_PRODUCTS:-}" ]; then
    if [ "$count" -lt "$MIN_PRODUCTS" ]; then
      echo "FAIL  catalogue size — $count products, below the required floor of $MIN_PRODUCTS"
      fails=$((fails + 1))
      return
    fi
    echo "OK    catalogue size — $count products (floor $MIN_PRODUCTS)"
    return
  fi

  baseline_dir="${SMOKE_BASELINE_DIR:-.smoke-baselines}"
  # One file per host, so staging (empty by design) and a client's live
  # catalogue never compare against each other.
  host=$(printf '%s' "$BASE" | sed -E 's#^[a-z]+://##; s#[^A-Za-z0-9.-]#_#g')
  baseline_file="$baseline_dir/$host"

  if [ ! -f "$baseline_file" ]; then
    mkdir -p "$baseline_dir" 2>/dev/null
    printf '%s\n' "$count" > "$baseline_file" 2>/dev/null
    echo "OK    catalogue size — $count products (baseline recorded, nothing to compare yet)"
    return
  fi

  baseline=$(cat "$baseline_file" 2>/dev/null)
  case "$baseline" in ''|*[!0-9]*) baseline=0 ;; esac

  # Integer arithmetic only — no bc, to keep this bash + curl.
  if [ "$((count * 100))" -lt "$((baseline * tolerance))" ]; then
    echo "FAIL  catalogue size — $count products, was $baseline (lost more than $((100 - tolerance))%)"
    echo "      A deploy that empties the catalogue still answers 200 on every other check."
    fails=$((fails + 1))
    return
  fi

  if [ "$count" -gt "$baseline" ]; then
    printf '%s\n' "$count" > "$baseline_file" 2>/dev/null
  fi
  echo "OK    catalogue size — $count products (was $baseline)"
}

echo "Smoke test: $BASE"
echo "---------------------------------------------"

# Public config API must return JSON — proves the DB + config layer booted.
check "site config API" "/api/site/config" "200" "json"
# Blog posts API — proves the articles data path works.
check "blog posts API" "/api/blog/posts" "200"
# Homepage — proves the Eleventy build was served.
check "homepage" "/" "200"
# Setup wizard — always 200 (static sendFile).
check "setup wizard" "/setup" "200"
# Panel route — 200 if configured, 302 redirect to /setup if not. Either proves
# the route is wired (a 404/500 would be the failure we care about).
check "panel route" "/panel" "200|302"
# Catalogue size — the one check that notices a site which boots fine and
# serves nothing. See check_catalog_floor above.
check_catalog_floor

# Security gates — these MUST NOT be downloadable. If any returns 200 the web
# docroot is exposing app internals (data/, source, config files). Hard fail:
# do not ship. See RELEASE.md (docroot = <app>/public) and the DB-path guard in
# src/db/database.js.
check_absent "DB not downloadable" "/data/app.db"
check_absent "env file not downloadable" "/.env"
# Source + manifest live at the app root. If nginx serves them, the document
# root is pointed at the app root instead of public/ (the Shoroban regression:
# the DB check alone passed because DB_PATH was moved out, while /src stayed
# exposed). These files always exist, so a 200 unambiguously means wrong docroot.
check_absent "source not downloadable" "/src/server.js"
check_absent "package manifest not downloadable" "/package.json"

echo "---------------------------------------------"
if [ "$fails" -eq 0 ]; then
  echo "PASS — all checks green"
  exit 0
fi
echo "FAILED — $fails check(s) failed"
exit 1

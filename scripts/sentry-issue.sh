#!/usr/bin/env bash
# Fetch a Sentry issue's latest event by short ID (e.g. EISE-J8).
# Usage: scripts/sentry-issue.sh <SHORT_ID> [--meta-only]
#   --meta-only  Print just the summary (title, browser, OS, url, user-agent, count).
set -euo pipefail

SHORT_ID="${1:-}"
if [ -z "$SHORT_ID" ]; then
  echo "usage: $0 <SHORT_ID> [--meta-only]" >&2
  exit 2
fi

HERE="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck disable=SC1091
source "$HERE/config/sentry-env.sh"

resolve() {
  curl -sf -H "Authorization: Bearer $SENTRY_AUTH_TOKEN" \
    "https://sentry.io/api/0/organizations/$SENTRY_ORG/shortids/$SHORT_ID/"
}

GROUP_JSON="$(resolve)"
GROUP_ID="$(printf '%s' "$GROUP_JSON" | jq -r '.groupId')"
if [ -z "$GROUP_ID" ] || [ "$GROUP_ID" = "null" ]; then
  echo "could not resolve $SHORT_ID" >&2
  printf '%s\n' "$GROUP_JSON" >&2
  exit 1
fi

EVENT_JSON="$(curl -sf -H "Authorization: Bearer $SENTRY_AUTH_TOKEN" \
  "https://sentry.io/api/0/organizations/$SENTRY_ORG/issues/$GROUP_ID/events/latest/")"

if [ "${2:-}" = "--meta-only" ]; then
  jq -n --argjson g "$GROUP_JSON" --argjson e "$EVENT_JSON" '{
    shortId: $g.shortId,
    title: $g.group.title,
    culprit: $g.group.culprit,
    level: $g.group.level,
    status: $g.group.status,
    count: $g.group.count,
    userCount: $g.group.userCount,
    firstSeen: $g.group.firstSeen,
    lastSeen: $g.group.lastSeen,
    permalink: $g.group.permalink,
    browser: ($e.contexts.browser // null),
    os: ($e.contexts.os // null),
    url: ($e.tags[]? | select(.key=="url") | .value),
    userAgent: ($e.entries[]? | select(.type=="request") | .data.headers[]? | select(.[0]=="User-Agent") | .[1]),
    release: $e.release,
    environment: ($e.tags[]? | select(.key=="environment") | .value)
  }'
else
  jq -n --argjson g "$GROUP_JSON" --argjson e "$EVENT_JSON" '{group: $g, event: $e}'
fi

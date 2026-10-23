#!/usr/bin/env bash
# Cut a Rock Band release of the desktop app (see RELEASING-ROCKBAND.md).
#
#   ./scripts/release-rockband.sh 0.3.1            tag custom's tip as v0.3.1 and push it
#   ./scripts/release-rockband.sh 0.3.1 --dry-run  say what it would do
#
# The tag push starts the Build workflow: Mac, Windows and Linux builds of this
# branch, bundling core and the Rock Band plugins from their release branches
# (scripts/build-common.sh), then a GitHub release on mattromano/feedBack-desktop
# that installed apps pick up through the in-app updater.
set -euo pipefail
REPO=mattromano/feedBack-desktop
BRANCH=custom
version="${1:-}"
dry=0
[ "${2:-}" = "--dry-run" ] && dry=1
if ! [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "usage: $0 X.Y.Z [--dry-run]   (a plain version: it must be higher than the last release)" >&2
  exit 2
fi
tag="v$version"
cd "$(dirname "${BASH_SOURCE[0]}")/.."
git fetch -q origin "$BRANCH" --tags
if git rev-parse -q --verify "refs/tags/$tag" >/dev/null; then
  echo "$tag already exists; pick the next version" >&2; exit 1
fi
# Versions only go up: the updater ignores a release older than the installed one.
last=$(git tag -l 'v[0-9]*.[0-9]*.[0-9]*' | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | sort -V | tail -1 || true)
if [ -n "$last" ] && [ "$(printf '%s\n%s\n' "$last" "$tag" | sort -V | tail -1)" != "$tag" ]; then
  echo "$tag is not higher than the last release $last" >&2; exit 1
fi
sha=$(git rev-parse "origin/$BRANCH")
echo "Release $tag from $BRANCH @ ${sha:0:7} (last release: ${last:-none})"
git log --oneline -1 "$sha"
if [ "$dry" -eq 1 ]; then echo "(dry run: nothing pushed)"; exit 0; fi
git tag -a "$tag" -m "Rock Band release $tag" "$sha"
git push origin "$tag"
echo "Pushed $tag. Build: https://github.com/$REPO/actions/workflows/build.yml"
echo "Release (when the build finishes, ~20-30 min): https://github.com/$REPO/releases/tag/$tag"

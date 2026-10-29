#!/usr/bin/env bash
# Build Cereal's Flatpak from this checkout and make a .flatpak bundle you can give to other people.
#
#   npm run flatpak                   typecheck + unit tests, build, bundle in dist/
#   npm run flatpak -- --install      also install it for this user (flatpak run dev.cereal.app)
#   npm run flatpak -- --e2e          also run the end-to-end smoke test before building
#   npm run flatpak -- --skip-tests   skip the typecheck and unit tests
#   npm run update-app                the same as --install: rebuild and reinstall your copy (takes --e2e too)
#
# The build runs offline inside the Flatpak SDK, from flatpak/generated-sources.json. That file is regenerated here
# whenever package-lock.json changes. Build state lives in .flatpak/.
set -euo pipefail
cd "$(dirname "$0")/.."

APP_ID=dev.cereal.app
MANIFEST=flatpak/$APP_ID.yml
SOURCES=flatpak/generated-sources.json
# flatpak-builder-tools, pinned: the generator decides what the offline build downloads.
GENERATOR_COMMIT=74697c75b630d7330e77250fc13cb5ea688d9479
FLATHUB=https://dl.flathub.org/repo/flathub.flatpakrepo

install=false
tests=true
e2e=false
for arg in "$@"; do
  case "$arg" in
    --install) install=true ;;
    --skip-tests) tests=false ;;
    --e2e) e2e=true ;;
    *) echo "Unknown option: $arg" >&2; exit 2 ;;
  esac
done

step() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
# Temporary directories, removed on exit.
scratch=()
trap 'rm -rf "${scratch[@]}"' EXIT

if $tests; then
  step 'Checking types and running tests'
  npm run typecheck
  npm test
fi

if $e2e; then
  step 'Running the end-to-end smoke test'
  # A private config dir keeps the test app from colliding with the single-instance lock of a running `npm run dev`.
  xdg=$(mktemp -d)
  scratch+=("$xdg")
  XDG_CONFIG_HOME="$xdg" npm run e2e
fi

step 'Checking Flatpak tools'
flatpak remote-add --user --if-not-exists flathub "$FLATHUB"
flatpak info org.flatpak.Builder >/dev/null 2>&1 || flatpak install --user -y flathub org.flatpak.Builder
builder() { flatpak run org.flatpak.Builder "$@"; }

if [[ ! -s "$SOURCES" || package-lock.json -nt "$SOURCES" ]]; then
  step 'Generating offline npm sources'
  if [[ ! -x .flatpak/tools/bin/flatpak-node-generator ]]; then
    python3 -m venv .flatpak/tools
    .flatpak/tools/bin/pip install -q "git+https://github.com/flatpak/flatpak-builder-tools.git@$GENERATOR_COMMIT#subdirectory=node"
  fi
  # The generator reads the lockfile alone, without node_modules next to it.
  lock=$(mktemp -d)
  scratch+=("$lock")
  cp package.json package-lock.json "$lock/"
  .flatpak/tools/bin/flatpak-node-generator npm "$lock/package-lock.json" --electron-node-headers -o "$SOURCES"
fi

step 'Building the Flatpak (offline, in the SDK)'
args=(--user --install-deps-from=flathub --force-clean --ccache --repo=.flatpak/repo --state-dir=.flatpak/state)
$install && args+=(--install)
builder "${args[@]}" .flatpak/build "$MANIFEST"

step 'Bundling'
version=$(node -p "require('./package.json').version")
bundle="dist/Cereal-$version.flatpak"
mkdir -p dist
# --runtime-repo lets the recipient's Flatpak fetch the runtime and the Electron BaseApp from Flathub.
flatpak build-bundle .flatpak/repo "$bundle" "$APP_ID" --runtime-repo="$FLATHUB"
(cd dist && sha256sum "$(basename "$bundle")" > "$(basename "$bundle").sha256")
echo "Bundle: $bundle ($(du -h "$bundle" | cut -f1)), checksum in $bundle.sha256"

step 'Linting'
# Expected: finish-args-contains-both-x11-and-wayland (the floating widget needs XWayland on Wayland). Flathub-only:
# appid-url-not-reachable (dev.cereal.app implies the domain cereal.dev) and missing metainfo screenshots.
flatpak run --command=flatpak-builder-lint org.flatpak.Builder manifest "$MANIFEST" || true
flatpak run --command=flatpak-builder-lint org.flatpak.Builder repo .flatpak/repo || true

if $install; then
  echo
  echo "Installed. Run it with: flatpak run $APP_ID"
  echo "API keys go in ~/.var/app/$APP_ID/config/Cereal/.env"
  # Flatpak installs next to a running copy, which keeps the old build until it quits.
  if flatpak ps --columns=application 2>/dev/null | grep -qx "$APP_ID"; then
    echo 'Cereal is still running the previous build. Quit it (tray → Quit) and start it again to use this one.'
  fi
fi

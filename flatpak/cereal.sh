#!/bin/sh
# Cereal's launcher inside the Flatpak.
# Every instance of this app shares this TMPDIR, so a second launch finds the first one's singleton socket and
# focuses its window instead of starting another Cereal.
export TMPDIR="$XDG_RUNTIME_DIR/app/$FLATPAK_ID"
exec zypak-wrapper /app/cereal/cereal "$@"

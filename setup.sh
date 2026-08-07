#!/usr/bin/env bash
# setup.sh -- builds msgs.wasm from a pinned slopgs checkout and checks for
# gm.dls.
#
# This player is just the frontend: it expects msgs.wasm and gm.dls to sit
# next to index.html. msgs.wasm is a build artifact (a few hundred KB,
# machine/toolchain-specific) so it isn't vendored in this repo -- the
# actual clone-and-build step lives in scripts/build-wasm.sh, shared with
# the GitHub Actions Pages deploy so both ever produce the same pinned,
# unmodified build. gm.dls is proprietary Windows data the user must
# supply themselves; this script only checks for it and tells you where to
# get it (the app itself also prompts for a drag-and-drop if it's missing).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

"$HERE/scripts/build-wasm.sh"

if [ -f "$HERE/gm.dls" ]; then
  echo "gm.dls found -- setup complete. Run: python3 -m http.server"
else
  cat >&2 <<'EOF'

gm.dls not found next to index.html.

Copy your own copy of gm.dls into this directory -- it ships with Windows
at C:\WINDOWS\system32\gm.dls (any version with General MIDI Wavetable
support has one). Or skip this: the page itself will prompt you to drag
one in directly, kept in-browser only, if it doesn't find one here.

Once it's in place (or not -- see above), run: python3 -m http.server
EOF
fi

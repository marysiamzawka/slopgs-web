# slopgs player

---

**This software is entirely vibe-coded.**

I built this by exclusively iterating with Claude. I wrote no line of code.

---

Drag a `.mid` file onto the page; it plays back through [slopgs](https://github.com/sloptainment/slopgs), a reimplementation of the Windows MSGS (`swmidi.sys`) wavetable synth. The point isn't a generic MIDI player -- it's that specific, recognizable classic-Windows sound, faithfully reproduced in the browser.

**Live demo:** https://marysiamzawka.github.io/slopgs-web/

## Quick start

You need one thing this project can't provide: **`gm.dls`**, the General MIDI instrument/soundfont data `slopgs` renders against. It ships with Windows and is proprietary, so it's never bundled, deployed, or fetched by this project -- you always supply your own.

1. Open the live demo (or run it locally, see below).
2. If `gm.dls` isn't found next to the page, it'll ask you to drag your own in -- grab it from `C:\WINDOWS\system32\gm.dls` on any Windows install with MIDI wavetable support, or wherever you've got a copy. It's read into the browser only; nothing is uploaded or written to disk. In Chromium-family browsers (Chrome/Edge/Brave/Opera) it'll offer to remember that file across visits -- one click to reuse it next time, no re-dragging. Firefox and Safari don't support that part, so it falls back to asking again each visit.
3. Drop a `.mid` file, or pick one of the bundled demo songs if you don't have one handy.

## Running locally

```sh
./setup.sh
python3 -m http.server
```

`setup.sh` clones `slopgs` at the commit pinned in `SLOPGS_COMMIT`, compiles `msgs.wasm` with clang, and copies it next to `index.html`. It also checks for a local `gm.dls` and tells you where to get one -- though as above, you can also just skip that and let the page prompt you instead.

## About the synth engine

`msgs.wasm` in this repo (and on the live deploy) is an **unmodified** build of [slopgs](https://github.com/sloptainment/slopgs), compiled from commit [`83e3c23`](https://github.com/sloptainment/slopgs/commit/83e3c232db77894c7a90c6657a0f87b25c805765) (pinned in `SLOPGS_COMMIT`, read by both `setup.sh` and the GitHub Actions Pages workflow, so the local build and the public deploy are always the identical snapshot).

slopgs' own README is upfront that its author doesn't feel able to attach a formal LICENSE to it -- the reimplementation itself was LLM-directed reverse-engineering, and they don't claim sole authorship over it. What they do say, directly: *"I've wished for this thing for a while now. And now, I have it. And you can have it as well."* This project's public deploy proceeds on that basis -- an informal grant, not a legal one. If slopgs' author ever objects to the public build, it comes down immediately.

Nothing about slopgs is modified, extended, or reinterpreted here -- this player calls its compiled WebAssembly export functions (`msgs_init`, `msgs_render`, etc.) the same way any program calls a library it links against; none of slopgs' own source is included in this repository.

## License

This repository's own code -- `index.html`, `styles.css`, `js/*.js`, `setup.sh`, `scripts/`, the GitHub Actions workflow -- is MIT licensed, see `LICENSE`. That license's scope explicitly excludes everything below, each of which carries its own terms:

- **`msgs.wasm`** -- built from slopgs at deploy/setup time, never committed to this repo. See "About the synth engine" above.
- **`gm.dls`** -- never included here at all, supplied by each user themselves.
- **`fonts/`** -- IBM Plex Sans and Space Mono, both SIL OFL-1.1. See `fonts/NOTICE.md`.
- **`js/vendor/`** -- `lame.js` (LGPL-3.0) and `libvorbis.js` (BSD/Xiph.org), used for MP3/OGG export, loaded only when you actually export. See `js/vendor/README.md`.
- **`demo/*.mid`** -- six tracks, each CC BY-NC-SA 3.0. See `demo/CREDITS.md`.

## Features

- Piano-roll visualization (falling notes, Synthesia-style) with measure/bar guide lines and octave markers, adjustable scroll speed
- Per-channel mute/solo, live patch names (including GS bank-select variations, e.g. "Lead 1 (square)" switching to "Sine Wave"), and a live voice-count meter per channel and overall
- Transport with seek (bar-snapped), loop, a bar counter, and the file's own embedded metadata (title/copyright/credit line/markers) when present
- Export to WAV, MP3, or OGG Vorbis, downloaded as a real file via a Blob
- Extended note-range support for files that use MIDI's full 0-127 range rather than the standard 88 keys

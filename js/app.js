/* app.js -- wires drag-and-drop, transport, channel sidebar, and the piano
 * roll together. No framework, no build step: this file is loaded as a
 * plain classic script after midi.js / synth.js / pianoroll.js.
 */
"use strict";

(() => {
  const { parseMidiFile, gmInstrumentName, valueAt, nearestBarTime, GM_DEFAULT_CHANNEL_VOLUME } = window.SlopgsMidi;

  const dropzone = document.getElementById("dropzone");
  const dropzoneTitleEl = document.getElementById("dropzoneTitle");
  const dragOverlay = document.getElementById("dragOverlay");
  const fileInput = document.getElementById("fileInput");
  const browseBtn = document.getElementById("browseBtn");
  const forgetDlsBtn = document.getElementById("forgetDlsBtn");
  const demoToggleBtn = document.getElementById("demoToggleBtn");
  const demoPicker = document.getElementById("demoPicker");
  const demoCloseBtn = document.getElementById("demoCloseBtn");
  const demoPickerList = document.getElementById("demoPickerList");
  const statusBanner = document.getElementById("statusBanner");
  const dropHint = document.getElementById("dropHint");

  const metabar = document.getElementById("metabar");
  const metaInfo = document.getElementById("metaInfo");
  const metaMarker = document.getElementById("metaMarker");
  const metaMarkerText = document.getElementById("metaMarkerText");

  const rollCanvas = document.getElementById("roll");
  const lyricsOverlay = document.getElementById("lyricsOverlay");
  // Each row's *physical* element is reused across all four roles over
  // time (see advanceLyricRowsByOne) -- this array's order is arbitrary
  // and never assumed to mean anything; `role` (kept alongside each el) is
  // the only thing that says what a row currently shows.
  const lyricRows = [...document.querySelectorAll("[data-lyric-row]")].map((el) => ({ el, role: null }));
  const channelList = document.getElementById("channelList");
  const sidebarEmpty = document.getElementById("sidebarEmpty");
  const voiceMeter = document.getElementById("voiceMeter");
  const voiceMeterFill = document.getElementById("voiceMeterFill");
  const voiceCountEl = document.getElementById("voiceCount");
  const updateRateSelect = document.getElementById("updateRateSelect");
  const perfHint = document.getElementById("perfHint");
  const rollSpeedSelect = document.getElementById("rollSpeedSelect");

  const playBtn = document.getElementById("playBtn");
  const loopBtn = document.getElementById("loopBtn");
  const seekBar = document.getElementById("seekBar");
  const timeElapsed = document.getElementById("timeElapsed");
  const timeTotal = document.getElementById("timeTotal");
  const transportBar = document.getElementById("transportBar");
  const barCounter = document.getElementById("barCounter");
  const volumeSlider = document.getElementById("volumeSlider");
  const fileNameEl = document.getElementById("fileName");
  const transport = document.getElementById("transport");
  const exportFormat = document.getElementById("exportFormat");
  const exportBtn = document.getElementById("exportBtn");
  const exportStatus = document.getElementById("exportStatus");
  const seekingPill = document.getElementById("seekingPill");
  const autoplayPrompt = document.getElementById("autoplayPrompt");
  const loadingIndicator = document.getElementById("loadingIndicator");
  const resetMuteSoloBtn = document.getElementById("resetMuteSoloBtn");
  const expandAllBtn = document.getElementById("expandAllBtn");

  const roll = new window.SlopgsPianoRoll(rollCanvas);
  const synth = new window.SlopgsSynth({ wasmUrl: "msgs.wasm", dlsUrl: "gm.dls" });

  let currentData = null;
  let currentBytes = null;
  let currentBaseName = "export";
  let perChannelNotes = new Map();
  let perDrumKeyNotes = new Map();
  let seeking = false;
  let synthReady = false;
  // True once wasm has instantiated but no gm.dls was found next to this
  // page -- the dropzone switches to accepting a gm.dls drop/browse instead
  // of a MIDI file until one arrives (see synth.dlsReady / initWithDls).
  let needsDls = false;
  // A .mid dropped/browsed while needsDls is true: held so it loads on its
  // own the instant gm.dls arrives, instead of making the user re-drop it.
  let pendingMidiFile = null;
  // A remembered FileSystemFileHandle from a previous visit (see
  // js/dls-store.js), non-null only while it's waiting on a user gesture to
  // re-confirm read access -- the dropzone shows a one-click "use it again"
  // affordance instead of the plain drop prompt whenever this is set.
  let rememberedDlsHandle = null;
  let currentMarkerText = null;
  const mutedChannels = new Set();
  const soloedChannels = new Set();
  // Whether the user has toggled on the "boost the melody line" control --
  // see lyricMelodyChannel in midi.js and applyMuteSolo below. Reset to off
  // on every new file load, same as mute/solo: a boost dialed in for one
  // song shouldn't silently carry over and mislead on the next.
  let melodyBoostEnabled = false;
  // Proportional velocity multiplier, clamped at 127 -- a gain, not a
  // ceiling, so the channel's own dynamics (loud notes vs. quiet ones)
  // still come through instead of flattening into one constant loudness.
  const MELODY_BOOST_FACTOR = 1.5;

  function fmtTime(sec) {
    if (!Number.isFinite(sec) || sec < 0) sec = 0;
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${String(s).padStart(2, "0")}`;
  }

  function showBanner(message, kind) {
    statusBanner.textContent = message;
    statusBanner.hidden = false;
    statusBanner.dataset.kind = kind || "error";
  }
  function hideBanner() {
    statusBanner.hidden = true;
  }

  function setTransportEnabled(enabled) {
    playBtn.disabled = !enabled;
    seekBar.disabled = !enabled;
    loopBtn.disabled = !enabled;
    exportFormat.disabled = !enabled;
    exportBtn.disabled = !enabled;
    resetMuteSoloBtn.disabled = !enabled;
    expandAllBtn.disabled = !enabled;
  }

  function setPlayingUI(playing) {
    playBtn.classList.toggle("is-playing", playing);
    playBtn.setAttribute("aria-label", playing ? "Pause" : "Play");
  }

  /**
   * Starts playback and only reflects "playing" in the UI once synth.play()
   * has actually confirmed the AudioContext is running -- not before, or
   * the pause icon shows during the window (or indefinitely, if the
   * browser's autoplay policy blocks it outright) where nothing is
   * actually audible yet and the piano roll just sits still. A block shows
   * the click-to-play prompt instead of failing silently or scaring the
   * user with an error banner over something that isn't a real failure.
   */
  async function attemptPlay() {
    try {
      await synth.play();
      setPlayingUI(true);
      autoplayPrompt.hidden = true;
      return true;
    } catch (err) {
      setPlayingUI(false);
      if (err.code === "audio-blocked") {
        autoplayPrompt.hidden = false;
      } else {
        showBanner(`Playback error: ${err.message || err}`, "error");
      }
      return false;
    }
  }

  // -- gm.dls: same-directory fetch, a remembered handle, or a drag-and-dropped fallback --

  /** Reflects needsDls/rememberedDlsHandle/synthReady into the dropzone's
   * copy and what its browse link/hidden input do. A remembered handle
   * takes priority over the plain needsDls prompt whenever both are true. */
  /** Everything about the gm.dls prompt (title, hint, browse label, whether
   * a demo song can even be picked yet) lives in this one dark dropzone
   * box -- no separate banner. A routine "you haven't given me gm.dls yet"
   * first-run step isn't an error or a warning, and the amber status
   * banner reads as one at a glance; it was firing for this on every
   * single first visit, which is the opposite of what that color means
   * everywhere else in this UI (see .status-banner's real uses: a failed
   * wasm load, a rejected permission, an actually-bad file). */
  function updateDropzoneMode() {
    demoToggleBtn.disabled = !synthReady;
    demoToggleBtn.textContent = synthReady ? "or try a demo song" : "add gm.dls to try a demo song";

    if (rememberedDlsHandle) {
      dropzoneTitleEl.textContent = "Use your gm.dls from last time?";
      dropHint.textContent = rememberedDlsHandle.name;
      browseBtn.textContent = "Use remembered gm.dls";
      browseBtn.title = "Nothing about the file was stored, only your browser's permission to re-open it.";
      forgetDlsBtn.hidden = false;
      fileInput.accept = ".dls";
    } else if (needsDls) {
      dropzoneTitleEl.textContent = "Drop your gm.dls file here";
      dropHint.textContent = "Used only in this tab, never saved to disk. Get it from C:\\Windows\\System32\\gm.dls on a Windows install, or wherever you've got one.";
      browseBtn.textContent = "browse for gm.dls instead";
      browseBtn.title = "";
      forgetDlsBtn.hidden = true;
      fileInput.accept = ".dls";
    } else {
      dropzoneTitleEl.textContent = "Drop a .mid file";
      dropHint.textContent = synthReady ? "Drag a .mid file here" : "Loading synth engine…";
      browseBtn.textContent = "browse a file instead";
      browseBtn.title = "";
      forgetDlsBtn.hidden = true;
      fileInput.accept = ".mid,.midi,audio/midi";
    }
  }

  function showDlsPrompt() {
    needsDls = true;
    hideBanner(); // this state has its own explanation in the dropzone box now, not a banner
    updateDropzoneMode();
  }

  /** @param {File} file @param {FileSystemFileHandle} [handle] pass this
   * when the file came from the File System Access API (a picker or a drop
   * that yielded a handle) so it gets remembered for next visit; omit it
   * for a plain <input>/drag File, which can't be remembered. */
  async function loadDls(file, handle) {
    hideBanner();
    dropHint.textContent = "Reading gm.dls…";
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      synth.initWithDls(bytes);
      needsDls = false;
      rememberedDlsHandle = null;
      synthReady = true;
      updateDropzoneMode();
      if (handle && window.SlopgsDlsStore) {
        window.SlopgsDlsStore.saveDlsHandle(handle); // best-effort, not awaited
      }
      if (pendingMidiFile) {
        const f = pendingMidiFile;
        pendingMidiFile = null;
        loadFile(f);
      }
    } catch (err) {
      showBanner(`Couldn't use ${file.name} as gm.dls: ${err.message || err}`, "error");
      updateDropzoneMode();
    }
  }

  /**
   * Re-requests access to a remembered handle from a user gesture (a click
   * on the dropzone's primary button, which is what wires this up) --
   * requestPermission() only works following a real gesture, unlike
   * queryPermission() in tryRememberedDls() below, which can run silently
   * at boot.
   */
  async function useRememberedDls() {
    const handle = rememberedDlsHandle;
    if (!handle) return;
    try {
      const perm = await handle.requestPermission({ mode: "read" });
      if (perm !== "granted") {
        showBanner("Permission wasn't granted -- pick a file below instead.", "error");
        return;
      }
      const file = await handle.getFile();
      await loadDls(file, handle);
    } catch (err) {
      rememberedDlsHandle = null;
      if (window.SlopgsDlsStore) window.SlopgsDlsStore.clearDlsHandle();
      updateDropzoneMode();
      showBanner(`Couldn't reuse the remembered gm.dls (${err.message || err}) -- drop it again.`, "error");
    }
  }

  /**
   * Checked once at boot, after a same-directory gm.dls fetch has already
   * failed: is there a handle left over from an earlier visit? If the
   * browser still silently trusts it (queryPermission, no gesture needed),
   * this loads it with no prompt at all -- the common case after the
   * first visit. If it needs re-confirming, or the file's gone/moved, this
   * falls through to the ordinary prompt (with or without the remembered-
   * handle affordance, respectively) rather than ever leaving the page
   * stuck.
   */
  async function tryRememberedDls() {
    const store = window.SlopgsDlsStore;
    if (!store || !store.hasFileSystemAccess()) {
      showDlsPrompt();
      return;
    }
    const handle = await store.loadDlsHandle();
    if (!handle) {
      showDlsPrompt();
      return;
    }
    let perm;
    try {
      perm = await handle.queryPermission({ mode: "read" });
    } catch {
      perm = "denied";
    }
    if (perm === "granted") {
      try {
        const file = await handle.getFile();
        await loadDls(file, handle);
        return;
      } catch {
        await store.clearDlsHandle();
        showDlsPrompt();
        return;
      }
    }
    rememberedDlsHandle = handle;
    showDlsPrompt();
  }

  // -- boot: load the synth engine eagerly so it's ready before the first drop --
  setTransportEnabled(false);
  updateDropzoneMode();
  synth
    .load()
    .then(() => {
      if (synth.dlsReady) {
        synthReady = true;
        updateDropzoneMode();
      } else {
        tryRememberedDls();
      }
    })
    .catch((err) => {
      dropHint.textContent = "Setup incomplete";
      showBanner(err.message || String(err), "setup");
    });

  synth.onEnded = () => {
    setPlayingUI(false);
    // synth already reset to the start internally; reflect that immediately
    // instead of waiting up to 140ms for the next transport poll.
    seekBar.value = "0";
    timeElapsed.textContent = fmtTime(0);
  };

  // -- channel sidebar --

  /**
   * One row of the "♪ [=====bar=====]" shape -- shared by the volume, pan,
   * and pitch meters so all three stay pixel-identical. `fillClass` is a
   * second class on the fill element (alongside the shared
   * .channel-row__meter-fill) that updateChannelList later selects by, the
   * same querySelector-by-class pattern the rest of this row already uses.
   * `labelClass` is omitted for volume (a plain level has no meaningful
   * "default" landmark worth a watermark the way pan's center or pitch's
   * rest position do) and present for pan/pitch, which also get the center
   * tick via .channel-row__meter-bar--bipolar.
   */
  function buildMeterRow(icon, fillClass, labelClass, titleText) {
    const row = document.createElement("div");
    row.className = "channel-row__meter";

    const iconEl = document.createElement("span");
    iconEl.className = "channel-row__meter-icon";
    iconEl.textContent = icon;
    iconEl.setAttribute("aria-hidden", "true");

    const bar = document.createElement("span");
    bar.className = labelClass ? "channel-row__meter-bar channel-row__meter-bar--bipolar" : "channel-row__meter-bar";
    bar.title = titleText;

    const fill = document.createElement("span");
    fill.className = `channel-row__meter-fill ${fillClass}`;
    bar.appendChild(fill);

    if (labelClass) {
      const label = document.createElement("span");
      label.className = `channel-row__meter-label ${labelClass}`;
      bar.appendChild(label);
    }

    row.append(iconEl, bar);
    return row;
  }

  function buildChannelList(data) {
    channelList.innerHTML = "";
    // Every rebuilt row starts collapsed (styles.css's own default) --
    // keep the bulk toggle's own state and label in sync with that, or a
    // stale "Collapse all" could sit there claiming a state the fresh rows
    // aren't actually in.
    allRowsExpanded = false;
    expandAllBtn.textContent = "Expand all";
    perChannelNotes = new Map();
    perDrumKeyNotes = new Map();
    for (const ch of data.channelsUsed) {
      perChannelNotes.set(ch, data.notes.filter((n) => n.channel === ch).sort((a, b) => a.startSec - b.startSec));
    }

    const channels = [...data.channelsUsed].sort((a, b) => a - b);
    sidebarEmpty.hidden = channels.length > 0;

    for (const ch of channels) {
      const li = document.createElement("li");
      li.className = "channel-row";
      li.dataset.channel = String(ch);

      const main = document.createElement("div");
      main.className = "channel-row__main";

      // The dot/CH-num/mute/solo/expand controls stay a tight single-line
      // grid; the patch name gets its own full-width line below instead of
      // squeezed into a grid column between them (see .channel-row__main /
      // .channel-row__main-top in styles.css) -- at the bigger font size the
      // channel boxes now use, that leftover column was too narrow for a
      // lot of real GM/GS names ("Electric Guitar (muted)", "CM-64/CM-32L
      // Drum Kit") to fit before ellipsis kicked in. A full-width line below
      // makes truncation the rare exception instead of the common case; the
      // title attribute set below still covers that exception.
      const mainTop = document.createElement("div");
      mainTop.className = "channel-row__main-top";

      const dot = document.createElement("span");
      dot.className = "channel-row__dot";
      dot.style.background = channelSwatchColor(ch);
      // Lets the meter fills and voice-count squares below borrow this same
      // per-channel hue (var(--ch-color) in styles.css) instead of one flat
      // color for everything -- inherits down to them since custom
      // properties do.
      li.style.setProperty("--ch-color", channelSwatchColor(ch));

      const num = document.createElement("span");
      num.className = "channel-row__num";
      num.textContent = `CH ${String(ch + 1).padStart(2, "0")}`;

      // Empty grid cell where the patch name used to live -- keeps the
      // mute/solo/expand controls pinned to the same columns they always
      // were without duplicating that grid's sizing elsewhere.
      const spacer = document.createElement("span");
      spacer.className = "channel-row__spacer";
      spacer.setAttribute("aria-hidden", "true");

      const patch = document.createElement("div");
      patch.className = "channel-row__patch";

      // Shown only on the one channel (if any) detectLyricMelodyChannel
      // picked out for this file -- see that function's own comment and
      // applyMuteSolo below, which is what the boost actually patches into
      // the loaded bytes. Built for every row and hidden by default rather
      // than only ever created on the winning row, so there's exactly one
      // code path handling "does this row have a boost button" instead of
      // two (build-time presence vs. runtime insertion).
      const boostBtn = document.createElement("button");
      boostBtn.type = "button";
      boostBtn.className = "channel-row__btn channel-row__btn--boost";
      boostBtn.textContent = "B";
      boostBtn.hidden = true;
      boostBtn.setAttribute("aria-pressed", "false");
      boostBtn.title = "This channel's notes line up closely with the lyrics' timing -- probably the melody line. Boost it to hear it more clearly over the mix.";
      boostBtn.setAttribute("aria-label", `Boost channel ${ch + 1} -- it likely carries the melody line the lyrics follow`);
      boostBtn.addEventListener("click", () => {
        melodyBoostEnabled = !melodyBoostEnabled;
        boostBtn.setAttribute("aria-pressed", String(melodyBoostEnabled));
        applyMuteSolo();
      });

      const patchText = document.createElement("span");
      patchText.className = "channel-row__patch-text";
      patchText.textContent = gmInstrumentName(0, ch === 9);
      patchText.title = patchText.textContent; // full name on hover, for the rare name still too long for the full-width line

      patch.append(boostBtn, patchText);

      const muteBtn = document.createElement("button");
      muteBtn.type = "button";
      muteBtn.className = "channel-row__btn channel-row__btn--mute";
      muteBtn.textContent = "M";
      muteBtn.setAttribute("aria-pressed", "false");
      muteBtn.setAttribute("aria-label", `Mute channel ${ch + 1}`);
      muteBtn.addEventListener("click", () => {
        if (mutedChannels.has(ch)) mutedChannels.delete(ch);
        else mutedChannels.add(ch);
        applyMuteSolo();
      });

      const soloBtn = document.createElement("button");
      soloBtn.type = "button";
      soloBtn.className = "channel-row__btn channel-row__btn--solo";
      soloBtn.textContent = "S";
      soloBtn.setAttribute("aria-pressed", "false");
      soloBtn.setAttribute("aria-label", `Solo channel ${ch + 1}`);
      soloBtn.addEventListener("click", () => {
        if (soloedChannels.has(ch)) soloedChannels.delete(ch);
        else soloedChannels.add(ch);
        applyMuteSolo();
      });

      // Volume/pan/pitch default to one shared row (see .channel-row__meters
      // in styles.css) -- this button swaps that row to three full-width
      // ones stacked instead, per-channel. expandAllBtn below does the same
      // thing in bulk.
      const expandBtn = document.createElement("button");
      expandBtn.type = "button";
      expandBtn.className = "channel-row__expand-btn";
      expandBtn.textContent = "▾";
      expandBtn.setAttribute("aria-expanded", "false");
      expandBtn.setAttribute("aria-label", "Expand channel meters");
      expandBtn.addEventListener("click", () => setRowExpanded(li, !isRowExpanded(li)));

      mainTop.append(dot, num, spacer, muteBtn, soloBtn, expandBtn);
      main.append(mainTop, patch);
      li.appendChild(main);

      // Live volume/pan/pitch. Pan and pitch fill from a center tick and
      // swap in a plain-language label ("LR", "+0") when they're sitting
      // dead at their default instead of showing a zero-width sliver.
      const meters = document.createElement("div");
      meters.className = "channel-row__meters";
      meters.append(
        buildMeterRow("♪", "channel-row__vol-fill", null, "Volume (CC7)"),
        buildMeterRow("↔", "channel-row__pan-fill", "channel-row__pan-label", "Pan (CC10)"),
        buildMeterRow("↕", "channel-row__pitch-fill", "channel-row__pitch-label", "Pitch bend")
      );
      li.appendChild(meters);

      if (ch === 9) {
        // The drum grid below already is a per-key activity readout with its
        // own labels -- a second, generic voice-count meter on this row
        // would just repeat what those chips already show more precisely.
        const drumKeys = [...new Set(perChannelNotes.get(ch).map((n) => n.key))].sort((a, b) => a - b);
        for (const key of drumKeys) {
          perDrumKeyNotes.set(key, perChannelNotes.get(ch).filter((n) => n.key === key));
        }

        const grid = document.createElement("div");
        grid.className = "drum-grid";
        for (const key of drumKeys) {
          const chip = document.createElement("span");
          chip.className = "drum-grid__chip";
          chip.dataset.key = String(key);
          chip.textContent = window.SlopgsMidi.gmPercussionLabel(key);
          chip.title = window.SlopgsMidi.gmPercussionName(key);
          grid.appendChild(chip);
        }
        li.appendChild(grid);
      } else {
        // A full-width row of its own, below the name/mute/solo line, rather
        // than squeezed into that grid as another column -- packed in next
        // to a long patch name, the two kept clipping each other. Left empty
        // here -- populateVoiceSquares (called once after the full channel
        // list is in the DOM, below) measures the real rendered width and
        // fills in exactly as many squares as fit, since that number depends
        // on layout this row doesn't have yet mid-build.
        const voices = document.createElement("div");
        voices.className = "channel-row__voices";
        voices.setAttribute("aria-hidden", "true"); // decorative echo of audible state, not new info for a11y
        voices.title = "Notes currently sounding on this channel";
        li.appendChild(voices);
      }

      channelList.appendChild(li);
    }

    populateVoiceSquares();

    melodyBoostEnabled = false;
    if (data.lyricMelodyChannel !== null) {
      const row = channelList.querySelector(`.channel-row[data-channel="${data.lyricMelodyChannel}"]`);
      const btn = row && row.querySelector(".channel-row__btn--boost");
      if (btn) btn.hidden = false;
    }
  }

  // -- per-row / global expand-collapse (volume/pan/pitch meters) --

  function isRowExpanded(row) {
    return row.querySelector(".channel-row__meters").classList.contains("channel-row__meters--expanded");
  }

  function setRowExpanded(row, expanded) {
    row.querySelector(".channel-row__meters").classList.toggle("channel-row__meters--expanded", expanded);
    const btn = row.querySelector(".channel-row__expand-btn");
    btn.textContent = expanded ? "▴" : "▾";
    btn.setAttribute("aria-expanded", String(expanded));
    btn.setAttribute("aria-label", expanded ? "Collapse channel meters" : "Expand channel meters");
  }

  // Independent of any individual row's own state -- always forces every
  // row to the same one, and flips which way that is on each click, rather
  // than trying to infer "expand" vs "collapse" from a mixed starting point.
  let allRowsExpanded = false;
  expandAllBtn.addEventListener("click", () => {
    allRowsExpanded = !allRowsExpanded;
    expandAllBtn.textContent = allRowsExpanded ? "Collapse all" : "Expand all";
    for (const row of channelList.children) setRowExpanded(row, allRowsExpanded);
  });

  // Fixed square size + gap, mirroring .voice-sq/.channel-row__voices in
  // styles.css -- kept as their own constants (not read from computed
  // style) because this only needs to run once per file load, and reading
  // getComputedStyle for two numbers isn't worth it over just keeping the
  // two sides of this in sync by hand (both are tiny, stable values).
  const VOICE_SQ_SIZE = 6;
  const VOICE_SQ_GAP = 2;
  // How many voice-count squares actually fit a row of the given width,
  // edge to edge -- "spawn enough boxes to fill the width" instead of a
  // guessed fixed count that leaves a gap on a wide sidebar or overflows a
  // narrow one. 6 is a floor, not a real expectation: only reachable if
  // the sidebar were absurdly narrow, which the responsive breakpoint
  // doesn't actually allow.
  function computeVoiceSquareCount(containerWidthPx) {
    if (!containerWidthPx) return 16;
    return Math.max(6, Math.floor((containerWidthPx + VOICE_SQ_GAP) / (VOICE_SQ_SIZE + VOICE_SQ_GAP)));
  }

  /** Measures one .channel-row__voices (they're all the same width) and
   * (re)builds every row's squares to that count -- see buildChannelList,
   * which leaves these containers empty until this runs post-insertion. */
  function populateVoiceSquares() {
    const sample = channelList.querySelector(".channel-row__voices");
    if (!sample) return;
    const count = computeVoiceSquareCount(sample.clientWidth);
    for (const voices of channelList.querySelectorAll(".channel-row__voices")) {
      voices.innerHTML = "";
      for (let i = 0; i < count; i++) {
        const sq = document.createElement("span");
        sq.className = "voice-sq";
        voices.appendChild(sq);
      }
      const overflow = document.createElement("span");
      overflow.className = "channel-row__voices-overflow";
      overflow.hidden = true;
      voices.appendChild(overflow);
    }
    voiceSquareCount = count;
  }

  resetMuteSoloBtn.addEventListener("click", () => {
    if (mutedChannels.size === 0 && soloedChannels.size === 0) return;
    mutedChannels.clear();
    soloedChannels.clear();
    applyMuteSolo();
  });

  /** Channels that should not sound right now: explicit mutes, or -- when
   * any channel is soloed -- everything that isn't soloed. */
  function effectiveMutedChannels() {
    if (soloedChannels.size > 0) {
      const muted = new Set();
      for (const ch of currentData.channelsUsed) {
        if (!soloedChannels.has(ch)) muted.add(ch);
      }
      return muted;
    }
    return mutedChannels;
  }

  async function applyMuteSolo() {
    if (!currentData || !currentBytes) return;
    const muted = effectiveMutedChannels();
    roll.setMutedChannels(muted);

    for (const row of channelList.children) {
      const ch = Number(row.dataset.channel);
      row.querySelector(".channel-row__btn--mute").setAttribute("aria-pressed", String(mutedChannels.has(ch)));
      row.querySelector(".channel-row__btn--solo").setAttribute("aria-pressed", String(soloedChannels.has(ch)));
      row.classList.toggle("is-silenced", muted.has(ch));
    }

    const patched = currentBytes.slice();
    for (const ch of muted) {
      const offsets = currentData.noteOnVelocityOffsets.get(ch);
      if (!offsets) continue;
      for (const off of offsets) patched[off] = 0;
    }
    // Same byte-patching path mute/solo already uses -- msgs.wasm has no
    // live per-channel gain of its own (see reloadPreservingPosition in
    // synth.js), so "louder" means scaling this channel's own note-on
    // velocities up before the file is (re)loaded, same way "silent" means
    // scaling them to 0 above. Skipped if the melody channel is itself
    // muted right now -- boosting a channel that isn't sounding at all
    // wouldn't do anything audible anyway.
    if (melodyBoostEnabled && currentData.lyricMelodyChannel !== null && !muted.has(currentData.lyricMelodyChannel)) {
      const offsets = currentData.noteOnVelocityOffsets.get(currentData.lyricMelodyChannel);
      if (offsets) {
        for (const off of offsets) patched[off] = Math.min(127, Math.round(patched[off] * MELODY_BOOST_FACTOR));
      }
    }
    try {
      await synth.reloadPreservingPosition(patched);
    } catch (err) {
      showBanner(`Couldn't apply mute/solo: ${err.message || err}`, "error");
    }
  }

  function channelSwatchColor(ch) {
    if (ch === 9) return "hsl(0, 0%, 68%)";
    const hues = [206, 42, 150, 350, 265, 20, 190, 100, 320, 0, 60, 230, 10, 170, 290, 80];
    return `hsl(${hues[ch % 16]}, 68%, 60%)`;
  }

  // Poll-driven, not frame-driven (~140ms tick): a hit shorter than that
  // could land entirely between two polls and never register as "active".
  // Holding the flash for a minimum duration is what makes a fast drum hit
  // still readable as a light rather than a coin-flip.
  const MIN_FLASH_SEC = 0.18;
  // How many of the per-channel voice-count squares actually fit the row's
  // width -- beyond this, a row switches to a "+N" overflow label instead
  // of just running out of squares to light. Recomputed per file load by
  // populateVoiceSquares (see the -- channel sidebar -- section above),
  // which measures the real rendered width rather than guessing a fixed
  // count. The drum channel never renders this row at all -- its per-key
  // grid already shows the same "what's sounding right now" information
  // more precisely.
  let voiceSquareCount = 16;

  /** How many notes in `notes` are sounding (or recently-enough-struck to
   * still read as active, see MIN_FLASH_SEC) at time t -- the shared
   * primitive behind both the channel row's active/inactive highlight and
   * its live voice-count squares, so both agree and only cost one scan. */
  function countActiveInWindow(notes, t) {
    if (!notes || notes.length === 0) return 0;
    // Binary-search the last note starting at or before t, then scan
    // backward from there (to catch an earlier long note still sounding)
    // instead of always starting at the array's end: with t early in a
    // long/dense file, "start from the end" means skipping past almost
    // the entire (future) array on every single poll tick.
    let lo = 0, hi = notes.length - 1, idx = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (notes[mid].startSec <= t) { idx = mid; lo = mid + 1; }
      else hi = mid - 1;
    }
    let count = 0;
    for (let i = idx; i >= 0; i--) {
      const n = notes[i];
      const heldEnd = Math.max(n.endSec, n.startSec + MIN_FLASH_SEC);
      if (n.startSec <= t && heldEnd >= t) count++;
      else if (heldEnd < t - 2) break; // notes are start-sorted; far enough back, stop
    }
    return count;
  }

  function isDrumKeyActive(key, t) {
    return countActiveInWindow(perDrumKeyNotes.get(key), t) > 0;
  }

  // A value close enough to 0 that it reads as "no deviation at all" rather
  // than a barely-visible sliver of fill -- both pan and pitch bend are
  // floats derived from a 7/14-bit MIDI value, so exact 0 is common (the GM
  // default, or an explicit center message) but not the only thing that
  // should count as centered.
  const METER_CENTER_EPSILON = 0.004;

  /** Fills `.channel-row__${kind}-fill` outward from its bar's center tick,
   * and shows `centerLabel` in `.channel-row__${kind}-label` instead of a
   * near-invisible fill when `value` is at (or essentially at) 0. Uses
   * clip-path on an always-full-size element rather than animating
   * width/left directly -- see the CSS comment on .channel-row__meter-fill
   * for why (this is the same layout-thrash-avoidance clip-path already
   * gets everywhere else in this file, e.g. updateVoiceMeter's fill). */
  function setBipolarMeter(row, kind, value, centerLabel) {
    const v = Math.max(-1, Math.min(1, value));
    const fillEl = row.querySelector(`.channel-row__${kind}-fill`);
    const labelEl = row.querySelector(`.channel-row__${kind}-label`);
    if (Math.abs(v) < METER_CENTER_EPSILON) {
      fillEl.style.clipPath = "inset(0 50% 0 50%)";
      labelEl.textContent = centerLabel;
      return;
    }
    labelEl.textContent = "";
    if (v >= 0) {
      fillEl.style.clipPath = `inset(0 ${50 - v * 50}% 0 50%)`;
    } else {
      fillEl.style.clipPath = `inset(0 50% 0 ${50 + v * 50}%)`;
    }
  }

  // Half-width, in percent of the bar, of the pitch thumb -- see
  // setPitchMeter just below for why pitch gets a marker instead of a fill.
  const PITCH_THUMB_HALF_PCT = 1.6;

  /** Pan reads naturally as a fill growing from center -- more fill means
   * more signal pulled to one side. Pitch bend has no such "amount of
   * something" quality: it's a single value tracking where the wheel
   * currently sits, so a fill outward from center misread as "how hard the
   * bend is" (a magnitude) rather than "where the bend is right now" (a
   * position). This instead clips the same always-full-size fill element
   * down to a thin marker at that position -- still clip-path-only (see
   * setBipolarMeter above for the layout-thrash reason), just a narrow slit
   * that tracks the value instead of a region that grows with it. At rest
   * it collapses into the bar's own center tick and shows "+0", same as
   * setBipolarMeter's center-label handling. */
  function setPitchMeter(row, value) {
    const v = Math.max(-1, Math.min(1, value));
    const fillEl = row.querySelector(".channel-row__pitch-fill");
    const labelEl = row.querySelector(".channel-row__pitch-label");
    if (Math.abs(v) < METER_CENTER_EPSILON) {
      fillEl.style.clipPath = "inset(0 50% 0 50%)";
      labelEl.textContent = "+0";
      return;
    }
    labelEl.textContent = "";
    const pos = 50 + v * 50; // 0 (full bend down) .. 100 (full bend up)
    const left = Math.max(0, pos - PITCH_THUMB_HALF_PCT);
    const right = Math.max(0, 100 - pos - PITCH_THUMB_HALF_PCT);
    fillEl.style.clipPath = `inset(0 ${right}% 0 ${left}%)`;
  }

  function updateChannelList(t) {
    for (const row of channelList.children) {
      const ch = Number(row.dataset.channel);
      const prog = valueAt(currentData.programChanges.get(ch), t, null);
      const bank = valueAt(currentData.channelBanks.get(ch), t, { value: 0 }).value;
      const patchName = gmInstrumentName(prog ? prog.program : 0, ch === 9, bank);
      // .channel-row__patch-text, not .channel-row__patch itself -- the
      // latter is a flex container that may also hold the boost button
      // (see buildChannelList); writing textContent straight onto it would
      // silently delete that button along with the old text.
      const patchEl = row.querySelector(".channel-row__patch-text");
      if (patchEl.textContent !== patchName) {
        patchEl.textContent = patchName;
        patchEl.title = patchName;
      }

      const activeCount = countActiveInWindow(perChannelNotes.get(ch), t);
      row.classList.toggle("is-active", activeCount > 0);

      // Volume is unipolar (0..1, GM default ~0.79) -- a plain left-anchored
      // level, same shape as the sidebar's own overall VOICES meter.
      const vol = valueAt(currentData.channelVolumes.get(ch), t, { value: GM_DEFAULT_CHANNEL_VOLUME }).value;
      const volPct = Math.max(0, Math.min(1, vol)) * 100;
      row.querySelector(".channel-row__vol-fill").style.clipPath = `inset(0 ${100 - volPct}% 0 0)`;

      // Pan and pitch are both bipolar (-1..1) around a meaningful center --
      // true stereo center for pan, no bend at all for pitch -- so both fill
      // outward from the bar's center tick and swap in a plain-language
      // label ("LR", "+0") for "sitting dead at that center" instead of a
      // zero-width sliver nobody would notice.
      const pan = valueAt(currentData.channelPans.get(ch), t, { value: 0 }).value;
      setBipolarMeter(row, "pan", pan, "LR");

      const bend = valueAt(currentData.pitchBends.get(ch), t, { value: 0 }).value;
      setPitchMeter(row, bend);

      if (ch === 9) {
        const grid = row.querySelector(".drum-grid");
        if (grid) {
          for (const chip of grid.children) {
            const key = Number(chip.dataset.key);
            chip.classList.toggle("is-active", isDrumKeyActive(key, t));
          }
        }
      } else {
        const squares = row.querySelectorAll(".voice-sq");
        for (let i = 0; i < squares.length; i++) squares[i].classList.toggle("is-lit", i < activeCount);
        const overflowEl = row.querySelector(".channel-row__voices-overflow");
        const overflow = activeCount - voiceSquareCount;
        overflowEl.hidden = overflow <= 0;
        if (overflow > 0) overflowEl.textContent = `+${overflow}`;
      }
    }
  }

  // -- metadata bar --

  /**
   * Populates the strip between the piano roll and the transport from
   * whatever the file's own meta events carry (see midi.js's title/
   * copyright/text/markers). Most files carry little or none of this --
   * the bar collapses to nothing rather than showing empty punctuation.
   * The live "current marker" readout is wired separately in
   * updateMetaMarker, polled alongside the rest of the transport.
   */
  function buildMetaBar(data) {
    metaInfo.innerHTML = "";
    const parts = [];
    if (data.title) parts.push({ cls: "metabar__title", text: data.title });
    if (data.copyright) parts.push({ cls: "metabar__dim", text: data.copyright });
    if (data.text) parts.push({ cls: "metabar__dim", text: data.text });
    for (let i = 0; i < parts.length; i++) {
      if (i > 0) {
        const sep = document.createElement("span");
        sep.className = "metabar__sep";
        sep.textContent = "·";
        metaInfo.appendChild(sep);
      }
      const el = document.createElement("span");
      el.className = parts[i].cls;
      el.textContent = parts[i].text;
      metaInfo.appendChild(el);
    }
    currentMarkerText = null;
    metaMarker.hidden = true;
    const hasMarkers = data.markers && data.markers.length > 0;
    metabar.hidden = parts.length === 0 && !hasMarkers;
  }

  // -- karaoke lyrics --

  /** Index of the most-recently-started lyric line at or before `t`, or -1
   * if the file's lyrics haven't started yet. Same binary-search shape as
   * barIndexAt below -- kept separate since the two want different return
   * conventions (a bar number vs. an array index with neighbors). */
  function lyricLineIndexAt(lines, t) {
    let lo = 0, hi = lines.length - 1, ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (lines[mid].atSec <= t) { ans = mid; lo = mid + 1; }
      else hi = mid - 1;
    }
    return ans;
  }

  function setLyricRowRole(row, role) {
    row.role = role;
    if (role === null) row.el.removeAttribute("data-role");
    else row.el.dataset.role = String(role);
  }

  function setLyricRowText(row, text) {
    row.el.textContent = text || "";
    row.el.title = text || "";
  }

  function setLyricRowLive(row, isCurrent) {
    if (isCurrent) row.el.setAttribute("aria-live", "polite");
    else row.el.removeAttribute("aria-live");
  }

  /** Snaps every row straight to its target role/text with no transition --
   * used for a freshly loaded file and for any jump that isn't a plain
   * one-line forward advance (a seek, a loop restart). Animating a "slide
   * past everything in between" for those would read as a glitch, not
   * motion, so this skips straight to the resting arrangement. */
  function snapLyricRows(lines, idx) {
    const textFor = [
      idx > 0 ? lines[idx - 1].text : "",
      idx >= 0 ? lines[idx].text : "",
      idx + 1 < lines.length ? lines[idx + 1].text : "",
      idx + 2 < lines.length ? lines[idx + 2].text : "",
    ];
    for (let i = 0; i < lyricRows.length; i++) {
      const row = lyricRows[i];
      const role = i - 1; // -1, 0, 1, 2
      row.el.classList.add("lyrics-overlay__row--no-transition");
      setLyricRowRole(row, role);
      setLyricRowText(row, textFor[i]);
      setLyricRowLive(row, role === 0);
    }
    // Forces the no-transition styles to actually land before the class
    // comes back off, or the *next* real advance would transition from
    // this frame's stale (pre-snap) state instead of starting clean.
    void lyricsOverlay.offsetHeight;
    for (const row of lyricRows) row.el.classList.remove("lyrics-overlay__row--no-transition");
  }

  /** Rotates which physical row element holds which role, one step
   * forward -- the row at role -1 (about to scroll off) is recycled to
   * become the new role 2 (the line now coming into view), instantly
   * repositioned to exactly where role 2 already rests but invisible, then
   * released back into its normal transition so it fades from there to
   * role 2's real resting look. Every other row just has its role
   * decremented by one and transitions there normally. That's what reads
   * as one continuous line physically moving from "next" up to "current"
   * (and "current" up and out to "prev") instead of four fixed boxes
   * relabeling their text. Only valid for exactly one line of forward
   * advance -- anything else goes through snapLyricRows instead. */
  function advanceLyricRowsByOne(lines, idx) {
    const outgoing = lyricRows.find((r) => r.role === -1);
    for (const row of lyricRows) {
      if (row === outgoing) continue;
      setLyricRowRole(row, row.role - 1);
      setLyricRowLive(row, row.role === 0);
    }
    outgoing.el.classList.add("lyrics-overlay__row--no-transition");
    setLyricRowRole(outgoing, "enter");
    setLyricRowText(outgoing, idx + 2 < lines.length ? lines[idx + 2].text : "");
    setLyricRowLive(outgoing, false);
    void outgoing.el.offsetHeight; // commit the invisible "enter" state before transitions resume
    outgoing.el.classList.remove("lyrics-overlay__row--no-transition");
    setLyricRowRole(outgoing, 2); // the transition from here to role 2's resting look is what fades it in
  }

  let lastLyricLineIndex = -2; // sentinel below any real index -- guarantees the first updateLyrics call writes
  let lyricRowsPrimed = false; // false until the first snap -- gates advanceLyricRowsByOne, which needs a real role -1 to recycle

  /** Resets/hides the piano roll's lyrics ticker for a freshly loaded file
   * -- shown only for the minority of files that carry any SMF Lyric
   * events at all (see lyricLines in midi.js); everyone else leaves the
   * roll's own dead space exactly as blank as it's always been. */
  function buildLyricsOverlay(data) {
    lastLyricLineIndex = -2;
    lyricRowsPrimed = false;
    lyricsOverlay.hidden = !(data.lyricLines && data.lyricLines.length > 0);
    for (const row of lyricRows) {
      row.el.classList.add("lyrics-overlay__row--no-transition");
      setLyricRowRole(row, null);
      setLyricRowText(row, "");
      setLyricRowLive(row, false);
    }
    void lyricsOverlay.offsetHeight;
    for (const row of lyricRows) row.el.classList.remove("lyrics-overlay__row--no-transition");
  }

  /** Current line centered (bright, enlarged), two lines of dimmed context
   * below and one above, each sliding/fading into its new role as playback
   * crosses a line boundary -- refreshed on the same ~140ms poll as the
   * rest of the transport (see updateTransport). Skips all of this
   * entirely when the active line hasn't changed since the last poll, same
   * guard updateMetaMarker uses. */
  function updateLyrics(t) {
    if (!currentData || !currentData.lyricLines || currentData.lyricLines.length === 0) return;
    const lines = currentData.lyricLines;
    const idx = lyricLineIndexAt(lines, t);
    if (idx === lastLyricLineIndex) return;
    const isForwardStep = lyricRowsPrimed && idx === lastLyricLineIndex + 1;
    lastLyricLineIndex = idx;
    if (isForwardStep) advanceLyricRowsByOne(lines, idx);
    else snapLyricRows(lines, idx);
    lyricRowsPrimed = true;
  }

  // -- metadata bar (marker readout) --

  /** Most-recent marker at or before the current position, refreshed on the
   * same ~140ms poll as the rest of the transport (see updateTransport). */
  function updateMetaMarker(t) {
    if (!currentData || !currentData.markers || currentData.markers.length === 0) return;
    const m = valueAt(currentData.markers, t, null);
    const text = m ? m.text : null;
    if (text === currentMarkerText) return;
    currentMarkerText = text;
    metaMarkerText.textContent = text || "";
    metaMarker.hidden = !text;
  }

  // -- transport --

  /**
   * Fallback voice count from note on/off timing alone, used when the
   * engine's real voice history isn't available yet (synth.
   * getActiveVoiceCountAt returns null right at playback start, before
   * anything has rendered) or the wasm build doesn't export the debug
   * counter at all. This is an approximation: it counts a note as sounding
   * exactly from its note-on to its note-off, with no release/decay tail,
   * so it under-counts whatever is still ringing out after note-off. notes[]
   * is sorted by startSec, so this only needs one binary search per poll
   * tick (~7Hz); this is not the piano roll's 60fps redraw, so no
   * early-exit bound is worth the complexity here.
   */
  function countActiveVoicesFallback(t) {
    if (!currentData) return 0;
    const notes = currentData.notes;
    let lo = 0, hi = notes.length - 1, idx = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (notes[mid].startSec <= t) { idx = mid; lo = mid + 1; }
      else hi = mid - 1;
    }
    let count = 0;
    for (let i = idx; i >= 0; i--) {
      if (notes[i].endSec >= t) count++;
    }
    return count;
  }

  function updateVoiceMeter(t) {
    if (!currentData) {
      voiceMeter.hidden = true;
      return;
    }
    // Prefer the engine's own real voice history (release tails,
    // voice-stealing and all, time-corrected to the audible position -- see
    // synth.js's getActiveVoiceCountAt) and only fall back to the cruder
    // note-timing approximation when there's no history yet or this wasm
    // build doesn't export the debug counter at all.
    const fromEngine = synth.getActiveVoiceCountAt(t);
    const raw = fromEngine !== null ? fromEngine : countActiveVoicesFallback(t);
    // The engine's own polyphony cap is the real ceiling on how many voices
    // can ever truly sound at once; clamp the display to it rather than
    // showing a number the audio hardware can't actually reach (dense
    // overlapping notes in the data can exceed it, where the real engine
    // would have already started stealing voices).
    const max = window.SlopgsSynth.MAX_VOICES;
    const count = Math.min(raw, max);
    voiceMeter.hidden = false;
    voiceCountEl.textContent = String(count);
    const frac = Math.min(1, count / max);
    voiceMeterFill.style.clipPath = `inset(0 ${(1 - frac) * 100}% 0 0)`;
    voiceMeterFill.classList.toggle("is-hot", frac > 0.75);
  }

  /** 1-based index of the bar containing time `t` -- barTimes[i] is the
   * start of bar i+1, floor-searched the same way nearestBarTime/valueAt
   * binary-search their own sorted lists. The final barTimes entry is an
   * end-of-song marker, not a real bar start, and is excluded. */
  function barIndexAt(barTimes, t) {
    const totalBars = barTimes.length - 1;
    if (totalBars <= 0) return 1;
    let lo = 0, hi = totalBars - 1, ans = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (barTimes[mid] <= t) { ans = mid; lo = mid + 1; }
      else hi = mid - 1;
    }
    return ans + 1;
  }

  function updateBarCounter(t) {
    const totalBars = currentData.barTimes.length - 1;
    const current = barIndexAt(currentData.barTimes, t);
    const width = String(totalBars).length;
    barCounter.textContent = `${String(current).padStart(width, "0")}/${totalBars}`;
  }

  function updateTransport() {
    if (!currentData) return;
    const t = synth.getPositionSec();
    if (!seeking) {
      seekBar.value = String(Math.round((t / currentData.durationSec) * 1000) || 0);
      timeElapsed.textContent = fmtTime(t);
    }
    updateChannelList(t);
    updateVoiceMeter(t);
    updateMetaMarker(t);
    updateBarCounter(t);
    updateLyrics(t);
    // A deep seek (or resuming after a pause deep into a long file) can take
    // real wall-clock time to catch up -- msgs.wasm only rewinds to tick 0,
    // so reaching any later position means rendering through everything
    // before it. That work now yields instead of freezing the page, but the
    // page still stays at the old audio for a beat; this is what says so.
    seekingPill.hidden = !synth.seeking;
  }
  setInterval(updateTransport, 140);

  playBtn.addEventListener("click", () => {
    if (!currentData) return;
    if (synth.playing) {
      synth.pause();
      setPlayingUI(false);
    } else {
      attemptPlay();
    }
  });

  autoplayPrompt.addEventListener("click", () => {
    // A direct click is an unambiguous, fresh user gesture -- this is the
    // one guaranteed to satisfy the browser's autoplay policy.
    attemptPlay();
  });

  loopBtn.addEventListener("click", () => {
    const next = loopBtn.getAttribute("aria-pressed") !== "true";
    loopBtn.setAttribute("aria-pressed", String(next));
    synth.setLoop(next);
  });

  seekBar.addEventListener("pointerdown", () => { seeking = true; });
  seekBar.addEventListener("input", () => {
    if (!currentData) return;
    const frac = Number(seekBar.value) / 1000;
    timeElapsed.textContent = fmtTime(frac * currentData.durationSec);
  });
  seekBar.addEventListener("change", () => {
    if (!currentData) return;
    const frac = Number(seekBar.value) / 1000;
    const raw = frac * currentData.durationSec;
    // Snapping the release point to the nearest bar (rather than seeking to
    // wherever the pointer landed) keeps every seek aimed at a musically
    // sensible spot instead of an arbitrary mid-note instant.
    const snapped = nearestBarTime(currentData.barTimes, raw);
    seekBar.value = String(Math.round((snapped / currentData.durationSec) * 1000) || 0);
    timeElapsed.textContent = fmtTime(snapped);
    synth.seek(snapped).catch((err) => showBanner(`Seek error: ${err.message || err}`, "error"));
    seeking = false;
  });

  volumeSlider.addEventListener("input", () => {
    synth.setVolume(Number(volumeSlider.value) / 100);
  });
  synth.setVolume(Number(volumeSlider.value) / 100);

  updateRateSelect.addEventListener("change", () => {
    synth.setUpdateRateHz(Number(updateRateSelect.value));
  });
  synth.setUpdateRateHz(Number(updateRateSelect.value));

  // Expressed to the user as a speed multiplier (2x = twice as fast), but
  // the roll itself takes a lookahead window in seconds -- higher speed
  // means less lead time, hence dividing rather than multiplying.
  rollSpeedSelect.addEventListener("change", () => {
    roll.setLookaheadSec(window.SlopgsPianoRoll.DEFAULT_LOOKAHEAD_SEC / Number(rollSpeedSelect.value));
  });
  roll.setLookaheadSec(window.SlopgsPianoRoll.DEFAULT_LOOKAHEAD_SEC / Number(rollSpeedSelect.value));

  const EXPORT_STATUS_LABEL = { rendering: "Rendering", encoding: "Encoding" };

  exportBtn.addEventListener("click", async () => {
    if (!currentData) return;
    const format = exportFormat.value;
    const controlsToDisable = [exportBtn, exportFormat, playBtn, seekBar];
    for (const el of controlsToDisable) el.disabled = true;
    exportStatus.hidden = false;

    try {
      await window.SlopgsExport.exportAudio(synth, format, currentBaseName, (status, frac) => {
        const label = EXPORT_STATUS_LABEL[status] || status;
        exportStatus.textContent = frac == null ? `${label}…` : `${label} ${Math.round(frac * 100)}%`;
      });
    } catch (err) {
      showBanner(`Export failed: ${err.message || err}`, "error");
    } finally {
      for (const el of controlsToDisable) el.disabled = false;
      exportStatus.hidden = true;
    }
  });

  // -- loading a file --

  async function loadFile(file) {
    if (needsDls) {
      pendingMidiFile = file;
      showBanner("Drop (or browse for) gm.dls first -- this file will load automatically right after.", "setup");
      return;
    }
    if (!synthReady) {
      showBanner("Synth engine isn't ready yet -- check the setup message above.", "error");
      return;
    }
    hideBanner();
    dropHint.textContent = "Reading…";
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const data = parseMidiFile(bytes);
      synth.pause();
      synth.loadSong(bytes, data.durationSec);

      currentData = data;
      currentBytes = bytes;
      mutedChannels.clear();
      soloedChannels.clear();
      roll.setData(data);
      buildChannelList(data);
      buildMetaBar(data);
      buildLyricsOverlay(data);

      fileNameEl.textContent = file.name;
      currentBaseName = file.name.replace(/\.[^.]+$/, "") || "export";
      timeTotal.textContent = fmtTime(data.durationSec);
      timeElapsed.textContent = fmtTime(0);
      seekBar.value = "0";
      // Degenerate bar data (e.g. an SMPTE-timed file, which carries no real
      // time-signature/tempo map to derive bars from -- see midi.js) is just
      // [0, durationSec], one "bar" that spans the whole file. Not worth a
      // counter at that point, so it stays hidden rather than showing a
      // meaningless "01/01".
      transportBar.hidden = data.barTimes.length < 3;
      updateBarCounter(0);
      setTransportEnabled(true);
      setPlayingUI(false);
      dropzone.classList.add("is-loaded");

      // The dropzone is gone but nothing else has appeared yet -- attemptPlay
      // still has to wait out the resume-timeout window (and possibly a
      // seek catch-up) before it knows whether this ends in "playing" or
      // "show the click-to-play prompt". Without this, that gap is just an
      // empty roll with no explanation.
      loadingIndicator.hidden = false;
      try {
        // attemptPlay handles both outcomes itself: a real failure shows the
        // error banner, an autoplay block shows the click-to-play prompt.
        // Either way the file itself loaded fine, so this never throws back
        // into the "couldn't load the file" catch below.
        await attemptPlay();
      } finally {
        loadingIndicator.hidden = true;
      }
    } catch (err) {
      showBanner(`Couldn't play ${file.name}: ${err.message || err}`, "error");
      dropHint.textContent = "Drag a .mid file here";
    }
  }

  roll.start(() => (currentData ? synth.getPositionSec() : 0));

  // -- drag and drop --

  let dragDepth = 0;
  window.addEventListener("dragenter", (e) => {
    e.preventDefault();
    dragDepth++;
    dragOverlay.classList.add("is-active");
  });
  window.addEventListener("dragleave", () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) dragOverlay.classList.remove("is-active");
  });
  window.addEventListener("dragover", (e) => e.preventDefault());
  window.addEventListener("drop", async (e) => {
    e.preventDefault();
    dragDepth = 0;
    dragOverlay.classList.remove("is-active");
    // Captured before any await -- items on a DragEvent's DataTransfer are
    // only guaranteed live during the event's own dispatch, so the item
    // reference itself has to be read synchronously even though the handle
    // it hands back is fetched asynchronously.
    const item = e.dataTransfer.items && e.dataTransfer.items[0];
    const file = e.dataTransfer.files && e.dataTransfer.files[0];
    if (!file) return;
    if (needsDls && /\.dls$/i.test(file.name)) {
      let handle = null;
      if (item && typeof item.getAsFileSystemHandle === "function") {
        try {
          const h = await item.getAsFileSystemHandle();
          if (h && h.kind === "file") handle = h;
        } catch {
          // Not fatal -- this drop just won't be remembered next visit.
        }
      }
      loadDls(file, handle);
    } else {
      loadFile(file);
    }
  });

  browseBtn.addEventListener("click", async () => {
    if (rememberedDlsHandle) {
      await useRememberedDls();
      return;
    }
    // Prefer the real file picker when it can hand back a rememberable
    // handle; falls back to the plain hidden <input> (no persistence)
    // everywhere else, including the ordinary "browse a .mid file" case,
    // which never needs a handle at all.
    if (needsDls && window.SlopgsDlsStore && window.SlopgsDlsStore.hasFileSystemAccess()) {
      try {
        const [handle] = await window.showOpenFilePicker({
          types: [{ description: "DLS soundfont", accept: { "application/octet-stream": [".dls"] } }],
        });
        const file = await handle.getFile();
        await loadDls(file, handle);
      } catch (err) {
        if (err && err.name === "AbortError") return; // user closed the picker
        showBanner(`Couldn't open that file: ${err.message || err}`, "error");
      }
      return;
    }
    fileInput.click();
  });
  fileInput.addEventListener("change", () => {
    const file = fileInput.files[0];
    if (!file) return;
    if (needsDls) loadDls(file); else loadFile(file);
    fileInput.value = "";
  });

  forgetDlsBtn.addEventListener("click", () => {
    rememberedDlsHandle = null;
    if (window.SlopgsDlsStore) window.SlopgsDlsStore.clearDlsHandle();
    showDlsPrompt();
  });

  // Bundled with this repo, all CC BY-NC-SA 3.0, all from battleofthebits.com
  // -- see demo/CREDITS.md for the same attribution in plain-file form.
  // entryId is that BotB entry's own numeric ID (battleofthebits.com/
  // barracks/Entry/View/<id>/); each artist's `slug` is their BotB username
  // as it appears in the URL (battleofthebits.com/barracks/Profile/<slug>/).
  // General Serum alone credits two people -- artists is an array so that
  // row can link both names independently instead of picking just one.
  const DEMO_SONGS = [
    { file: "vonotron-assembler.mid", title: "Vonotron Assembler", entryId: 30336, artists: [{ name: "Strobe", slug: "Strobe" }] },
    { file: "nyrmodian-bird-park.mid", title: "Nyrmodian Bird Park", entryId: 27317, artists: [{ name: "pigdevil2010", slug: "pigdevil2010" }] },
    { file: "general-serum.mid", title: "~ GENERAL SERUM ~", entryId: 60184, artists: [{ name: "Kot", slug: "Kot" }, { name: "A64", slug: "A64" }] },
    { file: "transcendental.mid", title: "transcendental", entryId: 69940, artists: [{ name: "A64", slug: "A64" }] },
    { file: "midian-city-nightclub.mid", title: "Midian City Nightclub", entryId: 10285, artists: [{ name: "Strobe", slug: "Strobe" }] },
    { file: "domestic-droid-rights-foundation.mid", title: "Domestic Droid Rights Foundation", entryId: 5026, artists: [{ name: "Strobe", slug: "Strobe" }] },
  ];
  const BOTB_ENTRY_URL = (id) => `https://battleofthebits.com/barracks/Entry/View/${id}/`;
  const BOTB_PROFILE_URL = (slug) => `https://battleofthebits.com/barracks/Profile/${slug}/`;

  /** Loads one demo song -- the exact same loadFile path as any dropped
   * file (constructed as a real File so nothing here needs a separate code
   * path), which means it also queues correctly behind the gm.dls prompt
   * if that hasn't been resolved yet. */
  async function loadDemoSong(song) {
    demoPicker.hidden = true;
    try {
      const resp = await fetch(`demo/${song.file}`);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const buf = await resp.arrayBuffer();
      const artistNames = song.artists.map((a) => a.name).join(" & ");
      const file = new File([buf], `${song.title} - ${artistNames}.mid`);
      loadFile(file);
    } catch (err) {
      showBanner(`Couldn't load the demo song: ${err.message || err}`, "error");
    }
  }

  // Built once at boot, not per file-load -- the list never depends on
  // whatever's currently playing.
  for (const song of DEMO_SONGS) {
    const li = document.createElement("li");
    li.className = "demo-picker__song";
    li.tabIndex = 0;
    li.setAttribute("role", "button");
    li.setAttribute("aria-label", `Load demo song ${song.title}`);

    const titleRow = document.createElement("p");
    titleRow.className = "demo-picker__song-title";
    titleRow.textContent = song.title;
    const by = document.createElement("span");
    by.className = "demo-picker__song-by";
    by.append(" by ");
    song.artists.forEach((artist, i) => {
      if (i > 0) by.append(" & ");
      const link = document.createElement("a");
      link.href = BOTB_PROFILE_URL(artist.slug);
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.textContent = artist.name;
      by.appendChild(link);
    });
    titleRow.appendChild(by);

    const entryLink = document.createElement("a");
    entryLink.className = "demo-picker__song-link";
    entryLink.href = BOTB_ENTRY_URL(song.entryId);
    entryLink.target = "_blank";
    entryLink.rel = "noopener noreferrer";
    entryLink.textContent = "view on battleofthebits.com ↗";

    li.append(titleRow, entryLink);

    // The row itself loads the song; the artist and entry links inside it
    // need to navigate instead -- letting the click bubble up unchecked
    // would do both at once. Nothing needs stopPropagation for that: there's
    // only this one listener, so just don't treat a click that started on
    // an <a> as "load this song."
    li.addEventListener("click", (e) => {
      if (e.target.closest("a")) return;
      loadDemoSong(song);
    });
    li.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        loadDemoSong(song);
      }
    });

    demoPickerList.appendChild(li);
  }

  demoToggleBtn.addEventListener("click", () => {
    demoPicker.hidden = false;
  });
  demoCloseBtn.addEventListener("click", () => {
    demoPicker.hidden = true;
  });
  demoPicker.addEventListener("click", (e) => {
    if (e.target === demoPicker) demoPicker.hidden = true; // clicked the dimmed backdrop, not the panel
  });
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !demoPicker.hidden) demoPicker.hidden = true;
  });

  // -- perf hint: only worth surfacing at the higher update rates where a
  // slower device could plausibly struggle to keep up (see synth.js's
  // PERF_CHECK_MIN_HZ, which gates whether it even measures) --
  synth.onPerfChange = (strained) => {
    perfHint.hidden = !strained;
  };
})();

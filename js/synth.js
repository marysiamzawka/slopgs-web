/* synth.js -- thin playback engine around slopgs's msgs.wasm.
 *
 * The ABI (see slopgs src/wasm.c) is pull-based: msgs_render(ptr, frames)
 * fills PCM into wasm memory on demand and has no random-access seek, only
 * msgs_reset() (rewind to tick 0). Every position change -- seek, resume
 * from pause -- is implemented the same way: reset, then render-and-discard
 * up to the target sample, then resume normal chunked scheduling. That
 * discard pass is pure synthesis with no I/O, but "fast" was measured on a
 * short, sparse probe file and does not hold in general: on a real, dense,
 * multi-minute file, a deep seek measured over 2 seconds of real work.
 * _seekWasmTo is therefore async and yields every ~12ms so that cost is a
 * visible, animated "catching up" state (see synth.seeking) rather than a
 * multi-second freeze of the whole page -- the earlier, synchronous version
 * of this file froze the piano roll and produced audio that sounded like
 * a backlog dumping out all at once the moment the block finally ended.
 *
 * Audio is scheduled the way slopgs's own dist/bg-sound2.js does it: render
 * fixed-size chunks ahead of AudioContext.currentTime into chained
 * AudioBufferSourceNodes. Playback position for the UI is derived from
 * wall-clock (ctx.currentTime - the time the current run started), never
 * from how far the wasm has rendered ahead.
 */
"use strict";

const DEFAULT_CHUNK_SECONDS = 0.5;
// Selectable range for setChunkSeconds(). The output scratch buffer is
// allocated once, sized for MAX_CHUNK_SECONDS, precisely so this can be
// changed later without a reallocation (msgs_alloc never frees).
// MIN_CHUNK_SECONDS = 1/60 -- one video frame, the fastest update rate
// that's ever visually meaningful against a 60fps piano roll.
const MIN_CHUNK_SECONDS = 1 / 60;
const MAX_CHUNK_SECONDS = 1.0;
const LOOKAHEAD_SECONDS = 1.5;
const TOPUP_INTERVAL_MS = 200;
// Every stop/start of the scheduled source chain (pause, seek, mute/solo
// reload) rides this short linear fade instead of a hard cut, so a
// discontinuity at the splice point lands as silence, not a click.
const FADE_SECONDS = 0.015;
// Mirrors NUM_VOICES in slopgs's src/engine/voice.h. Not queryable through
// the ABI, so this is a hardcoded mirror -- update it if that constant ever
// changes in a rebuilt msgs.wasm.
const MAX_VOICES = 54;
// AudioContext.resume() does not reject when the browser's autoplay policy
// blocks it -- it just stays pending, forever, until some future gesture
// (anywhere on the page) happens to satisfy the policy. Waiting on it with
// no timeout means: no click-to-play prompt ever shows (the catch branch is
// unreachable), and if a second play() call arrives later, both resume()
// calls settle together and race for control of the same engine and timer
// state. This bounds the wait so a block becomes visible quickly, without
// being so short it false-positives on ordinary startup latency (measured
// 50-1200ms for a genuinely successful resume across real files/machines).
const RESUME_TIMEOUT_MS = 600;

class SlopgsSynth {
  constructor({ wasmUrl, dlsUrl }) {
    this.wasmUrl = wasmUrl;
    this.dlsUrl = dlsUrl;
    this.exp = null;
    this.sampleRate = 0;
    this.outPtr = 0;
    this.outPtrCapacityFrames = 0;
    this.chunkFrames = 0;
    this.chunkSeconds = DEFAULT_CHUNK_SECONDS;
    // {sec, count}[], sec = song position, count = real engine voice count
    // at that position -- see getActiveVoiceCountAt.
    this.voiceHistory = [];

    this.ctx = null;
    this.gain = null;
    this.sources = [];
    this.timer = null;
    this.nextStartTime = 0;
    this.playStartCtxTime = 0;
    this.basePositionSamples = 0;
    this.playing = false;
    this.loop = false;
    this.songLoaded = false;
    this.durationSec = 0;

    this.onEnded = null;
    this.onError = null;
    this._seekGeneration = 0;
    this._seekingCount = 0;
    // False until msgs_init has actually run -- either from a same-directory
    // gm.dls fetched in load(), or from bytes handed in later via
    // initWithDls() (e.g. a drag-and-dropped file). Nothing can play before
    // this is true.
    this.dlsReady = false;
  }

  async load() {
    if (typeof WebAssembly !== "object") {
      throw new Error("WebAssembly is not supported in this browser");
    }

    let wasmBytes;
    try {
      const resp = await fetch(this.wasmUrl);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      wasmBytes = await resp.arrayBuffer();
    } catch (err) {
      throw new Error(
        `could not load ${this.wasmUrl} -- run setup.sh to compile msgs.wasm from a slopgs checkout (${err.message || err})`
      );
    }

    let instance;
    try {
      ({ instance } = await WebAssembly.instantiate(wasmBytes, {}));
    } catch (err) {
      throw new Error(`msgs.wasm failed to instantiate: ${err.message || err}`);
    }

    const exp = instance.exports;
    if (typeof exp.__wasm_call_ctors === "function") exp.__wasm_call_ctors();

    const required = [
      "msgs_abi_version", "msgs_sample_rate", "msgs_alloc", "msgs_init",
      "msgs_reset", "msgs_load_smf", "msgs_set_loop", "msgs_render",
      "msgs_is_finished", "memory",
    ];
    for (const name of required) {
      if (!(name in exp)) throw new Error(`msgs.wasm is missing required export "${name}"`);
    }

    const abiVersion = exp.msgs_abi_version() >>> 0;
    if (abiVersion !== 1) {
      throw new Error(`msgs.wasm reports ABI version ${abiVersion}, expected 1`);
    }

    this.exp = exp;
    this.sampleRate = exp.msgs_sample_rate() >>> 0;
    this.chunkFrames = Math.max(1, Math.floor(this.sampleRate * this.chunkSeconds));

    // One reusable scratch buffer, shared by normal playback chunks and
    // discard-seek chunks, sized for the largest chunk setChunkSeconds()
    // can ever select -- msgs_alloc never frees, so sizing for the max up
    // front means changing the chunk size later never needs a second
    // allocation (which would otherwise leak the old one every time).
    // Allocated up front, independent of gm.dls -- wasm and this buffer are
    // usable the moment instantiation succeeds; only playback needs gm.dls.
    this.outPtrCapacityFrames = Math.ceil(this.sampleRate * MAX_CHUNK_SECONDS);
    this.outPtr = exp.msgs_alloc(this.outPtrCapacityFrames * 4); // stereo int16 = 4 bytes/frame

    let dlsBytes;
    try {
      const resp = await fetch(this.dlsUrl);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      dlsBytes = new Uint8Array(await resp.arrayBuffer());
    } catch (err) {
      // Not fatal: no gm.dls sits next to this page. The caller can still
      // supply one directly -- see initWithDls -- e.g. from a UI prompt that
      // accepts a drag-and-dropped gm.dls file. Leave dlsReady false and
      // return normally rather than throwing; the wasm engine itself is
      // already fully usable, it just has no instruments loaded yet.
      return;
    }
    this._initDls(dlsBytes);
  }

  /** Copies gm.dls bytes into wasm memory and runs msgs_init. Shared by the
   * same-directory fetch in load() and initWithDls()'s drag-and-drop path. */
  _initDls(dlsBytes) {
    const { exp } = this;
    const dlsPtr = exp.msgs_alloc(dlsBytes.length);
    new Uint8Array(exp.memory.buffer, dlsPtr, dlsBytes.length).set(dlsBytes);
    const initRet = exp.msgs_init(dlsPtr, dlsBytes.length) | 0;
    if (initRet !== 0) {
      throw new Error(`msgs_init failed (code ${initRet}) -- is this a valid gm.dls / DLS soundfont file?`);
    }
    this.dlsReady = true;
  }

  /**
   * Supplies gm.dls bytes directly -- e.g. read via file.arrayBuffer() from
   * a drag-and-dropped File -- for when load()'s same-directory fetch found
   * nothing. The bytes are copied into wasm memory only: nothing here ever
   * writes to disk or the site directory, the same way dragging a font into
   * Photopea makes it usable in that browser tab without uploading it
   * anywhere. Requires load() to have resolved first (wasm must already be
   * instantiated); a stray second call once gm.dls is already loaded is a
   * silent no-op rather than a double msgs_init.
   */
  initWithDls(dlsBytes) {
    if (!this.exp) throw new Error("synth.load() must resolve before initWithDls()");
    if (this.dlsReady) return;
    this._initDls(dlsBytes);
  }

  /**
   * Sets how many frames each render/schedule step covers. Smaller chunks
   * mean msgs_render() and the AudioBufferSourceNode scheduling machinery
   * run more often -- more responsive (finer-grained voice-history samples,
   * see getActiveVoiceCountAt; the topup loop reacts to state changes
   * sooner) but more CPU/JS overhead per second of audio. Takes effect on
   * the next render step; safe to call during playback.
   */
  setChunkSeconds(sec) {
    const clamped = Math.max(MIN_CHUNK_SECONDS, Math.min(MAX_CHUNK_SECONDS, sec));
    this.chunkSeconds = clamped;
    if (this.sampleRate) this.chunkFrames = Math.max(1, Math.floor(this.sampleRate * clamped));
  }

  /**
   * Same as setChunkSeconds, expressed as an update rate: how many times
   * per second a chunk renders/schedules (and, per getActiveVoiceCountAt,
   * how often the voice meter can actually change). 60Hz -- one video
   * frame -- is the fastest rate that's ever visually distinguishable
   * against the piano roll's own 60fps redraw; measured stable with zero
   * scheduling underruns on real multi-minute, dense files (up to ~90
   * AudioBufferSourceNodes alive at once at this rate, comfortably within
   * what a browser's audio graph handles).
   */
  setUpdateRateHz(hz) {
    this.setChunkSeconds(1 / hz);
  }

  /** @param {Uint8Array} bytes @param {number} durationSec from the JS-side parse */
  loadSong(bytes, durationSec) {
    const { exp } = this;
    exp.msgs_reset();
    this.voiceHistory.length = 0;
    const ptr = exp.msgs_alloc(bytes.length);
    new Uint8Array(exp.memory.buffer, ptr, bytes.length).set(bytes);
    const ret = exp.msgs_load_smf(ptr, bytes.length) | 0;
    if (ret !== 0) throw new Error(`msgs_load_smf failed (code ${ret}) -- not a valid MIDI file?`);
    exp.msgs_set_loop(0); // looping is driven from JS, same as bg-sound2.js
    this.songLoaded = true;
    this.durationSec = durationSec;
    this.basePositionSamples = 0;
  }

  /**
   * Swaps in a byte-patched copy of the currently loaded file (e.g. with
   * muted channels' note-on velocities zeroed) without disturbing playback
   * position -- msgs.wasm has no per-channel mute of its own, so mute/solo
   * is implemented by reloading a patched SMF and reseeking back to where
   * playback was.
   */
  async reloadPreservingPosition(bytes) {
    const wasPlaying = this.playing;
    const posSec = this.getPositionSec();
    const resumeAt = wasPlaying ? this._fadeOutAndStop() : 0;
    this.playing = false;

    const { exp } = this;
    exp.msgs_reset();
    this.voiceHistory.length = 0;
    const ptr = exp.msgs_alloc(bytes.length);
    new Uint8Array(exp.memory.buffer, ptr, bytes.length).set(bytes);
    const ret = exp.msgs_load_smf(ptr, bytes.length) | 0;
    if (ret !== 0) throw new Error(`msgs_load_smf failed (code ${ret}) while applying mute/solo`);
    exp.msgs_set_loop(0);

    this.basePositionSamples = Math.max(0, posSec) * this.sampleRate;
    if (wasPlaying) await this.play(resumeAt);
  }

  _ensureContext() {
    if (this.ctx) return;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) throw new Error("AudioContext is not supported in this browser");
    this.ctx = new Ctx();
    this.gain = this.ctx.createGain();
    this.gain.connect(this.ctx.destination);
    this.targetGain = 0.8;
    this.gain.gain.value = this.targetGain;
  }

  /**
   * Resolves true once the context is actually running, false if it hasn't
   * gotten there within RESUME_TIMEOUT_MS. The underlying resume() call
   * itself is never abandoned -- losing the race just means this function
   * stops waiting on it; if the browser resolves it later (a future
   * gesture), nothing is left listening, so it drives no further state
   * changes. A caller that wants to keep playback going should start an
   * entirely fresh play() from a real, later gesture instead.
   */
  async _resumeContextWithTimeout() {
    if (this.ctx.state === "running") return true;
    const resumed = this.ctx.resume().then(() => true).catch(() => false);
    const timedOut = new Promise((resolve) => setTimeout(() => resolve("timeout"), RESUME_TIMEOUT_MS));
    const result = await Promise.race([resumed, timedOut]);
    return result === true && this.ctx.state === "running";
  }

  setVolume(v) {
    this._ensureContext();
    this.targetGain = Math.max(0, Math.min(1, v));
    const g = this.gain.gain;
    const now = this.ctx.currentTime;
    g.cancelScheduledValues(now);
    g.setValueAtTime(this.targetGain, now);
  }

  setLoop(on) {
    this.loop = !!on;
  }

  /**
   * Real engine voice count (release tails, voice-stealing and all) at
   * audible song position `sec` -- looked up from voiceHistory rather than
   * asked of the engine directly, because the engine only ever answers
   * "right now", which during playback is the *render* position, running
   * up to LOOKAHEAD_SECONDS ahead of what's actually audible. Resolution
   * is one sample per rendered chunk (see setChunkSeconds): a smaller
   * chunk size means more history samples per second of audio, at the
   * cost of more render/schedule overhead.
   *
   * Returns null if this build's wasm doesn't export the (marked-temporary)
   * debug counter, or if nothing has been rendered yet at/before `sec`
   * (right at the very start of playback) -- callers should fall back to
   * an approximate count (e.g. from note on/off timing) in either case.
   */
  getActiveVoiceCountAt(sec) {
    const h = this.voiceHistory;
    if (h.length === 0) return null;
    let lo = 0, hi = h.length - 1, ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (h[mid].sec <= sec) { ans = mid; lo = mid + 1; }
      else hi = mid - 1;
    }
    return ans === -1 ? null : h[ans].count;
  }

  /**
   * Renders-and-discards from tick 0 up to `targetSamples` -- the only way
   * to reach an arbitrary position, since the ABI's msgs_reset() only
   * rewinds to tick 0 and there is no random-access seek. Pure synthesis,
   * no I/O, but NOT free: measured on real multi-minute, dense files, a
   * deep seek can take over two seconds of wall-clock time. Running that
   * as one giant synchronous loop blocks the main thread for that whole
   * span -- the piano roll can't animate a single frame, and audio (whose
   * scheduling also lives on this thread) goes silent and then dumps a
   * full lookahead buffer the instant the block ends. Yielding every ~12ms
   * of work turns that freeze into an interruptible background task: the
   * page stays responsive and animated the entire time.
   *
   * Returns false if a newer seek superseded this one mid-flight (the
   * caller should treat that as "abandoned", not "reached the target").
   */
  async _seekWasmTo(targetSamples) {
    const generation = ++this._seekGeneration;
    this._seekingCount = (this._seekingCount || 0) + 1;
    try {
      const { exp, outPtr, chunkFrames } = this;
      exp.msgs_reset();
      this.voiceHistory.length = 0;
      let rendered = 0;
      let lastYield = performance.now();
      while (rendered < targetSamples && !exp.msgs_is_finished()) {
        const want = Math.min(chunkFrames, targetSamples - rendered);
        const n = exp.msgs_render(outPtr, want) >>> 0;
        if (n === 0) break;
        rendered += n;
        if (performance.now() - lastYield > 12) {
          await new Promise((resolve) => setTimeout(resolve, 0));
          if (generation !== this._seekGeneration) return false;
          lastYield = performance.now();
        }
      }
      return generation === this._seekGeneration;
    } finally {
      this._seekingCount--;
    }
  }

  /** True while any seek/resume discard-render is in flight -- the UI can
   * use this to show a "seeking" state during a long jump instead of
   * looking like nothing is happening. */
  get seeking() {
    return (this._seekingCount || 0) > 0;
  }

  /**
   * Stops the scheduled source chain under a short gain fade rather than a
   * hard cut, so whatever sample discontinuity sits at the splice point
   * (pause point, seek target, mute/solo swap) is inaudible. Returns the
   * ctx time at which the fade reaches true silence -- a caller that is
   * about to resume immediately (seek) must not start the new material
   * before that instant, or the old (still-fading) and new (fading-in)
   * source chains briefly sound together, which is its own audible glitch.
   * The sources themselves are scheduled to stop once the fade completes;
   * bookkeeping is cleared immediately since nothing else needs them after
   * this call.
   */
  _fadeOutAndStop() {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    let silenceAt = 0;
    if (this.ctx && this.gain) {
      const now = this.ctx.currentTime;
      silenceAt = now + FADE_SECONDS;
      const g = this.gain.gain;
      g.cancelScheduledValues(now);
      g.setValueAtTime(g.value, now);
      g.linearRampToValueAtTime(0, silenceAt);
      for (const src of this.sources) {
        try { src.stop(silenceAt); } catch (_) { /* already stopped */ }
      }
    } else {
      for (const src of this.sources) {
        try { src.stop(); } catch (_) { /* already stopped */ }
      }
    }
    this.sources = [];
    return silenceAt;
  }

  /** Current audible playback position, independent of render lookahead. */
  getPositionSec() {
    if (!this.playing) return this.basePositionSamples / this.sampleRate;
    // playStartCtxTime can be a few ms in the future right after a seek
    // (the coordinated silence gap before the new chain starts); clamp so
    // that brief window reads as "still at the seek target", not negative.
    const elapsed = Math.max(0, this.ctx.currentTime - this.playStartCtxTime);
    return this.basePositionSamples / this.sampleRate + elapsed;
  }

  /**
   * @param {number} [startAt] ctx time to begin audible playback at. Omit
   * for an ordinary play/resume with no preceding fade (starts "now" with
   * its own independent fade-in). Pass the value `_fadeOutAndStop` returned
   * to chain cleanly after it: the new chain then starts exactly when the
   * old one reaches silence, instead of overlapping it mid-fade.
   */
  async play(startAt) {
    if (!this.songLoaded || this.playing) return;
    this._ensureContext();

    // Every play() attempt gets its own id; any await below re-checks it
    // and bails if a newer attempt has since started. Without this, a
    // call stuck waiting on a blocked resume() and a later call (e.g. the
    // user loading a different file, or clicking play again) both run to
    // completion once the block eventually clears, each independently
    // resetting the engine and starting its own render timer -- two
    // uncoordinated playback loops fighting over one wasm instance.
    const myAttempt = (this._playAttemptId = (this._playAttemptId || 0) + 1);

    const resumed = await this._resumeContextWithTimeout();
    if (myAttempt !== this._playAttemptId) return; // superseded while waiting
    if (!resumed) {
      const blocked = new Error("audio playback was blocked by the browser -- click to retry");
      blocked.code = "audio-blocked";
      throw blocked;
    }

    const reached = await this._seekWasmTo(Math.round(this.basePositionSamples));
    if (myAttempt !== this._playAttemptId) return; // superseded while catching up
    if (!reached) return; // a newer seek/play superseded this one while we were catching up

    const now = this.ctx.currentTime;
    const at = Math.max(startAt || 0, now);
    this.playing = true;
    this.playStartCtxTime = at;
    this.nextStartTime = at;

    // Fade in from silence rather than starting at full volume -- masks
    // any discontinuity right at the resume point the same way the
    // matching fade-out on pause/seek masks the other side of the splice.
    const g = this.gain.gain;
    if (!startAt) {
      // No coordinated fade-out precedes this call (cold start, or resuming
      // well after a prior pause) -- safe to reset the gain curve outright.
      g.cancelScheduledValues(now);
      g.setValueAtTime(0, now);
    }
    // Otherwise gain is already riding _fadeOutAndStop's ramp down to 0,
    // landing exactly at `at`; anchor there and ramp up from that same
    // point rather than cancelling a ramp that hasn't finished yet.
    g.setValueAtTime(0, at);
    g.linearRampToValueAtTime(this.targetGain, at + FADE_SECONDS);

    const token = (this._token = (this._token || 0) + 1);
    this._pump(token);
    this.timer = setInterval(() => this._pump(token), TOPUP_INTERVAL_MS);
  }

  pause() {
    if (!this.playing) return;
    const posSamples = this.getPositionSec() * this.sampleRate;
    this._fadeOutAndStop();
    this.basePositionSamples = Math.max(0, posSamples);
    this.playing = false;
  }

  async seek(sec) {
    const clamped = Math.max(0, Math.min(sec, this.durationSec));
    const wasPlaying = this.playing;
    const resumeAt = wasPlaying ? this._fadeOutAndStop() : 0;
    this.basePositionSamples = clamped * this.sampleRate;
    this.playing = false;
    if (wasPlaying) await this.play(resumeAt);
  }

  _pump(token) {
    if (token !== this._token) return;
    const { ctx, exp, outPtr, sampleRate } = this;
    if (!ctx || !exp) return;

    if (this.nextStartTime < ctx.currentTime) this.nextStartTime = ctx.currentTime;

    while (this.nextStartTime - ctx.currentTime < LOOKAHEAD_SECONDS) {
      // The song position this about-to-be-rendered chunk starts at, in the
      // same terms getPositionSec() uses -- needed to tag the voice-history
      // sample below with a position the UI can actually look up later.
      const chunkStartSongSec = this.basePositionSamples / sampleRate + (this.nextStartTime - this.playStartCtxTime);
      const n = exp.msgs_render(outPtr, this.chunkFrames) >>> 0;
      if (n > 0) {
        const pcm = new Int16Array(exp.memory.buffer, outPtr, n * 2);
        const buf = ctx.createBuffer(2, n, sampleRate);
        const l = buf.getChannelData(0);
        const r = buf.getChannelData(1);
        for (let i = 0; i < n; i++) {
          l[i] = pcm[2 * i] / 32768;
          r[i] = pcm[2 * i + 1] / 32768;
        }
        const node = ctx.createBufferSource();
        node.buffer = buf;
        node.connect(this.gain);
        node.start(this.nextStartTime);
        node.onended = () => {
          const idx = this.sources.indexOf(node);
          if (idx !== -1) this.sources.splice(idx, 1);
        };
        this.sources.push(node);
        this.nextStartTime += n / sampleRate;

        // Real engine voice state (release tails, voice-stealing and all)
        // at the instant this chunk finished rendering, tagged with the
        // song position it corresponds to -- not "now", which is still
        // LOOKAHEAD_SECONDS in the future relative to what's audible. See
        // getActiveVoiceCountAt.
        if (typeof exp.msgs_debug_active_count === "function") {
          this.voiceHistory.push({
            sec: chunkStartSongSec + n / sampleRate,
            count: exp.msgs_debug_active_count() >>> 0,
          });
          if (this.voiceHistory.length > 500) this.voiceHistory.shift();
        }
      }

      if (n === 0 || exp.msgs_is_finished()) {
        if (this.loop) {
          exp.msgs_reset();
          this.voiceHistory.length = 0;
          this.basePositionSamples = 0;
          this.playStartCtxTime = this.nextStartTime;
          continue;
        } else {
          clearInterval(this.timer);
          this.timer = null;
          this.playing = false;
          // A track that finishes on its own resets to the start, same as
          // ordinary media players: without this, basePositionSamples is
          // still wherever this run started from (e.g. a seek target from
          // earlier in the session), so pressing play again would resume
          // from that stale spot instead of actually replaying the song.
          this.basePositionSamples = 0;
          if (this.onEnded) this.onEnded();
          return;
        }
      }
    }
  }
}

SlopgsSynth.MAX_VOICES = MAX_VOICES;
SlopgsSynth.MIN_CHUNK_SECONDS = MIN_CHUNK_SECONDS;
SlopgsSynth.MAX_CHUNK_SECONDS = MAX_CHUNK_SECONDS;
SlopgsSynth.DEFAULT_CHUNK_SECONDS = DEFAULT_CHUNK_SECONDS;
window.SlopgsSynth = SlopgsSynth;

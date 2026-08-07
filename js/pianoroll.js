/* pianoroll.js -- vertical falling-note canvas renderer.
 *
 * Notes fall top-to-bottom (Synthesia-style, not the horizontal-scroll
 * convention of a literal 2000s DAW piano roll) and strike a keyboard strip
 * near the bottom. A note's bar spans [noteOn Y, noteOff Y] and slides
 * through the strike line as one rigid piece, matching how a sustain
 * actually reads: part of the bar is "not yet due" above the line, part is
 * "currently sounding" below it, until the bar's tail clears the line at
 * note-off. Per-channel pitch bend nudges a note's x while it is visible,
 * same channel-wide wobble Synthesia shows on its keyboard.
 */
"use strict";

// The standard 88-key range -- what's shown for the overwhelming majority
// of files. A minority (chiptune/tracker-authored MIDI in particular) use
// note numbers outside it as arbitrary pitch/percussion slots with no
// piano-range convention in mind at all; setData widens lowKey/highKey
// (never narrows below this) to whatever the loaded file actually uses, so
// those notes render instead of silently vanishing off both edges.
const STANDARD_LOW_KEY = 21;   // A0
const STANDARD_HIGH_KEY = 108; // C8
// How many seconds of "not yet triggered" material are visible above the
// strike line -- this is the roll's scroll speed, just expressed as a time
// window rather than a px/sec rate: a smaller window means the same
// physical distance covers less time, i.e. notes fall faster. Adjustable at
// runtime via setLookaheadSec (see the sidebar's Roll speed control).
const DEFAULT_LOOKAHEAD_SEC = 3.0;
const MIN_LOOKAHEAD_SEC = 1.25;
const MAX_LOOKAHEAD_SEC = 6.0;
const IMPACT_Y_FRACTION = 0.82;
const STRIKE_STRIP_PX = 30;
const BEND_RANGE_SEMITONES = 2;
const BURST_LIFETIME_MS = 320;

const CHANNEL_HUES = [206, 42, 150, 350, 265, 20, 190, 100, 320, null, 60, 230, 10, 170, 290, 80];
const DRUM_CHANNEL = 9;
// Matches .channel-row.is-silenced's opacity in styles.css -- one dimming
// amount for "this channel is muted (or not the soloed one)" everywhere it
// shows up, sidebar and roll alike.
const MUTED_ALPHA_SCALE = 0.32;

function channelColor(ch, alpha = 1, variant = "solid") {
  const fill = variant === "fill";
  if (ch === DRUM_CHANNEL) return fill ? `hsla(0, 0%, 42%, ${alpha})` : `hsla(0, 0%, 68%, ${alpha})`;
  const hue = CHANNEL_HUES[ch % 16];
  return fill ? `hsla(${hue}, 45%, 42%, ${alpha})` : `hsla(${hue}, 68%, 60%, ${alpha})`;
}

// A note's own velocity (how hard it was struck) reads as transparency: a
// ppp grace note and a fff hit on the same key and channel should look
// different at a glance, not just sound different. The border stays more
// consistently legible than the fill across the velocity range so a very
// soft note still has a readable outline, not just a near-invisible smear.
function velocityAlpha(velocity) {
  const v = Math.max(0, Math.min(127, velocity)) / 127;
  return { fill: 0.22 + v * 0.63, border: 0.55 + v * 0.4 };
}

function isBlackKey(midiKey) {
  return [1, 3, 6, 8, 10].includes(midiKey % 12);
}

class PianoRoll {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.data = null; // { notes, programChanges, pitchBends, channelsUsed, durationSec }
    this.getTimeSec = () => 0;
    this.lookaheadSec = DEFAULT_LOOKAHEAD_SEC;
    this.longNotes = [];
    this.lowKey = STANDARD_LOW_KEY;
    this.highKey = STANDARD_HIGH_KEY;
    this.keyCount = STANDARD_HIGH_KEY - STANDARD_LOW_KEY + 1;
    // Channels that shouldn't read as "sounding" right now -- explicit
    // mutes, or (when any channel is soloed) everything that isn't it. Set
    // from app.js's own effectiveMutedChannels(), same source of truth the
    // sidebar and the actual audio patching use, so all three always agree.
    this.mutedChannels = new Set();
    this.dpr = Math.max(1, window.devicePixelRatio || 1);
    this.bursts = []; // { key, x, colorCh, firedAt }
    this._firedNoteBursts = new WeakSet();
    this._raf = null;
    this._resizeObserver = new ResizeObserver(() => this._resize());
    this._resizeObserver.observe(canvas);
    this._resize();
  }

  setData(data) {
    this.data = data;
    this.bursts.length = 0;
    this._firedNoteBursts = new WeakSet();
    this.mutedChannels = new Set(); // a freshly loaded file starts with nothing muted/soloed
    this._recomputeLongNotes();

    let dataLow = STANDARD_LOW_KEY, dataHigh = STANDARD_HIGH_KEY;
    for (const n of data.notes) {
      if (n.key < dataLow) dataLow = n.key;
      if (n.key > dataHigh) dataHigh = n.key;
    }
    this.lowKey = Math.min(STANDARD_LOW_KEY, dataLow);
    this.highKey = Math.max(STANDARD_HIGH_KEY, dataHigh);
    this.keyCount = this.highKey - this.lowKey + 1;
  }

  clearData() {
    this.data = null;
    this.bursts.length = 0;
    this.lowKey = STANDARD_LOW_KEY;
    this.highKey = STANDARD_HIGH_KEY;
    this.keyCount = STANDARD_HIGH_KEY - STANDARD_LOW_KEY + 1;
  }

  // Notes held longer than the lookahead window need a separate list: the
  // main loop finds visible notes by binary-searching for startSec close to
  // "now", which is correct for anything shorter than the window (an older
  // short note is guaranteed to have already ended) but wrong for a long
  // sustain -- one held for 10s while the window is 3s would fall out of
  // that search entirely partway through and vanish mid-note. Long notes are
  // the rare case in real music, so scanning this list in full every frame
  // costs nothing; it is never more than a small fraction of the total.
  // Depends on lookaheadSec, so this reruns whenever that changes too, not
  // just on a new file load.
  _recomputeLongNotes() {
    this.longNotes = this.data ? this.data.notes.filter((n) => n.endSec - n.startSec > this.lookaheadSec) : [];
  }

  /** Adjusts scroll speed by widening/narrowing the lookahead window (see
   * DEFAULT_LOOKAHEAD_SEC). Takes effect on the next drawn frame. */
  setLookaheadSec(sec) {
    const clamped = Math.max(MIN_LOOKAHEAD_SEC, Math.min(MAX_LOOKAHEAD_SEC, sec));
    if (clamped === this.lookaheadSec) return;
    this.lookaheadSec = clamped;
    this._recomputeLongNotes();
  }

  /** @param {Set<number>} channels channels to render dimmed (muted, or
   * everything-but-the-soloed-one) -- takes effect on the next drawn
   * frame, no redraw needs triggering since _draw already runs every
   * frame via the rAF loop in start(). */
  setMutedChannels(channels) {
    this.mutedChannels = channels || new Set();
  }

  _resize() {
    const rect = this.canvas.getBoundingClientRect();
    this.canvas.width = Math.max(1, Math.round(rect.width * this.dpr));
    this.canvas.height = Math.max(1, Math.round(rect.height * this.dpr));
    this.cssWidth = rect.width;
    this.cssHeight = rect.height;
  }

  start(getTimeSec) {
    this.getTimeSec = getTimeSec;
    const loop = () => {
      this._draw();
      this._raf = requestAnimationFrame(loop);
    };
    this._raf = requestAnimationFrame(loop);
  }

  stop() {
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = null;
  }

  _keyX(midiKey) {
    const t = (midiKey - this.lowKey) / this.keyCount;
    return t * this.cssWidth;
  }

  _colWidth() {
    return this.cssWidth / this.keyCount;
  }

  _draw() {
    const { ctx, dpr, cssWidth, cssHeight } = this;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssWidth, cssHeight);

    const impactY = cssHeight * IMPACT_Y_FRACTION;
    const stripH = Math.min(STRIKE_STRIP_PX, cssHeight - impactY);
    const floorY = impactY + stripH; // the keyboard's own bottom edge -- notes must not visually pass it
    this._drawKeyboardBackground(impactY);

    if (!this.data) {
      this._drawStrikeStrip(impactY, stripH, null);
      return;
    }

    const t = this.getTimeSec();
    const pxPerSec = impactY / this.lookaheadSec;
    const colWidth = this._colWidth();
    if (this.data.barTimes) this._drawBarLines(t, pxPerSec, impactY);
    const bendCache = new Map(); // channel -> px offset at time t

    const bendOffset = (channel) => {
      if (bendCache.has(channel)) return bendCache.get(channel);
      const ev = window.SlopgsMidi.valueAt(this.data.pitchBends.get(channel), t, null);
      const px = ev ? ev.value * BEND_RANGE_SEMITONES * colWidth : 0;
      bendCache.set(channel, px);
      return px;
    };

    const soundingKeys = new Map(); // midiKey -> channel (last wins, fine for a strike light)

    const drawNote = (note) => {
      if (note.endSec < t) return;
      if (note.key < this.lowKey || note.key > this.highKey) return;

      const topY = impactY - (note.endSec - t) * pxPerSec;
      // Clamp to the keyboard's own floor: a held note visually stops right
      // at the keys, it never bleeds into the empty space below them.
      const bottomY = Math.min(impactY - (note.startSec - t) * pxPerSec, floorY);
      if (bottomY < 0 || topY > floorY) return;

      const x = this._keyX(note.key) + bendOffset(note.channel);
      const w = Math.max(2, colWidth - 1.5);
      const h = Math.max(3, bottomY - topY);
      const alpha = velocityAlpha(note.velocity);
      const dim = this.mutedChannels.has(note.channel) ? MUTED_ALPHA_SCALE : 1;

      ctx.fillStyle = channelColor(note.channel, alpha.fill * dim, "fill");
      ctx.fillRect(x, topY, w, h);
      ctx.strokeStyle = channelColor(note.channel, alpha.border * dim);
      ctx.lineWidth = 1;
      ctx.strokeRect(x + 0.5, topY + 0.5, w - 1, Math.max(1, h - 1));

      if (t >= note.startSec && t <= note.endSec) {
        soundingKeys.set(note.key, note.channel);
        // A muted hit still lights the key (dimmed, below) so the roll
        // still reads as "this note fired" -- it just doesn't get the
        // celebratory spark an audible one does.
        if (dim === 1 && !this._firedNoteBursts.has(note)) {
          this._firedNoteBursts.add(note);
          this.bursts.push({ key: note.key, channel: note.channel, x: this._keyX(note.key) + colWidth / 2, firedAt: performance.now() });
        }
      }
    };

    // Binary-search the first (short) note that could be visible, rather
    // than scanning from index 0 every frame: for a long, dense file (tens
    // of thousands of notes), a from-the-start rescan gets more expensive
    // the deeper into the song playback goes. This is correct for a note
    // whose duration fits within the lookahead window -- one that started
    // further back than that is guaranteed to have already ended -- which
    // is why notes held longer than the window are excluded here and drawn
    // from the separate longNotes list below instead.
    const notes = this.data.notes;
    const threshold = t - this.lookaheadSec;
    let lo = 0, hi = notes.length - 1, startIdx = notes.length;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (notes[mid].startSec >= threshold) { startIdx = mid; hi = mid - 1; }
      else lo = mid + 1;
    }

    for (let i = startIdx; i < notes.length; i++) {
      const note = notes[i];
      if (note.startSec - this.lookaheadSec > t) break; // notes[] is time-sorted; nothing further is visible yet
      if (note.endSec - note.startSec > this.lookaheadSec) continue; // handled below
      drawNote(note);
    }

    // Same visibility window as the short notes above (fall in from the top
    // starting lookaheadSec before they're due), not just "while sounding" --
    // the latter was the bug: a long note would pop into existence exactly
    // at its note-on with no preceding fall, instead of approaching like
    // everything else (e.g. reported against "Transcendental.mid", whose
    // very first note is a 27s pad well past the lookahead window).
    for (const note of this.longNotes) {
      if (note.startSec - this.lookaheadSec > t || note.endSec < t) continue;
      drawNote(note);
    }

    this._drawBursts(impactY);
    this._drawStrikeStrip(impactY, stripH, soundingKeys);
  }

  /**
   * Bar/measure guide lines, falling in from the top on the same schedule as
   * notes -- barTimes comes straight from midi.js's tempo/time-signature
   * walk, so these line up with the transport's own bar counter. The last
   * entry in barTimes is an end-of-song marker rather than a real bar
   * start, so the loop stops one short of it.
   */
  _drawBarLines(t, pxPerSec, impactY) {
    const { ctx, cssWidth } = this;
    const barTimes = this.data.barTimes;
    const totalBars = barTimes.length - 1;
    if (totalBars <= 0) return;

    let lo = 0, hi = totalBars - 1, startIdx = totalBars;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (barTimes[mid] >= t - 0.001) { startIdx = mid; hi = mid - 1; }
      else lo = mid + 1;
    }

    ctx.lineWidth = 1;
    ctx.font = "600 9px 'Space Mono', ui-monospace, monospace";
    ctx.textBaseline = "alphabetic";
    for (let i = startIdx; i < totalBars; i++) {
      const y = impactY - (barTimes[i] - t) * pxPerSec;
      if (y < -20) break; // barTimes is ascending -- everything after this is further off the top too
      const yr = Math.round(y) + 0.5;
      ctx.strokeStyle = "rgba(255,255,255,0.09)";
      ctx.beginPath();
      ctx.moveTo(0, yr);
      ctx.lineTo(cssWidth, yr);
      ctx.stroke();
      if (y < impactY - 10) {
        ctx.fillStyle = "rgba(255,255,255,0.3)";
        ctx.fillText(String(i + 1), 4, y - 3);
      }
    }
  }

  _drawKeyboardBackground(impactY) {
    const { ctx } = this;
    const colWidth = this._colWidth();
    for (let k = this.lowKey; k <= this.highKey; k++) {
      const x = this._keyX(k);
      ctx.fillStyle = isBlackKey(k) ? "rgba(255,255,255,0.02)" : "rgba(255,255,255,0.005)";
      ctx.fillRect(x, 0, colWidth, impactY);
    }
    // octave guide lines at each C
    ctx.strokeStyle = "rgba(255,255,255,0.05)";
    ctx.lineWidth = 1;
    for (let k = this.lowKey; k <= this.highKey; k++) {
      if (k % 12 === 0) {
        const x = Math.round(this._keyX(k)) + 0.5;
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, impactY);
        ctx.stroke();
      }
    }
  }

  _drawStrikeStrip(impactY, stripH, soundingKeys) {
    const { ctx, cssWidth } = this;
    const colWidth = this._colWidth();

    ctx.fillStyle = "rgba(0,0,0,0.35)";
    ctx.fillRect(0, impactY, cssWidth, stripH);

    ctx.strokeStyle = "rgba(232,197,71,0.9)"; // amber strike line
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, impactY + 0.5);
    ctx.lineTo(cssWidth, impactY + 0.5);
    ctx.stroke();

    ctx.font = "700 8px 'Space Mono', ui-monospace, monospace";
    ctx.textAlign = "center";
    for (let k = this.lowKey; k <= this.highKey; k++) {
      const x = this._keyX(k);
      const black = isBlackKey(k);
      const lit = soundingKeys && soundingKeys.get(k);
      let fill = black ? "rgba(20,22,26,0.9)" : "rgba(230,230,230,0.12)";
      if (lit !== undefined && lit !== null) {
        const dim = this.mutedChannels.has(lit) ? MUTED_ALPHA_SCALE : 1;
        fill = channelColor(lit, 0.95 * dim);
      }
      ctx.fillStyle = fill;
      const keyH = black ? stripH * 0.62 : stripH * 0.92;
      ctx.fillRect(x + 0.5, impactY + stripH - keyH, colWidth - 1, keyH);

      // Octave marker -- C keys only (every other white key would just be
      // noise at this width); MIDI note 60 = C4 is the convention this
      // matches (per STANDARD_LOW_KEY/STANDARD_HIGH_KEY's own A0/C8 comments above).
      if (k % 12 === 0) {
        ctx.fillStyle = (lit !== undefined && lit !== null) ? "rgba(20,22,26,0.75)" : "rgba(255,255,255,0.4)";
        ctx.fillText(`C${Math.floor(k / 12) - 1}`, x + colWidth / 2, impactY + stripH - 4);
      }
    }
    ctx.textAlign = "left";
  }

  _drawBursts(impactY) {
    const { ctx } = this;
    const now = performance.now();
    this.bursts = this.bursts.filter((b) => now - b.firedAt < BURST_LIFETIME_MS);
    for (const b of this.bursts) {
      const life = (now - b.firedAt) / BURST_LIFETIME_MS; // 0..1
      const radius = 3 + life * 16;
      const alpha = 1 - life;
      const spokes = 6;
      ctx.strokeStyle = channelColor(b.channel, alpha * 0.8);
      ctx.lineWidth = 2;
      for (let s = 0; s < spokes; s++) {
        const angle = (s / spokes) * Math.PI * 2 + Math.PI / 2;
        const inner = radius * 0.35;
        ctx.beginPath();
        ctx.moveTo(b.x + Math.cos(angle) * inner, impactY + Math.sin(angle) * inner);
        ctx.lineTo(b.x + Math.cos(angle) * radius, impactY + Math.sin(angle) * radius);
        ctx.stroke();
      }
    }
  }
}

PianoRoll.DEFAULT_LOOKAHEAD_SEC = DEFAULT_LOOKAHEAD_SEC;
PianoRoll.MIN_LOOKAHEAD_SEC = MIN_LOOKAHEAD_SEC;
PianoRoll.MAX_LOOKAHEAD_SEC = MAX_LOOKAHEAD_SEC;
window.SlopgsPianoRoll = PianoRoll;

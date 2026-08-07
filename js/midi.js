/* midi.js -- Standard MIDI File parser.
 *
 * Mirrors the tick -> seconds conversion slopgs's own src/engine/smf.c does
 * (tempo map walk, division/SMPTE handling) so the piano roll's timeline
 * lines up with what msgs.wasm actually renders. Produces flat, time-sorted
 * note/program-change/pitch-bend lists a canvas renderer can binary-search.
 */
"use strict";

const GM_INSTRUMENTS = [
  "Acoustic Grand Piano", "Bright Acoustic Piano", "Electric Grand Piano", "Honky-tonk Piano",
  "Electric Piano 1", "Electric Piano 2", "Harpsichord", "Clavinet",
  "Celesta", "Glockenspiel", "Music Box", "Vibraphone",
  "Marimba", "Xylophone", "Tubular Bells", "Dulcimer",
  "Drawbar Organ", "Percussive Organ", "Rock Organ", "Church Organ",
  "Reed Organ", "Accordion", "Harmonica", "Tango Accordion",
  "Acoustic Guitar (nylon)", "Acoustic Guitar (steel)", "Electric Guitar (jazz)", "Electric Guitar (clean)",
  "Electric Guitar (muted)", "Overdriven Guitar", "Distortion Guitar", "Guitar Harmonics",
  "Acoustic Bass", "Electric Bass (finger)", "Electric Bass (pick)", "Fretless Bass",
  "Slap Bass 1", "Slap Bass 2", "Synth Bass 1", "Synth Bass 2",
  "Violin", "Viola", "Cello", "Contrabass",
  "Tremolo Strings", "Pizzicato Strings", "Orchestral Harp", "Timpani",
  "String Ensemble 1", "String Ensemble 2", "Synth Strings 1", "Synth Strings 2",
  "Choir Aahs", "Voice Oohs", "Synth Voice", "Orchestra Hit",
  "Trumpet", "Trombone", "Tuba", "Muted Trumpet",
  "French Horn", "Brass Section", "Synth Brass 1", "Synth Brass 2",
  "Soprano Sax", "Alto Sax", "Tenor Sax", "Baritone Sax",
  "Oboe", "English Horn", "Bassoon", "Clarinet",
  "Piccolo", "Flute", "Recorder", "Pan Flute",
  "Blown Bottle", "Shakuhachi", "Whistle", "Ocarina",
  "Lead 1 (square)", "Lead 2 (sawtooth)", "Lead 3 (calliope)", "Lead 4 (chiff)",
  "Lead 5 (charang)", "Lead 6 (voice)", "Lead 7 (fifths)", "Lead 8 (bass + lead)",
  "Pad 1 (new age)", "Pad 2 (warm)", "Pad 3 (polysynth)", "Pad 4 (choir)",
  "Pad 5 (bowed)", "Pad 6 (metallic)", "Pad 7 (halo)", "Pad 8 (sweep)",
  "FX 1 (rain)", "FX 2 (soundtrack)", "FX 3 (crystal)", "FX 4 (atmosphere)",
  "FX 5 (brightness)", "FX 6 (goblins)", "FX 7 (echoes)", "FX 8 (sci-fi)",
  "Sitar", "Banjo", "Shamisen", "Koto",
  "Kalimba", "Bagpipe", "Fiddle", "Shanai",
  "Tinkle Bell", "Agogo", "Steel Drums", "Woodblock",
  "Taiko Drum", "Melodic Tom", "Synth Drum", "Reverse Cymbal",
  "Guitar Fret Noise", "Breath Noise", "Seashore", "Bird Tweet",
  "Telephone Ring", "Helicopter", "Applause", "Gunshot",
];

// Roland GS-style drum kit selection: on the drum channel, a Program Change
// picks which *kit* sounds rather than an instrument -- General MIDI Level 1
// itself defines only one kit ("Standard"), but the GS extension slopgs/
// swmidi.sys emulates lets a file switch kits with the same message a melodic
// channel would use to switch instruments. No bank-select tracking needed:
// on GS hardware (and this emulation) the drum channel's own Program Change
// value alone selects the kit.
const GS_DRUM_KITS = {
  0: "Standard Drum Kit", 1: "Standard Drum Kit",
  8: "Room Drum Kit", 16: "Power Drum Kit",
  24: "Electronic Drum Kit", 25: "TR-808 Drum Kit",
  32: "Jazz Drum Kit", 40: "Brush Drum Kit",
  48: "Orchestra Drum Kit", 56: "SFX Drum Kit",
  127: "CM-64/CM-32L Drum Kit",
};

function gmDrumKitName(program) {
  return GS_DRUM_KITS[program & 0x7f] || `Drum Kit ${program}`;
}

/**
 * Named capital-tone variations for melodic instruments -- a Bank Select
 * MSB (CC0) sent before a Program Change doesn't pick a different
 * instrument family, it picks an alternate voicing of the *same* program
 * slot (e.g. program 80 "Lead 1" at bank 0 is "Square Wave", but at bank 8
 * it's "Sine Wave" -- a genuinely different waveform under the same GM
 * name). Keyed "program:bankMSB"; bank 0 is the GM default and isn't
 * listed here since GM_INSTRUMENTS already names it. slopgs's DLS engine
 * (src/engine/dls.c) really does resolve this bank/program/drum locale
 * against regions in the loaded gm.dls, so a bank switch is audible, not
 * cosmetic -- see vendor/slopgs's SPEC.adoc S2.8/S3.1.
 *
 * Sourced from vendor/slopgs/artifacts/probes/gm_dls_inventory.tsv, names
 * slopgs itself extracted from the reference gm.dls's own DLS instrument
 * headers used to validate this engine. That's specifically the standard
 * Windows gm.dls lineage this product is about -- a user-supplied gm.dls
 * from a different source could carry different (or no) variations at a
 * given bank number; an unlisted bank falls back to a plain number rather
 * than guessing a name for it (see gmInstrumentName).
 */
const BANK_VARIATIONS = {
  "0:8": "Piano 1", "0:16": "Piano 1d",
  "1:8": "Piano 2",
  "2:8": "Piano 3",
  "3:8": "Honky-tonk",
  "4:8": "Detuned EP 1", "4:16": "E.Piano 1v", "4:24": "60's E.Piano",
  "5:8": "Detuned EP 2", "5:16": "E.Piano 2v",
  "6:8": "Coupled Hps.", "6:16": "Harpsichord", "6:24": "Harpsi.o",
  "11:8": "Vibraphone",
  "12:8": "Marimba",
  "14:8": "Church Bell", "14:9": "Carillon",
  "16:8": "Detuned Or.1", "16:16": "60's Organ 1", "16:32": "Organ 4",
  "17:8": "Detuned Or.2", "17:32": "Organ 5",
  "19:8": "Church Org.2", "19:16": "Church Org.3",
  "21:8": "Accordion It",
  "24:8": "Ukulele", "24:16": "Nylon Gt.o", "24:32": "Nylon Gt.2",
  "25:8": "12-str.Gt", "25:16": "Mandolin",
  "26:8": "Hawaiian Gt.",
  "27:8": "Chorus Gt.",
  "28:8": "Funk Gt.", "28:16": "Funk Gt.2",
  "30:8": "Feedback Gt.",
  "31:8": "Gt. Feedback",
  "38:1": "SynthBass101", "38:8": "Synth Bass 3",
  "39:8": "Synth Bass 4", "39:16": "Rubber Bass",
  "40:8": "Slow Violin",
  "48:8": "Orchestra",
  "50:8": "Syn.Strings3",
  "52:32": "Choir Aahs 2",
  "57:1": "Trombone 2",
  "60:1": "Fr.Horn 2",
  "61:8": "Brass 2",
  "62:8": "Synth Brass3", "62:16": "AnalogBrass1",
  "63:8": "Synth Brass4", "63:16": "AnalogBrass2",
  "80:1": "Square", "80:8": "Sine Wave",
  "81:1": "Saw", "81:8": "Doctor Solo",
  "98:1": "Syn Mallet",
  "102:1": "Echo Bell", "102:2": "Echo Pan",
  "104:1": "Sitar 2",
  "107:8": "Taisho Koto",
  "115:8": "Castanets",
  "116:8": "Concert BD",
  "117:8": "Melo. Tom 2",
  "118:8": "808 Tom", "118:9": "Elec Perc.",
  "120:1": "Gt.Cut Noise", "120:2": "String Slap",
  "121:1": "Fl.Key Click",
  "122:1": "Rain", "122:2": "Thunder", "122:3": "Wind", "122:4": "Stream", "122:5": "Bubble",
  "123:1": "Dog", "123:2": "Horse-Gallop", "123:3": "Bird 2",
  "124:1": "Telephone 2", "124:2": "DoorCreaking", "124:3": "Door", "124:4": "Scratch", "124:5": "Wind Chimes",
  "125:1": "Car-Engine", "125:2": "Car-Stop", "125:3": "Car-Pass", "125:4": "Car-Crash", "125:5": "Siren",
  "125:6": "Train", "125:7": "Jetplane", "125:8": "Starship", "125:9": "Burst Noise",
  "126:1": "Laughing", "126:2": "Screaming", "126:3": "Punch", "126:4": "Heart Beat", "126:5": "Footsteps",
  "127:1": "Machine Gun", "127:2": "Lasergun", "127:3": "Explosion",
};

function gmInstrumentName(program, isDrumChannel, bankMSB) {
  if (isDrumChannel) return gmDrumKitName(program);
  const prog = program & 0x7f;
  const base = GM_INSTRUMENTS[prog] || `Program ${program}`;
  const bank = bankMSB || 0;
  if (bank === 0) return base;
  const variation = BANK_VARIATIONS[`${prog}:${bank}`];
  return variation || `${base} (bank ${bank})`;
}

// General MIDI percussion key map (channel 10), standard range 27-81.
// [short chip label, full name]
const GM_PERCUSSION = {
  27: ["HQ", "High Q"], 28: ["SLP", "Slap"], 29: ["SPH", "Scratch Push"], 30: ["SPL", "Scratch Pull"],
  31: ["STK", "Sticks"], 32: ["SQC", "Square Click"], 33: ["MT1", "Metronome Click"], 34: ["MT2", "Metronome Bell"],
  35: ["BD2", "Acoustic Bass Drum"], 36: ["BD1", "Bass Drum 1"], 37: ["SST", "Side Stick"], 38: ["SN1", "Acoustic Snare"],
  39: ["CLP", "Hand Clap"], 40: ["SN2", "Electric Snare"], 41: ["FT2", "Low Floor Tom"], 42: ["CHH", "Closed Hi-Hat"],
  43: ["FT1", "High Floor Tom"], 44: ["PHH", "Pedal Hi-Hat"], 45: ["LT2", "Low Tom"], 46: ["OHH", "Open Hi-Hat"],
  47: ["LT1", "Low-Mid Tom"], 48: ["HT2", "Hi-Mid Tom"], 49: ["CR1", "Crash Cymbal 1"], 50: ["HT1", "High Tom"],
  51: ["RD1", "Ride Cymbal 1"], 52: ["CHC", "Chinese Cymbal"], 53: ["RBL", "Ride Bell"], 54: ["TAM", "Tambourine"],
  55: ["SPC", "Splash Cymbal"], 56: ["CBL", "Cowbell"], 57: ["CR2", "Crash Cymbal 2"], 58: ["VSL", "Vibraslap"],
  59: ["RD2", "Ride Cymbal 2"], 60: ["HBG", "Hi Bongo"], 61: ["LBG", "Low Bongo"], 62: ["MHC", "Mute Hi Conga"],
  63: ["OHC", "Open Hi Conga"], 64: ["LCG", "Low Conga"], 65: ["HTB", "High Timbale"], 66: ["LTB", "Low Timbale"],
  67: ["HAG", "High Agogo"], 68: ["LAG", "Low Agogo"], 69: ["CAB", "Cabasa"], 70: ["MAR", "Maracas"],
  71: ["SWH", "Short Whistle"], 72: ["LWH", "Long Whistle"], 73: ["SGU", "Short Guiro"], 74: ["LGU", "Long Guiro"],
  75: ["CLA", "Claves"], 76: ["HWB", "Hi Wood Block"], 77: ["LWB", "Low Wood Block"], 78: ["MCU", "Mute Cuica"],
  79: ["OCU", "Open Cuica"], 80: ["MTR", "Mute Triangle"], 81: ["OTR", "Open Triangle"],
};

function gmPercussionLabel(key) {
  const entry = GM_PERCUSSION[key];
  return entry ? entry[0] : `#${key}`;
}
function gmPercussionName(key) {
  const entry = GM_PERCUSSION[key];
  return entry ? entry[1] : `Note ${key}`;
}

/**
 * A byte sequence "looks like" Shift-JIS only if it contains at least one
 * genuine double-byte pair (lead byte 0x81-0x9F/0xE0-0xFC followed by a
 * valid trail byte). Lone high bytes with no such pairing are far more
 * likely Windows-1252 -- accented Western text (c.f. disco-polo/Polish
 * MIDI packs, full of "Copyright \xA9 ...") shows up constantly in this
 * corpus, and single bytes like 0xA9 decode "successfully" but wrongly as
 * Shift-JIS halfwidth katakana if not gated behind this check.
 */
function looksLikeShiftJisBytes(bytes) {
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    const isLead = (b >= 0x81 && b <= 0x9f) || (b >= 0xe0 && b <= 0xfc);
    if (!isLead) continue;
    const trail = bytes[i + 1];
    if (trail !== undefined && ((trail >= 0x40 && trail <= 0x7e) || (trail >= 0x80 && trail <= 0xfc))) {
      return true;
    }
  }
  return false;
}

/**
 * Meta-text bytes have no declared encoding -- the spec says ASCII, real
 * files don't agree. Try UTF-8 first (correct for the plain-ASCII majority
 * and any modern UTF-8 file); if that produces mojibake (U+FFFD), the
 * corpus this was tested against splits between Shift-JIS (Japanese-scene
 * BMS/BotB-adjacent files, old doujin sequences) and Windows-1252
 * (Western European packs) -- looksLikeShiftJisBytes decides which to try,
 * with Windows-1252 as the catch-all since it has no undecodable bytes.
 * Untrimmed: most callers want decodeMetaText below, which trims for
 * display, but lyric events (see parseMidiFile's lyricLines) need their
 * whitespace -- a bare "\r" or a trailing space marking a word's end is
 * exactly what a trim would throw away.
 */
function decodeMetaBytes(bytes) {
  const utf8 = new TextDecoder("utf-8").decode(bytes);
  if (!utf8.includes("�")) return utf8;
  if (looksLikeShiftJisBytes(bytes)) {
    try {
      const sjis = new TextDecoder("shift-jis").decode(bytes);
      if (!sjis.includes("�")) return sjis;
    } catch {
      // shift-jis decoder unsupported in this environment -- fall through
    }
  }
  try {
    return new TextDecoder("windows-1252").decode(bytes);
  } catch {
    return utf8;
  }
}

function decodeMetaText(bytes) {
  return decodeMetaBytes(bytes).trim();
}

function readVLQ(bytes, pos) {
  let value = 0;
  let b;
  do {
    b = bytes[pos.i++];
    value = (value << 7) | (b & 0x7f);
  } while (b & 0x80);
  return value >>> 0;
}

function walkTrack(bytes, start, len, emit) {
  const end = start + len;
  const pos = { i: start };
  let absTick = 0;
  let runningStatus = 0;

  while (pos.i < end) {
    absTick += readVLQ(bytes, pos);
    if (pos.i >= end) break;
    let b = bytes[pos.i];

    if (b === 0xff) {
      pos.i++;
      const type = bytes[pos.i++];
      const mlen = readVLQ(bytes, pos);
      if (type === 0x51 && mlen === 3) {
        const usec = (bytes[pos.i] << 16) | (bytes[pos.i + 1] << 8) | bytes[pos.i + 2];
        emit(absTick, { kind: "tempo", usec });
      } else if (type === 0x58 && mlen === 4) {
        emit(absTick, {
          kind: "timesig",
          numerator: bytes[pos.i],
          denominator: 1 << bytes[pos.i + 1],
        });
      } else if ((type === 0x01 || type === 0x02 || type === 0x03 || type === 0x05 || type === 0x06) && mlen > 0) {
        // Text, Copyright, TrackName, Lyric, Marker -- the meta types that
        // carry human-readable content worth surfacing in the UI. Kept as a
        // raw byte view (no copy); decodeMetaText/decodeMetaBytes handle
        // the encoding.
        emit(absTick, { kind: "metatext", metaType: type, data: bytes.subarray(pos.i, pos.i + mlen) });
      }
      pos.i += mlen;
    } else if (b === 0xf0 || b === 0xf7) {
      pos.i++;
      const slen = readVLQ(bytes, pos);
      pos.i += slen;
    } else {
      let status;
      if (b & 0x80) {
        status = b;
        runningStatus = b;
        pos.i++;
      } else {
        status = runningStatus;
      }
      const kind = status & 0xf0;
      const d1 = bytes[pos.i++];
      const hasD2 = kind !== 0xc0 && kind !== 0xd0;
      const d2Offset = hasD2 ? pos.i : -1;
      const d2 = hasD2 ? bytes[pos.i++] : 0;
      emit(absTick, { kind: "midi", status, d1, d2, d2Offset });
    }
  }
}

function readU32BE(bytes, i) {
  return ((bytes[i] << 24) | (bytes[i + 1] << 16) | (bytes[i + 2] << 8) | bytes[i + 3]) >>> 0;
}
function readU16BE(bytes, i) {
  return (bytes[i] << 8) | bytes[i + 1];
}
function fourccIs(bytes, i, s) {
  return bytes[i] === s.charCodeAt(0) && bytes[i + 1] === s.charCodeAt(1) &&
    bytes[i + 2] === s.charCodeAt(2) && bytes[i + 3] === s.charCodeAt(3);
}

/** tick -> seconds using a sorted list of {tick, sec, usPerTick} checkpoints. */
function tickToSecFromCheckpoints(checkpoints, tick) {
  let lo = 0, hi = checkpoints.length - 1, ans = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (checkpoints[mid].tick <= tick) { ans = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  const cp = checkpoints[ans];
  return cp.sec + (tick - cp.tick) * cp.usPerTick / 1_000_000;
}

/** Bar-start times (seconds), derived from time-signature + tempo maps -- default 4/4 when the file names none. */
function computeBarTimes(timeSigEvents, totalTicks, divisionQ, tempoCheckpoints) {
  const sigs = timeSigEvents.slice().sort((a, b) => a.tick - b.tick);
  if (sigs.length === 0 || sigs[0].tick > 0) {
    sigs.unshift({ tick: 0, numerator: 4, denominator: 4 });
  }

  const barTicks = [];
  for (let i = 0; i < sigs.length; i++) {
    const segStart = sigs[i].tick;
    const segEnd = i + 1 < sigs.length ? sigs[i + 1].tick : totalTicks;
    const ticksPerBar = sigs[i].numerator * (divisionQ * 4 / sigs[i].denominator);
    if (!(ticksPerBar > 0)) continue;
    let tick = segStart;
    let guard = 0;
    while (tick < segEnd && guard++ < 200_000) {
      barTicks.push(tick);
      tick += ticksPerBar;
    }
  }
  if (barTicks.length === 0 || barTicks[barTicks.length - 1] < totalTicks) barTicks.push(totalTicks);

  return barTicks.map((t) => tickToSecFromCheckpoints(tempoCheckpoints, t));
}

/**
 * @returns {{
 *   durationSec: number,
 *   notes: Array<{channel:number,key:number,velocity:number,startSec:number,endSec:number}>,
 *   programChanges: Map<number, Array<{atSec:number, program:number}>>,
 *   pitchBends: Map<number, Array<{atSec:number, value:number}>>,
 *   channelsUsed: Set<number>,
 *   barTimes: number[],
 *   noteOnVelocityOffsets: Map<number, number[]>,
 *   channelVolumes: Map<number, Array<{atSec:number, value:number}>>,
 *   channelBanks: Map<number, Array<{atSec:number, value:number}>>,
 *   channelPans: Map<number, Array<{atSec:number, value:number}>>,
 *   title: string|null,
 *   copyright: string|null,
 *   text: string|null,
 *   markers: Array<{atSec:number, text:string}>,
 *   lyricLines: Array<{atSec:number, text:string}>,
 * }}
 */
function parseMidiFile(bytes) {
  if (bytes.length < 14 || !fourccIs(bytes, 0, "MThd")) {
    throw new Error("not a Standard MIDI File (missing MThd header)");
  }
  const hdrLen = readU32BE(bytes, 4);
  const format = readU16BE(bytes, 8);
  const division = readU16BE(bytes, 12);
  const ntracks = readU16BE(bytes, 10);

  let p = 8 + hdrLen;
  const tracks = [];
  for (let t = 0; t < ntracks && p + 8 <= bytes.length; t++) {
    if (!fourccIs(bytes, p, "MTrk")) break;
    const tlen = readU32BE(bytes, p + 4);
    tracks.push({ start: p + 8, len: tlen });
    p = p + 8 + tlen;
  }

  // Pass 1: flatten every track into one (absTick, seq, event) list, tagging
  // each event with its track index so ties break in file order, same as
  // smf.c's per-track sequence numbers.
  const events = [];
  let seq = 0;
  for (let trackIndex = 0; trackIndex < tracks.length; trackIndex++) {
    const track = tracks[trackIndex];
    walkTrack(bytes, track.start, track.len, (absTick, e) => {
      events.push({ absTick, seq: seq++, trackIndex, ...e });
    });
  }
  events.sort((a, b) => (a.absTick - b.absTick) || (a.seq - b.seq));

  // Pass 2: tick -> seconds, exactly mirroring smf.c's smpte/PPQ branches.
  const smpte = (division & 0x8000) !== 0;
  let ticksPerSecond = 0;
  if (smpte) {
    let fps = -((division >> 8) << 24 >> 24); // sign-extend the top byte
    if (fps <= 0) fps = 30;
    const tpf = division & 0xff;
    ticksPerSecond = fps * tpf;
  }
  const divisionQ = smpte ? 1 : (division & 0x7fff) || 24;

  let timeAccum = 0;
  let lastTick = 0;
  let curTempo = 500000;

  const notes = [];
  const programChanges = new Map();
  const pitchBends = new Map();
  const channelsUsed = new Set();
  const pending = new Map(); // `${channel}:${key}` -> stack of open note-ons
  const noteOnVelocityOffsets = new Map(); // channel -> byte offsets of note-on velocity bytes (mute/solo patching)
  const channelVolumes = new Map(); // channel -> [{atSec, value}], value 0..1 from CC7 (channel volume)
  const channelBanks = new Map(); // channel -> [{atSec, value}], value 0..127 from CC0 (bank select MSB)
  const channelPans = new Map(); // channel -> [{atSec, value}], value -1..1 from CC10 (pan), 0 = center
  const timeSigEvents = [];
  const tempoCheckpoints = [{ tick: 0, sec: 0, usPerTick: 500000 / divisionQ }];

  // Metadata surfaced in the UI between the piano roll and the transport.
  // Scoped to what real-world files actually carry (see decodeMetaText's
  // sibling scan of ~9600 files): TrackName is near-universal (85.7%),
  // Copyright and Text both sit around 2.4%, Marker under 1%. Lyric was
  // effectively absent from that general scan too -- but a targeted scan of
  // two karaoke-oriented packs (MIDI DISCO POLO, Rzadko spotykane MIDI: 820
  // files) found it in 782 of them (95%), so it earns support despite being
  // rare in MIDI at large. CuePoint remains skipped: still unseen anywhere.
  let title = null;
  let copyright = null;
  let textNote = null;
  const markers = [];

  // Lyric (0x05) events are per-syllable, not per-line -- a karaoke file
  // sings "Sto" then "je " as two events, meant to read as one word "Stoje"
  // (trailing spaces mark word ends; the events carry no line breaks of
  // their own beyond an embedded \r or \n). These get concatenated into
  // whole lines here as they're walked, each line timestamped to whenever
  // its first syllable actually starts -- see lyricLines below and
  // updateLyrics in app.js, which just needs to find "the line active at
  // time t" the same way it already does for markers.
  let lyricBuffer = "";
  let lyricLineStartSec = null;
  const lyricLines = [];
  function flushLyricLine() {
    const text = lyricBuffer.trim();
    if (text) lyricLines.push({ atSec: lyricLineStartSec ?? 0, text });
    lyricBuffer = "";
    lyricLineStartSec = null;
  }

  for (const e of events) {
    const deltaTicks = e.absTick - lastTick;
    if (smpte) {
      timeAccum = e.absTick / ticksPerSecond;
    } else {
      const secondsPerTick = (curTempo / 1_000_000) / divisionQ;
      timeAccum += deltaTicks * secondsPerTick;
    }
    lastTick = e.absTick;
    const atSec = timeAccum;

    if (e.kind === "tempo") {
      curTempo = e.usec;
      tempoCheckpoints.push({ tick: e.absTick, sec: atSec, usPerTick: curTempo / divisionQ });
      continue;
    }
    if (e.kind === "timesig") {
      timeSigEvents.push({ tick: e.absTick, numerator: e.numerator, denominator: e.denominator });
      continue;
    }
    if (e.kind === "metatext") {
      if (e.metaType === 0x05) {
        // Lyric: not trimmed like the rest (see decodeMetaBytes) -- a break
        // may be its own whole event ("\r" and nothing else), which a trim
        // would erase before flushLyricLine ever saw it.
        const raw = decodeMetaBytes(e.data);
        const segments = raw.split(/[\r\n]+/);
        for (let i = 0; i < segments.length; i++) {
          if (i > 0) flushLyricLine(); // a break preceded this segment
          if (segments[i]) {
            if (lyricLineStartSec === null) lyricLineStartSec = atSec;
            lyricBuffer += segments[i];
          }
        }
        continue;
      }
      const text = decodeMetaText(e.data);
      if (text) {
        if (e.metaType === 0x03) {
          // TrackName: per the SMF spec this is the *sequence* name only in
          // the first track (format 0's only track, or format 1's tempo
          // track) -- elsewhere it names an instrument/part, not the song.
          if (e.trackIndex === 0 && title === null) title = text;
        } else if (e.metaType === 0x02) {
          if (copyright === null) copyright = text;
        } else if (e.metaType === 0x01) {
          if (textNote === null && text !== title) textNote = text;
        } else if (e.metaType === 0x06) {
          markers.push({ atSec, text });
        }
      }
      continue;
    }

    const type = e.status & 0xf0;
    const channel = e.status & 0x0f;

    if (type === 0x90 || type === 0x80) {
      channelsUsed.add(channel);
      const key = e.d1;
      const velocity = e.d2;
      const noteOn = type === 0x90 && velocity > 0;
      const stackKey = `${channel}:${key}`;
      if (noteOn) {
        if (!pending.has(stackKey)) pending.set(stackKey, []);
        pending.get(stackKey).push({ channel, key, velocity, startSec: atSec });
        if (!noteOnVelocityOffsets.has(channel)) noteOnVelocityOffsets.set(channel, []);
        noteOnVelocityOffsets.get(channel).push(e.d2Offset);
      } else {
        const stack = pending.get(stackKey);
        const open = stack && stack.shift();
        if (open) {
          open.endSec = atSec;
          notes.push(open);
        }
      }
    } else if (type === 0xc0) {
      channelsUsed.add(channel);
      if (!programChanges.has(channel)) programChanges.set(channel, []);
      programChanges.get(channel).push({ atSec, program: e.d1 });
    } else if (type === 0xe0) {
      channelsUsed.add(channel);
      const raw = ((e.d2 << 7) | e.d1) - 8192; // -8192..8191, 0 = center
      if (!pitchBends.has(channel)) pitchBends.set(channel, []);
      pitchBends.get(channel).push({ atSec, value: raw / 8192 });
    } else if (type === 0xb0 && e.d1 === 7) {
      // Controller 7 = Channel Volume, the mixer-fader level GM/GS gives
      // each channel (distinct from a note's own velocity). GM's default
      // when a file never sends one is 100, not 127 -- see valueAt's
      // fallback where this map is read.
      channelsUsed.add(channel);
      if (!channelVolumes.has(channel)) channelVolumes.set(channel, []);
      channelVolumes.get(channel).push({ atSec, value: e.d2 / 127 });
    } else if (type === 0xb0 && e.d1 === 0) {
      // Controller 0 = Bank Select MSB -- picks a capital-tone variation of
      // whatever program comes next (see gmInstrumentName/BANK_VARIATIONS),
      // not tracked per note-on, just as a live value read back at display
      // time same as channel volume above. Bank Select LSB (CC32) is not
      // tracked: the reference gm.dls this table comes from never uses it
      // (bankLSB == 0 for all 235 instruments).
      channelsUsed.add(channel);
      if (!channelBanks.has(channel)) channelBanks.set(channel, []);
      channelBanks.get(channel).push({ atSec, value: e.d2 });
    } else if (type === 0xb0 && e.d1 === 10) {
      // Controller 10 = Pan. GM center is 64, not 0 or 127's midpoint by
      // symmetry -- (raw-64)/64 puts hard left at -1, center at exactly 0,
      // hard right at 127's own slightly-short-of-1 (0.984), the same
      // 7-bit asymmetry every other bipolar CC/pitch-bend value here has.
      channelsUsed.add(channel);
      if (!channelPans.has(channel)) channelPans.set(channel, []);
      channelPans.get(channel).push({ atSec, value: (e.d2 - 64) / 64 });
    }
  }
  flushLyricLine(); // catches a trailing line with no closing break -- common at EOF

  // Any note-on left without a matching note-off (malformed/truncated file):
  // close it at the last event's time rather than dropping it silently.
  const tailSec = timeAccum;
  for (const stack of pending.values()) {
    for (const open of stack) {
      open.endSec = Math.max(open.endSec ?? tailSec, tailSec);
      notes.push(open);
    }
  }
  notes.sort((a, b) => a.startSec - b.startSec);
  for (const list of programChanges.values()) list.sort((a, b) => a.atSec - b.atSec);
  for (const list of pitchBends.values()) list.sort((a, b) => a.atSec - b.atSec);
  for (const list of channelVolumes.values()) list.sort((a, b) => a.atSec - b.atSec);
  for (const list of channelBanks.values()) list.sort((a, b) => a.atSec - b.atSec);
  for (const list of channelPans.values()) list.sort((a, b) => a.atSec - b.atSec);

  let durationSec = tailSec;
  for (const n of notes) durationSec = Math.max(durationSec, n.endSec);

  const barTimes = smpte
    ? [0, durationSec] // no PPQ tempo map to derive bars from; snapping degrades to start/end only
    : computeBarTimes(timeSigEvents, lastTick, divisionQ, tempoCheckpoints);

  return {
    durationSec, notes, programChanges, pitchBends, channelsUsed, barTimes,
    noteOnVelocityOffsets, channelVolumes, channelBanks, channelPans,
    title, copyright, text: textNote, markers, lyricLines,
  };
}

/** Nearest bar-start time to `targetSec`, for seek-quantization. */
function nearestBarTime(barTimes, targetSec) {
  if (!barTimes || barTimes.length === 0) return targetSec;
  let lo = 0, hi = barTimes.length - 1, ans = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (barTimes[mid] <= targetSec) { ans = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  const lower = barTimes[ans];
  const upper = barTimes[Math.min(ans + 1, barTimes.length - 1)];
  return targetSec - lower <= upper - targetSec ? lower : upper;
}

/** Active (most recent <= atSec) value from a time-sorted list, or fallback. */
function valueAt(list, atSec, fallback) {
  if (!list || list.length === 0) return fallback;
  let lo = 0, hi = list.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid].atSec <= atSec) { ans = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  return ans === -1 ? fallback : list[ans];
}

// General MIDI's specified default channel volume when a file never sends
// a CC7 -- 100, not the controller's max of 127.
const GM_DEFAULT_CHANNEL_VOLUME = 100 / 127;

window.SlopgsMidi = {
  parseMidiFile, gmInstrumentName, valueAt, nearestBarTime, GM_INSTRUMENTS,
  gmPercussionLabel, gmPercussionName, GM_DEFAULT_CHANNEL_VOLUME,
};

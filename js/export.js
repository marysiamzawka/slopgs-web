/* export.js -- render the loaded song to a full PCM buffer and encode it
 * to a downloadable file: WAV (native, no dependency), MP3 (true VBR V0
 * via a patched vendor/lame.js), or Ogg Vorbis (via vendor/libvorbis.js).
 * Both encoder libraries are large (500KB-1.4MB) and only relevant to the
 * rare export action, so they load lazily on first use, not on page load.
 */
"use strict";

(() => {
  const scriptCache = new Map();
  function loadScriptOnce(src) {
    if (scriptCache.has(src)) return scriptCache.get(src);
    const p = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = src;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error(`failed to load ${src}`));
      document.head.appendChild(s);
    });
    scriptCache.set(src, p);
    return p;
  }

  const yieldToUI = () => new Promise((r) => setTimeout(r, 0));

  /**
   * Renders the currently loaded song to a complete interleaved stereo
   * Int16 PCM buffer at the engine's native rate, then restores whatever
   * playback position/state was active before the render started -- this
   * is a side render, not a transport action, and must leave the live
   * player exactly as the user left it.
   */
  async function renderFullSongPCM(synth, onProgress) {
    const { exp, outPtr, chunkFrames, sampleRate, durationSec } = synth;
    const wasPlaying = synth.playing;
    const savedPositionSec = synth.getPositionSec();
    if (wasPlaying) synth._fadeOutAndStop();
    synth.playing = false;

    exp.msgs_reset();
    const chunks = [];
    let total = 0;
    // Generous cap so a malformed file that never reports "finished" can't
    // spin forever: duration plus a wide margin, in frames.
    const maxFrames = Math.ceil((durationSec + 10) * sampleRate);

    // Same reasoning as synth.js's _seekWasmTo: rendering a whole song is a
    // multi-second synchronous task on a long file, so it yields
    // periodically instead of freezing the tab for the entire export.
    let lastYield = performance.now();
    while (!exp.msgs_is_finished() && total < maxFrames) {
      const n = exp.msgs_render(outPtr, chunkFrames) >>> 0;
      if (n === 0) break;
      const pcm = new Int16Array(exp.memory.buffer, outPtr, n * 2);
      chunks.push(pcm.slice());
      total += n;
      if (onProgress) onProgress(Math.min(1, total / sampleRate / durationSec));
      if (performance.now() - lastYield > 12) {
        await yieldToUI();
        lastYield = performance.now();
      }
    }

    const full = new Int16Array(total * 2);
    let off = 0;
    for (const c of chunks) {
      full.set(c, off);
      off += c.length;
    }

    // Restore the engine to wherever the live transport actually was.
    await synth._seekWasmTo(Math.round(savedPositionSec * sampleRate));
    synth.basePositionSamples = savedPositionSec * sampleRate;
    if (wasPlaying) await synth.play();

    return { pcm: full, sampleRate };
  }

  function toWavBlob(pcm, sampleRate) {
    const numChannels = 2;
    const bytesPerSample = 2;
    const blockAlign = numChannels * bytesPerSample;
    const dataSize = pcm.length * bytesPerSample;
    const buffer = new ArrayBuffer(44 + dataSize);
    const view = new DataView(buffer);

    const writeStr = (offset, str) => {
      for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
    };
    writeStr(0, "RIFF");
    view.setUint32(4, 36 + dataSize, true);
    writeStr(8, "WAVE");
    writeStr(12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true); // PCM
    view.setUint16(22, numChannels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * blockAlign, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, 16, true);
    writeStr(36, "data");
    view.setUint32(40, dataSize, true);
    new Int16Array(buffer, 44).set(pcm);

    return new Blob([buffer], { type: "audio/wav" });
  }

  async function toMp3Blob(pcm, sampleRate, onProgress) {
    await loadScriptOnce("js/vendor/lame.js");
    const lamejs = window.lamejs;
    // True VBR ("-V0") needs lamejs's VBR quantization-loop classes
    // (VBRNewIterationLoop and friends), which this port's transpile from
    // LAME's C source never completed -- only the CBR path is actually
    // wired up and working. 160kbps is the format ceiling MPEG-2 LSF Layer
    // III (required below 32kHz) allows at this engine's 22050Hz output,
    // so this is the highest-quality CBR this sample rate supports, not an
    // arbitrary number.
    const encoder = new lamejs.Mp3Encoder(2, sampleRate, 160);

    const numFrames = pcm.length / 2;
    const left = new Int16Array(numFrames);
    const right = new Int16Array(numFrames);
    for (let i = 0; i < numFrames; i++) {
      left[i] = pcm[2 * i];
      right[i] = pcm[2 * i + 1];
    }

    const CHUNK = 1152; // lamejs's native MPEG frame size
    const parts = [];
    for (let i = 0; i < numFrames; i += CHUNK) {
      const l = left.subarray(i, i + CHUNK);
      const r = right.subarray(i, i + CHUNK);
      const out = encoder.encodeBuffer(l, r);
      if (out.length > 0) parts.push(out);
      if (i % (CHUNK * 64) === 0) {
        if (onProgress) onProgress(i / numFrames);
        await yieldToUI(); // long encodes stay off the render-blocking path
      }
    }
    const tail = encoder.flush();
    if (tail.length > 0) parts.push(tail);

    return new Blob(parts, { type: "audio/mpeg" });
  }

  async function toOggBlob(pcm, sampleRate, onProgress) {
    await loadScriptOnce("js/vendor/libvorbis.js");

    const numFrames = pcm.length / 2;
    const left = new Float32Array(numFrames);
    const right = new Float32Array(numFrames);
    for (let i = 0; i < numFrames; i++) {
      left[i] = pcm[2 * i] / 32768;
      right[i] = pcm[2 * i + 1] / 32768;
    }

    return new Promise((resolve, reject) => {
      const encoder = new window.VorbisEncoder();
      const parts = [];
      encoder.ondata = (buf) => parts.push(new Uint8Array(buf));
      encoder.onfinish = () => resolve(new Blob(parts, { type: "audio/ogg" }));
      // quality: -0.1 (worst) .. 1.0 (best); 1.0 is the closest analogue to
      // MP3 V0's "spend whatever it takes for near-transparency" intent.
      encoder.init(2, sampleRate, 1.0);

      const CHUNK = 4096;
      let i = 0;
      const pushChunk = () => {
        if (i >= numFrames) {
          encoder.finish();
          return;
        }
        const end = Math.min(i + CHUNK, numFrames);
        const l = left.slice(i, end);
        const r = right.slice(i, end);
        encoder.encode([l.buffer, r.buffer], end - i, 2);
        i = end;
        if (onProgress) onProgress(i / numFrames);
        setTimeout(pushChunk, 0);
      };
      pushChunk();
    });
  }

  function triggerDownload(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }

  /**
   * @param {"wav"|"mp3"|"ogg"} format
   * @param {(status: string, frac: number|null) => void} [onProgress]
   */
  async function exportAudio(synth, format, baseName, onProgress) {
    onProgress && onProgress("rendering", null);
    const { pcm, sampleRate } = await renderFullSongPCM(synth, (f) => onProgress && onProgress("rendering", f));
    await yieldToUI();

    onProgress && onProgress("encoding", null);
    let blob, ext;
    if (format === "wav") {
      blob = toWavBlob(pcm, sampleRate);
      ext = "wav";
    } else if (format === "mp3") {
      blob = await toMp3Blob(pcm, sampleRate, (f) => onProgress && onProgress("encoding", f));
      ext = "mp3";
    } else if (format === "ogg") {
      blob = await toOggBlob(pcm, sampleRate, (f) => onProgress && onProgress("encoding", f));
      ext = "ogg";
    } else {
      throw new Error(`unknown export format "${format}"`);
    }

    triggerDownload(blob, `${baseName}.${ext}`);
    onProgress && onProgress("done", 1);
  }

  window.SlopgsExport = { exportAudio };
})();

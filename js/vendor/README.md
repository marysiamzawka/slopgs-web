# Vendored encoders

Loaded lazily by `js/export.js`, only when the user actually exports MP3 or OGG -- not on page load.

- **lame.js** -- [zhuker/lamejs](https://github.com/zhuker/lamejs) 1.2.1, LGPL-3.0, unmodified. Used via its public `Mp3Encoder(channels, sampleRate, kbps)` CBR API at 160kbps -- the MPEG-2 LSF Layer III ceiling for a 22050Hz source, i.e. the highest-quality CBR this sample rate supports. True VBR ("-V0") was attempted and reverted: this port's transpile from LAME's C source never completed the VBR quantization-loop classes (`VBRNewIterationLoop`, `VBROldIterationLoop`, `ABRIterationLoop` are referenced but not defined anywhere in the file), so `lame_init_params()` throws partway through for any VBR preset. Patching around a gap that size risked shipping subtly-wrong audio to chase a label; CBR at this format's real ceiling is the honest option.
- **libvorbis.js** -- [Garciat/libvorbis.js](https://github.com/Garciat/libvorbis.js) 1.1.2 (minified build as published), BSD (Xiph.org). Unmodified. This one's VBR is real (`_encoder_create_vbr`, quality 1.0 = highest) -- it's a full Emscripten build of actual libvorbis, not a partial hand-transpile.

# Mediabunny recording audio support

`mediabunny@1.61.6.patch` adds lossless packet passthrough for G.722, G.711 μ-law (PCMU) and A-law (PCMA) in Matroska. The dependency is pinned so an update cannot silently discard this support.

- Matroska uses `A_MS/ACM` with an 18-byte `WAVEFORMATEX` header; payload bytes are unchanged. G.722 uses the FFmpeg/VLC ACM tag `0x028f`, 16 kHz mono, 64 kbit/s. G.711 uses tags `7`/`6`, 8-bit samples.
- The demuxer recognizes those tags (and the legacy G.722 tag `0x0065`). This supports packet inspection, seek metadata and remuxing without an encoder.
- MP4/MOV/WebM do not advertise the added G.722 capability. The application selects MKV automatically for these audio codecs, or retains the audio fallback for explicit MP4.
- The patch includes the library sources, public ESM/CommonJS entry points and declarations. It adds no G.722 encoder or decoder. Codec byte preservation and pause/resume are tested in `apps/web/test/unit/recording-encoded-audio.test.ts`.

Mapping: [Matroska codec specifications](https://www.matroska.org/technical/codec_specs.html#a_msacm). G.722 RTP clocks: [RFC 3551 section 4.5.2](https://www.rfc-editor.org/rfc/rfc3551.html#section-4.5.2).

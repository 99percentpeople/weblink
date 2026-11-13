# Mediabunny 录制音频支持

`mediabunny@1.61.6.patch` 为 Matroska 添加 G.722、G.711 μ-law（PCMU）和 A-law（PCMA）的无损包直通支持。依赖版本固定，避免更新时静默丢失此能力。

- Matroska 使用 `A_MS/ACM` 和 18 字节 `WAVEFORMATEX` 头，载荷字节保持不变。G.722 使用 FFmpeg/VLC ACM 标签 `0x028f`，16 kHz 单声道，64 kbit/s；G.711 使用标签 `7`/`6` 和 8-bit 采样。
- 解复用器识别这些标签及旧 G.722 标签 `0x0065`，支持无编码器的包检查、seek 元数据及重新封装。
- MP4/MOV/WebM 不声明新增 G.722 能力。应用对这些音频格式自动选择 MKV；显式选择 MP4 时保留音频后备路径。
- 补丁包含库源码、公开 ESM/CommonJS 入口和声明，不添加 G.722 编码器或解码器。编解码器字节保真及暂停/恢复由 `apps/web/test/unit/recording-encoded-audio.test.ts` 测试。

映射规则：[Matroska 编解码器规范](https://www.matroska.org/technical/codec_specs.html#a_msacm)。G.722 RTP 时钟：[RFC 3551 第 4.5.2 节](https://www.rfc-editor.org/rfc/rfc3551.html#section-4.5.2)。

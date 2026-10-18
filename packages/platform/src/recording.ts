/** Encoded access units before RTP packetization, shared by browser and native sources. */
export interface EncodedVideoPacket {
  data: ArrayBuffer;
  type: "key" | "delta";
  timestamp: number;
  /** Browser RTP defaults to 90 kHz; native audio/video share a microsecond clock. */
  timestampScale?: 90000 | 1000000;
  /** Shared media clock in milliseconds (capture, or receiver delivery), shared by paired audio/video tracks. */
  clockTime?: number;
  mimeType: string;
  width: number;
  height: number;
  ssrc: number;
  spatialIndex: number;
  segment: number;
}

export interface RecordingAudioFormat {
  sampleRate: number;
  channelCount: number;
}

/** Interleaved signed 16-bit little-endian samples on the native video clock. */
export interface RecordingAudioPacket extends RecordingAudioFormat {
  data: ArrayBuffer;
  timestamp: number;
  segment: number;
}

/** A complete RTP audio payload, before decoding (or after sender encoding). */
export interface EncodedAudioPacket extends RecordingAudioFormat {
  data: ArrayBuffer;
  timestamp: number;
  /** RTP timestamp frequency; sampleRate describes the decoded audio. */
  clockRate?: number;
  clockTime?: number;
  mimeType: string;
  ssrc: number;
  segment: number;
}

export interface EncodedMediaConsumer {
  frame(packet: EncodedVideoPacket): void | Promise<void>;
  audio?(
    packet: RecordingAudioPacket,
  ): void | Promise<void>;
  encodedAudio?(
    packet: EncodedAudioPacket,
  ): void | Promise<void>;
  ended(error?: Error): void;
}

export interface EncodedMediaSubscription {
  readonly audioFormat?: RecordingAudioFormat;
  readonly encodedAudio?: boolean;
  pause(): void;
  resume(): void;
  /** Drain accepted callbacks and release only the recording subscription. */
  stop(): Promise<void>;
}

export interface EncodedMediaSource {
  readonly encodedAudio?: boolean;
  subscribe(
    consumer: EncodedMediaConsumer,
    signal?: AbortSignal,
  ):
    | EncodedMediaSubscription
    | null
    | Promise<EncodedMediaSubscription | null>;
}

export const ENCODED_VIDEO_MAX_PENDING = 8 * 1024 * 1024;

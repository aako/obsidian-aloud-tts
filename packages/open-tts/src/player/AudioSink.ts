import { CancellablePromise } from "./CancellablePromise";

export type TrackStatus = "playing" | "paused" | "complete";

export interface DecodedAudioData {
  duration: number;
  length: number;
  numberOfChannels: number;
  sampleRate: number;
  getChannelData(channel: number): Float32Array;
}

export interface AudioSink {
  /**
   * Indicates whether audio should currently be playing. This can be true
   * while playback is stalled waiting for upstream data.
   */
  readonly isPlaying: boolean;

  currentTime: number;
  readonly trackStatus: TrackStatus;
  readonly bufferedStart: number | undefined;
  /** Native output reported waiting/stalled; playback intent may still be true. */
  readonly isPlaybackStalled?: boolean;

  play(): void;
  pause(): void;
  restart(): void;
  /** User-initiated replay from retained native audio, never synthesis. */
  retryBufferedAt?(seconds: number): boolean;
  /** Sanitized native playback state, for a user-initiated diagnostic copy. */
  getPlaybackDiagnostics?(): unknown;
  setRate(rate: number): void;

  clearMedia(): Promise<void>;
  decodeAudioData(audio: ArrayBuffer): Promise<DecodedAudioData>;
  waitForSeeking(): CancellablePromise<void>;
  switchMedia(data: ArrayBuffer): Promise<void>;
  appendMedia(data: ArrayBuffer): Promise<void>;
  mediaComplete(): Promise<void>;
  destroy(): void;
}

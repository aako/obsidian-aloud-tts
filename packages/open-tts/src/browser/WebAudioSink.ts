import * as mobx from "mobx";
import { AudioSink, DecodedAudioData, TrackStatus } from "../player/AudioSink";
import { CancellablePromise } from "../player/CancellablePromise";

type WindowWithManagedMediaSource = Window & {
  ManagedMediaSource?: typeof MediaSource;
};

export class WebAudioSink implements AudioSink {
  _trackStatus: TrackStatus = "paused";

  _completionChecker?: ReturnType<typeof setTimeout> = undefined;
  _lastActivePlayPosition = 0;
  _audio: HTMLAudioElement;
  private _sourceBuffer: SourceBuffer;
  private _objectUrl: string | undefined;
  _isPlaying = false;
  private readonly onAppForeground = (): void => {
    this.lastObservedMediaTime = undefined;
    this.lastMediaProgressAt = undefined;
    this.reconcileNativePlaybackState();
  };
  onPlaybackFailure?: (error: unknown) => void;
  private _isPlaybackStalled = false;
  private stalledAtTime: number | undefined;
  private playbackWatchdog?: ReturnType<typeof setInterval>;
  private lastObservedMediaTime: number | undefined;
  private lastMediaProgressAt: number | undefined;
  private static readonly FOREGROUND_STALL_MS = 18000;
  private static readonly BUFFER_UNDERRUN_MS = 35000;

  /** A frozen native clock with playable audio must never advance a bookmark. */
  private readonly checkPlaybackHealth = (): void => {
    if (!this._isPlaying) {
      if (this.playbackWatchdog) clearInterval(this.playbackWatchdog);
      this.playbackWatchdog = undefined;
    }
    if (document.hidden || !this._isPlaying) {
      this.lastMediaProgressAt = undefined;
      this.lastObservedMediaTime = undefined;
      return;
    }
    if (this._audio.paused) {
      this.reconcileNativePlaybackState();
      return;
    }
    const now = Date.now();
    const time = this._audio.currentTime;
    if (!Number.isFinite(time)) return;
    if (
      this.lastObservedMediaTime == null ||
      this.lastMediaProgressAt == null ||
      Math.abs(time - this.lastObservedMediaTime) > 0.15
    ) {
      this.lastObservedMediaTime = time;
      this.lastMediaProgressAt = now;
      return;
    }
    const buffered = this._sourceBuffer.buffered;
    let bufferedAhead = false;
    for (let index = 0; index < buffered.length; index++) {
      if (time >= buffered.start(index) && time + 0.5 < buffered.end(index)) {
        bufferedAhead = true;
        break;
      }
    }
    const outputShouldAdvance =
      this._isPlaybackStalled || (bufferedAhead && this._audio.readyState >= 3);
    const limit = outputShouldAdvance
      ? WebAudioSink.FOREGROUND_STALL_MS
      : WebAudioSink.BUFFER_UNDERRUN_MS;
    if (now - this.lastMediaProgressAt < limit) return;
    this.pause();
    this.onPlaybackFailure?.(
      new Error("Aloud stopped after a prolonged native audio stall."),
    );
  };

  /**
   * A MediaSource `waiting`/`stalled` event means we no longer trust the
   * player clock as proof of audible progress. Intentional playback remains
   * active so iOS may automatically resume when the buffer recovers.
   */
  get isPlaybackStalled(): boolean {
    return this._isPlaybackStalled;
  }

  private resetStall(): void {
    this._isPlaybackStalled = false;
    this.stalledAtTime = undefined;
  }

  private restoreAfterStall(): boolean {
    const from = this.stalledAtTime;
    const now = this._audio.currentTime;
    if (from == null || !Number.isFinite(now) || now - from <= 0.5) return true;

    // The media clock advanced while output was reported stalled. That time
    // cannot be assumed to have been heard. Rewind to the last known point.
    const buffered = this._sourceBuffer.buffered;
    let canReplay = false;
    for (let index = 0; index < buffered.length; index++) {
      if (from >= buffered.start(index) && from < buffered.end(index)) {
        canReplay = true;
        break;
      }
    }

    if (canReplay) {
      try {
        this._audio.currentTime = from;
        return true;
      } catch {
        // A failed native seek is safer to surface than silent text skipping.
      }
    }
    // The previous audio was evicted or native seeking failed. Stop instead
    // of advancing the reading bookmark across unconfirmed output.
    this.pause();
    this.onPlaybackFailure?.(
      new Error(
        "Aloud paused after a stall because unread audio could not be restored.",
      ),
    );
    return false;
  }
  private playGeneration = 0;
  private playPending = false;
  private mediaQueue: Promise<void> = Promise.resolve();

  private enqueueMedia(operation: () => Promise<void>): Promise<void> {
    const pending = this.mediaQueue.then(operation);
    this.mediaQueue = pending.catch(() => undefined);
    return pending;
  }

  get audioElement(): HTMLAudioElement {
    return this._audio;
  }

  get bufferedStart(): number | undefined {
    const buffered = this._sourceBuffer.buffered;
    return buffered.length > 0 ? buffered.start(0) : undefined;
  }

  async decodeAudioData(audio: ArrayBuffer): Promise<DecodedAudioData> {
    const context = new AudioContext();
    try {
      const clonedBuffer = audio.slice(0);
      return await context.decodeAudioData(clonedBuffer);
    } finally {
      await context.close();
    }
  }

  waitForSeeking(): CancellablePromise<void> {
    return CancellablePromise.fromEvent(this._audio, "seeking").thenCancellable(
      () => undefined,
    );
  }

  static async create(): Promise<WebAudioSink> {
    const preferMMS = false;
    const managedMediaSource = (window as WindowWithManagedMediaSource)
      .ManagedMediaSource;
    const sources = preferMMS
      ? [managedMediaSource, window.MediaSource]
      : [window.MediaSource, managedMediaSource];
    const Source = sources.filter((x) => !!x)[0];
    if (!Source) {
      throw new Error("No MediaSource available");
    }
    const audioSource = new Source();
    const audio = new Audio();

    audio.disableRemotePlayback = true;
    audio.controls = true;

    const objectUrl = URL.createObjectURL(audioSource);
    audio.src = objectUrl;
    await once("sourceopen", audioSource);

    const sourceBuffer = audioSource.addSourceBuffer("audio/mpeg");
    await onceBuffUpdateEnd(sourceBuffer);
    const sink = new WebAudioSink(audio, sourceBuffer);
    sink._objectUrl = objectUrl;
    return sink;
  }

  constructor(_audio: HTMLAudioElement, _sourceBuffer: SourceBuffer) {
    this._audio = _audio;
    this._sourceBuffer = _sourceBuffer;
    mobx.makeObservable(this, {
      _trackStatus: mobx.observable,
      _audio: mobx.observable.ref,
      _isPlaying: mobx.observable,
      audioElement: mobx.computed,
      play: mobx.action,
      pause: mobx.action,
      restart: mobx.action,
      trackStatus: mobx.computed,
      isPlaying: mobx.computed,
      _updateTrackStatus: mobx.action,
      _onpause: mobx.action,
      _onplay: mobx.action,
    });
    this._audio.addEventListener("play", this._onplay);
    this._audio.addEventListener("pause", this._onpause);
    this._audio.addEventListener("seeked", this._onseeked);
    for (const event of [
      "playing",
      "waiting",
      "stalled",
      "emptied",
      "ended",
      "error",
    ]) {
      this._audio.addEventListener(event, this._onMediaLifecycle);
    }
    // Keep the dock state accurate even when navigator.mediaSession is absent.
    document.addEventListener("visibilitychange", this.onAppForeground);
    window.addEventListener("pageshow", this.onAppForeground);
    window.addEventListener("focus", this.onAppForeground);
  }

  seek(seconds: number = 1): void {
    this._audio.currentTime = this.audioElement.currentTime + seconds;
  }

  setRate(rate: number): void {
    this._audio.playbackRate = rate;
  }

  get trackStatus(): TrackStatus {
    return this._trackStatus;
  }

  get isPlaying(): boolean {
    return this._isPlaying;
  }

  /**
   * iOS can pause HTML audio from AirPods / lock screen without delivering a
   * JavaScript pause event until WebView returns to foreground. Reconcile its
   * native paused flag; never infer resume from a missing event.
   */
  reconcileNativePlaybackState(): void {
    if (this._audio.paused && (this._isPlaying || this.playPending)) {
      mobx.runInAction(() => this._onpause());
    }
  }

  get currentTime(): number {
    return this._audio.currentTime;
  }

  set currentTime(value: number) {
    this._audio.currentTime = value;
  }

  private getTrackStatus(): TrackStatus {
    const position = this._audio.currentTime;
    const buff = this._sourceBuffer.buffered;
    const lastIndex = buff.length - 1;
    const duration = buff.length > 0 ? buff.end(lastIndex) : undefined;
    let safeMargin = 0;
    if (this._lastActivePlayPosition === position) {
      safeMargin = 0.5;
    } else {
      this._lastActivePlayPosition = position;
    }
    if (this._audio.paused) return "paused";
    if (duration && position >= duration - safeMargin) {
      return "complete";
    }
    return "playing";
  }

  _updateTrackStatus(): void {
    this._trackStatus = this.getTrackStatus();
  }

  switchMedia(data: ArrayBuffer): Promise<void> {
    return this.enqueueMedia(() => this.switchMediaNow(data));
  }

  private async switchMediaNow(data: ArrayBuffer): Promise<void> {
    this.resetStall();
    await onceBuffUpdateEnd(this._sourceBuffer);
    const buffered = this._sourceBuffer.buffered;
    if (buffered.length > 0) {
      const end = buffered.end(buffered.length - 1);
      this._sourceBuffer.remove(0, end);
      this._audio.currentTime = 0;
      await onceBuffUpdateEnd(this._sourceBuffer);
      this._sourceBuffer.timestampOffset = 0;
      await onceBuffUpdateEnd(this._sourceBuffer);
    }
    this._sourceBuffer.appendBuffer(data);
    await onceBuffUpdateEnd(this._sourceBuffer);
    this.loopCheckCompletion();
    this._updateTrackStatus();
  }

  appendMedia(data: ArrayBuffer): Promise<void> {
    return this.enqueueMedia(() => this.appendMediaNow(data));
  }

  private async appendMediaNow(data: ArrayBuffer): Promise<void> {
    await onceBuffUpdateEnd(this._sourceBuffer);
    const buffered = this._sourceBuffer.buffered;
    if (buffered.length > 0) {
      this._sourceBuffer.timestampOffset = buffered.end(buffered.length - 1);
      await onceBuffUpdateEnd(this._sourceBuffer);
    }
    this._sourceBuffer.appendBuffer(data);
    await onceBuffUpdateEnd(this._sourceBuffer);
    await this._evictOldBufferData();
    this.loopCheckCompletion();
    this._updateTrackStatus();
  }

  private static readonly MAX_BUFFER_BEHIND_SECS = 60;

  private async _evictOldBufferData(): Promise<void> {
    try {
      const buffered = this._sourceBuffer.buffered;
      if (buffered.length === 0) return;

      const currentTime = this._audio.currentTime;
      const bufferStart = buffered.start(0);
      const behindAmount = currentTime - bufferStart;

      if (behindAmount > WebAudioSink.MAX_BUFFER_BEHIND_SECS) {
        const removeEnd = currentTime - WebAudioSink.MAX_BUFFER_BEHIND_SECS;
        this._sourceBuffer.remove(bufferStart, removeEnd);
        await onceBuffUpdateEnd(this._sourceBuffer);
      }
    } catch (e) {
      console.warn("Failed to evict old SourceBuffer data:", e);
    }
  }

  async mediaComplete(): Promise<void> {
    this._isPlaying = false;
    this._audio.pause();
  }

  clearMedia(): Promise<void> {
    return this.enqueueMedia(() => this.clearMediaNow());
  }

  private async clearMediaNow(): Promise<void> {
    this.resetStall();
    await onceBuffUpdateEnd(this._sourceBuffer);
    if (this._sourceBuffer.buffered.length > 0) {
      const wasZero = this._audio.currentTime === 0;
      let seekComplete: CancellablePromise<void> | undefined;
      if (!wasZero) {
        const wasSeeking = this._audio.seeking;
        this._audio.currentTime = 0;
        if (!wasSeeking) {
          seekComplete = CancellablePromise.fromEvent(
            this._audio,
            "seeked",
          ).thenCancellable(() => undefined);
        }
      }
      this._sourceBuffer.remove(
        0,
        this._sourceBuffer.buffered.end(this._sourceBuffer.buffered.length - 1),
      );
      await onceBuffUpdateEnd(this._sourceBuffer);
      this._sourceBuffer.timestampOffset = 0;
      await onceBuffUpdateEnd(this._sourceBuffer);
      if (seekComplete) {
        await CancellablePromise.race([
          CancellablePromise.delay(500),
          seekComplete,
        ]);
      }
      this._updateTrackStatus();
    }
    this._sourceBuffer.timestampOffset = 0;
    this._audio.currentTime = 0;
  }

  play(): void {
    if (this.playPending || this._isPlaying) return;
    this.playPending = true;
    const generation = ++this.playGeneration;
    try {
      void this._audio
        .play()
        .then(() => {
          if (generation === this.playGeneration) this.playPending = false;
        })
        .catch((error: unknown) => {
          if (generation !== this.playGeneration) return;
          this.playPending = false;
          mobx.runInAction(() => {
            this._isPlaying = false;
            this._updateTrackStatus();
          });
          this.onPlaybackFailure?.(error);
        });
    } catch (error) {
      this.playPending = false;
      mobx.runInAction(() => {
        this._isPlaying = false;
        this._updateTrackStatus();
      });
      this.onPlaybackFailure?.(error);
    }
  }

  private loopCheckCompletion(): void {
    clearTimeout(this._completionChecker);
    const sb = this._sourceBuffer;
    const audio = this._audio;
    const buff = sb.buffered;
    if (buff.length === 0) {
      return;
    }
    const untilDone = buff.end(buff.length - 1) - audio.currentTime;
    const delay =
      (untilDone < 0.5 ? 100 : untilDone * 1000) /
      (this._audio?.playbackRate || 1);
    this._completionChecker = setTimeout(() => {
      const updated = this.getTrackStatus();
      if (updated !== this._trackStatus) {
        this._updateTrackStatus();
      }
      if (this._trackStatus === "playing") {
        this.loopCheckCompletion();
      }
    }, delay);
  }

  pause(): void {
    ++this.playGeneration;
    this.playPending = false;
    this._audio.pause();
    this._onpause();
  }

  _onplay = (): void => {
    this.lastObservedMediaTime = undefined;
    this.lastMediaProgressAt = undefined;
    if (!this.playbackWatchdog) {
      this.playbackWatchdog = setInterval(this.checkPlaybackHealth, 1000);
    }
    this._updateTrackStatus();
    this.loopCheckCompletion();
    this._isPlaying = true;
  };

  _onpause = (): void => {
    if (this.playbackWatchdog) clearInterval(this.playbackWatchdog);
    this.playbackWatchdog = undefined;
    this.lastObservedMediaTime = undefined;
    this.lastMediaProgressAt = undefined;
    this.resetStall();
    ++this.playGeneration;
    this.playPending = false;
    this._updateTrackStatus();
    clearInterval(this._completionChecker);
    this._isPlaying = false;
  };

  private _onMediaLifecycle = (event: Event): void => {
    if (
      (event.type === "waiting" || event.type === "stalled") &&
      this._isPlaying &&
      !this._isPlaybackStalled
    ) {
      this._isPlaybackStalled = true;
      if (Number.isFinite(this._audio.currentTime))
        this.stalledAtTime = this._audio.currentTime;
    }
    if (event.type === "error" || event.type === "emptied") {
      this.resetStall();
      mobx.runInAction(() => {
        this._isPlaying = false;
        this._updateTrackStatus();
      });
    }
    if (event.type === "playing") {
      if (this._isPlaybackStalled && !this.restoreAfterStall()) return;
      this.resetStall();
      this._updateTrackStatus();
    }
    if (event.type === "error") {
      this.onPlaybackFailure?.(
        this._audio.error ?? new Error("Media element error"),
      );
    }
    if (["stalled", "error", "emptied"].includes(event.type)) {
      console.debug("Aloud audio lifecycle", {
        event: event.type,
        hidden: document.hidden,
      });
    }
  };

  _onseeked = (): void => {
    if (!this._sourceBuffer.buffered.length) {
      this._audio.currentTime = 0;
    } else if (
      this.audioElement.currentTime > this._sourceBuffer.buffered.end(0)
    ) {
      this._audio.currentTime = this._sourceBuffer.buffered.end(0);
    } else if (this._audio.currentTime < this._sourceBuffer.buffered.start(0)) {
      this._audio.currentTime = this._sourceBuffer.buffered.start(0);
    }
    this._updateTrackStatus();
    this.loopCheckCompletion();
  };

  /** Seek and replay only if the sentence is still held in the native buffer. */
  retryBufferedAt(seconds: number): boolean {
    if (!Number.isFinite(seconds)) return false;
    const buffered = this._sourceBuffer.buffered;
    let available = false;
    for (let i = 0; i < buffered.length; i++) {
      if (seconds >= buffered.start(i) && seconds < buffered.end(i) - 0.01) {
        available = true;
        break;
      }
    }
    if (!available) return false;
    this.pause();
    this._audio.currentTime = seconds;
    this.play();
    return true;
  }

  restart(): void {
    this._audio.currentTime = 0;
    this.play();
  }

  destroy(): void {
    if (this.playbackWatchdog) clearInterval(this.playbackWatchdog);
    this.playbackWatchdog = undefined;
    ++this.playGeneration;
    this.playPending = false;
    clearTimeout(this._completionChecker);
    this._audio.removeEventListener("play", this._onplay);
    this._audio.removeEventListener("pause", this._onpause);
    this._audio.removeEventListener("seeked", this._onseeked);
    for (const event of [
      "playing",
      "waiting",
      "stalled",
      "emptied",
      "ended",
      "error",
    ]) {
      this._audio.removeEventListener(event, this._onMediaLifecycle);
    }
    document.removeEventListener("visibilitychange", this.onAppForeground);
    window.removeEventListener("pageshow", this.onAppForeground);
    window.removeEventListener("focus", this.onAppForeground);
    this._audio.pause();
    try {
      if (this._sourceBuffer.buffered.length > 0) {
        this._sourceBuffer.remove(
          0,
          this._sourceBuffer.buffered.end(
            this._sourceBuffer.buffered.length - 1,
          ),
        );
      }
    } catch (_) {
      // MediaSource can already be closing.
    }
    this._audio.removeAttribute("src");
    this._audio.load();
    if (this._objectUrl) {
      URL.revokeObjectURL(this._objectUrl);
      this._objectUrl = undefined;
    }
  }
}

function once<S extends string>(
  event: S,
  emitter: {
    addEventListener: (event: S, listener: () => void) => void;
    removeEventListener: (event: S, listener: () => void) => void;
  },
): Promise<void> {
  return new Promise<void>((resolve) => {
    const listener = () => {
      resolve();
      emitter.removeEventListener(event, listener);
    };
    emitter.addEventListener(event, listener);
  });
}

async function onceBuffUpdateEnd(sb: SourceBuffer): Promise<void> {
  if (sb.updating) {
    await once("updateend", sb);
  }
}

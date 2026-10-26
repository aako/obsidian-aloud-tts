import * as mobx from "mobx";
import type { AudioSink, AudioStore } from "open-tts";

/** Feature-detected Web Media Session integration, not a native iOS audio session. */
export class AloudMediaSession {
  private readonly media: MediaSession | undefined;
  private readonly element: HTMLAudioElement | undefined;
  private disposeReaction?: mobx.IReactionDisposer;
  private oldTrack: object | null = null;
  private playingConfirmed = false;
  private ownedMetadata: MediaMetadata | null = null;
  private ownsSession = false;
  private readonly installed: MediaSessionAction[] = [];
  private readonly onForeground = (): void => {
    (
      this.sink as AudioSink & {
        reconcileNativePlaybackState?: () => void;
      }
    ).reconcileNativePlaybackState?.();
    this.sync();
  };
  private readonly onMediaEvent = (event: Event): void => {
    if (event.type === "playing") this.playingConfirmed = true;
    if (
      ["pause", "waiting", "stalled", "ended", "emptied", "error"].includes(
        event.type,
      )
    ) {
      this.playingConfirmed = false;
    }
    this.sync();
  };

  constructor(
    private player: AudioStore,
    private sink: AudioSink,
  ) {
    this.element = (
      sink as AudioSink & { audioElement?: HTMLAudioElement }
    ).audioElement;
    this.media =
      typeof navigator !== "undefined" ? navigator.mediaSession : undefined;
  }

  start(): void {
    if (!this.media || !this.element) return;
    for (const name of [
      "play",
      "playing",
      "pause",
      "waiting",
      "stalled",
      "ended",
      "emptied",
      "error",
    ]) {
      this.element.addEventListener(name, this.onMediaEvent);
    }
    document.addEventListener("visibilitychange", this.onForeground);
    window.addEventListener("pageshow", this.onForeground);
    window.addEventListener("focus", this.onForeground);
    this.disposeReaction = mobx.reaction(
      () => [
        this.player.activeText,
        this.sink.isPlaying,
        this.sink.trackStatus,
        this.player.activeText?.position,
      ],
      () => this.sync(),
      { fireImmediately: true },
    );
  }

  private installHandlers(): void {
    const install = (
      action: MediaSessionAction,
      callback: MediaSessionActionHandler,
    ): void => {
      try {
        this.media!.setActionHandler(action, callback);
        this.installed.push(action);
      } catch {
        // WKWebView support differs by iOS version.
      }
    };
    install("play", () => {
      const active = this.player.activeText;
      if (active && !active.isPlaying) active.play();
    });
    install("pause", () => {
      const active = this.player.activeText;
      active?.pause();
    });
    install("nexttrack", () => this.player.activeText?.goToNext());
    install("previoustrack", () => this.player.activeText?.goToPrevious());
  }

  private sync(): void {
    const session = this.media;
    if (!session) return;
    const active = this.player.activeText;
    if (!active) {
      this.oldTrack = null;
      this.playingConfirmed = false;
      this.releaseSession();
      return;
    }
    if (this.oldTrack !== active) {
      this.oldTrack = active;
      this.playingConfirmed = false;
      this.installHandlers();
      this.ownsSession = true;
      if (typeof MediaMetadata !== "undefined") {
        try {
          const filename = active.audio.filename.split("/").pop() || "Reading";
          session.metadata = new MediaMetadata({
            title: filename,
            artist: "Aloud (iOS Fork)",
          });
          this.ownedMetadata = session.metadata;
        } catch {
          /* unsupported */
        }
      }
    }
    if (!this.ownsSession || session.metadata !== this.ownedMetadata) return;
    // Use the actual HTML element; intention alone may say "playing" while stalled.
    try {
      session.playbackState =
        this.playingConfirmed &&
        this.element &&
        !this.element.paused &&
        !this.element.error &&
        this.sink.trackStatus === "playing"
          ? "playing"
          : "paused";
    } catch {
      /* unsupported */
    }
  }

  destroy(): void {
    document.removeEventListener("visibilitychange", this.onForeground);
    window.removeEventListener("pageshow", this.onForeground);
    window.removeEventListener("focus", this.onForeground);
    this.disposeReaction?.();
    if (this.element) {
      for (const name of [
        "play",
        "playing",
        "pause",
        "waiting",
        "stalled",
        "ended",
        "emptied",
        "error",
      ]) {
        this.element.removeEventListener(name, this.onMediaEvent);
      }
    }
    this.releaseSession();
  }

  private releaseSession(): void {
    if (
      this.media &&
      this.ownsSession &&
      this.media.metadata === this.ownedMetadata
    ) {
      for (const action of this.installed) {
        try {
          this.media.setActionHandler(action, null);
        } catch {
          /* unsupported */
        }
      }
      try {
        this.media.playbackState = "none";
        this.media.metadata = null;
      } catch {
        /* unsupported */
      }
    }
    this.installed.length = 0;
    this.ownsSession = false;
    this.ownedMetadata = null;
  }
}

import { afterEach, describe, expect, it, vi } from "vitest";
import type { AudioSink, AudioStore } from "open-tts";
import { AloudMediaSession } from "./MediaSessionController";

afterEach(() => {
  Reflect.deleteProperty(navigator, "mediaSession");
  vi.unstubAllGlobals();
});

describe("Aloud Web Media Session", () => {
  it("handles play and pause as idempotent separate actions", () => {
    const handlers = new Map<string, (() => void) | null>();
    const media = {
      playbackState: "none",
      metadata: null,
      setActionHandler: vi.fn((name: string, handler: (() => void) | null) => {
        if (name === "nexttrack") throw new Error("unsupported");
        handlers.set(name, handler);
      }),
    };
    Object.defineProperty(navigator, "mediaSession", {
      configurable: true,
      value: media,
    });
    vi.stubGlobal(
      "MediaMetadata",
      class MockMediaMetadata {
        title: string;
        constructor(input: { title: string }) {
          this.title = input.title;
        }
      },
    );
    const element = document.createElement("audio");
    const track = {
      audio: { filename: "Articles/example.md", chunks: [] },
      position: 0,
      isPlaying: true,
      pause: vi.fn(() => {
        track.isPlaying = false;
      }),
      play: vi.fn(() => {
        track.isPlaying = true;
      }),
      goToNext: vi.fn(),
      goToPrevious: vi.fn(),
    };
    const player = { activeText: track } as unknown as AudioStore;
    const sink = {
      audioElement: element,
      isPlaying: false,
      trackStatus: "paused",
    } as unknown as AudioSink;
    const controller = new AloudMediaSession(player, sink);
    controller.start();
    expect(media.setActionHandler).toHaveBeenCalledWith(
      "play",
      expect.any(Function),
    );
    expect(media.setActionHandler).toHaveBeenCalledWith(
      "pause",
      expect.any(Function),
    );
    expect(media.playbackState).toBe("paused");
    expect((media.metadata as { title: string } | null)?.title).toBe(
      "example.md",
    );
    handlers.get("pause")?.();
    handlers.get("pause")?.();
    expect(track.isPlaying).toBe(false);
    handlers.get("play")?.();
    handlers.get("play")?.();
    expect(track.play).toHaveBeenCalledTimes(1);
    Object.defineProperty(element, "paused", {
      configurable: true,
      value: false,
    });
    Object.assign(sink, { trackStatus: "playing" });
    element.dispatchEvent(new Event("playing"));
    expect(media.playbackState).toBe("playing");
    element.dispatchEvent(new Event("waiting"));
    expect(media.playbackState).toBe("paused");
    controller.destroy();
    expect(handlers.get("play")).toBeNull();
    expect(handlers.get("pause")).toBeNull();
  });

  it("leaves other plugins' metadata alone when idle and after ownership changes", () => {
    const otherMetadata = { title: "Other player" };
    const media = {
      metadata: otherMetadata,
      playbackState: "playing",
      setActionHandler: vi.fn(),
    };
    Object.defineProperty(navigator, "mediaSession", {
      configurable: true,
      value: media,
    });
    const element = document.createElement("audio");
    const player = { activeText: null } as unknown as AudioStore;
    const sink = { audioElement: element } as unknown as AudioSink;
    const idle = new AloudMediaSession(player, sink);
    idle.start();
    idle.destroy();
    expect(media.metadata).toBe(otherMetadata);
    expect(media.setActionHandler).not.toHaveBeenCalled();

    Object.assign(player, {
      activeText: { audio: { filename: "Book.md" }, position: 0 },
    });
    const active = new AloudMediaSession(player, sink);
    active.start();
    media.metadata = { title: "A different plugin took over" };
    media.setActionHandler.mockClear();
    active.destroy();
    expect(media.metadata.title).toBe("A different plugin took over");
    expect(media.setActionHandler).not.toHaveBeenCalled();
  });
});

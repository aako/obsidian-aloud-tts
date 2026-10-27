import { describe, expect, it, vi } from "vitest";
import { WebAudioSink } from "./WebAudioSink";

describe("HTML audio rejection recovery", () => {
  it("coalesces pending Play requests and cancels them on Pause", async () => {
    const element = document.createElement("audio");
    let rejectPlay: (error: Error) => void = () => undefined;
    const play = vi.spyOn(element, "play").mockImplementation(
      () =>
        new Promise<void>((_, reject) => {
          rejectPlay = reject;
        }),
    );
    vi.spyOn(element, "pause").mockImplementation(() => undefined);
    vi.spyOn(element, "load").mockImplementation(() => undefined);
    const sink = new WebAudioSink(element, {
      buffered: { length: 0 },
    } as SourceBuffer);
    const failure = vi.fn();
    sink.onPlaybackFailure = failure;
    sink.play();
    sink.play();
    expect(play).toHaveBeenCalledTimes(1);
    sink.pause();
    rejectPlay(new Error("interrupted"));
    await Promise.resolve();
    await Promise.resolve();
    expect(failure).not.toHaveBeenCalled();
    sink.play();
    expect(play).toHaveBeenCalledTimes(2);
    sink.destroy();
  });

  it("reconciles a native AirPods pause after lock-screen suspension even if JS missed pause", () => {
    const element = document.createElement("audio");
    const sink = new WebAudioSink(element, {
      buffered: { length: 0 },
    } as SourceBuffer);
    Object.defineProperty(element, "paused", {
      configurable: true,
      value: false,
    });
    element.dispatchEvent(new Event("play"));
    expect(sink.isPlaying).toBe(true);
    Object.defineProperty(element, "paused", {
      configurable: true,
      value: true,
    });
    // Native stopped on the lock screen; WKWebView never delivered pause.
    document.dispatchEvent(new Event("visibilitychange"));
    expect(sink.isPlaying).toBe(false);
    expect(sink.trackStatus).toBe("paused");
    sink.destroy();
  });

  it("does not treat a remote Pause near the buffer end as completion", () => {
    const element = document.createElement("audio");
    element.currentTime = 9.9;
    const sink = new WebAudioSink(element, {
      buffered: { length: 1, start: () => 0, end: () => 10 },
    } as unknown as SourceBuffer);
    element.dispatchEvent(new Event("pause"));
    expect(sink.trackStatus).toBe("paused");
    expect(sink.isPlaying).toBe(false);
  });

  it("serializes buffer writes and clears every range before resetting the timeline", async () => {
    const element = document.createElement("audio");
    vi.spyOn(element, "pause").mockImplementation(() => undefined);
    const source = Object.assign(new EventTarget(), {
      updating: false,
      timestampOffset: 24,
      buffered: {
        length: 2,
        start: () => 0,
        end: (index: number): number => (index === 0 ? 10 : 24),
      },
      appendBuffer: vi.fn(() => {
        source.updating = true;
      }),
      remove: vi.fn(() => {
        source.buffered.length = 0;
      }),
    });
    const sink = new WebAudioSink(element, source as unknown as SourceBuffer);
    const append = sink.appendMedia(new ArrayBuffer(1));
    await vi.waitFor(() => expect(source.appendBuffer).toHaveBeenCalledOnce());
    const clear = sink.clearMedia();
    await Promise.resolve();
    expect(source.remove).not.toHaveBeenCalled();
    source.updating = false;
    source.dispatchEvent(new Event("updateend"));
    await Promise.all([append, clear]);
    expect(source.remove).toHaveBeenCalledWith(0, 24);
    expect(source.timestampOffset).toBe(0);
    source.timestampOffset = 99;
    await sink.clearMedia();
    expect(source.timestampOffset).toBe(0);
    sink.pause();
  });

  it("rewinds a forward-jumping clock to the last buffered point after a stall", () => {
    const element = document.createElement("audio");
    vi.spyOn(element, "pause").mockImplementation(() => undefined);
    vi.spyOn(element, "load").mockImplementation(() => undefined);
    const source = {
      buffered: { length: 1, start: () => 0, end: () => 60 },
    } as unknown as SourceBuffer;
    const sink = new WebAudioSink(element, source);
    element.currentTime = 9.8;
    element.dispatchEvent(new Event("play"));
    element.dispatchEvent(new Event("playing"));
    element.dispatchEvent(new Event("waiting"));
    expect(sink.isPlaybackStalled).toBe(true);
    expect(sink.isPlaying).toBe(true);
    // Simulate the native clock moving forward while iOS outputs no sound.
    element.currentTime = 23;
    element.dispatchEvent(new Event("playing"));
    expect(sink.isPlaybackStalled).toBe(false);
    expect(element.currentTime).toBe(9.8);
    expect(sink.isPlaying).toBe(true);
    sink.destroy();
  });

  it("pauses rather than skipping when the audio at the stall checkpoint was evicted", () => {
    const element = document.createElement("audio");
    const pause = vi
      .spyOn(element, "pause")
      .mockImplementation(() => undefined);
    vi.spyOn(element, "load").mockImplementation(() => undefined);
    const source = {
      buffered: { length: 1, start: () => 20, end: () => 40 },
    } as unknown as SourceBuffer;
    const sink = new WebAudioSink(element, source);
    const failure = vi.fn();
    sink.onPlaybackFailure = failure;
    element.currentTime = 9.8;
    element.dispatchEvent(new Event("play"));
    element.dispatchEvent(new Event("waiting"));
    element.currentTime = 25;
    element.dispatchEvent(new Event("playing"));
    expect(pause).toHaveBeenCalled();
    expect(sink.isPlaying).toBe(false);
    expect(sink.isPlaybackStalled).toBe(false);
    expect(failure).toHaveBeenCalledTimes(1);
    sink.destroy();
  });

  it("does not rewind on a normal short buffering recovery or after explicit pause", () => {
    const element = document.createElement("audio");
    vi.spyOn(element, "pause").mockImplementation(() => undefined);
    vi.spyOn(element, "load").mockImplementation(() => undefined);
    const sink = new WebAudioSink(element, {
      buffered: { length: 1, start: () => 0, end: () => 40 },
    } as unknown as SourceBuffer);
    element.currentTime = 4;
    element.dispatchEvent(new Event("play"));
    element.dispatchEvent(new Event("stalled"));
    element.currentTime = 4.2;
    element.dispatchEvent(new Event("playing"));
    expect(element.currentTime).toBe(4.2);
    expect(sink.isPlaybackStalled).toBe(false);

    element.dispatchEvent(new Event("stalled"));
    sink.pause();
    element.currentTime = 11;
    element.dispatchEvent(new Event("playing"));
    expect(element.currentTime).toBe(11);
    expect(sink.isPlaybackStalled).toBe(false);
    sink.destroy();
  });

  it("pauses a frozen foreground media clock without advancing it", () => {
    vi.useFakeTimers();
    try {
      const element = document.createElement("audio");
      vi.spyOn(element, "pause").mockImplementation(() => undefined);
      vi.spyOn(element, "load").mockImplementation(() => undefined);
      Object.defineProperty(element, "paused", {
        configurable: true,
        value: false,
      });
      Object.defineProperty(element, "readyState", {
        configurable: true,
        value: 4,
      });
      const sink = new WebAudioSink(element, {
        buffered: { length: 1, start: () => 0, end: () => 30 },
      } as unknown as SourceBuffer);
      element.currentTime = 5;
      const failure = vi.fn();
      sink.onPlaybackFailure = failure;
      element.dispatchEvent(new Event("play"));
      vi.advanceTimersByTime(17000);
      expect(failure).not.toHaveBeenCalled();
      vi.advanceTimersByTime(2000);
      expect(failure).toHaveBeenCalledTimes(1);
      expect(sink.isPlaying).toBe(false);
      expect(element.currentTime).toBe(5);
      sink.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails closed when playback is stuck at an empty buffer boundary", () => {
    vi.useFakeTimers();
    try {
      const element = document.createElement("audio");
      vi.spyOn(element, "pause").mockImplementation(() => undefined);
      vi.spyOn(element, "load").mockImplementation(() => undefined);
      Object.defineProperty(element, "paused", {
        configurable: true,
        value: false,
      });
      Object.defineProperty(element, "readyState", {
        configurable: true,
        value: 2,
      });
      const sink = new WebAudioSink(element, {
        buffered: { length: 0 },
      } as unknown as SourceBuffer);
      const failure = vi.fn();
      sink.onPlaybackFailure = failure;
      element.dispatchEvent(new Event("play"));
      vi.advanceTimersByTime(34000);
      expect(failure).not.toHaveBeenCalled();
      vi.advanceTimersByTime(2000);
      expect(failure).toHaveBeenCalledTimes(1);
      expect(sink.isPlaying).toBe(false);
      sink.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps normal advancing playback alive during long foreground listening", () => {
    vi.useFakeTimers();
    try {
      const element = document.createElement("audio");
      vi.spyOn(element, "pause").mockImplementation(() => undefined);
      vi.spyOn(element, "load").mockImplementation(() => undefined);
      Object.defineProperty(element, "paused", {
        configurable: true,
        value: false,
      });
      Object.defineProperty(element, "readyState", {
        configurable: true,
        value: 4,
      });
      const sink = new WebAudioSink(element, {
        buffered: { length: 1, start: () => 0, end: () => 100 },
      } as unknown as SourceBuffer);
      const failure = vi.fn();
      sink.onPlaybackFailure = failure;
      element.dispatchEvent(new Event("play"));
      for (let second = 1; second <= 35; second++) {
        element.currentTime = second;
        vi.advanceTimersByTime(1000);
      }
      expect(failure).not.toHaveBeenCalled();
      expect(sink.isPlaying).toBe(true);
      sink.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("refuses replay of an evicted sentence without requesting new audio", () => {
    const element = document.createElement("audio");
    vi.spyOn(element, "pause").mockImplementation(() => undefined);
    vi.spyOn(element, "load").mockImplementation(() => undefined);
    const sink = new WebAudioSink(element, {
      buffered: { length: 1, start: () => 10, end: () => 20 },
    } as unknown as SourceBuffer);
    element.currentTime = 15;
    expect(sink.retryBufferedAt(4)).toBe(false);
    expect(element.currentTime).toBe(15);
    sink.destroy();
  });

  it("retains only sanitized media diagnostics and a bounded event history", () => {
    const element = document.createElement("audio");
    vi.spyOn(element, "pause").mockImplementation(() => undefined);
    vi.spyOn(element, "load").mockImplementation(() => undefined);
    const sink = new WebAudioSink(element, {
      updating: false,
      buffered: { length: 1, start: () => 0, end: () => 12 },
    } as unknown as SourceBuffer);
    element.currentTime = 4;
    for (let index = 0; index < 60; index++) {
      element.dispatchEvent(new Event("waiting"));
    }
    const report = sink.getPlaybackDiagnostics() as {
      schema: string;
      state: { currentTime: number; buffered: Array<{ end: number }> };
      events: Array<{ event: string }>;
    };
    expect(report.schema).toBe("aloud-playback-v1");
    expect(report.state.currentTime).toBe(4);
    expect(report.state.buffered[0].end).toBe(12);
    expect(report.events).toHaveLength(40);
    expect(JSON.stringify(report)).not.toMatch(
      /apiKey|sourcePath|articleText|transcript/,
    );
    sink.destroy();
  });

  it("times out a native SourceBuffer operation and preserves the media clock", async () => {
    vi.useFakeTimers();
    try {
      const element = document.createElement("audio");
      vi.spyOn(element, "pause").mockImplementation(() => undefined);
      vi.spyOn(element, "load").mockImplementation(() => undefined);
      const source = Object.assign(new EventTarget(), {
        updating: false,
        buffered: { length: 0 },
        appendBuffer: vi.fn(() => {
          source.updating = true;
        }),
      });
      const sink = new WebAudioSink(element, source as unknown as SourceBuffer);
      element.currentTime = 7;
      const failure = vi.fn();
      sink.onPlaybackFailure = failure;
      const pending = expect(
        sink.appendMedia(new ArrayBuffer(1)),
      ).rejects.toThrow("MediaSource buffer update timed out.");
      await vi.advanceTimersByTimeAsync(31000);
      await pending;
      expect(failure).toHaveBeenCalledOnce();
      expect(element.currentTime).toBe(7);
      expect(
        (
          sink.getPlaybackDiagnostics() as { events: Array<{ event: string }> }
        ).events.some((event) => event.event === "buffer-operation-failed"),
      ).toBe(true);
      sink.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("observes rejected play promises and reports an error without throwing", async () => {
    const element = document.createElement("audio");
    vi.spyOn(element, "play").mockRejectedValue(
      new DOMException("play denied", "NotAllowedError"),
    );
    vi.spyOn(element, "pause").mockImplementation(() => undefined);
    vi.spyOn(element, "load").mockImplementation(() => undefined);
    const source = { buffered: { length: 0 } } as unknown as SourceBuffer;
    const sink = new WebAudioSink(element, source);
    const error = vi.fn();
    sink.onPlaybackFailure = error;
    sink.play();
    await vi.waitFor(() => expect(error).toHaveBeenCalledOnce());
    expect(sink.isPlaying).toBe(false);
    expect(sink.trackStatus).toBe("paused");
    sink.destroy();
  });
});

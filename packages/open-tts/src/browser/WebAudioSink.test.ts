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

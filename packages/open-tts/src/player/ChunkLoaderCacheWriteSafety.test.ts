import { afterEach, describe, expect, it, vi } from "vitest";
import type { AudioSystem } from "./AudioSystem";
import { ChunkLoader } from "./ChunkLoader";
import type { AudioData } from "../models/tts-model";

const options = {
  modelProvider: "openai" as const,
  model: "example-model",
  voice: "example-voice",
};
const received: AudioData = {
  data: new Uint8Array([0xff, 0xfb, 0x90, 0x01]).buffer,
  format: "mp3",
};

const loaders: ChunkLoader[] = [];

afterEach(() => {
  for (const loader of loaders) loader.destroy();
  loaders.length = 0;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function makeSystem() {
  const storage = {
    getAudio: vi.fn().mockResolvedValue(null),
    saveAudio: vi.fn().mockRejectedValue(new Error("test-private-path")),
  };
  const ttsModel = {
    call: vi.fn().mockResolvedValue(received),
  };
  const system = {
    config: { backgroundLoaderIntervalMillis: 1000 },
    settings: { modelProvider: "openai" },
    audioStore: { activeText: null },
    storage,
    ttsModel,
  } as unknown as AudioSystem;
  const loader = new ChunkLoader({ system });
  loaders.push(loader);
  return { loader, storage, ttsModel };
}

describe("post-synthesis cache write failure safety", () => {
  it("plays already-received audio without retrying the paid generation", async () => {
    const warning = vi
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);
    const { loader, storage, ttsModel } = makeSystem();
    const audio = await loader.load("Hello there", options);
    expect(audio).toEqual(received);
    expect(ttsModel.call).toHaveBeenCalledTimes(1);
    expect(storage.saveAudio).toHaveBeenCalledTimes(1);
    expect(warning).toHaveBeenCalledWith(
      expect.stringContaining("NOT saved"),
      "Error",
    );
    // A second playback in the same session reuses the received audio.
    expect(await loader.load("Hello there", options)).toEqual(received);
    expect(ttsModel.call).toHaveBeenCalledTimes(1);
  });

  it("fails closed instead of rebilling after its in-memory copy expires", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { loader, ttsModel } = makeSystem();
    await loader.load("Hello there", options);
    await vi.advanceTimersByTimeAsync(65_000);
    await expect(loader.load("Hello there", options)).rejects.toThrow(
      "automatic regeneration is blocked",
    );
    expect(ttsModel.call).toHaveBeenCalledTimes(1);
  });

  it("accepts a healthy storage hit after a failed save without synthesizing again", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { loader, storage, ttsModel } = makeSystem();
    await loader.load("Hello there", options);
    storage.getAudio.mockResolvedValue(received);
    await vi.advanceTimersByTimeAsync(65_000);
    expect(await loader.load("Hello there", options)).toEqual(received);
    expect(ttsModel.call).toHaveBeenCalledTimes(1);
    expect(storage.saveAudio).toHaveBeenCalledTimes(1);
  });
});

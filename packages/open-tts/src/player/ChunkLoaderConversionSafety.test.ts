import { afterEach, describe, expect, it, vi } from "vitest";
import type { AudioSystem } from "./AudioSystem";
import { ChunkLoader } from "./ChunkLoader";
import type { AudioData } from "../models/tts-model";

const options = {
  modelProvider: "openai" as const,
  model: "sample-model",
  voice: "sample-voice",
};
const mp3: AudioData = {
  data: new Uint8Array([0xff, 0xfb, 0x90, 0x01]).buffer,
  format: "mp3",
};
const invalidWav: AudioData = {
  // The provider returned bytes, but the WAV header is not valid.
  data: new Uint8Array([0, 1, 2, 3]).buffer,
  format: "wav",
};
const loaders: ChunkLoader[] = [];

afterEach(() => {
  for (const loader of loaders) loader.destroy();
  loaders.length = 0;
  vi.restoreAllMocks();
});

function makeSystem(providerResponse: AudioData = invalidWav) {
  const storage = {
    getAudio: vi.fn().mockResolvedValue(null as AudioData | null),
    saveAudio: vi.fn().mockResolvedValue(undefined),
  };
  const ttsModel = {
    call: vi.fn().mockResolvedValue(providerResponse),
    convertToOptions: vi.fn().mockReturnValue(options),
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
  return { loader, ttsModel, storage };
}

describe("post-synthesis audio conversion safety", () => {
  it("does not make a second paid call when returned WAV data cannot be converted", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { loader, ttsModel, storage } = makeSystem();
    await expect(loader.load("A", options)).rejects.toThrow(
      "local audio conversion failed",
    );
    expect(ttsModel.call).toHaveBeenCalledTimes(1);
    expect(storage.saveAudio).not.toHaveBeenCalled();
  });

  it("blocks repeat synthesis of the same unconvertible chunk for this plugin session", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { loader, ttsModel } = makeSystem();
    await expect(loader.load("B", options)).rejects.toThrow(
      "No automatic paid retry",
    );
    await expect(loader.load("B", options)).rejects.toThrow(
      "No automatic paid retry",
    );
    expect(ttsModel.call).toHaveBeenCalledTimes(1);
  });

  it("reuses audio recovered from disk rather than requesting paid synthesis", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { loader, ttsModel, storage } = makeSystem();
    await expect(loader.load("C", options)).rejects.toThrow(
      "local audio conversion failed",
    );
    storage.getAudio.mockResolvedValue(mp3);
    await expect(loader.load("C", options)).resolves.toEqual(mp3);
    expect(ttsModel.call).toHaveBeenCalledTimes(1);
  });

  it("preserves successful MP3 playback and normal caching", async () => {
    const { loader, ttsModel, storage } = makeSystem(mp3);
    await expect(loader.load("D", options)).resolves.toEqual(mp3);
    expect(ttsModel.call).toHaveBeenCalledTimes(1);
    expect(storage.saveAudio).toHaveBeenCalledWith("D", options, mp3);
  });
});

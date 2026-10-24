import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AudioSystem } from "./AudioSystem";
import { ChunkLoader } from "./ChunkLoader";
import type { AudioData } from "../models/tts-model";

const options = {
  modelProvider: "openai" as const,
  model: "sample",
  voice: "narrator",
};
const mp3: AudioData = {
  data: new Uint8Array([0xff, 0xfb, 0x90, 0x01]).buffer,
  format: "mp3",
};
const invalidWav: AudioData = {
  data: new Uint8Array([0, 1, 2, 3]).buffer,
  format: "wav",
};

const loaders: ChunkLoader[] = [];

function fixture(response: AudioData = mp3) {
  const storage = {
    getAudio: vi.fn().mockResolvedValue(null as AudioData | null),
    saveAudio: vi.fn().mockRejectedValue(new Error("disk-write-failed")),
  };
  const ttsModel = {
    call: vi.fn().mockResolvedValue(response),
    convertToOptions: vi.fn().mockReturnValue(options),
  };
  const system = {
    config: { backgroundLoaderIntervalMillis: 1000 },
    settings: { modelProvider: "openai" },
    storage,
    ttsModel,
    audioStore: { activeText: null },
  } as unknown as AudioSystem;

  function loader(): ChunkLoader {
    const instance = new ChunkLoader({ system });
    loaders.push(instance);
    return instance;
  }
  return { loader, storage, ttsModel };
}

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  for (const loader of loaders) loader.destroy();
  loaders.length = 0;
  vi.restoreAllMocks();
});

describe("session-wide post-synthesis safety across loaders", () => {
  it("blocks a second loader from rebilling after the first cache write failed", async () => {
    const { loader, ttsModel } = fixture();
    const playback = loader();
    const exportJob = loader();

    await expect(playback.load("The same sentence", options)).resolves.toEqual(
      mp3,
    );
    await expect(exportJob.load("The same sentence", options)).rejects.toThrow(
      "automatic regeneration is blocked",
    );
    expect(ttsModel.call).toHaveBeenCalledTimes(1);
  });

  it("keeps the safety barrier after the first loader is destroyed", async () => {
    const { loader, ttsModel } = fixture();
    const playback = loader();
    await playback.load("Do not buy twice", options);
    playback.destroy();

    await expect(loader().load("Do not buy twice", options)).rejects.toThrow(
      "automatic regeneration is blocked",
    );
    expect(ttsModel.call).toHaveBeenCalledTimes(1);
  });

  it("blocks another loader after receiving audio that could not be converted", async () => {
    const { loader, ttsModel } = fixture(invalidWav);
    await expect(loader().load("Unplayable result", options)).rejects.toThrow(
      "local audio conversion failed",
    );
    await expect(loader().load("Unplayable result", options)).rejects.toThrow(
      "No automatic paid retry",
    );
    expect(ttsModel.call).toHaveBeenCalledTimes(1);
  });

  it("allows another loader to use an intact cached copy without a paid call", async () => {
    const { loader, ttsModel, storage } = fixture();
    await loader().load("Now on disk", options);
    storage.getAudio.mockResolvedValue(mp3);
    await expect(loader().load("Now on disk", options)).resolves.toEqual(mp3);
    expect(ttsModel.call).toHaveBeenCalledTimes(1);
  });

  it("isolates different voice choices within the same AudioSystem", async () => {
    const { loader, ttsModel } = fixture();
    await loader().load("Same words", options);
    const otherVoice = { ...options, voice: "second-narrator" };
    ttsModel.convertToOptions.mockReturnValue(otherVoice);
    await expect(loader().load("Same words", otherVoice)).resolves.toEqual(mp3);
    expect(ttsModel.call).toHaveBeenCalledTimes(2);
  });

  it("does not carry barriers across independent AudioSystem sessions", async () => {
    const first = fixture();
    const second = fixture();
    await first.loader().load("Another system", options);
    await expect(
      second.loader().load("Another system", options),
    ).resolves.toEqual(mp3);
    expect(first.ttsModel.call).toHaveBeenCalledTimes(1);
    expect(second.ttsModel.call).toHaveBeenCalledTimes(1);
  });
});

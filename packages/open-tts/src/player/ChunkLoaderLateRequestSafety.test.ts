import { afterEach, describe, expect, it, vi } from "vitest";
import type { AudioSystem } from "./AudioSystem";
import { ChunkLoader } from "./ChunkLoader";
import type { AudioData, TTSModelOptions } from "../models/tts-model";

const received: AudioData = {
  data: new Uint8Array([0xff, 0xfb, 0x90, 0x01]).buffer,
  format: "mp3",
};
const loaders: ChunkLoader[] = [];

afterEach(() => {
  for (const loader of loaders) loader.destroy();
  loaders.length = 0;
  vi.restoreAllMocks();
});

function createLoader(provider: "openai" | "speechify" = "openai") {
  const settings = { modelProvider: provider, voiceId: "original" };
  const convertToOptions = vi.fn(
    (): TTSModelOptions => ({
      modelProvider: settings.modelProvider,
      model: "fixed-model",
      voice: settings.voiceId,
    }),
  );
  const storage = {
    getAudio: vi.fn().mockResolvedValue(null as AudioData | null),
    saveAudio: vi.fn().mockResolvedValue(undefined),
  };
  const ttsModel = {
    convertToOptions,
    call: vi.fn().mockResolvedValue(received),
  };
  const system = {
    config: { backgroundLoaderIntervalMillis: 1000 },
    settings,
    audioStore: { activeText: null },
    storage,
    ttsModel,
  } as unknown as AudioSystem;
  const loader = new ChunkLoader({ system });
  loaders.push(loader);
  return { loader, settings, storage, ttsModel, convertToOptions };
}

function deferredCache(storage: ReturnType<typeof createLoader>["storage"]) {
  let release: (result: AudioData | null) => void = () => undefined;
  const pending = new Promise<AudioData | null>((resolve) => {
    release = resolve;
  });
  storage.getAudio.mockReturnValueOnce(pending);
  return (result: AudioData | null) => release(result);
}

describe("late audio cache reads and aborts", () => {
  it("does not synthesize using an obsolete voice after a slow cache miss", async () => {
    const { loader, settings, storage, ttsModel } = createLoader();
    const release = deferredCache(storage);
    const work = loader.load("Sentence A", ttsModel.convertToOptions());
    settings.voiceId = "new voice";
    release(null);
    await expect(work).rejects.toThrow("discarded before synthesis");
    expect(ttsModel.call).not.toHaveBeenCalled();
    expect(storage.saveAudio).not.toHaveBeenCalled();
    expect(storage.getAudio).toHaveBeenCalledTimes(1);
  });

  it("does not reroute a queued request if the provider changes during cache read", async () => {
    const { loader, settings, storage, ttsModel } = createLoader("speechify");
    const release = deferredCache(storage);
    const work = loader.load("Sentence B", ttsModel.convertToOptions());
    // Same model and voice; only provider changed.
    settings.modelProvider = "openai";
    release(null);
    await expect(work).rejects.toThrow("discarded before synthesis");
    expect(ttsModel.call).not.toHaveBeenCalled();
  });

  it("still synthesizes exactly once if nothing changed while the cache was loading", async () => {
    const { loader, storage, ttsModel } = createLoader();
    const release = deferredCache(storage);
    const work = loader.load("Sentence C", ttsModel.convertToOptions());
    release(null);
    await expect(work).resolves.toEqual(received);
    expect(ttsModel.call).toHaveBeenCalledTimes(1);
    expect(storage.saveAudio).toHaveBeenCalledTimes(1);
  });

  it("skips synthesis and all retries if cancelled during the cache lookup", async () => {
    const { loader, storage, ttsModel } = createLoader();
    const release = deferredCache(storage);
    const controller = new AbortController();
    const work = loader.load("Sentence D", ttsModel.convertToOptions(), {
      request: { signal: controller.signal },
    });
    controller.abort();
    release(null);
    await expect(work).rejects.toMatchObject({ name: "AbortError" });
    expect(ttsModel.call).not.toHaveBeenCalled();
    expect(storage.getAudio).toHaveBeenCalledTimes(1);
  });

  it("never retries provider AbortError, even for providers that permit transient retries", async () => {
    const { loader, ttsModel, storage } = createLoader("openai");
    ttsModel.call.mockRejectedValueOnce(
      new DOMException("Cancelled", "AbortError"),
    );
    await expect(
      loader.load("Sentence E", ttsModel.convertToOptions()),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(ttsModel.call).toHaveBeenCalledTimes(1);
    expect(storage.getAudio).toHaveBeenCalledTimes(1);
  });

  it("leaves legacy untagged library options compatible", async () => {
    const { loader, ttsModel, storage } = createLoader();
    await expect(
      loader.load("Sentence F", { model: "legacy" }),
    ).resolves.toEqual(received);
    expect(ttsModel.call).toHaveBeenCalledTimes(1);
    expect(storage.saveAudio).toHaveBeenCalledTimes(1);
  });
});

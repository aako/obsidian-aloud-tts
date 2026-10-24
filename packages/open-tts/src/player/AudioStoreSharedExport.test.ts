import { afterEach, describe, expect, it, vi } from "vitest";
import { createAudioSystem, type AudioSystem } from "./AudioSystem";
import { ChunkLoader } from "./ChunkLoader";
import { loadAudioStore, type AudioStore } from "./AudioStore";
import { memoryStorage } from "./AudioCache";
import { DEFAULT_SETTINGS } from "./TTSPluginSettings";
import type { AudioData } from "../models/tts-model";
import { createTestModel, FakeAudioSink } from "../test-utils";
import { concatenateMp3Buffers } from "../util/audioProcessing";

vi.mock("obsidian", () => ({
  requestUrl: vi.fn(),
  debounce: () => vi.fn(),
}));

vi.mock("../util/audioProcessing", async (importOriginal) => {
  const real = await importOriginal<typeof import("../util/audioProcessing")>();
  return {
    ...real,
    // The integration target is the loader, not MP3 re-encoding. Keep all
    // other conversion functions real, and avoid browser codecs in Vitest.
    concatenateMp3Buffers: vi.fn(async (buffers: ArrayBuffer[]) => buffers[0]),
  };
});

const fixtures: Array<{ system: AudioSystem; store: AudioStore }> = [];

function fixture() {
  const model = createTestModel();
  const call = vi.spyOn(model, "call");
  const system = createAudioSystem({
    storage: () => memoryStorage(),
    audioSink: () => new FakeAudioSink(),
    ttsModel: () => model,
    settings: () => ({ ...DEFAULT_SETTINGS }),
    config: () => ({ backgroundLoaderIntervalMillis: 1000 }),
    audioStore: (sys) => loadAudioStore({ system: sys }),
    chunkLoader: (sys) => new ChunkLoader({ system: sys }),
  });
  const result = { system, store: system.audioStore, call };
  fixtures.push(result);
  return result;
}

afterEach(() => {
  for (const { system, store } of fixtures.splice(0)) {
    store.destroy();
    system.chunkLoader.destroy();
  }
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe("export uses playback's guarded and cached loader", () => {
  it("reuses already synthesized playback audio and never sends an export-only provider call", async () => {
    const { system, store, call } = fixture();
    const text = "A sentence already synthesized during playback.";
    const options = system.ttsModel.convertToOptions(system.settings);
    const audio = await system.chunkLoader.load(text, options);
    expect(call).toHaveBeenCalledTimes(1);

    expect(await store.exportAudio(text)).toEqual(audio.data);
    expect(await store.exportAudio(text)).toEqual(audio.data);
    expect(call).toHaveBeenCalledTimes(1);
    expect(store.exportProgress).toBeNull();
  });

  it("preserves multi-chunk export progress and existing split boundaries while caching chunks", async () => {
    const { system, store, call } = fixture();
    const text = "A long meaningful sentence for the export pipeline. ".repeat(
      180,
    );
    const result = await store.exportAudio(text);
    expect(result).toBeInstanceOf(ArrayBuffer);
    expect(call.mock.calls.length).toBeGreaterThan(1);
    expect(concatenateMp3Buffers).toHaveBeenCalledTimes(1);
    expect(concatenateMp3Buffers).toHaveBeenCalledWith(
      expect.any(Array),
      system.audioSink,
    );
    const count = call.mock.calls.length;
    await store.exportAudio(text);
    expect(call).toHaveBeenCalledTimes(count);
    expect(store.exportProgress).toBeNull();
  });

  it("cancels an export after native synthesis resolves without discarding cache or buying audio again", async () => {
    const { store, call } = fixture();
    let resolveAudio!: (value: AudioData) => void;
    call.mockImplementationOnce(
      () => new Promise<AudioData>((resolve) => (resolveAudio = resolve)),
    );
    const text = "A request that has already reached the provider.";
    const pending = store.exportAudio(text);
    await vi.waitFor(() => expect(call).toHaveBeenCalledTimes(1));
    store.cancelExport();
    resolveAudio({ data: new ArrayBuffer(14), format: "mp3" });
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(store.exportProgress).toBeNull();
    await store.exportAudio(text);
    expect(call).toHaveBeenCalledTimes(1);
  });

  it("rejects a concurrent export rather than losing the first cancellation controller", async () => {
    const { store, call } = fixture();
    let resolveAudio!: (value: AudioData) => void;
    call.mockImplementationOnce(
      () => new Promise<AudioData>((resolve) => (resolveAudio = resolve)),
    );
    const first = store.exportAudio("First active export sentence.");
    await vi.waitFor(() => expect(call).toHaveBeenCalledTimes(1));
    await expect(store.exportAudio("Another export.")).rejects.toThrow(
      "already running",
    );
    resolveAudio({ data: new ArrayBuffer(13), format: "mp3" });
    await expect(first).resolves.toBeInstanceOf(ArrayBuffer);
    expect(call).toHaveBeenCalledTimes(1);
  });

  it("never returns unconverted WAV data as an MP3 export or retries a paid conversion failure", async () => {
    const { store, call } = fixture();
    const warning = vi
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);
    call.mockResolvedValue({
      data: new Uint8Array([0, 1, 2, 3]).buffer,
      format: "wav",
    });
    await expect(
      store.exportAudio("Invalid returned WAV audio."),
    ).rejects.toThrow("local audio conversion failed");
    expect(call).toHaveBeenCalledTimes(1);
    expect(warning).toHaveBeenCalled();
    expect(store.exportProgress).toBeNull();
  });
});

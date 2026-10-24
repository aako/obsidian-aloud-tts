import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { App } from "obsidian";
import type { AudioData, TTSModelOptions } from "open-tts";
import { configurableAudioCache } from "./ObsidianPlayer";
import { createTestSettingsStore } from "./test-utils";

const local = vi.hoisted(() => ({
  audio: null as AudioData | null,
}));

vi.mock("open-tts/browser", () => ({
  IndexedDBAudioStorage: vi.fn(() => ({
    getAudio: vi.fn(async () => local.audio),
    saveAudio: vi.fn(
      async (_text: string, _opts: unknown, audio: AudioData) => {
        local.audio = audio;
      },
    ),
    expire: vi.fn(async () => undefined),
    getStorageSize: vi.fn(async () => 0),
  })),
}));

vi.mock("obsidian", () => ({
  App: vi.fn(),
  normalizePath: (path: string) => path,
}));

const options: TTSModelOptions = {
  modelProvider: "speechify",
  model: "simba-3.2",
  voice: "geffen_32",
};
const mp3: AudioData = {
  data: new Uint8Array([0xff, 0xfb, 0x90, 1]).buffer,
  format: "mp3",
};
const app = {
  vault: {
    adapter: { exists: vi.fn(async () => false) },
  },
} as unknown as App;

beforeEach(() => {
  local.audio = null;
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
});

async function fixture() {
  const settings = await createTestSettingsStore();
  const persistent = {
    getAudio: vi.fn().mockResolvedValue(null as AudioData | null),
    saveAudio: vi.fn().mockResolvedValue(undefined),
  };
  const cache = configurableAudioCache(app, settings, persistent as any);
  return { cache, persistent };
}

async function flushAsyncSaves(): Promise<void> {
  // Let the chained promise for the queued vault write and failure marker settle.
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

describe("retry only known failed vault saves using existing local MP3", () => {
  it("recovers a failed vault save on the next local playback cache hit", async () => {
    const { cache, persistent } = await fixture();
    persistent.saveAudio
      .mockRejectedValueOnce(new Error("iCloud temporarily unavailable"))
      .mockResolvedValue(undefined);

    await cache.saveAudio("Hello.", options, mp3);
    await flushAsyncSaves();
    expect(persistent.saveAudio).toHaveBeenCalledTimes(1);

    await expect(cache.getAudio("Hello.", options, "mp3")).resolves.toEqual(
      mp3,
    );
    await cache.destroy();
    expect(persistent.saveAudio).toHaveBeenCalledTimes(2);
    expect(persistent.saveAudio).toHaveBeenLastCalledWith(
      "Hello.",
      options,
      mp3,
    );
  });

  it("does not promote an unrelated local legacy cache hit", async () => {
    const { cache, persistent } = await fixture();
    local.audio = mp3;
    await expect(cache.getAudio("Old cache", options, "mp3")).resolves.toEqual(
      mp3,
    );
    await cache.destroy();
    expect(persistent.saveAudio).not.toHaveBeenCalled();
  });

  it("does not retry healthy persistent writes on every local cache hit", async () => {
    const { cache, persistent } = await fixture();
    await cache.saveAudio("Already saved.", options, mp3);
    await flushAsyncSaves();
    await cache.getAudio("Already saved.", options, "mp3");
    await cache.destroy();
    expect(persistent.saveAudio).toHaveBeenCalledTimes(1);
  });

  it("does not rewrite an iCloud placeholder when persistent metadata is inaccessible", async () => {
    const { cache, persistent } = await fixture();
    persistent.saveAudio.mockRejectedValueOnce(new Error("save failed"));
    await cache.saveAudio("Do not overwrite.", options, mp3);
    await flushAsyncSaves();
    persistent.getAudio.mockRejectedValue(
      new Error("iCloud metadata unavailable"),
    );
    await expect(
      cache.getAudio("Do not overwrite.", options, "mp3"),
    ).resolves.toEqual(mp3);
    await cache.destroy();
    expect(persistent.saveAudio).toHaveBeenCalledTimes(1);
  });

  it("clears a failed-write marker after a recovered persistent cache hit", async () => {
    const { cache, persistent } = await fixture();
    persistent.saveAudio.mockRejectedValueOnce(new Error("save failed"));
    await cache.saveAudio("Already recovered.", options, mp3);
    await flushAsyncSaves();
    persistent.getAudio.mockResolvedValueOnce(mp3);
    await expect(
      cache.getAudio("Already recovered.", options, "mp3"),
    ).resolves.toEqual(mp3);
    await cache.getAudio("Already recovered.", options, "mp3");
    await cache.destroy();
    expect(persistent.saveAudio).toHaveBeenCalledTimes(1);
  });
});

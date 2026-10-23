import { describe, it, expect, vi } from "vitest";
import { configurableAudioCache, obsidianFileVault } from "./ObsidianPlayer";
import { createTestSettingsStore } from "./test-utils";

// Mock dependencies
vi.mock("open-tts/browser", () => ({
  IndexedDBAudioStorage: vi.fn(() => ({
    getAudio: vi.fn(),
    saveAudio: vi.fn(),
    ready: vi.fn(() => Promise.resolve()),
  })),
}));

vi.mock("obsidian", () => ({
  App: vi.fn(),
  normalizePath: vi.fn((path: string) => path),
}));

describe("ObsidianPlayer", () => {
  describe("configurableAudioCache", () => {
    it("should create cache without crashing", async () => {
      const mockApp = {} as any;
      const settingsStore = await createTestSettingsStore();

      const cache = configurableAudioCache(mockApp, settingsStore);

      expect(cache).toBeDefined();
      expect(typeof cache.getAudio).toBe("function");
      expect(typeof cache.destroy).toBe("function");
    });

    it("should have destroy method", async () => {
      const mockApp = {} as any;
      const settingsStore = await createTestSettingsStore();

      const cache = configurableAudioCache(mockApp, settingsStore);

      // Should not crash when calling destroy
      expect(() => cache.destroy()).not.toThrow();
    });
  });

  describe("shared playback cache", () => {
    it("writes generated audio locally first and queues a shared vault copy", async () => {
      const settingsStore = await createTestSettingsStore();
      const localWrites: Array<string> = [];
      const persistent = {
        saveAudio: vi.fn(async (text: string) => {
          localWrites.push(`shared:${text}`);
        }),
      };
      const cache = configurableAudioCache(
        {} as any,
        settingsStore,
        persistent as any,
      );
      const options = {
        model: "google-chirp3-hd-mp3-v1",
        voice: "en-US-Chirp3-HD-Aoede",
      };
      const audio = {
        data: new Uint8Array([0xff, 0xfb, 0x90, 1]).buffer,
        format: "mp3" as const,
      };
      await cache.saveAudio("First sentence.", options, audio);
      // Shared saves drain on unload, and never trigger another paid request.
      await cache.destroy();
      expect(persistent.saveAudio).toHaveBeenCalledOnce();
      expect(persistent.saveAudio).toHaveBeenCalledWith(
        "First sentence.",
        options,
        audio,
      );
      expect(localWrites).toEqual(["shared:First sentence."]);
    });

    it("does not block local playback on slow or failing shared-cache writes", async () => {
      const settingsStore = await createTestSettingsStore();
      let release: ((value: void) => void) | undefined;
      const persistent = {
        saveAudio: vi.fn(
          () =>
            new Promise<void>((resolve) => {
              release = resolve;
            }),
        ),
      };
      const cache = configurableAudioCache(
        {} as any,
        settingsStore,
        persistent as any,
      );
      const options = { model: "test", voice: "reader" };
      const audio = {
        data: new Uint8Array([1, 2, 3]).buffer,
        format: "mp3" as const,
      };
      // The foreground call resolves without waiting for iCloud persistence.
      await cache.saveAudio("Hello.", options, audio);
      await cache.saveAudio("Hello.", options, audio);
      await Promise.resolve();
      expect(persistent.saveAudio).toHaveBeenCalledOnce();
      release?.();
      await cache.destroy();
    });
  });

  describe("obsidianFileVault", () => {
    it("should create vault cache without crashing", () => {
      const mockApp = {
        vault: {
          adapter: {
            read: vi.fn(),
            write: vi.fn(),
            exists: vi.fn(() => Promise.resolve(false)),
            remove: vi.fn(),
          },
        },
      } as any;

      const cache = obsidianFileVault(mockApp);

      expect(cache).toBeDefined();
      expect(typeof cache.getAudio).toBe("function");
      expect(typeof cache.saveAudio).toBe("function");
    });
  });
});

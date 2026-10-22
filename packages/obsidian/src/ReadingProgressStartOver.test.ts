import { describe, expect, it, vi } from "vitest";
import * as mobx from "mobx";
import { buildTrack } from "open-tts";
import type { App, DataAdapter } from "obsidian";
import type { AudioStore, TTSPluginSettingsStore } from "open-tts";
import { ReadingProgress } from "./ReadingProgress";

describe("Start Over persistence", () => {
  it("persists chunk zero so a new instance never resumes to the old bookmark", async () => {
    const storage = new Map<string, string>();
    const adapter = {
      read: vi.fn(async (path: string) => {
        const value = storage.get(path);
        if (value === undefined) throw new Error("not found");
        return value;
      }),
      write: vi.fn(async (path: string, value: string) => {
        storage.set(path, value);
      }),
      exists: vi.fn(async (path: string) => storage.has(path)),
    } as unknown as DataAdapter;
    const app = { vault: { configDir: ".obsidian" } } as unknown as App;
    const player = mobx.observable({
      activeText: null as unknown,
    }) as AudioStore;
    const settings = {
      settings: { chunkType: "sentence" },
    } as unknown as TTSPluginSettingsStore;
    const text =
      "The first complete sentence. The second complete sentence. A third sentence.";
    const options = {
      filename: "Book.md",
      sourcePath: "Book.md",
      start: 0,
      end: text.length,
      text,
    };
    const progress = new ReadingProgress(
      app,
      adapter,
      player,
      settings,
      "aloud-ios-fork",
    );
    await progress.load();
    progress.start();
    const oldTrack = mobx.observable({
      audio: buildTrack(options),
      position: 0,
      isPlaying: true,
    });
    mobx.runInAction(() => {
      player.activeText = oldTrack as unknown as AudioStore["activeText"];
    });
    mobx.runInAction(() => {
      oldTrack.position = 2;
    });
    const reset = progress.resetToStart(options);
    mobx.runInAction(() => {
      oldTrack.position = 1;
      oldTrack.isPlaying = false;
    });
    document.dispatchEvent(new Event("visibilitychange"));
    await reset;
    await progress.stop();
    const resumed = new ReadingProgress(
      app,
      adapter,
      player,
      settings,
      "aloud-ios-fork",
    );
    await resumed.load();
    expect(resumed.positionFor(options)).toBe(0);
  });
});

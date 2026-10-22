import { describe, expect, it, vi } from "vitest";
import * as mobx from "mobx";
import type { App, DataAdapter } from "obsidian";
import type { AudioStore, TTSPluginSettingsStore } from "open-tts";
import { buildTrack } from "open-tts";
import { ReadingProgress } from "./ReadingProgress";
import {
  readingFingerprint,
  readingKey,
  resolveReadingPosition,
  validSnapshot,
  SavedReading,
} from "./ReadingProgress";

const text =
  "First sentence. Second sentence. Third sentence. Fourth sentence.";
const opts = {
  filename: "article.md",
  sourcePath: "articles/article.md",
  text,
  start: 0,
  end: text.length,
  minChunkLength: 1,
};
function record(chunk: number, anchor: string): SavedReading {
  return {
    path: opts.sourcePath,
    start: opts.start,
    end: opts.end,
    fingerprint: readingFingerprint(text),
    chunk,
    anchor,
    updatedAt: 100,
  };
}

describe("durable progress", () => {
  it("produces reproducible text fingerprints", () => {
    expect(readingFingerprint(text)).toBe(readingFingerprint(text));
    expect(readingFingerprint(text)).not.toBe(readingFingerprint(text + "x"));
  });
  it("uses path and selection boundaries for separate bookmarks", () => {
    expect(readingKey("a", 0, 8, "h")).not.toBe(readingKey("b", 0, 8, "h"));
    expect(readingKey("a", 0, 8, "h")).not.toBe(readingKey("a", 1, 8, "h"));
  });
  it("restores only when matching the exact source sentence", () => {
    const saved = record(1, readingFingerprint("Second sentence. "));
    expect(resolveReadingPosition(opts, saved, "sentence")).toBe(1);
  });
  it("rejects changed article text", () => {
    const changed = { ...opts, text: text + " Changed.", end: text.length + 9 };
    expect(
      resolveReadingPosition(
        changed,
        record(1, readingFingerprint("Second sentence. ")),
        "sentence",
      ),
    ).toBeUndefined();
  });
  it("rejects changed anchoring sentence", () => {
    expect(
      resolveReadingPosition(opts, record(1, "Wrong sentence"), "sentence"),
    ).toBeUndefined();
  });
  it("rejects out-of-range chunk", () => {
    expect(
      resolveReadingPosition(opts, record(99, ""), "sentence"),
    ).toBeUndefined();
  });
  it("rejects corrupt and partial snapshots", () => {
    expect(
      validSnapshot({
        version: 1,
        generation: 10,
        latestKey: "x",
        readings: { x: {} },
      }),
    ).toBe(false);
    expect(
      validSnapshot({
        version: 1,
        generation: -1,
        latestKey: "",
        readings: {},
      }),
    ).toBe(false);
  });
  it("accepts a well-formed checkpoint snapshot", () => {
    const item = record(0, readingFingerprint("First sentence. "));
    const key = readingKey(item.path, item.start, item.end, item.fingerprint);
    expect(
      validSnapshot({
        version: 1,
        generation: 12,
        latestKey: key,
        readings: { [key]: item },
      }),
    ).toBe(true);
  });
  it("writes redundant checkpoints and restores across plugin instances", async () => {
    const storage = new Map<string, string>();
    const adapter = {
      read: vi.fn(async (path: string) => {
        const data = storage.get(path);
        if (!data) throw new Error("not found");
        return data;
      }),
      exists: vi.fn(async (path: string) => storage.has(path)),
      write: vi.fn(async (path: string, data: string) => {
        storage.set(path, data);
      }),
    } as unknown as DataAdapter;
    const app = { vault: { configDir: ".obsidian" } } as unknown as App;
    const player = mobx.observable({
      activeText: null as unknown,
    }) as unknown as AudioStore;
    const settings = {
      settings: { chunkType: "sentence" },
    } as unknown as TTSPluginSettingsStore;
    const progress = new ReadingProgress(
      app,
      adapter,
      player,
      settings,
      "aloud-ios-fork",
    );
    await progress.load();
    progress.start();
    const audio = buildTrack(opts, "sentence");
    const track = mobx.observable({ audio, position: 0, isPlaying: true });
    mobx.runInAction(() => {
      player.activeText = track as unknown as AudioStore["activeText"];
    });
    mobx.runInAction(() => {
      track.position = 2;
    });
    await progress.stop();
    expect(adapter.write).toHaveBeenCalled();
    expect(
      [...storage.keys()].some((path) => path.includes("reading-progress.")),
    ).toBe(true);
    const restored = new ReadingProgress(
      app,
      adapter,
      player,
      settings,
      "aloud-ios-fork",
    );
    await restored.load();
    expect(restored.positionFor(opts)).toBe(1);
    for (let attempt = 0; attempt < 3; attempt++) {
      mobx.runInAction(() => {
        track.position = restored.positionFor(opts)!;
      });
      restored.start();
      await restored.stop();
      expect(restored.positionFor(opts)).toBe(1);
    }
    // Corrupt the latest slot; the prior generation must remain recoverable.
    const keys = [...storage.keys()];
    const snapshots = keys.map((key) => ({
      key,
      state: JSON.parse(storage.get(key)!),
    }));
    const newest = snapshots.sort(
      (a, b) => b.state.generation - a.state.generation,
    )[0];
    storage.set(newest.key, "{truncated");
    const fallback = new ReadingProgress(
      app,
      adapter,
      player,
      settings,
      "aloud-ios-fork",
    );
    await fallback.load();
    expect(fallback.latest?.path).toBe(opts.sourcePath);
  });
});

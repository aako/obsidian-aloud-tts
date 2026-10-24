import { afterEach, describe, expect, it, vi } from "vitest";
import type { DataAdapter } from "obsidian";
import type { AudioSystem, AudioData, TTSModelOptions } from "open-tts";
import { ArticleCache } from "./ArticleCache";
import { PersistentVaultCache } from "./PersistentVaultCache";

const text =
  "A sufficiently long opening sentence about persistent reading. Another long sentence about offline listening.";

function fixture() {
  const files = new Map<string, string>();
  const folders = new Set<string>();
  const adapter = {
    exists: vi.fn(async (path: string) => folders.has(path) || files.has(path)),
    mkdir: vi.fn(async (path: string) => {
      folders.add(path);
    }),
    write: vi.fn(async (path: string, data: string) => {
      files.set(path, data);
    }),
    read: vi.fn(async (path: string) => {
      const data = files.get(path);
      if (data === undefined) throw new Error("unavailable");
      return data;
    }),
    list: vi.fn(async (path: string) => ({
      files: [...files.keys()].filter((key) => key.startsWith(`${path}/`)),
      folders: [],
    })),
  } as unknown as DataAdapter;
  const options: TTSModelOptions = { model: "test-voice", voice: "reader" };
  const cached = new Map<string, AudioData>();
  const call = vi.fn(
    async (): Promise<AudioData> => ({
      data: new Uint8Array([0xff, 0xfb, 0, 0]).buffer as ArrayBuffer,
      format: "mp3",
    }),
  );
  const storage = {
    getAudio: vi.fn(async (chunk: string) => cached.get(chunk) ?? null),
    saveAudio: vi.fn(
      async (chunk: string, _settings: TTSModelOptions, audio: AudioData) => {
        cached.set(chunk, audio);
      },
    ),
  };
  const system = {
    settings: {
      modelProvider: "openai",
      chunkType: "sentence",
      azureMonthlyBudget: 450000,
      cacheDurationMillis: 604800000,
    },
    config: { backgroundLoaderIntervalMillis: 1000 },
    ttsModel: { convertToOptions: () => options, call },
    storage,
    audioStore: { activeText: null },
  } as unknown as AudioSystem;
  const vault = new PersistentVaultCache(
    adapter,
    () => "_Aloud Audio Cache",
    () => 500,
  );
  vi.spyOn(vault, "saveAudio").mockResolvedValue(undefined);
  const manager = new ArticleCache(system, vault, async () => text);
  return { manager, adapter, call, files, cached };
}

const managers: ArticleCache[] = [];
afterEach(async () => {
  await Promise.all(managers.splice(0).map((m) => m.stop()));
});

describe("article pre-caching", () => {
  it("plans a complete article without calling the speech provider", async () => {
    const { manager, call } = fixture();
    managers.push(manager);
    const job = await manager.prepare({
      text,
      filename: "Article.md",
      sourcePath: "Article.md",
      start: 0,
      end: text.length,
    });
    expect(job.id).toMatch(/^[a-f0-9]+$/);
    const estimate = await manager.estimate(job);
    expect(estimate.missing).toBeGreaterThan(0);
    expect(estimate.characters).toBeGreaterThan(0);
    expect(estimate.persistentCached).toBe(0);
    expect(estimate.localOnlyCached).toBe(0);
    expect(call).not.toHaveBeenCalled();
    expect(job.state).toBe("paused");
  });

  it("reuses synthesized chunks and restores a paused job from metadata", async () => {
    const { manager, call, adapter, cached } = fixture();
    managers.push(manager);
    const job = await manager.prepare({
      text,
      filename: "Article.md",
      sourcePath: "Article.md",
      start: 0,
      end: text.length,
    });
    await manager.start(job);
    expect(job.state).toBe("complete");
    expect(cached.size).toBeGreaterThan(0);
    // The fixture deliberately simulates local playback storage while its
    // persistent vault save is a no-op. Do not report these as iCloud-saved.
    const verified = await manager.estimate(job);
    expect(verified.cached).toBeGreaterThan(0);
    expect(verified.persistentCached).toBe(0);
    expect(verified.localOnlyCached).toBe(verified.cached);
    const calls = call.mock.calls.length;
    await manager.start(job);
    expect(call).toHaveBeenCalledTimes(calls);
    const second = new ArticleCache(
      manager.system,
      new PersistentVaultCache(
        adapter,
        () => "_Aloud Audio Cache",
        () => 500,
      ),
      async () => text,
    );
    managers.push(second);
    await second.load();
    expect(second.jobs).toHaveLength(1);
    expect(second.jobs[0].state).toBe("complete");
  });
});

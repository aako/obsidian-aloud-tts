import { afterEach, describe, expect, it, vi } from "vitest";
import type { DataAdapter } from "obsidian";
import type { AudioData, AudioSystem, TTSModelOptions } from "open-tts";
import { ArticleCache } from "./ArticleCache";
import { PersistentVaultCache } from "./PersistentVaultCache";

const text =
  "An introductory sentence about sharing audiobooks. Another sentence to test that cached audio is reused.";
const managers: ArticleCache[] = [];
afterEach(async () => {
  await Promise.all(managers.splice(0).map((m) => m.stop()));
});

function fixture() {
  const files = new Map<string, string>();
  const binary = new Map<string, ArrayBuffer>();
  const folders = new Set<string>();
  const adapter = {
    exists: vi.fn(
      async (name: string) =>
        files.has(name) || binary.has(name) || folders.has(name),
    ),
    mkdir: vi.fn(async (name: string) => {
      folders.add(name);
    }),
    write: vi.fn(async (name: string, value: string) => {
      files.set(name, value);
    }),
    writeBinary: vi.fn(async (name: string, value: ArrayBuffer) => {
      binary.set(name, value);
    }),
    stat: vi.fn(async (name: string) => ({
      size: binary.get(name)?.byteLength ?? 0,
    })),
    rename: vi.fn(async (before: string, after: string) => {
      const value = binary.get(before);
      if (value) {
        binary.set(after, value);
        binary.delete(before);
      }
    }),
  } as unknown as DataAdapter;
  const call = vi.fn();
  const options: TTSModelOptions = { model: "test", voice: "reader" };
  const system = {
    settings: {
      modelProvider: "openai",
      chunkType: "sentence",
      azureMonthlyBudget: 450000,
    },
    config: { backgroundLoaderIntervalMillis: 1000 },
    ttsModel: { convertToOptions: () => options, call },
    audioStore: { activeText: null },
    storage: { getAudio: vi.fn(), saveAudio: vi.fn() },
  } as unknown as AudioSystem;
  const vault = new PersistentVaultCache(
    adapter,
    () => "_Aloud Audio Cache",
    () => 1024,
  );
  const manager = new ArticleCache(system, vault, async () => text);
  managers.push(manager);
  return { manager, vault, adapter, call, binary };
}

describe("native multipart MP3 ZIP export from verified cache", () => {
  it("writes a single ZIP of verified MP3 files without invoking a synthesis provider", async () => {
    const { manager, vault, call, binary } = fixture();
    const job = await manager.prepare({
      text,
      filename: "Article.md",
      sourcePath: "Article.md",
      start: 0,
      end: text.length,
    });
    job.chunks.forEach((chunk) => {
      chunk.state = "cached";
    });
    job.state = "complete";
    const fragment: AudioData = {
      data: new Uint8Array([255, 251, 144, 1]).buffer,
      format: "mp3",
    };
    vi.spyOn(vault, "getAudio").mockResolvedValue(fragment);
    const destination = await manager.exportNativeAudio(job, "aloud");
    expect(destination).toMatch(/^aloud\/Article-[a-f0-9]+-cached-audio\.zip$/);
    expect(binary.get(destination)?.byteLength).toBeGreaterThan(0);
    expect(call).not.toHaveBeenCalled();
  });

  it("refuses missing chunks without writing a partial MP3", async () => {
    const { manager, vault, adapter, binary } = fixture();
    const job = await manager.prepare({
      text,
      filename: "Article.md",
      sourcePath: "Article.md",
      start: 0,
      end: text.length,
    });
    job.chunks.forEach((chunk) => {
      chunk.state = "cached";
    });
    job.state = "complete";
    vi.spyOn(vault, "getAudio").mockResolvedValue(null);
    await expect(manager.exportNativeAudio(job, "aloud")).rejects.toThrow(
      "not fully available",
    );
    expect(adapter.writeBinary).not.toHaveBeenCalled();
    expect(binary.size).toBe(0);
  });
});

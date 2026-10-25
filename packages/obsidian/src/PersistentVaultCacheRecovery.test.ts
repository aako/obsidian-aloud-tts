import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { DataAdapter } from "obsidian";
import { hashAudioInputs } from "open-tts";
import { PersistentVaultCache } from "./PersistentVaultCache";

const folder = "_Aloud Audio Cache";
const options = { model: "simba-3.2", voice: "geffen_32" };
const audio = new Uint8Array([0xff, 0xfb, 0x90, 0x01]).buffer as ArrayBuffer;
const otherAudio = new Uint8Array([0xff, 0xfb, 0x91, 0x01])
  .buffer as ArrayBuffer;
const checksum = (bytes: ArrayBuffer): string =>
  createHash("sha256").update(new Uint8Array(bytes)).digest("hex");

function fixture() {
  const textFiles = new Map<string, string>();
  const binaries = new Map<string, ArrayBuffer>();
  const list = vi.fn(async () => ({
    files: [...binaries.keys(), ...textFiles.keys()],
    folders: [],
  }));
  const adapter = {
    exists: vi.fn(
      async (path: string) =>
        path === folder || textFiles.has(path) || binaries.has(path),
    ),
    read: vi.fn(async (path: string) => {
      const value = textFiles.get(path);
      if (value === undefined) throw new Error("missing text");
      return value;
    }),
    write: vi.fn(async (path: string, value: string) => {
      textFiles.set(path, value);
    }),
    readBinary: vi.fn(async (path: string) => {
      const bytes = binaries.get(path);
      if (!bytes) throw new Error("not downloaded");
      return bytes.slice(0);
    }),
    list,
  } as unknown as DataAdapter;
  const cache = new PersistentVaultCache(
    adapter,
    () => folder,
    () => 100,
  );
  return { textFiles, binaries, adapter, cache, list };
}

function addFinal(
  files: Map<string, ArrayBuffer>,
  text: string,
  bytes: ArrayBuffer,
  filenameDigest = checksum(bytes),
): string {
  const key = hashAudioInputs(text, options, "mp3");
  const name = `${key}-${filenameDigest}.mp3`;
  files.set(`${folder}/${name}`, bytes);
  return key;
}

describe("restart recovery of already-written vault audio", () => {
  it("adopts a finalized checksum-valid MP3 with missing metadata, without synthesizing", async () => {
    const { binaries, textFiles, cache, adapter } = fixture();
    const key = addFinal(binaries, "Sentence with paid audio", audio);
    expect(
      await cache.getAudio("Sentence with paid audio", options, "mp3"),
    ).toEqual({ format: "mp3", data: audio });
    const reference = JSON.parse(
      textFiles.get(`${folder}/${key}.a.json`) ?? "",
    );
    expect(reference.value).toEqual({
      file: `${key}-${checksum(audio)}.mp3`,
      digest: checksum(audio),
      size: audio.byteLength,
    });
    expect(textFiles.has(`${folder}/${key}.b.json`)).toBe(true);
    const fresh = new PersistentVaultCache(
      adapter,
      () => folder,
      () => 100,
    );
    expect(
      await fresh.getAudio("Sentence with paid audio", options, "mp3"),
    ).toEqual({ format: "mp3", data: audio });
  });

  it("refuses ambiguous orphan MP3 candidates, without modifying either", async () => {
    const { binaries, textFiles, cache } = fixture();
    const key = addFinal(binaries, "Ambiguous", audio);
    addFinal(binaries, "Ambiguous", otherAudio);
    await expect(cache.getAudio("Ambiguous", options, "mp3")).rejects.toThrow(
      "Multiple unreferenced",
    );
    expect(textFiles.has(`${folder}/${key}.a.json`)).toBe(false);
    expect(binaries.size).toBe(2);
  });

  it("fails closed on digest mismatch or unavailable iCloud binary", async () => {
    const first = fixture();
    addFinal(first.binaries, "Corrupt", audio, checksum(otherAudio));
    await expect(
      first.cache.getAudio("Corrupt", options, "mp3"),
    ).rejects.toThrow("No automatic paid regeneration");
    expect(first.textFiles.size).toBe(0);

    const second = fixture();
    addFinal(second.binaries, "Not downloaded", audio);
    vi.spyOn(second.adapter, "readBinary").mockRejectedValueOnce(
      new Error("iCloud placeholder"),
    );
    await expect(
      second.cache.getAudio("Not downloaded", options, "mp3"),
    ).rejects.toThrow("No automatic paid regeneration");
  });

  it("does not synthesize when only a crashed temporary file remains", async () => {
    const { binaries, cache } = fixture();
    const key = hashAudioInputs("Unfinished", options, "mp3");
    binaries.set(
      `${folder}/${key}-${checksum(audio)}.mp3.1234-abcd.tmp`,
      audio,
    );
    await expect(cache.getAudio("Unfinished", options, "mp3")).rejects.toThrow(
      "unfinished vault audio write",
    );
    expect(binaries.size).toBe(1);
  });

  it("does not repeatedly list an entire iCloud folder for sequential cache misses", async () => {
    const { cache, list } = fixture();
    expect(await cache.getAudio("Not cached A", options, "mp3")).toBeNull();
    expect(await cache.getAudio("Not cached B", options, "mp3")).toBeNull();
    expect(await cache.getAudio("Not cached C", options, "mp3")).toBeNull();
    expect(list).toHaveBeenCalledTimes(1);
  });

  it("preserves a corrupt metadata fail-closed barrier rather than overriding it", async () => {
    const { binaries, textFiles, cache } = fixture();
    const key = addFinal(binaries, "Metadata unavailable", audio);
    textFiles.set(`${folder}/${key}.a.json`, "{not downloaded");
    await expect(
      cache.getAudio("Metadata unavailable", options, "mp3"),
    ).rejects.toThrow("metadata is unavailable or corrupt");
    expect(textFiles.get(`${folder}/${key}.a.json`)).toBe("{not downloaded");
  });
});

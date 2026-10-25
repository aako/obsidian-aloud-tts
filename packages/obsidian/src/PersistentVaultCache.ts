import type { DataAdapter } from "obsidian";
import {
  AudioCache,
  AudioData,
  MediaFormat,
  TTSModelOptions,
  hashAudioInputs,
} from "open-tts";

export function cacheFolder(value: string): string {
  const folder = value.trim().replace(/\/$/, "");
  if (
    !folder ||
    folder.startsWith("/") ||
    folder.split("/").some((part) => !part || part.startsWith(".")) ||
    /[\\:]/.test(folder)
  )
    throw new Error(
      "Choose an ordinary vault folder without dot-prefixed or parent path components.",
    );
  return folder;
}

export async function ensureFolder(
  adapter: DataAdapter,
  path: string,
): Promise<void> {
  const parts = path.split("/");
  for (let i = 1; i <= parts.length; i++) {
    const parent = parts.slice(0, i).join("/");
    if (!(await adapter.exists(parent))) await adapter.mkdir(parent);
  }
}

export async function readSnapshot<T>(
  adapter: DataAdapter,
  base: string,
  valid: (value: unknown) => value is T,
): Promise<{ generation: number; value: T } | undefined> {
  const candidates: { generation: number; value: T }[] = [];
  let exists = false;
  for (const slot of ["a", "b"]) {
    const path = `${base}.${slot}.json`;
    if (!(await adapter.exists(path))) continue;
    exists = true;
    try {
      const parsed: unknown = JSON.parse(await adapter.read(path));
      if (
        parsed &&
        typeof parsed === "object" &&
        "generation" in parsed &&
        typeof parsed.generation === "number" &&
        Number.isSafeInteger(parsed.generation) &&
        parsed.generation >= 0 &&
        "value" in parsed &&
        valid(parsed.value)
      )
        candidates.push({ generation: parsed.generation, value: parsed.value });
    } catch {
      /* An interrupted or not-yet-downloaded slot can use its peer. */
    }
  }
  if (exists && !candidates.length)
    throw new Error(
      "Cache metadata is unavailable or corrupt. Finish iCloud download and retry; no provider request was sent.",
    );
  return candidates.sort((a, b) => b.generation - a.generation)[0];
}

export async function writeSnapshot(
  adapter: DataAdapter,
  base: string,
  generation: number,
  value: unknown,
): Promise<void> {
  await adapter.write(
    `${base}.${generation % 2 ? "a" : "b"}.json`,
    JSON.stringify({ generation, value }),
  );
}

async function digest(data: ArrayBuffer): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", data)))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

interface ChunkReference {
  file: string;
  size: number;
  digest: string;
}

interface RecoveryIndex {
  complete: Map<string, ChunkReference[]>;
  unfinished: Set<string>;
}

function validReference(value: unknown): value is ChunkReference {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<ChunkReference>;
  return (
    typeof item.file === "string" &&
    /^[a-f0-9]+-[a-f0-9]{64}\.mp3$/.test(item.file) &&
    typeof item.size === "number" &&
    item.size > 0 &&
    typeof item.digest === "string" &&
    /^[a-f0-9]{64}$/.test(item.digest)
  );
}

/** Permanent read-through storage; expiry never removes article audio. */
export class PersistentVaultCache implements AudioCache {
  // Coordinate automatic playback saves with explicit article-precache saves.
  // One instance per vault avoids duplicate hash-named writes and quota races.
  private saveTail: Promise<void> = Promise.resolve();
  /** Scan once for many sequential misses; refresh for later iCloud changes. */
  private recoveryScan?: {
    folder: string;
    startedAt: number;
    result: Promise<RecoveryIndex>;
  };

  private async orphanIndex(folder: string): Promise<RecoveryIndex> {
    const now = Date.now();
    if (
      !this.recoveryScan ||
      this.recoveryScan.folder !== folder ||
      now - this.recoveryScan.startedAt >= 60_000
    ) {
      const result = (async (): Promise<RecoveryIndex> => {
        const complete = new Map<string, ChunkReference[]>();
        const unfinished = new Set<string>();
        if (!(await this.adapter.exists(folder)))
          return { complete, unfinished };
        const listing = await this.adapter.list(folder);
        for (const path of listing.files) {
          if (!path.startsWith(`${folder}/`)) continue;
          const name = path.slice(folder.length + 1);
          const final = /^([a-f0-9]+)-([a-f0-9]{64})\.mp3$/.exec(name);
          if (final) {
            const previous = complete.get(final[1]) ?? [];
            previous.push({ file: name, digest: final[2], size: 0 });
            complete.set(final[1], previous);
          } else {
            // A crashed write may have left the binary in its .tmp stage.
            // Never assume an unfinished file is playable or issue paid TTS.
            const temporary =
              /^([a-f0-9]+)-[a-f0-9]{64}\.mp3\.[a-f0-9-]+\.tmp$/.exec(name);
            if (temporary) unfinished.add(temporary[1]);
          }
        }
        return { complete, unfinished };
      })();
      this.recoveryScan = { folder, startedAt: now, result };
    }
    return this.recoveryScan.result;
  }

  private async recoverOrphan(
    folder: string,
    key: string,
    format: MediaFormat,
  ): Promise<AudioData | null> {
    const candidates = await this.orphanIndex(folder);
    const found = candidates.complete.get(key) ?? [];
    if (found.length > 1)
      throw new Error(
        "Multiple unreferenced audio files exist for this chunk. No automatic paid regeneration; inspect the vault cache.",
      );
    if (!found.length) {
      if (candidates.unfinished.has(key))
        throw new Error(
          "An unfinished vault audio write exists for this chunk. No automatic paid regeneration; inspect or restore the cache.",
        );
      return null;
    }

    const reference = found[0];
    let data: ArrayBuffer;
    try {
      data = await this.adapter.readBinary(`${folder}/${reference.file}`);
      if (!data.byteLength || (await digest(data)) !== reference.digest)
        throw new Error("checksum mismatch");
    } catch {
      throw new Error(
        "Unreferenced vault audio is incomplete or unavailable from iCloud. No automatic paid regeneration.",
      );
    }

    // Another device could have synchronized metadata during our checksum read.
    // In that case verify the authoritative metadata rather than overwrite it.
    const base = `${folder}/${key}`;
    const existing = await readSnapshot(this.adapter, base, validReference);
    if (existing) {
      const saved = await this.adapter.readBinary(
        `${folder}/${existing.value.file}`,
      );
      if (
        saved.byteLength !== existing.value.size ||
        (await digest(saved)) !== existing.value.digest
      )
        throw new Error(
          "Synced audio metadata refers to unavailable audio. No automatic paid regeneration.",
        );
      return { data: saved, format };
    }
    const restored = {
      file: reference.file,
      size: data.byteLength,
      digest: reference.digest,
    };
    await writeSnapshot(this.adapter, base, 1, restored);
    await writeSnapshot(this.adapter, base, 2, restored);
    return { data, format };
  }

  constructor(
    readonly adapter: DataAdapter,
    private folderSetting: () => string,
    private limitMB: () => number,
  ) {}
  get folder(): string {
    return cacheFolder(this.folderSetting());
  }

  async getAudio(
    text: string,
    settings: TTSModelOptions,
    format: MediaFormat,
  ): Promise<AudioData | null> {
    if (format !== "mp3") return null;
    const key = hashAudioInputs(text, settings, format);
    const folder = this.folder;
    const saved = await readSnapshot(
      this.adapter,
      `${folder}/${key}`,
      validReference,
    );
    if (!saved) return this.recoverOrphan(folder, key, format);
    try {
      const data = await this.adapter.readBinary(
        `${folder}/${saved.value.file}`,
      );
      if (
        data.byteLength !== saved.value.size ||
        (await digest(data)) !== saved.value.digest
      )
        throw new Error("checksum mismatch");
      return { data, format };
    } catch {
      throw new Error(
        "Cached audio is missing, corrupt, or awaiting iCloud download. Download the cache folder and retry. No automatic paid regeneration.",
      );
    }
  }

  saveAudio(
    text: string,
    settings: TTSModelOptions,
    audio: AudioData,
  ): Promise<void> {
    const task = this.saveTail.then(() =>
      this.writeAudio(text, settings, audio),
    );
    this.saveTail = task.catch(() => undefined);
    return task;
  }

  private async writeAudio(
    text: string,
    settings: TTSModelOptions,
    audio: AudioData,
  ): Promise<void> {
    if (audio.format !== "mp3" || !audio.data.byteLength)
      throw new Error("Invalid cached audio.");
    const folder = this.folder;
    const key = hashAudioInputs(text, settings, audio.format);
    const existing = await readSnapshot(
      this.adapter,
      `${folder}/${key}`,
      validReference,
    );
    if (existing) {
      await this.getAudio(text, settings, audio.format);
      return;
    }
    if (
      (await this.getStorageSize()) + audio.data.byteLength >
      this.limitMB() * 1024 * 1024
    )
      throw new Error(
        "Persistent cache size limit reached. Delete selected cached audio or increase the limit; nothing was evicted.",
      );
    await ensureFolder(this.adapter, folder);
    const checksum = await digest(audio.data);
    const file = `${key}-${checksum}.mp3`;
    const target = `${folder}/${file}`;
    if (!(await this.adapter.exists(target))) {
      const temporary = `${target}.${crypto.randomUUID()}.tmp`;
      await this.adapter.writeBinary(temporary, audio.data);
      if ((await digest(await this.adapter.readBinary(temporary))) !== checksum)
        throw new Error("Cache write verification failed.");
      await this.adapter.rename(temporary, target);
    }
    const reference = { file, size: audio.data.byteLength, digest: checksum };
    await writeSnapshot(this.adapter, `${folder}/${key}`, 1, reference);
    await writeSnapshot(this.adapter, `${folder}/${key}`, 2, reference);
  }

  async expire(): Promise<void> {
    /* Persistent cache is removed only by explicit user action. */
  }

  async getStorageSize(): Promise<number> {
    if (!(await this.adapter.exists(this.folder))) return 0;
    const listed = await this.adapter.list(this.folder);
    let total = 0;
    for (const file of listed.files)
      total += (await this.adapter.stat(file))?.size ?? 0;
    return total;
  }

  async removeChunks(keys: string[]): Promise<void> {
    if (!(await this.adapter.exists(this.folder))) return;
    const files = (await this.adapter.list(this.folder)).files;
    for (const key of keys) {
      if (!/^[a-f0-9]+$/.test(key)) throw new Error("Invalid cache reference.");
      for (const path of files) {
        const name = path.slice(this.folder.length + 1);
        if (
          path.startsWith(`${this.folder}/`) &&
          (name === `${key}.a.json` ||
            name === `${key}.b.json` ||
            new RegExp(`^${key}-[a-f0-9]{64}\\.mp3$`).test(name))
        )
          await this.adapter.remove(path);
      }
    }
  }
}

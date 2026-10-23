import * as mobx from "mobx";
import { zippedMP3Chunks } from "./CachedAudioZip";
import {
  AudioSystem,
  AudioTextOptions,
  ChunkLoader,
  azureCharacters,
  azureRequestGate,
  googleChirpRequestGate,
  speechifyRequestGate,
  speechifyCharacters,
  googleChirpCharacters,
  buildTrack,
  hashAudioInputs,
  readingFingerprint,
  voiceHash,
} from "open-tts";
import {
  PersistentVaultCache,
  ensureFolder,
  readSnapshot,
  cacheFolder,
  writeSnapshot,
} from "./PersistentVaultCache";

export interface ArticleJob {
  id: string;
  path: string;
  start: number;
  end: number;
  fingerprint: string;
  voice: string;
  chunkType: "sentence" | "paragraph";
  chunks: {
    key: string;
    size: number;
    state: "missing" | "cached" | "failed";
  }[];
  state: "paused" | "running" | "waiting" | "cancelled" | "complete" | "failed";
  message: string;
  generation: number;
}

export interface CacheEstimate {
  characters: number;
  cached: number;
  missing: number;
  requests: number;
  additionalCharacters: number;
  approximateBytes: number;
  remaining: number;
  exceedsBudget: boolean;
}

function validJob(value: unknown): value is ArticleJob {
  if (!value || typeof value !== "object") return false;
  const job = value as ArticleJob;
  return (
    typeof job.id === "string" &&
    /^[a-f0-9]+$/.test(job.id) &&
    typeof job.path === "string" &&
    typeof job.fingerprint === "string" &&
    typeof job.voice === "string" &&
    Number.isSafeInteger(job.start) &&
    job.start >= 0 &&
    Number.isSafeInteger(job.end) &&
    job.end >= job.start &&
    ["sentence", "paragraph"].includes(job.chunkType) &&
    Array.isArray(job.chunks) &&
    job.chunks.every(
      (chunk) =>
        chunk &&
        /^[a-f0-9]+$/.test(chunk.key) &&
        Number.isFinite(chunk.size) &&
        chunk.size >= 0 &&
        ["missing", "cached", "failed"].includes(chunk.state),
    ) &&
    Number.isSafeInteger(job.generation) &&
    job.generation >= 0
  );
}

export class ArticleCache {
  jobs: ArticleJob[] = [];
  private busy = false;
  private stopped = false;
  private writes: Promise<void> = Promise.resolve();
  private loader: ChunkLoader;
  private requestController?: AbortController;
  get isBusy(): boolean {
    return this.busy;
  }
  constructor(
    readonly system: AudioSystem,
    readonly vault: PersistentVaultCache,
    private readNote: (path: string) => Promise<string>,
  ) {
    this.loader = new ChunkLoader({ system });
    mobx.makeObservable(this, { jobs: mobx.observable });
  }

  async load(): Promise<void> {
    if (this.busy) throw new Error("Wait for the current chunk to finish.");
    this.stopped = false;
    mobx.runInAction(() => {
      this.jobs = [];
    });
    if (!(await this.vault.adapter.exists(this.vault.folder))) return;
    const files = (await this.vault.adapter.list(this.vault.folder)).files;
    const bases = new Set(
      files
        .filter((file) => /\/article-[a-f0-9]+\.[ab]\.json$/.test(file))
        .map((file) => file.replace(/\.[ab]\.json$/, "")),
    );
    for (const base of bases) {
      const saved = await readSnapshot(this.vault.adapter, base, validJob);
      if (saved)
        mobx.runInAction(() =>
          this.jobs.push({
            ...saved.value,
            state: saved.value.state === "complete" ? "complete" : "paused",
            message: "Verify downloaded files before resuming.",
          }),
        );
    }
  }

  private async options(job: ArticleJob): Promise<AudioTextOptions> {
    const text = (await this.readNote(job.path)).slice(job.start, job.end);
    if (readingFingerprint(text) !== job.fingerprint)
      throw new Error(
        "Article changed. Create a new estimate; this job was not regenerated.",
      );
    const voice = this.voice();
    if (voice !== job.voice || this.system.settings.chunkType !== job.chunkType)
      throw new Error(
        "Voice or chunk settings changed. Restore the original settings or create a new estimate.",
      );
    return {
      filename: job.path,
      sourcePath: job.path,
      start: job.start,
      end: job.end,
      text,
    };
  }

  /** Validate the exact note and voice before starting playback or export. */
  playbackOptions(job: ArticleJob): Promise<AudioTextOptions> {
    return this.options(job);
  }

  /** Export only verified cached bytes. Absolutely no network synthesis requests. */
  async exportNativeAudio(job: ArticleJob, directory: string): Promise<string> {
    if (job.state !== "complete")
      throw new Error("Finish caching all chunks before exporting.");
    const options = await this.options(job);
    const chunks = buildTrack(options, job.chunkType).chunks;
    if (job.chunks.length !== chunks.length)
      throw new Error("Article chunk structure has changed.");
    const voiceOptions = this.system.ttsModel.convertToOptions(
      this.system.settings,
    );
    const parts: ArrayBuffer[] = [];
    for (const [index, chunk] of chunks.entries()) {
      if (
        job.chunks[index].key !==
        hashAudioInputs(chunk.text, voiceOptions, "mp3")
      )
        throw new Error(
          "The cached voice or chunk identity changed. No export written.",
        );
      const cached = await this.vault.getAudio(chunk.text, voiceOptions, "mp3");
      if (!cached)
        throw new Error(
          "One or more chunks are not fully available offline. No export written.",
        );
      parts.push(cached.data);
    }
    // Preserve independently encoded MP3 files; do not concatenate MP3 bitstreams.
    const zipped = zippedMP3Chunks(parts);
    const folder = cacheFolder(directory);
    const name =
      (job.path.split("/").pop() ?? "Article")
        .replace(/\.md$/i, "")
        .replace(/[^a-zA-Z0-9_-]/g, "-")
        .slice(0, 70) || "Article";
    const target = `${folder}/${name}-${job.id}-cached-audio.zip`;
    if (await this.vault.adapter.exists(target))
      throw new Error(
        "A cached export with this name already exists; nothing was overwritten.",
      );
    await ensureFolder(this.vault.adapter, folder);
    const temp = `${target}.${crypto.randomUUID()}.tmp`;
    try {
      await this.vault.adapter.writeBinary(temp, zipped);
      const stat = await this.vault.adapter.stat(temp);
      if (stat?.size !== zipped.byteLength)
        throw new Error("Cached MP3 export write verification failed.");
      await this.vault.adapter.rename(temp, target);
    } catch (error) {
      if (await this.vault.adapter.exists(temp))
        await this.vault.adapter.remove(temp);
      throw error;
    }
    return target;
  }

  private voice(): string {
    return `${this.system.settings.modelProvider}:${voiceHash(this.system.ttsModel.convertToOptions(this.system.settings))}`;
  }

  async prepare(opts: AudioTextOptions): Promise<ArticleJob> {
    if (!opts.sourcePath)
      throw new Error("Save the note before pre-caching it.");
    if (!opts.text.trim()) throw new Error("This note has no readable text.");
    const fingerprint = readingFingerprint(opts.text);
    const voice = this.voice();
    const id = hashAudioInputs(
      JSON.stringify([
        opts.sourcePath,
        opts.start,
        opts.end,
        fingerprint,
        voice,
        this.system.settings.chunkType,
      ]),
      { model: "article-job-v1" },
      "mp3",
    );
    const existing = this.jobs.find((job) => job.id === id);
    if (existing) return existing;
    const options = this.system.ttsModel.convertToOptions(this.system.settings);
    const chunks = buildTrack(opts, this.system.settings.chunkType).chunks.map(
      (chunk) => ({
        key: hashAudioInputs(chunk.text, options, "mp3"),
        size: 0,
        state: "missing" as const,
      }),
    );
    const job: ArticleJob = {
      id,
      path: opts.sourcePath,
      start: opts.start,
      end: opts.end,
      fingerprint,
      voice,
      chunkType: this.system.settings.chunkType,
      chunks,
      state: "paused",
      message: "Estimate only; no synthesis requested.",
      generation: 0,
    };
    mobx.runInAction(() => this.jobs.push(job));
    const stored = this.jobs[this.jobs.length - 1];
    await this.save(stored);
    return stored;
  }

  async estimate(job: ArticleJob): Promise<CacheEstimate> {
    const opts = await this.options(job);
    const chunks = buildTrack(opts, job.chunkType).chunks;
    const options = this.system.ttsModel.convertToOptions(this.system.settings);
    let cached = 0,
      characters = 0,
      additionalCharacters = 0,
      bytes = 0;
    const missingKeys = new Set<string>();
    for (const [index, chunk] of chunks.entries()) {
      const count =
        this.system.settings.modelProvider === "google_chirp"
          ? googleChirpCharacters(chunk.text)
          : this.system.settings.modelProvider === "speechify"
            ? speechifyCharacters(chunk.text)
            : azureCharacters(chunk.text);
      characters += count;
      const audio = await this.system.storage.getAudio(
        chunk.text,
        options,
        "mp3",
      );
      if (audio) {
        cached++;
        bytes += audio.data.byteLength;
      } else if (!missingKeys.has(job.chunks[index].key)) {
        additionalCharacters += count;
        missingKeys.add(job.chunks[index].key);
      }
    }
    const google = this.system.settings.modelProvider === "google_chirp";
    const azure = this.system.settings.modelProvider === "azure";
    const speechify = this.system.settings.modelProvider === "speechify";
    const gate = speechify
      ? speechifyRequestGate
      : google
        ? googleChirpRequestGate
        : azureRequestGate;
    const budget = speechify
      ? this.system.settings.speechifyMonthlyBudget
      : google
        ? this.system.settings.googleChirpMonthlyBudget
        : this.system.settings.azureMonthlyBudget;
    const remaining = Math.max(0, budget - gate.used);
    return {
      characters,
      cached,
      missing: chunks.length - cached,
      requests: azure || google || speechify ? missingKeys.size : 0,
      additionalCharacters,
      approximateBytes: bytes + additionalCharacters * 800,
      remaining,
      exceedsBudget:
        (azure || google || speechify) && additionalCharacters > remaining,
    };
  }

  async start(job: ArticleJob, consent = false): Promise<void> {
    if (this.busy)
      throw new Error("Pause the running article job before starting another.");
    this.busy = true;
    const controller = new AbortController();
    this.requestController = controller;
    try {
      const estimate = await this.estimate(job);
      if (estimate.exceedsBudget && !consent)
        throw new Error(
          "This job exceeds the local monthly budget. Explicit approval is required.",
        );
      const options = this.system.ttsModel.convertToOptions(
        this.system.settings,
      );
      const chunks = buildTrack(await this.options(job), job.chunkType).chunks;
      const google = this.system.settings.modelProvider === "google_chirp";
      const speechify = this.system.settings.modelProvider === "speechify";
      const gate = speechify
        ? speechifyRequestGate
        : google
          ? googleChirpRequestGate
          : azureRequestGate;
      const budget = speechify
        ? this.system.settings.speechifyMonthlyBudget
        : google
          ? this.system.settings.googleChirpMonthlyBudget
          : this.system.settings.azureMonthlyBudget;
      const limit = consent
        ? Math.max(budget, gate.used + estimate.additionalCharacters)
        : budget;
      mobx.runInAction(() => {
        job.state = "running";
        job.message = "Generating missing chunks.";
      });
      await this.save(job);
      for (const [index, chunk] of chunks.entries()) {
        if (this.stopped || !["running", "waiting"].includes(job.state)) break;
        await this.options(job);
        try {
          const cached = await this.system.storage.getAudio(
            chunk.text,
            options,
            "mp3",
          );
          const audio =
            cached ??
            (await this.loader.load(chunk.text, options, {
              textBefore: chunks
                .slice(Math.max(0, index - 3), index)
                .map((item) => item.text)
                .join(""),
              textAfter: chunks
                .slice(index + 1, index + 4)
                .map((item) => item.text)
                .join(""),
              request: {
                priority: "background",
                budgetLimit: limit,
                signal: controller.signal,
                onWait: () => {
                  mobx.runInAction(() => {
                    if (job.state === "running") {
                      job.state = "waiting";
                      job.message =
                        "Waiting for the provider request gate. Pause/cancel takes effect at this chunk boundary.";
                    }
                  });
                },
              },
            }));
          await this.vault.saveAudio(chunk.text, options, audio);
          mobx.runInAction(() => {
            job.chunks[index] = {
              key: job.chunks[index].key,
              state: "cached",
              size: audio.data.byteLength,
            };
            if (job.state === "waiting") job.state = "running";
          });
        } catch (error) {
          if (
            controller.signal.aborted ||
            job.state === "paused" ||
            job.state === "cancelled"
          )
            break;
          mobx.runInAction(() => {
            job.chunks[index].state = "failed";
            job.state = "failed";
            job.message =
              error instanceof Error ? error.message : "Chunk failed.";
          });
          await this.save(job);
          break;
        }
        await this.save(job);
      }
      if (job.chunks.every((chunk) => chunk.state === "cached"))
        mobx.runInAction(() => {
          job.state = "complete";
          job.message =
            "All chunks stored in the vault. Let iCloud finish downloading on the other device.";
        });
      await this.save(job);
    } catch (error) {
      mobx.runInAction(() => {
        job.state = "failed";
        job.message = error instanceof Error ? error.message : "Job failed.";
      });
      await this.save(job);
      throw error;
    } finally {
      this.busy = false;
      if (this.requestController === controller)
        this.requestController = undefined;
    }
  }

  async pause(job: ArticleJob, cancel = false): Promise<void> {
    this.requestController?.abort();
    mobx.runInAction(() => {
      job.state = cancel ? "cancelled" : "paused";
      job.message =
        "Stops after the current chunk. Completed audio is retained.";
    });
    await this.save(job);
  }

  async deleteAudio(job: ArticleJob): Promise<void> {
    if (this.busy)
      throw new Error(
        "Wait for the current chunk to finish before deleting audio.",
      );
    await this.vault.removeChunks(job.chunks.map((chunk) => chunk.key));
    mobx.runInAction(() => {
      for (const item of this.jobs)
        for (const chunk of item.chunks)
          if (job.chunks.some((target) => target.key === chunk.key)) {
            chunk.state = "missing";
            chunk.size = 0;
            item.state = "paused";
          }
    });
    for (const item of this.jobs) await this.save(item);
  }

  private save(job: ArticleJob): Promise<void> {
    mobx.runInAction(() => job.generation++);
    const data: ArticleJob = JSON.parse(JSON.stringify(job));
    const folder = this.vault.folder;
    this.writes = this.writes
      .catch(() => undefined)
      .then(async () => {
        await ensureFolder(this.vault.adapter, folder);
        await writeSnapshot(
          this.vault.adapter,
          `${folder}/article-${job.id}`,
          data.generation,
          data,
        );
      });
    return this.writes;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.requestController?.abort();
    this.loader.destroy();
    await this.writes;
  }

  destroy(): void {
    this.stopped = true;
    this.requestController?.abort();
    this.loader.destroy();
  }
}

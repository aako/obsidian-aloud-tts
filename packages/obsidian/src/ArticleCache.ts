import * as mobx from "mobx";
import {
  AudioSystem,
  AudioTextOptions,
  ChunkLoader,
  azureCharacters,
  azureRequestGate,
  buildTrack,
  hashAudioInputs,
  readingFingerprint,
  voiceHash,
} from "open-tts";
import {
  PersistentVaultCache,
  ensureFolder,
  readSnapshot,
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
      const count = azureCharacters(chunk.text);
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
    const remaining = Math.max(
      0,
      this.system.settings.azureMonthlyBudget - azureRequestGate.used,
    );
    const azure = this.system.settings.modelProvider === "azure";
    return {
      characters,
      cached,
      missing: chunks.length - cached,
      requests: azure ? missingKeys.size : 0,
      additionalCharacters,
      approximateBytes: bytes + additionalCharacters * 800,
      remaining,
      exceedsBudget: azure && additionalCharacters > remaining,
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
      const limit = consent
        ? Math.max(
            this.system.settings.azureMonthlyBudget,
            azureRequestGate.used + estimate.additionalCharacters,
          )
        : this.system.settings.azureMonthlyBudget;
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
                        "Waiting for the shared Azure rate limit. Pause/cancel takes effect at this chunk boundary.";
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

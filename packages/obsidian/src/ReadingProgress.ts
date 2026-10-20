import * as mobx from "mobx";
import { Notice } from "obsidian";
import type { App, DataAdapter } from "obsidian";
import {
  ActiveAudioText,
  AudioStore,
  AudioTextOptions,
  buildTrack,
  readingFingerprint,
  TTSPluginSettingsStore,
} from "open-tts";

// A sentence-boundary checkpoint is intentionally conservative: resuming may
// repeat a sentence, but cannot intentionally skip forward into unplayed audio.
export interface SavedReading {
  path: string;
  start: number;
  end: number;
  fingerprint: string;
  chunk: number;
  anchor: string;
  updatedAt: number;
}

export interface ProgressSnapshot {
  version: 1;
  generation: number;
  latestKey: string;
  readings: Record<string, SavedReading>;
}

export { readingFingerprint } from "open-tts";

export function readingKey(
  path: string,
  start: number,
  end: number,
  fingerprint: string,
): string {
  return JSON.stringify([path, start, end, fingerprint]);
}

export function validSnapshot(value: unknown): value is ProgressSnapshot {
  if (!value || typeof value !== "object") return false;
  const state = value as Partial<ProgressSnapshot>;
  if (
    state.version !== 1 ||
    !Number.isSafeInteger(state.generation) ||
    (state.generation ?? -1) < 0 ||
    typeof state.latestKey !== "string" ||
    !state.readings ||
    typeof state.readings !== "object" ||
    Array.isArray(state.readings)
  )
    return false;
  const keys = Object.keys(state.readings);
  if (keys.length > 100) return false;
  return keys.every((key) => {
    const item = state.readings![key];
    return (
      typeof key === "string" &&
      item !== null &&
      typeof item === "object" &&
      typeof item.path === "string" &&
      item.path.length > 0 &&
      Number.isSafeInteger(item.start) &&
      Number.isSafeInteger(item.end) &&
      item.start >= 0 &&
      item.end >= item.start &&
      typeof item.fingerprint === "string" &&
      Number.isSafeInteger(item.chunk) &&
      item.chunk >= 0 &&
      typeof item.anchor === "string" &&
      item.anchor.length <= 250 &&
      Number.isFinite(item.updatedAt)
    );
  });
}

export function resolveReadingPosition(
  opts: AudioTextOptions,
  saved: SavedReading | undefined,
  chunkType: "sentence" | "paragraph",
): number | undefined {
  if (
    !saved ||
    !opts.sourcePath ||
    saved.path !== opts.sourcePath ||
    saved.start !== opts.start ||
    saved.end !== opts.end ||
    saved.fingerprint !== readingFingerprint(opts.text)
  )
    return undefined;
  const chunks = buildTrack(opts, chunkType).chunks;
  if (!chunks[saved.chunk]) return undefined;
  if (readingFingerprint(chunks[saved.chunk].rawText) !== saved.anchor)
    return undefined;
  return saved.chunk;
}

const emptyState = (): ProgressSnapshot => ({
  version: 1,
  generation: 0,
  latestKey: "",
  readings: {},
});

export class ReadingProgress {
  private readonly files: [string, string];
  private state: ProgressSnapshot = emptyState();
  private active: ActiveAudioText | null = null;
  private disposeTrack?: mobx.IReactionDisposer;
  private disposeActive?: mobx.IReactionDisposer;
  private writeQueue: Promise<void> = Promise.resolve();
  private timer?: ReturnType<typeof setInterval>;
  private failed = false;
  private onVisibility = (): void => {
    if (document.visibilityState === "hidden") this.capture(true);
  };
  private onPageHide = (): void => this.capture(true);

  constructor(
    app: App,
    private adapter: DataAdapter,
    private player: AudioStore,
    private settings: TTSPluginSettingsStore,
    pluginId: string,
  ) {
    const dir = `${app.vault.configDir}/plugins/${pluginId}`;
    this.files = [
      `${dir}/reading-progress.a.json`,
      `${dir}/reading-progress.b.json`,
    ];
  }

  async load(): Promise<void> {
    const candidates: ProgressSnapshot[] = [];
    for (const file of this.files) {
      try {
        const parsed: unknown = JSON.parse(await this.adapter.read(file));
        if (validSnapshot(parsed)) candidates.push(parsed);
      } catch (error) {
        // Missing or interrupted slot: the other slot may be valid.
        if (await this.adapter.exists(file)) {
          console.warn("Aloud progress: unreadable checkpoint", file, error);
        }
      }
    }
    candidates.sort((a, b) => b.generation - a.generation);
    this.state = candidates[0] ?? emptyState();
  }

  start(): void {
    this.disposeActive = mobx.reaction(
      () => this.player.activeText,
      (active) => this.attach(active),
      { fireImmediately: true },
    );
    this.timer = setInterval(() => this.capture(false), 3000);
    document.addEventListener("visibilitychange", this.onVisibility);
    window.addEventListener("pagehide", this.onPageHide);
  }

  private attach(active: ActiveAudioText | null): void {
    this.capture(true);
    this.disposeTrack?.();
    this.disposeTrack = undefined;
    this.active = active;
    if (active) {
      this.disposeTrack = mobx.reaction(
        () => [active.position, active.isPlaying],
        () => this.capture(false),
      );
    }
  }

  get latest(): SavedReading | undefined {
    return this.state.readings[this.state.latestKey];
  }

  positionFor(opts: AudioTextOptions): number | undefined {
    if (!opts.sourcePath) return undefined;
    const fingerprint = readingFingerprint(opts.text);
    const key = readingKey(opts.sourcePath, opts.start, opts.end, fingerprint);
    return resolveReadingPosition(
      opts,
      this.state.readings[key],
      this.settings.settings.chunkType,
    );
  }

  private capture(force: boolean): void {
    const active = this.active;
    const audio = active?.audio;
    if (!active || !audio?.sourcePath || !audio.chunks.length) return;
    if (active.position < 0) return; // Keep prior checkpoint if ending falsely.
    const current = Math.min(active.position, audio.chunks.length - 1);
    const conservative = Math.max(0, current - 1);
    const chunk = audio.chunks[conservative];
    if (!chunk) return;
    const fingerprint = audio.sourceFingerprint;
    const start = audio.sourceStart;
    const end = audio.sourceEnd;
    if (!fingerprint || start == null || end == null) return;
    const key = readingKey(audio.sourcePath, start, end, fingerprint);
    const previous = this.state.readings[key];
    if (
      !force &&
      previous &&
      previous.chunk === conservative &&
      this.state.latestKey === key
    )
      return;
    this.state.readings[key] = {
      path: audio.sourcePath,
      start,
      end,
      fingerprint,
      chunk: conservative,
      anchor: readingFingerprint(chunk.rawText),
      updatedAt: Date.now(),
    };
    this.state.latestKey = key;
    const ordered = Object.keys(this.state.readings)
      .sort(
        (a, b) =>
          this.state.readings[b].updatedAt - this.state.readings[a].updatedAt,
      )
      .slice(0, 100);
    const trimmed: Record<string, SavedReading> = {};
    for (const recentKey of ordered) {
      trimmed[recentKey] = this.state.readings[recentKey];
    }
    this.state.readings = trimmed;
    this.state.generation += 1;
    const slot = this.files[this.state.generation % 2];
    const payload = JSON.stringify(this.state);
    this.writeQueue = this.writeQueue
      .then(() => this.adapter.write(slot, payload))
      .catch((error: unknown) => {
        console.error("Aloud progress: failed to save checkpoint", error);
        if (!this.failed) {
          this.failed = true;
          // Do not claim durability if vault writes fail.
          new Notice(
            "Aloud progress autosave failed; please check vault access.",
          );
        }
      });
  }

  async stop(): Promise<void> {
    this.capture(true);
    this.disposeTrack?.();
    this.disposeActive?.();
    clearInterval(this.timer);
    document.removeEventListener("visibilitychange", this.onVisibility);
    window.removeEventListener("pagehide", this.onPageHide);
    await this.writeQueue;
  }
}

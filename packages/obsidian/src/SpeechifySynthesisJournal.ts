import type { DataAdapter } from "obsidian";
import { hashAudioInputs, TTSErrorInfo, type TTSModelOptions } from "open-tts";
import { ensureFolder } from "./PersistentVaultCache";

/** A durable *possibility* of billing, not a provider billing receipt. */
export class SpeechifySynthesisNeedsReview extends TTSErrorInfo {
  constructor() {
    super(
      "Speechify synthesis may already have been charged before Aloud stopped. Cached audio is safe to play, but automatic paid regeneration is blocked for this chunk. Check the cache and explicitly approve any new request before resetting its recovery marker.",
    );
  }
  override get isRetryable(): boolean {
    return false;
  }
}

/**
 * A per-request marker lives in the plugin's Obsidian configuration folder.
 * It contains no article text, credentials or URLs, only a one-way hash and
 * timestamp. A partially written marker fails CLOSED on next startup.
 *
 * File sync between devices is not atomic. This journal protects requests
 * observed on this device and whatever marker files have fully synced; it is
 * not a cross-device distributed lock or a guarantee about provider billing.
 */
export class SpeechifySynthesisJournal {
  private active = new Set<string>();

  constructor(
    private readonly adapter: DataAdapter,
    private readonly folder: string,
  ) {}

  private async filename(
    text: string,
    options: TTSModelOptions,
  ): Promise<string> {
    // Including credential material in the digest input distinguishes accounts,
    // while never saving or displaying credentials themselves.
    const identity = JSON.stringify({
      provider: "speechify",
      audio: hashAudioInputs(text, options, "mp3"),
      credential: options.apiKey ?? "",
    });
    const data = new TextEncoder().encode(identity);
    const hash = await crypto.subtle.digest("SHA-256", data);
    const name = Array.from(new Uint8Array(hash))
      .map((value) => value.toString(16).padStart(2, "0"))
      .join("");
    return `${this.folder}/${name}.json`;
  }

  async assertAllowed(text: string, options: TTSModelOptions): Promise<void> {
    const filename = await this.filename(text, options);
    if (this.active.has(filename) || (await this.adapter.exists(filename)))
      throw new SpeechifySynthesisNeedsReview();
  }

  async beforeDispatch(text: string, options: TTSModelOptions): Promise<void> {
    const filename = await this.filename(text, options);
    await this.assertAllowed(text, options);
    this.active.add(filename);
    try {
      await ensureFolder(this.adapter, this.folder);
      const marker = JSON.stringify({ schema: 1, createdAt: Date.now() });
      // This must finish BEFORE the billable HTTP POST can be dispatched.
      await this.adapter.write(filename, marker);
      const saved = JSON.parse(await this.adapter.read(filename)) as unknown;
      if (
        !saved ||
        typeof saved !== "object" ||
        !("schema" in saved) ||
        saved.schema !== 1 ||
        !("createdAt" in saved) ||
        typeof saved.createdAt !== "number"
      ) {
        throw new SpeechifySynthesisNeedsReview();
      }
    } catch {
      // A failed/partial marker may exist; never dispatch the paid request.
      throw new SpeechifySynthesisNeedsReview();
    }
  }

  async audioSaved(text: string, options: TTSModelOptions): Promise<void> {
    const filename = await this.filename(text, options);
    // Called only after a cache hit or successful local audio save. If removal
    // fails, the marker remains conservative; playable audio is unaffected.
    if (await this.adapter.exists(filename))
      await this.adapter.remove(filename);
    this.active.delete(filename);
  }
}

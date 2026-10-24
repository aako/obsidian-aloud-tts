import * as mobx from "mobx";
import { AudioSystem } from "./AudioSystem";
import {
  AudioTextContext,
  TTSErrorInfo,
  TTSModelOptions,
} from "../models/tts-model";
import { AudioData } from "../models/tts-model";
import { convertToPlayableFormat } from "../util/audioProcessing";
import { hashAudioInputs } from "./AudioCache";

const sharedRequests = new WeakMap<
  AudioSystem,
  Map<string, Promise<AudioData>>
>();

/** manages loading and caching of tracks */
export class ChunkLoader {
  private MAX_BACKGROUND_REQUESTS = 3;
  private MAX_LOCAL_TTL_MILLIS = 60 * 1000;

  private system: AudioSystem;
  private backgroundQueue: BackgroundRequest[] = [];
  private backgroundActiveCount = 0;
  private localCache: CachedAudio[] = [];
  /**
   * Session-only safety barrier: after successfully synthesizing a chunk whose
   * cache write failed, don't silently buy the same audio again if it falls
   * out of the one-minute in-memory cache. A healthy cache hit may clear it.
   */
  private unsavedSynthesisKeys = new Set<string>();
  private backgroundRequestProcessor: IntervalDaemon;
  private garbageCollector: IntervalDaemon;

  constructor({ system }: { system: AudioSystem }) {
    this.system = system;

    this.backgroundRequestProcessor = IntervalDaemon(
      this.processBackgroundQueue.bind(this),
      { interval: system.config.backgroundLoaderIntervalMillis },
    );
    this.garbageCollector = IntervalDaemon(this.processGarbage.bind(this), {
      interval: this.MAX_LOCAL_TTL_MILLIS / 2,
    }).startIfNot();
  }

  expireBefore = (
    position: number = this.system.audioStore?.activeText?.position ?? 0,
  ): void => {
    this.backgroundQueue = this.backgroundQueue.filter(
      (x) => !(x.position < position),
    );
  };

  /**
   * Removes locally cached audio (e.g., if ArrayBuffer becomes detached).
   * Does not affect storage cache.
   */
  uncache(text: string): void {
    this.localCache = this.localCache.filter((x) => x.text !== text);
  }

  preload(
    text: string,
    options: TTSModelOptions,
    position: number,
    context: AudioTextContext = {},
  ): void {
    const sourceAudioId = this.system.audioStore.activeText?.audio.id;
    // Identical sentences in different reading sessions are different queued
    // work, even if their voice and chunk index also happen to match.
    const found = this.backgroundQueue.find(
      (x) =>
        x.sourceAudioId === sourceAudioId &&
        x.text === text &&
        mobx.comparer.structural(x.options, options),
    );
    if (found) {
      return;
    }

    // Check if already in local memory cache (loading or loaded)
    const loaded = this.localCache.find(
      (x) => x.text === text && mobx.comparer.structural(x.options, options),
    );
    if (loaded) {
      return;
    }
    this.backgroundQueue.push({
      text,
      options,
      sourceAudioId,
      requestedTime: Date.now(),
      context,
      position,
    });
    this.backgroundRequestProcessor.startIfNot();
  }

  async load(
    text: string,
    options: TTSModelOptions,
    context: AudioTextContext = {},
  ): Promise<AudioData> {
    const existing = this.localCache.find(
      (x) => x.text === text && mobx.comparer.structural(x.options, options), // Use structural comparison
    );

    if (existing) {
      existing.requestedTime = Date.now();
      return existing.result;
    } else {
      const audio = this.createCachedAudio(text, options, context);
      this.localCache.push(audio);
      return audio.result;
    }
  }

  destroy(): void {
    this.backgroundRequestProcessor.stop();
    this.garbageCollector.stop();
    // Clear caches and queue on destroy
    this.localCache = [];
    this.unsavedSynthesisKeys.clear();
    this.backgroundQueue = [];
    this.backgroundActiveCount = 0;
  }

  private createCachedAudio(
    text: string,
    options: TTSModelOptions,
    context: AudioTextContext = {},
  ): CachedAudio {
    const audio: CachedAudio = {
      text,
      options,
      requestedTime: Date.now(),
      result: this.sharedLoad(text, options, context).catch((e) => {
        this.destroyCachedAudio(audio);
        throw e;
      }),
    };
    return audio;
  }

  private sharedLoad(
    text: string,
    options: TTSModelOptions,
    context: AudioTextContext,
  ): Promise<AudioData> {
    let requests = sharedRequests.get(this.system);
    if (!requests) {
      requests = new Map();
      sharedRequests.set(this.system, requests);
    }
    // Keep in-flight dedup provider-specific without invalidating stored audio.
    const key = inFlightRequestKey(
      text,
      options,
      this.system.settings.modelProvider,
    );
    const existing = requests.get(key);
    if (existing) return existing;
    const pending = this.tryLoadTrack(
      text,
      options,
      0,
      maxRetriesForRequest(options, this.system.settings.modelProvider),
      context,
    ).finally(() => requests!.delete(key));
    requests.set(key, pending);
    return pending;
  }

  private destroyCachedAudio(audio: CachedAudio): void {
    const index = this.localCache.indexOf(audio);
    if (index !== -1) {
      this.localCache.splice(index, 1);
    }
  }

  // Processes the queue. Obsolete work must be discarded BEFORE cache lookup
  // or a potentially paid synthesis request. Current foreground work is not
  // affected; in-flight background work is handled separately.
  private processBackgroundQueue(): boolean {
    if (this.backgroundActiveCount >= this.MAX_BACKGROUND_REQUESTS) {
      return true;
    }

    while (this.backgroundQueue.length > 0) {
      const item = this.backgroundQueue.shift()!;
      const active = this.system.audioStore.activeText;
      const currentOptions = this.system.ttsModel.convertToOptions(
        this.system.settings,
      );
      if (
        !isCurrentPreload(item, {
          options: currentOptions,
          text: active?.audio.chunks[item.position]?.text,
          audioId: active?.audio.id,
          position: active?.position,
        })
      ) {
        continue;
      }

      this.backgroundActiveCount += 1;
      this.load(item.text, item.options, backgroundPreloadContext(item.context))
        .catch(() => undefined)
        .finally(() => {
          this.backgroundActiveCount -= 1;
          this.processBackgroundQueue();
        });
      return true;
    }

    return false;
  }

  private processGarbage(): boolean {
    this.localCache = this.localCache.filter(
      (entry) => Date.now() - entry.requestedTime < this.MAX_LOCAL_TTL_MILLIS,
    );
    return true;
  }

  private async tryLoadTrack(
    track: string,
    options: TTSModelOptions,
    attempt: number = 0,
    maxAttempts: number = 3,
    context: AudioTextContext = {},
  ): Promise<AudioData> {
    try {
      return await this.loadTrack(track, options, context);
    } catch (ex) {
      console.warn("error loading track", ex);
      const errorInfo = ex instanceof TTSErrorInfo ? ex : undefined;
      const canRetry =
        !context.request?.signal?.aborted &&
        !(ex && typeof ex === "object" && "name" in ex && ex.name === "AbortError") &&
        attempt < maxAttempts &&
        (errorInfo ? errorInfo.isRetryable : true);
      if (!canRetry) {
        throw ex;
      } else {
        await new Promise((resolve) =>
          setTimeout(resolve, 250 * Math.pow(2, attempt)),
        );
        return await this.tryLoadTrack(
          track,
          options,
          attempt + 1,
          maxAttempts,
          context,
        );
      }
    }
  }

  /** non-stateful function (barring layers of caching and API calls) */
  private async loadTrack(
    text: string,
    options: TTSModelOptions,
    context: AudioTextContext = {},
  ): Promise<AudioData> {
    const requestKey = inFlightRequestKey(
      text,
      options,
      this.system.settings.modelProvider,
    );
    // Preserve existing safety behavior: unreadable known caches must throw
    // rather than causing a new billable generation.
    const cached = await this.system.storage.getAudio(text, options, "mp3");
    if (cached) {
      this.unsavedSynthesisKeys.delete(requestKey);
      return cached;
    }
    if (this.unsavedSynthesisKeys.has(requestKey)) {
      throw new UnsavedAudioRequiresRecovery();
    }

    // A vault/iCloud cache read can complete well after the user changes the
    // voice or provider. Recheck immediately BEFORE any billable synthesis.
    // We only enforce this for provider-tagged options from the Obsidian proxy;
    // older direct library consumers retain their existing behavior.
    if (context.request?.signal?.aborted) {
      throw new DOMException("Audio request cancelled.", "AbortError");
    }
    if (
      options.modelProvider &&
      !mobx.comparer.structural(
        options,
        this.system.ttsModel.convertToOptions(this.system.settings),
      )
    ) {
      throw new SupersededAudioRequest();
    }

    // Call provider and convert to playable format
    const audio = await this.system.ttsModel.call(
      text,
      options,
      this.system.settings,
      context,
      context.request?.signal,
    );
    const playable = await convertToPlayableFormat(audio);

    // A storage failure is NOT a synthesis failure: retrying the whole
    // request would make another paid API call after audio was received.
    try {
      await this.system.storage.saveAudio(text, options, playable);
      this.unsavedSynthesisKeys.delete(requestKey);
    } catch (error) {
      this.unsavedSynthesisKeys.add(requestKey);
      // Do not log raw storage errors: they may contain private vault paths.
      const category =
        error instanceof Error && /^[a-z][a-z0-9]{0,39}$/i.test(error.name)
          ? error.name
          : "UnknownError";
      console.warn(
        "Aloud: synthesis succeeded but the audio cache write failed. Playing the received audio from memory; it is NOT saved. Further synthesis of this chunk is blocked for this session if the in-memory copy expires.",
        category,
      );
    }
    return playable;
  }
}

/**
 * A queued request became obsolete while waiting for the audio cache.
 * This is not a provider error and is never safe to retry automatically.
 */
class SupersededAudioRequest extends TTSErrorInfo {
  constructor() {
    super(
      "Audio voice or provider changed while reading the cache. The obsolete request was discarded before synthesis.",
    );
  }

  override get isRetryable(): boolean {
    return false;
  }
}

/**
 * A previously synthesized result was returned to the player but could not
 * be stored. Do not regenerate it automatically merely because memory expired.
 * TTSErrorInfo preserves a readable message in the existing player UI.
 */
class UnsavedAudioRequiresRecovery extends TTSErrorInfo {
  constructor() {
    super(
      "This audio was already synthesized but its cache write failed. To avoid another paid request, automatic regeneration is blocked for this session. Check local cache storage before restarting Aloud.",
    );
  }

  override get isRetryable(): boolean {
    return false;
  }
}

/**
 * A background request belongs only to the still-active document, chunk and
 * provider/voice configuration. Never synthesize obsolete queued work.
 * Checks are made at dequeue time, not only when the work was scheduled.
 */
export function isCurrentPreload(
  queued: Pick<
    BackgroundRequest,
    "text" | "position" | "options" | "sourceAudioId"
  >,
  current: {
    text?: string;
    audioId?: string;
    position?: number;
    options: TTSModelOptions;
  },
): boolean {
  return (
    current.position !== undefined &&
    current.position >= 0 &&
    queued.sourceAudioId === current.audioId &&
    queued.position >= current.position &&
    queued.text === current.text &&
    mobx.comparer.structural(queued.options, current.options)
  );
}

/** Preserve caller cancellation and accounting metadata on background work. */
export function backgroundPreloadContext(
  context: AudioTextContext,
): AudioTextContext {
  return {
    ...context,
    request: { ...context.request, priority: "background" },
  };
}

// --- Helper Interfaces and Functions ---
interface IntervalDaemon {
  stop: () => IntervalDaemon;
  startIfNot: () => IntervalDaemon;
}

type ShouldContinue = boolean;

/** runs the work function every interval, until the work function returns false. Can be stopped and started. */
export function IntervalDaemon(
  doWork: () => ShouldContinue,
  opts: {
    interval: number;
  },
): IntervalDaemon {
  let timer: undefined | ReturnType<typeof setInterval>;
  const processor: IntervalDaemon = {
    stop: () => {
      if (timer) {
        clearInterval(timer);
        timer = undefined;
      }
      return processor;
    },
    startIfNot: () => {
      if (timer !== undefined) {
        return processor;
      }
      let shouldContinue = true;
      try {
        shouldContinue = doWork();
      } catch (ex) {
        // Decide whether to stop or continue based on error? For now, assume continue.
        shouldContinue = true;
      }
      if (shouldContinue) {
        timer = setInterval(() => {
          let shouldContinueInterval = true;
          try {
            shouldContinueInterval = doWork();
          } catch (ex) {
            // Decide whether to stop or continue based on error? For now, assume continue.
            shouldContinueInterval = true;
          }
          if (!shouldContinueInterval) {
            processor.stop();
          }
        }, opts.interval);
      }
      return processor;
    },
  };
  return processor;
}

interface BackgroundRequest {
  /** Unique reading session at the time of enqueue. */
  sourceAudioId?: string;
  /** the text that was requested */
  text: string;
  /** the options used to generate this audio */
  options: TTSModelOptions;
  /** the time the request was made. Milliseconds since Unix Epoch */
  requestedTime: number;
  /** the context that was requested */
  context: AudioTextContext;
  /** the position that was requested */
  position: number;
}

/** In-memory only. Provider identity must not change existing disk cache keys. */
export function inFlightRequestKey(
  text: string,
  options: TTSModelOptions,
  currentProvider: string,
): string {
  return `${options.modelProvider ?? currentProvider}|${hashAudioInputs(text, options, "mp3")}`;
}

/** Retry policy is bound to the queued request, not current UI settings. */
export function maxRetriesForRequest(
  options: TTSModelOptions,
  currentProvider: string,
): number {
  const provider = options.modelProvider ?? currentProvider;
  return provider === "azure" || provider === "speechify" ? 0 : 3;
}

interface CachedAudio {
  /** the text that was requested */
  readonly text: string;
  /** the index for the text */
  readonly index?: number;
  /** the options used to generate this audio */
  readonly options: TTSModelOptions;
  /** the final result of the request across retries */
  readonly result: Promise<AudioData>;
  /** the time the request was made. Milliseconds since Unix Epoch. May be updated to prevent deletion */
  requestedTime: number;
}

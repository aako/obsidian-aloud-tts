import { App, normalizePath } from "obsidian";
import { AudioCache, hashAudioInputs } from "open-tts";
import { TTSModelOptions } from "open-tts";
import { TTSPluginSettingsStore } from "open-tts";
import { AudioData, MediaFormat } from "open-tts";
import { IndexedDBAudioStorage } from "open-tts/browser";
import * as mobx from "mobx";
import type { PersistentVaultCache } from "./PersistentVaultCache";
import type { SpeechifySynthesisJournal } from "./SpeechifySynthesisJournal";

export function configurableAudioCache(
  app: App,
  settings: TTSPluginSettingsStore,
  persistent?: PersistentVaultCache,
  synthesisJournal?: SpeechifySynthesisJournal,
): AudioCache & { destroy(): Promise<void> } {
  const createCache = (): AudioCache =>
    settings.settings.cacheType === "vault"
      ? obsidianFileVault(app)
      : new IndexedDBAudioStorage();

  let active: AudioCache = createCache();
  // iCloud writes must never hold up playback. Serialize and deduplicate them;
  // the article pre-cache worker can still explicitly await its own verified write.
  let sharedSaveTail: Promise<void> = Promise.resolve();
  const pendingSharedKeys = new Set<string>();
  // Retry only vault writes that failed for audio synthesized in this session.
  // Never silently promote unrelated old .tts/IndexedDB entries whose provider
  // provenance cannot be established from the legacy cache key.
  const failedSharedKeys = new Set<string>();
  const reportedErrors = new Set<string>();

  function enqueueSharedSave(
    text: string,
    options: TTSModelOptions,
    audio: AudioData,
  ): void {
    const sharedCache = persistent;
    if (!sharedCache || audio.format !== "mp3") return;
    const key = hashAudioInputs(text, options, audio.format);
    if (pendingSharedKeys.has(key)) return;
    pendingSharedKeys.add(key);
    const queued = sharedSaveTail
      .then(() => sharedCache.saveAudio(text, options, audio))
      .then(async () => {
        // Only a completed persistent-vault write may retire the journal.
        // Local IndexedDB playback may be evicted or the iCloud write interrupted.
        if (options.modelProvider === "speechify")
          await synthesisJournal?.audioSaved(text, options);
        failedSharedKeys.delete(key);
      })
      .catch((error: unknown) => {
        failedSharedKeys.add(key);
        const reason = error instanceof Error ? error.message : String(error);
        if (!reportedErrors.has(reason)) {
          reportedErrors.add(reason);
          console.warn(
            "Aloud: shared vault cache save failed; audio remains in the local playback cache.",
            error,
          );
        }
      })
      .finally(() => pendingSharedKeys.delete(key));
    sharedSaveTail = queued.then(() => undefined);
  }

  function retryFailedSharedSave(
    text: string,
    options: TTSModelOptions,
    audio: AudioData,
    persistentError: unknown,
  ): void {
    if (
      audio.format === "mp3" &&
      !persistentError &&
      failedSharedKeys.has(hashAudioInputs(text, options, audio.format))
    ) {
      // Only reuse the bytes we already have locally. No provider API calls.
      // Never overwrite/reference an iCloud copy whose metadata is unavailable.
      enqueueSharedSave(text, options, audio);
    }
  }

  const cancelReaction = mobx.reaction(
    () => settings.settings.cacheType,
    () => {
      active = createCache();
    },
  );

  return {
    async checkSynthesisAllowed(text: string, options: TTSModelOptions) {
      if (options.modelProvider === "speechify")
        await synthesisJournal?.assertAllowed(text, options);
    },
    async beforeSynthesisDispatch(text: string, options: TTSModelOptions) {
      if (options.modelProvider === "speechify")
        await synthesisJournal?.beforeDispatch(text, options);
    },
    async getAudio(
      text: string,
      settings: TTSModelOptions,
      format: MediaFormat,
    ): Promise<AudioData | null> {
      let persistentError: unknown;
      try {
        const saved = await persistent?.getAudio(text, settings, format);
        if (saved) {
          failedSharedKeys.delete(hashAudioInputs(text, settings, format));
          // getAudio() verifies persistent metadata and SHA-256 before returning.
          if (settings.modelProvider === "speechify") {
            void synthesisJournal
              ?.audioSaved(text, settings)
              .catch(() => undefined);
          }
          return saved;
        }
      } catch (error) {
        persistentError = error;
      }
      // An intact older/local copy remains playable if iCloud hasn't downloaded yet.
      const legacy = await obsidianFileVault(app).getAudio(
        text,
        settings,
        format,
      );
      if (legacy) {
        retryFailedSharedSave(text, settings, legacy, persistentError);
        return legacy;
      }
      const local = await active.getAudio(text, settings, format);
      if (local) {
        retryFailedSharedSave(text, settings, local, persistentError);
        return local;
      }
      // Do not call Azure to recreate an expected-but-missing iCloud file.
      if (persistentError) throw persistentError;
      return null;
    },
    async saveAudio(
      text: string,
      settings: TTSModelOptions,
      audio: AudioData,
    ): Promise<void> {
      // Never wait for iCloud hashing and file writes in the playback pipeline.
      // Existing ios.7 local-cache semantics remain intact as the first write.
      await active.saveAudio(text, settings, audio);
      enqueueSharedSave(text, settings, audio);
    },
    async expire(ageInMillis = 1000 * 60 * 60 * 8): Promise<void> {
      if (settings.settings.cacheType === "vault") return;
      return active.expire(ageInMillis);
    },
    async getStorageSize(): Promise<number> {
      return active.getStorageSize();
    },

    async destroy() {
      cancelReaction();
      // Drain queued writes on normal plugin unload rather than abandon them.
      await sharedSaveTail;
    },
  };
}

export function obsidianFileVault(app: App): AudioCache {
  const vault = app.vault;
  const cachedir = ".tts";
  // Default format reserved for future use when upgrading existing entries

  return {
    async getAudio(
      text: string,
      settings: TTSModelOptions,
      format: MediaFormat,
    ): Promise<AudioData | null> {
      const str = hashAudioInputs(text, settings, format);
      const filepath = normalizePath(`/${cachedir}/${str}.${format}`);
      const exists = await vault.adapter.exists(filepath);
      if (!exists) {
        return null;
      } else {
        const data = await vault.adapter.readBinary(filepath);
        return { data, format };
      }
    },
    async saveAudio(
      text: string,
      settings: TTSModelOptions,
      audio: AudioData,
    ): Promise<void> {
      const str = hashAudioInputs(text, settings, audio.format);
      const filepath = normalizePath(`/${cachedir}/${str}.${audio.format}`);

      const exists = await vault.adapter.exists(normalizePath(`/${cachedir}`));
      if (!exists) {
        await vault.adapter.mkdir(normalizePath(`/${cachedir}`));
      }
      await vault.adapter.writeBinary(filepath, audio.data);
    },
    async expire(ageInMillis = 1000 * 60 * 60 * 8): Promise<void> {
      const exists = await vault.adapter.exists(normalizePath(`/${cachedir}`));
      if (!exists) {
        return;
      }
      const listed = await vault.adapter.list(".tts");
      for (const file of listed.files) {
        const stats = await vault.adapter.stat(file);
        if (stats) {
          const tooOld = stats.mtime + ageInMillis < Date.now().valueOf();
          if (tooOld) {
            await vault.adapter.remove(file);
          }
        }
      }
    },

    async getStorageSize(): Promise<number> {
      const listed = await vault.adapter.list(".tts");
      let total = 0;
      for (const file of listed.files) {
        const stats = await vault.adapter.stat(file);
        if (stats) {
          total += stats.size;
        }
      }
      return total;
    },
  };
}

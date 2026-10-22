import { App, normalizePath } from "obsidian";
import { AudioCache, hashAudioInputs } from "open-tts";
import { TTSModelOptions } from "open-tts";
import { TTSPluginSettingsStore } from "open-tts";
import { AudioData, MediaFormat } from "open-tts";
import { IndexedDBAudioStorage } from "open-tts/browser";
import * as mobx from "mobx";
import type { PersistentVaultCache } from "./PersistentVaultCache";

export function configurableAudioCache(
  app: App,
  settings: TTSPluginSettingsStore,
  persistent?: PersistentVaultCache,
): AudioCache & { destroy(): void } {
  const createCache = (): AudioCache =>
    settings.settings.cacheType === "vault"
      ? obsidianFileVault(app)
      : new IndexedDBAudioStorage();

  let active: AudioCache = createCache();

  const cancelReaction = mobx.reaction(
    () => settings.settings.cacheType,
    () => {
      active = createCache();
    },
  );

  return {
    async getAudio(
      text: string,
      settings: TTSModelOptions,
      format: MediaFormat,
    ): Promise<AudioData | null> {
      let persistentError: unknown;
      try {
        const saved = await persistent?.getAudio(text, settings, format);
        if (saved) return saved;
      } catch (error) {
        persistentError = error;
      }
      // An intact older/local copy remains playable if iCloud hasn't downloaded yet.
      const legacy = await obsidianFileVault(app).getAudio(
        text,
        settings,
        format,
      );
      if (legacy) return legacy;
      const local = await active.getAudio(text, settings, format);
      if (local) return local;
      // Do not call Azure to recreate an expected-but-missing iCloud file.
      if (persistentError) throw persistentError;
      return null;
    },
    async saveAudio(
      text: string,
      settings: TTSModelOptions,
      audio: AudioData,
    ): Promise<void> {
      return active.saveAudio(text, settings, audio);
    },
    async expire(ageInMillis = 1000 * 60 * 60 * 8): Promise<void> {
      if (settings.settings.cacheType === "vault") return;
      return active.expire(ageInMillis);
    },
    async getStorageSize(): Promise<number> {
      return active.getStorageSize();
    },

    destroy() {
      cancelReaction();
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

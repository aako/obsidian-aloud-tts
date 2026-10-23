import { TTSCodeMirror } from "./TTSCodemirror";
import { createPlayerSynchronizer } from "@open-tts/ui";

import { MarkdownView, Plugin, Notice, TFile, addIcon } from "obsidian";
import { ReadingProgress } from "./ReadingProgress";
import { ArticleCache } from "./ArticleCache";
import {
  PersistentVaultCache,
  ensureFolder,
  readSnapshot,
  writeSnapshot,
} from "./PersistentVaultCache";
import {
  azureRequestGate,
  validAzureLedger,
  googleChirpRequestGate,
} from "open-tts";
import { AloudMediaSession } from "./MediaSessionController";
import { REGISTRY } from "open-tts";
import { TTSSettingTab } from "./components/TTSPluginSettingsTab";
import { AudioSink } from "open-tts";
import { WebAudioSink } from "open-tts/browser";
import { AudioStore, loadAudioStore } from "open-tts";
import { AudioSystem, createAudioSystem } from "open-tts";
import { ChunkLoader } from "open-tts";
import {
  MARKETING_NAME,
  TTSPluginSettings,
  TTSPluginSettingsStore,
  pluginSettingsStore,
} from "open-tts";
import { ObsidianBridge, ObsidianBridgeImpl } from "./ObsidianBridge";
import { configurableAudioCache } from "./ObsidianPlayer";
import { AudioTextContext, TTSModel, TTSModelOptions } from "open-tts";
import { TTSEditorAction } from "./TTSEditorAction";
import { DetachedPlayerHost } from "./components/DetachedPlayer";

// standard lucide.dev icon, but for some reason not working as a ribbon icon without registering it
// https://lucide.dev/icons/audio-lines
addIcon(
  "audio-lines",
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-audio-lines"><path d="M2 10v3"/><path d="M6 6v11"/><path d="M10 3v18"/><path d="M14 8v7"/><path d="M18 5v13"/><path d="M22 10v3"/></svg>',
);

export default class TTSPlugin extends Plugin {
  settings: TTSPluginSettingsStore;

  system: AudioSystem;
  bridge: ObsidianBridge;
  cache: { destroy: () => void | Promise<void> } | undefined;
  editorAction: TTSEditorAction | undefined;
  detachedPlayerHost: DetachedPlayerHost | undefined;
  private _playerSyncDisposer: (() => void) | undefined;
  private progress: ReadingProgress;
  private mediaSession?: AloudMediaSession;
  private articleCache?: ArticleCache;

  get player(): AudioStore {
    return this.system.audioStore;
  }

  get audio(): AudioSink {
    return this.system.audioSink;
  }

  async onload() {
    await this.loadSettings();

    // add right click menu to play selection
    this.registerEvent(
      this.app.workspace.on("editor-menu", (menu, editor, view) => {
        menu.addItem((item) => {
          item
            .setTitle(`${MARKETING_NAME}: Play selection`)
            .setIcon("play")
            .onClick(async () => {
              await this.bridge.triggerSelection(view.file, editor, {
                extendShort: true,
              });
            });
        });
        menu.addItem((item) => {
          item
            .setTitle(`${MARKETING_NAME}: Paste text to audio`)
            .setIcon("clipboard")
            .onClick(async () => {
              const text = await navigator.clipboard.readText();
              this.bridge.exportAudio(text, true);
            });
        });
        menu.addItem((item) => {
          item
            .setTitle(`${MARKETING_NAME}: Export selection to audio`)
            .setIcon("file-audio")
            .onClick(async () => {
              const text = editor.getSelection();
              this.bridge.exportAudio(text, false);
            });
        });
      }),
    );

    // Also add a command that can perform the same play selection.
    // This will always initiate new audio.
    this.addCommand({
      id: "play-selection",
      name: "Play selection",
      checkCallback: (checking) => {
        if (checking) {
          return true;
        }
        this.bridge.playSelection();
      },
    });
    this.addCommand({
      id: "save-document-audio",
      name: "Save document as audio",
      checkCallback: (checking) => {
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        const busy = !!this.player.exportProgress;
        if (checking) {
          return !!view && !busy;
        }
        this.bridge.saveDocumentAudio().catch((ex) => {
          console.error("Couldn't save document audio!", ex);
        });
      },
    });
    this.addCommand({
      id: "play-clipboard",
      name: "Play from clipboard",
      checkCallback: (checking) => {
        if (checking) {
          return true;
        }
        void this.bridge.playClipboard();
      },
    });

    this.addCommand({
      id: "resume-last-reading",
      name: "Resume last reading (saved progress)",
      callback: () => void this.bridge.resumeSavedReading(),
    });

    this.addCommand({
      id: "start-over",
      name: "Start Over (first sentence)",
      callback: () => void this.bridge.startOver(),
    });
    this.addCommand({
      id: "precache-article",
      name: "Pre-cache current article audio",
      callback: () => void this.bridge.openArticleCache("document"),
    });
    this.addCommand({
      id: "manage-article-cache",
      name: "Manage article audio cache",
      callback: () => void this.bridge.openArticleCache("manage"),
    });

    // Editor action button - always present, behavior differs by platform
    this.editorAction = new TTSEditorAction(
      this,
      this.player,
      this.settings,
      this.bridge,
      this.audio,
    );
    this.editorAction.register();
    this.detachedPlayerHost = new DetachedPlayerHost(
      this.addStatusBarItem(),
      this.player,
      this.settings,
      this.audio,
      this.bridge,
    );

    // this pause/resumes the current audio, or initiates a new audio if nothing is playing
    this.addCommand({
      id: "play-pause",
      name: "Play/pause",
      checkCallback: (checking) => {
        const active = this.player.activeText;
        if (checking) {
          return true;
        }
        if (!active) {
          this.bridge.playSelection();
        } else if (this.player.activeText?.isPlaying) {
          this.player.activeText?.pause();
        } else {
          this.player.activeText?.play();
        }
      },
    });

    this.addCommand({
      id: "increase-playback-speed",
      name: "Increase playback speed",
      checkCallback: (checking) => {
        if (checking) {
          return this.settings.settings.playbackSpeed < 2.5;
        }
        this.settings.setSpeed(this.settings.settings.playbackSpeed + 0.1);
      },
    });

    this.addCommand({
      id: "decrease-playback-speed",
      name: "Decrease playback speed",
      checkCallback: (checking) => {
        if (checking) {
          return this.settings.settings.playbackSpeed > 0.5;
        }
        this.settings.setSpeed(this.settings.settings.playbackSpeed - 0.1);
      },
    });

    // track navigation
    this.addCommand({
      id: "next-track",
      name: "Next track",
      checkCallback: (checking) => {
        const hasActive = !!this.player.activeText;
        if (checking) {
          return hasActive;
        }
        this.player.activeText?.goToNext();
      },
    });

    this.addCommand({
      id: "previous-track",
      name: "Previous track",
      checkCallback: (checking) => {
        const hasActive = !!this.player.activeText;
        if (checking) {
          return hasActive;
        }
        this.player.activeText?.goToPrevious();
      },
    });

    this.addCommand({
      id: "seek-backward-15",
      name: "Seek backward 15 seconds",
      checkCallback: (checking) => {
        if (checking) return !!this.player.activeText;
        const before = this.audio.currentTime;
        const target = before - 15;
        if (target < 0) {
          this.player.activeText?.goToPrevious();
        } else {
          this.audio.currentTime = target;
        }
      },
    });

    this.addCommand({
      id: "seek-forward-15",
      name: "Seek forward 15 seconds",
      checkCallback: (checking) => {
        if (checking) return !!this.player.activeText;
        this.audio.currentTime = this.audio.currentTime + 15;
      },
    });

    this.addCommand({
      id: "toggle-autoscroll",
      name: "Toggle autoscroll focus",
      checkCallback: (checking) => {
        const hasSettings = !!this.settings;
        if (checking) {
          return hasSettings;
        }
        const newValue = !this.player.autoScrollEnabled;
        if (newValue) {
          this.player.enableAutoScrollAndScrollToCurrent();
        } else {
          this.player.disableAutoScroll();
        }
        // Persist the setting
        this.settings.updateSettings({ autoScrollPlayerView: newValue });
      },
    });

    this._playerSyncDisposer = createPlayerSynchronizer(
      this.player,
      this.bridge,
    );
    this.registerEditorExtension(
      TTSCodeMirror(this.player, this.settings, this.audio, this.bridge),
    );

    // This adds a settings tab so the user can configure various aspects of the plugin
    this.addSettingTab(
      new TTSSettingTab(this.app, this, this.settings, this.player),
    );
  }

  async onunload(): Promise<void> {
    await this.articleCache?.stop();
    await this.progress?.stop();
    this.mediaSession?.destroy();
    this.detachedPlayerHost?.destroy();
    this.editorAction?.destroy();
    this._playerSyncDisposer?.();
    this.player?.destroy();
    this.audio?.destroy();
    this.bridge?.destroy();
    await this.cache?.destroy();
  }

  async loadSettings() {
    this.settings = await pluginSettingsStore(
      () => this.loadData(),
      (data) => this.saveData(data),
    );

    // Ledger writes must finish before an Azure network request may begin.
    // Keep this separate from data.json so frequent reservations never clobber settings.
    const adapter = this.app.vault.adapter;
    const ledgerFolder = `${this.app.vault.configDir}/plugins/${this.manifest.id}`;
    const ledgerBase = `${ledgerFolder}/azure-usage`;
    try {
      const stored = await readSnapshot(adapter, ledgerBase, validAzureLedger);
      let generation = stored?.generation ?? 0;
      azureRequestGate.initialize(
        stored?.value ?? {
          month: new Date().toISOString().slice(0, 7),
          characters: 0,
          starts: [],
          blockedUntil: 0,
        },
        async (value) => {
          await ensureFolder(adapter, ledgerFolder);
          // Two identical reservations, one per slot, so fallback can't undercount.
          await writeSnapshot(adapter, ledgerBase, ++generation, value);
          await writeSnapshot(adapter, ledgerBase, ++generation, value);
        },
      );
    } catch (error) {
      // Fail CLOSED: the gate remains uninitialized if the ledger cannot be read.
      // Cached playback and non-Azure providers remain available.
      console.error(
        "Aloud: Azure ledger unavailable; synthesis disabled",
        error,
      );
      new Notice(
        "Aloud: Azure usage ledger unavailable. Azure generation is disabled; cached audio can still play.",
      );
    }
    // Separate durable local ledger: Chirp use must never share Azure's budget.
    const googleLedgerBase = `${ledgerFolder}/google-chirp-usage`;
    try {
      const saved = await readSnapshot(
        adapter,
        googleLedgerBase,
        validAzureLedger,
      );
      let generation = saved?.generation ?? 0;
      googleChirpRequestGate.initialize(
        saved?.value ?? {
          month: new Date().toISOString().slice(0, 7),
          characters: 0,
          starts: [],
          blockedUntil: 0,
        },
        async (value) => {
          await ensureFolder(adapter, ledgerFolder);
          await writeSnapshot(adapter, googleLedgerBase, ++generation, value);
          await writeSnapshot(adapter, googleLedgerBase, ++generation, value);
        },
      );
    } catch (error) {
      console.error(
        "Aloud: Google Chirp ledger unavailable; synthesis disabled",
        error,
      );
      new Notice(
        "Aloud: Google Chirp ledger unavailable. Google synthesis is disabled; cached audio can still play.",
      );
    }
    const persistent = new PersistentVaultCache(
      adapter,
      () => this.settings.settings.persistentCacheFolder,
      () => this.settings.settings.persistentCacheMaxMB,
    );
    const audio = await WebAudioSink.create();
    audio.onPlaybackFailure = (error: unknown): void => {
      const name = error instanceof Error ? error.name : "UnknownError";
      console.warn("Aloud audio: playback could not resume", {
        name,
        hidden: document.hidden,
      });
      new Notice(
        "Audio couldn't resume. Return to Aloud and tap Continue or Resume saved article.",
      );
    };
    const cache = configurableAudioCache(this.app, this.settings, persistent);
    this.cache = cache;
    this.system = createAudioSystem({
      settings: () => this.settings.settings,
      audioSink: () => audio,
      audioStore: (sys) => loadAudioStore({ system: sys }),
      storage: () => cache,
      ttsModel: (system) => ProxiedTTSModel(system.settings),
      chunkLoader: (system) => new ChunkLoader({ system }),
      config: () => ({
        backgroundLoaderIntervalMillis: 1000,
      }),
    });
    this.articleCache = new ArticleCache(
      this.system,
      persistent,
      async (path: string): Promise<string> => {
        const file = this.app.vault.getAbstractFileByPath(path);
        if (!(file instanceof TFile))
          throw new Error(
            "The saved article cannot be found. No Azure request was sent.",
          );
        return this.app.vault.read(file);
      },
    );
    try {
      await this.articleCache.load();
    } catch (error) {
      console.warn(
        "Aloud: article cache metadata unavailable; no automatic regeneration",
        error,
      );
      new Notice(
        "Aloud: article cache metadata unavailable. Check iCloud downloads; existing files were not changed.",
      );
      this.articleCache.destroy();
      this.articleCache = undefined;
    }
    this.progress = new ReadingProgress(
      this.app,
      this.app.vault.adapter,
      this.player,
      this.settings,
      this.manifest.id,
    );
    await this.progress.load();
    this.bridge = new ObsidianBridgeImpl(
      this.app,
      this.player,
      this.settings,
      this.progress,
      this.articleCache,
    );
    this.progress.start();
    this.mediaSession = new AloudMediaSession(this.player, audio);
    this.mediaSession.start();
  }
}

function ProxiedTTSModel(settings: TTSPluginSettings): TTSModel {
  const getModel = () => {
    return REGISTRY[settings.modelProvider];
  };
  return {
    call: (
      text: string,
      options: TTSModelOptions,
      settings: TTSPluginSettings,
      context?: AudioTextContext,
      signal?: AbortSignal,
    ) => {
      return getModel().call(text, options, settings, context, signal);
    },
    validateConnection: (settings: TTSPluginSettings) => {
      return getModel().validateConnection(settings);
    },
    convertToOptions: (settings: TTSPluginSettings) => {
      return getModel().convertToOptions(settings);
    },
  };
}

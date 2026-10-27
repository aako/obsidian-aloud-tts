import { EditorView } from "@codemirror/view";
import * as mobx from "mobx";
import {
  App,
  Editor,
  MarkdownFileInfo,
  MarkdownView,
  Modal,
  Notice,
  Setting,
  TFile,
  loadPdfJs,
} from "obsidian";
import * as React from "react";
import { createRoot, Root } from "react-dom/client";
import { IsPlaying } from "./components/ObsidianIsPlaying";
import { AudioStore, AudioTextOptions } from "open-tts";
import type { AudioSink } from "open-tts";
import { hashString } from "open-tts";
import { TTSPluginSettingsStore } from "open-tts";
import { TTSEditorBridge } from "@open-tts/ui";
import { readingFingerprint } from "./ReadingProgress";
import type { ReadingProgress } from "./ReadingProgress";
import type { ArticleCache, ArticleJob } from "./ArticleCache";
import { ArticleCacheModal } from "./components/ArticleCacheModal";
import { selectCurrentArticleCacheJob } from "./components/ArticleCacheSelection";
import { scrollToSpokenRange } from "./ReadingViewHighlight";
import {
  chunkIndexAtSourceOffset,
  exactReadingViewSourceRange,
  isMarkdownReadingView,
  readingViewSelection,
} from "./ReadingViewPlayback";

/** A selection snapshot bound to its original note, before the menu steals focus. */
export interface ReadingSelectionAnchor {
  sourcePath: string;
  renderedText: string;
}

export interface ObsidianBridgeSpecifics {
  activeObsidianEditor: Editor | undefined;
}

export interface ObsidianBridge
  extends TTSEditorBridge,
    ObsidianBridgeSpecifics {
  canPlayDetachedAudio: boolean;
  /** Observable active view kind; Reader/Editor Markdown both report markdown. */
  activeViewType?: string | null;
  activeMarkdownPath?: string | null;
  /** This note belongs to Innermaze, so Aloud must not render controls. */
  isInnermazeContext?: boolean;
  /** Installed plugin manifest version, identical on all plugin interfaces. */
  readonly version?: string;
  // Obsidian-specific methods beyond the shared interface
  triggerSelection: (
    file: TFile | null,
    editor: Editor,
    options?: { extendShort?: boolean },
  ) => void;
  playDetached: (text: string, filename?: string) => void;
  playSelection: () => void;
  captureReadingSelection(): ReadingSelectionAnchor | undefined;
  playFromHere(anchor?: ReadingSelectionAnchor): Promise<void>;
  playDocument(): Promise<void>;
  openArticleCache(
    scope?: "document" | "selection" | "saved" | "manage",
  ): Promise<void>;
  playClipboard: () => Promise<void>;
  playSavedReading: (opts: AudioTextOptions) => Promise<void>;
  hasSavedReading(): boolean;
  resumeSavedReading(): Promise<void>;
  startOver(): Promise<void>;
  jumpToPlayingLine(): boolean;
  retryCurrentSentence(): boolean;
  copyPlaybackDiagnostics(): Promise<boolean>;
  readingProgressLabel(): string | undefined;
}

interface PdfTextItem {
  str: string;
  hasEOL?: boolean;
}

interface PdfTextContent {
  items: unknown[];
}

interface PdfPage {
  getTextContent: () => Promise<PdfTextContent>;
}

interface PdfDocument {
  numPages: number;
  getPage: (pageNumber: number) => Promise<PdfPage>;
  destroy?: () => Promise<void> | void;
}

interface PdfDocumentLoadingTask {
  promise: Promise<PdfDocument>;
}

interface PdfJs {
  getDocument: (source: { data: Uint8Array }) => PdfDocumentLoadingTask;
}

type PdfFileView = {
  file: TFile | null;
  getViewType: () => string;
  containerEl?: HTMLElement;
  contentEl?: HTMLElement;
};

/** observable class for obsidian related implementation to activate audio */
export class ObsidianBridgeImpl implements ObsidianBridge {
  private readingActionPending = false;
  // the editor that was last interacted with for playing audio.
  active: MarkdownFileInfo | null = null;
  activeEditorView: MarkdownView | null;
  activeFilename: string | null = null;
  activeObsidianEditor: Editor | undefined = undefined;
  // the focused editor, or last focused editor if none
  focusedEditorView: MarkdownView | null = null;

  isDetachedAudio: boolean = false;
  activeViewType: string | null = null;
  /** Active Markdown file; reactive even when another Markdown file was open. */
  activeMarkdownPath: string | null = null;
  isInnermazeContext = false;
  private _playingIconRoot: Root | null = null;
  get detachedAudio(): boolean {
    return this.isDetachedAudio;
  }
  get canPlayDetachedAudio(): boolean {
    return this.activeViewType === "pdf";
  }

  get focusedEditor(): EditorView | undefined {
    // @ts-expect-error
    const editor = this.focusedEditorView?.editor?.cm as EditorView | undefined;
    return editor || undefined;
  }
  get activeEditor(): EditorView | undefined {
    // @ts-expect-error
    const editor = this.active?.editor?.cm as EditorView | undefined;
    return editor || undefined;
  }

  constructor(
    private app: App,
    private audio: AudioStore,
    private settings: TTSPluginSettingsStore,
    private progress?: ReadingProgress,
    private articleCache?: ArticleCache,
    readonly version?: string,
    private readonly playbackSink?: AudioSink,
  ) {
    mobx.makeObservable(this, {
      active: mobx.observable.ref,
      activeEditor: mobx.computed,
      activeObsidianEditor: mobx.observable.ref,
      activeViewType: mobx.observable,
      activeMarkdownPath: mobx.observable,
      isInnermazeContext: mobx.observable,
      canPlayDetachedAudio: mobx.computed,
      detachedAudio: mobx.computed,
      focusedEditorView: mobx.observable.ref,
      isDetachedAudio: mobx.observable,
      _setFocusedEditor: mobx.action,
      _setActiveEditor: mobx.action,
      _syncActiveViewType: mobx.action,
      _onLayoutChange: mobx.action,
      _onFileOpen: mobx.action,
      playDetached: mobx.action,
    });
    this.app.workspace!.on("active-leaf-change", this._setFocusedEditor);
    this._setFocusedEditor();
    this.app.workspace!.on("layout-change", this._onLayoutChange);
    this.app.workspace!.on("file-open", this._onFileOpen);
    this.app.metadataCache?.on("changed", this._onMetadataChanged);
  }
  isMobile: () => boolean = () => {
    // docs show this... types do not https://docs.obsidian.md/Plugins/Getting+started/Mobile+development
    // @ts-expect-error
    return this.app.isMobile;
  };

  saveDocumentAudio: () => Promise<void> = async () => {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view) {
      new Notice("Open a note first to save its audio.");
      return;
    }
    const text = view.editor.getValue();
    if (!text.trim()) {
      new Notice("No text in the current note to convert.");
      return;
    }
    const baseName =
      view.file?.basename?.replace(/[^a-zA-Z0-9_-]+/g, "-").slice(0, 60) ||
      "aloud-document";
    const hash = hashString(text, 32).toString(16).slice(0, 8);
    const filename = `${baseName}-${hash}.mp3`;

    const destination = this.settings.settings.audioExportDestination;
    let mode: "vault" | "download" =
      destination === "vault" ? "vault" : "download";
    if (destination === "prompt") {
      const choice = await openExportDestinationModal(this.app);
      if (!choice) return;
      mode = choice;
    }

    new Notice("Generating audio, this may take some time…");
    let bytes: ArrayBuffer;
    try {
      bytes = await this.audio.exportAudio(text);
    } catch (ex) {
      if (ex instanceof DOMException && ex.name === "AbortError") {
        new Notice("Audio export cancelled");
        return;
      }
      console.error("Couldn't generate audio for document!", ex);
      new Notice("Failed to generate audio");
      return;
    }

    try {
      if (mode === "vault") {
        const folder = this.settings.settings.audioFolder;
        const vaultPath = `${folder}/${filename}`;
        await this.app.vault.adapter.mkdir(folder);
        await this.app.vault.adapter.writeBinary(vaultPath, bytes);
        new Notice(`Saved ${vaultPath}`);
      } else {
        triggerBrowserDownload(bytes, filename);
        new Notice(`Downloaded ${filename}`);
      }
    } catch (ex) {
      console.error("Couldn't save audio!", ex);
      new Notice("Failed to save audio file");
    }
  };

  exportAudio: (text: string, replaceSelection: boolean) => Promise<void> =
    async (text, replaceSelection) => {
      if (!text.trim()) {
        new Notice("No text to export");
        return;
      }
      const hash = hashString(text, 32).toString(16);
      const prefix = text
        .replace(/\s/g, "-")
        .replace(/[^a-zA-Z0-9_-]/g, "")
        .slice(0, 20)
        .replace(/-+$/, "");
      const filename = `${this.settings.settings.audioFolder}/${prefix}-${hash}.mp3`;

      const view = this.app.workspace.getActiveViewOfType(MarkdownView);

      const editor = view?.editor;
      const finalReplacement = `![[${filename}]]\n`;
      const loadingReplacement = `<loading file="${filename}" />\n`;
      if (editor) {
        if (replaceSelection) {
          editor.replaceSelection(loadingReplacement);
        } else {
          // Insert the exported audio on a new line below the selected line
          const selectionEnd = editor.getCursor("to");
          const lineBelowSelection = selectionEnd.line + 1;

          if (lineBelowSelection < editor.lineCount()) {
            const insertPosition = { line: lineBelowSelection, ch: 0 };

            editor.replaceRange(
              loadingReplacement,
              insertPosition,
              insertPosition,
            );
          } else {
            const endOfLine = {
              line: selectionEnd.line,
              ch: editor.getLine(selectionEnd.line).length,
            };

            editor.replaceRange(
              `\n${loadingReplacement}`,
              endOfLine,
              endOfLine,
            );
          }
        }
      }

      function removeLoadingState(finalReplacement: string) {
        if (editor) {
          const doc = editor.getValue();
          const escapedLoadingReplacement = loadingReplacement.replace(
            /[.*+?^${}()|[\]\\]/g,
            "\\$&",
          );
          const match = doc.match(new RegExp(escapedLoadingReplacement));
          if (match) {
            const start = doc.indexOf(match[0]);
            const end = start + match[0].length;
            editor.replaceRange(
              finalReplacement,
              editor.offsetToPos(start),
              editor.offsetToPos(end),
            );
          }
        }
      }
      try {
        new Notice(`Exporting ${filename}, this may take some time`);
        const contents = await this.audio.exportAudio(text);
        await this.app.vault.adapter.mkdir(this.settings.settings.audioFolder);
        await this.app.vault.adapter.writeBinary(filename, contents);
        removeLoadingState(finalReplacement);
        new Notice(`Exported ${filename}`);
      } catch (ex) {
        console.error("Couldn't export audio!", ex);
        new Notice("Failed to export audio");
        removeLoadingState("");
      }
    };

  _setActiveEditor = () => {
    this._syncActiveViewType();
    this.isDetachedAudio = false;
    this.active = this.app.workspace?.activeEditor || null;
    this.activeEditorView =
      this.app.workspace.getActiveViewOfType(MarkdownView);
    this.activeObsidianEditor = this.activeEditorView?.editor || undefined;

    this.activeFilename = this.active?.file?.name || null;

    this._attachPlayingIconToEditor(this.activeEditorView);
  };

  _attachPlayingIconToEditor(editor: MarkdownView | null) {
    // Unmount previous React root before creating a new one
    if (this._playingIconRoot) {
      this._playingIconRoot.unmount();
      this._playingIconRoot = null;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tabElement = (editor?.leaf as any | undefined)?.tabHeaderEl;

    if (tabElement) {
      const inner = tabElement.querySelector(".workspace-tab-header-inner");
      if (inner) {
        inner.querySelector(".aloud-ios-fork-tab-playing-icon")?.remove();
        const iconSpan = document.createElement("span");
        iconSpan.className =
          "tts-tab-playing-icon aloud-ios-fork-tab-playing-icon";
        this._playingIconRoot = createRoot(iconSpan);
        this._playingIconRoot.render(
          React.createElement(IsPlaying, {
            audio: this.audio,
            bridge: this,
            editor: this.activeEditor!,
            className: "tts-toolbar-icon",
          }),
        );
        inner.prepend(iconSpan);
      }
    }
  }

  _onFileOpen = () => {
    this._syncActiveViewType();
    const f = this.activeEditorView?.file;
    if (f && f.name !== this.activeFilename) {
      // if current window was replaced
      this.active = null;
      this.activeEditorView = null;
      this.activeFilename = null;
    }
  };

  _onLayoutChange = () => {
    this._syncActiveViewType();
    // pause the current editor when its window closes
    const didMatch = this.app.workspace
      .getLeavesOfType("markdown")
      .some((leaf) => leaf.view === this.activeEditorView);
    if (!didMatch) {
      this.audio.activeText?.pause();
    } else {
      // keep the file up to date in case this was triggered by a file rename
      this.activeFilename = this.active?.file?.name || null;
    }
  };

  _setFocusedEditor = () => {
    this._syncActiveViewType();
    this.focusedEditorView =
      this.app.workspace.getActiveViewOfType(MarkdownView) ||
      this.focusedEditorView; // is sticky
  };

  private readonly _onMetadataChanged = (file: TFile): void => {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (view?.file?.path === file.path) this._syncActiveViewType();
  };

  _syncActiveViewType = () => {
    this.activeViewType =
      this.app.workspace.activeLeaf?.view.getViewType() || null;
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    const file = view?.file;
    this.activeMarkdownPath = file?.path ?? null;
    const frontmatter = file
      ? this.app.metadataCache?.getFileCache(file)?.frontmatter
      : undefined;
    // Innermaze's own note marker, not the filename or folder location.
    this.isInnermazeContext =
      this.activeViewType === "innermaze-player" ||
      (this.activeViewType === "markdown" &&
        frontmatter?.voice_archive === true);
  };

  destroy: () => void = () => {
    this.app.workspace?.off("active-leaf-change", this._setFocusedEditor);
    this.app.workspace?.off("layout-change", this._onLayoutChange);
    this.app.workspace?.off("file-open", this._onFileOpen);
    this.app.metadataCache?.off("changed", this._onMetadataChanged);
    if (this._playingIconRoot) {
      this._playingIconRoot.unmount();
      this._playingIconRoot = null;
    }
  };

  async playClipboard(): Promise<void> {
    try {
      const text = await navigator.clipboard.readText();
      if (!text.trim()) {
        new Notice("No text found in clipboard");
        return;
      }
      this.playDetached(text);
    } catch (ex) {
      console.error("Failed to play clipboard audio", ex);
      new Notice("Failed to get data from clipboard");
    }
  }

  playDetached(text: string, filename?: string): void {
    if (!text.trim()) {
      new Notice("No text selected to speak");
      return;
    }
    this.isDetachedAudio = true;
    void this.audio
      .startPlayer({
        filename: filename || text.slice(0, 20),
        text,
        start: 0,
        end: text.length,
      })
      .catch((ex) => {
        console.error("Couldn't start player!", ex);
        mobx.runInAction(() => {
          this.isDetachedAudio = false;
        });
        new Notice("Failed to start audio");
      });
  }

  async playSavedReading(opts: AudioTextOptions): Promise<void> {
    this._setActiveEditor();
    await this.audio.startPlayer(opts);
  }

  hasSavedReading(): boolean {
    return !!this.progress?.latest;
  }

  readingProgressLabel(): string | undefined {
    const unit =
      this.settings.settings.chunkType === "paragraph"
        ? "paragraph"
        : "sentence group";
    const active = this.audio.activeText;
    if (active && active.position >= 0) {
      return `Live: ${unit} ${active.position + 1} of ${active.audio.chunks.length}`;
    }
    const saved = this.progress?.latest;
    return saved ? `Saved: ${unit} ${saved.chunk + 1}` : undefined;
  }

  private async savedOptions(): Promise<AudioTextOptions | undefined> {
    const saved = this.progress?.latest;
    if (!saved) {
      new Notice("No saved article yet.");
      return undefined;
    }
    return this.optionsForSource(
      saved.path,
      saved.start,
      saved.end,
      saved.fingerprint,
    );
  }

  private async optionsForSource(
    path: string,
    start: number,
    end: number,
    fingerprint: string,
  ): Promise<AudioTextOptions | undefined> {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) {
      new Notice("Saved article no longer exists.");
      return undefined;
    }
    const text = (await this.app.vault.read(file)).slice(start, end);
    if (readingFingerprint(text) !== fingerprint) {
      new Notice("Article has changed; saved position is not safe to restore.");
      return undefined;
    }
    return { filename: file.path, sourcePath: file.path, start, end, text };
  }

  async resumeSavedReading(): Promise<void> {
    if (this.readingActionPending) return;
    this.readingActionPending = true;
    try {
      const opts = await this.savedOptions();
      if (!opts) return;
      const position = this.progress?.positionFor(opts);
      if (position == null) {
        new Notice("The saved sentence no longer matches this article.");
        return;
      }
      const file = this.app.vault.getAbstractFileByPath(opts.sourcePath!);
      if (file instanceof TFile)
        await this.app.workspace.getLeaf(false).openFile(file);
      await this.playSavedReading({ ...opts, resumeChunkIndex: position });
    } catch (error) {
      console.warn("Aloud: saved reading could not resume", error);
      new Notice(
        "Couldn't resume the saved article. Check vault access and try again.",
      );
    } finally {
      this.readingActionPending = false;
    }
  }

  jumpToPlayingLine(): boolean {
    const active = this.audio.activeText;
    const chunk = active?.currentChunk;
    const sourcePath = active?.audio.sourcePath;
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!chunk || !sourcePath || !view?.file || view.file.path !== sourcePath) {
      new Notice("Open the note currently playing to jump to its position.");
      return false;
    }
    if (view.getMode() === "preview") {
      const preview = view.containerEl.querySelector(".markdown-preview-view");
      if (
        !(preview instanceof HTMLElement) ||
        !scrollToSpokenRange(preview, chunk.text)
      ) {
        new Notice(
          "The spoken line cannot be located uniquely in Reading View.",
        );
        return false;
      }
      return true;
    }
    const editor = view.editor;
    const text = editor.getValue();
    if (
      chunk.start < 0 ||
      chunk.end > text.length ||
      text.slice(chunk.start, chunk.end) !== chunk.rawText
    ) {
      new Notice("The note changed; the spoken line cannot be located safely.");
      return false;
    }
    editor.scrollIntoView(
      {
        from: editor.offsetToPos(chunk.start),
        to: editor.offsetToPos(chunk.end),
      },
      true,
    );
    return true;
  }

  retryCurrentSentence(): boolean {
    const chunk = this.audio.activeText?.currentChunk;
    const begin = chunk?.timelineStartSeconds;
    const end = chunk?.timelineEndSeconds;
    const sink = this.playbackSink;
    if (
      begin == null ||
      end == null ||
      !sink?.retryBufferedAt ||
      end <= begin ||
      !sink.retryBufferedAt(begin + Math.min(0.05, (end - begin) / 2))
    ) {
      new Notice(
        "Current sentence is no longer in the audio buffer. No new audio was purchased.",
      );
      return false;
    }
    return true;
  }

  async copyPlaybackDiagnostics(): Promise<boolean> {
    const snapshot = this.playbackSink?.getPlaybackDiagnostics?.();
    if (!snapshot) {
      new Notice("Playback diagnostics are unavailable.");
      return false;
    }
    try {
      await navigator.clipboard.writeText(
        JSON.stringify(
          {
            pluginVersion: this.version ?? "unknown",
            playback: snapshot,
          },
          null,
          2,
        ),
      );
      new Notice(
        "Aloud playback diagnostics copied (no article text or API keys).",
      );
      return true;
    } catch {
      new Notice("Unable to copy playback diagnostics from this device.");
      return false;
    }
  }

  async startOver(): Promise<void> {
    if (this.readingActionPending) return;
    this.readingActionPending = true;
    try {
      const active = this.audio.activeText;
      let opts: AudioTextOptions | undefined;
      if (
        active?.audio.sourcePath &&
        active.audio.sourceFingerprint != null &&
        active.audio.sourceStart != null &&
        active.audio.sourceEnd != null
      ) {
        opts = await this.optionsForSource(
          active.audio.sourcePath,
          active.audio.sourceStart,
          active.audio.sourceEnd,
          active.audio.sourceFingerprint,
        );
      } else if (active) {
        const text = active.audio.chunks.map((chunk) => chunk.rawText).join("");
        if (text.trim()) {
          opts = {
            filename: active.audio.filename,
            text,
            start: 0,
            end: text.length,
          };
        }
      } else {
        opts = await this.savedOptions();
      }
      if (!opts) return;
      active?.pause(); // Stop the old timeline before clearing its MediaSource.
      await this.progress?.resetToStart(opts);
      // Recreate detached/PDF playback without losing its status-bar menu.
      if (active && !active.audio.sourcePath) {
        this.playDetached(opts.text, opts.filename);
        return;
      }
      // startPlayer clears the MediaSource timeline: even chunk zero rewinds.
      await this.playSavedReading({ ...opts, resumeChunkIndex: 0 });
    } catch (error) {
      console.warn("Aloud: Start Over failed", error);
      new Notice("Couldn't restart reading. Check vault access and try again.");
    } finally {
      this.readingActionPending = false;
    }
  }

  playSelection(): void {
    const pdfView = this.getActivePdfView();
    if (pdfView) {
      void this.playPdfSelectionOrDocument(pdfView);
      return;
    }

    const current = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (isMarkdownReadingView(current)) {
      void this.playReadingView(current);
      return;
    }
    // The sticky editor is useful for Edit View, but must not override a
    // currently active Reading View (which has no CodeMirror selection).
    const focused = current ?? this.focusedEditorView;
    if (focused?.editor) {
      this.triggerSelection(focused.file, focused.editor);
    } else {
      new Notice("Focus a file or select some text first to play");
    }
  }

  /** Capture the preview selection before a mobile drawer can collapse it. */
  captureReadingSelection(): ReadingSelectionAnchor | undefined {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!isMarkdownReadingView(view) || !view.file) return undefined;
    const selected = readingViewSelection(
      view.containerEl,
      (typeof activeWindow !== "undefined"
        ? activeWindow
        : window
      ).getSelection(),
    );
    return selected
      ? { sourcePath: view.file.path, renderedText: selected }
      : undefined;
  }

  /** Continue through the note from the selected sentence group or editor cursor. */
  async playFromHere(anchor?: ReadingSelectionAnchor): Promise<void> {
    if (this.readingActionPending) return;
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view?.file || this.isInnermazeContext) {
      new Notice("Open an ordinary Markdown note to play from a line.");
      return;
    }
    const file = view.file;
    const preview = view.getMode() === "preview";
    const captured =
      anchor?.sourcePath === file.path
        ? anchor
        : this.captureReadingSelection();
    if (preview && !captured?.renderedText) {
      new Notice(
        "Select words in Reading View before choosing Play from here.",
      );
      return;
    }

    this.readingActionPending = true;
    try {
      const source = preview
        ? await this.app.vault.read(file)
        : view.editor.getValue();
      const offset = preview
        ? exactReadingViewSourceRange(source, captured!.renderedText)?.start
        : view.editor.posToOffset(view.editor.getCursor("from"));
      if (offset == null) {
        new Notice(
          "Selected text must appear uniquely and exactly in the note. Try selecting a shorter, plain-text phrase.",
        );
        return;
      }
      const options: AudioTextOptions = {
        filename: file.path,
        sourcePath: file.path,
        text: source,
        start: 0,
        end: source.length,
      };
      const index = chunkIndexAtSourceOffset(
        options,
        this.settings.settings.chunkType,
        offset,
      );
      if (index == null) {
        new Notice("No speakable text remains at the selected location.");
        return;
      }
      if (
        this.app.workspace.getActiveViewOfType(MarkdownView)?.file?.path !==
        file.path
      ) {
        new Notice(
          "The active note changed. Select your starting point again.",
        );
        return;
      }
      // The same source identity, full-document chunk boundaries and cache keys.
      // Never resume from a previous bookmark: the explicit selection wins.
      await this.playSavedReading({ ...options, resumeChunkIndex: index });
    } catch (error) {
      console.warn("Aloud: Play from here failed", error);
      new Notice("Couldn't start playback from the selected location.");
    } finally {
      this.readingActionPending = false;
    }
  }

  private async playReadingView(view: MarkdownView): Promise<void> {
    const file = view.file;
    if (!file) {
      new Notice("Open a saved note to listen in Reading View.");
      return;
    }
    const selection = readingViewSelection(
      view.containerEl,
      (typeof activeWindow !== "undefined"
        ? activeWindow
        : window
      ).getSelection(),
    );
    try {
      const source = await this.app.vault.read(file);
      if (!source.trim()) return;
      const selected = selection
        ? exactReadingViewSourceRange(source, selection)
        : { text: source, start: 0, end: source.length };
      if (!selected) {
        // A rendered selection might contain Markdown decorations omitted from
        // its source text. Speak it, but never invent bookmark source offsets.
        this.playDetached(selection, file.path);
        return;
      }
      const opts: AudioTextOptions = {
        ...selected,
        filename: file.path,
        sourcePath: file.path,
      };
      opts.resumeChunkIndex = this.progress?.positionFor(opts);
      await this.playSavedReading(opts);
    } catch (error) {
      console.warn("Aloud: Reading View playback could not start", error);
      new Notice("Couldn't start Reading View playback. Check vault access.");
    }
  }

  async playDocument(): Promise<void> {
    const view =
      this.app.workspace.getActiveViewOfType(MarkdownView) ??
      this.focusedEditorView;
    if (!view) {
      new Notice("Focus a note first to play the complete document.");
      return;
    }
    try {
      // Preserve unsaved edits in Source Mode, but use the saved note itself
      // when Reading View has no active CodeMirror editor.
      const text =
        isMarkdownReadingView(view) && view.file
          ? await this.app.vault.read(view.file)
          : view.editor.getValue();
      if (!text.trim()) return;
      await this.playSavedReading({
        text,
        filename: view.file?.path ?? "Untitled",
        sourcePath: view.file?.path,
        start: 0,
        end: text.length,
        resumeChunkIndex: 0,
      });
    } catch (error) {
      console.warn("Aloud: document playback failed", error);
      new Notice("Couldn't start document playback.");
    }
  }

  async openArticleCache(
    scope: "document" | "selection" | "saved" | "manage" = "document",
  ): Promise<void> {
    if (!this.articleCache) return;
    try {
      let opts: AudioTextOptions | undefined;
      const current = this.app.workspace.getActiveViewOfType(MarkdownView);
      const reading = isMarkdownReadingView(current) ? current : null;
      if (scope === "saved") {
        opts = await this.savedOptions();
      } else if (scope !== "manage" && reading?.file) {
        const source = await this.app.vault.read(reading.file);
        const selection =
          scope === "selection"
            ? readingViewSelection(
                reading.containerEl,
                (typeof activeWindow !== "undefined"
                  ? activeWindow
                  : window
                ).getSelection(),
              )
            : "";
        const mapped =
          scope === "selection"
            ? exactReadingViewSourceRange(source, selection)
            : { text: source, start: 0, end: source.length };
        if (!mapped) {
          throw new Error(
            "This rendered selection cannot be matched uniquely to Markdown. Play the selection instead, or pre-cache the full article.",
          );
        }
        opts = {
          ...mapped,
          filename: reading.file.path,
          sourcePath: reading.file.path,
        };
      } else if (scope === "document" && !this.focusedEditorView?.editor) {
        opts = await this.savedOptions();
      } else if (scope !== "manage") {
        const view = this.focusedEditorView;
        if (!view?.editor || !view.file)
          throw new Error("Focus a saved note first.");
        const fullText = view.editor.getValue();
        const selection =
          scope === "selection" ? view.editor.getSelection() : "";
        if (scope === "selection" && !selection.trim())
          throw new Error("Select a passage first.");
        const start =
          scope === "selection"
            ? view.editor.posToOffset(view.editor.getCursor("from"))
            : 0;
        const text = scope === "selection" ? selection : fullText;
        opts = {
          text,
          start,
          end: start + text.length,
          filename: view.file.path,
          sourcePath: view.file.path,
        };
      }
      if (scope !== "manage" && !opts) return;
      const job = opts
        ? await this.articleCache.prepare(opts)
        : selectCurrentArticleCacheJob(
            this.articleCache.jobs,
            this.app.workspace.getActiveViewOfType(MarkdownView)?.file?.path ??
              this.focusedEditorView?.file?.path ??
              this.audio.activeText?.audio.sourcePath,
          );
      new ArticleCacheModal(
        this.app,
        this.articleCache,
        this.settings,
        job,
        async (selected: ArticleJob) => {
          if (!this.articleCache)
            throw new Error("Cache manager is unavailable.");
          await this.playSavedReading(
            await this.articleCache.playbackOptions(selected),
          );
        },
        this.version,
      ).open();
    } catch (error) {
      new Notice(
        error instanceof Error ? error.message : "Couldn't open article cache.",
      );
    }
  }

  private getActivePdfView(): PdfFileView | null {
    const view = this.app.workspace.activeLeaf?.view;
    return isPdfFileView(view) ? view : null;
  }

  private async playPdfSelectionOrDocument(view: PdfFileView): Promise<void> {
    const file = view.file;
    if (!file) {
      new Notice("No PDF file to play");
      return;
    }
    const selection = this.getPdfSelection(view);
    if (selection) {
      this.playDetached(selection, file.path);
      return;
    }

    try {
      new Notice("Loading PDF text");
      const text = await this.readPdfText(file);
      this.playDetached(text, file.path);
    } catch (ex) {
      console.error("Failed to load PDF text", ex);
      new Notice("Failed to load PDF text");
    }
  }

  private getPdfSelection(view: PdfFileView): string {
    const selection = (
      typeof activeWindow !== "undefined" ? activeWindow : window
    ).getSelection();
    const text = selection?.toString().trim();
    if (!selection || !text || selection.rangeCount === 0) {
      return "";
    }

    const root = view.contentEl || view.containerEl;
    if (!root) {
      return "";
    }

    for (let index = 0; index < selection.rangeCount; index++) {
      const range = selection.getRangeAt(index);
      if (
        nodeIsInside(root, range.commonAncestorContainer) ||
        nodeIsInside(root, selection.anchorNode) ||
        nodeIsInside(root, selection.focusNode)
      ) {
        return text;
      }
    }
    return "";
  }

  private async readPdfText(file: TFile): Promise<string> {
    const pdfjs = (await loadPdfJs()) as PdfJs;
    const data = new Uint8Array(await this.app.vault.readBinary(file));
    const document = await pdfjs.getDocument({ data }).promise;
    try {
      const pages: string[] = [];
      for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber++) {
        const page = await document.getPage(pageNumber);
        const content = await page.getTextContent();
        const text = content.items
          .filter(isPdfTextItem)
          .map((item) => (item.hasEOL ? `${item.str}\n` : item.str))
          .join(" ")
          .replace(/[ \t]+\n/g, "\n")
          .replace(/\n[ \t]+/g, "\n")
          .trim();
        if (text) {
          pages.push(text);
        }
      }
      return pages.join("\n\n");
    } finally {
      await document.destroy?.();
    }
  }

  onTextChanged(position: number, type: "add" | "remove", text: string) {
    this.audio.activeText?.onTextChanged(position, type, text);
  }

  triggerSelection(
    file: TFile | null,
    editor: Editor,
    { extendShort }: { extendShort?: boolean } = {},
  ) {
    this._setActiveEditor();
    const player: AudioStore = this.audio;
    const from = editor.getCursor("from");
    let to = editor.getCursor("to");
    let isTooShort = false;
    if (extendShort) {
      const text = editor.getRange(from, to);
      isTooShort = !text.trim().match(/\s+/);
    }
    if ((from.ch === to.ch && from.line === to.line) || isTooShort) {
      to = {
        line: editor.lastLine(),
        ch: editor.getLine(editor.lastLine()).length,
      };
    }
    const start = editor.getRange({ line: 0, ch: 0 }, from).length;

    const selection = editor.getRange(from, to);
    if (selection) {
      try {
        const opts: AudioTextOptions = {
          text: selection,
          filename:
            [file?.path, file?.name].filter((x) => x).join("/") || "Untitled",
          sourcePath: file?.path,
          start,
          end: start + selection.length,
        };
        opts.resumeChunkIndex = this.progress?.positionFor(opts);
        player.startPlayer(opts).catch((ex) => {
          console.error("Couldn't start player!", ex);
        });
      } catch (ex) {
        console.error("Couldn't start player!", ex);
      }
    } else {
      new Notice("No text selected to speak");
    }
  }

  openSettings(): void {
    // big ugly hack. There's hopefully a better way to do this
    type Commands = {
      commands?: { commands?: Record<string, { callback?: () => void }> };
    };
    (this.app as unknown as Commands)?.commands?.commands?.[
      "app:open-settings"
    ]?.callback?.();
  }
}

export function isObsidianBridgeSpecifics(
  bridge: TTSEditorBridge,
): bridge is TTSEditorBridge & ObsidianBridgeSpecifics {
  return (bridge as any).activeObsidianEditor !== undefined;
}

function triggerBrowserDownload(bytes: ArrayBuffer, filename: string): void {
  const blob = new Blob([bytes], { type: "audio/mpeg" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  // Defer revocation to give the browser time to start the download.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function openExportDestinationModal(
  app: App,
): Promise<"vault" | "download" | null> {
  return new Promise((resolve) => {
    const modal = new ExportDestinationModal(app, resolve);
    modal.open();
  });
}

class ExportDestinationModal extends Modal {
  private resolved = false;
  constructor(
    app: App,
    private onChoice: (choice: "vault" | "download" | null) => void,
  ) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText("Save audio file");
    this.contentEl.createEl("p", {
      text: "Where would you like to save the generated audio?",
    });
    new Setting(this.contentEl)
      .addButton((btn) =>
        btn.setButtonText("Vault folder").onClick(() => this.choose("vault")),
      )
      .addButton((btn) =>
        btn
          .setButtonText("Download")
          .setCta()
          .onClick(() => this.choose("download")),
      )
      .addButton((btn) =>
        btn.setButtonText("Cancel").onClick(() => this.choose(null)),
      );
  }

  onClose(): void {
    if (!this.resolved) {
      this.onChoice(null);
    }
    this.contentEl.empty();
  }

  private choose(choice: "vault" | "download" | null): void {
    this.resolved = true;
    this.onChoice(choice);
    this.close();
  }
}

function isPdfTextItem(item: unknown): item is PdfTextItem {
  return (
    typeof item === "object" &&
    item !== null &&
    "str" in item &&
    typeof item.str === "string"
  );
}

function isPdfFileView(view: unknown): view is PdfFileView {
  return (
    typeof view === "object" &&
    view !== null &&
    "file" in view &&
    "getViewType" in view &&
    typeof view.getViewType === "function" &&
    view.getViewType() === "pdf"
  );
}

function nodeIsInside(root: HTMLElement, node: Node | null): boolean {
  return !!node && (node === root || root.contains(node));
}

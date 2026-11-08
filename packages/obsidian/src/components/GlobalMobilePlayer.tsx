import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import * as mobx from "mobx";
import { observer } from "mobx-react-lite";
import { MarkdownView, setIcon } from "obsidian";
import type { App } from "obsidian";
import {
  type AudioStore,
  type TTSPluginSettingsStore,
  createTTSActions,
} from "open-tts";
import type { ObsidianBridge, ReadingSelectionAnchor } from "../ObsidianBridge";
import { ObsidianTooltipProvider } from "../util/ObsidianTooltipService";
import { TTSControlMenuContent } from "./TTSControlMenu";

/** On phones the player belongs to the active note, never to the app overlay. */
export class GlobalMobilePlayerHost {
  private readonly container: HTMLElement;
  private readonly root: Root;
  private readonly stopLayoutReaction: () => void;
  private readonly mobile: boolean;
  private mountFrame: number | null = null;

  private updateMobileMount(): void {
    if (!this.mobile || !this.app) return;
    const workspace = this.app.workspace;
    const view = workspace.getActiveViewOfType(MarkdownView);
    // Do not show above file pickers, settings or other active views; the
    // existing track and its reading checkpoint remain entirely untouched.
    if (
      !view?.file ||
      workspace.activeLeaf?.view !== view ||
      view.getViewType() !== "markdown" ||
      this.bridge.isInnermazeContext
    ) {
      this.container.remove();
      return;
    }
    const content = view.containerEl.querySelector(".view-content");
    if (!(content instanceof HTMLElement)) {
      this.container.remove();
      return;
    }
    // The mobile safe-area and note header belong to Obsidian's view-content
    // layout. Mounting before view-content bypasses that inset and covers the
    // iOS status bar; mount inside it, ahead of the rendered article instead.
    if (
      this.container.parentElement !== content ||
      content.firstElementChild !== this.container
    ) {
      content.insertBefore(this.container, content.firstChild);
    }
    this.positionBelowMobileHeader(view);
  }

  /** Obsidian's phone header can float over the top of .view-content.
   * Account for its actual screen geometry instead of trusting a safe-area
   * inset or a hard-coded number of pixels. The margin stays within the note.
   */
  private positionBelowMobileHeader(view: MarkdownView): void {
    // Measure the natural position, not last frame's added clearance.
    this.container.style.marginTop = "0px";
    const dockTop = this.container.getBoundingClientRect().top;
    const header = view.containerEl.querySelector<HTMLElement>(".view-header");
    const headerRect = header?.getBoundingClientRect();
    const headerBottom =
      headerRect && headerRect.height > 0 ? headerRect.bottom : 0;
    const safeArea = Number.parseFloat(
      window
        .getComputedStyle(view.containerEl)
        .getPropertyValue("--safe-area-inset-top"),
    );
    const obstructionBottom = Math.max(
      headerBottom,
      Number.isFinite(safeArea) ? safeArea : 0,
    );
    const gap =
      obstructionBottom > dockTop
        ? Math.ceil(obstructionBottom - dockTop + 8)
        : 0;
    this.container.style.marginTop = `${gap}px`;
  }

  private readonly onWorkspaceChange = (): void => {
    this.updateMobileMount();
    if (this.mountFrame !== null) window.cancelAnimationFrame(this.mountFrame);
    // Obsidian sometimes constructs .view-content after active-leaf-change.
    this.mountFrame = window.requestAnimationFrame(() => {
      this.mountFrame = null;
      this.updateMobileMount();
    });
  };

  constructor(
    player: AudioStore,
    settings: TTSPluginSettingsStore,
    private readonly bridge: ObsidianBridge,
    private readonly app?: App,
  ) {
    this.container = document.createElement("div");
    this.mobile = bridge.isMobile();
    this.container.className = this.mobile
      ? "tts-global-mobile-host"
      : "tts-global-desktop-host";
    // Desktop remains as before. Mobile never briefly flashes over dialogs.
    if (!this.mobile) document.body.appendChild(this.container);
    this.stopLayoutReaction = mobx.reaction(
      () => [
        settings.settings.floatingPlayerPosition,
        settings.settings.floatingPlayerWidth,
      ],
      ([position, width]) => {
        this.container.classList.toggle("tts-player-top", position === "top");
        this.container.classList.toggle("tts-player-full", width === "full");
      },
      { fireImmediately: true },
    );
    this.root = createRoot(this.container);
    this.root.render(
      <ObsidianTooltipProvider>
        <GlobalMobilePlayer
          player={player}
          settings={settings}
          bridge={bridge}
        />
      </ObsidianTooltipProvider>,
    );
    if (this.mobile && this.app) {
      // Separate calls preserve Obsidian's strongly typed event overloads.
      this.app.workspace.on("active-leaf-change", this.onWorkspaceChange);
      this.app.workspace.on("file-open", this.onWorkspaceChange);
      this.app.workspace.on("layout-change", this.onWorkspaceChange);
      window.addEventListener("resize", this.onWorkspaceChange);
      this.onWorkspaceChange();
    }
  }

  destroy(): void {
    if (this.mobile && this.app) {
      this.app.workspace.off("active-leaf-change", this.onWorkspaceChange);
      this.app.workspace.off("file-open", this.onWorkspaceChange);
      this.app.workspace.off("layout-change", this.onWorkspaceChange);
      window.removeEventListener("resize", this.onWorkspaceChange);
    }
    if (this.mountFrame !== null) window.cancelAnimationFrame(this.mountFrame);
    this.stopLayoutReaction();
    this.root.unmount();
    this.container.remove();
  }
}

/**
 * Playback belongs to Aloud's AudioStore, not a particular Markdown editor.
 * Reading View, Live Preview and Source View all share the same controls.
 */
export const GlobalMobilePlayer = observer(
  ({
    player,
    settings,
    bridge,
  }: {
    player: AudioStore;
    settings: TTSPluginSettingsStore;
    bridge: ObsidianBridge;
  }): React.ReactElement | null => {
    const [menuOpen, setMenuOpen] = React.useState(false);
    const [readingSelection, setReadingSelection] = React.useState<
      ReadingSelectionAnchor | undefined
    >(undefined);
    const pointerSelection = React.useRef<ReadingSelectionAnchor | undefined>(
      undefined,
    );
    const actions = React.useMemo(
      () => createTTSActions(player, settings, bridge),
      [player, settings, bridge],
    );
    const active = player.activeText;
    const mobile = bridge.isMobile();
    const isPhone = mobile && window.innerWidth < 600;
    const isMac = !mobile;
    const hasNote = bridge.activeViewType === "markdown";
    // On iPhone the dock is note-specific, never a global floating player.
    // Desktop deliberately retains its previous detached/PDF behavior.
    const visible =
      !bridge.isInnermazeContext &&
      (isPhone
        ? hasNote && !!bridge.activeMarkdownPath
        : isMac &&
          (hasNote ||
            !!active ||
            bridge.hasSavedReading() ||
            bridge.canPlayDetachedAudio));

    React.useEffect(() => {
      if (!visible) setMenuOpen(false);
    }, [visible]);

    // Never leave a previous article's menu or selection attached to a new one.
    React.useEffect(() => {
      setMenuOpen(false);
      setReadingSelection(undefined);
      pointerSelection.current = undefined;
    }, [bridge.activeMarkdownPath]);

    React.useEffect(() => {
      if (!menuOpen) return;
      const onEscape = (event: KeyboardEvent): void => {
        if (event.key === "Escape") setMenuOpen(false);
      };
      document.addEventListener("keydown", onEscape);
      return () => document.removeEventListener("keydown", onEscape);
    }, [menuOpen]);

    if (!visible) return null;

    const currentNotePath = hasNote ? bridge.activeMarkdownPath : null;
    // A track from a different article is not the currently displayed article.
    // Keep the old track/bookmark, but don't aim the dock's controls at it.
    const showingAnotherArticle =
      !!currentNotePath &&
      !!active &&
      active.audio.sourcePath !== currentNotePath;
    const currentAudio = showingAnotherArticle ? null : active;
    const title =
      currentNotePath?.split("/").pop() ??
      active?.audio.filename?.split("/").pop() ??
      "Aloud";
    const progress =
      currentAudio &&
      currentAudio.position >= 0 &&
      currentAudio.audio.chunks.length > 0
        ? `${currentAudio.position + 1} / ${currentAudio.audio.chunks.length}`
        : hasNote
          ? "Current note"
          : bridge.hasSavedReading()
            ? "Saved reading"
            : "Ready";
    const isPlaying = currentAudio?.isPlaying ?? false;

    return (
      <>
        {menuOpen && (
          <div className="tts-global-mobile-overlay">
            <button
              className="tts-global-mobile-backdrop"
              type="button"
              aria-label="Close Aloud menu"
              onClick={() => setMenuOpen(false)}
            />
            <div
              className="menu tts-global-mobile-menu"
              aria-label="Aloud playback menu"
            >
              <TTSControlMenuContent
                actions={actions}
                player={player}
                settings={settings}
                bridge={bridge}
                readingSelection={readingSelection}
                onClose={() => setMenuOpen(false)}
              />
            </div>
          </div>
        )}
        <div
          className="tts-global-mobile-dock"
          role="toolbar"
          aria-label="Aloud player"
        >
          <div className="tts-global-mobile-caption">
            <span className="tts-global-mobile-title" title={title}>
              {title}
            </span>
            <span className="tts-global-mobile-progress">{progress}</span>
          </div>
          <div className="tts-global-mobile-buttons">
            <DockButton
              icon="skip-back"
              label="Previous sentence"
              disabled={!currentAudio}
              onClick={actions.previous}
            />
            <DockButton
              icon={isPlaying ? "pause" : "play"}
              label={
                isPlaying
                  ? "Pause Aloud"
                  : currentAudio
                    ? "Resume Aloud"
                    : "Play current note"
              }
              primary
              onClick={actions.playPause}
            />
            <DockButton
              icon="skip-forward"
              label="Next sentence"
              disabled={!currentAudio}
              onClick={actions.next}
            />
            <DockButton
              icon="locate-fixed"
              label="Jump to playing line"
              disabled={
                !currentAudio?.currentChunk || !currentAudio.audio.sourcePath
              }
              onClick={() => bridge.jumpToPlayingLine()}
            />
            <DockButton
              icon="ellipsis"
              label="More Aloud controls"
              onPointerDown={() => {
                // iOS may collapse the rendered text selection on button focus.
                pointerSelection.current = bridge.captureReadingSelection();
              }}
              onClick={() => {
                const captured =
                  pointerSelection.current ?? bridge.captureReadingSelection();
                pointerSelection.current = undefined;
                setReadingSelection(menuOpen ? undefined : captured);
                setMenuOpen((before) => !before);
              }}
              expanded={menuOpen}
            />
          </div>
        </div>
      </>
    );
  },
);

const DockButton: React.FC<{
  icon: string;
  label: string;
  onClick: () => void;
  onPointerDown?: () => void;
  disabled?: boolean;
  primary?: boolean;
  expanded?: boolean;
}> = ({
  icon,
  label,
  onClick,
  onPointerDown,
  disabled = false,
  primary = false,
  expanded,
}) => (
  <button
    type="button"
    className={`tts-global-mobile-button${primary ? " is-primary" : ""}`}
    aria-label={label}
    aria-expanded={expanded}
    aria-haspopup={expanded === undefined ? undefined : "menu"}
    disabled={disabled}
    onPointerDown={onPointerDown}
    onClick={onClick}
  >
    <DockIcon icon={icon} />
  </button>
);

const DockIcon: React.FC<{ icon: string }> = ({ icon }) => {
  const ref = React.useRef<HTMLSpanElement>(null);
  React.useEffect(() => {
    if (ref.current) setIcon(ref.current, icon);
  }, [icon]);
  return <span className="svg-icon" ref={ref} aria-hidden="true" />;
};

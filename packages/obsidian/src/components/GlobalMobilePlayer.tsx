import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import * as mobx from "mobx";
import { observer } from "mobx-react-lite";
import { setIcon } from "obsidian";
import {
  type AudioStore,
  type TTSPluginSettingsStore,
  createTTSActions,
} from "open-tts";
import type { ObsidianBridge } from "../ObsidianBridge";
import { ObsidianTooltipProvider } from "../util/ObsidianTooltipService";
import { TTSControlMenuContent } from "./TTSControlMenu";

/** One host per plugin, attached to the application rather than CodeMirror. */
export class GlobalMobilePlayerHost {
  private readonly container: HTMLElement;
  private readonly root: Root;
  private readonly stopLayoutReaction: () => void;

  constructor(
    player: AudioStore,
    settings: TTSPluginSettingsStore,
    bridge: ObsidianBridge,
  ) {
    this.container = document.createElement("div");
    // The same AudioStore-backed dock serves iPhone and Mac. Keep the
    // platform-specific position/size in CSS, not in a second player.
    this.container.className = bridge.isMobile()
      ? "tts-global-mobile-host"
      : "tts-global-desktop-host";
    document.body.appendChild(this.container);
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
  }

  destroy(): void {
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
    const actions = React.useMemo(
      () => createTTSActions(player, settings, bridge),
      [player, settings, bridge],
    );
    const active = player.activeText;
    const mobile = bridge.isMobile();
    const isPhone = mobile && window.innerWidth < 600;
    const isMac = !mobile;
    const hasNote = bridge.activeViewType === "markdown";
    const visible =
      (isPhone || isMac) &&
      (hasNote ||
        !!active ||
        bridge.hasSavedReading() ||
        bridge.canPlayDetachedAudio);

    React.useEffect(() => {
      if (!visible) setMenuOpen(false);
    }, [visible]);

    React.useEffect(() => {
      if (!menuOpen) return;
      const onEscape = (event: KeyboardEvent): void => {
        if (event.key === "Escape") setMenuOpen(false);
      };
      document.addEventListener("keydown", onEscape);
      return () => document.removeEventListener("keydown", onEscape);
    }, [menuOpen]);

    if (!visible) return null;

    const title = active?.audio.filename?.split("/").pop() ?? "Aloud";
    const progress =
      active && active.position >= 0 && active.audio.chunks.length > 0
        ? `${active.position + 1} / ${active.audio.chunks.length}`
        : hasNote
          ? "Current note"
          : bridge.hasSavedReading()
            ? "Saved reading"
            : "Ready";
    const isPlaying = active?.isPlaying ?? false;

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
              disabled={!active}
              onClick={actions.previous}
            />
            <DockButton
              icon={isPlaying ? "pause" : "play"}
              label={
                isPlaying
                  ? "Pause Aloud"
                  : active
                    ? "Resume Aloud"
                    : "Play current note"
              }
              primary
              onClick={actions.playPause}
            />
            <DockButton
              icon="skip-forward"
              label="Next sentence"
              disabled={!active}
              onClick={actions.next}
            />
            <DockButton
              icon="locate-fixed"
              label="Jump to playing line"
              disabled={!active?.currentChunk || !active.audio.sourcePath}
              onClick={() => bridge.jumpToPlayingLine()}
            />
            <DockButton
              icon="ellipsis"
              label="More Aloud controls"
              onClick={() => setMenuOpen((before) => !before)}
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
  disabled?: boolean;
  primary?: boolean;
  expanded?: boolean;
}> = ({
  icon,
  label,
  onClick,
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

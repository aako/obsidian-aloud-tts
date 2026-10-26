import { observer } from "mobx-react-lite";
import * as React from "react";
import { createRoot, Root } from "react-dom/client";
import {
  AudioSink,
  AudioStore,
  createTTSActions,
  TTSPluginSettingsStore,
} from "open-tts";
import { AudioStatusInfoContents } from "@open-tts/ui";
import { ObsidianBridge } from "../ObsidianBridge";
import { ObsidianTooltipProvider } from "../util/ObsidianTooltipService";
import { setIcon } from "obsidian";
import { TTSControlMenuContent } from "./TTSControlMenu";

type SinkWithElement = AudioSink & { audioElement?: HTMLAudioElement };

export class DetachedPlayerHost {
  private root: Root;

  constructor(
    private container: HTMLElement,
    player: AudioStore,
    settings: TTSPluginSettingsStore,
    sink: AudioSink,
    bridge: ObsidianBridge,
  ) {
    this.container.classList.add("tts-detached-player-host");
    this.root = createRoot(this.container);
    this.root.render(
      <ObsidianTooltipProvider>
        <DetachedPlayerView
          player={player}
          settings={settings}
          sink={sink}
          bridge={bridge}
          audioElement={(sink as SinkWithElement).audioElement}
        />
      </ObsidianTooltipProvider>,
    );
  }

  destroy(): void {
    this.root.unmount();
    this.container.remove();
  }
}

export const DetachedPlayerView = observer(
  ({
    player,
    settings,
    bridge,
    audioElement,
  }: {
    player: AudioStore;
    settings: TTSPluginSettingsStore;
    sink: AudioSink;
    bridge: ObsidianBridge;
    audioElement?: HTMLAudioElement;
  }): React.ReactNode => {
    const active = player.activeText;
    const hasDetachedPlayback = bridge.detachedAudio && !!active;
    // Desktop status bar also exposes the same menu for ordinary Markdown notes.
    // Unlike a CodeMirror panel it survives Source/Live Preview/Reading switches.
    const hasMarkdownNote = bridge.activeViewType === "markdown";
    const shouldShow =
      hasMarkdownNote || hasDetachedPlayback || bridge.canPlayDetachedAudio;
    const canOpenMenu = hasMarkdownNote || hasDetachedPlayback;
    const [isMenuOpen, setIsMenuOpen] = React.useState(false);
    const buttonRef = React.useRef<HTMLButtonElement | null>(null);
    const actions = React.useMemo(
      () => createTTSActions(player, settings, bridge),
      [player, settings, bridge],
    );

    React.useEffect(() => {
      if (!shouldShow) {
        setIsMenuOpen(false);
      }
    }, [shouldShow]);

    React.useEffect(() => {
      if (!isMenuOpen) {
        return;
      }

      const handleMouseDown = (event: MouseEvent): void => {
        if (
          buttonRef.current &&
          !buttonRef.current.parentElement?.contains(event.target as Node)
        ) {
          setIsMenuOpen(false);
        }
      };

      document.addEventListener("mousedown", handleMouseDown);
      return () => document.removeEventListener("mousedown", handleMouseDown);
    }, [isMenuOpen]);

    if (!shouldShow) {
      return null;
    }

    const title = active?.audio.filename || active?.audio.friendlyName;

    const handleClick = (): void => {
      if (canOpenMenu) {
        setIsMenuOpen((opened) => !opened);
        return;
      }
      bridge.playSelection();
    };

    return (
      <>
        <div className="tts-detached-status-content">
          <button
            ref={buttonRef}
            type="button"
            className="tts-detached-status-button"
            aria-label={
              canOpenMenu ? "Open playback controls" : "Play PDF audio"
            }
            aria-expanded={isMenuOpen}
            aria-haspopup={canOpenMenu ? "menu" : undefined}
            onClick={handleClick}
          >
            <ObsidianIcon icon={canOpenMenu ? "audio-lines" : "file-text"} />
            {canOpenMenu ? (
              <span
                className="tts-detached-status-title"
                title={title ?? "Aloud"}
              >
                {active ? title : "Aloud"}
              </span>
            ) : (
              <span>Aloud PDF</span>
            )}
          </button>
          {hasDetachedPlayback && (
            <span className="tts-detached-status-info">
              <AudioStatusInfoContents
                audioElement={audioElement}
                player={player}
                settings={settings}
                onOpenSettings={() => bridge.openSettings()}
              />
            </span>
          )}
        </div>
        {isMenuOpen && canOpenMenu && (
          <div
            className="menu tts-detached-player-menu"
            onClick={(event) => event.stopPropagation()}
          >
            <TTSControlMenuContent
              actions={actions}
              player={player}
              settings={settings}
              bridge={bridge}
              onClose={() => setIsMenuOpen(false)}
              showRestartFromCursor={hasMarkdownNote}
              showAutoscroll={hasMarkdownNote}
            />
          </div>
        )}
      </>
    );
  },
);

const ObsidianIcon: React.FC<{ icon: string }> = ({ icon }) => {
  const ref = React.useRef<HTMLSpanElement>(null);

  React.useEffect(() => {
    if (ref.current) {
      setIcon(ref.current, icon);
    }
  }, [icon]);

  return <span ref={ref} className="svg-icon" aria-hidden="true" />;
};

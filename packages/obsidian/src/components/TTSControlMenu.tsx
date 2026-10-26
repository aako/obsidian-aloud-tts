import { observer } from "mobx-react-lite";
import * as React from "react";
import { setIcon } from "obsidian";
import { TTSActions } from "open-tts";
import { AudioStore } from "open-tts";
import { TTSPluginSettingsStore } from "open-tts";
import type { ObsidianBridge } from "../ObsidianBridge";

export interface TTSControlMenuProps {
  actions: TTSActions;
  player: AudioStore;
  settings: TTSPluginSettingsStore;
  bridge?: ObsidianBridge;
  onClose: () => void;
  showRestartFromCursor?: boolean;
  showAutoscroll?: boolean;
}

const MIN_SPEED = 0.5;
const MAX_SPEED = 2.5;
const SPEED_STEP = 0.1;

/**
 * Custom TTS control menu content component.
 * Renders the inner content of the menu (without the outer .menu wrapper).
 * The container element should have class="menu" applied.
 */
export const TTSControlMenuContent = observer(
  ({
    actions,
    player,
    settings,
    bridge,
    onClose,
    showRestartFromCursor = true,
    showAutoscroll = true,
  }: TTSControlMenuProps): React.ReactElement => {
    const active = player.activeText;
    const isPlaying = active?.isPlaying ?? false;
    const speed = settings.settings.playbackSpeed;

    // Close on Escape
    React.useEffect(() => {
      const handleKeyDown = (e: KeyboardEvent): void => {
        if (e.key === "Escape") {
          onClose();
        }
      };
      document.addEventListener("keydown", handleKeyDown);
      return () => document.removeEventListener("keydown", handleKeyDown);
    }, [onClose]);

    const handleSpeedChange = (
      e: React.ChangeEvent<HTMLInputElement>,
    ): void => {
      const newSpeed = parseFloat(e.target.value);
      settings.setSpeed(newSpeed);
    };

    return (
      <>
        {/* Grabber for mobile drawer UI */}
        <div className="menu-grabber" />
        <div className="menu-scroll tts-aloud-controls">
          {bridge?.version && (
            <div className="tts-menu-row" aria-label="Aloud version">
              Aloud v{bridge.version}
            </div>
          )}
          {bridge?.readingProgressLabel() && (
            <div className="tts-menu-row" role="status">
              {bridge?.readingProgressLabel()}
            </div>
          )}
          {active && active.position >= 0 && active.audio.chunks.length > 0 && (
            <progress
              className="tts-menu-progress"
              aria-label="Reading progress"
              value={active.position + 1}
              max={active.audio.chunks.length}
            />
          )}
          {/* Playback controls group */}
          <div className="menu-group tts-menu-playback-group">
            <div className="tts-menu-row tts-menu-playback">
              <IconButton
                icon="skip-back"
                label="Previous"
                onClick={() => actions.previous()}
                disabled={!active}
              />
              <IconButton
                icon={isPlaying ? "pause" : "play"}
                label={
                  isPlaying ? "Pause" : active ? "Continue" : "Play Selection"
                }
                onClick={() => actions.playPause()}
                primary
              />
              <IconButton
                icon="skip-forward"
                label="Next"
                onClick={() => actions.next()}
                disabled={!active}
              />
              <IconButton
                icon="square"
                label="Stop"
                onClick={() => {
                  actions.stop();
                  onClose();
                }}
                disabled={!active}
              />
            </div>
          </div>

          {showRestartFromCursor && (
            <div className="menu-group">
              <button
                type="button"
                className="menu-item tappable"
                onClick={() => {
                  onClose();
                  actions.playSelection();
                }}
              >
                Play Selection / From Cursor
              </button>
              {bridge && (
                <button
                  type="button"
                  className="menu-item tappable"
                  onClick={() => {
                    onClose();
                    void bridge.playDocument();
                  }}
                >
                  Play Entire Document
                </button>
              )}
            </div>
          )}

          {(bridge?.hasSavedReading() || active) && (
            <>
              <div className="menu-separator" />
              <div className="menu-group">
                {bridge && active?.audio.sourcePath && (
                  <button
                    className="menu-item tappable"
                    type="button"
                    onClick={() => {
                      onClose();
                      bridge.jumpToPlayingLine();
                    }}
                  >
                    <span className="menu-item-icon">
                      <ObsidianIcon icon="locate-fixed" />
                    </span>
                    <span className="menu-item-title">
                      Jump to playing line
                    </span>
                  </button>
                )}
                {bridge && active?.currentChunk && (
                  <button
                    className="menu-item tappable"
                    type="button"
                    onClick={() => {
                      onClose();
                      bridge.retryCurrentSentence();
                    }}
                  >
                    <span className="menu-item-icon">
                      <ObsidianIcon icon="refresh-cw" />
                    </span>
                    <span className="menu-item-title">
                      Retry current sentence (buffered only)
                    </span>
                  </button>
                )}
                {bridge?.hasSavedReading() && (
                  <button
                    className="menu-item tappable"
                    type="button"
                    onClick={() => {
                      onClose();
                      void bridge?.resumeSavedReading();
                    }}
                  >
                    <span className="menu-item-icon">
                      <ObsidianIcon icon="bookmark" />
                    </span>
                    <span className="menu-item-title">
                      Resume saved article
                    </span>
                  </button>
                )}
                {bridge && (active || bridge.hasSavedReading()) && (
                  <button
                    className="menu-item tappable"
                    type="button"
                    onClick={() => {
                      onClose();
                      void bridge?.startOver();
                    }}
                  >
                    <span className="menu-item-icon">
                      <ObsidianIcon icon="rotate-ccw" />
                    </span>
                    <span className="menu-item-title">Start Over</span>
                  </button>
                )}
              </div>
            </>
          )}

          {(bridge?.hasSavedReading() || !!active || showAutoscroll) && (
            <div className="menu-separator" />
          )}

          {bridge && (
            <div className="menu-group">
              {showRestartFromCursor && (
                <>
                  <button
                    type="button"
                    className="menu-item tappable"
                    onClick={() => {
                      onClose();
                      void bridge.openArticleCache("document");
                    }}
                  >
                    Pre-cache Entire Article
                  </button>
                  <button
                    type="button"
                    className="menu-item tappable"
                    onClick={() => {
                      onClose();
                      void bridge.openArticleCache("selection");
                    }}
                  >
                    Pre-cache Selection
                  </button>
                </>
              )}
              {bridge.hasSavedReading() && (
                <button
                  type="button"
                  className="menu-item tappable"
                  onClick={() => {
                    onClose();
                    void bridge.openArticleCache("saved");
                  }}
                >
                  Pre-cache Saved Reading
                </button>
              )}
              <button
                type="button"
                className="menu-item tappable"
                onClick={() => {
                  onClose();
                  void bridge.openArticleCache("manage");
                }}
              >
                Manage Article Cache
              </button>
            </div>
          )}

          <div className="menu-group">
            <div className="menu-item tts-menu-speed">
              <div className="menu-item-icon">
                <ObsidianIcon icon="gauge" />
              </div>
              <input
                type="range"
                className="tts-menu-slider"
                aria-label="Playback speed"
                min={MIN_SPEED}
                max={MAX_SPEED}
                step={SPEED_STEP}
                value={speed}
                onChange={handleSpeedChange}
              />
              <span className="tts-menu-speed-value">{speed.toFixed(1)}x</span>
            </div>

            {showAutoscroll && (
              <div
                className="menu-item tappable"
                onClick={() => actions.toggleAutoscroll()}
              >
                <div className="menu-item-icon">
                  <ObsidianIcon
                    icon={actions.autoscrollEnabled() ? "eye" : "eye-off"}
                  />
                </div>
                <div className="menu-item-title">
                  Auto scroll: {actions.autoscrollEnabled() ? "ON" : "OFF"}
                </div>
              </div>
            )}
          </div>
        </div>
      </>
    );
  },
);

interface IconButtonProps {
  icon: string;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  primary?: boolean;
}

const IconButton: React.FC<IconButtonProps> = ({
  icon,
  label,
  onClick,
  disabled = false,
  primary = false,
}) => {
  return (
    <button
      className={`tts-menu-icon-btn ${primary ? "tts-menu-icon-btn-primary" : ""} ${disabled ? "is-disabled" : ""}`}
      onClick={(e) => {
        e.stopPropagation();
        if (!disabled) onClick();
      }}
      disabled={disabled}
      aria-label={label}
      title={label}
    >
      <ObsidianIcon icon={icon} />
    </button>
  );
};

const ObsidianIcon: React.FC<{ icon: string }> = ({ icon }) => {
  const ref = React.useRef<HTMLSpanElement>(null);
  React.useEffect(() => {
    if (ref.current) {
      setIcon(ref.current, icon);
    }
  }, [icon]);
  return <span ref={ref} className="svg-icon" />;
};

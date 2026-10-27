import { vi } from "vitest";

export {
  createTestAudioStore,
  createTestSettingsStore,
  FakeAudioSink,
} from "../../open-tts/src/test-utils";

export const createMockEditorView = () => ({
  state: { doc: { toString: () => "test content" } },
  dispatch: vi.fn(),
});

export const createMockObsidianBridge = () => ({
  activeEditor: undefined,
  focusedEditor: undefined,
  activeObsidianEditor: undefined,
  canPlayDetachedAudio: false,
  isInnermazeContext: false,
  detachedAudio: false,
  triggerSelection: vi.fn(),
  playSelection: vi.fn(),
  captureReadingSelection: vi.fn(),
  playFromHere: vi.fn(async () => undefined),
  playDocument: vi.fn(),
  openArticleCache: vi.fn(),
  playDetached: vi.fn(),
  playClipboard: vi.fn(),
  playSavedReading: vi.fn(),
  hasSavedReading: vi.fn(() => false),
  resumeSavedReading: vi.fn(),
  startOver: vi.fn(),
  jumpToPlayingLine: vi.fn(() => true),
  retryCurrentSentence: vi.fn(() => true),
  copyPlaybackDiagnostics: vi.fn(async () => true),
  readingProgressLabel: vi.fn((): string | undefined => undefined),
  onTextChanged: vi.fn(),
  openSettings: vi.fn(),
  destroy: vi.fn(),
  isMobile: vi.fn(() => false),
  exportAudio: vi.fn(),
  saveDocumentAudio: vi.fn(),
});

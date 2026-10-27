import type { MarkdownView } from "obsidian";
import { buildTrack } from "open-tts";
import type { AudioTextOptions } from "open-tts";

/** Reading View renders text without an active CodeMirror selection. */
export function isMarkdownReadingView(
  view: MarkdownView | null | undefined,
): view is MarkdownView {
  return !!view && view.getMode() === "preview";
}

/**
 * Ignore selected text from another note, a menu or the surrounding app UI.
 * Don't infer text from a stale EditorView while the current note is previewed.
 */
export function readingViewSelection(
  container: HTMLElement,
  selection: Selection | null,
): string {
  const preview = container.querySelector(".markdown-preview-view");
  if (!preview || !selection || selection.isCollapsed || !selection.rangeCount)
    return "";
  for (let i = 0; i < selection.rangeCount; i++) {
    const range = selection.getRangeAt(i);
    if (
      !preview.contains(range.startContainer) ||
      !preview.contains(range.endContainer)
    )
      return "";
  }
  return selection.toString().trim();
}

/**
 * Map only UNIQUE exact raw-source matches to resumable reading checkpoints.
 * Rendered Markdown can differ from its raw source (emphasis, wikilinks, etc).
 * An ambiguous/nonexact match must never create an invented file offset.
 */
export function exactReadingViewSourceRange(
  source: string,
  renderedSelection: string,
): { text: string; start: number; end: number } | undefined {
  const text = renderedSelection.trim();
  if (!text) return undefined;
  const start = source.indexOf(text);
  if (start < 0 || source.indexOf(text, start + 1) >= 0) return undefined;
  return { text, start, end: start + text.length };
}

/**
 * Seek within the unchanged full-document chunk sequence. Using a suffix as a
 * new track would change cache keys and the saved-reading identity, whereas
 * a resume chunk uses exactly the same audio chunks as normal playback.
 * A selected character inside a chunk starts at that chunk's beginning.
 */
export function chunkIndexAtSourceOffset(
  options: AudioTextOptions,
  chunkType: "sentence" | "paragraph",
  offset: number,
): number | undefined {
  if (
    !Number.isSafeInteger(offset) ||
    offset < options.start ||
    offset >= options.end
  )
    return undefined;
  const chunks = buildTrack(options, chunkType).chunks;
  const index = chunks.findIndex((chunk) => chunk.end > offset);
  return index < 0 ? undefined : index;
}

/**
 * The source offset stored with a played chunk survives Reading View's virtual
 * rendering, unlike a DOM text lookup. Reject stale or edited source: a guessed
 * line could take the reader to the wrong passage.
 */
export function sourceLineForPlayingChunk(
  source: string,
  chunk: { start: number; end: number; rawText: string },
): number | undefined {
  if (
    !Number.isSafeInteger(chunk.start) ||
    !Number.isSafeInteger(chunk.end) ||
    chunk.start < 0 ||
    chunk.end <= chunk.start ||
    chunk.end > source.length ||
    source.slice(chunk.start, chunk.end) !== chunk.rawText
  )
    return undefined;

  let line = 0;
  for (let index = 0; index < chunk.start; index++) {
    if (source[index] === "\n") line++;
  }
  return line;
}

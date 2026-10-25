import type { MarkdownView } from "obsidian";

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

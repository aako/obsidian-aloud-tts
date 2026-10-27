import * as mobx from "mobx";
import { App, MarkdownView } from "obsidian";
import type { AudioStore } from "open-tts";

/** Lightweight source-independent text match: never rewrite Obsidian's rendered DOM. */
type TextAddress = { node: Text; offset: number };
type IndexedText = { text: string; starts: TextAddress[]; ends: TextAddress[] };

/** Obsidian/Markdown rendering may smarten punctuation without changing the speech. */
function comparableChar(char: string): string {
  if (char === "\u2018" || char === "\u2019") return "'";
  if (char === "\u201c" || char === "\u201d") return '"';
  if (char === "\u00a0" || char === "\u202f") return " ";
  return char;
}

function normalizedBlockText(block: Element): IndexedText {
  const starts: TextAddress[] = [];
  const ends: TextAddress[] = [];
  let text = "";
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    if (
      node.parentElement?.closest(
        "script, style, code, pre, .internal-embed, .markdown-embed, .footnote-ref, .heading-collapse-indicator, .collapse-indicator, .aloud-reading-highlight, [aria-hidden='true']",
      )
    )
      continue;
    for (let i = 0; i < node.data.length; i++) {
      const char = comparableChar(node.data[i]);
      if (/\s/.test(char)) {
        if (text.endsWith(" ")) {
          ends[ends.length - 1] = { node, offset: i + 1 };
          continue;
        }
        text += " ";
      } else {
        text += char;
      }
      starts.push({ node, offset: i });
      ends.push({ node, offset: i + 1 });
    }
  }
  return { text, starts, ends };
}

function normalizeSpoken(value: string): string {
  return Array.from(value, comparableChar).join("").replace(/\s+/g, " ").trim();
}

/** Index all visible prose, not just one paragraph: audio chunks may span headings
 * and adjacent paragraphs. Synthetic spaces represent block boundaries, but
 * range endpoints always refer to real DOM text nodes. No DOM is modified. */
function indexedPreviewText(preview: HTMLElement): IndexedText {
  const textParts: string[] = [];
  const starts: TextAddress[] = [];
  const ends: TextAddress[] = [];
  const selector = "p, h1, h2, h3, h4, h5, h6, li, td, th, blockquote";
  const blocks = Array.from(preview.querySelectorAll(selector)).filter(
    (block) =>
      !block.querySelector(selector) &&
      !block.closest(".internal-embed, .markdown-embed, [aria-hidden='true']"),
  );
  let lastWasSpace = false;
  for (const block of blocks) {
    const indexed = normalizedBlockText(block);
    if (!indexed.text.trim()) continue;
    if (ends.length && !lastWasSpace && indexed.text[0] !== " ") {
      textParts.push(" ");
      starts.push(ends[ends.length - 1]);
      ends.push(indexed.starts[0]);
      lastWasSpace = true;
    }
    for (let i = 0; i < indexed.text.length; i++) {
      const char = indexed.text[i];
      if (char === " " && lastWasSpace) {
        // Collapse whitespace across inline nodes and rendered block boundaries.
        ends[ends.length - 1] = indexed.ends[i];
        continue;
      }
      textParts.push(char);
      starts.push(indexed.starts[i]);
      ends.push(indexed.ends[i]);
      lastWasSpace = char === " ";
    }
  }
  return { text: textParts.join(""), starts, ends };
}

/** Multiple occurrences are deliberately ambiguous, even if one is nearby. */
function uniqueRenderedRange(
  indexed: IndexedText,
  target: string,
): Range | null {
  if (!target) return null;
  const { text, starts, ends } = indexed;
  let found = -1;
  let at = text.indexOf(target);
  while (at >= 0) {
    const left = at === 0 || !/\w/.test(text[at - 1]);
    const after = at + target.length;
    const right = after === text.length || !/\w/.test(text[after]);
    if (left && right) {
      if (found >= 0) return null;
      found = at;
    }
    at = text.indexOf(target, at + 1);
  }
  if (found < 0) return null;
  const range = document.createRange();
  range.setStart(starts[found].node, starts[found].offset);
  const end = ends[found + target.length - 1];
  range.setEnd(end.node, end.offset);
  return range;
}

/** Do not override an ambiguous exact match with a shorter anchor. */
function countRenderedMatches(text: string, target: string): number {
  let count = 0;
  let index = text.indexOf(target);
  while (index >= 0) {
    const left = index === 0 || !/\w/.test(text[index - 1]);
    const end = index + target.length;
    const right = end === text.length || !/\w/.test(text[end]);
    if (left && right) count++;
    if (count > 1) return count;
    index = text.indexOf(target, index + 1);
  }
  return count;
}

/**
 * A sentence group is displayed only when there is exactly one unambiguous
 * rendered match in the active note. No guessed raw Markdown offsets.
 * Multiple inline nodes (strong, emphasis, links) can form one Range.
 */
export function findReadingHighlightRange(
  preview: HTMLElement,
  spokenText: string,
): Range | null {
  const target = normalizeSpoken(spokenText);
  if (target.length < 5 || target.length > 8000) return null;
  const indexed = indexedPreviewText(preview);
  const count = countRenderedMatches(indexed.text, target);
  if (count > 1) return null;
  if (count === 1) return uniqueRenderedRange(indexed, target);

  // Rendered Markdown can differ from cleanMarkup's spoken text (link URLs,
  // punctuation, footnotes, or chunks crossing blocks). Locate only a LONG,
  // uniquely occurring opening phrase; never guess from a few common words.
  // The shorter painted range is intentional: it is verifiably present.
  const words = target.split(" ").filter(Boolean);
  if (words.length < 10 || target.length < 70) return null;
  const prefix: string[] = [];
  for (const word of words) {
    prefix.push(word);
    if (prefix.length >= 12 && prefix.join(" ").length >= 70) break;
    if (prefix.length >= 20) break;
  }
  const anchor = prefix.join(" ");
  if (anchor.length < 65) return null;
  return uniqueRenderedRange(indexed, anchor);
}

/** Center the uniquely matched spoken range; never mutate rendered Markdown. */
export function scrollToSpokenRange(
  preview: HTMLElement,
  spokenText: string,
): boolean {
  const range = findReadingHighlightRange(preview, spokenText);
  if (!range) return false;
  const rect = range.getClientRects?.()[0];
  if (
    rect &&
    preview.clientHeight > 0 &&
    typeof preview.scrollBy === "function"
  ) {
    const viewport = preview.getBoundingClientRect();
    preview.scrollBy({
      top: rect.top - viewport.top - preview.clientHeight / 2 + rect.height / 2,
      behavior: "smooth",
    });
    return true;
  }
  const anchor = range.startContainer.parentElement;
  if (!anchor || typeof anchor.scrollIntoView !== "function") return false;
  anchor.scrollIntoView({ block: "center", behavior: "smooth" });
  return true;
}

type HighlightRegistry = {
  set(name: string, value: unknown): void;
  delete(name: string): void;
};
type HighlightConstructor = new (...ranges: Range[]) => unknown;

/**
 * Highlight API provides a paint-only layer: links, Markdown selections and
 * event listeners are not replaced or wrapped.
 */
export class ReadingViewHighlight {
  private readonly name = "aloud-reading-current";
  private observer?: MutationObserver;
  private disposeReaction: () => void;
  private root: HTMLElement | null = null;
  private frame: number | null = null;

  constructor(
    private readonly app: App,
    private readonly player: AudioStore,
  ) {
    this.disposeReaction = mobx.reaction(
      () => {
        const active = this.player.activeText;
        return [
          active?.audio.sourcePath,
          active?.currentChunk?.text,
          active?.position,
        ];
      },
      () => this.schedule(),
      { fireImmediately: true },
    );
    this.app.workspace.on("active-leaf-change", this.onLayout);
    this.app.workspace.on("layout-change", this.onLayout);
    this.app.workspace.on("file-open", this.onLayout);
    this.schedule();
  }

  private readonly onLayout = (): void => this.schedule();

  private registry(): HighlightRegistry | undefined {
    if (typeof CSS === "undefined") return undefined;
    return (CSS as unknown as { highlights?: HighlightRegistry }).highlights;
  }

  private clear(): void {
    this.registry()?.delete(this.name);
  }

  private schedule(): void {
    if (this.frame !== null) return;
    this.frame = window.requestAnimationFrame(() => {
      this.frame = null;
      this.paint();
    });
  }

  private paint(): void {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    const container = view?.containerEl as HTMLElement | undefined;
    if (this.root !== container) {
      this.observer?.disconnect();
      this.root = container ?? null;
      if (this.root && typeof MutationObserver !== "undefined") {
        this.observer = new MutationObserver(() => this.schedule());
        this.observer.observe(this.root, {
          childList: true,
          subtree: true,
          characterData: true,
        });
      }
    }
    this.clear();
    if (!view || view.getMode() !== "preview" || !view.file) return;
    const active = this.player.activeText;
    if (
      !active ||
      active.audio.sourcePath !== view.file.path ||
      !active.currentChunk
    )
      return;
    const preview = container?.querySelector(".markdown-preview-view");
    if (!(preview instanceof HTMLElement)) return;
    const range = findReadingHighlightRange(preview, active.currentChunk.text);
    if (!range) return;

    const registry = this.registry();
    const HighlightCtor = (
      window as Window & {
        Highlight?: HighlightConstructor;
      }
    ).Highlight;
    if (registry && HighlightCtor)
      registry.set(this.name, new HighlightCtor(range));
  }

  destroy(): void {
    this.disposeReaction();
    this.app.workspace.off("active-leaf-change", this.onLayout);
    this.app.workspace.off("layout-change", this.onLayout);
    this.app.workspace.off("file-open", this.onLayout);
    if (this.frame !== null) window.cancelAnimationFrame(this.frame);
    this.observer?.disconnect();
    this.clear();
  }
}

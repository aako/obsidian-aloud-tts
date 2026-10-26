import * as mobx from "mobx";
import { App, MarkdownView } from "obsidian";
import type { AudioStore } from "open-tts";

/** Lightweight source-independent text match: never rewrite Obsidian's rendered DOM. */
type TextAddress = { node: Text; offset: number };
type IndexedText = { text: string; starts: TextAddress[]; ends: TextAddress[] };

function normalizedBlockText(block: Element): IndexedText {
  const starts: TextAddress[] = [];
  const ends: TextAddress[] = [];
  let text = "";
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    if (
      node.parentElement?.closest(
        "script, style, code, pre, .internal-embed, .markdown-embed, .footnote-ref, .aloud-reading-highlight",
      )
    )
      continue;
    for (let i = 0; i < node.data.length; i++) {
      const char = node.data[i];
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
  return value.replace(/\s+/g, " ").trim();
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

  const blocks = Array.from(
    preview.querySelectorAll("p, h1, h2, h3, h4, h5, h6, li, td, th"),
  ).filter(
    (block) => !block.querySelector("p, h1, h2, h3, h4, h5, h6, li, td, th"),
  );
  const matches: Range[] = [];
  for (const block of blocks) {
    const { text, starts, ends } = normalizedBlockText(block);
    let offset = text.indexOf(target);
    while (offset >= 0) {
      // A substring inside another word should never be highlighted.
      const left = offset === 0 || !/\w/.test(text[offset - 1]);
      const after = offset + target.length;
      const right = after === text.length || !/\w/.test(text[after]);
      if (left && right) {
        const range = document.createRange();
        range.setStart(starts[offset].node, starts[offset].offset);
        range.setEnd(ends[after - 1].node, ends[after - 1].offset);
        matches.push(range);
        if (matches.length > 1) return null;
      }
      offset = text.indexOf(target, offset + 1);
    }
  }
  return matches.length === 1 ? matches[0] : null;
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

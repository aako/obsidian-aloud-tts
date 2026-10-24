import { describe, expect, it } from "vitest";
import { backgroundPreloadContext, isCurrentPreload } from "./ChunkLoader";

const speechify = {
  modelProvider: "speechify" as const,
  model: "simba-3.2",
  voice: "geffen_32",
};
const otherVoice = { ...speechify, voice: "dominic_32" };
const otherProvider = { ...speechify, modelProvider: "openai" as const };

const queued = {
  text: "The first sentence.",
  options: speechify,
  position: 1,
  sourceAudioId: "reading-A",
};

describe("obsolete background preload safety", () => {
  it("accepts the same voice, provider, document chunk and position", () => {
    expect(
      isCurrentPreload(queued, {
        text: queued.text,
        position: 0,
        audioId: "reading-A",
        options: { ...speechify },
      }),
    ).toBe(true);
  });

  it("discards a queued voice switch before another paid request", () => {
    expect(
      isCurrentPreload(queued, {
        text: queued.text,
        position: 0,
        audioId: "reading-A",
        options: otherVoice,
      }),
    ).toBe(false);
  });

  it("discards a provider switch even when the model and voice are identical", () => {
    expect(
      isCurrentPreload(queued, {
        text: queued.text,
        position: 0,
        audioId: "reading-A",
        options: otherProvider,
      }),
    ).toBe(false);
  });

  it("rejects identical text in a different reading session", () => {
    expect(
      isCurrentPreload(queued, {
        text: queued.text,
        position: 0,
        audioId: "reading-B",
        options: speechify,
      }),
    ).toBe(false);
  });

  it("discards old-document work and requests behind the reading position", () => {
    expect(
      isCurrentPreload(queued, {
        text: "Different article sentence.",
        position: 0,
        audioId: "reading-A",
        options: speechify,
      }),
    ).toBe(false);
    expect(
      isCurrentPreload(queued, {
        text: queued.text,
        position: 2,
        audioId: "reading-A",
        options: speechify,
      }),
    ).toBe(false);
  });

  it("does not preload after playback finishes or the player closes", () => {
    expect(
      isCurrentPreload(queued, {
        text: queued.text,
        position: -1,
        audioId: "reading-A",
        options: speechify,
      }),
    ).toBe(false);
    expect(
      isCurrentPreload(queued, {
        position: undefined,
        audioId: "reading-A",
        options: speechify,
      }),
    ).toBe(false);
  });

  it("retains request budget, abort signal, callback and text context", () => {
    const controller = new AbortController();
    const onWait = () => undefined;
    const context = {
      textBefore: "Earlier.",
      textAfter: "Later.",
      request: {
        budgetLimit: 0,
        priority: "foreground" as const,
        signal: controller.signal,
        onWait,
      },
    };

    const result = backgroundPreloadContext(context);
    expect(result).toEqual({
      ...context,
      request: {
        ...context.request,
        priority: "background",
      },
    });
    expect(result.request?.budgetLimit).toBe(0);
    expect(result.request?.signal).toBe(controller.signal);
    expect(result.request?.onWait).toBe(onWait);
    // Never mutate metadata on the caller's original context.
    expect(context.request.priority).toBe("foreground");
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  configureSpeechifyTransport,
  listSpeechifyVoices,
  type SpeechifyHttpRequest,
  type SpeechifyHttpResponse,
} from "./speechify";

function catalogResponse(
  voices: unknown[],
  nextCursor: string | null,
  hasMore: boolean,
): SpeechifyHttpResponse {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => ({ voices, next_cursor: nextCursor, has_more: hasMore }),
    arrayBuffer: async () => new ArrayBuffer(0),
  };
}

afterEach(() => configureSpeechifyTransport());

describe("Speechify English voice discovery", () => {
  it("follows next_cursor even when an intermediate page is empty", async () => {
    const requests: SpeechifyHttpRequest[] = [];
    configureSpeechifyTransport(async (request) => {
      requests.push(request);
      if (requests.length === 1)
        return catalogResponse([], "after-empty", true);
      return catalogResponse(
        [
          {
            id: "geffen_32",
            display_name: "Geffen",
            locale: "en-US",
            gender: "male",
          },
          {
            id: "dominic_32",
            display_name: "Dominic",
            locale: "en-GB",
            gender: "male",
          },
          {
            id: "en_unmarked",
            display_name: "English",
            locale: "en",
            gender: "not_specified",
          },
          {
            id: "fr_voice",
            display_name: "French",
            locale: "fr-FR",
            gender: "female",
          },
        ],
        null,
        false,
      );
    });
    expect(await listSpeechifyVoices("test-key", "simba-3.2")).toEqual([
      { id: "geffen_32", name: "Geffen", locale: "en-US", gender: "male" },
      { id: "dominic_32", name: "Dominic", locale: "en-GB", gender: "male" },
      {
        id: "en_unmarked",
        name: "English",
        locale: "en",
        gender: "not_specified",
      },
    ]);
    expect(requests).toHaveLength(2);
    expect(new URL(requests[0].url).searchParams.get("locale")).toBe("en");
    expect(new URL(requests[0].url).searchParams.get("model")).toBe(
      "simba-3.2",
    );
    expect(new URL(requests[0].url).searchParams.get("limit")).toBe("200");
    expect(new URL(requests[1].url).searchParams.get("cursor")).toBe(
      "after-empty",
    );
    expect(requests.every((request) => request.method === "GET")).toBe(true);
  });

  it("deduplicates voices and refuses a repeated cursor", async () => {
    let count = 0;
    configureSpeechifyTransport(async () => {
      count += 1;
      return catalogResponse(
        [
          {
            id: "geffen_32",
            display_name: "Geffen",
            locale: "en-US",
            gender: "male",
          },
        ],
        "loop",
        true,
      );
    });
    await expect(listSpeechifyVoices("test-key", "simba-3.2")).rejects.toThrow(
      "pagination",
    );
    expect(count).toBe(2);
  });

  it("rejects invalid catalogs and never calls synthesis", async () => {
    const transport = vi.fn(async (_request: SpeechifyHttpRequest) => ({
      ...catalogResponse([], null, false),
      json: async () => ({ items: [] }),
    }));
    configureSpeechifyTransport(transport);
    await expect(listSpeechifyVoices("test-key", "simba-3.2")).rejects.toThrow(
      "invalid voice catalog",
    );
    expect(transport).toHaveBeenCalledOnce();
    expect(transport.mock.calls[0][0].method).toBe("GET");
  });
});

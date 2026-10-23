import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AzureRequestGate,
  validAzureLedger,
  azureCharacters,
} from "./AzureRequestGate";

describe("Azure request gate", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-22T12:00:00Z"));
  });
  afterEach(() => vi.useRealTimers());

  function makeGate() {
    const gate = new AzureRequestGate();
    const snapshots: string[] = [];
    gate.initialize(
      { month: "2026-10", characters: 0, starts: [], blockedUntil: 0 },
      async (ledger) => {
        snapshots.push(JSON.stringify(ledger));
      },
    );
    return { gate, snapshots };
  }

  it("refuses billable calls until durable persistence is configured", async () => {
    const work = vi.fn().mockResolvedValue("audio");
    await expect(
      new AzureRequestGate().request(work, { characters: 5, budget: 10 }),
    ).rejects.toThrow("unavailable");
    expect(work).not.toHaveBeenCalled();
  });

  it("reserves characters before invoking the provider, even for failed requests", async () => {
    const { gate, snapshots } = makeGate();
    const work = vi.fn().mockRejectedValue(new Error("HTTP 429"));
    await expect(
      gate.request(work, { characters: 9, budget: 10 }),
    ).rejects.toThrow("429");
    expect(snapshots).toHaveLength(1);
    expect(JSON.parse(snapshots[0]).characters).toBe(9);
    expect(work).toHaveBeenCalledOnce();
    await expect(
      gate.request(work, { characters: 2, budget: 10 }),
    ).rejects.toThrow("budget reached");
    expect(work).toHaveBeenCalledOnce();
  });

  it("restores its usage after restart", async () => {
    const { gate, snapshots } = makeGate();
    await gate.request(async () => "ok", { characters: 8, budget: 10 });
    const restarted = new AzureRequestGate();
    restarted.initialize(JSON.parse(snapshots[0]), async () => undefined);
    const work = vi.fn().mockResolvedValue("ok");
    await expect(
      restarted.request(work, { characters: 3, budget: 10 }),
    ).rejects.toThrow("budget reached");
    expect(work).not.toHaveBeenCalled();
  });

  it("blocks network calls when saving the ledger fails", async () => {
    const gate = new AzureRequestGate();
    gate.initialize(
      { month: "2026-10", characters: 0, starts: [], blockedUntil: 0 },
      async () => {
        throw new Error("vault unavailable");
      },
    );
    const work = vi.fn().mockResolvedValue("ok");
    await expect(
      gate.request(work, { characters: 1, budget: 10 }),
    ).rejects.toThrow("vault unavailable");
    expect(work).not.toHaveBeenCalled();
  });

  it("disables Azure requests after a failed ledger write, including queued work", async () => {
    const gate = new AzureRequestGate();
    gate.initialize(
      { month: "2026-10", characters: 0, starts: [], blockedUntil: 0 },
      async () => {
        await Promise.resolve();
        throw new Error("second vault snapshot failed");
      },
    );
    const work = vi.fn().mockResolvedValue("audio");
    const first = gate.request(work, { characters: 4, budget: 10 });
    const second = gate.request(work, { characters: 4, budget: 10 });
    const firstCheck = expect(first).rejects.toThrow(
      "second vault snapshot failed",
    );
    const secondCheck = expect(second).rejects.toThrow("ledger failed");
    await Promise.all([firstCheck, secondCheck]);
    await expect(
      gate.request(work, { characters: 1, budget: 10 }),
    ).rejects.toThrow("unavailable");
    expect(work).not.toHaveBeenCalled();
  });

  it("enforces 12 starts in 60 seconds", async () => {
    const { gate } = makeGate();
    const work = vi.fn().mockResolvedValue("ok");
    for (let i = 0; i < 12; i++)
      await gate.request(work, { characters: 1, budget: 50 });
    const next = gate.request(work, { characters: 1, budget: 50 });
    await Promise.resolve();
    expect(work).toHaveBeenCalledTimes(12);
    await vi.advanceTimersByTimeAsync(60_001);
    await next;
    expect(work).toHaveBeenCalledTimes(13);
  });

  it("rejects a queued, aborted request without charging characters", async () => {
    const { gate } = makeGate();
    for (let i = 0; i < 12; i++)
      await gate.request(async () => true, { characters: 1, budget: 50 });
    const controller = new AbortController();
    const work = vi.fn().mockResolvedValue("ok");
    const next = gate.request(work, {
      characters: 9,
      budget: 50,
      signal: controller.signal,
    });
    controller.abort();
    await expect(next).rejects.toMatchObject({ name: "AbortError" });
    expect(work).not.toHaveBeenCalled();
    expect(gate.used).toBe(12);
  });

  it("validates saved metadata and counts Han characters conservatively", () => {
    expect(azureCharacters("a 中!")).toBe(5);
    expect(
      validAzureLedger({
        month: "2026-10",
        characters: 12,
        starts: [1234],
        blockedUntil: 0,
      }),
    ).toBe(true);
    expect(
      validAzureLedger({
        month: "2026-10",
        characters: -1,
        starts: [],
        blockedUntil: 0,
      }),
    ).toBe(false);
  });
});

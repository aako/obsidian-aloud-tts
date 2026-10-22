/** A conservative, single-process Azure F0 request gate. This is NOT an Azure billing record. */
export interface AzureLedger {
  month: string;
  characters: number;
  starts: number[];
  blockedUntil: number;
}

export interface AzureRequestOptions {
  characters: number;
  budget: number;
  priority?: "foreground" | "background";
  signal?: AbortSignal;
  onWait?: () => void;
}

interface WaitingRequest<T> {
  options: AzureRequestOptions;
  work: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
  onAbort: () => void;
  settled: boolean;
}

function currentMonth(): string {
  return new Date().toISOString().slice(0, 7);
}

/** Estimate only: excludes Azure-specific SSML billing adjustments and other devices. */
export function azureCharacters(text: string): number {
  return Array.from(text).reduce(
    (total, char) => total + (/\p{Script=Han}/u.test(char) ? 2 : 1),
    0,
  );
}

export function validAzureLedger(value: unknown): value is AzureLedger {
  if (!value || typeof value !== "object") return false;
  const ledger = value as Partial<AzureLedger>;
  return (
    typeof ledger.month === "string" &&
    /^\d{4}-\d{2}$/.test(ledger.month) &&
    Number.isSafeInteger(ledger.characters) &&
    (ledger.characters ?? -1) >= 0 &&
    Array.isArray(ledger.starts) &&
    ledger.starts.every((x) => Number.isSafeInteger(x) && x >= 0) &&
    Number.isSafeInteger(ledger.blockedUntil) &&
    (ledger.blockedUntil ?? -1) >= 0
  );
}

export class AzureRequestGate {
  constructor(private readonly serviceName = "Azure") {}
  ledger: AzureLedger = {
    month: currentMonth(),
    characters: 0,
    starts: [],
    blockedUntil: 0,
  };
  persist: (ledger: AzureLedger) => Promise<void> = async () => {
    throw new Error(
      "Azure usage ledger has not been initialized. Synthesis is blocked to protect your budget.",
    );
  };
  private initialized = false;
  private readonly queue: WaitingRequest<unknown>[] = [];
  private active = false;
  private timer?: ReturnType<typeof setTimeout>;

  initialize(
    ledger: AzureLedger,
    persist: (value: AzureLedger) => Promise<void>,
  ): void {
    if (!validAzureLedger(ledger))
      throw new Error("Invalid Azure usage ledger");
    if (this.active || this.queue.length)
      throw new Error("Cannot replace the Azure ledger during requests");
    this.ledger = { ...ledger, starts: [...ledger.starts] };
    this.persist = persist;
    this.initialized = true;
  }

  get used(): number {
    return this.ledger.month === currentMonth() ? this.ledger.characters : 0;
  }

  defer(milliseconds: number): void {
    if (Number.isFinite(milliseconds) && milliseconds > 0) {
      this.ledger.blockedUntil = Math.max(
        this.ledger.blockedUntil,
        Date.now() + Math.ceil(milliseconds),
      );
    }
  }

  request<T>(work: () => Promise<T>, options: AzureRequestOptions): Promise<T> {
    if (!this.initialized) {
      return Promise.reject(
        new Error(
          `${this.serviceName} usage ledger is unavailable; refusing a potentially billable request.`,
        ),
      );
    }
    if (
      !Number.isSafeInteger(options.characters) ||
      options.characters < 0 ||
      !Number.isSafeInteger(options.budget) ||
      options.budget < 0
    ) {
      return Promise.reject(new Error("Invalid Azure request budget"));
    }
    return new Promise<T>((resolve, reject) => {
      const item: WaitingRequest<T> = {
        work,
        options,
        resolve,
        reject,
        settled: false,
        onAbort: () => undefined,
      };
      item.onAbort = () => {
        const index = this.queue.indexOf(
          item as unknown as WaitingRequest<unknown>,
        );
        if (index >= 0) {
          this.queue.splice(index, 1);
          item.settled = true;
          options.signal?.removeEventListener("abort", item.onAbort);
          reject(new DOMException("Cancelled", "AbortError"));
          this.pump();
        }
      };
      if (options.signal?.aborted) {
        reject(new DOMException("Cancelled", "AbortError"));
        return;
      }
      options.signal?.addEventListener("abort", item.onAbort, { once: true });
      this.queue.push(item as unknown as WaitingRequest<unknown>);
      this.pump();
    });
  }

  private finish(item: WaitingRequest<unknown>, error?: unknown): void {
    if (item.settled) return;
    item.settled = true;
    item.options.signal?.removeEventListener("abort", item.onAbort);
    item.reject(error);
  }

  private pump(): void {
    if (this.active) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.queue.length === 0) return;

    const now = Date.now();
    const recent = this.ledger.starts.filter(
      (x) => x > now - 60_000 && x <= now,
    );
    const until = Math.max(
      this.ledger.blockedUntil,
      recent.length >= 12 ? recent[0] + 60_001 : 0,
    );
    if (until > now) {
      for (const item of this.queue) item.options.onWait?.();
      this.timer = setTimeout(
        () => this.pump(),
        Math.min(Math.max(1, until - now), 60_000),
      );
      return;
    }

    const foreground = this.queue.findIndex(
      (x) => x.options.priority !== "background",
    );
    const [item] = this.queue.splice(foreground >= 0 ? foreground : 0, 1);
    const month = currentMonth();
    const used = month === this.ledger.month ? this.ledger.characters : 0;
    if (used + item.options.characters > item.options.budget) {
      this.finish(
        item,
        new Error(
          "Local Azure character budget reached; no synthesis request was sent.",
        ),
      );
      this.pump();
      return;
    }

    // Reserve the budget and durable rolling request slot BEFORE touching Azure.
    // A crash after reservation may overcount, deliberately favoring user safety.
    const next: AzureLedger = {
      month,
      characters: used + item.options.characters,
      starts: [...recent, now],
      blockedUntil: this.ledger.blockedUntil,
    };
    this.active = true;
    void this.persist({ ...next, starts: [...next.starts] })
      .then(
        () => {
          this.ledger = next;
          if (item.options.signal?.aborted)
            throw new DOMException("Cancelled", "AbortError");
          return item.work();
        },
        (error: unknown) => {
          this.initialized = false;
          const stopped = new Error(
            `${this.serviceName} usage ledger failed; synthesis disabled until plugin restart.`,
          );
          for (const queued of this.queue.splice(0))
            this.finish(queued, stopped);
          throw error;
        },
      )
      .then((value) => {
        if (!item.settled) {
          item.settled = true;
          item.options.signal?.removeEventListener("abort", item.onAbort);
          item.resolve(value);
        }
      })
      .catch((error: unknown) => this.finish(item, error))
      .finally(() => {
        this.active = false;
        this.pump();
      });
  }
}

export const azureRequestGate = new AzureRequestGate();

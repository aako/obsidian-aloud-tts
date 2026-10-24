import * as React from "react";
import { createRoot, Root } from "react-dom/client";
import { observer } from "mobx-react-lite";
import { App, Modal } from "obsidian";
import {
  TTSPluginSettingsStore,
  azureRequestGate,
  googleChirpRequestGate,
  speechifyRequestGate,
} from "open-tts";
import { ArticleCache, ArticleJob, CacheEstimate } from "../ArticleCache";
import { cacheFolder } from "../PersistentVaultCache";

export class ArticleCacheModal extends Modal {
  private root?: Root;
  constructor(
    app: App,
    private manager: ArticleCache,
    private settings: TTSPluginSettingsStore,
    private selected?: ArticleJob,
    private onListen?: (job: ArticleJob) => Promise<void>,
    private version?: string,
  ) {
    super(app);
  }
  onOpen(): void {
    this.titleEl.setText("Article Audio Cache");
    this.root = createRoot(this.contentEl);
    this.root.render(
      <ArticleCacheView
        manager={this.manager}
        settings={this.settings}
        initial={this.selected}
        onListen={this.onListen}
        version={this.version}
      />,
    );
  }
  onClose(): void {
    this.root?.unmount();
  }
}

export const ArticleCacheView = observer(
  ({
    manager,
    settings,
    initial,
    onListen,
    version,
  }: {
    manager: ArticleCache;
    settings: TTSPluginSettingsStore;
    initial?: ArticleJob;
    onListen?: (job: ArticleJob) => Promise<void>;
    version?: string;
  }): React.ReactElement => {
    // Manage has no implicit job. A prior unrelated article must never be
    // selected silently, especially when destructive actions are available.
    const [id, setId] = React.useState(initial?.id ?? "");
    const job = manager.jobs.find((item) => item.id === id);
    const [estimate, setEstimate] = React.useState<CacheEstimate>();
    const [consent, setConsent] = React.useState(false);
    const [confirmDelete, setConfirmDelete] = React.useState(false);
    const [error, setError] = React.useState("");
    const [exportMessage, setExportMessage] = React.useState("");
    const [bytes, setBytes] = React.useState(0);
    const [folder, setFolder] = React.useState(
      settings.settings.persistentCacheFolder,
    );
    const google = settings.settings.modelProvider === "google_chirp";
    const speechify = settings.settings.modelProvider === "speechify";
    const serviceName = speechify
      ? "Speechify"
      : google
        ? "Google Chirp"
        : "Azure";
    const serviceGate = speechify
      ? speechifyRequestGate
      : google
        ? googleChirpRequestGate
        : azureRequestGate;
    const [budget, setBudget] = React.useState(
      speechify
        ? settings.settings.speechifyMonthlyBudget
        : google
          ? settings.settings.googleChirpMonthlyBudget
          : settings.settings.azureMonthlyBudget,
    );
    const [limit, setLimit] = React.useState(
      settings.settings.persistentCacheMaxMB,
    );
    const [checking, setChecking] = React.useState(false);
    const refreshGeneration = React.useRef(0);
    const isRendering = job?.state === "running" || job?.state === "waiting";
    const fullyVerified =
      !!job &&
      job.chunks.length > 0 &&
      estimate?.persistentCached === job.chunks.length;
    const run = (operation: () => Promise<unknown>): void => {
      setError("");
      void operation().catch((reason: unknown) =>
        setError(
          reason instanceof Error ? reason.message : "Operation failed.",
        ),
      );
    };
    const refresh = async (): Promise<void> => {
      const generation = ++refreshGeneration.current;
      setChecking(true);
      setEstimate(undefined);
      setConsent(false);
      try {
        // An earlier article's async verification must not populate a newer
        // selection after a slow iCloud read finishes.
        const nextEstimate = job ? await manager.estimate(job) : undefined;
        const nextBytes = await manager.vault.getStorageSize();
        if (generation !== refreshGeneration.current) return;
        setEstimate(nextEstimate);
        setBytes(nextBytes);
      } finally {
        if (generation === refreshGeneration.current) setChecking(false);
      }
    };
    React.useEffect(() => {
      setConfirmDelete(false);
      run(refresh);
      return () => {
        refreshGeneration.current += 1;
      };
    }, [id]);
    return (
      <div className="tts-cache-panel">
        {version && (
          <p className="setting-item-description" aria-label="Aloud version">
            Aloud v{version}
          </p>
        )}
        <p>
          Listening caches audio locally first; the separate vault save can
          finish later or fail. Only verified persistent vault audio is
          iCloud-syncable. Render All creates and verifies missing vault copies.
          Let iCloud download the folder before offline playback.
        </p>
        <label>
          Article{" "}
          <select value={id} onChange={(event) => setId(event.target.value)}>
            <option value="">Select An Article</option>
            {manager.jobs.map((item) => (
              <option key={item.id} value={item.id}>
                {item.path} ({item.state})
              </option>
            ))}
          </select>
        </label>
        {!job && (
          <p role="status">
            Select an article to inspect its cached audio. Nothing is selected
            for rendering or deletion.
          </p>
        )}
        {job && (
          <>
            <p role="status">
              {isRendering
                ? `Rendering: ${
                    job.chunks.filter((chunk) => chunk.state === "cached")
                      .length
                  }/${job.chunks.length} job chunks. ${job.message}`
                : `Render job: ${job.state}. ${job.message}`}
            </p>
            <button disabled={checking} onClick={() => run(refresh)}>
              Verify local + vault cache (no synthesis)
            </button>
            {estimate && (
              <>
                <p role="status">
                  Verified persistent vault: {estimate.persistentCached}/
                  {job.chunks.length} chunks. Available on this device:{" "}
                  {estimate.cached}/{job.chunks.length}. Local-only:{" "}
                  {estimate.localOnlyCached}; vault unavailable or pending
                  iCloud: {estimate.persistentUnavailable}.
                </p>
                {fullyVerified && (
                  <p>All article chunks are verified. No rendering needed.</p>
                )}
                <p>
                  {estimate.characters.toLocaleString()} characters ·{" "}
                  {estimate.missing} missing · approximately {estimate.requests}{" "}
                  new {serviceName} requests before retries ·{" "}
                  {estimate.additionalCharacters.toLocaleString()} additional
                  characters · about{" "}
                  {(estimate.approximateBytes / 1048576).toFixed(1)} MB. Audio
                  size is a rough 96 kbps speech estimate.
                </p>
              </>
            )}
            <p>
              Locally tracked this UTC month:{" "}
              {serviceGate.used.toLocaleString()} {serviceName} characters.
              Estimated remaining local allowance:{" "}
              {Math.max(0, budget - serviceGate.used).toLocaleString()}. This is
              not provider billing; requests on other devices/apps and prior
              usage are unknown. Attempts and retries are counted
              conservatively. Generate on one device at a time.
            </p>
            {estimate?.exceedsBudget && (
              <label>
                <input
                  type="checkbox"
                  checked={consent}
                  onChange={(event) => setConsent(event.target.checked)}
                />
                I approve this job exceeding my local budget by up to{" "}
                {Math.max(
                  0,
                  estimate.additionalCharacters - estimate.remaining,
                ).toLocaleString()}{" "}
                characters. This does not change my provider account or plan.
              </label>
            )}
            <div className="tts-cache-actions">
              {onListen && (
                <button type="button" onClick={() => run(() => onListen(job))}>
                  Listen Now (play from start)
                </button>
              )}
              {job.state === "complete" && (
                <button
                  type="button"
                  onClick={() =>
                    run(async () => {
                      const path = await manager.exportNativeAudio(
                        job,
                        settings.settings.audioFolder,
                      );
                      setExportMessage(
                        `Exported multipart MP3 ZIP to ${path}. Import it from Files into BookPlayer or another native audiobook app. No synthesis requested.`,
                      );
                    })
                  }
                >
                  Export cached audio ZIP (native player)
                </button>
              )}
              <button
                className="tts-cache-render"
                disabled={
                  !estimate ||
                  checking ||
                  fullyVerified ||
                  (estimate.exceedsBudget && !consent) ||
                  isRendering
                }
                onClick={() => run(() => manager.start(job, consent))}
              >
                {fullyVerified
                  ? "All Audio Verified"
                  : job.state === "failed"
                    ? "Retry Failed Render"
                    : "Render All Missing Audio"}
              </button>
              {isRendering && (
                <>
                  <button onClick={() => run(() => manager.pause(job))}>
                    Pause Render
                  </button>
                  <button onClick={() => run(() => manager.pause(job, true))}>
                    Cancel Render
                  </button>
                </>
              )}
            </div>
            <label>
              <input
                type="checkbox"
                checked={confirmDelete}
                onChange={(event) => setConfirmDelete(event.target.checked)}
              />
              Delete this article's persistent audio, including chunks shared
              with other jobs. Legacy .tts audio and reading checkpoints are
              preserved.
            </label>
            <button
              disabled={!confirmDelete}
              onClick={() =>
                run(async () => {
                  await manager.deleteAudio(job);
                  setConfirmDelete(false);
                  await refresh();
                })
              }
            >
              Delete Selected Audio
            </button>
          </>
        )}
        <p>
          Persistent vault folder usage on this device:{" "}
          {(bytes / 1048576).toFixed(1)} MB (not the local playback cache).
        </p>
        <label>
          Cache Folder{" "}
          <input
            value={folder}
            onChange={(event) => setFolder(event.target.value)}
          />
        </label>
        <p>
          Changing the folder leaves previous files in place. Switch back to
          access them.
        </p>
        <label>
          Persistent Cache Limit (MB){" "}
          <input
            type="number"
            min="1"
            value={limit}
            onChange={(event) => setLimit(Number(event.target.value))}
          />
        </label>
        <label>
          Local Monthly {serviceName} Character Budget{" "}
          <input
            type="number"
            min="0"
            value={budget}
            onChange={(event) => setBudget(Number(event.target.value))}
          />
        </label>
        <button
          onClick={() =>
            run(async () => {
              if (
                manager.jobs.some((item) =>
                  ["running", "waiting"].includes(item.state),
                )
              )
                throw new Error(
                  "Pause and finish the current chunk before changing settings.",
                );
              if (
                !Number.isFinite(limit) ||
                limit < 1 ||
                !Number.isSafeInteger(budget) ||
                budget < 0
              )
                throw new Error(
                  "Enter a positive size limit and a non-negative whole character budget.",
                );
              const next = cacheFolder(folder);
              await settings.updateSettings({
                persistentCacheFolder: next,
                persistentCacheMaxMB: limit,
                azureMonthlyBudget:
                  !google && !speechify
                    ? budget
                    : settings.settings.azureMonthlyBudget,
                googleChirpMonthlyBudget: google
                  ? budget
                  : settings.settings.googleChirpMonthlyBudget,
                speechifyMonthlyBudget: speechify
                  ? budget
                  : settings.settings.speechifyMonthlyBudget,
              });
              await manager.load();
              setId("");
              await refresh();
            })
          }
        >
          Save Cache Settings
        </button>
        {error && <p role="alert">{error}</p>}
        {exportMessage && <p role="status">{exportMessage}</p>}
      </div>
    );
  },
);

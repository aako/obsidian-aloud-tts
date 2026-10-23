import React from "react";
import { observer } from "mobx-react-lite";
import {
  listGoogleChirpVoices,
  type GoogleChirpVoice,
  type TTSPluginSettingsStore,
} from "open-tts";
import { ApiKeyComponent } from "../api-key-component";

export const GoogleChirpSettings = observer(
  ({ store }: { store: TTSPluginSettingsStore }) => (
    <>
      <ApiKeyComponent
        store={store}
        provider="google_chirp"
        fieldName="googleChirpApiKey"
        displayName="Google Cloud Text-to-Speech API key"
        helpText={
          <>
            Your Google Cloud Text-to-Speech API key. This provider uses Chirp 3
            HD voices only. Check billing and usage in Google Cloud Console.
          </>
        }
        showValidation={true}
      />
      <GoogleChirpVoicePicker store={store} />
      <GoogleChirpPacing store={store} />
      <div className="setting-item">
        <div className="setting-item-info">
          <div className="setting-item-name">
            Local Google Chirp monthly character budget
          </div>
          <div className="setting-item-description">
            Defaults to 900,000 characters; this is a per-device local request
            cap, not a Google Cloud billing limit. Never generate the same
            article simultaneously on two devices.
          </div>
        </div>
        <div className="setting-item-control">
          <input
            type="number"
            min="0"
            step="1"
            aria-label="Google Chirp monthly budget"
            value={store.settings.googleChirpMonthlyBudget}
            onChange={(e) => {
              const n = Number(e.target.value);
              if (Number.isSafeInteger(n) && n >= 0)
                void store.updateSettings({ googleChirpMonthlyBudget: n });
            }}
          />
        </div>
      </div>
    </>
  ),
);

const GoogleChirpPacing = observer(
  ({ store }: { store: TTSPluginSettingsStore }) => {
    const value = store.settings.googleChirpSentencePauseMs ?? 0;
    return (
      <div className="setting-item">
        <div className="setting-item-info">
          <div className="setting-item-name">Extra pause between sentences</div>
          <div className="setting-item-description">
            {value === 0
              ? "Off (reuse existing cached audio)."
              : `${value} ms base; question marks and paragraph breaks get a slightly longer pause.`}{" "}
            Uses preview Google SSML at synthesis time. Changes require fresh
            synthesis, consume Google usage allowance, and might be ignored by
            some voices at the end of a chunk. Test a short sample first.
            Frequent previews may also wait behind the 12-requests/minute
            limiter.
          </div>
        </div>
        <div className="setting-item-control">
          <input
            type="range"
            min="0"
            max="1200"
            step="50"
            aria-label="Chirp sentence pause milliseconds"
            value={value}
            onChange={(event) => {
              const next = Number(event.target.value);
              if (Number.isSafeInteger(next) && next >= 0 && next <= 1200)
                void store.updateSettings({ googleChirpSentencePauseMs: next });
            }}
          />
          <span>{value} ms</span>
        </div>
      </div>
    );
  },
);

export const GoogleChirpVoicePicker = observer(
  ({ store }: { store: TTSPluginSettingsStore }) => {
    const apiKey = store.settings.googleChirpApiKey;
    const selectedVoice = store.settings.googleChirpVoice;
    const favorites = store.settings.googleChirpFavoriteVoices ?? [];
    const [voices, setVoices] = React.useState<GoogleChirpVoice[]>([]);
    const [loading, setLoading] = React.useState(false);
    const [error, setError] = React.useState("");
    const [search, setSearch] = React.useState("");
    const [locale, setLocale] = React.useState("");
    const [gender, setGender] = React.useState("");
    const [favoritesOnly, setFavoritesOnly] = React.useState(false);

    React.useEffect(() => {
      let cancelled = false;
      setError("");
      setVoices([]);
      setLocale("");
      setGender("");
      setLoading(!!apiKey);
      if (apiKey)
        void listGoogleChirpVoices(apiKey)
          .then((received) => {
            if (!cancelled) setVoices(received);
          })
          .catch((reason: unknown) => {
            if (!cancelled)
              setError(
                reason instanceof Error
                  ? reason.message
                  : "Failed to list Google voices.",
              );
          })
          .finally(() => {
            if (!cancelled) setLoading(false);
          });
      return () => {
        cancelled = true;
      };
    }, [apiKey]);

    const locales = Array.from(new Set(voices.map((v) => v.locale))).sort();
    const genders = Array.from(new Set(voices.map((v) => v.gender))).sort();
    const filtered = voices
      .filter(
        (v) =>
          (!locale || v.locale === locale) &&
          (!gender || v.gender === gender) &&
          (!favoritesOnly || favorites.includes(v.id)) &&
          [v.id, v.name, v.locale, v.gender].some((t) =>
            t.toLowerCase().includes(search.toLowerCase().trim()),
          ),
      )
      .sort(
        (a, b) =>
          Number(favorites.includes(b.id)) - Number(favorites.includes(a.id)) ||
          a.locale.localeCompare(b.locale) ||
          a.name.localeCompare(b.name),
      );
    const star = (id: string): void => {
      void store.updateModelSpecificSettings("google_chirp", {
        googleChirpFavoriteVoices: favorites.includes(id)
          ? favorites.filter((v) => v !== id)
          : [...favorites, id],
      });
    };
    return (
      <div className="tts-azure-voices setting-item">
        <div className="setting-item-info">
          <div className="setting-item-name">Chirp 3 HD voice</div>
          <div className="setting-item-description">
            Search all available Chirp 3 HD voices, filter by locale/gender,
            star your favorites. Playback uses the exact selected voice.
          </div>
          <div className="tts-azure-voice-current" role="status">
            Current voice: <strong>{selectedVoice}</strong>
          </div>
        </div>
        {!apiKey ? (
          <p>Enter your Google API key to load voices.</p>
        ) : (
          <div className="tts-azure-voice-browser">
            <input
              type="search"
              aria-label="Search Chirp voices"
              placeholder="Search Chirp 3 HD voices…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <div className="tts-azure-voice-filters">
              <select
                aria-label="Filter Chirp locale"
                value={locale}
                onChange={(e) => setLocale(e.target.value)}
              >
                <option value="">All languages</option>
                {locales.map((l) => (
                  <option key={l} value={l}>
                    {l}
                  </option>
                ))}
              </select>
              <select
                aria-label="Filter Chirp gender"
                value={gender}
                onChange={(e) => setGender(e.target.value)}
              >
                <option value="">All genders</option>
                {genders.map((g) => (
                  <option key={g} value={g}>
                    {g}
                  </option>
                ))}
              </select>
              <label>
                <input
                  type="checkbox"
                  checked={favoritesOnly}
                  onChange={(e) => setFavoritesOnly(e.target.checked)}
                />
                Favorites only
              </label>
            </div>
            {loading && <p role="status">Loading Chirp voices…</p>}
            {error && <p role="alert">{error}</p>}
            {!loading && !error && (
              <>
                <div className="setting-item-description" role="status">
                  {filtered.length} matching voices{" "}
                  {filtered.length > 80 ? "(showing first 80)" : ""}
                </div>
                <div
                  className="tts-azure-voice-results"
                  aria-label="Chirp voice results"
                >
                  {filtered.slice(0, 80).map((v) => (
                    <div key={v.id} className="tts-azure-voice-row">
                      <button
                        type="button"
                        className={`tts-azure-voice-select${selectedVoice === v.id ? " is-selected" : ""}`}
                        aria-label={`Select voice ${v.name} (${v.id})`}
                        aria-pressed={selectedVoice === v.id}
                        onClick={() => {
                          void store.updateModelSpecificSettings(
                            "google_chirp",
                            { googleChirpVoice: v.id },
                          );
                        }}
                      >
                        <span>
                          {v.name} · {v.locale} · {v.gender}
                        </span>
                        <small>{v.id}</small>
                      </button>
                      <button
                        type="button"
                        className="tts-azure-voice-star"
                        aria-label={`${favorites.includes(v.id) ? "Remove" : "Add"} ${v.id} ${favorites.includes(v.id) ? "from" : "to"} favorites`}
                        aria-pressed={favorites.includes(v.id)}
                        onClick={() => star(v.id)}
                      >
                        {favorites.includes(v.id) ? "★" : "☆"}
                      </button>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        )}
      </div>
    );
  },
);

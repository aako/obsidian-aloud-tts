import { observer } from "mobx-react-lite";
import React from "react";
import { TTSPluginSettingsStore } from "open-tts";
import { ApiKeyComponent } from "../api-key-component";
import { OptionSelectSetting } from "../setting-components";
import { listAzureVoices, AZURE_REGIONS, AZURE_OUTPUT_FORMATS } from "open-tts";

type AzureVoice = Awaited<ReturnType<typeof listAzureVoices>>[number];

export const AzureSettings = observer(
  ({ store }: { store: TTSPluginSettingsStore }) => {
    return (
      <>
        <ApiKeyComponent
          store={store}
          provider="azure"
          fieldName="azure_apiKey"
          displayName="Azure Speech API key"
          helpText={
            <>
              Your Azure Speech Services API key. You can get one{" "}
              <a
                href="https://portal.azure.com/#create/Microsoft.CognitiveServicesSpeechServices"
                target="_blank"
                rel="noreferrer"
              >
                here
              </a>
              .
            </>
          }
          showValidation={true}
        />
        <AzureRegionComponent store={store} />
        <AzureVoiceComponent store={store} />
        <AzureOutputFormatComponent store={store} />
      </>
    );
  },
);

const AzureRegionComponent: React.FC<{
  store: TTSPluginSettingsStore;
}> = observer(({ store }) => {
  const regionOptions = AZURE_REGIONS.map((region) => ({
    label: region.charAt(0).toUpperCase() + region.slice(1),
    value: region,
  }));

  return (
    <OptionSelectSetting
      name="Region"
      description="The Azure region for your Speech Services resource."
      store={store}
      provider="azure"
      fieldName="azure_region"
      options={regionOptions}
    />
  );
});

export const AzureVoiceComponent: React.FC<{
  store: TTSPluginSettingsStore;
}> = observer(({ store }) => {
  const [voices, setVoices] = React.useState<AzureVoice[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [query, setQuery] = React.useState("");
  const [locale, setLocale] = React.useState("");
  const [gender, setGender] = React.useState("");
  const [favoritesOnly, setFavoritesOnly] = React.useState(false);

  const apiKey = store.settings.azure_apiKey;
  const region = store.settings.azure_region;
  const selectedVoice = store.settings.azure_voice;
  const favoriteIds = Array.isArray(store.settings.azure_favoriteVoices)
    ? store.settings.azure_favoriteVoices
    : [];

  React.useEffect(() => {
    let cancelled = false;
    setVoices([]);
    setError(null);
    setLocale("");
    setGender("");
    setLoading(!!apiKey && !!region);
    if (apiKey && region) {
      void listAzureVoices(apiKey, region)
        .then((available) => {
          if (!cancelled) setVoices(available);
        })
        .catch((reason: unknown) => {
          if (cancelled) return;
          console.warn("Aloud: could not load Azure voice catalog", reason);
          setError(
            "Could not load Azure voices. Check your API key and region.",
          );
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    }
    return () => {
      cancelled = true;
    };
  }, [apiKey, region]);

  const locales = React.useMemo(
    () => Array.from(new Set(voices.map((v) => v.locale))).sort(),
    [voices],
  );
  const genders = React.useMemo(
    () => Array.from(new Set(voices.map((v) => v.gender))).sort(),
    [voices],
  );
  const filteredVoices = React.useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return voices
      .filter((voice) => {
        if (locale && voice.locale !== locale) return false;
        if (gender && voice.gender !== gender) return false;
        if (favoritesOnly && !favoriteIds.includes(voice.id)) return false;
        if (!needle) return true;
        return [voice.id, voice.name, voice.gender, voice.locale].some((part) =>
          part.toLocaleLowerCase().includes(needle),
        );
      })
      .sort((a, b) => {
        const favoriteDifference =
          Number(favoriteIds.includes(b.id)) -
          Number(favoriteIds.includes(a.id));
        return (
          favoriteDifference ||
          a.locale.localeCompare(b.locale) ||
          a.name.localeCompare(b.name)
        );
      });
  }, [voices, locale, gender, favoritesOnly, favoriteIds, query]);

  const toggleFavorite = (id: string): void => {
    const updated = favoriteIds.includes(id)
      ? favoriteIds.filter((voice) => voice !== id)
      : [...favoriteIds, id];
    void store.updateModelSpecificSettings("azure", {
      azure_favoriteVoices: updated,
    });
  };

  if (!apiKey || !region) {
    return (
      <p>Enter your API key and select a region to load available voices.</p>
    );
  }

  return (
    <div
      className="tts-azure-voices setting-item"
      data-testid="aloud-azure-voice-picker"
    >
      <div className="setting-item-info">
        <div className="setting-item-name">Voice</div>
        <div className="setting-item-description">
          Search by name, voice ID, language, or gender. Star voices to keep
          them at the top. Your favorites are saved with the plugin settings.
        </div>
        <div className="tts-azure-voice-current" role="status">
          Current voice: <strong>{selectedVoice || "None"}</strong>
        </div>
      </div>
      <div className="tts-azure-voice-browser">
        <input
          type="search"
          aria-label="Search Azure voices"
          value={query}
          placeholder="Search voices..."
          onChange={(event) => setQuery(event.target.value)}
        />
        <div className="tts-azure-voice-filters">
          <select
            aria-label="Filter voice locale"
            value={locale}
            onChange={(e) => setLocale(e.target.value)}
          >
            <option value="">All languages</option>
            {locales.map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </select>
          <select
            aria-label="Filter voice gender"
            value={gender}
            onChange={(e) => setGender(e.target.value)}
          >
            <option value="">All genders</option>
            {genders.map((v) => (
              <option key={v} value={v}>
                {v}
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
        {loading && <p role="status">Loading Azure voices...</p>}
        {error && <p role="alert">{error}</p>}
        {!loading && !error && (
          <>
            <div className="setting-item-description" role="status">
              {filteredVoices.length} matching voices
              {filteredVoices.length > 80
                ? " (showing first 80; refine your search)"
                : ""}
            </div>
            <div
              className="tts-azure-voice-results"
              aria-label="Azure voice results"
            >
              {filteredVoices.slice(0, 80).map((voice) => {
                const isFavorite = favoriteIds.includes(voice.id);
                return (
                  <div key={voice.id} className="tts-azure-voice-row">
                    <button
                      type="button"
                      className={`tts-azure-voice-select${voice.id === selectedVoice ? " is-selected" : ""}`}
                      aria-label={`Select voice ${voice.name} (${voice.id})`}
                      aria-pressed={voice.id === selectedVoice}
                      onClick={() => {
                        void store.updateModelSpecificSettings("azure", {
                          azure_voice: voice.id,
                        });
                      }}
                    >
                      <span>
                        {voice.name} · {voice.locale} · {voice.gender}
                      </span>
                      <small>{voice.id}</small>
                    </button>
                    <button
                      type="button"
                      className="tts-azure-voice-star"
                      aria-label={`${isFavorite ? "Remove" : "Add"} ${voice.id} ${isFavorite ? "from" : "to"} favorites`}
                      aria-pressed={isFavorite}
                      title={isFavorite ? "Remove favorite" : "Add favorite"}
                      onClick={() => toggleFavorite(voice.id)}
                    >
                      {isFavorite ? "★" : "☆"}
                    </button>
                  </div>
                );
              })}
            </div>
          </>
        )}
      </div>
    </div>
  );
});

const AzureOutputFormatComponent: React.FC<{
  store: TTSPluginSettingsStore;
}> = observer(({ store }) => {
  return (
    <OptionSelectSetting
      name="Output Format"
      description="The audio format for the generated speech."
      store={store}
      provider="azure"
      fieldName="azure_outputFormat"
      options={AZURE_OUTPUT_FORMATS}
    />
  );
});

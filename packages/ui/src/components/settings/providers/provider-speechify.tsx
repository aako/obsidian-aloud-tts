import * as React from "react";
import { observer } from "mobx-react-lite";
import {
  listSpeechifyVoices,
  type SpeechifyModel,
  type SpeechifyVoice,
  type TTSPluginSettingsStore,
} from "open-tts";
import { ApiKeyComponent } from "../api-key-component";
import { OptionSelectSetting, TextInputSetting } from "../setting-components";

const MODELS = [
  { label: "Simba 3.2 (English, fast)", value: "simba-3.2" },
  { label: "Simba 3.5 (multilingual)", value: "simba-3.5" },
  { label: "Simba 3.0 (multilingual)", value: "simba-3.0" },
] as const;

export const SpeechifySettings = observer(
  ({ store }: { store: TTSPluginSettingsStore }) => {
    const apiKey = store.settings.speechifyApiKey;
    const model = store.settings.speechifyModel;
    const [voices, setVoices] = React.useState<SpeechifyVoice[]>([]);
    const [loading, setLoading] = React.useState(false);
    const [error, setError] = React.useState("");
    const [filter, setFilter] = React.useState("");

    React.useEffect(() => {
      let cancelled = false;
      setVoices([]);
      setError("");
      setLoading(!!apiKey);
      if (apiKey) {
        void listSpeechifyVoices(apiKey, model as SpeechifyModel)
          .then((list) => {
            if (!cancelled) setVoices(list);
          })
          .catch((reason: unknown) => {
            if (!cancelled)
              setError(
                reason instanceof Error
                  ? reason.message
                  : "Voice list unavailable.",
              );
          })
          .finally(() => {
            if (!cancelled) setLoading(false);
          });
      }
      return () => {
        cancelled = true;
      };
    }, [apiKey, model]);

    const selected = store.settings.speechifyVoice;
    const filtered = voices
      .filter((voice) =>
        `${voice.name} ${voice.id} ${voice.gender}`
          .toLowerCase()
          .includes(filter.toLowerCase()),
      )
      .sort((a, b) => a.name.localeCompare(b.name));

    return (
      <>
        <ApiKeyComponent
          store={store}
          provider="speechify"
          fieldName="speechifyApiKey"
          displayName="Speechify API key"
          helpUrl="https://console.speechify.ai/"
          showValidation={true}
        />
        <OptionSelectSetting
          name="Model"
          description="Simba 3.2 supports English only. Switching models generates distinct cached audio."
          store={store}
          provider="speechify"
          fieldName="speechifyModel"
          options={MODELS}
        />
        <TextInputSetting
          name="Voice ID"
          description="Exact Speechify voice ID. You can also select an available US English voice below."
          store={store}
          provider="speechify"
          fieldName="speechifyVoice"
          placeholder="geffen_32"
        />
        <div className="setting-item">
          <div className="setting-item-info">
            <div className="setting-item-name">US English voices</div>
            <div className="setting-item-description">
              Catalog filtered by Speechify model and en-US locale; listing
              voices does not synthesize audio.
              {loading ? " Loading…" : ` ${voices.length} voices available.`}
              {error && <span role="alert"> {error}</span>}
            </div>
          </div>
          <div className="setting-item-control">
            <input
              type="search"
              value={filter}
              aria-label="Search Speechify voices"
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Search voices…"
            />
            <select
              aria-label="Select Speechify voice"
              value={filtered.some((v) => v.id === selected) ? selected : ""}
              onChange={(e) => {
                if (e.target.value)
                  void store.updateModelSpecificSettings("speechify", {
                    speechifyVoice: e.target.value,
                  });
              }}
            >
              <option value="">Select a listed voice</option>
              {filtered.map((v) => (
                <option value={v.id} key={v.id}>
                  {v.name} ({v.id}, {v.gender})
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className="setting-item">
          <div className="setting-item-info">
            <div className="setting-item-name">
              Local monthly Speechify character cap
            </div>
            <div className="setting-item-description">
              Defaults to zero: explicitly authorize synthesis before testing.
              Reservations are stored per device and do not reflect Speechify
              billing or credits. Free starter credits are not a monthly
              allowance. Avoid generating the same article simultaneously on
              multiple devices.
            </div>
          </div>
          <div className="setting-item-control">
            <input
              type="number"
              min="0"
              step="1"
              aria-label="Speechify monthly budget"
              value={store.settings.speechifyMonthlyBudget}
              onChange={(e) => {
                const n = Number(e.target.value);
                if (Number.isSafeInteger(n) && n >= 0)
                  void store.updateSettings({ speechifyMonthlyBudget: n });
              }}
            />
          </div>
        </div>
      </>
    );
  },
);

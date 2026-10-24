import { REGISTRY } from "open-tts";
import type { TTSModel, TTSPluginSettings } from "open-tts";

/**
 * UI validation uses the currently selected provider. Audio synthesis uses
 * the provider captured when options were created, so an in-flight preload
 * cannot be rerouted when the user switches providers.
 */
export function ProxiedTTSModel(settings: TTSPluginSettings): TTSModel {
  return {
    call: (text, options, requestSettings, context, signal) => {
      const provider = options.modelProvider ?? settings.modelProvider;
      return REGISTRY[provider].call(
        text,
        options,
        requestSettings,
        context,
        signal,
      );
    },
    validateConnection: (currentSettings) =>
      REGISTRY[currentSettings.modelProvider].validateConnection(
        currentSettings,
      ),
    convertToOptions: (currentSettings) => {
      const provider = currentSettings.modelProvider;
      return {
        ...REGISTRY[provider].convertToOptions(currentSettings),
        modelProvider: provider,
      };
    },
  };
}

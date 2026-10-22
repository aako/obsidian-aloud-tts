import type { TTSPluginSettings } from "../player/TTSPluginSettings";
import type { AudioData } from "./tts-model";
import { azureCharacters, azureRequestGate } from "./AzureRequestGate";
import {
  AudioTextContext,
  ErrorMessage,
  REQUIRE_API_KEY,
  TTSErrorInfo,
  type TTSModel,
  type TTSModelOptions,
} from "./tts-model";

export const azureTextToSpeech: TTSModel = {
  call: azureCallTextToSpeech,
  validateConnection: async (settings) => {
    if (!settings.azure_apiKey.trim()) {
      return REQUIRE_API_KEY;
    }
    if (!settings.azure_region.trim()) {
      return "Please specify an Azure region";
    }
    return await validateApiKeyAzure(
      settings.azure_apiKey,
      settings.azure_region,
    );
  },
  convertToOptions: (settings): TTSModelOptions => {
    return {
      apiKey: settings.azure_apiKey,
      apiUri: `https://${settings.azure_region}.tts.speech.microsoft.com`,
      voice: settings.azure_voice,
      model: settings.azure_outputFormat,
    };
  },
};

export async function validateApiKeyAzure(
  apiKey: string,
  region: string,
): Promise<string | undefined> {
  try {
    await listAzureVoices(apiKey, region);
    return undefined;
  } catch (error) {
    if (error instanceof TTSErrorInfo) {
      if (error.httpErrorCode === 401) {
        return "Invalid API key or region";
      } else if (error.httpErrorCode !== undefined) {
        return `HTTP error code ${error.httpErrorCode}: ${error.ttsJsonMessage() || error.message}`;
      } else {
        return error.ttsJsonMessage() || error.message;
      }
    }
    return "Cannot connect to Azure Speech Services";
  }
}

export async function azureCallTextToSpeech(
  text: string,
  options: TTSModelOptions,
  settings: TTSPluginSettings,
  context: AudioTextContext = {},
  signal?: AbortSignal,
): Promise<AudioData> {
  if (!options.voice) {
    throw new Error("Voice is required for Azure TTS");
  }

  const ssmlBody = `<speak version='1.0' xml:lang='en-US'>
    <voice xml:lang='en-US' name='${options.voice}'>
      ${escapeXml(text)}
    </voice>
  </speak>`;

  const characters = azureCharacters(text);
  if (characters > 4000)
    throw new Error(
      "Azure chunk exceeds the conservative 4,000-character request limit. Use sentence chunking.",
    );
  signal ??= context.request?.signal;
  for (let attempt = 0; ; attempt++) {
    try {
      return await azureRequestGate.request(
        async () => {
          const response = await fetch(
            `${options.apiUri}/cognitiveservices/v1`,
            {
              method: "POST",
              headers: {
                "Ocp-Apim-Subscription-Key": options.apiKey || "",
                "Content-Type": "application/ssml+xml",
                "X-Microsoft-OutputFormat":
                  options.model || "audio-24khz-96kbitrate-mono-mp3",
                "User-Agent": "obsidian-aloud-tts",
              },
              body: ssmlBody,
              ...(signal ? { signal } : {}),
            },
          );

          if (response.status === 429 || response.status >= 500) {
            const retry = response.headers?.get("Retry-After");
            const delay = retry
              ? /^\d+(\.\d+)?$/.test(retry)
                ? Number(retry) * 1000
                : Math.max(0, Date.parse(retry) - Date.now())
              : 0;
            azureRequestGate.defer(
              Math.max(
                Number.isFinite(delay) ? delay : 0,
                Math.min(30_000, 1000 * 2 ** attempt) + Math.random() * 500,
              ),
            );
          }
          await validate200Azure(response);
          const buf = await response.arrayBuffer();
          // Always return mp3 format for cache consistency. Dynamic format selection not yet supported.
          return { data: buf, format: "mp3" };
        },
        {
          characters,
          budget:
            context.request?.budgetLimit ??
            settings.azureMonthlyBudget ??
            450000,
          priority: context.request?.priority,
          signal,
          onWait: context.request?.onWait,
        },
      );
    } catch (error) {
      if (
        signal?.aborted ||
        attempt >= 3 ||
        (error instanceof TTSErrorInfo && !error.isRetryable) ||
        !(error instanceof TTSErrorInfo || error instanceof TypeError)
      )
        throw error;
      azureRequestGate.defer(1000 * 2 ** attempt + Math.random() * 500);
    }
  }
}

export async function listAzureVoices(
  apiKey: string,
  region: string,
): Promise<{ id: string; name: string; gender: string; locale: string }[]> {
  const response = await fetch(
    `https://${region}.tts.speech.microsoft.com/cognitiveservices/voices/list`,
    {
      headers: {
        "Ocp-Apim-Subscription-Key": apiKey,
      },
    },
  );

  await validate200Azure(response);
  const voices = await response.json();

  return voices.map((voice: any) => ({
    id: voice.ShortName,
    name: voice.DisplayName,
    gender: voice.Gender,
    locale: voice.Locale,
  }));
}

export const AZURE_REGIONS = [
  "eastus",
  "eastus2",
  "westus",
  "westus2",
  "westus3",
  "centralus",
  "northcentralus",
  "southcentralus",
  "westcentralus",
  "canadacentral",
  "brazilsouth",
  "northeurope",
  "westeurope",
  "uksouth",
  "francecentral",
  "germanywestcentral",
  "norwayeast",
  "switzerlandnorth",
  "switzerlandwest",
  "swedencentral",
  "eastasia",
  "southeastasia",
  "japaneast",
  "japanwest",
  "koreacentral",
  "australiaeast",
  "centralindia",
  "jioindiawest",
  "uaenorth",
] as const;

export const AZURE_OUTPUT_FORMATS = [
  { label: "MP3 44.1kHz 128kbps", value: "audio-16khz-128kbitrate-mono-mp3" },
  { label: "MP3 24kHz 96kbps", value: "audio-24khz-96kbitrate-mono-mp3" },
  { label: "MP3 48kHz 192kbps", value: "audio-48khz-192kbitrate-mono-mp3" },
] as const;

async function validate200Azure(response: Response) {
  if (response.status >= 300) {
    let errorMessage: ErrorMessage | undefined;
    try {
      const jsonBody = await response.json();
      if (jsonBody.error) {
        errorMessage = {
          error: {
            message: jsonBody.error.message || "Unknown error",
            type: jsonBody.error.code || "azure_error",
            code: response.status.toString(),
            param: null,
          },
        };
      }
    } catch (ex) {
      // Failed to parse JSON, use generic error
    }

    throw new TTSErrorInfo(
      `HTTP ${response.status} error`,
      errorMessage,
      response.status,
    );
  }
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

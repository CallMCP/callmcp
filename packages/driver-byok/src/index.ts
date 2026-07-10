/**
 * @callmcp/driver-byok — public entry point.
 *
 * driver_id: `twilio_openai`. Twilio transport (calls/numbers/SMS) bridged
 * to a bring-your-own-key realtime brain (OpenAI Realtime API today).
 * Normative reference: SPEC.md at the repo root, and this package's README.
 */

export { BYOKDriver, TwilioDriverError, type BYOKDriverConfig } from "./driver.js";
export { BYOK_DRIVER_ID, BYOK_DRIVER_MANIFEST } from "./manifest.js";

export {
  TwilioTransport,
  buildVoiceStreamTwiml,
  mapTwilioError,
  type TwilioTransportConfig,
  type TwilioClientLike,
  type TwilioCallResource,
  type TwilioMessageResource,
  type TwilioRecordingResource,
  type TwilioAvailableNumberResource,
  type TwilioIncomingNumberResource,
} from "./transport/twilio.js";

export {
  RealtimeBridge,
  DEFAULT_SESSION_AUDIO_FORMAT,
  type RealtimeBridgeOptions,
  type ToolCallHook,
  type ToolCallOutcome,
} from "./brain/realtimeBridge.js";

export {
  openaiRealtimeAdapter,
  grokAdapter,
  type BrainAdapter,
  type BrainSessionConfig,
  type BrainTranscriptEvent,
  type BrainToolCallEvent,
  type BrainErrorEvent,
  type RealtimeAudioFormat,
  type RealtimeToolDefinition,
  type OpenAiRealtimeAdapterOptions,
  type GrokAdapterOptions,
} from "./brain/adapter.js";

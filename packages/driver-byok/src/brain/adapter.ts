/**
 * @callmcp/driver-byok — BrainAdapter
 *
 * The seam that lets `realtimeBridge.ts` stay brain-agnostic. A `BrainAdapter`
 * owns exactly one thing: a bidirectional realtime speech session with some
 * frontier-model "brain" — connect, stream caller audio in, stream agent
 * audio out, surface transcript events, and surface/settle mid-call tool
 * calls. `realtimeBridge.ts` never talks to OpenAI's (or anyone else's) wire
 * protocol directly; it only talks to this interface.
 *
 * Why this exists (see workspace/research/r3-realtime-brains.md): xAI's Grok
 * Voice Agent API is documented as OpenAI-Realtime-*wire-compatible* — "most
 * OpenAI Realtime SDKs work by swapping the base URL"
 * (docs.litellm.ai/docs/providers/xai_realtime, docs.x.ai Voice Agent guide).
 * That means a second brain can plausibly be added as a thin config diff
 * (base URL + API key + maybe a model name) rather than a second bridge
 * implementation — see `grokAdapter` below, which is intentionally a
 * documented TODO rather than a guess at wire details this repo hasn't
 * verified against x.ai's docs directly.
 */

import WebSocket from "ws";

// ---------------------------------------------------------------------------
// Wire-agnostic types the bridge programs against
// ---------------------------------------------------------------------------

/** Audio codec/sample-rate pairing. Twilio Media Streams ships 8kHz mu-law
 * (`g711_ulaw`) natively — requesting that same format from the brain avoids
 * a resampling step in the bridge entirely, which is the default this driver
 * uses (see `DEFAULT_SESSION_AUDIO_FORMAT` in realtimeBridge.ts). */
export type RealtimeAudioFormat = "g711_ulaw" | "g711_alaw" | "pcm16";

/** JSON-schema tool definition passed into the brain's session config, in
 * the shape OpenAI's Realtime API (and, per the wire-compatibility claim
 * above, Grok's Voice Agent API) expects for a function tool. */
export interface RealtimeToolDefinition {
  type: "function";
  name: string;
  description?: string;
  parameters: Record<string, unknown>;
}

export interface BrainSessionConfig {
  /** System prompt / agent instructions for this call. */
  instructions?: string;
  /** Brain-native voice identifier, if the brain supports voice selection. */
  voice?: string;
  /** Tool schemas the brain may invoke mid-conversation. */
  tools?: RealtimeToolDefinition[];
  inputAudioFormat?: RealtimeAudioFormat;
  outputAudioFormat?: RealtimeAudioFormat;
  /** Server-side voice-activity-detection turn-taking config; left as a
   * passthrough object since VAD tuning knobs are brain-specific. */
  turnDetection?: Record<string, unknown> | null;
}

export interface BrainTranscriptEvent {
  role: "agent" | "caller";
  text: string;
  /** false for incremental deltas, true for the finalized turn. Only final
   * turns should be persisted into a CallMCP `get_transcript` response. */
  final: boolean;
  at: string;
}

/**
 * A mid-call tool-call request from the brain. `toolCallId` is the brain's
 * own correlation id (e.g. OpenAI's Realtime `call_id`) — NOT a CallMCP
 * `call_id`. The bridge/driver is responsible for mapping any tool here that
 * itself would place a call or send a message back through the CallMCP
 * approval/allowlist machinery (SPEC §3) before ever settling it — see
 * `realtimeBridge.ts`'s `onToolCall` hook and `driver.ts`'s wiring comment.
 */
export interface BrainToolCallEvent {
  toolCallId: string;
  name: string;
  /** Raw JSON string of arguments, as the brain emitted them — parsing/
   * validating is the caller's responsibility so this adapter stays a dumb
   * pipe with no opinion on tool schemas. */
  argumentsJson: string;
}

export interface BrainErrorEvent {
  message: string;
  raw?: unknown;
}

/**
 * The contract every realtime brain adapter implements. Modeled as an
 * event-callback interface (rather than an EventEmitter) so it has zero
 * dependency surface beyond `ws` and is trivial to fake in tests.
 */
export interface BrainAdapter {
  /** short slug identifying the brain, e.g. "openai_realtime" */
  readonly id: string;

  /** Opens the realtime session and applies `config` (instructions/tools/
   * audio format) before any audio is exchanged. Must resolve once the
   * session is ready to accept audio — callers should not call
   * `sendCallerAudio` before this resolves. */
  connect(config: BrainSessionConfig): Promise<void>;

  /** Streams one chunk of caller audio (base64-encoded, in the format
   * negotiated by `connect`'s `inputAudioFormat`) into the brain session. */
  sendCallerAudio(chunkBase64: string): void;

  /** Registered exactly once by the bridge; fires for every agent audio
   * chunk (base64, `outputAudioFormat`) the brain streams back. */
  onAgentAudio(cb: (chunkBase64: string) => void): void;

  /** Registered exactly once by the bridge; fires for both caller and agent
   * transcript turns as the brain produces them. */
  onTranscript(cb: (event: BrainTranscriptEvent) => void): void;

  /** Registered exactly once by the bridge; fires whenever the brain wants
   * to invoke a tool mid-call. */
  onToolCall(cb: (event: BrainToolCallEvent) => void): void;

  /** Registered exactly once by the bridge; fires on brain-side session
   * errors (auth failure, malformed session config, upstream disconnect). */
  onError(cb: (event: BrainErrorEvent) => void): void;

  /** Settles a previously-emitted tool call and asks the brain to continue
   * the conversation using the result. */
  sendToolResult(toolCallId: string, resultJson: string): void;

  /** Barge-in support: tells the brain to stop the in-flight agent response
   * because the caller started talking over it. The bridge is responsible
   * for also clearing Twilio's outbound audio buffer — this only cancels
   * the brain's generation. */
  interruptAgent(): void;

  /** Closes the realtime session. Idempotent. */
  close(): void;
}

// ---------------------------------------------------------------------------
// OpenAI Realtime API adapter (GA today — see r3-realtime-brains.md §1)
// ---------------------------------------------------------------------------

export interface OpenAiRealtimeAdapterOptions {
  apiKey: string;
  /** Defaults to "gpt-realtime". Override for gpt-realtime-2.1,
   * gpt-realtime-2.1-mini (cheaper tier, ~40% of flagship audio-token cost
   * per r3-realtime-brains.md §1), etc. */
  model?: string;
  /** Defaults to OpenAI's realtime WebSocket endpoint. Overriding this (with
   * `wsUrlOverride`) plus swapping `apiKey` is the entire mechanism
   * `grokAdapter` below will eventually use — x.ai's Voice Agent API is
   * documented as wire-compatible at `wss://api.x.ai/v1/realtime?model=...`. */
  wsUrlOverride?: string;
  /** Injectable for tests; defaults to the real `ws` WebSocket constructor. */
  webSocketFactory?: (url: string, options: WebSocket.ClientOptions) => WebSocket;
}

const DEFAULT_OPENAI_REALTIME_URL = "wss://api.openai.com/v1/realtime";
const DEFAULT_OPENAI_REALTIME_MODEL = "gpt-realtime";

/**
 * Adapter for OpenAI's Realtime API over its WebSocket transport
 * (`wss://api.openai.com/v1/realtime`). Wire protocol reference:
 * https://developers.openai.com/api/docs/guides/realtime — every event
 * type/name below (`session.update`, `input_audio_buffer.append`,
 * `response.audio.delta`, `response.function_call_arguments.done`, etc.) is
 * OpenAI's own documented event vocabulary, not invented here.
 */
export function openaiRealtimeAdapter(options: OpenAiRealtimeAdapterOptions): BrainAdapter {
  const model = options.model ?? DEFAULT_OPENAI_REALTIME_MODEL;
  const url = options.wsUrlOverride ?? `${DEFAULT_OPENAI_REALTIME_URL}?model=${encodeURIComponent(model)}`;
  const wsFactory = options.webSocketFactory ?? ((u, o) => new WebSocket(u, o));

  let socket: WebSocket | null = null;
  let agentAudioCb: ((chunkBase64: string) => void) | null = null;
  let transcriptCb: ((event: BrainTranscriptEvent) => void) | null = null;
  let toolCallCb: ((event: BrainToolCallEvent) => void) | null = null;
  let errorCb: ((event: BrainErrorEvent) => void) | null = null;

  function send(payload: Record<string, unknown>): void {
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return;
    }
    socket.send(JSON.stringify(payload));
  }

  function handleServerEvent(raw: string): void {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      errorCb?.({ message: "received non-JSON frame from OpenAI Realtime", raw });
      return;
    }

    const type = event.type as string | undefined;
    switch (type) {
      case "response.audio.delta": {
        const delta = event.delta as string | undefined;
        if (delta) {
          agentAudioCb?.(delta);
        }
        break;
      }
      case "response.audio_transcript.delta": {
        const delta = event.delta as string | undefined;
        if (delta) {
          transcriptCb?.({ role: "agent", text: delta, final: false, at: new Date().toISOString() });
        }
        break;
      }
      case "response.audio_transcript.done": {
        const transcript = event.transcript as string | undefined;
        if (transcript) {
          transcriptCb?.({ role: "agent", text: transcript, final: true, at: new Date().toISOString() });
        }
        break;
      }
      case "conversation.item.input_audio_transcription.completed": {
        const transcript = event.transcript as string | undefined;
        if (transcript) {
          transcriptCb?.({ role: "caller", text: transcript, final: true, at: new Date().toISOString() });
        }
        break;
      }
      case "response.function_call_arguments.done": {
        const callId = event.call_id as string | undefined;
        const name = event.name as string | undefined;
        const args = event.arguments as string | undefined;
        if (callId && name) {
          toolCallCb?.({ toolCallId: callId, name, argumentsJson: args ?? "{}" });
        }
        break;
      }
      case "error": {
        errorCb?.({ message: String((event.error as { message?: string } | undefined)?.message ?? "unknown OpenAI Realtime error"), raw: event });
        break;
      }
      default:
        // Every other event type (session.created, response.created,
        // input_audio_buffer.speech_started/stopped, rate_limits.updated,
        // etc.) is intentionally not surfaced through BrainAdapter's narrow
        // interface. realtimeBridge.ts can widen this switch if a future
        // feature (e.g. explicit barge-in detection) needs one of them.
        break;
    }
  }

  return {
    id: "openai_realtime",

    connect(config: BrainSessionConfig): Promise<void> {
      return new Promise((resolve, reject) => {
        socket = wsFactory(url, {
          headers: {
            Authorization: `Bearer ${options.apiKey}`,
            "OpenAI-Beta": "realtime=v1",
          },
        });

        socket.once("open", () => {
          send({
            type: "session.update",
            session: {
              instructions: config.instructions ?? "",
              voice: config.voice ?? "alloy",
              input_audio_format: config.inputAudioFormat ?? "g711_ulaw",
              output_audio_format: config.outputAudioFormat ?? "g711_ulaw",
              input_audio_transcription: { model: "whisper-1" },
              turn_detection: config.turnDetection === null ? null : (config.turnDetection ?? { type: "server_vad" }),
              tools: config.tools ?? [],
            },
          });
          resolve();
        });

        socket.on("message", (data) => handleServerEvent(data.toString()));
        socket.on("error", (err) => {
          errorCb?.({ message: err.message, raw: err });
          reject(err);
        });
        socket.once("close", () => {
          socket = null;
        });
      });
    },

    sendCallerAudio(chunkBase64: string): void {
      send({ type: "input_audio_buffer.append", audio: chunkBase64 });
    },

    onAgentAudio(cb): void {
      agentAudioCb = cb;
    },

    onTranscript(cb): void {
      transcriptCb = cb;
    },

    onToolCall(cb): void {
      toolCallCb = cb;
    },

    onError(cb): void {
      errorCb = cb;
    },

    sendToolResult(toolCallId: string, resultJson: string): void {
      send({
        type: "conversation.item.create",
        item: {
          type: "function_call_output",
          call_id: toolCallId,
          output: resultJson,
        },
      });
      send({ type: "response.create" });
    },

    interruptAgent(): void {
      send({ type: "response.cancel" });
    },

    close(): void {
      socket?.close();
      socket = null;
    },
  };
}

// ---------------------------------------------------------------------------
// Grok Voice Agent API adapter — documented TODO, not implemented
// ---------------------------------------------------------------------------

export interface GrokAdapterOptions {
  apiKey: string;
  model?: string;
}

/**
 * TODO(grok-adapter): xAI's Grok Voice Agent API is documented as
 * OpenAI-Realtime *wire-compatible* — endpoint
 * `wss://api.x.ai/v1/realtime?model={model_name}`, "most OpenAI Realtime
 * SDKs work by swapping the base URL"
 * (https://docs.litellm.ai/docs/providers/xai_realtime,
 * https://docs.x.ai/developers/model-capabilities/audio/voice-agent). The
 * expected implementation is NOT a new event-parsing branch in this file —
 * it is a thin wrapper that calls `openaiRealtimeAdapter` with
 * `wsUrlOverride` pointed at x.ai's endpoint and `id` overridden to
 * "grok_realtime":
 *
 *   export function grokAdapter(o: GrokAdapterOptions): BrainAdapter {
 *     const inner = openaiRealtimeAdapter({
 *       apiKey: o.apiKey,
 *       model: o.model ?? "grok-voice",
 *       wsUrlOverride: `wss://api.x.ai/v1/realtime?model=${o.model ?? "grok-voice"}`,
 *     });
 *     return { ...inner, id: "grok_realtime" };
 *   }
 *
 * Left unimplemented deliberately: this repo has not verified Grok's event
 * vocabulary against a live session (SIP `byo_trunk`/G.711 support and
 * `response.function_call_arguments.done`-shaped tool events are documented
 * per r3-realtime-brains.md §2, but field-for-field wire parity is a claim
 * from third-party docs, not something exercised here). Wire this up behind
 * a real Grok API key and a recorded session transcript before flipping any
 * driver manifest flag that depends on it — do not ship this as
 * `supports_*: true` on the strength of the docs alone.
 */
export function grokAdapter(_options: GrokAdapterOptions): BrainAdapter {
  throw new Error(
    "grokAdapter is not implemented yet — see the documented TODO in src/brain/adapter.ts. " +
      "Grok Voice Agent API is claimed OpenAI-Realtime-wire-compatible but has not been " +
      "verified against a live session from this repo.",
  );
}

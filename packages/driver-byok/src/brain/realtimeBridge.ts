/**
 * @callmcp/driver-byok — RealtimeBridge
 *
 * The actual "Twilio Voice webhook -> TwiML <Connect><Stream> -> WebSocket
 * media-stream server -> bridge caller audio to an OpenAI Realtime API
 * session -> forward audio both directions, preserving mid-call
 * tool-calling" pattern from workspace/research/r2-transports.md §1 and
 * r3-realtime-brains.md §1, wired against a live Twilio Media Streams
 * WebSocket connection.
 *
 * This class does not open the WebSocket server itself — `@callmcp/server`
 * (or whatever host process embeds this driver) accepts the incoming
 * WebSocket upgrade from Twilio and hands the raw `ws.WebSocket` to
 * `RealtimeBridge.attach()`. That keeps this driver framework-agnostic
 * (no assumption about Express/Fastify/raw `http`/Twilio-Serverless).
 *
 * Twilio Media Streams wire protocol reference:
 * https://www.twilio.com/docs/voice/twiml/stream — the four event types
 * handled below (`connected`, `start`, `media`, `stop`) plus the outbound
 * `media`/`clear` events are Twilio's own documented vocabulary.
 */

import type WebSocket from "ws";
import type {
  BrainAdapter,
  BrainSessionConfig,
  BrainToolCallEvent,
  BrainTranscriptEvent,
  RealtimeAudioFormat,
} from "./adapter.js";
import type { TranscriptTurn } from "@callmcp/driver-interface";

/** Twilio Media Streams defaults to 8kHz mu-law — requesting the same
 * format from the brain (see BrainSessionConfig) means every audio chunk is
 * forwarded byte-for-byte in both directions, no resampling in this bridge. */
export const DEFAULT_SESSION_AUDIO_FORMAT: RealtimeAudioFormat = "g711_ulaw";

/**
 * Result of a mid-call tool invocation, as decided by whatever hook the
 * driver wired into `onToolCall` (see `ToolCallHook` below). `resultJson` is
 * fed straight back to the brain via `BrainAdapter.sendToolResult`.
 */
export interface ToolCallOutcome {
  resultJson: string;
}

/**
 * The hook `driver.ts` injects so a mid-call tool invocation from the brain
 * still passes through CallMCP's approval/allowlist machinery (SPEC §3)
 * before it's allowed to have an effect — e.g. if the agent's toolset
 * includes something that would place another call or send an SMS, that
 * tool implementation is responsible for checking approval state (owned by
 * the server core per driver-interface's README, not by this driver) before
 * acting, and for returning a result the brain can speak back to the caller
 * either way (approved, denied, or "still pending, I'll text you").
 *
 * This bridge does not know or care what a tool does — it only guarantees
 * every tool call the brain emits is round-tripped through this hook rather
 * than settled directly against the brain.
 */
export type ToolCallHook = (event: BrainToolCallEvent, callId: string) => Promise<ToolCallOutcome>;

export interface RealtimeBridgeOptions {
  /** The Twilio Media Streams WebSocket connection (server side of the
   * `<Connect><Stream>` upgrade). */
  twilioSocket: WebSocket;
  /** Factory so the bridge doesn't need to know which brain it's wiring —
   * pass `() => openaiRealtimeAdapter({...})` in production, a fake in
   * tests. Called once per bridge (i.e. once per call). */
  createBrainAdapter: () => BrainAdapter;
  /**
   * Resolves the session config (instructions/tools/voice) to apply to the
   * brain, given the real Twilio CallSid/StreamSid from the `start` event.
   * A function rather than a fixed value because the driver doesn't know
   * which call this bridge belongs to (and therefore which `agent_config_ref`
   * to resolve) until Twilio's `start` message arrives — the WebSocket
   * upgrade itself carries no reliable call identity ahead of that.
   */
  resolveSessionConfig: (info: { callSid: string; streamSid: string }) => Promise<BrainSessionConfig> | BrainSessionConfig;
  /** Invoked for every mid-call tool call the brain emits. Required — a
   * bridge with no tool hook still needs to at least no-op-and-log so a
   * misbehaving brain can't hang waiting for a tool result forever. */
  onToolCall: ToolCallHook;
  /** Called for every finalized transcript turn, so `driver.ts` can
   * accumulate it into the CallMCP `get_transcript` store for this call. */
  onTranscriptTurn?: (turn: TranscriptTurn) => void;
  /** Called once Twilio's `start` event arrives, with the real Twilio
   * CallSid/StreamSid — lets the driver correlate this bridge instance back
   * to the call_id it already knows from `make_call`. */
  onStart?: (info: { callSid: string; streamSid: string }) => void;
  /** Called once the stream ends (Twilio `stop` event or socket close). */
  onEnd?: () => void;
}

interface TwilioStreamStartMessage {
  event: "start";
  start: {
    streamSid: string;
    callSid: string;
    customParameters?: Record<string, string>;
  };
}

interface TwilioStreamMediaMessage {
  event: "media";
  media: { payload: string };
}

interface TwilioStreamStopMessage {
  event: "stop";
}

interface TwilioStreamConnectedMessage {
  event: "connected";
}

type TwilioStreamMessage =
  | TwilioStreamStartMessage
  | TwilioStreamMediaMessage
  | TwilioStreamStopMessage
  | TwilioStreamConnectedMessage
  | { event: string };

/**
 * One `RealtimeBridge` instance = one live phone call. Owns the Twilio
 * Media Streams socket and the brain session for that call's duration.
 */
export class RealtimeBridge {
  private readonly twilioSocket: WebSocket;
  private readonly createBrainAdapter: () => BrainAdapter;
  private readonly resolveSessionConfig: (info: {
    callSid: string;
    streamSid: string;
  }) => Promise<BrainSessionConfig> | BrainSessionConfig;
  private readonly onToolCall: ToolCallHook;
  private readonly onTranscriptTurn: ((turn: TranscriptTurn) => void) | undefined;
  private readonly onStartCb: ((info: { callSid: string; streamSid: string }) => void) | undefined;
  private readonly onEndCb: (() => void) | undefined;

  private brain: BrainAdapter | null = null;
  private streamSid: string | null = null;
  private callSid: string | null = null;
  private readonly transcript: TranscriptTurn[] = [];

  constructor(options: RealtimeBridgeOptions) {
    this.twilioSocket = options.twilioSocket;
    this.createBrainAdapter = options.createBrainAdapter;
    this.resolveSessionConfig = options.resolveSessionConfig;
    this.onToolCall = options.onToolCall;
    this.onTranscriptTurn = options.onTranscriptTurn;
    this.onStartCb = options.onStart;
    this.onEndCb = options.onEnd;
  }

  /** Wires the Twilio socket's event listeners. Call once, right after
   * construction. Split from the constructor only so tests can construct
   * without immediately racing the `message` listener. */
  attach(): void {
    this.twilioSocket.on("message", (data) => {
      void this.handleTwilioMessage(data.toString());
    });
    this.twilioSocket.on("close", () => {
      this.brain?.close();
      this.onEndCb?.();
    });
  }

  getTranscript(): TranscriptTurn[] {
    return this.transcript;
  }

  private async handleTwilioMessage(raw: string): Promise<void> {
    let message: TwilioStreamMessage;
    try {
      message = JSON.parse(raw) as TwilioStreamMessage;
    } catch {
      return;
    }

    switch (message.event) {
      case "connected":
        // No-op: Twilio's handshake ack. Real session setup happens on `start`,
        // which is the first message that actually carries callSid/streamSid.
        break;

      case "start":
        await this.handleStart(message as TwilioStreamStartMessage);
        break;

      case "media":
        this.handleMedia(message as TwilioStreamMediaMessage);
        break;

      case "stop":
        this.brain?.close();
        this.onEndCb?.();
        break;

      default:
        break;
    }
  }

  private async handleStart(message: TwilioStreamStartMessage): Promise<void> {
    this.streamSid = message.start.streamSid;
    this.callSid = message.start.callSid;
    this.onStartCb?.({ callSid: this.callSid, streamSid: this.streamSid });

    const brain = this.createBrainAdapter();
    this.brain = brain;

    brain.onAgentAudio((chunkBase64) => {
      this.sendMediaToTwilio(chunkBase64);
    });

    brain.onTranscript((event: BrainTranscriptEvent) => {
      if (!event.final) {
        return;
      }
      const turn: TranscriptTurn = {
        role: event.role === "caller" ? "caller" : "agent",
        text: event.text,
        at: event.at,
      };
      this.transcript.push(turn);
      this.onTranscriptTurn?.(turn);
    });

    brain.onToolCall((event: BrainToolCallEvent) => {
      void this.settleToolCall(event);
    });

    brain.onError((event) => {
      this.transcript.push({
        role: "system",
        text: `brain error: ${event.message}`,
        at: new Date().toISOString(),
      });
    });

    const sessionConfig = await this.resolveSessionConfig({
      callSid: this.callSid,
      streamSid: this.streamSid,
    });

    await brain.connect({
      inputAudioFormat: DEFAULT_SESSION_AUDIO_FORMAT,
      outputAudioFormat: DEFAULT_SESSION_AUDIO_FORMAT,
      ...sessionConfig,
    });
  }

  private handleMedia(message: TwilioStreamMediaMessage): void {
    this.brain?.sendCallerAudio(message.media.payload);
  }

  private async settleToolCall(event: BrainToolCallEvent): Promise<void> {
    if (!this.callSid) {
      // Should be unreachable — `start` always precedes tool-call-bearing
      // audio in Twilio's protocol — but fail safe rather than throw into
      // an unawaited promise chain.
      return;
    }
    const outcome = await this.onToolCall(event, this.callSid);
    this.brain?.sendToolResult(event.toolCallId, outcome.resultJson);
  }

  /** Forwards one agent audio chunk back to Twilio as an outbound `media`
   * event, per the Media Streams wire format. */
  private sendMediaToTwilio(chunkBase64: string): void {
    if (!this.streamSid || this.twilioSocket.readyState !== this.twilioSocket.OPEN) {
      return;
    }
    this.twilioSocket.send(
      JSON.stringify({
        event: "media",
        streamSid: this.streamSid,
        media: { payload: chunkBase64 },
      }),
    );
  }

  /** Barge-in: caller started talking while the agent's audio is still
   * playing out over the Twilio leg. Clears Twilio's outbound buffer AND
   * cancels the brain's in-flight response — both halves are required, or
   * the caller keeps hearing stale audio even after the brain stops
   * generating it. Exposed for a future caller-VAD hook; OpenAI's server-
   * side `turn_detection` already triggers `interruptAgent`-equivalent
   * behavior brain-side via `input_audio_buffer.speech_started`, but this
   * bridge does not yet listen for that event (see adapter.ts's `default`
   * switch-case comment) — wiring it here is the next increment. */
  interruptForBargeIn(): void {
    if (this.streamSid && this.twilioSocket.readyState === this.twilioSocket.OPEN) {
      this.twilioSocket.send(JSON.stringify({ event: "clear", streamSid: this.streamSid }));
    }
    this.brain?.interruptAgent();
  }
}

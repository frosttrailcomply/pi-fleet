// Builds the pi-ai assistant-message event sequence for a fully-resolved text
// answer. The fleet provider resolves the whole answer via the failover
// executor (non-streaming upstream) then re-emits it to pi as a single-chunk
// stream, following the documented event order:
//   start -> text_start -> text_delta -> text_end -> done
//
// The concrete stream object pi passes in exposes push()/end(); we stay
// defensive about its exact shape so minor pi-ai version drift doesn't break us.

export interface PushableStream {
  push(event: Record<string, unknown>): void;
  end(): void;
}

export interface AssistantOutput {
  role: "assistant";
  content: Array<Record<string, unknown>>;
  provider: string;
  model: string;
  usage: Record<string, number>;
  stopReason: string;
  timestamp: number;
  errorMessage?: string;
}

export function newOutput(provider: string, model: string): AssistantOutput {
  return {
    role: "assistant", content: [], provider, model,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
    stopReason: "pending", timestamp: Date.now(),
  };
}

/** Emit a complete text answer as a pi assistant-message stream. */
export function emitText(stream: PushableStream, output: AssistantOutput, text: string, tokens: number): void {
  output.content = [{ type: "text", text }];
  output.usage.output = tokens;
  output.usage.totalTokens = tokens;
  output.stopReason = "stop";
  stream.push({ type: "start", partial: { ...output, content: [], stopReason: "pending" } });
  stream.push({ type: "text_start", index: 0 });
  stream.push({ type: "text_delta", index: 0, delta: text });
  stream.push({ type: "text_end", index: 0 });
  stream.push({ type: "done", reason: "stop", message: output });
  stream.end();
}

/** Emit an error as a pi assistant-message stream. */
export function emitError(stream: PushableStream, output: AssistantOutput, message: string, aborted = false): void {
  output.stopReason = aborted ? "aborted" : "error";
  output.errorMessage = message;
  stream.push({ type: "error", reason: output.stopReason, error: output });
  stream.end();
}

// A deliberately minimal, local view of the pi ExtensionAPI surface this
// package uses. Typing against this (instead of importing @earendil-works/
// pi-coding-agent) lets the extension typecheck standalone; at runtime pi
// injects the real, richer object which is structurally compatible.

export interface PiEventCtx {
  cwd: string;
  hasUI?: boolean;
  ui?: {
    notify?(msg: string): void;
    setStatus?(msg: string): void;
  };
  isProjectTrusted?(): boolean;
}

export interface PiCommandCtx extends PiEventCtx {
  waitForIdle?(): Promise<void>;
}

/** Legacy provider-config form accepted by pi.registerProvider(name, config). */
export interface PiProviderConfig {
  name?: string;
  baseUrl?: string;
  apiKey?: string;
  api?: string;
  headers?: Record<string, string>;
  models?: Array<Record<string, unknown>>;
  refreshModels?: (args: { signal?: AbortSignal; stored?: unknown; publish?: (models: unknown[]) => void }) => Promise<Array<Record<string, unknown>>>;
  streamSimple?: (model: unknown, context: unknown, options?: unknown) => unknown;
}

export interface PiExtensionAPI {
  on(event: string, handler: (event: unknown, ctx: PiEventCtx) => unknown): void;
  registerProvider(name: string, config: PiProviderConfig): void;
  unregisterProvider?(name: string): void;
  registerCommand(name: string, def: { description: string; handler: (args: string, ctx: PiCommandCtx) => Promise<void> | void }): void;
  registerFlag?(name: string, def: { description: string; type: "boolean" | "string"; default?: unknown }): void;
  sendMessage?(message: unknown, opts?: unknown): void;
}

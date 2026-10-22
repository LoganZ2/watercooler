import Anthropic from '@anthropic-ai/sdk';
import type { BotConfig } from './config';

/** A client tool the model calls to hand back its answer as structured input. */
export type SubmitTool = Anthropic.Beta.BetaTool;

export interface AskRequest {
  system: string;
  prompt: string;
  /** Web searches the model may run; a failed search still uses one up. */
  maxSearches: number;
  tool: SubmitTool;
}

/** Ask the model with web search and return what it passed to `tool`, or null if it never called it. */
export type Ask = (req: AskRequest) => Promise<unknown>;

/** Models with dynamic-filtering web search (`web_search_20260209`). */
const DYNAMIC_SEARCH_MODELS = /^claude-(opus-(5-5|5|4-8|4-7|4-6)|sonnet-(5-5|5|4-6)|fable-5(-1)?|mythos-5(-1)?)(\b|$)/;
/** Models that accept the server-side `fallbacks: "default"` refusal fallback. */
const FALLBACK_MODELS = new Set(['claude-fable-5-1', 'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5']);
const OFFICIAL_ENDPOINT = 'https://api.anthropic.com';
/** A paused server-tool turn is resumed at most this many times. */
const MAX_CONTINUATIONS = 4;

/** The SDK appends /v1/messages itself; accept endpoints written with or without it. */
export function normalizeEndpoint(endpoint: string): string {
  return endpoint.replace(/\/+$/, '').replace(/\/v1(\/messages)?$/, '');
}

/** The client plus the request options every call shares (effort, refusal fallback). */
function connect(config: BotConfig) {
  const baseURL = normalizeEndpoint(config.endpoint);
  const client = new Anthropic({ apiKey: config.apiKey, baseURL, maxRetries: 2, timeout: 10 * 60_000 });
  const fallback = config.refusalFallback ?? (baseURL === OFFICIAL_ENDPOINT && FALLBACK_MODELS.has(config.model));
  const shared = {
    ...(config.effort ? { output_config: { effort: config.effort } } : {}),
    ...(fallback ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {}),
  };
  return { client, shared };
}

export function createAsk(config: BotConfig): Ask {
  const { client, shared } = connect(config);
  const searchType =
    config.webSearchTool ?? (DYNAMIC_SEARCH_MODELS.test(config.model) ? 'web_search_20260209' : 'web_search_20250305');

  return async ({ system, prompt, maxSearches, tool }) => {
    const search: Anthropic.Beta.BetaToolUnion =
      searchType === 'web_search_20260209'
        ? { type: 'web_search_20260209', name: 'web_search', max_uses: maxSearches }
        : { type: 'web_search_20250305', name: 'web_search', max_uses: maxSearches };
    const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: 'user', content: prompt }];
    for (let turn = 0; turn <= MAX_CONTINUATIONS; turn++) {
      const response = await client.beta.messages.create({
        model: config.model,
        max_tokens: 16000,
        system,
        messages,
        tools: [search, tool],
        ...shared,
      });
      if (response.stop_reason === 'refusal') return null;
      const call = response.content.find(
        (b): b is Anthropic.Beta.BetaToolUseBlock => b.type === 'tool_use' && b.name === tool.name,
      );
      if (call) return call.input;
      // The server-side search loop paused: send the turn back unchanged and it resumes.
      if (response.stop_reason !== 'pause_turn') return null;
      messages.push({ role: 'assistant', content: response.content });
    }
    return null;
  };
}

export interface ChatRequest {
  system: string;
  messages: Anthropic.Beta.BetaMessageParam[];
  tools: Anthropic.Beta.BetaTool[];
}

/** One model turn with client tools only (no web search): the caller runs the tools and loops. */
export type Chat = (req: ChatRequest) => Promise<Pick<Anthropic.Beta.BetaMessage, 'content' | 'stop_reason'>>;

export function createChat(config: BotConfig): Chat {
  const { client, shared } = connect(config);
  return (req) =>
    client.beta.messages.create(
      {
        model: config.model,
        max_tokens: 4096,
        system: req.system,
        messages: req.messages,
        tools: req.tools,
        ...shared,
      },
      { timeout: 2 * 60_000 },
    );
}

export interface PlayRequest {
  /** Identical for every call of a game, so it is cached once. */
  system: string;
  /**
   * What everyone has seen so far, one block per event, oldest first. Calls share it as a growing
   * prefix: the last block is marked for caching and later calls read the earlier blocks back.
   */
  transcript: string[];
  /** The player's own view and task, after the shared part. */
  prompt: string;
  tool: Anthropic.Beta.BetaTool;
}

/** One werewolf player's turn: what it passed to `tool`, or null if it never called it. */
export type Play = (req: PlayRequest) => Promise<unknown>;

export function createPlay(config: BotConfig): Play {
  const model = config.werewolf.model ?? config.model;
  const { client, shared } = connect({ ...config, model });
  return async ({ system, transcript, prompt, tool }) => {
    const blocks: Anthropic.Beta.BetaTextBlockParam[] = transcript.map((text) => ({ type: 'text', text }));
    if (blocks.length) blocks[blocks.length - 1]!.cache_control = { type: 'ephemeral' };
    const response = await client.beta.messages.create(
      {
        model,
        max_tokens: 8000,
        system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content: [...blocks, { type: 'text', text: prompt }] }],
        tools: [tool],
        ...shared,
      },
      { timeout: 3 * 60_000 },
    );
    if (response.stop_reason === 'refusal') return null;
    const call = response.content.find(
      (b): b is Anthropic.Beta.BetaToolUseBlock => b.type === 'tool_use' && b.name === tool.name,
    );
    return call?.input ?? null;
  };
}

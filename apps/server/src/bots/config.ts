import { existsSync, readFileSync } from 'node:fs';
import { z } from 'zod';

/** bot.json: how the AI bots reach the model and how busy they are. Lives next to the database, never in git. */
export const botConfigSchema = z.object({
  /** An Anthropic Messages API endpoint: the official one or a compatible relay. */
  endpoint: z.string().url().default('https://api.anthropic.com'),
  apiKey: z.string().min(1),
  model: z.string().min(1),
  /** Number of bot accounts on this instance. */
  bots: z.number().int().min(1).max(500).default(50),
  /** Attempts to write an AI market per 24h, failed ones included (each one searches the web several times). */
  marketsPerDay: z.number().min(0).max(100).default(2),
  /** Upper bound on bot bets per 24h (each bet is one model call with one web search). */
  betsPerDay: z.number().min(0).max(5000).default(50),
  /** Chance that a bot deliberately bets against its own pick. */
  flipProbability: z.number().min(0).max(1).default(0.2),
  /** Optional `output_config.effort`; the model's default when absent. */
  effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional(),
  /** Web search tool version; picked from the model when absent. */
  webSearchTool: z.enum(['web_search_20260209', 'web_search_20250305']).optional(),
  /** Server-side refusal fallback (`fallbacks: "default"`); on by default for supported models on the official endpoint. */
  refusalFallback: z.boolean().optional(),
  /** Optional WeCom (企业微信) smart bot: people bind their account in a group chat and then bet by chatting. */
  wecom: z
    .object({
      botId: z.string().min(1),
      secret: z.string().min(1),
      /** Public address of this instance, for binding links and market links, e.g. https://ky-z.com/watercooler */
      siteUrl: z.string().url(),
      siteName: z.string().min(1).default('Watercooler'),
      /** Messages per person per hour that go to the model. */
      messagesPerHour: z.number().int().min(1).max(1000).default(30),
    })
    .optional(),
});
export type BotConfig = z.infer<typeof botConfigSchema>;

/** Null when there is no bot.json; throws with a readable message when it is invalid. */
export function loadBotConfig(path: string): BotConfig | null {
  if (!existsSync(path)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(`${path} is not valid JSON: ${(err as Error).message}`);
  }
  const parsed = botConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(`${path}: ${issue?.path.join('.') || '(root)'} ${issue?.message ?? 'is invalid'}`);
  }
  return parsed.data;
}

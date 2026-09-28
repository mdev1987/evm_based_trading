import { Bot } from "grammy";
import { convert } from "telegram-markdown-v2";
import type { TelegramConfig } from "./config";

const MAX_MESSAGE_CHARS = 3900;

type TelegramBot = Bot;

/** Context shown on the startup banner. */
export type StartupInfo = {
  mode: string;
  chains: string[];
  version: string;
  buyAmountBase: string;
  maxOpenPositions: number;
  takeProfitSummary: string;
  trailingSummary: string;
};

/** Context shown on the shutdown banner. */
export type ShutdownInfo = {
  mode: string;
  chains: string[];
  uptimeMs: number;
};

/** Current UTC time as "2026-09-29 02:10:00 UTC". */
function utcNow(): string {
  return `${new Date().toISOString().split(".")[0]?.replace("T", " ")} UTC`;
}

/** Compact uptime, e.g. "2h 15m" or "45s". */
function formatUptime(uptimeMs: number): string {
  if (!Number.isFinite(uptimeMs) || uptimeMs < 0) return "N/A";
  const seconds = Math.floor(uptimeMs / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

/**
 * Telegram reporter used by the trading engine and application coordinator.
 *
 * The bot is never started with long polling: it only sends outbound reports.
 * This keeps Telegram isolated from the trading event loop.
 */
export class TelegramService {
  private readonly bot: TelegramBot | null;

  constructor(private readonly config: TelegramConfig) {
    this.bot = config.enabled ? new Bot(config.token) : null;
  }

  /** Whether Telegram reporting is enabled. */
  get enabled(): boolean {
    return this.bot !== null;
  }

  /** Send a Markdown message, transparently splitting oversized messages. */
  async send(markdown: string): Promise<void> {
    if (!this.bot) return;

    const formatted = convert(markdown, "escape");
    for (const chunk of splitMessage(formatted)) {
      await this.bot.api.sendMessage(this.config.chatId, chunk, {
        parse_mode: "MarkdownV2",
        link_preview_options: { is_disabled: true },
      });
    }
  }

  /** Verify both bot credentials and access to the configured destination chat. */
  async verify(): Promise<void> {
    if (!this.bot) return;
    await this.bot.api.getMe();
    await this.bot.api.getChat(this.config.chatId);
  }

  /** Send a standardized application startup report. */
  async sendStartup(info: StartupInfo): Promise<void> {
    await this.send(
      `🚀 *EVM Trading Bot started* ✅\n` +
      `⚙️ Mode: ${info.mode.toUpperCase()}\n` +
      `🔖 Version: v${info.version}\n` +
      `⛓️ Chains: ${info.chains.join(", ")}\n` +
      `💵 Buy: ${info.buyAmountBase} | 📦 Max positions: ${info.maxOpenPositions}\n` +
      `🎯 TP: ${info.takeProfitSummary}\n` +
      `🛡️ Trailing: ${info.trailingSummary}\n` +
      `🕒 Started: ${utcNow()}`,
    );
  }

  /** Send a standardized application shutdown report. */
  async sendShutdown(info: ShutdownInfo): Promise<void> {
    await this.send(
      `🛑 *EVM Trading Bot stopped*\n` +
      `⚙️ Mode: ${info.mode.toUpperCase()}\n` +
      `⛓️ Chains: ${info.chains.join(", ")}\n` +
      `⏱️ Uptime: ${formatUptime(info.uptimeMs)}\n` +
      `🕒 Stopped: ${utcNow()}`,
    );
  }

  /** Send a standardized service error report. */
  async sendError(scope: string, chain: string, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    await this.send(`*${scope} error*\nChain: ${chain}\n${message}`);
  }
}

/**
 * Split escaped Telegram MarkdownV2 text below Telegram's 4096 character
 * message limit while avoiding a trailing escape character at chunk boundaries.
 */
export function splitMessage(text: string): string[] {
  if (text.length <= MAX_MESSAGE_CHARS) return [text];

  const chunks: string[] = [];
  let current = "";

  const pushLine = (line: string): void => {
    let rest = line;

    while (rest.length > MAX_MESSAGE_CHARS) {
      if (current) {
        chunks.push(current);
        current = "";
      }

      let cut = MAX_MESSAGE_CHARS;
      const trailingBackslashes = rest.slice(0, cut).match(/\\+$/)?.[0].length ?? 0;
      if (trailingBackslashes % 2 === 1) cut -= 1;

      chunks.push(rest.slice(0, cut));
      rest = rest.slice(cut);
    }

    const candidate = current ? `${current}\n${rest}` : rest;
    if (current && candidate.length > MAX_MESSAGE_CHARS) {
      chunks.push(current);
      current = rest;
    } else {
      current = candidate;
    }
  };

  for (const line of text.split("\n")) pushLine(line);
  if (current) chunks.push(current);
  return chunks;
}

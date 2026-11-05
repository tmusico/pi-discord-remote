/**
 * Config management for pi-discord-remote.
 * Config is persisted to ~/.pi/agent/pi-discord-remote/config.json.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

export const CONFIG_DIR = join(homedir(), ".pi", "agent", "pi-discord-remote");
export const CONFIG_FILE = join(CONFIG_DIR, "config.json");

export interface Config {
  token: string;
  /** Discord guild (server) ID — required for auto-channel creation */
  guildId: string;
  /** Optional category ID to put new channels under */
  categoryId?: string;
  /** Fallback channel ID when not creating a new channel (legacy) */
  channelId?: string;
  /** Optional allow-list of Discord user IDs. Empty = allow everyone. */
  allowedUserIds?: string[];
  /** React with emoji while processing (default: true) */
  reactions?: boolean;
  /** Also send tool responses (output/results) after each tool call (default: false) */
  toolResponses?: boolean;
  /**
   * Keep the Discord connection alive after `/pi-discord-remote stop`
   * (hub mode) so the `/pi-status` slash command can still answer.
   * Set to `false` to restore the old behavior (stop = full disconnect).
   * Default: true.
   */
  keepOnline?: boolean;
}

/**
 * Load the configuration.
 *
 * `file` defaults to {@link CONFIG_FILE}; a different path can be passed so
 * tests (and alternative installs) never touch the user's real config.
 */
export async function loadConfig(file: string = CONFIG_FILE): Promise<Config | null> {
  try {
    const cfg = JSON.parse(await readFile(file, "utf-8")) as Config;
    // Allow DISCORD_TOKEN env var to override the config token
    if (process.env.DISCORD_TOKEN) {
      cfg.token = process.env.DISCORD_TOKEN;
    }
    return cfg;
  } catch {
    // Fall back to env var only (useful for CI / headless setups)
    if (process.env.DISCORD_TOKEN && process.env.DISCORD_GUILD_ID) {
      return {
        token: process.env.DISCORD_TOKEN,
        guildId: process.env.DISCORD_GUILD_ID,
        categoryId: process.env.DISCORD_CATEGORY_ID,
        reactions: true,
        toolResponses: false,
        keepOnline: true,
      };
    }
    return null;
  }
}

/**
 * Persist the configuration.
 *
 * `file` defaults to {@link CONFIG_FILE}; a different path can be passed so
 * tests (and alternative installs) never touch the user's real config.
 */
export async function saveConfig(cfg: Config, file: string = CONFIG_FILE): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(cfg, null, 2) + "\n");
}

/** Default config template shown in the editor when no config exists. */
export function defaultConfigTemplate(): string {
  return (
    JSON.stringify(
      {
        token: "",
        guildId: "",
        categoryId: "",
        allowedUserIds: [],
        reactions: true,
        // Set to true to also post tool outputs/results after each tool call
        toolResponses: false,
        // Keep the bot connected after /pi-discord-remote stop so /pi-status
        // can still answer. Set to false for the old "stop = disconnect" behavior.
        keepOnline: true,
      },
      null,
      2,
    ) + "\n"
  );
}

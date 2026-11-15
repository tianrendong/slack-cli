#!/usr/bin/env -S bun --no-env-file

import { readBoolFlag, readIntFlag, readStringFlag, parseCliArgs } from "./args";
import {
  authFilePath,
  clearStoredAuth,
  ENV_TOKEN_VAR,
  getAuthForApi,
  readStoredAuth,
  runOAuthLogin,
  storeUserToken,
} from "./auth";
import { formatMessages, parseDateOrTimestamp, printJson, printMessages } from "./format";
import { loadLocalEnv } from "./env";
import {
  createClient,
  getPermalink,
  listChannels,
  readChannelHistory,
  readThread,
  searchSlack,
  type SearchMode,
} from "./slack";
import { parseSlackUrl } from "./slack-url";

async function main(): Promise<void> {
  await loadLocalEnv();

  const args = parseCliArgs(Bun.argv.slice(2));

  if (!args.command || args.command === "help" || args.command === "--help" || args.command === "-h") {
    printHelp();
    return;
  }

  if (readBoolFlag(args.flags, "help") || readBoolFlag(args.flags, "h")) {
    printCommandHelp(args.command);
    return;
  }

  switch (args.command) {
    case "auth":
      await runAuthCommand(args.subcommand, args.positionals, args.flags);
      return;
    case "search":
      await runSearchCommand([args.subcommand, ...args.positionals].filter(Boolean) as string[], args.flags);
      return;
    case "read":
      await runReadCommand([args.subcommand, ...args.positionals].filter(Boolean) as string[], args.flags);
      return;
    case "thread":
      await runThreadCommand([args.subcommand, ...args.positionals].filter(Boolean) as string[], args.flags);
      return;
    case "channels":
      await runChannelsCommand([args.subcommand, ...args.positionals].filter(Boolean) as string[], args.flags);
      return;
    case "permalink":
      await runPermalinkCommand([args.subcommand, ...args.positionals].filter(Boolean) as string[]);
      return;
    default:
      throw new Error(`Unknown command: ${args.command}`);
  }
}

async function runAuthCommand(
  subcommand: string | undefined,
  positionals: string[],
  flags: Record<string, string | boolean>,
): Promise<void> {
  switch (subcommand) {
    case "status": {
      const envToken = process.env[ENV_TOKEN_VAR];
      const stored = envToken ? undefined : await readStoredAuth();
      const token = envToken ?? stored?.userToken;

      if (!token) {
        console.log("Not authenticated.");
        console.log(`No token stored at ${authFilePath()} and ${ENV_TOKEN_VAR} is not set`);
        return;
      }

      const client = createClient(token);
      const test = await client.auth.test();
      const userId = test.user_id ?? stored?.authedUser?.id ?? "unknown";
      const userName = test.user ?? "unknown";
      const team = test.team ?? stored?.team?.name ?? "unknown-team";
      const headers = (test.response_metadata as { scopes?: string[] } | undefined);
      const headerScopes = headers?.scopes?.length ? headers.scopes.join(",") : undefined;
      const scopes = headerScopes ?? stored?.scope;

      console.log(`Token source: ${envToken ? `env var ${ENV_TOKEN_VAR}` : `token file ${authFilePath()}`}`);
      console.log(`User: ${userName} (${userId})`);
      console.log(`Team: ${team}`);
      console.log(`Scopes: ${scopes ?? "unknown"}`);
      if (stored?.expiresAt) {
        console.log(`Expires: ${new Date(stored.expiresAt).toLocaleString()}`);
      } else if (stored) {
        console.log("Expires: no local expiry recorded");
      }
      return;
    }
    case "token": {
      const token = positionals[0];
      if (!token) throw new Error("Usage: slack auth token <xoxp-token>");
      const auth = await storeUserToken(token);
      console.log(`Stored Slack user token at ${authFilePath()}`);
      console.log(`Authenticated as ${auth.authedUser?.id ?? "unknown"} on ${auth.team?.name ?? "unknown-team"}`);
      return;
    }
    case "login": {
      const auth = await runOAuthLogin({ openBrowser: !readBoolFlag(flags, "no-open") });
      console.log(`Stored Slack user token at ${authFilePath()}`);
      console.log(`Authenticated as ${auth.authedUser?.id ?? "unknown"} on ${auth.team?.name ?? "unknown-team"}`);
      if (auth.expiresAt) {
        console.log(`Token rotation detected; expires ${new Date(auth.expiresAt).toLocaleString()}`);
      }
      return;
    }
    case "logout":
      await clearStoredAuth();
      console.log(`Removed ${authFilePath()}`);
      return;
    default:
      printAuthHelp();
  }
}

async function runSearchCommand(positionals: string[], flags: Record<string, string | boolean>): Promise<void> {
  const query = positionals.join(" ").trim();
  if (!query) throw new Error("Usage: slack search <query> [--limit 20] [--legacy|--rts] [--json]");

  const auth = await getAuthForApi();
  const client = createClient(auth.userToken);
  const mode: SearchMode = readBoolFlag(flags, "legacy") ? "legacy" : readBoolFlag(flags, "rts") ? "rts" : "auto";
  const sort = readStringFlag(flags, "sort") === "timestamp" ? "timestamp" : "score";
  const sortDir = readStringFlag(flags, "sort-dir") === "asc" ? "asc" : "desc";
  const result = await searchSlack(client, {
    query,
    limit: readIntFlag(flags, "limit", 20, { min: 1, max: 100 }),
    mode,
    sort,
    sortDir,
    includeContext: readBoolFlag(flags, "context"),
  });

  if (readBoolFlag(flags, "json")) {
    printJson(result.raw);
    return;
  }

  console.log(`Provider: ${result.provider}`);
  console.log("");
  await printMessages(client, result.messages);
}

async function runReadCommand(positionals: string[], flags: Record<string, string | boolean>): Promise<void> {
  const channel = positionals[0];
  if (!channel) throw new Error("Usage: slack read <channel-id|#channel-name> [--limit 20] [--after date] [--before date]");

  const auth = await getAuthForApi();
  const client = createClient(auth.userToken);
  const result = await readChannelHistory(client, channel, {
    limit: readIntFlag(flags, "limit", 20, { min: 1, max: 100 }),
    oldest: parseDateOrTimestamp(readStringFlag(flags, "after")),
    latest: parseDateOrTimestamp(readStringFlag(flags, "before")),
  });

  if (readBoolFlag(flags, "json")) {
    printJson(result.raw);
    return;
  }

  console.log(`Channel: ${result.channelId}`);
  console.log("");
  await printMessages(client, result.messages);
}

async function runThreadCommand(positionals: string[], flags: Record<string, string | boolean>): Promise<void> {
  let channel = positionals[0];
  let threadTs = positionals[1];

  if (channel && !threadTs) {
    const parsed = parseSlackUrl(channel);
    if (parsed) {
      channel = parsed.channelId;
      threadTs = parsed.threadTs ?? parsed.messageTs;
    }
  }

  if (!channel || !threadTs) {
    throw new Error("Usage: slack thread <thread-url> OR slack thread <channel-id|#channel-name> <thread_ts> [--limit 1000]");
  }

  const auth = await getAuthForApi();
  const client = createClient(auth.userToken);
  const result = await readThread(client, channel, threadTs, {
    limit: readIntFlag(flags, "limit", 1000, { min: 1, max: 5000 }),
  });
  // 0 means unlimited; callers with an output cap pass it so the newest replies survive.
  const maxChars = readIntFlag(flags, "max-chars", 0, { min: 0 });
  const total = result.totalMessages ?? "unknown";

  if (readBoolFlag(flags, "json")) {
    const raw = result.raw as { messages: unknown[]; omitted_for_size?: number };
    const keep = fitNewest(raw.messages, (kept) => JSON.stringify({ ...raw, messages: kept }, null, 2).length, maxChars);
    printJson({ ...raw, messages: keep, ...(keep.length < raw.messages.length ? { omitted_for_size: raw.messages.length - keep.length } : {}) });
    return;
  }

  const blocks = await formatMessages(client, result.messages);
  const header = `Thread: ${result.channelId} ${threadTs}`;
  const budget = maxChars > 0 ? maxChars - header.length - 300 : 0;
  const kept = fitNewest(blocks, (selected) => selected.reduce((sum, block) => sum + block.length + 1, 0), budget);
  const omittedForSize = blocks.length - kept.length;

  console.log(header);
  if (result.truncated) {
    console.log(
      `WARNING: fetched ${result.messages.length} of ${total} messages (parent plus the newest replies); raise --limit to read the rest.`,
    );
  }
  if (omittedForSize > 0) {
    console.log(
      `WARNING: omitted the ${omittedForSize} oldest replies after the parent to fit the output size limit; showing ${kept.length} of ${total} messages.`,
    );
  }
  console.log("");
  for (const block of kept) console.log(block);
}

// Keeps the first item (the thread parent) plus as many of the newest items as fit the budget.
function fitNewest<T>(items: T[], size: (selected: T[]) => number, budget: number): T[] {
  if (budget <= 0 || items.length <= 1 || size(items) <= budget) return items;
  let low = 0;
  let high = items.length - 1;
  while (low < high) {
    const newest = Math.ceil((low + high) / 2);
    if (size([items[0]!, ...items.slice(items.length - newest)]) <= budget) low = newest;
    else high = newest - 1;
  }
  return [items[0]!, ...items.slice(items.length - low)];
}

async function runChannelsCommand(positionals: string[], flags: Record<string, string | boolean>): Promise<void> {
  const auth = await getAuthForApi();
  const client = createClient(auth.userToken);
  const channels = await listChannels(client, positionals.join(" ").trim() || undefined, {
    limit: readIntFlag(flags, "limit", 50, { min: 1, max: 500 }),
  });

  if (readBoolFlag(flags, "json")) {
    printJson(channels);
    return;
  }

  for (const channel of channels) {
    console.log(`${channel.id ?? "(no-id)"}  ${channel.type.padEnd(15)}  ${channel.name ?? "(no-name)"}`);
  }
}

async function runPermalinkCommand(positionals: string[]): Promise<void> {
  let channel = positionals[0];
  let messageTs = positionals[1];

  if (channel && !messageTs) {
    const parsed = parseSlackUrl(channel);
    if (parsed) {
      channel = parsed.channelId;
      messageTs = parsed.messageTs;
    }
  }

  if (!channel || !messageTs) {
    throw new Error("Usage: slack permalink <thread-url> OR slack permalink <channel-id|#channel-name> <message_ts>");
  }

  const auth = await getAuthForApi();
  const client = createClient(auth.userToken);
  console.log(await getPermalink(client, channel, messageTs));
}

function printHelp(): void {
  console.log(`slack-cli

Usage:
  slack auth status
  slack auth login [--no-open]
  slack auth token <xoxp-token>
  slack auth logout
  slack search <query> [--limit 20] [--legacy|--rts] [--json]
  slack read <channel-id|#channel-name> [--limit 20] [--after date] [--before date] [--json]
  slack thread <thread-url>
  slack thread <channel-id|#channel-name> <thread_ts> [--limit 1000] [--json]
  slack channels [query] [--limit 50] [--json]
  slack permalink <thread-url>
  slack permalink <channel-id|#channel-name> <message_ts>

Examples:
  slack search "project gizmo after:2026-04-01" --limit 10
  slack read '#team-channel' --limit 20
  slack thread "https://workspace.slack.com/archives/C123/p1713890000123456"
  slack thread C123456 1713890000.123456

Token file:
  ${authFilePath()}

Date flags accept Slack timestamps, YYYY-MM-DD, or any date string parseable by JavaScript.`);
}

function printAuthHelp(): void {
  console.log(`slack auth

Usage:
  slack auth status
  slack auth login [--no-open]
  slack auth token <xoxp-token>
  slack auth logout

OAuth login requires:
  SLACK_CLIENT_ID
  SLACK_CLIENT_SECRET

Optional:
  SLACK_REDIRECT_URI   default: http://localhost:3119/slack/oauth/callback
  SLACK_USER_SCOPES    comma-separated user scopes`);
}

function printCommandHelp(command: string): void {
  switch (command) {
    case "auth":
      printAuthHelp();
      return;
    case "search":
      console.log("Usage: slack search <query> [--limit 20] [--legacy|--rts] [--sort score|timestamp] [--sort-dir asc|desc] [--context] [--json]");
      return;
    case "read":
      console.log("Usage: slack read <channel-id|#channel-name> [--limit 20] [--after date] [--before date] [--json]");
      return;
    case "thread":
      console.log("Usage: slack thread <thread-url> OR slack thread <channel-id|#channel-name> <thread_ts> [--limit 1000] [--json]");
      return;
    case "channels":
      console.log("Usage: slack channels [query] [--limit 50] [--json]");
      return;
    case "permalink":
      console.log("Usage: slack permalink <thread-url> OR slack permalink <channel-id|#channel-name> <message_ts>");
      return;
    default:
      printHelp();
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`error: ${message}`);
  process.exit(1);
});

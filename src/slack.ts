import { WebClient } from "@slack/web-api";
import type { PrintableMessage } from "./format";

export type SearchMode = "auto" | "rts" | "legacy";

export interface SearchOptions {
  query: string;
  limit: number;
  mode: SearchMode;
  sort: "score" | "timestamp";
  sortDir: "asc" | "desc";
  includeContext: boolean;
}

export interface SearchResult {
  provider: "assistant.search.context" | "search.messages";
  messages: PrintableMessage[];
  raw: unknown;
}

interface RealtimeSearchResponse {
  ok?: boolean;
  error?: string;
  results?: {
    messages?: Array<{
      author_name?: string;
      author_user_id?: string;
      channel_id?: string;
      channel_name?: string;
      message_ts?: string;
      content?: string;
      permalink?: string;
      context_messages?: {
        before?: Array<{ text?: string; user_id?: string; ts?: string }>;
        after?: Array<{ text?: string; user_id?: string; ts?: string }>;
      };
    }>;
    response_metadata?: {
      next_cursor?: string;
    };
  };
}

interface LegacySearchResponse {
  ok?: boolean;
  error?: string;
  messages?: {
    matches?: Array<{
      channel?: {
        id?: string;
        name?: string;
      };
      permalink?: string;
      text?: string;
      ts?: string;
      user?: string;
      username?: string;
    }>;
  };
}

interface SlackMessage {
  type?: string;
  subtype?: string;
  user?: string;
  username?: string;
  text?: string;
  ts?: string;
  thread_ts?: string;
  reply_count?: number;
}

interface ConversationListResponse {
  ok?: boolean;
  error?: string;
  channels?: Array<{
    id?: string;
    name?: string;
    is_channel?: boolean;
    is_group?: boolean;
    is_im?: boolean;
    is_mpim?: boolean;
  }>;
  response_metadata?: {
    next_cursor?: string;
  };
}

export function createClient(token: string): WebClient {
  return new WebClient(token);
}

export async function searchSlack(client: WebClient, options: SearchOptions): Promise<SearchResult> {
  if (options.mode === "legacy") {
    return searchLegacy(client, options);
  }

  if (options.mode === "rts") {
    return searchRealtime(client, options);
  }

  try {
    return await searchRealtime(client, options);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!isRealtimeFallbackError(message)) {
      throw error;
    }
    return searchLegacy(client, options);
  }
}

async function searchRealtime(client: WebClient, options: SearchOptions): Promise<SearchResult> {
  const response = await client.apiCall("assistant.search.context", {
    query: options.query,
    limit: Math.min(options.limit, 20),
    channel_types: ["public_channel", "private_channel", "mpim", "im"],
    content_types: ["messages"],
    sort: options.sort,
    sort_dir: options.sortDir,
    include_context_messages: options.includeContext,
    include_bots: true,
    highlight: true,
  }) as RealtimeSearchResponse;

  if (!response.ok) {
    throw new Error(`assistant.search.context failed: ${response.error ?? "unknown_error"}`);
  }

  const messages = response.results?.messages ?? [];
  return {
    provider: "assistant.search.context",
    raw: response,
    messages: messages.map((message) => ({
      channelId: message.channel_id,
      channelName: message.channel_name,
      ts: message.message_ts,
      userId: message.author_user_id,
      userName: message.author_name,
      text: message.content,
      permalink: message.permalink,
    })),
  };
}

async function searchLegacy(client: WebClient, options: SearchOptions): Promise<SearchResult> {
  const response = await client.search.messages({
    query: options.query,
    count: Math.min(options.limit, 100),
    sort: options.sort,
    sort_dir: options.sortDir,
    highlight: true,
  }) as LegacySearchResponse;

  if (!response.ok) {
    throw new Error(`search.messages failed: ${response.error ?? "unknown_error"}`);
  }

  const matches = response.messages?.matches ?? [];
  return {
    provider: "search.messages",
    raw: response,
    messages: matches.map((message) => ({
      channelId: message.channel?.id,
      channelName: message.channel?.name,
      ts: message.ts,
      userId: message.user,
      userName: message.username,
      text: message.text,
      permalink: message.permalink,
    })),
  };
}

function isRealtimeFallbackError(message: string): boolean {
  return [
    "missing_scope",
    "method_not_supported_for_channel_type",
    "feature_not_enabled",
    "assistant_search_context_disabled",
    "not_allowed_token_type",
    "unknown_method",
    "invalid_arguments",
  ].some((needle) => message.includes(needle));
}

export async function readChannelHistory(
  client: WebClient,
  channel: string,
  options: { limit: number; oldest?: string; latest?: string },
): Promise<{ channelId: string; messages: PrintableMessage[]; raw: unknown }> {
  const channelId = await resolveChannelId(client, channel);
  const response = await client.conversations.history({
    channel: channelId,
    limit: options.limit,
    oldest: options.oldest,
    latest: options.latest,
    inclusive: true,
  });

  const messages = ((response.messages ?? []) as SlackMessage[]).map((message) => ({
    channelId,
    ts: message.ts,
    userId: message.user,
    userName: message.username,
    text: message.text,
    threadTs: message.thread_ts,
    replyCount: message.reply_count,
  }));

  return { channelId, messages, raw: response };
}

export async function readThread(
  client: WebClient,
  channel: string,
  threadTs: string,
  options: { limit: number },
): Promise<{
  channelId: string;
  messages: PrintableMessage[];
  totalMessages: number | undefined;
  truncated: boolean;
  raw: unknown;
}> {
  const channelId = await resolveChannelId(client, channel);
  // Slack returns the parent plus the newest replies first; each cursor page walks further back.
  const byTs = new Map<string, SlackMessage>();
  let parent: SlackMessage | undefined;
  let cursor: string | undefined;
  let hasMore = false;
  let pages = 0;
  let added = 0;
  do {
    const replies = [...byTs.values()].filter((message) => message.ts !== threadTs).length;
    const response = await client.conversations.replies({
      channel: channelId,
      ts: threadTs,
      limit: Math.min(200, Math.max(1, options.limit - replies)),
      cursor,
    });
    pages++;
    const before = byTs.size;
    for (const message of (response.messages ?? []) as SlackMessage[]) {
      if (!message.ts) continue;
      if (message.ts === threadTs) parent = message;
      byTs.set(message.ts, message);
    }
    added = byTs.size - before;
    hasMore = response.has_more === true;
    cursor = response.response_metadata?.next_cursor || undefined;
  } while (
    hasMore &&
    cursor &&
    added > 0 &&
    [...byTs.values()].filter((message) => message.ts !== threadTs).length < options.limit
  );

  const sorted = [...byTs.values()].sort((a, b) => Number(a.ts) - Number(b.ts));
  const messages = sorted.map((message) => ({
    channelId,
    ts: message.ts,
    userId: message.user,
    userName: message.username,
    text: message.text,
    threadTs: message.thread_ts,
    replyCount: message.reply_count,
  }));
  const replyCount = parent?.reply_count;
  const totalMessages = replyCount === undefined ? undefined : replyCount + 1;

  return {
    channelId,
    messages,
    totalMessages,
    truncated: hasMore || (totalMessages !== undefined && messages.length < totalMessages),
    raw: { ok: true, pages, has_more: hasMore, total_messages: totalMessages, messages: sorted },
  };
}

export async function getPermalink(client: WebClient, channel: string, messageTs: string): Promise<string> {
  const channelId = await resolveChannelId(client, channel);
  const response = await client.chat.getPermalink({
    channel: channelId,
    message_ts: messageTs,
  });

  if (!response.permalink) {
    throw new Error("Slack did not return a permalink");
  }

  return response.permalink;
}

export async function listChannels(
  client: WebClient,
  query: string | undefined,
  options: { limit: number },
): Promise<Array<{ id?: string; name?: string; type: string }>> {
  const channels: Array<{ id?: string; name?: string; type: string }> = [];
  let cursor: string | undefined;

  do {
    const response = await client.conversations.list({
      types: "public_channel,private_channel,mpim,im",
      limit: 200,
      cursor,
      exclude_archived: false,
    }) as ConversationListResponse;

    if (!response.ok) {
      throw new Error(`conversations.list failed: ${response.error ?? "unknown_error"}`);
    }

    for (const channel of response.channels ?? []) {
      const name = channel.name ?? channel.id;
      if (query && !name?.toLowerCase().includes(query.toLowerCase()) && channel.id !== query) {
        continue;
      }

      channels.push({
        id: channel.id,
        name,
        type: channelType(channel),
      });

      if (channels.length >= options.limit) {
        return channels;
      }
    }

    cursor = response.response_metadata?.next_cursor || undefined;
  } while (cursor);

  return channels;
}

export async function resolveChannelId(client: WebClient, input: string): Promise<string> {
  if (/^[CDG][A-Z0-9]+$/.test(input)) return input;

  const name = input.startsWith("#") ? input.slice(1) : input;
  const matches = await listChannels(client, name, { limit: 5 });
  const exact = matches.find((channel) => channel.name === name || channel.id === input);
  if (exact?.id) return exact.id;

  if (matches.length === 1 && matches[0]?.id) return matches[0].id;

  if (matches.length > 1) {
    const choices = matches.map((channel) => `${channel.name} (${channel.id})`).join(", ");
    throw new Error(`Channel name "${input}" is ambiguous. Use an ID. Matches: ${choices}`);
  }

  throw new Error(`Could not find channel: ${input}`);
}

function channelType(channel: {
  is_channel?: boolean;
  is_group?: boolean;
  is_im?: boolean;
  is_mpim?: boolean;
}): string {
  if (channel.is_im) return "im";
  if (channel.is_mpim) return "mpim";
  if (channel.is_group) return "private_channel";
  if (channel.is_channel) return "public_channel";
  return "unknown";
}

import { WebClient } from "@slack/web-api";
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { PrintableFile, PrintableMessage } from "./format";

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

interface SlackFile {
  id?: string;
  name?: string;
  title?: string;
  mimetype?: string;
  filetype?: string;
  size?: number;
  url_private?: string;
  url_private_download?: string;
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
      files?: SlackFile[];
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
  files?: SlackFile[];
}

function mapSlackFiles(files?: SlackFile[]): PrintableFile[] | undefined {
  if (!files || files.length === 0) return undefined;
  return files.map((file) => ({
    id: file.id,
    name: file.name,
    title: file.title,
    mimetype: file.mimetype,
    filetype: file.filetype,
    size: file.size,
    urlPrivateDownload: file.url_private_download,
    urlPrivate: file.url_private,
  }));
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
      files: mapSlackFiles(message.files),
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
    files: mapSlackFiles(message.files),
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
    files: mapSlackFiles(message.files),
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

export interface DownloadedFile {
  ok: true;
  id?: string;
  name: string;
  mimetype?: string;
  filetype?: string;
  size: number;
  path: string;
  url: string;
}

function isSlackHost(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  return lower === "slack.com" || lower.endsWith(".slack.com");
}

function sanitizeFilename(name: string): string {
  const base = path.basename(name).replace(/[\0/\\:*?"<>|]/g, "_").trim();
  return base || "slack-file";
}

function extractFileIdFromUrl(url: URL): string | undefined {
  // e.g. https://files.slack.com/files-pri/T01234567-F0123ABC/download/img.jpg
  const priMatch = url.pathname.match(/\/[TEW][A-Z0-9]+-(F[A-Z0-9]+)(?:\/|$)/i);
  if (priMatch?.[1]) return priMatch[1].toUpperCase();
  // e.g. https://workspace.slack.com/files/U01234567/F0123ABC/img.jpg
  const filesMatch = url.pathname.match(/\/files\/[^/]+\/(F[A-Z0-9]+)(?:\/|$)/i);
  if (filesMatch?.[1]) return filesMatch[1].toUpperCase();
  return undefined;
}

function resolveDownloadPath(outPath: string | undefined, filename: string, fileId?: string): string {
  const safeName = sanitizeFilename(filename);
  if (outPath) {
    const resolved = path.resolve(outPath);
    if (outPath.endsWith(path.sep) || outPath.endsWith("/") || (existsSync(resolved) && statSync(resolved).isDirectory())) {
      mkdirSync(resolved, { recursive: true });
      return path.join(resolved, safeName);
    }
    mkdirSync(path.dirname(resolved), { recursive: true });
    return resolved;
  }

  const dir = path.join(tmpdir(), "slack-files");
  mkdirSync(dir, { recursive: true });
  const prefixed = fileId && !safeName.startsWith(`${fileId}-`) ? `${fileId}-${safeName}` : safeName;
  return path.join(dir, prefixed);
}

export async function downloadFile(
  client: WebClient,
  token: string,
  fileInput: string,
  outPath?: string,
): Promise<DownloadedFile> {
  const trimmed = fileInput.trim();
  if (!trimmed) {
    throw new Error("Provide a Slack file ID (e.g. F0123ABC) or Slack file URL.");
  }

  let fileId: string | undefined;
  let downloadUrl: string | undefined;
  let name: string | undefined;
  let mimetype: string | undefined;
  let filetype: string | undefined;

  if (/^F[A-Z0-9]+$/i.test(trimmed)) {
    fileId = trimmed.toUpperCase();
  } else {
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      throw new Error(`Invalid Slack file ID or URL: ${trimmed}`);
    }
    if (!isSlackHost(parsed.hostname)) {
      throw new Error(`Refusing to send Slack credentials to non-Slack host: ${parsed.hostname}`);
    }
    const extractedId = extractFileIdFromUrl(parsed);
    if (parsed.hostname.toLowerCase() === "files.slack.com") {
      downloadUrl = parsed.toString();
      fileId = extractedId;
      const urlSegment = parsed.pathname.split("/").filter(Boolean).pop();
      if (urlSegment) name = decodeURIComponent(urlSegment);
    } else if (extractedId) {
      fileId = extractedId;
    } else {
      throw new Error(`Could not extract a Slack file ID or downloadable URL from: ${trimmed}`);
    }
  }

  if (!downloadUrl && fileId) {
    const response = await client.files.info({ file: fileId });
    const file = response.file as SlackFile | undefined;
    if (!response.ok || !file) {
      throw new Error(`files.info failed for ${fileId}`);
    }
    downloadUrl = file.url_private_download ?? file.url_private;
    if (!downloadUrl) {
      throw new Error(`Slack file ${fileId} has no downloadable private URL.`);
    }
    name = file.name ?? file.title ?? fileId;
    mimetype = file.mimetype;
    filetype = file.filetype;
  }

  if (!downloadUrl) {
    throw new Error(`Could not resolve download URL for: ${trimmed}`);
  }

  let currentUrl = downloadUrl;
  let res: Response | undefined;
  for (let hop = 0; hop < 5; hop++) {
    const target = new URL(currentUrl);
    const headers: Record<string, string> = {};
    if (isSlackHost(target.hostname)) {
      headers["Authorization"] = `Bearer ${token}`;
    }

    res = await fetch(currentUrl, { headers, redirect: "manual" });
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) break;
      const nextUrl = new URL(location, currentUrl);
      if (
        isSlackHost(nextUrl.hostname) &&
        (nextUrl.searchParams.has("redir") || nextUrl.pathname === "/signin" || nextUrl.pathname === "/ssb/redirect")
      ) {
        throw new Error(
          "Slack redirected to a login page. Check that your token is valid and has the files:read scope.",
        );
      }
      currentUrl = nextUrl.toString();
      continue;
    }
    break;
  }

  if (!res || !res.ok) {
    throw new Error(`Failed to download Slack file (HTTP ${res?.status ?? "unknown"} ${res?.statusText ?? ""})`.trim());
  }

  const contentType = res.headers.get("content-type")?.split(";")[0]?.trim();
  const isExpectedHtml =
    mimetype === "text/html" ||
    filetype === "html" ||
    (name !== undefined && /\.(html?|xhtml)$/i.test(name));

  const bytes = new Uint8Array(await res.arrayBuffer());
  if (contentType === "text/html" && !isExpectedHtml) {
    const preview = new TextDecoder().decode(bytes.subarray(0, 512)).toLowerCase();
    if (preview.includes("slack") && (preview.includes("sign in") || preview.includes("login") || preview.includes("redir"))) {
      throw new Error(
        "Slack returned an HTML login page instead of the file. Check that your token has the files:read scope.",
      );
    }
  }

  const resolvedMimeType = mimetype || contentType || undefined;
  const resolvedName = name || fileId || "slack-file";
  const destPath = resolveDownloadPath(outPath, resolvedName, fileId);
  writeFileSync(destPath, bytes);

  return {
    ok: true,
    id: fileId,
    name: resolvedName,
    mimetype: resolvedMimeType,
    filetype,
    size: bytes.byteLength,
    path: destPath,
    url: downloadUrl,
  };
}

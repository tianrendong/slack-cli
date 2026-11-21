import type { WebClient } from "@slack/web-api";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const USER_CACHE_TTL_MS =
  Number.parseInt(process.env["SLACK_USER_CACHE_TTL_DAYS"] ?? "30", 10) * 24 * 60 * 60 * 1000;
const USER_CACHE_PATH = path.join(homedir(), ".cache", "pi", "slack-users.json");

interface UserCacheEntry {
  id: string;
  name: string;
  updatedAt: number;
}

interface UserCache {
  ttlMs: number;
  entries: Record<string, UserCacheEntry>;
}

function readUserCache(): UserCache {
  try {
    if (!existsSync(USER_CACHE_PATH)) return { ttlMs: USER_CACHE_TTL_MS, entries: {} };
    const data = JSON.parse(readFileSync(USER_CACHE_PATH, "utf8")) as Partial<UserCache>;
    if (!data.entries || typeof data.entries !== "object") return { ttlMs: USER_CACHE_TTL_MS, entries: {} };
    return { ttlMs: data.ttlMs || USER_CACHE_TTL_MS, entries: data.entries };
  } catch {
    return { ttlMs: USER_CACHE_TTL_MS, entries: {} };
  }
}

function writeUserCache(cache: UserCache): void {
  try {
    mkdirSync(path.dirname(USER_CACHE_PATH), { recursive: true });
    writeFileSync(USER_CACHE_PATH, JSON.stringify(cache, null, 2));
  } catch {
    // User-name caching is best-effort; never fail Slack output formatting for it.
  }
}

function cachedUserName(cache: UserCache, userId: string): string | undefined {
  const entry = cache.entries[userId];
  if (!entry) return undefined;
  if (Date.now() - entry.updatedAt > cache.ttlMs) return undefined;
  return entry.name;
}

function setCachedUserName(cache: UserCache, userId: string, name: string): boolean {
  if (!userId || !name || name === userId) return false;
  const existing = cache.entries[userId];
  if (existing?.name === name && Date.now() - existing.updatedAt <= cache.ttlMs) return false;
  cache.entries[userId] = { id: userId, name, updatedAt: Date.now() };
  return true;
}

export interface PrintableFile {
  id?: string;
  name?: string;
  title?: string;
  mimetype?: string;
  filetype?: string;
  size?: number;
  urlPrivateDownload?: string;
  urlPrivate?: string;
}

export interface PrintableMessage {
  channelId?: string;
  channelName?: string;
  ts?: string;
  userId?: string;
  userName?: string;
  text?: string;
  permalink?: string;
  threadTs?: string;
  replyCount?: number;
  files?: PrintableFile[];
}

export function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

export async function printMessages(client: WebClient, messages: PrintableMessage[]): Promise<void> {
  for (const block of await formatMessages(client, messages)) console.log(block);
}

export async function formatMessages(client: WebClient, messages: PrintableMessage[]): Promise<string[]> {
  const userCache = readUserCache();
  const userNames = new Map<string, string>();
  let userCacheChanged = false;

  for (const message of messages) {
    if (!message.userId) continue;
    if (message.userName) {
      userNames.set(message.userId, message.userName);
      userCacheChanged = setCachedUserName(userCache, message.userId, message.userName) || userCacheChanged;
      continue;
    }
    if (userNames.has(message.userId)) continue;
    const cachedName = cachedUserName(userCache, message.userId);
    if (cachedName) {
      userNames.set(message.userId, cachedName);
      continue;
    }
    const resolvedName = await resolveUserName(client, message.userId);
    userNames.set(message.userId, resolvedName);
    userCacheChanged = setCachedUserName(userCache, message.userId, resolvedName) || userCacheChanged;
  }

  if (userCacheChanged) writeUserCache(userCache);

  return messages.map((message) => {
    const channel = formatChannel(message);
    const ts = message.ts ? formatSlackTs(message.ts) : "";
    const user = message.userName ?? (message.userId ? userNames.get(message.userId) ?? message.userId : "unknown");
    const text = normalizeSlackText(message.text ?? "");
    const lines = [`${channel} ${ts} ${user}`, indent(text || "(no text)")];
    if (message.ts) lines.push(`  ts: ${message.ts}`);
    if (message.replyCount && message.replyCount > 0) lines.push(`  replies: ${message.replyCount}`);
    if (message.files && message.files.length > 0) {
      lines.push("  files:");
      for (const file of message.files) {
        const label = file.name || file.title || "(unnamed)";
        const meta = [
          file.mimetype || file.filetype,
          file.size !== undefined ? formatBytes(file.size) : undefined,
        ].filter(Boolean).join(", ");
        const idPrefix = file.id ? `${file.id}  ` : "";
        lines.push(`    - ${idPrefix}${label}${meta ? ` (${meta})` : ""}`);
      }
    }
    if (message.permalink) lines.push(`  ${message.permalink}`);
    if (message.threadTs && message.threadTs !== message.ts) lines.push(`  thread: ${message.threadTs}`);
    return `${lines.join("\n")}\n`;
  });
}

function formatChannel(message: PrintableMessage): string {
  if (message.channelName) return `#${message.channelName}`;
  if (message.channelId) return message.channelId;
  return "(unknown-channel)";
}

export function formatSlackTs(ts: string): string {
  const seconds = Number.parseFloat(ts);
  if (!Number.isFinite(seconds)) return ts;
  return new Date(seconds * 1000).toLocaleString();
}

export function parseDateOrTimestamp(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (/^\d+(\.\d+)?$/.test(value)) return value;

  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Could not parse date/timestamp: ${value}`);
  }

  return String(Math.floor(parsed / 1000));
}

export function normalizeSlackText(text: string): string {
  return text
    .replace(/\uE000/g, "")
    .replace(/\uE001/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return `${bytes} B`;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function indent(text: string): string {
  return text
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n");
}

async function resolveUserName(client: WebClient, userId: string): Promise<string> {
  try {
    const response = await client.users.info({ user: userId });
    const user = response.user;
    if (!user) return userId;

    const profile = "profile" in user ? user.profile : undefined;
    const displayName = profile && "display_name" in profile ? profile.display_name : undefined;
    const realName = profile && "real_name" in profile ? profile.real_name : undefined;
    const name = "name" in user ? user.name : undefined;

    return displayName || realName || name || userId;
  } catch {
    return userId;
  }
}

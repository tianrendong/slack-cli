export interface ParsedSlackUrl {
  channelId: string;
  messageTs: string;
  threadTs?: string;
}

export function parseSlackUrl(input: string): ParsedSlackUrl | undefined {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return undefined;
  }

  if (!url.hostname.endsWith("slack.com")) {
    return undefined;
  }

  const parts = url.pathname.split("/").filter(Boolean);
  const archivesIndex = parts.indexOf("archives");
  if (archivesIndex === -1) {
    return undefined;
  }

  const channelId = parts[archivesIndex + 1];
  const messagePart = parts[archivesIndex + 2];
  if (!channelId || !messagePart?.startsWith("p")) {
    return undefined;
  }

  const messageTs = parseSlackUrlMessageTs(messagePart);
  if (!messageTs) {
    return undefined;
  }

  return {
    channelId,
    messageTs,
    threadTs: url.searchParams.get("thread_ts") ?? undefined,
  };
}

function parseSlackUrlMessageTs(messagePart: string): string | undefined {
  const digits = messagePart.slice(1);
  if (!/^\d{16}$/.test(digits)) {
    return undefined;
  }

  return `${digits.slice(0, 10)}.${digits.slice(10)}`;
}

import type { AgentToolResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { execFile } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const DEFAULT_TIMEOUT_MS = 90_000;

const CHANNEL_CACHE_TTL_MS =
	parseInt(process.env["SLACK_CHANNEL_CACHE_TTL_HOURS"] ?? "24", 10) * 3_600_000;
const CHANNEL_CACHE_PATH = path.join(homedir(), ".cache", "pi", "slack-channels.json");

type ChannelCacheEntry = { id: string; name: string };
interface ChannelCache { cachedAt: number; ttlMs: number; entries: ChannelCacheEntry[]; }

function readChannelCache(): ChannelCache | null {
	try {
		const raw = readFileSync(CHANNEL_CACHE_PATH, "utf8");
		const data = JSON.parse(raw) as ChannelCache;
		if (Date.now() - data.cachedAt > data.ttlMs) return null;
		return data;
	} catch {
		return null;
	}
}

function writeChannelCache(entries: ChannelCacheEntry[]): void {
	try {
		mkdirSync(path.dirname(CHANNEL_CACHE_PATH), { recursive: true });
		writeFileSync(CHANNEL_CACHE_PATH, JSON.stringify({ cachedAt: Date.now(), ttlMs: CHANNEL_CACHE_TTL_MS, entries }, null, 2));
	} catch (err) {
		console.warn("[slack-cli] Failed to write channel cache:", err);
	}
}

function parseChannelEntries(json: unknown): ChannelCacheEntry[] {
	try {
		let arr: unknown[];
		if (Array.isArray(json)) {
			arr = json;
		} else if (json && typeof json === "object" && Array.isArray((json as Record<string, unknown>)["channels"])) {
			arr = (json as Record<string, unknown>)["channels"] as unknown[];
		} else {
			return [];
		}
		const entries = arr
			.map((item) => {
				if (!item || typeof item !== "object") return null;
				const { id, name } = item as Record<string, unknown>;
				if (typeof id !== "string" || typeof name !== "string") return null;
				return { id, name };
			})
			.filter((e): e is ChannelCacheEntry => e !== null);
		if (entries.length === 0) console.warn("[slack-cli] parseChannelEntries: yielded 0 entries from JSON");
		return entries;
	} catch {
		return [];
	}
}
const MAX_OUTPUT_CHARS = 80_000;
/** Cap on what scripts receive; they filter output themselves instead of handing it to the model. */
const SCRIPT_OUTPUT_MAX_CHARS = 1_000_000;

/** pi assigns nested calls (e.g. from codemode scripts) the id `<parent id>/<n>`. */
function isProgrammaticCall(toolCallId: string): boolean {
	return toolCallId.includes("/");
}

/**
 * What scripts receive: parsed JSON for format=json, full stdout for format=text. Only the
 * model-facing `content` is trimmed to MAX_OUTPUT_CHARS.
 */
const SLACK_OUTPUT_SCHEMA = Type.Union([
	Type.String(),
	Type.Record(Type.String(), Type.Unknown()),
	Type.Array(Type.Unknown()),
]);

type SlackFormat = "text" | "json";
type SlackSort = "score" | "timestamp";

/** JSON-serializable value accepted as `structuredContent`. */
type JsonValue = NonNullable<AgentToolResult<unknown>["structuredContent"]>;

interface SlackCommandResult {
	command: string[];
	stdout: string;
	stderr: string;
	parsedJson?: JsonValue;
}

function trimOutput(value: string): string {
	if (value.length <= MAX_OUTPUT_CHARS) return value;
	return `${value.slice(0, MAX_OUTPUT_CHARS)}\n\n[truncated ${value.length - MAX_OUTPUT_CHARS} chars]`;
}

function formatOutput(result: SlackCommandResult): string {
	const stdout = result.stdout.trim();
	const stderr = result.stderr.trim();
	const parts: string[] = [];
	if (stdout) parts.push(stdout);
	if (stderr) parts.push(`stderr:\n${stderr}`);
	return trimOutput(parts.join("\n\n") || "Slack command completed with no output.");
}

function maybeParseJson(stdout: string, format: SlackFormat): JsonValue | undefined {
	if (format !== "json") return undefined;
	try {
		return JSON.parse(stdout);
	} catch {
		return undefined;
	}
}

function pushOptionalFlag(args: string[], name: string, value: string | number | boolean | undefined): void {
	if (value === undefined || value === false || value === "") return;
	if (value === true) {
		args.push(`--${name}`);
		return;
	}
	args.push(`--${name}`, String(value));
}

function slackExecutable(): string {
	const candidates = [
		process.env["SLACK_CLI_PATH"],
		`${homedir()}/.pi/agent/bin/slack`,
		`${homedir()}/.bun/bin/slack`,
		"/opt/homebrew/bin/slack",
		"/usr/local/bin/slack",
	].filter(Boolean) as string[];

	for (const candidate of candidates) {
		if (existsSync(candidate)) return candidate;
	}

	return "slack";
}

async function runSlack(args: string[], signal: AbortSignal | undefined, format: SlackFormat = "text"): Promise<SlackCommandResult> {
	const fullArgs = [...args];
	if (format === "json") fullArgs.push("--json");
	const executable = slackExecutable();

	try {
		const { stdout, stderr } = await execFileAsync(executable, fullArgs, {
			timeout: DEFAULT_TIMEOUT_MS,
			maxBuffer: 10 * 1024 * 1024,
			signal,
		});
		return {
			command: [executable, ...fullArgs],
			stdout,
			stderr,
			parsedJson: maybeParseJson(stdout, format),
		};
	} catch (err: unknown) {
		const error = err as NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: number | string };
		const stdout = typeof error.stdout === "string" ? error.stdout : "";
		const stderr = typeof error.stderr === "string" ? error.stderr : "";
		const message = error.message || String(err);
		throw new Error(trimOutput([
			`${executable} ${fullArgs.join(" ")} failed`,
			message,
			stdout && `stdout:\n${stdout}`,
			stderr && `stderr:\n${stderr}`,
		].filter(Boolean).join("\n\n")));
	}
}

function toolResponse(result: SlackCommandResult) {
	return {
		content: [{ type: "text" as const, text: formatOutput(result) }],
		structuredContent: result.parsedJson ?? result.stdout.slice(0, SCRIPT_OUTPUT_MAX_CHARS),
		details: result,
	};
}

const INLINE_IMAGE_MIME_TYPES = new Set([
	"image/jpeg",
	"image/png",
	"image/gif",
	"image/webp",
]);
const MAX_INLINE_IMAGE_BYTES = 4 * 1024 * 1024;

interface DownloadedFileResult {
	ok: boolean;
	id?: string;
	name: string;
	mimetype?: string;
	filetype?: string;
	size: number;
	path: string;
	url: string;
}

const FORMAT_PARAM = Type.Optional(Type.Union([
	Type.Literal("text"),
	Type.Literal("json"),
], { description: "Default text; json for raw Slack API fields." }));

export default function slackCliExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: "slack_thread",
		label: "Slack Thread",
		description: "Read a Slack thread by URL, or by channel + threadTs.",
		promptSnippet: "Read a Slack thread",
		promptGuidelines: [
			"Use slack_thread (not web fetch) for Slack URLs; slack_search to find Slack context; slack_read for surrounding channel history; slack_download to download attached files or images.",
		],
		outputSchema: SLACK_OUTPUT_SCHEMA,
		parameters: Type.Object({
			url: Type.Optional(Type.String()),
			channel: Type.Optional(Type.String({ description: "ID or #name" })),
			threadTs: Type.Optional(Type.String()),
			limit: Type.Optional(Type.Number({ maximum: 5000, description: "Max replies (default 1000); keeps parent + newest." })),
			format: FORMAT_PARAM,
		}),
		async execute(toolCallId, params, signal) {
			const format = (params.format ?? "text") as SlackFormat;
			const args = ["thread"];
			if (params.url) {
				args.push(params.url);
			} else if (params.channel && params.threadTs) {
				args.push(params.channel, params.threadTs);
			} else {
				throw new Error("Provide either url, or both channel and threadTs.");
			}
			pushOptionalFlag(args, "limit", params.limit);
			// Stay under the output cap so the CLI drops the oldest replies instead of a trim cutting the newest.
			const maxChars = isProgrammaticCall(toolCallId) ? SCRIPT_OUTPUT_MAX_CHARS : MAX_OUTPUT_CHARS;
			pushOptionalFlag(args, "max-chars", maxChars - 2_000);
			return toolResponse(await runSlack(args, signal, format));
		},
	});

	pi.registerTool({
		name: "slack_read",
		label: "Slack Read",
		description: "Read recent messages in a Slack channel.",
		promptSnippet: "Read Slack channel history",
		outputSchema: SLACK_OUTPUT_SCHEMA,
		parameters: Type.Object({
			channel: Type.String({ description: "ID or #name" }),
			limit: Type.Optional(Type.Number({ maximum: 100 })),
			after: Type.Optional(Type.String({ description: "YYYY-MM-DD or Slack ts" })),
			before: Type.Optional(Type.String({ description: "YYYY-MM-DD or Slack ts" })),
			format: FORMAT_PARAM,
		}),
		async execute(_toolCallId, params, signal) {
			const format = (params.format ?? "text") as SlackFormat;
			const args = ["read", params.channel];
			pushOptionalFlag(args, "limit", params.limit);
			pushOptionalFlag(args, "after", params.after);
			pushOptionalFlag(args, "before", params.before);
			return toolResponse(await runSlack(args, signal, format));
		},
	});

	pi.registerTool({
		name: "slack_search",
		label: "Slack Search",
		description: "Search Slack messages.",
		promptSnippet: "Search Slack",
		outputSchema: SLACK_OUTPUT_SCHEMA,
		parameters: Type.Object({
			query: Type.String({ description: "Slack syntax, e.g. in:#chan after:YYYY-MM-DD" }),
			limit: Type.Optional(Type.Number({ maximum: 100 })),
			sort: Type.Optional(Type.Union([Type.Literal("score"), Type.Literal("timestamp")], { description: "timestamp = newest first" })),
			context: Type.Optional(Type.Boolean({ description: "Include surrounding messages" })),
			format: FORMAT_PARAM,
		}),
		async execute(_toolCallId, params, signal) {
			const format = (params.format ?? "text") as SlackFormat;
			const args = ["search", params.query];
			pushOptionalFlag(args, "limit", params.limit);
			pushOptionalFlag(args, "sort", params.sort as SlackSort | undefined);
			pushOptionalFlag(args, "context", params.context);
			return toolResponse(await runSlack(args, signal, format));
		},
	});

	pi.registerTool({
		name: "slack_channels",
		label: "Slack Channels",
		description: "List/search Slack channels (cached 24h).",
		promptSnippet: "List Slack channels",
		outputSchema: SLACK_OUTPUT_SCHEMA,
		parameters: Type.Object({
			query: Type.Optional(Type.String({ description: "Name substring" })),
			limit: Type.Optional(Type.Number({ maximum: 500 })),
			force: Type.Optional(Type.Boolean({ description: "Bypass cache" })),
			format: FORMAT_PARAM,
		}),
		async execute(_toolCallId, params, signal) {
			const format = (params.format ?? "text") as SlackFormat;

			// Try cache first (unless force=true)
			if (!params.force) {
				const cached = readChannelCache();
				if (cached) {
					let entries = cached.entries;
					if (params.query) {
						const q = params.query.toLowerCase();
						entries = entries.filter(e => e.name.toLowerCase().includes(q));
					}
					if (params.limit) entries = entries.slice(0, params.limit);
					const text = format === "json"
						? JSON.stringify(entries, null, 2)
						: entries.map(e => `${e.name}  (${e.id})`).join("\n") || "No matching channels.";
					return {
						content: [{ type: "text" as const, text: `[cache] ${text}` }],
						structuredContent: format === "json" ? entries : text,
						details: undefined,
					};
				}
			}

			// Fetch fresh — always use --json internally for caching
			const args = ["channels"];
			pushOptionalFlag(args, "limit", params.limit);
			const result = await runSlack(args, signal, "json");
			const entries = parseChannelEntries(result.parsedJson);
			if (entries.length > 0) writeChannelCache(entries);

			// Apply query filter
			let filtered = entries;
			if (params.query) {
				const q = params.query.toLowerCase();
				filtered = entries.filter(e => e.name.toLowerCase().includes(q));
			}

			if (entries.length === 0) {
				// Parsing failed, fall back to raw output
				return toolResponse(result);
			}

			const text = format === "json"
				? JSON.stringify(filtered, null, 2)
				: filtered.map(e => `${e.name}  (${e.id})`).join("\n") || "No matching channels.";
			return {
				content: [{ type: "text" as const, text: trimOutput(text) }],
				structuredContent: format === "json" ? filtered : text,
				details: undefined,
			};
		},
	});

	pi.registerTool({
		name: "slack_permalink",
		label: "Slack Permalink",
		description: "Get a Slack permalink from a URL or channel + messageTs.",
		promptSnippet: "Resolve Slack permalinks",
		outputSchema: SLACK_OUTPUT_SCHEMA,
		parameters: Type.Object({
			url: Type.Optional(Type.String()),
			channel: Type.Optional(Type.String({ description: "ID or #name" })),
			messageTs: Type.Optional(Type.String()),
		}),
		async execute(_toolCallId, params, signal) {
			const args = ["permalink"];
			if (params.url) {
				args.push(params.url);
			} else if (params.channel && params.messageTs) {
				args.push(params.channel, params.messageTs);
			} else {
				throw new Error("Provide either url, or both channel and messageTs.");
			}
			return toolResponse(await runSlack(args, signal));
		},
	});

	pi.registerTool({
		name: "slack_download",
		label: "Slack Download",
		description: "Download a file or image attached to a Slack message by file ID (e.g. F0123ABC) or Slack file URL. Saves to disk and attaches images directly so you can inspect them.",
		promptSnippet: "Download Slack files and images",
		outputSchema: SLACK_OUTPUT_SCHEMA,
		parameters: Type.Object({
			file: Type.String({ description: "Slack file ID (e.g. F0123ABC) or files.slack.com URL" }),
			out: Type.Optional(Type.String({ description: "Destination file or directory path (default: temp dir)" })),
		}),
		async execute(_toolCallId, params, signal) {
			const args = ["download", params.file];
			pushOptionalFlag(args, "out", params.out);
			const result = await runSlack(args, signal, "json");
			const downloaded = result.parsedJson as DownloadedFileResult | undefined;
			if (!downloaded || typeof downloaded !== "object" || typeof downloaded.path !== "string") {
				return toolResponse(result);
			}

			const summaryLines = [
				`Saved: ${downloaded.path}`,
				`File: ${downloaded.id ? `${downloaded.id} ` : ""}${downloaded.name} (${downloaded.mimetype ?? "unknown"}, ${downloaded.size} bytes)`,
			];
			const content: Array<
				| { type: "text"; text: string }
				| { type: "image"; data: string; mimeType: string }
			> = [{ type: "text", text: summaryLines.join("\n") }];

			if (downloaded.mimetype && INLINE_IMAGE_MIME_TYPES.has(downloaded.mimetype)) {
				if (downloaded.size <= MAX_INLINE_IMAGE_BYTES) {
					const data = readFileSync(downloaded.path).toString("base64");
					content.push({ type: "image", data, mimeType: downloaded.mimetype });
				} else {
					content[0]!.text += `\nNote: image exceeds 4 MB; use the read tool on ${downloaded.path} to view a resized copy.`;
				}
			}

			return {
				content,
				structuredContent: downloaded as unknown as JsonValue,
				details: result,
			};
		},
	});

	pi.registerTool({
		name: "slack_auth_status",
		label: "Slack Auth Status",
		description: "Check Slack CLI auth.",
		promptSnippet: "Check Slack CLI auth",
		outputSchema: SLACK_OUTPUT_SCHEMA,
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, signal) {
			return toolResponse(await runSlack(["auth", "status"], signal));
		},
	});

}

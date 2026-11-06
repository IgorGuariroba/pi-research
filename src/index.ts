import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { formatBatch, runBatch, type BatchJob } from "./batch.ts";
import { capFor, RESEARCH_PROMPT, RESEARCH_RULES, RESEARCH_TOOLS, ReadRangeGuard, truncateUtf8 } from "./policy.ts";

const Job = Type.Object({
	kind: Type.Union([Type.Literal("read"), Type.Literal("search"), Type.Literal("files")]),
	path: Type.Optional(Type.String({ description: "Path relative to cwd, or an explicit absolute path" })),
	pattern: Type.Optional(Type.String({ description: "Regex for search; optional filename glob for files" })),
	glob: Type.Optional(Type.String({ description: "Optional file glob for search" })),
	offset: Type.Optional(Type.Integer({ minimum: 1 })),
	limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 5000 })),
	context: Type.Optional(Type.Integer({ minimum: 0, maximum: 8 })),
});

/**
 * Opt-in read-only research profile: `pi --research` or `/research on`.
 * While on: answer-focused system prompt, tools read/grep/find/ls/research_batch, whole-file
 * reads, repeated-read rejection and capped search output. Off restores the previous tools.
 */
export default function research(pi: ExtensionAPI) {
	let enabled = false;
	let previousTools: string[] | undefined;
	const guard = new ReadRangeGuard();

	const enable = () => {
		if (enabled) return;
		enabled = true;
		previousTools = pi.getActiveTools();
		pi.setActiveTools([...RESEARCH_TOOLS]);
	};
	const disable = () => {
		if (!enabled) return;
		enabled = false;
		if (previousTools) pi.setActiveTools(previousTools);
		previousTools = undefined;
	};

	pi.registerFlag("research", {
		description: "Start in the read-only research profile (answer-focused prompt, bounded batched reads)",
		type: "boolean",
		default: false,
	});

	pi.on("session_start", () => {
		if (pi.getFlag("research")) enable();
	});

	pi.registerCommand("research", {
		description: "Read-only research profile: on | off | status",
		handler: async (args, ctx) => {
			const action = args.trim();
			if (action === "on") enable();
			else if (action === "off") disable();
			if (ctx.hasUI) ctx.ui.notify(`Research profile: ${enabled ? "on" : "off"}`, "info");
		},
	});

	pi.on("agent_start", () => guard.clear());

	pi.on("before_agent_start", (event) => {
		if (!enabled) {
			delete event.systemPromptOptions.sections.research_rules;
			return;
		}
		event.systemPromptOptions.customPrompt = RESEARCH_PROMPT;
		event.systemPromptOptions.sections.research_rules = RESEARCH_RULES;
		// The measured profile ran without skills: their catalog (often >10 KB) is for tasks outside
		// read-only research. Project context files (AGENTS.md) stay: they carry repository rules.
		if (Array.isArray(event.systemPromptOptions.skills)) event.systemPromptOptions.skills.length = 0;
	});

	pi.on("tool_call", (event) => {
		if (!enabled || event.toolName !== "read") return;
		const verdict = guard.check(event.input as { path: string; offset?: number; limit?: number });
		if (verdict.block) return { block: true, reason: verdict.reason };
	});

	pi.on("tool_result", (event) => {
		if (!enabled) return;
		const cap = capFor(event.toolName);
		if (cap === undefined) return;
		const text = event.content.map((block) => (block.type === "text" ? block.text : "")).join("\n");
		const cut = truncateUtf8(text, cap);
		if (!cut.truncated) return;
		return {
			content: [
				{
					type: "text",
					text: `${cut.text}\n[Truncated ${cut.totalBytes} bytes to ${cap}. Narrow the pattern or path.]`,
				},
			],
		};
	});

	pi.registerTool({
		name: "research_batch",
		label: "Research batch",
		defaultActive: false,
		description:
			"Run 1–8 independent repository reads, regex searches or filename searches concurrently (max 4 workers). Reads return whole files by default (up to 2000 lines / 50 KB per job); search/file output is capped at 8000 bytes per job, with the full output saved privately and its path disclosed. Read-only; no shell.",
		promptSnippet: "Batch independent repository reads and searches with bounded output",
		parameters: Type.Object({ jobs: Type.Array(Job, { minItems: 1, maxItems: 8 }) }),
		annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
		reachesTools: () => ["read"],
		async execute(_id, params, signal, _onUpdate, ctx) {
			const started = performance.now();
			const jobs = params.jobs as BatchJob[];
			const results = await runBatch(jobs, {
				signal,
				read: async (args) => {
					const result = await ctx.executeTool("read", args, { signal });
					return {
						isError: Boolean(result.isError),
						text: result.content
							.map((block) => (block.type === "text" ? block.text : "[Non-text result: use native read for this file]"))
							.join("\n"),
					};
				},
				exec: (command, args) =>
					pi.exec(command, args, { cwd: ctx.cwd, signal, timeout: 10_000, maxBuffer: 1024 * 1024 }),
			});
			return {
				content: [{ type: "text", text: formatBatch(jobs, results) }],
				details: {
					elapsedMs: performance.now() - started,
					jobs: results.map(({ text, ...rest }) => ({ ...rest, returnedBytes: Buffer.byteLength(text) })),
				},
				isError: results.every((result) => result.error),
			};
		},
	});
}

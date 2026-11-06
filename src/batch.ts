import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BATCH_READ_LINES, BATCH_READ_MAX_BYTES, SEARCH_MAX_BYTES, truncateUtf8 } from "./policy.ts";

export interface BatchJob {
	kind: "read" | "search" | "files";
	path?: string;
	pattern?: string;
	glob?: string;
	offset?: number;
	limit?: number;
	context?: number;
}

export interface BatchDeps {
	/** Run Pi's native `read` (so read guards and permissions still apply). */
	read(args: { path: string; offset: number; limit: number }): Promise<{ text: string; isError: boolean }>;
	/** Run a command (ripgrep) in the working directory. */
	exec(
		command: string,
		args: string[],
	): Promise<{ stdout: string; stderr: string; code: number; killed?: boolean; truncated?: boolean }>;
	signal?: AbortSignal;
	/** Where full output is saved when a job is truncated. Defaults to the OS temp dir. */
	spillDir?: string;
}

export interface BatchJobResult {
	kind: BatchJob["kind"];
	path: string;
	text: string;
	error: boolean;
	truncated: boolean;
	fullOutputPath?: string;
}

/** Never searched, whatever the pattern: dependencies, VCS data and common credential stores. */
export const EXCLUDED_GLOBS = [
	"!.git/**",
	"!vendor/**",
	"!node_modules/**",
	"!storage/**",
	"!.env",
	"!.env.*",
	"!.aws/**",
	"!.ssh/**",
];

export const MAX_WORKERS = 4;

export function ripgrepArgs(job: BatchJob): string[] {
	const path = (job.path ?? ".").replace(/^@/, "");
	const args =
		job.kind === "files"
			? ["--files", "--color=never"]
			: ["--line-number", "--with-filename", "--color=never", "--max-count=60", "--max-columns=500", "--max-columns-preview"];
	for (const glob of EXCLUDED_GLOBS) args.push("--glob", glob);
	if (job.kind === "files") {
		if (job.pattern) args.push("--glob", job.pattern);
	} else {
		if (!job.pattern) throw new Error("search requires pattern");
		if (job.glob) args.push("--glob", job.glob);
		args.push("--context", String(job.context ?? 1), "--regexp", job.pattern);
	}
	args.push("--", path);
	return args;
}

async function runJob(job: BatchJob, deps: BatchDeps): Promise<BatchJobResult> {
	const path = (job.path ?? ".").replace(/^@/, "");
	let text = "";
	let error = false;
	try {
		deps.signal?.throwIfAborted();
		if (job.kind === "read") {
			if (!job.path) throw new Error("read requires path");
			const result = await deps.read({ path, offset: job.offset ?? 1, limit: job.limit ?? BATCH_READ_LINES });
			text = result.text;
			error = result.isError;
		} else {
			const result = await deps.exec("rg", ripgrepArgs(job));
			error = result.code > 1 || Boolean(result.killed) || Boolean(result.truncated);
			text = result.stdout || (result.code === 1 ? "[No matches]" : "");
			if (result.stderr) text += `\n[stderr]\n${result.stderr}`;
			if (result.killed || result.truncated) {
				text += "\n[Process stopped: deadline or capture limit. Narrow the search; captured text may be incomplete.]";
			}
		}
	} catch (err) {
		error = true;
		text = `Error: ${err instanceof Error ? err.message : String(err)}`;
	}

	const cap = job.kind === "read" ? BATCH_READ_MAX_BYTES : SEARCH_MAX_BYTES;
	const cut = truncateUtf8(text, cap);
	if (!cut.truncated) return { kind: job.kind, path, text, error, truncated: false };

	const dir = await mkdtemp(join(deps.spillDir ?? tmpdir(), "pi-research-"));
	const fullOutputPath = join(dir, "output.txt");
	await writeFile(fullOutputPath, text, { mode: 0o600 });
	return {
		kind: job.kind,
		path,
		error,
		truncated: true,
		fullOutputPath,
		text: `${cut.text}\n[Truncated ${cut.totalBytes} bytes to <=${cap} bytes. Full captured output: ${fullOutputPath}. Read the full path or narrower source ranges.]`,
	};
}

/** Run up to 8 independent jobs with at most MAX_WORKERS in flight; results keep job order. */
export async function runBatch(jobs: BatchJob[], deps: BatchDeps): Promise<BatchJobResult[]> {
	const results: BatchJobResult[] = new Array(jobs.length);
	let next = 0;
	async function worker() {
		while (next < jobs.length) {
			const index = next++;
			results[index] = await runJob(jobs[index]!, deps);
		}
	}
	await Promise.all(Array.from({ length: Math.min(MAX_WORKERS, jobs.length) }, worker));
	return results;
}

export function formatBatch(jobs: BatchJob[], results: BatchJobResult[]): string {
	return results
		.map((result, index) => {
			const job = jobs[index]!;
			const start = job.offset ?? 1;
			const range = job.kind === "read" ? ` lines ${start}..${start + (job.limit ?? BATCH_READ_LINES) - 1} (requested)` : "";
			return `=== ${index + 1}. ${result.kind} ${result.path}${range}${result.error ? " [ERROR]" : ""} ===\n${result.text}`;
		})
		.join("\n\n");
}

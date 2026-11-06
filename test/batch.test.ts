import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatBatch, ripgrepArgs, runBatch, type BatchDeps } from "../src/batch.ts";

async function fixture() {
	const dir = await mkdtemp(join(tmpdir(), "pi-research-test-"));
	await writeFile(join(dir, "a.php"), "alpha\nneedle\nomega\n");
	await writeFile(join(dir, ".env"), "needle secret-value\n");
	await mkdir(join(dir, "many"));
	for (let i = 0; i < 300; i++) await writeFile(join(dir, "many", `controller-with-a-long-name-${i}.php`), "x\n");
	const deps: BatchDeps = {
		spillDir: dir,
		read: async ({ path, offset, limit }) => {
			try {
				const text = await readFile(join(dir, path), "utf8");
				return { isError: false, text: text.split("\n").slice(offset - 1, offset - 1 + limit).join("\n") };
			} catch {
				return { isError: true, text: "ENOENT" };
			}
		},
		exec: (command, args) =>
			new Promise((resolve) => {
				execFile(command, args, { cwd: dir, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
					const code = err && typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : 0;
					resolve({ stdout, stderr, code });
				});
			}),
	};
	return { dir, deps, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

test("mixed batch keeps job order and reads whole files by default", async () => {
	const { deps, cleanup } = await fixture();
	try {
		const jobs = [
			{ kind: "read" as const, path: "a.php" },
			{ kind: "search" as const, pattern: "needle", glob: "a.php" },
			{ kind: "files" as const, pattern: "*.php" },
		];
		const results = await runBatch(jobs, deps);
		assert.equal(results[0]!.text, "alpha\nneedle\nomega\n");
		assert.match(results[1]!.text, /a\.php:2:needle/);
		assert.match(results[2]!.text, /a\.php/);
		assert.match(formatBatch(jobs, results), /=== 1\. read a\.php lines 1\.\.2000 \(requested\) ===/);
	} finally {
		await cleanup();
	}
});

test("search never reads .env", async () => {
	const { deps, cleanup } = await fixture();
	try {
		const [result] = await runBatch([{ kind: "search", pattern: "secret-value" }], deps);
		assert.equal(result!.text, "[No matches]");
		assert.equal(result!.error, false);
		assert.ok(ripgrepArgs({ kind: "search", pattern: "x" }).includes("!.env"));
	} finally {
		await cleanup();
	}
});

test("oversized file listing is truncated losslessly to a private file", async () => {
	const { deps, cleanup } = await fixture();
	try {
		const [result] = await runBatch([{ kind: "files", path: "many" }], deps);
		assert.equal(result!.truncated, true);
		assert.match(result!.text, /Truncated \d+ bytes to <=8000 bytes/);
		const full = await readFile(result!.fullOutputPath!, "utf8");
		assert.ok(Buffer.byteLength(full) > 8000);
	} finally {
		await cleanup();
	}
});

test("one failing job is reported without failing the others", async () => {
	const { deps, cleanup } = await fixture();
	try {
		const results = await runBatch([{ kind: "read", path: "missing.php" }, { kind: "read", path: "a.php" }, { kind: "search" }], deps);
		assert.equal(results[0]!.error, true);
		assert.equal(results[1]!.error, false);
		assert.match(results[2]!.text, /search requires pattern/);
	} finally {
		await cleanup();
	}
});

test("an aborted batch reports cancellation per job", async () => {
	const { deps, cleanup } = await fixture();
	try {
		const controller = new AbortController();
		controller.abort();
		const [result] = await runBatch([{ kind: "read", path: "a.php" }], { ...deps, signal: controller.signal });
		assert.equal(result!.error, true);
		assert.match(result!.text, /abort/i);
	} finally {
		await cleanup();
	}
});

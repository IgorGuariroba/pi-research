import { test } from "node:test";
import assert from "node:assert/strict";
import { capFor, READ_LINES, RESEARCH_PROMPT, RESEARCH_TOOLS, ReadRangeGuard, SEARCH_MAX_BYTES, truncateUtf8 } from "../src/policy.ts";

test("a read covered by an earlier read is rejected", () => {
	const guard = new ReadRangeGuard();
	assert.equal(guard.check({ path: "a.php", offset: 1, limit: 100 }).block, false);
	const again = guard.check({ path: "./a.php", offset: 10, limit: 20 });
	assert.equal(again.block, true);
	assert.match(again.block ? again.reason : "", /Already read a\.php lines 10\.\.29/);
});

test("a whole-file read covers later sub-range reads", () => {
	const guard = new ReadRangeGuard();
	assert.equal(guard.check({ path: "big.php" }).block, false);
	assert.equal(guard.check({ path: "big.php", offset: 500, limit: 40 }).block, true);
	assert.equal(guard.check({ path: "big.php", offset: READ_LINES + 1, limit: 10 }).block, false);
});

test("a different range or file is allowed, and clear() forgets the run", () => {
	const guard = new ReadRangeGuard();
	guard.check({ path: "a.php", offset: 1, limit: 10 });
	assert.equal(guard.check({ path: "a.php", offset: 5, limit: 20 }).block, false);
	assert.equal(guard.check({ path: "b.php", offset: 1, limit: 10 }).block, false);
	guard.clear();
	assert.equal(guard.check({ path: "a.php", offset: 1, limit: 10 }).block, false);
});

test("reads are not capped by the profile; search/list output is", () => {
	assert.equal(capFor("read"), undefined);
	assert.equal(capFor("research_batch"), undefined);
	for (const tool of ["grep", "find", "ls"]) assert.equal(capFor(tool), SEARCH_MAX_BYTES);
});

test("truncateUtf8 never splits a multi-byte character", () => {
	const cut = truncateUtf8("é".repeat(10), 5);
	assert.equal(cut.truncated, true);
	assert.equal(cut.totalBytes, 20);
	assert.equal(cut.text, "éé");
	assert.deepEqual(truncateUtf8("short", 100), { text: "short", truncated: false, totalBytes: 5 });
});

test("the profile prompt is read-only and answer-focused", () => {
	assert.match(RESEARCH_PROMPT, /read-only code research assistant/);
	assert.match(RESEARCH_PROMPT, /Do not audit for bugs/);
	assert.match(RESEARCH_PROMPT, /preceding step/);
	assert.deepEqual([...RESEARCH_TOOLS], ["read", "grep", "find", "ls", "research_batch"]);
});

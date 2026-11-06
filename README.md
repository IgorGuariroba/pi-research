# pi-research

A **read-only research profile** for the [Pi coding agent](https://pi.dev). Use it to ask questions about a codebase, such as "what is the flow to do X, with the curl for each endpoint". Pi answers with fewer round trips and less reasoning, and still covers every step the question asks for.

It is opt-in. Pi stays a normal coding agent until you turn the profile on.

```bash
pi --research "Qual o fluxo para faturar um pedido de venda, com os curl de cada endpoint?"
# or, inside a session
/research on
/research off
/research status
```

## Install

```bash
pi install npm:@igor-guari/pi-research
# or
pi install git:github.com/IgorGuariroba/pi-research
```

Try it without installing: `pi -e npm:@igor-guari/pi-research --research`.

## What the profile changes

| While on | Why |
|---|---|
| Replaces Pi's coding-agent preamble with a read-only, answer-focused prompt: parallel calls, stop when every part is answered, no bug auditing nobody asked for, list each preceding step with its own command | This change had the largest measured effect: reasoning time fell from ~100 s to 62–80 s |
| Active tools: `read`, `grep`, `find`, `ls`, and `research_batch` (from this package) | A small surface, built only for reading |
| Whole-file reads (Pi's own limit, 2000 lines). Reading a range already read is rejected | 200-line or 8 KB read caps made the model re-read in pieces. Removing them cut the median run time by about 9.5 s |
| `research_batch` runs 1–8 reads and searches in parallel (4 workers) with ripgrep. It never searches `.git`, `vendor`, `node_modules`, `storage`, `.env*`, `.aws` or `.ssh` | One round trip for independent lookups |
| Search and list output is capped at 8 KB. Batch output over the cap is saved to a private temp file, and the path is shown | Keeps context small without losing data |
| The skills catalog is hidden. Project context files (`AGENTS.md`) stay | The measured profile ran without skills, and project files carry the repository's rules |

`/research off` restores the tools that were active before.

## Evidence

The profile came out of a lab that compared Pi with the Cursor CLI (`agent --mode ask`) on the same model and question, over a read-only PHP repository. Both sides used Cursor Auto Cost through [`@igor-guari/pi-cursor`](https://github.com/IgorGuariroba/pi-cursor).

| Pi configuration | Pi median | Cursor median | Quality |
|---|---|---|---|
| Plain lean Pi, before the profile | 144.3 s | 143.8 s | complete |
| Profile without the preceding-step rule | **122.9 s** (won 3 of 3 pairs) | 143.7 s | 1 of 3 answers missed a preceding step |
| Profile as shipped (4 pre-registered pairs) | 141.1 s | 131.6 s | **4 of 4 complete** |

Run-to-run noise is about ±25 s on both sides, and it comes mostly from how much the model chooses to reason. So, honestly: with full quality, the profile puts Pi on par with the Cursor CLI, not clearly ahead. Compared with Pi's default prompt, it cuts reasoning on read-only questions.

## Development

```bash
npm test   # node --test, no build step
```

## License

MIT

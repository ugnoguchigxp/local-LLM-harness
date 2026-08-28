# AGENTS.md

## Project overview

local-LLM-harness (LARM) is the Linux-first control plane for local AI runtimes on the gnosis host. Keep inference engines and model weights outside this source-only repository.

## Commands

- Install: `bun install --frozen-lockfile`
- Full check: `bun run check`
- Tests: `bun run test`
- Type check: `bun run typecheck`
- Preview design documents: `bun run docs`
- Check design documents: `bun run docs:check`
- Fix and check design documents: `bun run docs:check:fix`

## Spec HTML documents

When design decisions, specifications, implementation plans, or research results are worth preserving, create or update a Spec HTML document under `specs/` without waiting for a separate documentation request.

- Make each file an HTML fragment with one root `article` whose `lang` identifies the document's primary language. Do not add `html`, `head`, `body`, document-specific CSS, or navigation.
- Add exactly one `h1` and use standard semantic HTML. Use tables, `aside`, `details`, and `figure` when they improve understanding.
- Keep requirements, conclusions, and values understandable from the HTML text. Scripts and diagrams are supporting material only.
- Keep document links and assets inside `specs/` and reference them with relative URLs.
- Existing Markdown may remain until deliberately migrated. New design artifacts use HTML.
- After creating or editing documents, run `bun run docs:check:fix` and resolve every remaining diagnostic.

## Architecture boundaries

- Keep OS-independent registry, planning, lease, and resolve logic in `packages/core`.
- Keep systemd and llama-swap integrations in `packages/backends`.
- Qwen 3.8 27B remains the resident default, including realtime tasks. Optional speed-oriented models require explicit selection.
- Do not commit model weights, binaries, build output, caches, logs, or generated media.

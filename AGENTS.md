# AGENTS.md

## Project overview

local-LLM-harness (LARM) is the Linux-first, demand-driven control plane for local AI runtimes, with `local-node` as its neutral deployment profile. A consumer requests an Agent Profile and its Provider services; LARM resolves the required runtimes and dynamically starts, keeps warm, replaces, or stops the backing Provider processes according to lifecycle, resource, priority, and swap-group policy. A port, systemd unit, or currently running model is therefore current execution state, not a permanent Provider identity. Keep inference engines and model weights outside this source-only repository.

## Provider lifecycle premise

- Treat the requested Agent Profile and Provider subset as the source of intent. Trace profile -> route -> runtime -> backend before deciding which model should be running.
- Do not infer a configuration fault merely because a currently running process differs from another profile's desired model. It may legitimately serve the active workload, such as a ContextStill request.
- When investigating a model or concurrency issue, distinguish the current workload, the resolved runtime, the live backend process, and the repository's possible runtime definitions. Only call their difference drift after proving that the active request resolves to a different runtime than the process serving it.
- Evaluate session capacity against the runtime that LARM would resolve for the named request, including its context size, slot count, KV cache, lifecycle, and competing Providers. Do not substitute whichever model happens to be running at inspection time.

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

## Related repositories

- SAAA is expected at `../SAAA` and its canonical repository is `https://github.com/ugnoguchigxp/SAAA`.
- Before inspecting or relying on the SAAA implementation, check the `../SAAA` worktree. If it is clean, run `git pull --ff-only` in that directory and inspect the updated revision.
- If `../SAAA` is missing, clone the canonical repository there. If its worktree is not clean or a fast-forward pull is not possible, do not overwrite, reset, stash, or merge its changes; report the condition and resolve it before treating the checkout as current.

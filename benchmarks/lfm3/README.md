# LFM3 conversation benchmark

The 2026-10-28 evaluation uses the pinned QAD Q4_0 GGUF and a separately built
llama.cpp Vulkan server documented in `specs/lfm3-candidate-review-2026-10-28.html`.
The server is bound to localhost, with one slot, a 32768-token context,
`--jinja --reasoning-format deepseek`, GPU offload, and continuous background
workloads left running. No model or build artifacts belong in this repository.

With that server listening on `127.0.0.1:18094`, run:

```sh
PYTHONDONTWRITEBYTECODE=1 python3 benchmarks/lfm3/benchmark.py /srv/ai/evidence/lfm3-example
```

The script records time to the first streamed reasoning or content, first
visible content, total time, server timing and token counts. It tests the same
short prompts for every requested effort, synthetic long-context retrieval, and
actual multi-turn conversation. It stores visible answers but only the length
of reasoning, not the reasoning text. Cold startup is not measured. Inspect
answers manually; the small sample and seeded prompts are not a quality score.
The template, not the accepted API field alone, determines which effort values
actually change behavior. Do not interpret the four thinking-on request labels
as distinct supported effort levels.

For the separate startup-budget experiment, run:

```sh
PYTHONDONTWRITEBYTECODE=1 python3 benchmarks/lfm3/budget_benchmark.py /srv/ai/evidence/lfm3-budget-example
PYTHONDONTWRITEBYTECODE=1 python3 benchmarks/lfm3/budget_benchmark.py /srv/ai/evidence/lfm3-native-off-example --native-off-only
```

The first run starts a server for each budget and requests the same two seeded
outputs at each level. The second measures this model's native thinking-off
mode without forcing a zero budget. These experiments use repetition penalty
1.05 to match the separate LFM2.5 comparison, rather than LFM3's recommended
1.1. Budget caps and retokenized reasoning lengths can differ by one token at
boundaries. The script writes generated outputs to the external evidence path.

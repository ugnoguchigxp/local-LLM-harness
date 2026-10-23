import { expect, test } from "bun:test";
import { retentionCommand } from "./prepare-prompt-retention-config";

test("candidate partitions KV while preserving total context, slots and checkpoints", () => {
  const original = "/old/engine --model /weights/synthetic.gguf --port ${PORT} --parallel 4 --ctx-size 1048576 --kv-unified --cache-prompt -cram 0 --no-cache-idle-slots -ctxcp 8 -cpent 1024 --cache-reuse 0";
  const changed = retentionCommand(original, "/candidate/engine", "/candidate/launch.py", "/private/env.json", 8 * 1024 ** 3);
  expect(changed.startsWith("/usr/bin/python3 /candidate/launch.py /private/env.json /candidate/engine ")).toBe(true);
  expect(changed).toContain("--parallel 4 --ctx-size 1048576 --no-kv-unified --cache-prompt -cram 8192 --no-cache-idle-slots -ctxcp 8 -cpent 1024 --cache-reuse 0");
});

test("ambiguous and unsupported command baselines are rejected without interpretation", () => {
  for (const command of ["engine -cram 0 -cram 0 --cache-prompt --no-cache-idle-slots", "engine --cache-ram=0 --cache-prompt --no-cache-idle-slots",
    "engine -cram 0 --cache-prompt --no-cache-idle-slots --cache-disk /cache", "engine -cram 0 --cache-prompt --no-cache-idle-slots $(unsafe)",
    "engine -cram 0 --cache-prompt --no-cache-idle-slots --kv-unified --no-kv-unified"]) {
    expect(() => retentionCommand(command, "/candidate/engine", "/candidate/launch.py", "/private/env.json", 8 * 1024 ** 3)).toThrow();
  }
});

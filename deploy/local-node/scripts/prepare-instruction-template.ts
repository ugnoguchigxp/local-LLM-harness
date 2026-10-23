import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

/** Preserve the pinned template's first-two instruction prefix and all tool,
 * vision and reasoning handling. Render subsequent instructions at their
 * original position and with their original role. No message promotion. */
export function repairInstructionTemplate(source: string): string {
  const digest = createHash("sha256").update(source).digest("hex");
  if (digest !== "f55f52930aa8bf44ab5cb85f99370fcc3c56e9a85640b812086d5330bce5d86b") throw new Error("instruction_template_source_mismatch");
  const guard = '{%- if loop.index0 >= num_sys and message.role != "system" and message.role != "developer" %}';
  const branch = '{%- if message.role == "user" %}';
  if (source.split(guard).length !== 2 || source.split(branch).length !== 2) throw new Error("instruction_template_shape_mismatch");
  return source.replace(guard, '{%- if loop.index0 >= num_sys %}')
    .replace(branch, `{%- if message.role == "system" or message.role == "developer" %}
        {{- '<|im_start|>' + message.role + '\\n' + render_content(message.content, false, true)|trim + '<|im_end|>\\n' }}
    {%- elif message.role == "user" %}`);
}

if (import.meta.main) {
  const [source, output] = process.argv.slice(2);
  if (!source || !output) throw new Error("usage: prepare-instruction-template.ts ORIGINAL_TEMPLATE NEW_TEMPLATE");
  const template = repairInstructionTemplate(readFileSync(source, "utf8"));
  writeFileSync(output, template, { flag: "wx", mode: 0o600 });
  console.log(JSON.stringify({ templateSha256: createHash("sha256").update(template).digest("hex"), activated: false }));
}

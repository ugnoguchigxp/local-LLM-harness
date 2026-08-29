import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { compareSlo } from "../../../packages/core/src/index";
import { parse } from "yaml";

const manifestPath = resolve(process.env.LARM_SLO_MANIFEST ?? resolve(import.meta.dir, "../slo.yaml"));
const summaryPath = process.env.LARM_SLO_SUMMARY;
const expectedCommit = process.env.LARM_SLO_EXPECTED_COMMIT;
const expectedConfigRevision = process.env.LARM_SLO_EXPECTED_CONFIG_REVISION;

if (!summaryPath || !isAbsolute(summaryPath)) throw new Error("LARM_SLO_SUMMARY must be an absolute path");
if (!expectedCommit || !/^[a-f0-9]{40}$/.test(expectedCommit)) {
  throw new Error("LARM_SLO_EXPECTED_COMMIT must be a full commit hash");
}

const manifest = parse(await readFile(manifestPath, "utf8"));
const summary = JSON.parse(await readFile(summaryPath, "utf8"));
const result = compareSlo(manifest, summary, {
  commit: expectedCommit,
  ...(expectedConfigRevision ? { configRevision: expectedConfigRevision } : {}),
});
console.log(JSON.stringify({ schemaVersion: 1, manifest: manifestPath, summary: summaryPath, ...result }));
if (!result.passed) process.exit(1);

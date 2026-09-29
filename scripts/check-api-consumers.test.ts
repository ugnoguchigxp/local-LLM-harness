import { expect, test } from "bun:test";
import {
  validateApiConsumerMigration,
  validateProductionConsumerReferences,
} from "./check-api-consumers";

const goodSources = {
  "deploy/local-node/scripts/evaluate-backchannel-candidates.ts": "client.listAgentProfilesV3()",
  "deploy/local-node/scripts/verify-live-contract.ts": '"/v3/agent-profiles"',
  "deploy/local-node/scripts/activate-larm-release.sh": "/v3/agent-profiles",
  "deploy/local-node/scripts/smoke-laya-profile.ts": 'listAgentProfilesV3("SAAA")',
  "apps/daemon/README.md": "/v1/allocations is the explicit API compatibility endpoint",
  "README.md": "/v3/agent-profiles /v1/agent-connections 互換専用",
  "packages/client/src/client-agent-connections.ts": [
    "@deprecated Use listAgentProfilesV3",
    'request("/v2/agent-profiles"',
    "/v3/agent-profiles",
  ].join(" "),
  "packages/client/src/index.ts": [
    "@deprecated Use listAgentProfilesV3",
    "this.agentConnections.listAgentProfiles(signal)",
    "async listAgentProfilesV3",
  ].join(" "),
  "deploy/local-node/scripts/shadow-larm.sh": "${base_url}/prepare ${base_url}/resolve /v1/allocations/",
};

test("accepts documented repository consumer migrations and intentional compatibility holds", () => {
  expect(validateApiConsumerMigration(goodSources)).toEqual([]);
});

test("rejects a migrated consumer that regresses to a compatibility route", () => {
  const regressed = {
    ...goodSources,
    "deploy/local-node/scripts/verify-live-contract.ts": '"/v2/agent-profiles"',
  };
  const failures = validateApiConsumerMigration(regressed);
  expect(failures).toContain(
    `deploy/local-node/scripts/verify-live-contract.ts: expected migration evidence ${JSON.stringify('"/v3/agent-profiles"')}`,
  );
  expect(failures).toContain(
    `deploy/local-node/scripts/verify-live-contract.ts: stale consumer reference ${JSON.stringify('"/v2/agent-profiles"')}`,
  );
});

test("requires evidence for every inventoried consumer", () => {
  const incomplete = { ...goodSources };
  delete (incomplete as Record<string, string>)["deploy/local-node/scripts/smoke-laya-profile.ts"];
  expect(validateApiConsumerMigration(incomplete)).toContain(
    "deploy/local-node/scripts/smoke-laya-profile.ts: migration evidence source is missing",
  );
});

test("scans production consumers and permits only the registered legacy parity consumer", () => {
  expect(validateProductionConsumerReferences({
    "deploy/local-node/scripts/migrated.ts": 'request("/v3/agent-profiles")',
    "deploy/local-node/scripts/shadow-larm.sh": '${base_url}/prepare ${base_url}/resolve',
  })).toEqual([]);
  expect(validateProductionConsumerReferences({
    "deploy/local-node/scripts/new-consumer.ts": 'request("/v2/agent-profiles")',
  })).toEqual([
    "deploy/local-node/scripts/new-consumer.ts: unregistered compatibility consumer reference /v2/agent-profiles",
  ]);
});

test("repository production source scanning covers apps and packages while excluding route catalogs", () => {
  expect(validateProductionConsumerReferences({
    "apps/daemon/src/new-consumer.ts": 'fetch("/prepare")',
    "packages/example/src/client.ts": 'request("/v2/agent-profiles")',
    "apps/daemon/src/routes/legacy-control.ts": 'app.post("/prepare", handler)',
    "packages/core/src/api-operations.ts": '["post", "/prepare", "prepareLegacyLease"]',
    "packages/client/src/client-agent-connections.ts": 'request("/v2/agent-profiles")',
  })).toEqual([
    "apps/daemon/src/new-consumer.ts: unregistered compatibility consumer reference legacy /prepare",
    "packages/example/src/client.ts: unregistered compatibility consumer reference /v2/agent-profiles",
  ]);
});

test("detects legacy release and operation polling without confusing versioned operations", () => {
  expect(validateProductionConsumerReferences({
    "apps/agent/src/old-release.ts": 'request("/release")',
    "packages/tool/src/old-poll.ts": 'request(`/operations/${id}`)',
    "packages/tool/src/current-poll.ts": 'request(`/v1/operations/${id}`)',
    "packages/tool/src/convergence.ts": 'request("/v1/release-convergence")',
  })).toEqual([
    "apps/agent/src/old-release.ts: unregistered compatibility consumer reference legacy /release",
    "packages/tool/src/old-poll.ts: unregistered compatibility consumer reference legacy /operations/:id",
  ]);
});

test("ignores TypeScript comments when checking migration and legacy references", () => {
  const commentedMigration = {
    ...goodSources,
    "deploy/local-node/scripts/evaluate-backchannel-candidates.ts":
      "// client.listAgentProfilesV3()\nclient.listAgentProfiles()",
  };
  expect(validateApiConsumerMigration(commentedMigration)).toContain(
    'deploy/local-node/scripts/evaluate-backchannel-candidates.ts: expected migration evidence "listAgentProfilesV3()"',
  );
  expect(validateProductionConsumerReferences({
    "apps/agent/src/current.ts": '// request("/v2/agent-profiles")\nrequest("/v3/agent-profiles")',
  })).toEqual([]);
});

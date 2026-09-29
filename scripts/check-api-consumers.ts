import ts from "typescript";

type ConsumerRule = {
  path: string;
  required: readonly string[];
  forbidden?: readonly string[];
};

const CONSUMER_RULES: readonly ConsumerRule[] = [
  {
    path: "deploy/local-node/scripts/evaluate-backchannel-candidates.ts",
    required: ["listAgentProfilesV3()"],
    forbidden: ["listAgentProfiles()"],
  },
  {
    path: "deploy/local-node/scripts/verify-live-contract.ts",
    required: ['"/v3/agent-profiles"'],
    forbidden: ['"/v1/agent-profiles"', '"/v2/agent-profiles"'],
  },
  {
    path: "deploy/local-node/scripts/activate-larm-release.sh",
    required: ["/v3/agent-profiles"],
    forbidden: ["/v1/agent-profiles", "/v2/agent-profiles"],
  },
  {
    path: "deploy/local-node/scripts/smoke-laya-profile.ts",
    required: ["listAgentProfilesV3("],
    forbidden: ["listAgentProfiles("],
  },
  {
    path: "apps/daemon/README.md",
    required: ["/v1/allocations", "compatibility endpoint"],
  },
  {
    path: "README.md",
    required: ["/v3/agent-profiles", "/v1/agent-connections", "互換専用"],
  },
  {
    path: "packages/client/src/client-agent-connections.ts",
    required: [
      "@deprecated Use listAgentProfilesV3",
      'request("/v2/agent-profiles"',
      "/v3/agent-profiles",
    ],
  },
  {
    path: "packages/client/src/index.ts",
    required: [
      "@deprecated Use listAgentProfilesV3",
      "this.agentConnections.listAgentProfiles(signal)",
      "async listAgentProfilesV3",
    ],
  },
  {
    path: "deploy/local-node/scripts/shadow-larm.sh",
    required: ["${base_url}/prepare", "${base_url}/resolve", "/v1/allocations/"],
  },
];

const INTENTIONAL_COMPATIBILITY_CONSUMERS = new Set([
  "deploy/local-node/scripts/shadow-larm.sh",
  "packages/client/src/client-agent-connections.ts",
  "packages/client/src/index.ts",
]);
const API_PROVIDER_OR_CATALOG_SOURCES = new Set([
  "apps/daemon/src/app-auth.ts",
  "apps/daemon/src/routes/agent-profiles.ts",
  "apps/daemon/src/routes/inspection.ts",
  "apps/daemon/src/routes/legacy-control.ts",
  "packages/core/src/api-lifecycle.ts",
  "packages/core/src/api-operations.ts",
  "scripts/check-api-consumers.ts",
]);
const COMPATIBILITY_REFERENCES: readonly { label: string; pattern: RegExp }[] = [
  { label: "listAgentProfiles()", pattern: /\blistAgentProfiles\s*\(/ },
  { label: "/v1/agent-profiles", pattern: /\/v1\/agent-profiles\b/ },
  { label: "/v2/agent-profiles", pattern: /\/v2\/agent-profiles\b/ },
  { label: "legacy /prepare", pattern: /(?:\$\{base_url\}|["'`])\/prepare\b/ },
  { label: "legacy /resolve", pattern: /(?:\$\{base_url\}|["'`])\/resolve\b/ },
  { label: "legacy /release", pattern: /(?:\$\{base_url\}|["'`])\/release(?![\w-])/ },
  { label: "legacy /operations/:id", pattern: /(?:\$\{base_url\}|["'`])\/operations\// },
];

const SOURCE_ROOTS = ["apps", "packages", "deploy/local-node/scripts", "scripts", "benchmarks"] as const;
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs", ".sh", ".py"]);

function executableText(path: string, source: string): string {
  if (!/\.[cm]?[jt]sx?$/.test(path)) return source;
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, source);
  const chars = source.split("");
  for (let kind = scanner.scan(); kind !== ts.SyntaxKind.EndOfFileToken; kind = scanner.scan()) {
    if (kind !== ts.SyntaxKind.SingleLineCommentTrivia && kind !== ts.SyntaxKind.MultiLineCommentTrivia) continue;
    for (let index = scanner.getTokenPos(); index < scanner.getTextPos(); index += 1) {
      if (chars[index] !== "\n" && chars[index] !== "\r") chars[index] = " ";
    }
  }
  return chars.join("");
}

function isProductionSource(path: string): boolean {
  const filename = path.slice(path.lastIndexOf("/") + 1);
  const extension = filename.slice(filename.lastIndexOf("."));
  return SOURCE_EXTENSIONS.has(extension)
    && !/\.(?:test|spec)\.[^.]+$/.test(filename)
    && !filename.endsWith(".d.ts")
    && !API_PROVIDER_OR_CATALOG_SOURCES.has(path);
}

export function validateApiConsumerMigration(sources: Readonly<Record<string, string>>): string[] {
  const failures: string[] = [];
  for (const rule of CONSUMER_RULES) {
    const source = sources[rule.path];
    if (source === undefined) {
      failures.push(`${rule.path}: migration evidence source is missing`);
      continue;
    }
    const code = executableText(rule.path, source);
    for (const marker of rule.required) {
      const searched = marker.startsWith("@deprecated") ? source : code;
      if (!searched.includes(marker)) failures.push(`${rule.path}: expected migration evidence ${JSON.stringify(marker)}`);
    }
    for (const marker of rule.forbidden ?? []) {
      if (code.includes(marker)) failures.push(`${rule.path}: stale consumer reference ${JSON.stringify(marker)}`);
    }
  }
  return failures.sort();
}

export function validateProductionConsumerReferences(
  sources: Readonly<Record<string, string>>,
): string[] {
  const failures: string[] = [];
  for (const [path, source] of Object.entries(sources)) {
    if (API_PROVIDER_OR_CATALOG_SOURCES.has(path)) continue;
    if (INTENTIONAL_COMPATIBILITY_CONSUMERS.has(path)) continue;
    const code = executableText(path, source);
    for (const reference of COMPATIBILITY_REFERENCES) {
      if (reference.pattern.test(code)) {
        failures.push(`${path}: unregistered compatibility consumer reference ${reference.label}`);
      }
    }
  }
  return failures.sort();
}

if (import.meta.main) {
  const sources: Record<string, string> = {};
  for (const rule of CONSUMER_RULES) sources[rule.path] = await Bun.file(rule.path).text();
  const productionPaths = [...new Set(SOURCE_ROOTS.flatMap((root) =>
    [...new Bun.Glob("**/*").scanSync({ cwd: root, onlyFiles: true })]
      .map((path) => `${root}/${path}`)
      .filter(isProductionSource)
  ))].sort();
  const productionSources = Object.fromEntries(await Promise.all(productionPaths.map(async (path) => [
    path,
    await Bun.file(path).text(),
  ])));
  const failures = [
    ...validateApiConsumerMigration(sources),
    ...validateProductionConsumerReferences(productionSources),
  ].sort();
  if (failures.length > 0) {
    console.error("API consumer migration check failed:");
    for (const failure of failures) console.error(`- ${failure}`);
    process.exit(1);
  }
  console.log(
    `API consumer migration check passed (${CONSUMER_RULES.length} migration evidence sources; ${productionPaths.length} repository production sources scanned)`,
  );
}

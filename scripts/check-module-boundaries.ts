import ts from "typescript";

const SOURCE_ROOTS = [
  "apps/daemon/src",
  "packages/core/src",
  "packages/backends/src",
  "packages/client/src",
] as const;

function isSource(path: string): boolean {
  return path.endsWith(".ts")
    && !path.endsWith(".test.ts")
    && !path.endsWith(".spec.ts")
    && !path.endsWith(".d.ts");
}

function importedModule(node: ts.Node): string | undefined {
  if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
    if (ts.isImportDeclaration(node) && node.importClause?.isTypeOnly) return undefined;
    if (ts.isExportDeclaration(node) && node.isTypeOnly) return undefined;
    if (ts.isImportDeclaration(node) && node.importClause) {
      const bindings = node.importClause.namedBindings;
      if (!node.importClause.name && bindings && ts.isNamedImports(bindings)
        && bindings.elements.every((element) => element.isTypeOnly)) return undefined;
    }
    if (ts.isExportDeclaration(node) && node.exportClause && ts.isNamedExports(node.exportClause)
      && node.exportClause.elements.every((element) => element.isTypeOnly)) return undefined;
    return node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)
      ? node.moduleSpecifier.text
      : undefined;
  }
  if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
    const first = node.arguments[0];
    return first && ts.isStringLiteral(first) ? first.text : undefined;
  }
  return undefined;
}

function normalize(path: string): string {
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (part === "." || part === "") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return parts.join("/");
}

export function checkModuleBoundaries(sources: Readonly<Record<string, string>>): string[] {
  const paths = new Set(Object.keys(sources));
  const edges = new Map<string, string[]>();
  const failures: string[] = [];
  for (const [path, source] of Object.entries(sources)) {
    const parsed = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
    const imports: string[] = [];
    for (const node of parsed.statements) {
      const specifier = importedModule(node);
      if (!specifier?.startsWith(".")) continue;
      const directory = path.slice(0, path.lastIndexOf("/"));
      const resolved = normalize(`${directory}/${specifier}`);
      const target = [resolved, `${resolved}.ts`, `${resolved}/index.ts`].find((candidate) => paths.has(candidate));
      if (!target) continue;
      imports.push(target);
      if (path.startsWith("packages/core/src/") && target.startsWith("apps/")) {
        failures.push(`${path}: core depends on application source ${target}`);
      }
      if (path.startsWith("apps/daemon/src/") && !path.includes("/routes/")
        && target.startsWith("apps/daemon/src/routes/")) {
        const basename = path.slice(path.lastIndexOf("/") + 1);
        if (basename !== "app.ts") failures.push(`${path}: domain module imports HTTP route ${target}`);
      }
    }
    edges.set(path, imports);
  }
  const visited = new Set<string>();
  const active = new Set<string>();
  const stack: string[] = [];
  function visit(path: string): void {
    if (visited.has(path)) return;
    visited.add(path);
    active.add(path);
    stack.push(path);
    for (const target of edges.get(path) ?? []) {
      if (active.has(target)) {
        failures.push(`runtime import cycle: ${[...stack.slice(stack.indexOf(target)), target].join(" -> ")}`);
      } else visit(target);
    }
    stack.pop();
    active.delete(path);
  }
  for (const path of paths) visit(path);
  return failures.sort();
}

if (import.meta.main) {
  const paths = SOURCE_ROOTS.flatMap((root) =>
    [...new Bun.Glob("**/*.ts").scanSync({ cwd: root, onlyFiles: true })]
      .map((path) => `${root}/${path}`)
      .filter(isSource)
  ).sort();
  const sources = Object.fromEntries(await Promise.all(paths.map(async (path) => [
    path,
    await Bun.file(path).text(),
  ])));
  const failures = checkModuleBoundaries(sources);
  if (failures.length > 0) {
    console.error("module boundary check failed:");
    for (const failure of failures) console.error(`- ${failure}`);
    process.exit(1);
  }
  console.log(`module boundary check passed (${paths.length} source files)`);
}

import { expect, test } from "bun:test";
import { validateSpecCatalog } from "./check-spec-catalog";

function row(
  file: string,
  title: string,
  role: string,
  status: string,
  metadata: {
    kind: string;
    state: string;
    domain: string;
    successor?: string;
    observedOn?: string;
    targetRevision?: string;
    auditGap?: string;
  },
) {
  const successor = metadata.successor === "none"
    ? ' <span data-successor-note="後継文書なし">後継文書なし</span>'
    : metadata.successor
    ? ` <a rel="successor" href="./${metadata.successor}">successor</a>`
    : "";
  const successorAttr = metadata.successor ? ` data-successor="${metadata.successor}"` : "";
  const requiresAudit = metadata.state === "historical"
    && ["contract", "evidence", "research"].includes(metadata.kind);
  const audit = requiresAudit || metadata.observedOn || metadata.targetRevision
    ? ` data-audit="point-in-time" data-observed-on="${metadata.observedOn ?? "2026-09-01"}" data-target-revision="${metadata.targetRevision ?? "abcdef1234567"}"${metadata.auditGap ? ` data-audit-gap="${metadata.auditGap}"` : ""}`
    : "";
  const visibleAudit = audit
    ? `<small data-audit-summary="true">観測 ${metadata.observedOn ?? "2026-09-01"} · revision ${metadata.targetRevision ?? "abcdef1234567"}</small>${metadata.auditGap ? `<span data-audit-gap-note="true">${metadata.auditGap}</span>` : ""}`
    : "";
  return `<tr data-kind="${metadata.kind}" data-state="${metadata.state}" data-domain="${metadata.domain}"${successorAttr}${audit}>`
    + `<th scope="row"><a href="./${file}">${title}</a></th>`
    + `<td>${role}<small>分類: <code>${metadata.kind}</code> · 状態: <code>${metadata.state}</code> · 正本領域: <code>${metadata.domain}</code></small>${visibleAudit}</td>`
    + `<td>${status}${successor}</td></tr>`;
}

test("spec catalog requires every document exactly once and rejects broken links", () => {
  const markup = [
    "<table><tbody>",
    '<tr><th scope="row"><a href="./overview.html">Overview</a></th><td>入口</td><td>current</td></tr>',
    row("current.html", "Current", "仕様", "current", {
      kind: "contract", state: "current", domain: "api",
    }),
    row("current.html", "Duplicate", "仕様", "proposed", {
      kind: "contract", state: "proposed", domain: "api-plan",
    }),
    row("missing.html", "Missing", "調査", "historical", {
      kind: "research", state: "historical", domain: "missing", successor: "none",
    }),
    "</tbody></table>",
  ].join("\n");

  expect(validateSpecCatalog(markup, ["overview.html", "current.html", "uncatalogued.html"])).toEqual([
    "catalog document must appear in exactly one row: current.html",
    "catalog link has no matching spec: missing.html",
    "duplicate catalog entry: current.html",
    "spec is missing from catalog: uncatalogued.html",
  ]);
});

test("spec catalog accepts an exact, classified index", () => {
  expect(validateSpecCatalog(
    "<table><tbody>"
      + row("one.html", "One", "契約", "current", { kind: "contract", state: "current", domain: "api" })
      + row("two.html", "Two", "計画", "proposed", { kind: "plan", state: "proposed", domain: "rollout" })
      + "</tbody></table>",
    ["overview.html", "one.html", "two.html"],
  )).toEqual([]);
});

test("spec catalog requires a role, state, and semantic metadata for each document", () => {
  expect(validateSpecCatalog(
    '<table><tr><th scope="row"><a href="./one.html">One</a></th><td></td><td></td></tr></table>',
    ["overview.html", "one.html"],
  )).toEqual([
    "catalog row 1: authority domain is required",
    "catalog row 1: document kind must be one of contract, decision, plan, evidence, research",
    "catalog row 1: document role is required",
    "catalog row 1: document state is required",
    "catalog row 1: document state must be one of current, proposed, implemented, historical",
    "catalog row 1: visible kind, state, and authority domain are required",
  ]);
});

test("one current document is allowed per authority domain", () => {
  const markup = "<table><tbody>"
    + row("one.html", "One", "仕様", "current", { kind: "contract", state: "current", domain: "api" })
    + row("two.html", "Two", "別仕様", "current", { kind: "contract", state: "current", domain: "api" })
    + "</tbody></table>";
  expect(validateSpecCatalog(markup, ["overview.html", "one.html", "two.html"])).toEqual([
    "authority domain must have exactly one current document: api",
  ]);
});

test("visible classification must match the machine-readable metadata", () => {
  const markup = row("one.html", "One", "仕様", "現行正本", {
    kind: "contract", state: "current", domain: "api",
  }).replace("状態: <code>current</code>", "状態: <code>historical</code>");
  expect(validateSpecCatalog(markup, ["overview.html", "one.html"])).toContain(
    "catalog row 1: visible state does not match metadata",
  );
});

test("historical documents require an existing successor or an explicit no-successor note", () => {
  const markup = "<table><tbody>"
    + row("old.html", "Old", "旧計画", "historical", {
      kind: "plan", state: "historical", domain: "old-plan", successor: "new.html",
    })
    + row("new.html", "New", "現行計画", "current", { kind: "plan", state: "current", domain: "rollout" })
    + "</tbody></table>";
  expect(validateSpecCatalog(markup, ["overview.html", "old.html", "new.html"])).toEqual([]);
  expect(validateSpecCatalog(
    '<table><tr data-kind="research" data-state="historical" data-domain="old"><th scope="row"><a href="./old.html">Old</a></th><td>調査</td><td>historical</td></tr></table>',
    ["overview.html", "old.html"],
  )).toContain("catalog row 1: historical document must declare successor or none");
});

test("historical point-in-time rows require a visible observed date and target revision", () => {
  const valid = row("old.html", "Old", "調査", "後継あり", {
    kind: "research", state: "historical", domain: "old-research", successor: "new.html",
    observedOn: "2026-09-24", targetRevision: "unrecorded",
    auditGap: "engine commit was not recorded",
  }) + row("new.html", "New", "仕様", "current", { kind: "contract", state: "current", domain: "current" });
  expect(validateSpecCatalog(`<table>${valid}</table>`, ["overview.html", "old.html", "new.html"])).toEqual([]);

  const missingVisibleRevision = valid.replace("revision unrecorded", "revision missing");
  expect(validateSpecCatalog(`<table>${missingVisibleRevision}</table>`, ["overview.html", "old.html", "new.html"])).toContain(
    "catalog row 1: point-in-time date and revision must be visible",
  );

  const missingGap = row("old.html", "Old", "調査", "後継あり", {
    kind: "research", state: "historical", domain: "old-research", successor: "new.html",
    observedOn: "2026-09-24", targetRevision: "unrecorded",
  });
  expect(validateSpecCatalog(`<table>${missingGap}</table>`, ["overview.html", "old.html", "new.html"])).toContain(
    "catalog row 1: unrecorded target revision requires a visible gap explanation",
  );

  const invalidDate = valid.replace('data-observed-on="2026-09-24"', 'data-observed-on="2026-02-30"');
  expect(validateSpecCatalog(`<table>${invalidDate}</table>`, ["overview.html", "old.html", "new.html"])).toContain(
    "catalog row 1: point-in-time audit requires a valid observed date",
  );
});

test("measured implementation evidence cannot lose its point-in-time provenance", () => {
  const audited = row(
    "qwen-3.5-2b-interaction-evaluation.html",
    "Qwen evaluation",
    "実測研究",
    "評価記録",
    {
      kind: "research",
      state: "implemented",
      domain: "qwen-evaluation",
      observedOn: "2026-09-24",
      targetRevision: "unrecorded",
      auditGap: "target LARM source commit was not recorded",
    },
  );
  expect(validateSpecCatalog(`<table>${audited}</table>`, [
    "overview.html",
    "qwen-3.5-2b-interaction-evaluation.html",
  ])).toEqual([]);

  const withoutAudit = row(
    "qwen-3.5-2b-interaction-evaluation.html",
    "Qwen evaluation",
    "実測研究",
    "評価記録",
    { kind: "research", state: "implemented", domain: "qwen-evaluation" },
  );
  expect(validateSpecCatalog(`<table>${withoutAudit}</table>`, [
    "overview.html",
    "qwen-3.5-2b-interaction-evaluation.html",
  ])).toContain("catalog row 1: document requires point-in-time audit metadata");
});

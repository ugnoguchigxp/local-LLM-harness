export type SpecDocumentKind = "contract" | "decision" | "plan" | "evidence" | "research";
export type SpecDocumentState = "current" | "proposed" | "implemented" | "historical";
export type SpecAuditKind = "point-in-time";

const DOCUMENT_KINDS = new Set<SpecDocumentKind>([
  "contract", "decision", "plan", "evidence", "research",
]);
const DOCUMENT_STATES = new Set<SpecDocumentState>([
  "current", "proposed", "implemented", "historical",
]);
const POINT_IN_TIME_REQUIRED_DOCUMENTS = new Set([
  "implementation-completion-m15-m21.html",
  "irodori-tts-evaluation.html",
  "qwen-3.5-2b-interaction-evaluation.html",
]);

function anchorFiles(markup: string, includeSuccessors = false): string[] {
  return [...markup.matchAll(/<a\b([^>]*)href="\.\/([^"#]+\.html)"([^>]*)>/g)]
    .filter((match) => includeSuccessors || !/\brel="successor"/.test(`${match[1]} ${match[3]}`))
    .map((match) => match[2]!);
}

export function validateSpecCatalog(markup: string, specFiles: readonly string[]): string[] {
  const links = anchorFiles(markup).filter((file) => file !== "overview.html");
  const allFiles = new Set(specFiles.filter((file) => file !== "overview.html"));
  const seen = new Set<string>();
  const failures: string[] = [];
  const rowLinks = new Map<string, number>();
  const currentDomains = new Map<string, number>();

  for (const [index, match] of [...markup.matchAll(/<tr\b([^>]*)>([\s\S]*?)<\/tr>/g)].entries()) {
    const attributes = match[1]!;
    const row = match[2]!;
    const documentFiles = anchorFiles(row).filter((file) => file !== "overview.html");
    if (documentFiles.length === 0) continue;
    const cells = [...row.matchAll(/<(th|td)\b([^>]*)>([\s\S]*?)<\/\1>/g)];
    if (documentFiles.length !== 1) {
      failures.push(`catalog row ${index + 1}: expected exactly one document link`);
    }
    if (cells.length !== 3 || !/scope="row"/.test(cells[0]?.[2] ?? "")) {
      failures.push(`catalog row ${index + 1}: expected one row header and two data cells`);
    }
    const role = cells[1]?.[3]?.replace(/<[^>]*>/g, " ").trim();
    const stateText = cells[2]?.[3]?.replace(/<[^>]*>/g, " ").trim();
    if (!role) failures.push(`catalog row ${index + 1}: document role is required`);
    if (!stateText) failures.push(`catalog row ${index + 1}: document state is required`);

    const kindMatch = /\bdata-kind="([^"]+)"/.exec(attributes);
    const stateMatch = /\bdata-state="([^"]+)"/.exec(attributes);
    const domainMatch = /\bdata-domain="([^"]+)"/.exec(attributes);
    const successorMatch = /\bdata-successor="([^"]+)"/.exec(attributes);
    const auditMatch = /\bdata-audit="([^"]+)"/.exec(attributes);
    const observedOnMatch = /\bdata-observed-on="([^"]+)"/.exec(attributes);
    const targetRevisionMatch = /\bdata-target-revision="([^"]+)"/.exec(attributes);
    const auditGapMatch = /\bdata-audit-gap="([^"]+)"/.exec(attributes);
    const kind = kindMatch?.[1] as SpecDocumentKind | undefined;
    const state = stateMatch?.[1] as SpecDocumentState | undefined;
    const domain = domainMatch?.[1];
    if (!kindMatch || !DOCUMENT_KINDS.has(kind!)) {
      failures.push(`catalog row ${index + 1}: document kind must be one of ${[...DOCUMENT_KINDS].join(", ")}`);
    }
    if (!stateMatch || !DOCUMENT_STATES.has(state!)) {
      failures.push(`catalog row ${index + 1}: document state must be one of ${[...DOCUMENT_STATES].join(", ")}`);
    }
    if (!domain || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(domain)) {
      failures.push(`catalog row ${index + 1}: authority domain is required`);
    }
    const visibleClassification = /分類:\s*<code>([^<]+)<\/code>\s*·\s*状態:\s*<code>([^<]+)<\/code>\s*·\s*正本領域:\s*<code>([^<]+)<\/code>/
      .exec(row);
    if (!visibleClassification) {
      failures.push(`catalog row ${index + 1}: visible kind, state, and authority domain are required`);
    } else {
      if (visibleClassification[1] !== kind) {
        failures.push(`catalog row ${index + 1}: visible kind does not match metadata`);
      }
      if (visibleClassification[2] !== state) {
        failures.push(`catalog row ${index + 1}: visible state does not match metadata`);
      }
      if (visibleClassification[3] !== domain) {
        failures.push(`catalog row ${index + 1}: visible authority domain does not match metadata`);
      }
    }
    if (state === "current" && domain) {
      currentDomains.set(domain, (currentDomains.get(domain) ?? 0) + 1);
    }
    if (state === "historical") {
      const successor = successorMatch?.[1];
      if (!successor) {
        failures.push(`catalog row ${index + 1}: historical document must declare successor or none`);
      } else if (successor === "none") {
        if (!/data-successor-note="後継文書なし"/.test(cells[2]?.[3] ?? "")) {
          failures.push(`catalog row ${index + 1}: no-successor rationale must be visible`);
        }
      } else {
        const successorAnchor = [...row.matchAll(/<a\b([^>]*)href="\.\/([^"#]+\.html)"([^>]*)>/g)]
          .filter((link) => /\brel="successor"/.test(`${link[1]} ${link[3]}`));
        if (successorAnchor.length !== 1 || successorAnchor[0]?.[2] !== successor) {
          failures.push(`catalog row ${index + 1}: successor metadata must match one successor link`);
        }
        if (!allFiles.has(successor)) failures.push(`successor link has no matching spec: ${successor}`);
      }
    } else if (successorMatch) {
      failures.push(`catalog row ${index + 1}: only historical documents may declare a successor`);
    }
    const requiresPointInTimeAudit = (state === "historical"
      && (kind === "research" || kind === "evidence" || kind === "contract"))
      || documentFiles.some((file) => POINT_IN_TIME_REQUIRED_DOCUMENTS.has(file));
    if (requiresPointInTimeAudit && auditMatch?.[1] !== "point-in-time") {
      failures.push(`catalog row ${index + 1}: document requires point-in-time audit metadata`);
    }
    if (auditMatch) {
      if (auditMatch[1] !== "point-in-time") {
        failures.push(`catalog row ${index + 1}: unsupported document audit kind`);
      }
      const observedOn = observedOnMatch?.[1];
      if (!observedOn || !/^\d{4}-\d{2}-\d{2}$/.test(observedOn)
        || Number.isNaN(Date.parse(`${observedOn}T00:00:00Z`))
        || new Date(`${observedOn}T00:00:00Z`).toISOString().slice(0, 10) !== observedOn) {
        failures.push(`catalog row ${index + 1}: point-in-time audit requires a valid observed date`);
      }
      const targetRevision = targetRevisionMatch?.[1];
      if (!targetRevision || (targetRevision !== "unrecorded" && !/^[a-f0-9]{7,40}$/.test(targetRevision))) {
        failures.push(`catalog row ${index + 1}: point-in-time audit requires a target revision or unrecorded`);
      }
      const auditSummary = /<small\b[^>]*data-audit-summary="true"[^>]*>([\s\S]*?)<\/small\s*>/.exec(row)?.[1]
        ?.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
      if (!auditSummary || !observedOn || !targetRevision
        || !auditSummary.includes(observedOn) || !auditSummary.includes(targetRevision)) {
        failures.push(`catalog row ${index + 1}: point-in-time date and revision must be visible`);
      }
      if (targetRevision === "unrecorded") {
        const gap = auditGapMatch?.[1];
        const visibleGap = /<span\b[^>]*data-audit-gap-note="true"[^>]*>([\s\S]*?)<\/span\s*>/.exec(row)?.[1]
          ?.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
        if (!gap || !visibleGap || !visibleGap.includes(gap)) {
          failures.push(`catalog row ${index + 1}: unrecorded target revision requires a visible gap explanation`);
        }
      } else if (auditGapMatch) {
        failures.push(`catalog row ${index + 1}: audit gap is only valid when target revision is unrecorded`);
      }
    } else if (observedOnMatch || targetRevisionMatch || auditGapMatch) {
      failures.push(`catalog row ${index + 1}: point-in-time metadata requires data-audit`);
    }
    for (const file of documentFiles) rowLinks.set(file, (rowLinks.get(file) ?? 0) + 1);
  }

  for (const [domain, count] of currentDomains) {
    if (count !== 1) failures.push(`authority domain must have exactly one current document: ${domain}`);
  }
  for (const link of links) {
    if (seen.has(link)) failures.push(`duplicate catalog entry: ${link}`);
    seen.add(link);
  }
  for (const [file, count] of rowLinks) {
    if (count !== 1) failures.push(`catalog document must appear in exactly one row: ${file}`);
  }
  for (const link of seen) {
    if (!allFiles.has(link)) failures.push(`catalog link has no matching spec: ${link}`);
  }
  for (const file of allFiles) {
    if (!seen.has(file)) failures.push(`spec is missing from catalog: ${file}`);
  }
  return failures.sort();
}

if (import.meta.main) {
  const markup = await Bun.file("specs/overview.html").text();
  const files = [...new Bun.Glob("*.html").scanSync({ cwd: "specs" })];
  const failures = validateSpecCatalog(markup, files);
  if (failures.length > 0) {
    console.error("Spec catalog check failed:");
    for (const failure of failures) console.error(`- ${failure}`);
    process.exit(1);
  }
  const audited = [...markup.matchAll(/\bdata-audit="point-in-time"/g)].length;
  console.log(`Spec catalog check passed (${files.length - 1} classified documents; ${audited} point-in-time audits)`);
}

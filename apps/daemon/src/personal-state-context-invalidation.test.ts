import { expect, test } from "bun:test";
import type { ContextController } from "./context-controller";
import type { LocalPersonalStateJournal } from "@larm/backends";
import { invalidatePersonalStateContext } from "./personal-state-context-invalidation";

test("persists the resolved forget closure before invalidating context and durable views", async () => {
  const events: string[] = [];
  const sourceHandles = new Set(["requested-source"]);
  const descriptor = { sourceHandle: "registered-source" } as never;
  const journal = {
    forget: async () => ({
      resolved: { sourceHandles: [], sourceDigests: ["previous-digest"], viewIds: ["previous-view"] },
    }),
    viewsForSubject: async () => [
      { viewId: "durable-view", dependencies: { contextIds: ["context-1"], sourceDigests: [] } },
      { viewId: "unrelated-view", dependencies: { contextIds: ["other"], sourceDigests: ["other-digest"] } },
    ],
    saveForget: async (value: unknown) => {
      events.push("save-forget");
      expect(value).toMatchObject({ resolved: {
        sourceHandles: ["registered-source", "requested-source"],
        sourceDigests: ["new-digest", "previous-digest"],
        viewIds: ["durable-view", "planned-view", "previous-view"],
      } });
    },
    saveView: async (value: { viewId: string; state: string }) => {
      events.push(`save-view:${value.viewId}:${value.state}`);
    },
  } as unknown as LocalPersonalStateJournal;
  const context = {
    invalidatePersonalState: async (
      _request: unknown,
      onPlanned: (plan: { descriptors: typeof descriptor[]; viewIds: string[]; sourceDigests: string[] }) => Promise<{ viewIds?: string[] } | void>,
    ) => {
      const additions = await onPlanned({
        descriptors: [descriptor],
        viewIds: ["planned-view"],
        sourceDigests: ["new-digest"],
      });
      events.push("commit-context-invalidation");
      return {
        descriptors: [descriptor],
        viewIds: additions?.viewIds ?? ["planned-view"],
        sourceDigests: ["new-digest"],
      };
    },
  } as unknown as ContextController;

  const invalidated = await invalidatePersonalStateContext({
    context,
    journal,
    principal: "principal-1",
    subjectDigest: "subject-1",
    forgetId: "forget-1",
    request: { forgetId: "forget-1", contextIds: ["context-1"], sourceHandles: [], attemptIds: [] } as never,
    sourceHandles,
    initial: { descriptors: [], viewIds: [], sourceDigests: [] },
    nowIso: () => "2026-09-29T00:00:00.000Z",
  });

  expect(invalidated).toMatchObject({
    viewIds: ["durable-view", "planned-view", "previous-view"],
    sourceDigests: ["new-digest"],
  });
  expect(sourceHandles).toEqual(new Set(["requested-source", "registered-source"]));
  expect(events).toEqual([
    "save-forget",
    "commit-context-invalidation",
    "save-view:durable-view:invalid",
  ]);
});

test("does not report context invalidation complete when forget closure persistence fails", async () => {
  const context = {
    invalidatePersonalState: async (_request: unknown, onPlanned: (plan: {
      descriptors: never[]; viewIds: string[]; sourceDigests: string[];
    }) => Promise<unknown>) => {
      await onPlanned({ descriptors: [], viewIds: [], sourceDigests: [] });
      throw new Error("context mutation must not commit");
    },
  } as unknown as ContextController;
  const journal = {
    forget: async () => ({}),
    viewsForSubject: async () => [],
    saveForget: async () => { throw new Error("journal unavailable"); },
    saveView: async () => undefined,
  } as unknown as LocalPersonalStateJournal;

  await expect(invalidatePersonalStateContext({
    context,
    journal,
    principal: "principal-1",
    subjectDigest: "subject-1",
    forgetId: "forget-1",
    request: { forgetId: "forget-1", contextIds: [], sourceHandles: [], attemptIds: [] } as never,
    sourceHandles: new Set<string>(),
    initial: { descriptors: [], viewIds: [], sourceDigests: [] },
    nowIso: () => "2026-09-29T00:00:00.000Z",
  })).rejects.toThrow("journal unavailable");
});

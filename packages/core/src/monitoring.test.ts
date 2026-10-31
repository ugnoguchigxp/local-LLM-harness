import { expect, test } from "bun:test";
import { MonitoringEventStore, MonitoringCursorError } from "./monitoring-events";
import { monitoringSnapshotSchema, monitoringEventsSchema, monitoringErrorSchema, monitoringSample, ageMonitoringView, monitoringContractJsonSchema, type MonitoringEvent } from "./monitoring";

const fact = (kind: MonitoringEvent["kind"] = "request.started"): Omit<MonitoringEvent, "id" | "sequence" | "streamId" | "recordedAt"> => ({
  kind, target: { type: "runtime", id: "r1", nodeId: "n1" }, occurredAt: "2026-10-18T08:30:00.000Z", workId: "work1",
  reasonCode: "accepted", outcome: null, fromState: null, toState: null, countDelta: null, observationInterval: null, source: "daemon-state", sourceEventId: null,
});
test("monitoring contract accepts the agreed examples and rejects fake zero/unknown combinations", async () => {
  expect(await Bun.file(new URL("../../../specs/assets/spatial-monitoring-v1/responses.schema.json", import.meta.url)).json()).toEqual(monitoringContractJsonSchema());
  for (const name of ["snapshot-idle", "snapshot-partial", "snapshot-unsupported", "events-cancelled", "cursor-expired", "epoch-changed"]) {
    const data = await Bun.file(new URL(`../../../specs/assets/spatial-monitoring-v1/${name}.json`, import.meta.url)).json();
    expect(monitoringSnapshotSchema.or(monitoringEventsSchema).or(monitoringErrorSchema).safeParse(data).success).toBe(true);
  }
  const value = monitoringSample("count", "daemon-state", "2026-10-18T08:30:00.000Z", 0);
  const fixture = await Bun.file(new URL("../../../specs/assets/spatial-monitoring-v1/snapshot-idle.json", import.meta.url)).json();
  fixture.core.activeWorkloads = { ...value, status: "unsupported" };
  expect(monitoringSnapshotSchema.safeParse(fixture).success).toBe(false);
  const aged = ageMonitoringView(value, Date.parse("2026-10-18T08:30:11.000Z"));
  expect(aged.status).toBe("stale"); expect(aged.observedAt).toBe(value.observedAt); expect(value.status).toBe("ok");
});
test("event readers independently replay fixed pages while new facts arrive", () => {
  let clock = Date.parse("2026-10-18T08:30:00.000Z"), mono = 0;
  const store = new MonitoringEventStore("epoch-one", { now: () => clock, monotonic: () => mono });
  store.append(fact()); store.append(fact("request.terminal"));
  const first = store.read(undefined, 1), reader2 = store.read(undefined, 1);
  expect(reader2.events).toEqual(first.events); expect(first.hasMore).toBe(true);
  clock += 1000; mono += 1000; store.append(fact());
  const second = store.read(first.nextCursor, 1);
  expect(second.events.map(e => e.sequence)).toEqual(["2"]); expect(second.hasMore).toBe(false);
  expect(store.read(first.nextCursor, 1).events).toEqual(second.events);
  expect(store.read(second.nextCursor).events.map(e => e.sequence)).toEqual(["3"]);
});
test("expiry, capacity loss, restart and tampering are distinct; reads do not consume or prune", () => {
  let mono = 0; const now = () => Date.parse("2026-10-18T08:30:00.000Z") + mono;
  const store = new MonitoringEventStore("epoch-one", { now, monotonic: () => mono });
  const empty = store.read(); store.append(fact()); mono += 600_001;
  expect(() => store.read(empty.nextCursor)).toThrow("monitoring_cursor_expired");
  try { store.read(empty.nextCursor); } catch (e) { expect((e as MonitoringCursorError).status).toBe(410); }
  const next = new MonitoringEventStore("epoch-two", { now, monotonic: () => mono });
  expect(() => next.read(empty.nextCursor)).toThrow("monitoring_epoch_changed");
  const small = new MonitoringEventStore("epoch-small", { now, monotonic: () => mono, maxEvents: 1 });
  const initial = small.read(); small.append(fact()); small.append(fact());
  expect(small.metadata().continuity).toBe("gap"); expect(small.metadata().droppedEventsTotal).toBe("1");
  try { small.read(initial.nextCursor); } catch (e) { expect((e as MonitoringCursorError).reason).toBe("capacity_evicted"); }
  const valid = small.read().nextCursor;
  expect(() => small.read(valid.slice(0, -2) + (valid.endsWith("AA") ? "BB" : "AA"))).toThrow("invalid_request");
  expect(() => small.read(undefined, 0)).toThrow("invalid_request");
});

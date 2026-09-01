import { expect, test } from "bun:test";
import { MutationCoordinator, MutationCoordinatorError } from "./mutation-coordinator";

test("mutation coordinator serializes artifact and runtime mutations", async () => {
  const coordinator = new MutationCoordinator();
  const lease = coordinator.reserve("artifact-stage");
  expect(() => coordinator.reserve("runtime-activation")).toThrow(MutationCoordinatorError);
  expect(coordinator.current()).toBe("artifact-stage");
  const drained = coordinator.drain(1_000);
  lease.release();
  expect(await drained).toBe(true);
  expect(coordinator.current()).toBeUndefined();
});

test("mutation coordinator fails closed after shutdown drain begins", async () => {
  const coordinator = new MutationCoordinator();
  const lease = coordinator.reserve("artifact-stage");
  coordinator.beginDrain();
  expect(() => coordinator.reserve("runtime-activation")).toThrow("draining");
  expect(await coordinator.drain(0)).toBe(false);
  lease.release();
  expect(await coordinator.drain(0)).toBe(true);
});

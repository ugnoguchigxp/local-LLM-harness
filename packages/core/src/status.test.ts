import { expect, test } from "bun:test";
import { deriveStatus, isStartingCondition, type StatusInput } from "./status";
import type { RuntimeStatus } from "./schema";

type Case = {
  name: string;
  input: StatusInput;
  status: RuntimeStatus;
};

const cases: Case[] = [
  {
    name: "health ok is HOT even when service is Unknown",
    input: {
      service: "Unknown",
      listening: true,
      healthOk: true,
      busy: false,
      startingGraceExpired: false,
    },
    status: "HOT",
  },
  {
    name: "fail_on_no_slot 503 is BUSY",
    input: {
      service: "Running",
      listening: true,
      healthOk: true,
      busy: true,
      startingGraceExpired: false,
    },
    status: "BUSY",
  },
  {
    name: "Running and listening without health is STARTING",
    input: {
      service: "Running",
      listening: true,
      healthOk: false,
      busy: false,
      startingGraceExpired: false,
    },
    status: "STARTING",
  },
  {
    name: "Running without listen is STARTING",
    input: {
      service: "Running",
      listening: false,
      healthOk: false,
      busy: false,
      startingGraceExpired: false,
    },
    status: "STARTING",
  },
  {
    name: "listening without health is STARTING when service is Unknown",
    input: {
      service: "Unknown",
      listening: true,
      healthOk: false,
      busy: false,
      startingGraceExpired: false,
    },
    status: "STARTING",
  },
  {
    name: "STARTING past grace is FAILED",
    input: {
      service: "Running",
      listening: true,
      healthOk: false,
      busy: false,
      startingGraceExpired: true,
    },
    status: "FAILED",
  },
  {
    name: "Unknown listening past grace is FAILED",
    input: {
      service: "Unknown",
      listening: true,
      healthOk: false,
      busy: false,
      startingGraceExpired: true,
    },
    status: "FAILED",
  },
  {
    name: "Stopped and closed is COLD",
    input: {
      service: "Stopped",
      listening: false,
      healthOk: false,
      busy: false,
      startingGraceExpired: false,
    },
    status: "COLD",
  },
  {
    name: "Unknown closed without health is COLD",
    input: {
      service: "Unknown",
      listening: false,
      healthOk: false,
      busy: false,
      startingGraceExpired: true,
    },
    status: "COLD",
  },
  {
    name: "NotFound is FAILED",
    input: {
      service: "NotFound",
      listening: false,
      healthOk: false,
      busy: false,
      startingGraceExpired: false,
    },
    status: "FAILED",
  },
  {
    name: "NotFound does not become STARTING even if a port is listening",
    input: {
      service: "NotFound",
      listening: true,
      healthOk: false,
      busy: false,
      startingGraceExpired: false,
    },
    status: "FAILED",
  },
  {
    name: "Stopped leftover listen without health is STARTING",
    input: {
      service: "Stopped",
      listening: true,
      healthOk: false,
      busy: false,
      startingGraceExpired: false,
    },
    status: "STARTING",
  },
];

for (const row of cases) {
  test(row.name, () => {
    expect(deriveStatus(row.input)).toBe(row.status);
  });
}

test("isStartingCondition is false when health is ok", () => {
  expect(
    isStartingCondition({
      service: "Running",
      listening: true,
      healthOk: true,
      busy: false,
    }),
  ).toBe(false);
});

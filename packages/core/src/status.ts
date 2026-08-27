import type { RuntimeStatus, ServiceState } from "./schema";

export type StatusInput = {
  service: ServiceState;
  listening: boolean;
  healthOk: boolean;
  busy: boolean;
  startingGraceExpired: boolean;
};

export function isStartingCondition(input: Omit<StatusInput, "startingGraceExpired">): boolean {
  if (input.healthOk) {
    return false;
  }
  if (input.service === "NotFound") {
    return false;
  }
  return input.service === "Running" || input.listening;
}

export function deriveStatus(input: StatusInput): RuntimeStatus {
  if (input.healthOk && input.busy) {
    return "BUSY";
  }
  if (input.healthOk) {
    return "HOT";
  }
  if (input.service === "NotFound") {
    return "FAILED";
  }
  if (isStartingCondition(input)) {
    return input.startingGraceExpired ? "FAILED" : "STARTING";
  }
  return "COLD";
}

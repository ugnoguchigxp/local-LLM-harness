import type { ContextActivationState, ContextMaterializationMode } from "@larm/core";

export type ContextRuntimeStatus = {
  runtime: string;
  release?: string;
  state: ContextActivationState;
  reason: string;
  modes: ContextMaterializationMode[];
  leaseEpoch: number;
  quota?: {
    sourceTokensUsed: number;
    sourceTokensLimit: number;
    sourceBytesUsed: number;
    sourceBytesLimit: number;
    filesystemFreeFloorBytes: number;
  };
};

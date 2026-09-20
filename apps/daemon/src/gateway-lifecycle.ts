export type GatewayLifecycleState = "starting" | "verifying" | "ready" | "draining" | "failed";

export type GatewayReadiness = {
  state: GatewayLifecycleState;
  ready: boolean;
  changedAt: string;
  reason: string;
  listener?: string;
};

export type GatewayReadinessTransition = {
  from: GatewayLifecycleState;
  to: GatewayLifecycleState;
  reason: string;
  timestamp: string;
  bootEpoch: string;
  configRevision: string;
  listener?: string;
};

export class GatewayLifecycle {
  private current: GatewayReadiness;
  private readonly now: () => number;

  constructor(private readonly options: {
    bootEpoch: string;
    configRevision: string;
    now?: () => number;
    onTransition?: (transition: GatewayReadinessTransition) => void;
  }) {
    this.now = options.now ?? Date.now;
    this.current = {
      state: "starting",
      ready: false,
      changedAt: new Date(this.now()).toISOString(),
      reason: "process_starting",
    };
  }

  snapshot(): GatewayReadiness {
    return { ...this.current };
  }

  listenerBound(listener: string): void {
    if (this.current.state !== "starting") this.invalid("bind listener");
    this.transition("verifying", "listener_bound", listener);
  }

  listenerVerified(): void {
    if (this.current.state !== "verifying") this.invalid("verify listener");
    this.transition("ready", "listener_verified", this.current.listener);
  }

  listenerVerificationFailed(reason: string): void {
    if (this.current.state !== "starting" && this.current.state !== "verifying") {
      this.invalid("fail listener verification");
    }
    this.transition("failed", reason, this.current.listener);
  }

  beginDrain(reason: string): void {
    if (this.current.state === "draining" || this.current.state === "failed") return;
    this.transition("draining", reason, this.current.listener);
  }

  private transition(state: GatewayLifecycleState, reason: string, listener?: string): void {
    const from = this.current.state;
    const timestamp = new Date(this.now()).toISOString();
    this.current = {
      state,
      ready: state === "ready",
      changedAt: timestamp,
      reason,
      ...(listener ? { listener } : {}),
    };
    this.options.onTransition?.({
      from,
      to: state,
      reason,
      timestamp,
      bootEpoch: this.options.bootEpoch,
      configRevision: this.options.configRevision,
      ...(listener ? { listener } : {}),
    });
  }

  private invalid(action: string): never {
    throw new Error(`cannot ${action} while gateway is ${this.current.state}`);
  }
}

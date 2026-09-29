import type { Allocation } from "@larm/core";

type TimerHandle = ReturnType<typeof setTimeout>;
type TimerScheduler = {
  schedule: (callback: () => void, delayMs: number) => TimerHandle;
  clear: (timer: TimerHandle) => void;
};

const systemTimers: TimerScheduler = {
  schedule: (callback, delayMs) => setTimeout(callback, delayMs),
  clear: (timer) => clearTimeout(timer),
};

export class AllocationTimers {
  private readonly allocationTimers = new Map<string, TimerHandle>();
  private idleTimer: TimerHandle | undefined;
  private waitingTimer: TimerHandle | undefined;

  constructor(private readonly timers: TimerScheduler = systemTimers) {}

  scheduleWaitingPromotion(input: {
    draining: boolean;
    hasWaiting: boolean;
    delayMs: number;
    promote: () => void;
  }): void {
    if (input.draining || this.waitingTimer || !input.hasWaiting) return;
    const timer = this.timers.schedule(() => {
      if (this.waitingTimer === timer) this.waitingTimer = undefined;
      input.promote();
    }, input.delayMs);
    timer.unref?.();
    this.waitingTimer = timer;
  }

  cancelWaitingPromotion(): void {
    if (!this.waitingTimer) return;
    this.timers.clear(this.waitingTimer);
    this.waitingTimer = undefined;
  }

  scheduleIdleStop(input: {
    draining: boolean;
    ttlMs: number;
    ids: string[];
    enqueue: (work: () => Promise<void>) => void;
    runStop: (ids: string[]) => Promise<void>;
  }): void {
    if (input.draining) return;
    this.cancelIdle();
    if (input.ttlMs <= 0) {
      input.enqueue(() => input.runStop(input.ids));
      return;
    }
    const timer = this.timers.schedule(() => {
      if (this.idleTimer === timer) this.idleTimer = undefined;
      input.enqueue(() => input.runStop(input.ids));
    }, input.ttlMs);
    this.idleTimer = timer;
    this.idleTimer.unref?.();
  }

  cancelIdle(): void {
    if (!this.idleTimer) return;
    this.timers.clear(this.idleTimer);
    this.idleTimer = undefined;
  }

  scheduleAllocationExpiry(input: {
    id: string;
    expiresAt: string;
    now: number;
    expire: (id: string) => void;
  }): void {
    this.clearAllocationExpiry(input.id);
    const timer = this.timers.schedule(
      () => input.expire(input.id),
      Math.max(0, Date.parse(input.expiresAt) - input.now),
    );
    timer.unref?.();
    this.allocationTimers.set(input.id, timer);
  }

  clearAllocationExpiry(id: string): void {
    const timer = this.allocationTimers.get(id);
    if (!timer) return;
    this.timers.clear(timer);
    this.allocationTimers.delete(id);
  }

  expireDueAllocations(input: {
    allocations: Iterable<Allocation>;
    now: number;
    isActive: (status: Allocation["status"]) => boolean;
    expire: (id: string) => void;
  }): void {
    for (const allocation of input.allocations) {
      if (input.isActive(allocation.status) && Date.parse(allocation.expiresAt) <= input.now) {
        input.expire(allocation.id);
      }
    }
  }
}

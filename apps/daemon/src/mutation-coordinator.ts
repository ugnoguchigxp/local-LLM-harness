export type MutationKind =
  | "artifact-stage"
  | "runtime-activation"
  | "runtime-rollback"
  | "allocation-deployment";

export type MutationLease = {
  kind: MutationKind;
  release(): void;
};

export class MutationCoordinatorError extends Error {
  constructor(
    readonly code: "mutation_in_progress" | "draining",
    message: string,
    readonly activeKind?: MutationKind,
  ) {
    super(message);
    this.name = "MutationCoordinatorError";
  }
}

export class MutationCoordinator {
  private active?: MutationKind;
  private draining = false;
  private readonly waiters = new Set<() => void>();

  reserve(kind: MutationKind): MutationLease {
    if (this.draining) {
      throw new MutationCoordinatorError("draining", "runtime mutation coordinator is draining");
    }
    if (this.active) {
      throw new MutationCoordinatorError(
        "mutation_in_progress",
        `${this.active} is already in progress`,
        this.active,
      );
    }
    this.active = kind;
    let released = false;
    return {
      kind,
      release: () => {
        if (released) return;
        released = true;
        if (this.active === kind) this.active = undefined;
        if (!this.active) {
          for (const resolve of this.waiters) resolve();
          this.waiters.clear();
        }
      },
    };
  }

  current(): MutationKind | undefined {
    return this.active;
  }

  beginDrain(): void {
    this.draining = true;
  }

  async drain(timeoutMs: number): Promise<boolean> {
    if (!this.active) return true;
    return await new Promise<boolean>((resolve) => {
      const complete = () => {
        clearTimeout(timeout);
        resolve(true);
      };
      const timeout = setTimeout(() => {
        this.waiters.delete(complete);
        resolve(false);
      }, Math.max(0, timeoutMs));
      timeout.unref?.();
      this.waiters.add(complete);
    });
  }
}

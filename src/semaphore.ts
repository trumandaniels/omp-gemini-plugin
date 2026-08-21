export class Semaphore {
  readonly limit: number;
  #active = 0;
  #queue: Array<() => void> = [];

  constructor(limit: number) {
    if (!Number.isInteger(limit) || limit <= 0) {
      throw new Error("Semaphore limit must be a positive integer");
    }
    this.limit = limit;
  }

  get active(): number {
    return this.#active;
  }

  get pending(): number {
    return this.#queue.length;
  }

  async acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) throw signal.reason ?? new Error("Aborted");

    if (this.#active < this.limit) {
      this.#active += 1;
      return this.#makeRelease();
    }

    await new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        const index = this.#queue.indexOf(wake);
        if (index >= 0) this.#queue.splice(index, 1);
        reject(signal?.reason ?? new Error("Aborted"));
      };
      const wake = () => {
        signal?.removeEventListener("abort", onAbort);
        this.#active += 1;
        resolve();
      };
      this.#queue.push(wake);
      signal?.addEventListener("abort", onAbort, { once: true });
    });

    return this.#makeRelease();
  }

  #makeRelease(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#active -= 1;
      const next = this.#queue.shift();
      next?.();
    };
  }
}

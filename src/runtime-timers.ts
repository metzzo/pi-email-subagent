import { MAX_TIMER_DELAY_MS } from "./config.ts";

export function runtimeSafeDelay(ms: number): number {
  if (!Number.isFinite(ms)) return MAX_TIMER_DELAY_MS;
  return Math.max(0, Math.min(MAX_TIMER_DELAY_MS, Math.ceil(ms)));
}

/** Sum lifecycle phases as an absolute duration; callers must use a chunked deadline. */
export function lifecycleDuration(...parts: readonly number[]): number {
  let total = 0;
  for (const part of parts) {
    if (!Number.isFinite(part) || part < 0) throw new Error("Lifecycle duration must be a finite non-negative number.");
    total += part;
    if (!Number.isSafeInteger(total)) throw new Error("Lifecycle duration exceeds the safe integer range.");
  }
  return total;
}

export interface DeadlineSignal {
  promise: Promise<void>;
  cancel(): void;
}

/**
 * Represent an absolute duration with one or more Node-safe timer chunks.
 * Chunking preserves the requested deadline instead of clamping long sums.
 */
export function deadlineSignal(timeoutMs: number, options: { unref?: boolean } = {}): DeadlineSignal {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0 || !Number.isSafeInteger(timeoutMs)) {
    throw new Error("Timer deadline must be a finite non-negative safe integer.");
  }
  const deadline = Date.now() + timeoutMs;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancelled = false;
  let resolvePromise!: () => void;
  const promise = new Promise<void>((resolve) => { resolvePromise = resolve; });
  const arm = (): void => {
    if (cancelled) return;
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      resolvePromise();
      return;
    }
    timer = setTimeout(arm, runtimeSafeDelay(remaining));
    if (options.unref) timer.unref?.();
  };
  arm();
  return {
    promise,
    cancel() {
      cancelled = true;
      if (timer) clearTimeout(timer);
      timer = undefined;
    },
  };
}

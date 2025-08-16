/**
 * Time source for all limiters, in milliseconds.
 *
 * Limiters only ever compare two readings of the same clock, so the origin does not matter;
 * what matters is that it never jumps. `Date.now()` follows the wall clock and can move
 * backwards or forwards when the system time is adjusted (NTP, manual change), which would
 * reset windows early or keep them closed. `performance.now()` is monotonic.
 */
export interface Clock {
  now(): number;
}

export class MonotonicClock implements Clock {
  now(): number {
    return performance.now();
  }
}

/** A clock that only moves when told to. Used by tests and the deterministic simulator. */
export class ManualClock implements Clock {
  #now: number;

  constructor(startMs = 0) {
    this.#now = startMs;
  }

  now(): number {
    return this.#now;
  }

  advance(ms: number): void {
    if (ms < 0) throw new RangeError('ManualClock cannot go backwards');
    this.#now += ms;
  }

  set(ms: number): void {
    if (ms < this.#now) throw new RangeError('ManualClock cannot go backwards');
    this.#now = ms;
  }
}

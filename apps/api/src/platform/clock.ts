// Time is passed in, never read from the system inside business logic, so
// tests can move it (refund windows, retries and leases all depend on it).

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

export class FakeClock implements Clock {
  #at: Date;
  constructor(start: Date | string) {
    this.#at = new Date(start);
  }
  now(): Date {
    return new Date(this.#at);
  }
  advance(ms: number): void {
    this.#at = new Date(this.#at.getTime() + ms);
  }
  set(to: Date | string): void {
    this.#at = new Date(to);
  }
}

export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

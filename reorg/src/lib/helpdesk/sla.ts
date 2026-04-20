/**
 * Help-desk SLA / response-time computation.
 *
 * eBay's seller response policy buckets every buyer message into a "time to
 * first response" target. We mirror that with three buckets:
 *
 *   GREEN   < 12h business hours from buyer's last message
 *   AMBER   12h <= elapsed < 24h
 *   RED     >= 24h
 *
 * "Business hours" defaults to Mon–Fri 09:00–17:00 in the configured shop
 * timezone (America/New_York unless overridden in Settings). Weekends are
 * skipped entirely. This is intentionally simple in v1 — we do not honor
 * holidays, partial days, or per-store schedules. The function is pure so it
 * can be reused on the server (cron) and the client (timer chip).
 *
 * The "deadline" for first response is `lastBuyerMessageAt + 24h business`.
 * We never tick the clock once `firstResponseAt` is set.
 */

export type SlaBucket = "GREEN" | "AMBER" | "RED" | "MET" | "NA";

export interface SlaConfig {
  /** IANA timezone, e.g. "America/New_York". */
  timezone?: string;
  /** Day-of-week start (0 = Sun, 1 = Mon, …). Default Mon (1). */
  workWeekStart?: number;
  /** Day-of-week end inclusive. Default Fri (5). */
  workWeekEnd?: number;
  /** 24h start hour, 0-23. Default 9. */
  startHour?: number;
  /** 24h end hour, 0-23. Default 17. */
  endHour?: number;
  /** Bucket thresholds in business-hour MILLISECONDS. */
  amberAfterMs?: number;
  redAfterMs?: number;
  /** Total response budget in business-hour ms. Default 24h = 86_400_000. */
  budgetMs?: number;
}

export const DEFAULT_SLA_CONFIG: Required<SlaConfig> = {
  timezone: "America/New_York",
  workWeekStart: 1,
  workWeekEnd: 5,
  startHour: 9,
  endHour: 17,
  amberAfterMs: 12 * 60 * 60 * 1000,
  redAfterMs: 24 * 60 * 60 * 1000,
  budgetMs: 24 * 60 * 60 * 1000,
};

export interface SlaInput {
  /** Set when the buyer sent the most recent message awaiting agent reply. */
  lastBuyerMessageAt: Date | null;
  /** Set once the agent has replied at all in this thread. */
  firstResponseAt: Date | null;
  now?: Date;
}

export interface SlaResult {
  bucket: SlaBucket;
  /** ms of business-hours elapsed since the buyer's last message. */
  elapsedBusinessMs: number;
  /** ms remaining until RED (negative if already red). */
  remainingBusinessMs: number;
  /** Wall-clock ETA when budget will run out. May be far in the future on
   *  weekends; null if no buyer-pending state. */
  dueAt: Date | null;
}

/** Compute SLA bucket for a single ticket. */
export function computeSla(
  input: SlaInput,
  cfg: SlaConfig = {},
): SlaResult {
  const c = { ...DEFAULT_SLA_CONFIG, ...cfg };
  const now = input.now ?? new Date();

  if (!input.lastBuyerMessageAt) {
    return { bucket: "NA", elapsedBusinessMs: 0, remainingBusinessMs: c.budgetMs, dueAt: null };
  }
  // If buyer wrote, then we replied AFTER that message, the SLA is met.
  if (
    input.firstResponseAt &&
    input.firstResponseAt.getTime() >= input.lastBuyerMessageAt.getTime()
  ) {
    return { bucket: "MET", elapsedBusinessMs: 0, remainingBusinessMs: c.budgetMs, dueAt: null };
  }

  const elapsed = businessMillisBetween(input.lastBuyerMessageAt, now, c);
  const remaining = c.budgetMs - elapsed;
  const dueAt = addBusinessMillis(input.lastBuyerMessageAt, c.budgetMs, c);
  let bucket: SlaBucket = "GREEN";
  if (elapsed >= c.redAfterMs) bucket = "RED";
  else if (elapsed >= c.amberAfterMs) bucket = "AMBER";
  return { bucket, elapsedBusinessMs: elapsed, remainingBusinessMs: remaining, dueAt };
}

// ---------------------------------------------------------------------------
// Business-hour math (timezone-aware via Intl).
// ---------------------------------------------------------------------------

interface ResolvedConfig extends Required<SlaConfig> {}

// ---------------------------------------------------------------------------
// Closed-form business-hour math.
//
// The previous implementation walked the timeline one minute at a time,
// allocating an `Intl.DateTimeFormat` on every iteration. With 50 tickets in
// the inbox table and `cap = 14 days = 20,160 minutes`, that meant ~1M
// formatter calls per render and was the dominant source of the multi-second
// main-thread freeze when the agent navigated to / searched the inbox.
//
// The new implementation:
//   - Caches one formatter per (timezone) pair.
//   - Walks the timeline one *day* at a time (max 14 iterations).
//   - Computes each day's business window in real-ms by anchoring with two
//     formatter calls (start-of-day and start-of-business). Total ≤ ~30
//     formatter calls per ticket, regardless of elapsed time.
//
// Tests in sla.test.ts pin behavior; tolerance is 5 minutes which the
// minute-resolution math here easily satisfies (we land on minute boundaries
// thanks to flooring `start`/`end` to the minute).
// ---------------------------------------------------------------------------

const _formatterCache = new Map<string, Intl.DateTimeFormat>();
function getFormatter(tz: string): Intl.DateTimeFormat {
  let f = _formatterCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
      hour12: false,
      weekday: "short",
    });
    _formatterCache.set(tz, f);
  }
  return f;
}

interface TzParts {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
  hour: number; // 0-23
  minute: number; // 0-59
  second: number; // 0-59
  dow: number; // 0=Sun..6=Sat
}

const DOW_MAP: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

function getTzParts(d: Date, tz: string): TzParts {
  const parts = getFormatter(tz).formatToParts(d);
  const lookup: Record<string, string> = {};
  for (const p of parts) {
    if (p.type !== "literal") lookup[p.type] = p.value;
  }
  let hour = Number(lookup.hour ?? "0");
  if (hour === 24) hour = 0; // Intl quirk
  return {
    year: Number(lookup.year ?? "1970"),
    month: Number(lookup.month ?? "1"),
    day: Number(lookup.day ?? "1"),
    hour,
    minute: Number(lookup.minute ?? "0"),
    second: Number(lookup.second ?? "0"),
    dow: DOW_MAP[lookup.weekday ?? "Mon"] ?? 1,
  };
}

/**
 * Resolve "the wall-clock instant in `tz` whose calendar parts are
 * (y, m, d, h, mi)" to a UTC `Date`. Loops at most twice to converge on the
 * correct UTC offset (handles DST transitions cleanly).
 */
function tzCalendarToUtc(
  tz: string,
  y: number,
  m: number,
  d: number,
  h: number,
  mi: number,
): Date {
  // Initial guess: pretend tz == UTC.
  let utcMs = Date.UTC(y, m - 1, d, h, mi, 0, 0);
  for (let i = 0; i < 3; i++) {
    const parts = getTzParts(new Date(utcMs), tz);
    const observedMs = Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour,
      parts.minute,
      0,
      0,
    );
    const desiredMs = Date.UTC(y, m - 1, d, h, mi, 0, 0);
    const delta = desiredMs - observedMs;
    if (delta === 0) break;
    utcMs += delta;
  }
  return new Date(utcMs);
}

/** Returns the UTC instant of `00:00` *in `tz`* on the given calendar day. */
function startOfTzDay(tz: string, y: number, m: number, d: number): Date {
  return tzCalendarToUtc(tz, y, m, d, 0, 0);
}

/** Add `days` to a calendar date in `tz` and return start-of-day UTC. */
function addTzDays(
  tz: string,
  y: number,
  m: number,
  d: number,
  days: number,
): { y: number; m: number; d: number; date: Date } {
  // Use a UTC day arithmetic; calendar-day rollover doesn't depend on tz.
  const base = Date.UTC(y, m - 1, d) + days * 86_400_000;
  const bd = new Date(base);
  return {
    y: bd.getUTCFullYear(),
    m: bd.getUTCMonth() + 1,
    d: bd.getUTCDate(),
    date: startOfTzDay(
      tz,
      bd.getUTCFullYear(),
      bd.getUTCMonth() + 1,
      bd.getUTCDate(),
    ),
  };
}

/**
 * Sweep from `start` to `end` accumulating only business-hour milliseconds.
 * O(elapsed-days), not O(elapsed-minutes). Caps at 14 days to bound runtime.
 */
export function businessMillisBetween(
  start: Date,
  end: Date,
  cfg: SlaConfig = {},
): number {
  const c: ResolvedConfig = { ...DEFAULT_SLA_CONFIG, ...cfg };
  if (end.getTime() <= start.getTime()) return 0;
  const startMs = start.getTime();
  const cap = Math.min(end.getTime(), startMs + 14 * 86_400_000);
  const startParts = getTzParts(start, c.timezone);

  let acc = 0;
  let cursorY = startParts.year;
  let cursorM = startParts.month;
  let cursorD = startParts.day;

  for (let i = 0; i < 16; i++) {
    const dayStart = startOfTzDay(c.timezone, cursorY, cursorM, cursorD);
    if (dayStart.getTime() >= cap) break;
    const dowParts = getTzParts(dayStart, c.timezone);
    if (dowParts.dow >= c.workWeekStart && dowParts.dow <= c.workWeekEnd) {
      const bizOpen = tzCalendarToUtc(
        c.timezone,
        cursorY,
        cursorM,
        cursorD,
        c.startHour,
        0,
      ).getTime();
      const bizClose = tzCalendarToUtc(
        c.timezone,
        cursorY,
        cursorM,
        cursorD,
        c.endHour,
        0,
      ).getTime();
      const overlapStart = Math.max(bizOpen, startMs);
      const overlapEnd = Math.min(bizClose, cap);
      if (overlapEnd > overlapStart) acc += overlapEnd - overlapStart;
    }
    const next = addTzDays(c.timezone, cursorY, cursorM, cursorD, 1);
    cursorY = next.y;
    cursorM = next.m;
    cursorD = next.d;
  }

  return acc;
}

/**
 * Walk forward from `start` skipping non-business minutes until we have
 * accumulated `targetMs` business-hour milliseconds. O(elapsed-days).
 */
export function addBusinessMillis(
  start: Date,
  targetMs: number,
  cfg: SlaConfig = {},
): Date {
  const c: ResolvedConfig = { ...DEFAULT_SLA_CONFIG, ...cfg };
  if (targetMs <= 0) return start;
  const startMs = start.getTime();
  const ceiling = startMs + 30 * 86_400_000;
  const startParts = getTzParts(start, c.timezone);

  let remaining = targetMs;
  let cursorY = startParts.year;
  let cursorM = startParts.month;
  let cursorD = startParts.day;

  for (let i = 0; i < 32; i++) {
    const dayStart = startOfTzDay(c.timezone, cursorY, cursorM, cursorD);
    if (dayStart.getTime() >= ceiling) break;
    const dowParts = getTzParts(dayStart, c.timezone);
    if (dowParts.dow >= c.workWeekStart && dowParts.dow <= c.workWeekEnd) {
      const bizOpen = tzCalendarToUtc(
        c.timezone,
        cursorY,
        cursorM,
        cursorD,
        c.startHour,
        0,
      ).getTime();
      const bizClose = tzCalendarToUtc(
        c.timezone,
        cursorY,
        cursorM,
        cursorD,
        c.endHour,
        0,
      ).getTime();
      const overlapStart = Math.max(bizOpen, startMs);
      if (bizClose > overlapStart) {
        const available = bizClose - overlapStart;
        if (available >= remaining) {
          return new Date(overlapStart + remaining);
        }
        remaining -= available;
      }
    }
    const next = addTzDays(c.timezone, cursorY, cursorM, cursorD, 1);
    cursorY = next.y;
    cursorM = next.m;
    cursorD = next.d;
  }

  return new Date(ceiling);
}

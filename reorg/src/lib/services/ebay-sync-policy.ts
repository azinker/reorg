const PEAK_START_HOUR = 9;
const PEAK_END_HOUR = 16;
const QUIET_START_HOUR = 22;
const BASE_GETITEM_RESERVE_MIN = 500;
const BASE_GETITEM_RESERVE_RATIO = 0.2;
const TARGETED_REFRESH_RESERVE_PER_STORE = 200;
const TARGETED_REFRESH_RESERVE_RATIO = 0.08;

export type EbayPullWindow = "peak" | "shoulder" | "quiet";

function getHourInTimeZone(date: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "numeric",
    hourCycle: "h23",
  }).formatToParts(date);
  const hour = parts.find((part) => part.type === "hour")?.value;
  return hour ? parseInt(hour, 10) : date.getHours();
}

function getMinuteInTimeZone(date: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    minute: "numeric",
  }).formatToParts(date);
  const minute = parts.find((part) => part.type === "minute")?.value;
  return minute ? parseInt(minute, 10) : date.getMinutes();
}

function getLocalDateTimeParts(date: Date, timeZone: string) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = formatter.formatToParts(date);
  const value = (type: string) =>
    Number(parts.find((part) => part.type === type)?.value ?? "0");
  return {
    year: value("year"),
    month: value("month"),
    day: value("day"),
    hour: value("hour"),
    minute: value("minute"),
    second: value("second"),
  };
}

function getTimeZoneOffsetMs(date: Date, timeZone: string) {
  const parts = getLocalDateTimeParts(date, timeZone);
  const asUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  return asUtc - date.getTime();
}

function zonedDateTimeToUtc(
  timeZone: string,
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second = 0,
) {
  const utcGuess = Date.UTC(year, month - 1, day, hour, minute, second);
  const offset = getTimeZoneOffsetMs(new Date(utcGuess), timeZone);
  return new Date(utcGuess - offset);
}

function addDaysToParts(
  parts: ReturnType<typeof getLocalDateTimeParts>,
  days: number,
  timeZone: string,
) {
  const baseUtc = zonedDateTimeToUtc(
    timeZone,
    parts.year,
    parts.month,
    parts.day,
    12,
    0,
    0,
  );
  baseUtc.setUTCDate(baseUtc.getUTCDate() + days);
  return getLocalDateTimeParts(baseUtc, timeZone);
}

export function getEbayPullWindow(date: Date, timeZone: string): EbayPullWindow {
  const hour = getHourInTimeZone(date, timeZone);
  if (hour >= PEAK_START_HOUR && hour < PEAK_END_HOUR) return "peak";
  if (hour >= PEAK_END_HOUR && hour < QUIET_START_HOUR) return "shoulder";
  return "quiet";
}

export function getEbayAutoSyncIntervalMinutes(date: Date, timeZone: string) {
  const window = getEbayPullWindow(date, timeZone);
  if (window === "peak") return 30;
  if (window === "shoulder") return 60;
  return null;
}

export function formatEbayAutoSyncSchedule() {
  return "Every 30m from 9:00-16:00, every 1h from 16:00-22:00, paused overnight";
}

export function getNextEbayAutoSyncAt(now: Date, timeZone: string) {
  const parts = getLocalDateTimeParts(now, timeZone);
  const window = getEbayPullWindow(now, timeZone);
  const hour = parts.hour;
  const minute = parts.minute;

  if (window === "peak") {
    const nextMinute = minute < 30 ? 30 : 60;
    if (nextMinute === 60) {
      if (hour + 1 < PEAK_END_HOUR) {
        return zonedDateTimeToUtc(
          timeZone,
          parts.year,
          parts.month,
          parts.day,
          hour + 1,
          0,
          0,
        );
      }
      return zonedDateTimeToUtc(
        timeZone,
        parts.year,
        parts.month,
        parts.day,
        PEAK_END_HOUR,
        0,
        0,
      );
    }

    return zonedDateTimeToUtc(
      timeZone,
      parts.year,
      parts.month,
      parts.day,
      hour,
      nextMinute,
      0,
    );
  }

  if (window === "shoulder") {
    if (hour + 1 < QUIET_START_HOUR) {
      return zonedDateTimeToUtc(
        timeZone,
        parts.year,
        parts.month,
        parts.day,
        hour + 1,
        0,
        0,
      );
    }
  }

  const nextDayParts =
    hour >= QUIET_START_HOUR
      ? addDaysToParts(parts, 1, timeZone)
      : parts;

  return zonedDateTimeToUtc(
    timeZone,
    nextDayParts.year,
    nextDayParts.month,
    nextDayParts.day,
    PEAK_START_HOUR,
    0,
    0,
  );
}

export function getRemainingEbayWeightedStoreRuns(
  now: Date,
  timeZone: string,
  sharedStoreCount: number,
) {
  const hour = getHourInTimeZone(now, timeZone);
  const minute = getMinuteInTimeZone(now, timeZone);
  const decimalHour = hour + minute / 60;
  const currentWindow = getEbayPullWindow(now, timeZone);
  const currentWeight = currentWindow === "peak" ? 2 : currentWindow === "shoulder" ? 1 : 0;

  if (currentWindow === "quiet") {
    return {
      currentWeight,
      weightedRunsRemaining: 0,
    };
  }

  const peakHoursRemaining = Math.max(0, PEAK_END_HOUR - Math.max(decimalHour, PEAK_START_HOUR));
  const shoulderHoursRemaining = Math.max(0, QUIET_START_HOUR - Math.max(decimalHour, PEAK_END_HOUR));

  const peakRunsRemainingPerStore = Math.max(0, Math.ceil((peakHoursRemaining * 60) / 30));
  const shoulderRunsRemainingPerStore = Math.max(0, Math.ceil(shoulderHoursRemaining));

  return {
    currentWeight,
    weightedRunsRemaining:
      peakRunsRemainingPerStore * sharedStoreCount * 2 +
      shoulderRunsRemainingPerStore * sharedStoreCount,
  };
}

export function getPerRunEbayGetItemBudget(args: {
  remaining: number;
  limit: number;
  now: Date;
  timeZone: string;
  sharedStoreCount: number;
}) {
  const reserve = getReservedEbayGetItemCalls(
    args.limit,
    args.sharedStoreCount,
  );
  const usableRemaining = Math.max(0, args.remaining - reserve);
  const { currentWeight, weightedRunsRemaining } = getRemainingEbayWeightedStoreRuns(
    args.now,
    args.timeZone,
    args.sharedStoreCount,
  );

  if (usableRemaining <= 0 || currentWeight <= 0 || weightedRunsRemaining <= 0) {
    return 0;
  }

  const weightedShare = Math.floor(
    (usableRemaining * currentWeight) / weightedRunsRemaining,
  );
  const minimumBudget = Math.min(25, usableRemaining);
  return Math.max(minimumBudget, Math.min(usableRemaining, weightedShare));
}

export function getReservedEbayGetItemCalls(
  limit: number,
  sharedStoreCount: number,
) {
  const baseReserve = getBaseEbayGetItemReserve(limit);
  const targetedRefreshReserve = getTargetedRefreshReserve(
    limit,
    sharedStoreCount,
  );

  return baseReserve + targetedRefreshReserve;
}

export function getBaseEbayGetItemReserve(limit: number) {
  return Math.max(
    BASE_GETITEM_RESERVE_MIN,
    Math.floor(limit * BASE_GETITEM_RESERVE_RATIO),
  );
}

export function getTargetedRefreshReserve(
  limit: number,
  sharedStoreCount: number,
) {
  return Math.max(
    sharedStoreCount * TARGETED_REFRESH_RESERVE_PER_STORE,
    Math.floor(limit * TARGETED_REFRESH_RESERVE_RATIO),
  );
}

export function getFallbackPerRunEbayGetItemBudget(
  now: Date,
  timeZone: string,
) {
  const window = getEbayPullWindow(now, timeZone);
  if (window === "peak") return 100;
  if (window === "shoulder") return 60;
  return 0;
}

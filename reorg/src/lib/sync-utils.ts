import type { CompletionTone, IntegrationSyncState, SyncJobInfo, SyncProfile } from "@/lib/sync-types";

export function formatDurationMs(ms: number) {
  if (!Number.isFinite(ms) || ms <= 0) return "0s";
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

export function formatRelativeTime(value: string | null, nowMs: number) {
  if (!value) return "Never";
  const diffMs = nowMs - new Date(value).getTime();
  if (diffMs < 0) return "Just now";
  const minutes = Math.floor(diffMs / 60000);
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  const rem = minutes % 60;
  if (hours < 24) return rem > 0 ? `${hours}h ${rem}m ago` : `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function getJobDurationMs(job: SyncJobInfo | null, now: number) {
  if (!job?.startedAt) return null;
  const startedAt = new Date(job.startedAt).getTime();
  const finishedAt = job.completedAt ? new Date(job.completedAt).getTime() : now;
  if (!Number.isFinite(startedAt) || !Number.isFinite(finishedAt)) return null;
  return Math.max(0, finishedAt - startedAt);
}

export function getRelevantFallbackReason(
  profile: SyncProfile,
  syncState: IntegrationSyncState | null | undefined,
) {
  if (!syncState?.lastFallbackReason) return null;
  if (profile.preferredMode === "full" && syncState.lastEffectiveMode === "full") return null;
  return syncState.lastFallbackReason;
}

export function getCompletionSummary(
  job: SyncJobInfo | null,
  fallbackReason: string | null,
): { label: string; tone: CompletionTone; detail: string } {
  if (!job) return { label: "No sync yet", tone: "info", detail: "Run a sync to pull data from this store." };
  const issueCount = Array.isArray(job.errors) ? job.errors.length : 0;
  if (job.status === "RUNNING") return { label: "Syncing", tone: "info", detail: "Pull is in progress." };
  if (job.status === "FAILED") {
    return {
      label: "Failed",
      tone: "error",
      detail: issueCount > 0
        ? `${issueCount} issue${issueCount === 1 ? "" : "s"} blocked completion.`
        : "Last pull did not complete.",
    };
  }
  if (issueCount > 0) {
    return {
      label: "Completed with issues",
      tone: "warning",
      detail: `Done, but ${issueCount} row${issueCount === 1 ? "" : "s"} had issues.`,
    };
  }
  return {
    label: "Complete",
    tone: "success",
    detail: fallbackReason ? "Completed with safe fallback." : "All items synced successfully.",
  };
}

function getLocalDateTimeParts(date: Date, timeZone: string) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone, hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const parts = formatter.formatToParts(date);
  const v = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? "0");
  return { year: v("year"), month: v("month"), day: v("day"), hour: v("hour"), minute: v("minute"), second: v("second") };
}

function getTimeZoneOffsetMs(date: Date, timeZone: string) {
  const p = getLocalDateTimeParts(date, timeZone);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - date.getTime();
}

function zonedDateTimeToUtc(tz: string, y: number, mo: number, d: number, h: number, mi: number, s = 0) {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  return new Date(guess - getTimeZoneOffsetMs(new Date(guess), tz));
}

function addDaysToParts(parts: ReturnType<typeof getLocalDateTimeParts>, days: number, tz: string) {
  const b = zonedDateTimeToUtc(tz, parts.year, parts.month, parts.day, 12, 0, 0);
  b.setUTCDate(b.getUTCDate() + days);
  return getLocalDateTimeParts(b, tz);
}

export function getNextPullAt(profile: SyncProfile, now: Date, _platform?: string) {
  if (!profile.autoSyncEnabled) return null;

  const nowParts = getLocalDateTimeParts(now, profile.timezone);
  const candidates: Date[] = [];

  for (let dayOffset = 0; dayOffset <= 2; dayOffset += 1) {
    const dayParts = addDaysToParts(nowParts, dayOffset, profile.timezone);

    for (let m = profile.dayStartHour * 60; m < profile.dayEndHour * 60; m += profile.dayIntervalMinutes) {
      candidates.push(zonedDateTimeToUtc(profile.timezone, dayParts.year, dayParts.month, dayParts.day, Math.floor(m / 60), m % 60));
    }

    const overnightEnd = profile.dayStartHour * 60 + 24 * 60;
    for (let m = profile.dayEndHour * 60; m < overnightEnd; m += profile.overnightIntervalMinutes) {
      const tp = m >= 24 * 60 ? addDaysToParts(dayParts, 1, profile.timezone) : dayParts;
      const nm = m % (24 * 60);
      candidates.push(zonedDateTimeToUtc(profile.timezone, tp.year, tp.month, tp.day, Math.floor(nm / 60), nm % 60));
    }
  }

  const nowTime = now.getTime();
  return candidates.filter((c) => c.getTime() > nowTime).sort((a, b) => a.getTime() - b.getTime())[0] ?? null;
}

export function formatCountdown(target: Date | null, now: number) {
  if (!target) return "\u2014";
  const remaining = target.getTime() - now;
  if (remaining <= 0) return "Due now";
  const totalSeconds = Math.floor(remaining / 1000);
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  return `${m}m ${s}s`;
}

export function formatSchedule(profile: SyncProfile, _platform?: string) {
  const overnightWindowMinutes = (24 - profile.dayEndHour + profile.dayStartHour) * 60;
  const overnightLabel =
    profile.overnightIntervalMinutes >= overnightWindowMinutes ? "Once overnight"
      : profile.overnightIntervalMinutes >= 60 && profile.overnightIntervalMinutes % 60 === 0
        ? `Every ${profile.overnightIntervalMinutes / 60}h overnight`
        : `Every ${profile.overnightIntervalMinutes}m overnight`;
  const daytimeLabel =
    profile.dayIntervalMinutes >= 60 && profile.dayIntervalMinutes % 60 === 0
      ? `Every ${profile.dayIntervalMinutes / 60}h`
      : `Every ${profile.dayIntervalMinutes}m`;
  return `${daytimeLabel} (${profile.dayStartHour}:00\u2013${profile.dayEndHour}:00), ${overnightLabel}`;
}

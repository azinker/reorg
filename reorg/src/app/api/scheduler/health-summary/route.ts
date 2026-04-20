/**
 * Lightweight scheduler-health endpoint used by the global Sidebar to power
 * the "sync issues" badge.
 *
 * WHY THIS EXISTS
 * ────────────────
 * The full `/api/scheduler/status` route returns ~50 KB of JSON
 * (recentJobs, recentWebhooks, automationEvents, integrationHealth, the
 * full `upcoming` plan, etc.) and on cold Vercel instances takes 15-25
 * seconds because it queries 5 000 audit-log rows and hits the live eBay
 * Trading API for rate-limit snapshots.
 *
 * The sidebar uses **only** the small `healthSummary` object out of all
 * that. Returning the entire payload was triggering:
 *   - A multi-second blocking task in the browser when JSON-parsing the
 *     50 KB response.
 *   - 3 simultaneous 20 s requests on every page mount (two duplicate
 *     useEffects in the sidebar × cold-start dedup misses).
 *
 * This route returns ONLY the summary. It uses its OWN cache key
 * (not the one `/api/scheduler/status` uses) so the Sync page's
 * behavior is completely unaffected. Badge math stays identical to the
 * Sync page because both routes call the same `buildAutomationHealthSnapshot`
 * function — they just memoize the result independently.
 *
 * Keep this endpoint surgical — DO NOT add fields here. If a feature
 * needs more scheduler state, hit `/api/scheduler/status` from that
 * specific feature page instead of bloating this one.
 */

import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { buildAutomationHealthSnapshot } from "@/lib/services/automation-health";
import { planScheduledSyncs } from "@/lib/services/sync-scheduler";
import { getServerCachedValue } from "@/lib/server-cache";

async function buildHealthSummary() {
  const plan = await planScheduledSyncs();
  const snapshot = await buildAutomationHealthSnapshot(plan);
  return snapshot.summary;
}

export async function GET() {
  try {
    // Cached for 60 s — the sidebar polls every 5 min and the previous
    // server cache was only 15 s, which meant most polls (and certainly
    // the duplicate-on-mount calls) re-ran the full heavy snapshot.
    const summary = await getServerCachedValue({
      key: "api:scheduler-health-summary",
      ttlMs: 60_000,
      loader: buildHealthSummary,
    });
    return NextResponse.json({ data: summary });
  } catch (error) {
    console.error("[scheduler/health-summary] GET failed", error);
    return NextResponse.json(
      { error: "Failed to fetch scheduler health summary" },
      { status: 500 },
    );
  }
}

// db is imported so the route stays in the Node.js runtime (matches the
// rest of /api/scheduler/*); reference it once to keep the bundler honest.
void db;

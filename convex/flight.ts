import { action, internalAction, internalMutation, mutation, query } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";

const ICAO24 = "44bb57";
const CALLSIGN = "OO-NZW";

type AcRecord = {
  hex?: string;
  flight?: string;
  r?: string;
  alt_baro?: number | string;
  gs?: number;
  track?: number;
  lat?: number;
  lon?: number;
  squawk?: string;
  emergency?: string;
  on_ground?: boolean | number;
  ground?: boolean | number;
};

// Resolve callsign / registration / ICAO24 → { icao24, label }
export const resolveAircraft = action({
  args: { query: v.string() },
  handler: async (_ctx, args): Promise<{ icao24: string; label: string } | null> => {
    const q = args.query.trim();
    // 6-char hex → direct ICAO24
    if (/^[0-9a-fA-F]{6}$/.test(q)) {
      return { icao24: q.toLowerCase(), label: q.toUpperCase() };
    }
    // Try callsign search
    const callsign = q.toUpperCase().replace(/\s/g, "");
    const csRes = await fetch(`https://api.adsb.lol/v2/callsign/${encodeURIComponent(callsign)}`, {
      headers: { Accept: "application/json" },
    });
    if (csRes.ok) {
      const csData = await csRes.json() as { ac?: AcRecord[] };
      const ac = csData?.ac?.[0];
      if (ac?.hex) return { icao24: ac.hex.toLowerCase(), label: callsign };
    }
    // Try registration search
    const regRes = await fetch(`https://api.adsb.lol/v2/reg/${encodeURIComponent(q.toUpperCase())}`, {
      headers: { Accept: "application/json" },
    });
    if (regRes.ok) {
      const regData = await regRes.json() as { ac?: AcRecord[] };
      const ac = regData?.ac?.[0];
      if (ac?.hex) {
        const label = (ac.r ?? q).toUpperCase();
        return { icao24: ac.hex.toLowerCase(), label };
      }
    }
    return null;
  },
});

type LiveData = {
  found: boolean;
  onGround: boolean;
  altitude: number | null;
  speed: number | null;
  heading: number | null;
  lat: number | null;
  lon: number | null;
  squawk: string | null;
  emergency: string | null;
  timestamp: number;
};

// Fetch live flight data from adsb.lol — optional icao24 override for custom tracking
export const fetchLiveData = action({
  args: { icao24Override: v.optional(v.string()) },
  handler: async (_ctx, args): Promise<LiveData> => fetchAdsb(args.icao24Override ?? ICAO24),
});

// Background check (cron): records Frances Dell's state even when no one has the app open.
// Only active Friday–Sunday (Vienna time), per the owner's request.
function isWeekendInVienna(now: Date): boolean {
  const day = new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: "Europe/Vienna" }).format(now);
  return day === "Fri" || day === "Sat" || day === "Sun";
}

export const backgroundCheck = internalAction({
  args: {},
  handler: async (ctx): Promise<null> => {
    if (!isWeekendInVienna(new Date())) return null;
    const result = await fetchAdsb(ICAO24).catch(() => null);
    if (!result) return null;
    await ctx.runMutation(internal.flight.recordBackgroundState, result);
    return null;
  },
});

export const recordBackgroundState = internalMutation({
  args: {
    found: v.boolean(),
    onGround: v.boolean(),
    altitude: v.union(v.number(), v.null()),
    speed: v.union(v.number(), v.null()),
    heading: v.union(v.number(), v.null()),
    lat: v.union(v.number(), v.null()),
    lon: v.union(v.number(), v.null()),
    squawk: v.union(v.string(), v.null()),
    emergency: v.union(v.string(), v.null()),
    timestamp: v.number(),
  },
  handler: async (ctx, args) => {
    await ctx.db.insert("flightSnapshots", args);
    const airborne = args.found && !args.onGround;
    if (airborne) {
      await openFlight(ctx, args.timestamp);
      await updateOpenFlight(ctx, args.altitude, args.speed);
    } else if (args.found && args.onGround) {
      await closeFlight(ctx, args.timestamp);
    }
    const status: FlightStatus = !args.found ? "hangar"
      : !args.onGround ? "airborne"
      : args.speed !== null && args.speed > 5 ? "taxiing" : "landed";
    await logStatusChange(ctx, status, STATUS_MESSAGES[status], args.timestamp);
  },
});

type FlightStatus = "hangar" | "taxiing" | "airborne" | "landed";

const STATUS_MESSAGES: Record<FlightStatus, string> = {
  hangar:  "Frances Dell steht friedlich im Hangar.",
  taxiing: "Triebwerk läuft — Frances Dell rollt zur Startbahn.",
  airborne:"✈ AIRBORNE — Frances Dell ist in der Luft!",
  landed:  "Mission abgeschlossen. Motor aus. Propeller läuft aus.",
};

const PUSH: Partial<Record<string, { title: string; body: string; urgency: "high" | "normal" }>> = {
  taxiing:  { title: "📡 Signal gefunden — Frances Dell", body: "Triebwerk läuft, sie rollt zur Startbahn!", urgency: "high" },
  airborne: { title: "✈ AIRBORNE — Frances Dell", body: "Frances Dell ist in der Luft!", urgency: "high" },
  landed:   { title: "Mission abgeschlossen", body: "Motor aus. Propeller läuft aus. Hangartor schließt sich.", urgency: "normal" },
};

// Logs an event + sends a push only when the status actually changed.
// Shared by the open app and the background recorder so nobody gets duplicates.
async function logStatusChange(ctx: MutationCtx, type: string, message: string, timestamp: number) {
  const last = await ctx.db.query("flightEvents").order("desc").first();
  if (last?.type === type) return;
  await ctx.db.insert("flightEvents", { type, message, timestamp });
  const push = PUSH[type];
  if (push) {
    await ctx.scheduler.runAfter(0, internal.pushNotifications.sendNotification, push);
    await ctx.scheduler.runAfter(0, internal.emailAlerts.sendAlertEmail, {
      title: push.title, body: push.body, timestamp,
    });
  }
}

async function fetchAdsb(icao24: string): Promise<LiveData> {
  {
    const url = `https://api.adsb.lol/v2/icao/${icao24}`;
    const res = await fetch(url, {
      headers: { "Accept": "application/json" },
    });
    if (!res.ok) {
      return {
        found: false, onGround: true,
        altitude: null, speed: null, heading: null,
        lat: null, lon: null, squawk: null, emergency: null,
        timestamp: Date.now(),
      };
    }
    const data = await res.json() as {
      ac?: Array<{
        flight?: string;
        alt_baro?: number | string;
        gs?: number;
        track?: number;
        lat?: number;
        lon?: number;
        squawk?: string;
        emergency?: string;
        on_ground?: boolean | number;
        ground?: boolean | number;
      }>;
    };
    const ac = data?.ac?.[0];
    if (!ac) {
      return {
        found: false, onGround: true,
        altitude: null, speed: null, heading: null,
        lat: null, lon: null, squawk: null, emergency: null,
        timestamp: Date.now(),
      };
    }
    const altRaw = ac.alt_baro;
    const altitude = typeof altRaw === "number" ? altRaw : null;
    const onGround = ac.on_ground === true || ac.on_ground === 1 || ac.ground === true || ac.ground === 1 || altRaw === "ground" || altitude === 0;

    return {
      found: true,
      onGround: onGround ?? false,
      altitude,
      speed: ac.gs ?? null,
      heading: ac.track ?? null,
      lat: ac.lat ?? null,
      lon: ac.lon ?? null,
      squawk: ac.squawk ?? null,
      emergency: ac.emergency ?? null,
      timestamp: Date.now(),
    };
  }
}
export const saveSnapshot = mutation({
  args: {
    found: v.boolean(),
    onGround: v.boolean(),
    altitude: v.union(v.number(), v.null()),
    speed: v.union(v.number(), v.null()),
    heading: v.union(v.number(), v.null()),
    lat: v.union(v.number(), v.null()),
    lon: v.union(v.number(), v.null()),
    squawk: v.union(v.string(), v.null()),
    emergency: v.union(v.string(), v.null()),
    timestamp: v.number(),
  },
  handler: async (ctx, args) => {
    await ctx.db.insert("flightSnapshots", args);
  },
});

// Get latest snapshot
export const getLatest = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db
      .query("flightSnapshots")
      .order("desc")
      .first();
  },
});

// Get recent trail points (airborne only, last 60 snapshots with valid lat/lon)
export const getTrail = query({
  args: {},
  handler: async (ctx) => {
    const snapshots = await ctx.db
      .query("flightSnapshots")
      .order("desc")
      .take(80);
    // Keep only airborne points with valid coords, reverse to oldest-first
    return snapshots
      .filter(s => s.found && !s.onGround && s.lat !== null && s.lon !== null)
      .slice(0, 60)
      .reverse()
      .map(s => ({ lat: s.lat as number, lon: s.lon as number }));
  },
});

// Get recent event log (last 20)
export const getEventLog = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db
      .query("flightEvents")
      .order("desc")
      .take(20);
  },
});

// Save event to log + broadcast push notification to all subscribers
export const saveEvent = mutation({
  args: {
    type: v.string(),
    message: v.string(),
    timestamp: v.number(),
  },
  handler: async (ctx, args) => {
    await logStatusChange(ctx, args.type, args.message, args.timestamp);
  },
});

// Start a new flight session (called on takeoff). No-ops if a flight is
// already open — this makes it safe to call every poll, not just on the
// exact transition detected in one browser session.
async function getNewestFlight(ctx: MutationCtx) {
  return await ctx.db.query("flights").withIndex("by_takeoff").order("desc").first();
}

// Signal drops shorter than this are treated as the same flight.
const MERGE_GAP_MS = 10 * 60 * 1000;
// If the plane wasn't seen for longer than this, it landed unobserved;
// the flight ends at the last airborne sighting. Longer than the 30-min cron.
const STALE_MS = 45 * 60 * 1000;

function lastSeenOf(f: { takeoffTime: number; lastSeenTime?: number }) {
  return f.lastSeenTime ?? f.takeoffTime;
}

async function openFlight(ctx: MutationCtx, takeoffTime: number) {
  const newest = await getNewestFlight(ctx);
  if (newest && newest.landingTime === null) {
    if (takeoffTime - lastSeenOf(newest) <= STALE_MS) return; // still the same flight
    await closeFlight(ctx, takeoffTime); // stale: closes at last sighting
  } else if (newest && newest.landingTime !== null && takeoffTime - newest.landingTime <= MERGE_GAP_MS) {
    // Brief signal loss: continue the previous flight instead of starting a new one
    await ctx.db.patch(newest._id, { landingTime: null, durationMs: null });
    return;
  }
  await ctx.db.insert("flights", {
    takeoffTime,
    landingTime: null,
    maxAltitude: null,
    maxSpeed: null,
    durationMs: null,
    lastSeenTime: takeoffTime,
  });
}

async function updateOpenFlight(ctx: MutationCtx, altitude: number | null, speed: number | null) {
  const open = await getNewestFlight(ctx);
  if (!open || open.landingTime !== null) return;
  const patch: { maxAltitude?: number; maxSpeed?: number; lastSeenTime: number } = { lastSeenTime: Date.now() };
  if (altitude !== null && (open.maxAltitude === null || altitude > open.maxAltitude)) patch.maxAltitude = altitude;
  if (speed !== null && (open.maxSpeed === null || speed > open.maxSpeed)) patch.maxSpeed = speed;
  await ctx.db.patch(open._id, patch);
}

// Idempotent: closes an open flight, no-op otherwise
async function closeFlight(ctx: MutationCtx, now: number) {
  const open = await getNewestFlight(ctx);
  if (!open || open.landingTime !== null) return;
  const lastSeen = lastSeenOf(open);
  const landingTime = now - lastSeen > STALE_MS ? lastSeen : now;
  await ctx.db.patch(open._id, { landingTime, durationMs: landingTime - open.takeoffTime });
}

// One-off repair: rebuilds the flights list from the saved airborne position data.
export const rebuildFlights = internalMutation({
  args: {},
  handler: async (ctx): Promise<number> => {
    const old = await ctx.db.query("flights").take(2000);
    for (const f of old) await ctx.db.delete(f._id);
    const snaps = await ctx.db.query("flightSnapshots").take(8000);
    const air = snaps.filter(s => s.found && !s.onGround).sort((a, b) => a.timestamp - b.timestamp);
    type Draft = { takeoffTime: number; lastSeen: number; maxAltitude: number | null; maxSpeed: number | null };
    const drafts: Draft[] = [];
    for (const s of air) {
      const cur = drafts[drafts.length - 1];
      if (!cur || s.timestamp - cur.lastSeen > STALE_MS) {
        drafts.push({ takeoffTime: s.timestamp, lastSeen: s.timestamp, maxAltitude: s.altitude, maxSpeed: s.speed });
        continue;
      }
      cur.lastSeen = s.timestamp;
      if (s.altitude !== null && (cur.maxAltitude === null || s.altitude > cur.maxAltitude)) cur.maxAltitude = s.altitude;
      if (s.speed !== null && (cur.maxSpeed === null || s.speed > cur.maxSpeed)) cur.maxSpeed = s.speed;
    }
    for (const d of drafts) {
      await ctx.db.insert("flights", {
        takeoffTime: d.takeoffTime,
        landingTime: d.lastSeen,
        durationMs: d.lastSeen - d.takeoffTime,
        maxAltitude: d.maxAltitude,
        maxSpeed: d.maxSpeed,
        lastSeenTime: d.lastSeen,
      });
    }
    return drafts.length;
  },
});

export const startFlight = mutation({
  args: { takeoffTime: v.number() },
  handler: async (ctx, args) => {
    await openFlight(ctx, args.takeoffTime);
  },
});

// Update in-flight stats (altitude, speed)
export const updateFlight = mutation({
  args: {
    altitude: v.union(v.number(), v.null()),
    speed: v.union(v.number(), v.null()),
  },
  handler: async (ctx, args) => {
    await updateOpenFlight(ctx, args.altitude, args.speed);
  },
});

// Land — close the open flight session.
export const landFlight = mutation({
  args: { landingTime: v.number() },
  handler: async (ctx, args) => {
    await closeFlight(ctx, args.landingTime);
  },
});

// Get last 5 completed flights
export const getLastFlights = query({
  args: {},
  handler: async (ctx) => {
    const fromFlights = await ctx.db
      .query("flights")
      .withIndex("by_takeoff")
      .order("desc")
      .take(5);

    const completed = fromFlights.filter(f => f.landingTime !== null);
    if (completed.length > 0) return completed;

    // Fallback: reconstruct from flightEvents if flights table is empty
    const events = await ctx.db
      .query("flightEvents")
      .order("desc")
      .take(200);

    type ReconFlight = {
      _id: string;
      takeoffTime: number;
      landingTime: number | null;
      maxAltitude: number | null;
      maxSpeed: number | null;
      durationMs: number | null;
    };

    const reconstructed: ReconFlight[] = [];
    let landingTime: number | null = null;

    for (const evt of events) {
      if (evt.type === "landed" || evt.type === "hangar") {
        if (!landingTime) landingTime = evt.timestamp;
      } else if (evt.type === "airborne" && landingTime !== null) {
        reconstructed.push({
          _id: evt._id,
          takeoffTime: evt.timestamp,
          landingTime,
          durationMs: landingTime - evt.timestamp,
          maxAltitude: null,
          maxSpeed: null,
        });
        landingTime = null;
        if (reconstructed.length >= 5) break;
      }
    }

    return reconstructed;
  },
});

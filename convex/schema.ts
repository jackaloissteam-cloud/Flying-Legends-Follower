import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  users: defineTable({
    tokenIdentifier: v.string(),
    name: v.optional(v.string()),
    email: v.optional(v.string()),
  }).index("by_token", ["tokenIdentifier"]),

  flightSnapshots: defineTable({
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
  }),

  flightEvents: defineTable({
    type: v.string(),
    message: v.string(),
    timestamp: v.number(),
  }),

  // Push notification identity mapping
  pushIdentities: defineTable({
    secret: v.string(),
    visitorId: v.string(),
  })
    .index("by_secret", ["secret"])
    .index("by_visitorId", ["visitorId"]),

  // Each completed or ongoing flight session
  flights: defineTable({
    takeoffTime: v.number(),
    landingTime: v.union(v.number(), v.null()),
    maxAltitude: v.union(v.number(), v.null()),
    maxSpeed: v.union(v.number(), v.null()),
    durationMs: v.union(v.number(), v.null()),
    // Last time the plane was actually seen in the air. Used to close a flight
    // at the real landing time when nobody was watching.
    lastSeenTime: v.optional(v.number()),
  }).index("by_takeoff", ["takeoffTime"]),
});

import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

// Records Frances Dell flights every 30 min; the job itself skips Mon–Thu
crons.interval("record Frances Dell flights", { minutes: 30 }, internal.flight.backgroundCheck, {});

export default crons;

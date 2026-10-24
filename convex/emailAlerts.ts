"use node";

import escapeHtml from "escape-html";
import { Hercules } from "@usehercules/sdk";
import { v } from "convex/values";
import { internalAction } from "./_generated/server";

const hercules = new Hercules({ apiKey: process.env.HERCULES_API_KEY!, apiVersion: "2025-12-09" });

// Sender must be verified in the Email tab; alerts also go to this address
const ALERT_ADDRESS = "werner.jedlicsek@gmail.com";

export const sendAlertEmail = internalAction({
  args: { title: v.string(), body: v.string(), timestamp: v.number() },
  handler: async (_ctx, args): Promise<null> => {
    const time = new Date(args.timestamp).toLocaleString("de-AT", {
      timeZone: "Europe/Vienna", dateStyle: "medium", timeStyle: "short",
    });
    try {
      await hercules.email.send({
        from: `Flying Legends Follower <${ALERT_ADDRESS}>`,
        to: ALERT_ADDRESS,
        subject: args.title,
        text: `${args.body}\n\nZeit: ${time}\nP-51D Mustang Frances Dell · OO-NZW`,
        html: `
          <div style="font-family:Georgia,serif;background:#0d0b07;color:#f0e6d2;padding:24px;border-radius:12px">
            <p style="font-size:11px;letter-spacing:3px;text-transform:uppercase;color:#e8a33d;margin:0 0 8px">Flying Legends Follower</p>
            <h1 style="font-size:24px;margin:0 0 12px">${escapeHtml(args.title)}</h1>
            <p style="font-size:16px;margin:0 0 16px">${escapeHtml(args.body)}</p>
            <p style="font-size:12px;color:#a89a80;margin:0">Zeit: ${escapeHtml(time)}<br/>P-51D Mustang Frances Dell · OO-NZW</p>
          </div>`,
      });
    } catch (error) {
      // Most likely the sender is not verified yet — don't break flight recording
      console.error("Alert email failed:", error);
    }
    return null;
  },
});

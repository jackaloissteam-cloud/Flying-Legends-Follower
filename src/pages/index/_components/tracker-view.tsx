"use client";
import { useState, useEffect, useRef, useCallback } from "react";
import { motion, AnimatePresence } from "motion/react";
import { useAction } from "convex/react";
import { api } from "@/convex/_generated/api.js";
import { toast } from "sonner";
import FlightMap from "@/components/flight-map.tsx";

type FlightStatus = "hangar" | "taxiing" | "airborne" | "landed";

function deriveStatus(data: {
  found: boolean; onGround: boolean;
  speed: number | null; altitude: number | null;
} | null): FlightStatus {
  if (!data || !data.found) return "hangar";
  if (!data.onGround) return "airborne";
  if (data.speed !== null && data.speed > 5) return "taxiing";
  return "landed";
}

function headingToLabel(h: number | null) {
  if (h === null) return "—";
  return ["N","NO","O","SO","S","SW","W","NW"][Math.round(h / 45) % 8];
}
function fmt(v: number | null, unit: string) {
  return v === null ? "—" : `${Math.round(v).toLocaleString("de-DE")} ${unit}`;
}

type LiveData = {
  found: boolean; onGround: boolean;
  altitude: number | null; speed: number | null;
  heading: number | null; lat: number | null; lon: number | null;
  squawk: string | null; emergency: string | null; timestamp: number;
};

const STATUS_LABEL: Record<FlightStatus, string> = {
  hangar:   "Kein ADS-B-Signal",
  taxiing:  "Rollend",
  airborne: "In der Luft",
  landed:   "Gelandet",
};
const STATUS_DOT: Record<FlightStatus, string> = {
  hangar:   "bg-gray-400",
  taxiing:  "bg-yellow-400",
  airborne: "bg-green-400",
  landed:   "bg-blue-400",
};

type Props = {
  icao24: string;
  label: string;
  onReturn: () => void;
};

export default function TrackerView({ icao24, label, onReturn }: Props) {
  const fetchLive = useAction(api.flight.fetchLiveData);
  const [data, setData]   = useState<LiveData | null>(null);
  const [trail, setTrail] = useState<{ lat: number; lon: number }[]>([]);
  const prevRef = useRef<FlightStatus>("hangar");

  const poll = useCallback(async () => {
    try {
      const result = await fetchLive({ icao24Override: icao24 });
      setData(result);
      const st = deriveStatus(result);
      if (!result.onGround && result.found && result.lat !== null && result.lon !== null) {
        setTrail(prev => {
          const next = [...prev, { lat: result.lat as number, lon: result.lon as number }];
          return next.length > 120 ? next.slice(-120) : next;
        });
      }
      prevRef.current = st;
    } catch { /* silent */ }
  }, [fetchLive, icao24]);

  useEffect(() => {
    void poll();
    const id = setInterval(() => void poll(), 15_000);
    return () => clearInterval(id);
  }, [poll]);

  const status = deriveStatus(data);
  const hasPos = data?.lat !== null && data?.lon !== null && data?.found;

  return (
    <motion.div
      className="fixed inset-0 z-50 flex flex-col overflow-y-auto"
      style={{ background: "oklch(0.07 0.008 45)" }}
      initial={{ x: "100%" }}
      animate={{ x: 0 }}
      exit={{ x: "100%" }}
      transition={{ duration: 0.45, ease: [0.32, 0, 0.1, 1] as const }}
    >
      {/* Header */}
      <div className="flex items-center gap-3 px-5 py-4 border-b border-border shrink-0">
        <button
          onClick={onReturn}
          className="flex items-center gap-2 px-3 py-2 rounded-xl border border-border text-xs tracking-widest uppercase font-sans cursor-pointer hover:bg-accent active:scale-95 transition"
          style={{ background: "var(--card)" }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M19 12H5M5 12l7 7M5 12l7-7"/>
          </svg>
          Frances Dell
        </button>
        <div className="flex-1 min-w-0">
          <h2 className="text-lg font-black font-serif tracking-tight text-foreground leading-none truncate">{label}</h2>
          <p className="text-[10px] tracking-[0.2em] uppercase text-muted-foreground font-sans mt-0.5">ICAO24 {icao24.toUpperCase()}</p>
        </div>
        <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-full shrink-0"
          style={{ background: "oklch(0.1 0.01 60 / 75%)", backdropFilter: "blur(8px)" }}>
          <span className={`w-2 h-2 rounded-full ${STATUS_DOT[status]} ${status !== "hangar" ? "animate-pulse" : ""}`} />
          <span className="text-[10px] tracking-[0.2em] uppercase font-sans text-foreground/80">{STATUS_LABEL[status]}</span>
        </div>
      </div>

      {/* Body */}
      <div className="flex flex-col gap-5 px-5 py-5 flex-1">

        {/* Live cards */}
        <div>
          <p className="text-[10px] tracking-[0.3em] uppercase text-muted-foreground font-sans mb-3">Live-Daten</p>
          {!data ? (
            <div className="grid grid-cols-2 gap-3">
              {[0,1,2,3].map(i => (
                <div key={i} className="rounded-xl border border-border p-3 h-16 animate-pulse" style={{ background: "var(--card)" }} />
              ))}
            </div>
          ) : !data.found ? (
            <div className="rounded-xl border border-border p-4 text-center" style={{ background: "var(--card)" }}>
              <p className="text-sm italic text-foreground/60 font-serif">Nicht im Radar sichtbar.</p>
              <p className="text-[10px] tracking-widest uppercase text-muted-foreground font-sans mt-1">Suche läuft alle 15s</p>
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-3">
              {[
                { label: "Höhe",            value: fmt(data.altitude, "ft"), icon: "☁" },
                { label: "Geschwindigkeit", value: fmt(data.speed, "kts"),   icon: "✈" },
                { label: "Kurs",            value: headingToLabel(data.heading), icon: "🧭" },
                { label: "Squawk",          value: data.squawk ?? "—",       icon: "📻" },
              ].map((c, i) => (
                <motion.div key={c.label} className="rounded-xl border border-border p-3 flex flex-col gap-1"
                  style={{ background: "var(--card)" }}
                  initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: i * 0.07 }}
                >
                  <span className="text-base">{c.icon}</span>
                  <span className="text-sm font-bold font-serif text-foreground">{c.value}</span>
                  <span className="text-[10px] tracking-[0.2em] uppercase text-muted-foreground font-sans">{c.label}</span>
                </motion.div>
              ))}
            </div>
          )}
        </div>

        {/* Map */}
        <AnimatePresence>
          {hasPos && (
            <motion.div
              initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }} transition={{ duration: 0.6 }}
            >
              <p className="text-[10px] tracking-[0.3em] uppercase text-muted-foreground font-sans mb-3">📡 Live-Position</p>
              <FlightMap
                lat={data!.lat!}
                lon={data!.lon!}
                heading={data!.heading}
                label={label}
                trail={trail}
              />
            </motion.div>
          )}
        </AnimatePresence>

        {/* Aktualisierung */}
        <p className="text-[10px] tracking-[0.2em] uppercase text-muted-foreground/50 font-sans text-center pb-4">
          Aktualisiert alle 15s
        </p>
      </div>
    </motion.div>
  );
}

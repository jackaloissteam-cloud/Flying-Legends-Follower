import { useState, useEffect, useCallback, useRef } from "react";
import { motion, AnimatePresence } from "motion/react";
import { useAction, useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api.js";
import { toast } from "sonner";
import { useThemeByStatus } from "@/hooks/use-theme-by-status.ts";
import { useReverseGeocode } from "@/hooks/use-reverse-geocode.ts";
import { useMerlinSound } from "@/hooks/use-merlin-sound.ts";
import { usePushNotifications } from "@/hooks/use-push-notifications.ts";
import FlightMap from "@/components/flight-map.tsx";
import TrackerView from "@/pages/index/_components/tracker-view.tsx";

const HERO_URL    = "https://hercules-cdn.com/file_GNyA6IMjSCoT9BeSfnW4E0he";
const HANGAR_URL  = "https://hercules-cdn.com/file_myOZtAlMR2WUI7wmfhFPxpcK";
const POLL_INTERVAL = 30_000;

type IntroPhase   = "hangar" | "welcome" | "preparing" | "fading" | "done";
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
function formatAlt(ft: number | null) {
  return ft === null ? "—" : `${Math.round(ft).toLocaleString("de-DE")} ft`;
}
function formatSpeed(kts: number | null) {
  return kts === null ? "—" : `${Math.round(kts)} kts`;
}

function Propeller({ status }: { status: FlightStatus }) {
  const dur = status === "airborne" ? 0.18 : status === "taxiing" ? 0.5 : status === "landed" ? 3.5 : 0;
  const spinning = dur > 0;
  return (
    <motion.div
      animate={{ rotate: spinning ? 360 : 0 }}
      transition={spinning
        ? { duration: dur, repeat: Infinity, ease: "linear" }
        : { duration: 1.5, ease: "easeOut" }}
      style={{ fontSize: "2.5rem", lineHeight: 1 }}
      className="select-none"
    >✈</motion.div>
  );
}

export default function Index() {
  const [introPhase, setIntroPhase]           = useState<IntroPhase>("hangar");
  const [showHangarOpen, setShowHangarOpen]   = useState(false);
  const [showAirborne, setShowAirborne]       = useState(false);
  const [showMissionDone, setShowMissionDone] = useState(false);
  const [started, setStarted]                 = useState(false);
  const [showTrackMenu, setShowTrackMenu]     = useState(false);
  const [customIcao, setCustomIcao]           = useState("");
  const [resolving, setResolving]             = useState(false);
  // Custom tracker — shown as separate overlay page, never touches FD poll/DB
  const [trackerIcao, setTrackerIcao]         = useState<string | null>(null);
  const [trackerLabel, setTrackerLabel]       = useState<string | null>(null);
  // FD poll state
  const prevStatusRef = useRef<FlightStatus>("hangar");
  const [prevStatus, _setPrevStatus]          = useState<FlightStatus>("hangar");
  const setPrevStatus = useCallback((s: FlightStatus) => {
    prevStatusRef.current = s;
    _setPrevStatus(s);
  }, []);
  const isFirstPoll = useRef(true);

  const fetchLive    = useAction(api.flight.fetchLiveData);
  const resolveAc    = useAction(api.flight.resolveAircraft);
  const saveSnapshot = useMutation(api.flight.saveSnapshot);
  const saveEvent    = useMutation(api.flight.saveEvent);
  const startFlight  = useMutation(api.flight.startFlight);
  const updateFlight = useMutation(api.flight.updateFlight);
  const landFlight   = useMutation(api.flight.landFlight);
  const latest       = useQuery(api.flight.getLatest);
  const eventLog     = useQuery(api.flight.getEventLog);
  const trail        = useQuery(api.flight.getTrail);
  const lastFlights  = useQuery(api.flight.getLastFlights);

  const [primeMerlin, revealMerlin, merlinRemaining] = useMerlinSound();
  const { status: pushStatus, subscribe: pushSubscribe, unsubscribe: pushUnsubscribe } = usePushNotifications();

  // Intro sequence — starts only after user clicks "Starten" (required for audio autoplay)
  useEffect(() => {
    if (!started) return;
    const t1 = setTimeout(() => setIntroPhase("welcome"),   1800);
    const t2 = setTimeout(() => setIntroPhase("preparing"), 3400);
    const t3 = setTimeout(() => setIntroPhase("fading"),   11000);
    const t4 = setTimeout(() => { setIntroPhase("done"); revealMerlin(); }, 12200);
    return () => { clearTimeout(t1); clearTimeout(t2); clearTimeout(t3); clearTimeout(t4); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [started]);

  // Open custom tracker as separate slide-in page (never touches FD poll/DB)
  const handleTrack = useCallback(async (input: string) => {
    if (!input.trim()) return;
    setResolving(true);
    try {
      const result = await resolveAc({ query: input.trim() });
      if (!result) {
        toast.error(`Flugzeug nicht gefunden: ${input.toUpperCase()}`);
        return;
      }
      setTrackerIcao(result.icao24);
      setTrackerLabel(result.label);
      setShowTrackMenu(false);
      setCustomIcao("");
    } catch {
      toast.error("Suche fehlgeschlagen – bitte erneut versuchen");
    } finally {
      setResolving(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resolveAc]);

  const triggerMoment = useCallback((newStatus: FlightStatus) => {
    if (newStatus === "taxiing" || (newStatus === "airborne" && prevStatusRef.current === "hangar")) {
      setShowHangarOpen(true);
      setTimeout(() => setShowHangarOpen(false), 3800);
    }
    if (newStatus === "airborne") {
      setShowAirborne(true);
      setTimeout(() => setShowAirborne(false), 3500);
    }
    if (newStatus === "landed") {
      setShowMissionDone(true);
      setTimeout(() => setShowMissionDone(false), 4000);
    }
  }, []);

  const poll = useCallback(async () => {
    try {
      // Frances Dell only — always uses the fixed ICAO24 44bb57
      const result = await fetchLive({});
      await saveSnapshot(result);
      const newStatus = deriveStatus(result);

      // Update in-flight peak stats
      if (newStatus === "airborne") {
        await updateFlight({ altitude: result.altitude, speed: result.speed });
      }

      // Keep flight session state in sync with the true status on every poll,
      // not just on a detected transition. This self-heals sessions left
      // "open" because no one had the app open at the exact moment a
      // transition happened in an earlier session.
      if (newStatus === "airborne") {
        await startFlight({ takeoffTime: Date.now() });
      } else {
        await landFlight({ landingTime: Date.now() });
      }

      if (newStatus !== prevStatusRef.current) {
        const messages: Record<FlightStatus, string> = {
          hangar:  "Frances Dell steht friedlich im Hangar.",
          taxiing: "Triebwerk läuft — Frances Dell rollt zur Startbahn.",
          airborne:"✈ AIRBORNE — Frances Dell ist in der Luft!",
          landed:  "Mission abgeschlossen. Motor aus. Propeller läuft aus.",
        };
        await saveEvent({ type: newStatus, message: messages[newStatus], timestamp: Date.now() });

        if (!isFirstPoll.current) { triggerMoment(newStatus); toast(messages[newStatus]); }
        setPrevStatus(newStatus);
      }
      isFirstPoll.current = false;
    } catch { /* silent */ }
  }, [fetchLive, saveSnapshot, saveEvent, startFlight, updateFlight, landFlight, triggerMoment, setPrevStatus]);

  useEffect(() => {
    if (introPhase !== "done") return;
    isFirstPoll.current = true;
    void poll();
    const id = setInterval(() => void poll(), POLL_INTERVAL);
    return () => clearInterval(id);
  }, [introPhase, poll]);

  const status = deriveStatus(latest ?? null);
  useThemeByStatus(status, introPhase);

  // Reverse geocode position
  const placeName = useReverseGeocode(
    latest?.lat ?? null,
    latest?.lon ?? null,
  );

  const statusConfig: Record<FlightStatus, { label: string; dot: string; scanText: string }> = {
    hangar:  { label: "Ruht im Hangar",        dot: "bg-amber-500",  scanText: "Den Himmel absuchen..." },
    taxiing: { label: "Rollend zur Startbahn",  dot: "bg-yellow-400", scanText: "Signal gefunden — Triebwerk läuft" },
    airborne:{ label: "🟢 LIVE — In der Luft", dot: "bg-green-400",  scanText: "Live-Daten empfangen" },
    landed:  { label: "Mission abgeschlossen",  dot: "bg-blue-400",   scanText: "Gelandet — Motor aus" },
  };

  const statusDescription: Record<FlightStatus, string> = {
    hangar:  "Frances Dell steht friedlich im Hangar.",
    taxiing: "Triebwerk läuft — Frances Dell rollt zur Startbahn.",
    airborne:"Frances Dell verbindet die Geschichte der P-51 Mustang mit dem heutigen Flugbetrieb.",
    landed:  "Mission abgeschlossen. Propeller läuft aus. Hangartor schließt sich.",
  };

  const cfg = statusConfig[status];
  const hasPosition = latest?.lat != null && latest?.lon != null;

  return (
    <div className="min-h-screen bg-background text-foreground">

      {/* ── START SCREEN — waits for user tap (required for audio autoplay) ── */}
      {!started && (
        <div className="fixed inset-0 z-[60] flex flex-col items-center justify-center"
          style={{ background: "oklch(0.05 0.005 45)" }}
        >
          <motion.div className="flex flex-col items-center gap-8 px-6 text-center w-full max-w-lg"
            initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 1.2, ease: "easeOut", delay: 0.3 }}
          >
            <img src={HERO_URL} alt="Flying Legends"
              className="w-full rounded-2xl object-contain"
              style={{ boxShadow: "0 0 80px oklch(0.72 0.18 65 / 40%)" }} />
            <h1 className="text-4xl md:text-6xl font-bold tracking-tight font-serif"
              style={{
                background: "linear-gradient(160deg, #e8ecf4 0%, #9aa0b4 35%, #d8dce8 60%, #b0b6c8 85%, #e0e4f0 100%)",
                WebkitBackgroundClip: "text",
                WebkitTextFillColor: "transparent",
                textShadow: "none",
                filter: "drop-shadow(0 0 18px rgba(180,190,210,0.45))",
              }}>Flying Legends</h1>
            <p className="text-xs tracking-[0.25em] uppercase text-muted-foreground font-sans">
              P-51D Mustang · Frances Dell · OO-NZW
            </p>
            <button
              onClick={() => { primeMerlin(); setStarted(true); }}
              className="w-full max-w-xs px-10 py-5 rounded-full font-sans text-base tracking-[0.3em] uppercase font-semibold cursor-pointer transition-all duration-200 active:scale-95"
              style={{ background: "oklch(0.72 0.18 65)", color: "oklch(0.1 0.01 45)", boxShadow: "0 0 40px oklch(0.72 0.18 65 / 50%)" }}
            >
              ▶ Starten
            </button>
            <p className="text-[10px] tracking-[0.2em] uppercase text-muted-foreground/50 font-sans">
              Ton wird aktiviert
            </p>
          </motion.div>
        </div>
      )}

      {/* ── INTRO OVERLAY ── */}
      <AnimatePresence>
        {started && introPhase !== "done" && (
          <motion.div key="intro" className="fixed inset-0 z-50 overflow-hidden"
            initial={{ opacity: 1 }}
            animate={{ opacity: introPhase === "fading" ? 0 : 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 1.2, ease: "easeInOut" }}
            onAnimationComplete={() => {
              if (introPhase === "fading") setIntroPhase("done");
            }}
          >
            <div className="absolute inset-0" style={{ background: "radial-gradient(ellipse 80% 60% at 50% 60%, oklch(0.14 0.03 50) 0%, oklch(0.05 0.005 45) 100%)" }} />
            <motion.div className="absolute top-0 left-0 right-0 origin-top"
              style={{ background: "oklch(0.08 0.008 45)", height: "52%" }}
              initial={{ scaleY: 1 }} animate={{ scaleY: introPhase === "hangar" ? 1 : 0 }}
              transition={{ duration: 2.6, ease: [0.76, 0, 0.24, 1] as const }}
            />
            <motion.div className="absolute bottom-0 left-0 right-0 origin-bottom"
              style={{ background: "oklch(0.08 0.008 45)", height: "52%" }}
              initial={{ scaleY: 1 }} animate={{ scaleY: introPhase === "hangar" ? 1 : 0 }}
              transition={{ duration: 2.6, ease: [0.76, 0, 0.24, 1] as const }}
            />
            <motion.div className="absolute top-0 left-1/2 -translate-x-1/2"
              style={{ height: "100%", width: "200px", filter: "blur(40px)", background: "linear-gradient(to bottom, oklch(0.72 0.18 65 / 0%) 0%, oklch(0.72 0.18 65 / 18%) 40%, oklch(0.72 0.18 65 / 0%) 100%)" }}
              initial={{ opacity: 0 }} animate={{ opacity: introPhase === "hangar" ? 0 : 0.7 }}
              transition={{ duration: 2, delay: 0.5 }}
            />
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 px-8 py-10 text-center overflow-y-auto">
              <motion.div className="flex flex-col items-center gap-4 w-full max-w-xl"
                initial={{ opacity: 0, y: 16 }}
                animate={{ opacity: introPhase === "hangar" || introPhase === "fading" ? 0 : 1, y: introPhase === "hangar" ? 16 : 0 }}
                transition={{ duration: 1.1, ease: "easeOut" }}
              >
                <img
                  src={HERO_URL}
                  alt="Flying Legends"
                  className="w-full max-w-xl rounded-2xl object-contain shadow-2xl"
                  style={{ boxShadow: "0 0 80px oklch(0.72 0.18 65 / 35%)" }}
                />
                <p className="text-xs tracking-[0.45em] uppercase text-primary font-sans">Willkommen an Bord</p>
                <h1 className="text-5xl md:text-7xl font-bold tracking-tight font-serif"
                  style={{
                    color: "#b0b8c8",
                    textShadow: "0 0 60px rgba(160,170,190,0.4), 0 2px 8px rgba(0,0,0,0.8)",
                    background: "linear-gradient(160deg, #d0d8e8 0%, #8e96a8 40%, #c8d0e0 70%, #a0a8b8 100%)",
                    WebkitBackgroundClip: "text",
                    WebkitTextFillColor: "transparent",
                  }}>Flying Legends</h1>
                <div className="h-px w-40" style={{ background: "oklch(0.72 0.18 65 / 50%)" }} />
                <p className="text-[11px] tracking-[0.2em] uppercase font-sans"
                  style={{ color: "oklch(0.78 0.16 65)" }}>
                  Created by Werner Jedlicsek for his lifelong companion Georg, since their childhood.
                </p>
              </motion.div>
              <motion.p className="text-[11px] tracking-[0.3em] uppercase text-muted-foreground font-sans"
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: introPhase === "preparing" || introPhase === "fading" ? 0.7 : 0, y: introPhase === "preparing" ? 0 : 8 }}
                transition={{ duration: 0.9, ease: "easeOut" }}
              >
                {/* Inner span pulses independently so the fade-in/out of the parent keeps working */}
                <motion.span
                  className="inline-block"
                  animate={{ opacity: [1, 0.3, 1], scale: [1, 1.04, 1] }}
                  transition={{ duration: 1.8, ease: "easeInOut", repeat: Infinity }}
                >
                  {cfg.scanText}
                </motion.span>
              </motion.p>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── HANGAR OPENS ── */}
      <AnimatePresence>
        {showHangarOpen && (
          <motion.div key="hangar-open" className="fixed inset-0 z-40 pointer-events-none overflow-hidden"
            initial={{ opacity: 1 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 1 }}
          >
            <motion.div className="absolute top-0 left-0 right-0 origin-top"
              style={{ background: "oklch(0.08 0.008 45)", height: "50%" }}
              initial={{ scaleY: 1 }} animate={{ scaleY: 0 }}
              transition={{ duration: 2.2, ease: [0.76, 0, 0.24, 1] as const, delay: 0.3 }}
            />
            <motion.div className="absolute bottom-0 left-0 right-0 origin-bottom"
              style={{ background: "oklch(0.08 0.008 45)", height: "50%" }}
              initial={{ scaleY: 1 }} animate={{ scaleY: 0 }}
              transition={{ duration: 2.2, ease: [0.76, 0, 0.24, 1] as const, delay: 0.3 }}
            />
            <motion.div className="absolute inset-0"
              style={{ background: "radial-gradient(ellipse 60% 40% at 50% 50%, oklch(0.72 0.18 65 / 30%) 0%, transparent 70%)" }}
              initial={{ opacity: 0 }} animate={{ opacity: [0, 0.6, 0] }}
              transition={{ duration: 2.5, delay: 0.8, times: [0, 0.4, 1] }}
            />
            <motion.div className="absolute inset-0 flex items-center justify-center"
              initial={{ opacity: 0 }} animate={{ opacity: [0, 1, 1, 0] }}
              transition={{ duration: 3, delay: 1.2, times: [0, 0.2, 0.7, 1] }}
            >
              <p className="text-xs tracking-[0.45em] uppercase text-primary font-sans">🟢 Bereit zum Abflug</p>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── AIRBORNE ── */}
      <AnimatePresence>
        {showAirborne && (
          <motion.div key="airborne" className="fixed inset-0 z-40 flex items-center justify-center pointer-events-none"
            style={{ background: "oklch(0.08 0.02 35 / 85%)" }}
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            transition={{ duration: 0.6 }}
          >
            <motion.div className="text-center flex flex-col items-center gap-4"
              initial={{ scale: 0.85, opacity: 0 }} animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 1.08, opacity: 0 }} transition={{ duration: 0.7, ease: "easeOut" }}
            >
              <motion.p className="text-7xl md:text-9xl font-black font-serif tracking-wider text-primary"
                animate={{ textShadow: ["0 0 40px oklch(0.75 0.2 45 / 40%)", "0 0 100px oklch(0.75 0.2 45 / 80%)", "0 0 40px oklch(0.75 0.2 45 / 40%)"] }}
                transition={{ duration: 2, repeat: Infinity }}
              >✈ AIRBORNE</motion.p>
              <p className="text-xs tracking-[0.4em] uppercase text-primary/70 font-sans">Frances Dell ist in der Luft</p>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── MISSION COMPLETE ── */}
      <AnimatePresence>
        {showMissionDone && (
          <motion.div key="mission" className="fixed inset-0 z-40 flex items-center justify-center pointer-events-none"
            style={{ background: "oklch(0.08 0.01 240 / 88%)" }}
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.8 }}
          >
            <motion.div className="text-center flex flex-col items-center gap-3 px-8"
              initial={{ y: 20, opacity: 0 }} animate={{ y: 0, opacity: 1 }}
              exit={{ y: -10, opacity: 0 }} transition={{ duration: 0.8, ease: "easeOut" }}
            >
              <p className="text-4xl md:text-6xl font-black font-serif tracking-wide text-foreground">Mission abgeschlossen.</p>
              <div className="h-px w-32 my-1" style={{ background: "oklch(0.65 0.15 230 / 60%)" }} />
              <p className="text-[11px] tracking-[0.35em] uppercase text-muted-foreground font-sans">
                Motor aus · Propeller läuft aus · Hangartor schließt sich
              </p>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── MAIN APP ── */}
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: introPhase === "done" ? 1 : 0 }}
        transition={{ duration: 1.2, ease: "easeIn" }}
        className="flex flex-col min-h-screen"
      >
        {/* Navbar */}
        <header className="flex items-center justify-between px-5 py-4 border-b border-border gap-3">
          <span className="text-sm font-semibold tracking-wide text-foreground font-serif truncate min-w-0">Frances Dell P-51D</span>
          <nav className="flex items-center gap-2 text-[10px] tracking-[0.25em] uppercase text-muted-foreground font-sans shrink-0">
            <span className="hidden sm:inline">Merlin · V2.1</span>
            {/* Push notification bell */}
            {pushStatus !== "unsupported" && (
              <button
                onClick={() => {
                  if (pushStatus === "subscribed") {
                    void pushUnsubscribe().then(() => toast("Benachrichtigungen deaktiviert."));
                  } else if (pushStatus === "denied") {
                    toast("Benachrichtigungen wurden blockiert. Bitte in den Browser-Einstellungen aktivieren.");
                  } else if (pushStatus === "iframe") {
                    toast("Push-Benachrichtigungen funktionieren nur in der veröffentlichten App.");
                  } else {
                    void pushSubscribe().then(() => {
                      toast.success("Benachrichtigungen aktiviert! Du wirst bei Abflug & Landung informiert.");
                    });
                  }
                }}
                title={pushStatus === "subscribed" ? "Benachrichtigungen deaktivieren" : "Benachrichtigungen aktivieren"}
                className="p-2 rounded-full border border-border cursor-pointer transition hover:bg-accent active:scale-95 flex items-center justify-center relative"
                style={{ background: "var(--card)" }}
              >
                {pushStatus === "subscribed" ? (
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" className="text-primary">
                    <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9M13.73 21a2 2 0 0 1-3.46 0"/>
                  </svg>
                ) : (
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-muted-foreground">
                    <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9M13.73 21a2 2 0 0 1-3.46 0"/>
                  </svg>
                )}
                {pushStatus === "subscribed" && (
                  <span className="absolute -top-0.5 -right-0.5 w-2 h-2 bg-green-400 rounded-full" />
                )}
              </button>
            )}
            {/* Track menu button in navbar */}
            <div className="relative">
              <button
                onClick={() => setShowTrackMenu(v => !v)}
                className="p-2 rounded-full border border-border cursor-pointer transition hover:bg-accent active:scale-95 flex items-center justify-center"
                style={{ background: "var(--card)" }}
                title="Flugzeug suchen"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-foreground">
                  <circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>
                </svg>
              </button>
              <AnimatePresence>
                {showTrackMenu && (
                  <motion.div
                    key="track-menu"
                    className="absolute right-0 top-11 z-30 rounded-2xl border border-border p-4 flex flex-col gap-3 w-72 shadow-2xl"
                    style={{ background: "var(--card)" }}
                    initial={{ opacity: 0, y: -8, scale: 0.96 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    exit={{ opacity: 0, y: -8, scale: 0.96 }}
                    transition={{ duration: 0.2 }}
                  >
                    <p className="text-[10px] tracking-[0.3em] uppercase text-muted-foreground font-sans">Flugzeug suchen</p>
                    <input
                      type="text"
                      placeholder="Callsign, Registration oder ICAO24"
                      value={customIcao}
                      onChange={e => setCustomIcao(e.target.value)}
                      onKeyDown={e => {
                        if (e.key === "Enter" && customIcao.trim()) {
                          void handleTrack(customIcao);
                        }
                      }}
                      className="w-full rounded-xl border border-border px-3 py-2 text-sm font-mono bg-background text-foreground outline-none focus:ring-1 focus:ring-primary"
                    />
                    <p className="text-[10px] text-muted-foreground/60 font-sans">z.B. OCN2B · D-AIUQ · 3C6517</p>
                    <div className="flex gap-2">
                      <button
                        onClick={() => { if (customIcao.trim()) void handleTrack(customIcao); }}
                        disabled={!customIcao.trim() || resolving}
                        className="w-full rounded-xl py-2 text-xs font-semibold tracking-widest uppercase cursor-pointer disabled:opacity-40"
                        style={{ background: "oklch(0.72 0.18 65)", color: "oklch(0.1 0.01 45)" }}
                      >{resolving ? "Suche…" : "Tracken"}</button>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          </nav>
        </header>

        {/* Hero or Hangar image */}
        <div className="relative w-full overflow-hidden" style={{ aspectRatio: "16/9" }}>
          <AnimatePresence mode="wait">
            {status === "hangar" ? (
              <motion.img key="hangar-img" src={HANGAR_URL}
                alt="Frances Dell im Hangar"
                className="w-full h-full object-cover object-center absolute inset-0"
                initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                transition={{ duration: 1.5 }}
              />
            ) : (
              <motion.img key="hero-img" src={HERO_URL}
                alt="Frances Dell P-51D Mustang in Fahrt"
                className="w-full h-full object-cover object-center absolute inset-0"
                initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                transition={{ duration: 1.5 }}
              />
            )}
          </AnimatePresence>
          {/* Airborne warm overlay */}
          <AnimatePresence>
            {status === "airborne" && (
              <motion.div key="airborne-overlay" className="absolute inset-0"
                style={{ background: "linear-gradient(to bottom, oklch(0.6 0.15 40 / 20%) 0%, transparent 60%)" }}
                initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                transition={{ duration: 2 }}
              />
            )}
          </AnimatePresence>
          {/* Status badge */}
          <div className="absolute top-3 left-3 flex items-center gap-2 px-3 py-1.5 rounded-full"
            style={{ background: "oklch(0.1 0.01 60 / 75%)", backdropFilter: "blur(8px)" }}>
            <span className={`w-2 h-2 rounded-full ${cfg.dot} ${status !== "hangar" ? "animate-pulse" : ""}`} />
            <span className="text-[10px] tracking-[0.25em] uppercase text-foreground/90 font-sans font-semibold">{cfg.label}</span>
          </div>
          {/* Refresh */}
          {latest && (
            <div className="absolute bottom-2 right-3 text-[9px] tracking-widest uppercase text-white/40 font-sans">
              Aktualisiert alle 30s
            </div>
          )}
        </div>

        {/* Merlin Engine Sound Countdown */}
        <AnimatePresence>
          {merlinRemaining > 0 && (
            <motion.div
              key="merlin-countdown"
              className="px-5 pt-2 pb-0 flex items-center gap-3"
              initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6 }} transition={{ duration: 0.4 }}
            >
              <div className="flex items-center gap-2 rounded-full px-3 py-1.5 border border-border"
                style={{ background: "var(--card)" }}>
                <span className="text-[10px] tracking-[0.2em] uppercase text-muted-foreground font-sans">Merlin läuft</span>
                <span className="text-xs font-mono font-bold text-primary tabular-nums">
                  {String(Math.floor(merlinRemaining / 60)).padStart(2, "0")}:{String(merlinRemaining % 60).padStart(2, "0")}
                </span>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Name + propeller */}
        <div className="px-5 pt-6 pb-2 flex flex-col gap-3 max-w-2xl">
          <div className="flex items-center gap-4">
            <Propeller status={status} />
            <div className="flex-1">
              <h2 className="text-5xl md:text-7xl font-black tracking-tight leading-none text-foreground font-serif">
                <span>FRANCES</span><br /><span>DELL</span>
              </h2>
            </div>
          </div>
          <p className="text-xs tracking-[0.2em] uppercase text-muted-foreground font-sans">
            P-51D-30NA Mustang Frances Dell
          </p>
          <p className="text-xs tracking-[0.2em] uppercase text-muted-foreground font-sans">
            OO-NZW&nbsp;·&nbsp;ICAO24 44BB57
          </p>
          <AnimatePresence mode="wait">
            <motion.p key={status}
              className="text-base italic text-foreground/70 leading-relaxed font-serif max-w-prose"
              initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6 }} transition={{ duration: 0.6 }}
            >{statusDescription[status]}</motion.p>
          </AnimatePresence>

        </div>

        {/* Live data cards */}
        <AnimatePresence>
          {latest?.found && (
            <motion.div key="live-cards" className="px-5 pt-4 pb-2"
              initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }} transition={{ duration: 0.6 }}
            >
              <p className="text-[10px] tracking-[0.3em] uppercase text-muted-foreground font-sans mb-3">Live-Daten</p>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                {[
                  { label: "Höhe",            value: formatAlt(latest.altitude),     icon: "☁" },
                  { label: "Geschwindigkeit", value: formatSpeed(latest.speed),      icon: "✈" },
                  { label: "Kurs",            value: headingToLabel(latest.heading), icon: "🧭" },
                  { label: "Position",        value: placeName ?? "Wird geladen…",   icon: "📍" },
                ].map((card, i) => (
                  <motion.div key={card.label}
                    className="rounded-xl border border-border p-3 flex flex-col gap-1"
                    style={{ background: "var(--card)" }}
                    initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: i * 0.08 }}
                  >
                    <span className="text-base">{card.icon}</span>
                    <span className="text-sm font-bold font-serif text-foreground leading-tight">{card.value}</span>
                    <span className="text-[10px] tracking-[0.2em] uppercase text-muted-foreground font-sans">{card.label}</span>
                  </motion.div>
                ))}
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Live MAP — only when airborne or taxiing */}
        <AnimatePresence>
          {latest?.found && hasPosition && (status === "airborne" || status === "taxiing") && (
            <motion.div key="map" className="px-5 pt-4 pb-2"
              initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }} transition={{ duration: 0.8 }}
            >
              <p className="text-[10px] tracking-[0.3em] uppercase text-muted-foreground font-sans mb-3">📡 Live-Position</p>
              <FlightMap
                lat={latest.lat!}
                lon={latest.lon!}
                heading={latest.heading}
                label="Frances Dell OO-NZW"
                trail={trail ?? []}
              />
            </motion.div>
          )}
        </AnimatePresence>

        {/* No signal */}
        {latest && !latest.found && (
          <div className="px-5 pt-2 pb-2">
            <div className="rounded-xl border border-border p-4 text-center" style={{ background: "var(--card)" }}>
              <p className="text-xs tracking-[0.25em] uppercase text-muted-foreground font-sans">Den Himmel absuchen...</p>
              <p className="text-sm text-foreground/60 font-serif italic mt-1">Frances Dell ist derzeit nicht im Radar sichtbar.</p>
            </div>
          </div>
        )}

        {/* Loading */}
        {latest === undefined && introPhase === "done" && (
          <div className="px-5 pt-2 pb-2">
            <div className="rounded-xl border border-border p-4 text-center animate-pulse" style={{ background: "var(--card)" }}>
              <p className="text-xs tracking-[0.25em] uppercase text-muted-foreground font-sans">Hangar wird geöffnet...</p>
            </div>
          </div>
        )}

        <div className="mx-5 mt-4 h-px bg-border" />

        {/* Specs */}
        <div className="px-5 pt-4 pb-4">
          <p className="text-[10px] tracking-[0.3em] uppercase text-muted-foreground font-sans mb-3">Technische Daten</p>
          <div className="grid grid-cols-2 gap-4 text-xs font-sans">
            {[
              { label: "Typ",         value: "P-51D Mustang" },
              { label: "Kennzeichen", value: "OO-NZW" },
              { label: "Epoche",      value: "Zweiter Weltkrieg" },
              { label: "Triebwerk",   value: "Rolls-Royce Merlin" },
            ].map((item) => (
              <div key={item.label} className="flex flex-col gap-1">
                <span className="tracking-[0.2em] uppercase text-muted-foreground">{item.label}</span>
                <span className="text-foreground font-semibold tracking-wide">{item.value}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Event log */}
        {eventLog && eventLog.length > 0 && (
          <>
            <div className="mx-5 h-px bg-border" />
            <div className="px-5 pt-4 pb-8">
              <p className="text-[10px] tracking-[0.3em] uppercase text-muted-foreground font-sans mb-3">Ereignisprotokoll</p>
              <div className="flex flex-col gap-3">
                {eventLog.map((event, i) => (
                  <motion.div key={event._id} className="flex items-start gap-3 text-xs font-sans"
                    initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0 }}
                    transition={{ delay: i * 0.05 }}
                  >
                    <span className="text-muted-foreground shrink-0 mt-0.5 tabular-nums">
                      {new Date(event.timestamp).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" })}
                    </span>
                    <span className="text-foreground/80 italic font-serif text-sm leading-snug">{event.message}</span>
                  </motion.div>
                ))}
              </div>
            </div>
          </>
        )}

        {/* Letzte 5 Flüge — nur wenn nicht airborne */}
        {status !== "airborne" && lastFlights !== undefined && (
          <>
            <div className="mx-5 h-px bg-border" />
            <div className="px-5 pt-4 pb-6">
              <p className="text-[10px] tracking-[0.3em] uppercase text-muted-foreground font-sans mb-3">✈ Letzte Flüge</p>
              {lastFlights.filter(f => f.landingTime !== null).length === 0 ? (
                <div className="rounded-xl border border-border px-4 py-5 text-center" style={{ background: "var(--card)" }}>
                  <p className="text-xs tracking-[0.2em] uppercase text-muted-foreground font-sans">Suche nach früheren Flügen…</p>
                  <p className="text-sm italic text-foreground/50 font-serif mt-1">Noch keine abgeschlossenen Flüge aufgezeichnet.</p>
                </div>
              ) : (
                <div className="flex flex-col gap-2">
                  {lastFlights.filter(f => f.landingTime !== null).map((flight, i) => {
                    const date = new Date(flight.takeoffTime);
                    const dur = flight.durationMs !== null
                      ? `${Math.floor(flight.durationMs / 60000)} min`
                      : "—";
                    return (
                      <motion.div key={flight._id}
                        className="rounded-xl border border-border px-4 py-3 grid grid-cols-3 gap-2 text-xs font-sans"
                        style={{ background: "var(--card)" }}
                        initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }}
                        transition={{ delay: i * 0.06 }}
                      >
                        <div className="flex flex-col gap-1">
                          <span className="tracking-[0.15em] uppercase text-muted-foreground">Datum</span>
                          <span className="font-semibold text-foreground tabular-nums">
                            {date.toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", year: "2-digit" })}
                          </span>
                          <span className="text-muted-foreground tabular-nums text-[10px]">
                            {date.toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" })} Uhr
                          </span>
                        </div>
                        <div className="flex flex-col gap-1">
                          <span className="tracking-[0.15em] uppercase text-muted-foreground">Dauer</span>
                          <span className="font-semibold text-foreground">{dur}</span>
                        </div>
                        <div className="flex flex-col gap-1">
                          <span className="tracking-[0.15em] uppercase text-muted-foreground">Max. Höhe</span>
                          <span className="font-semibold text-foreground">{formatAlt(flight.maxAltitude)}</span>
                          <span className="tracking-[0.15em] uppercase text-muted-foreground text-[10px]">
                            {flight.maxSpeed !== null ? `${Math.round(flight.maxSpeed)} kts` : "—"}
                          </span>
                        </div>
                      </motion.div>
                    );
                  })}
                </div>
              )}
            </div>
          </>
        )}

        {/* Footer */}
        <div className="mt-auto px-5 pb-6 pt-4 border-t border-border text-center">
          <p className="text-[10px] tracking-[0.3em] uppercase text-muted-foreground font-sans">Every flight tells a story.</p>
          <p className="text-[9px] tracking-[0.2em] uppercase text-muted-foreground/50 font-sans mt-1">DRUDE Flight Operations</p>
        </div>
      </motion.div>

      {/* ── CUSTOM TRACKER OVERLAY — slides in from right, independent poll ── */}
      <AnimatePresence>
        {trackerIcao && trackerLabel && (
          <TrackerView
            key={trackerIcao}
            icao24={trackerIcao}
            label={trackerLabel}
            onReturn={() => { setTrackerIcao(null); setTrackerLabel(null); }}
          />
        )}
      </AnimatePresence>
    </div>
  );
}

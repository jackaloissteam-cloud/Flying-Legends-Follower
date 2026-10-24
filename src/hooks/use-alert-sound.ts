import { useCallback, useRef } from "react";

// Short radar-style alert beep built with Web Audio (no sound file needed).
// unlock() must run inside a user gesture (e.g. the "Starten" tap) so browsers allow later playback.
export function useAlertSound(): [() => void, () => void] {
  const ctxRef = useRef<AudioContext | null>(null);

  const unlock = useCallback(() => {
    if (!ctxRef.current && typeof AudioContext !== "undefined") {
      ctxRef.current = new AudioContext();
    }
    void ctxRef.current?.resume();
  }, []);

  const play = useCallback(() => {
    const ctx = ctxRef.current;
    if (!ctx) return;
    // Three rising beeps
    [0, 0.35, 0.7].forEach((offset, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = 660 + i * 220;
      const t = ctx.currentTime + offset;
      gain.gain.setValueAtTime(0, t);
      gain.gain.linearRampToValueAtTime(0.4, t + 0.03);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.3);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t);
      osc.stop(t + 0.32);
    });
    if ("vibrate" in navigator) navigator.vibrate([200, 100, 200]);
  }, []);

  return [unlock, play];
}

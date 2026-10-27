import { useEffect, useRef } from "react";
import * as maplibregl from "maplibre-gl";
import { setWorkerUrl, type GeoJSONSource } from "maplibre-gl";
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
import "maplibre-gl/dist/maplibre-gl.css";

setWorkerUrl(workerUrl);

type LatLon = { lat: number; lon: number };
type Props = {
  lat: number;
  lon: number;
  heading: number | null;
  label?: string;
  trail?: LatLon[];
};

function trackData(trail: LatLon[]) {
  return {
    type: "FeatureCollection" as const,
    features: [{
      type: "Feature" as const,
      properties: {},
      geometry: {
        type: "LineString" as const,
        coordinates: trail.map(p => [p.lon, p.lat]),
      },
    }],
  };
}

function dotsData(trail: LatLon[]) {
  return {
    type: "FeatureCollection" as const,
    features: trail.map((p, i) => ({
      type: "Feature" as const,
      properties: { opacity: 0.15 + 0.6 * (i / Math.max(trail.length - 1, 1)) },
      geometry: { type: "Point" as const, coordinates: [p.lon, p.lat] },
    })),
  };
}

export default function FlightMap({ lat, lon, heading, label, trail = [] }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const markerRef = useRef<maplibregl.Marker | null>(null);
  const planeRef = useRef<HTMLDivElement | null>(null);
  const initialRef = useRef({ lat, lon, heading, label, trail });
  const trailRef = useRef(trail);
  trailRef.current = trail;

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const initial = initialRef.current;
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: "https://tiles.openfreemap.org/styles/dark",
      center: [initial.lon, initial.lat],
      zoom: 8,
      attributionControl: true,
    });
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-left");
    mapRef.current = map;

    const wrapper = document.createElement("div");
    wrapper.style.cssText = "width:36px;height:36px;display:flex;align-items:center;justify-content:center;";
    const plane = document.createElement("div");
    plane.textContent = "✈";
    plane.style.cssText = "font-size:28px;line-height:1;color:#f4c96a;text-shadow:0 0 10px #df9f32;transition:transform 1.2s ease;";
    plane.style.transform = `rotate(${initial.heading ?? 0}deg)`;
    wrapper.appendChild(plane);
    planeRef.current = plane;
    const marker = new maplibregl.Marker({ element: wrapper, anchor: "center" })
      .setLngLat([initial.lon, initial.lat])
      .addTo(map);
    if (initial.label) marker.setPopup(new maplibregl.Popup({ offset: 20 }).setText(initial.label));
    markerRef.current = marker;

    map.on("load", () => {
      map.addSource("flight-trail", { type: "geojson", data: trackData(trailRef.current) });
      map.addLayer({
        id: "flight-trail-line", type: "line", source: "flight-trail",
        paint: { "line-color": "#dca01e", "line-width": 2.5, "line-opacity": 0.8 },
        layout: { "line-cap": "round", "line-join": "round" },
      });
      map.addSource("flight-dots", { type: "geojson", data: dotsData(trailRef.current) });
      map.addLayer({
        id: "flight-trail-dots", type: "circle", source: "flight-dots",
        paint: {
          "circle-radius": 3,
          "circle-color": "#dca01e",
          "circle-opacity": ["get", "opacity"],
        },
      });
    });

    return () => {
      map.remove();
      mapRef.current = null;
      markerRef.current = null;
      planeRef.current = null;
    };
  }, []);

  useEffect(() => {
    markerRef.current?.setLngLat([lon, lat]);
    if (planeRef.current) planeRef.current.style.transform = `rotate(${heading ?? 0}deg)`;
    if (mapRef.current) mapRef.current.easeTo({ center: [lon, lat], duration: 1200 });
  }, [lat, lon, heading]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const line = map.getSource("flight-trail") as GeoJSONSource | undefined;
    const dots = map.getSource("flight-dots") as GeoJSONSource | undefined;
    line?.setData(trackData(trail));
    dots?.setData(dotsData(trail));
    if (trail.length >= 2) {
      const bounds = new maplibregl.LngLatBounds();
      trail.forEach(p => bounds.extend([p.lon, p.lat]));
      map.fitBounds(bounds, { padding: 40, maxZoom: 10, duration: 800 });
    }
  }, [trail]);

  return (
    <div
      ref={containerRef}
      className="w-full rounded-xl overflow-hidden border border-border"
      style={{ height: "260px" }}
      aria-label="Live-Flugkarte von Frances Dell"
    />
  );
}

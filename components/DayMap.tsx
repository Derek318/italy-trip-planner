"use client";

// Numbered pins in visiting order with a line between them, so a reader can see at a glance
// whether a day is geographically sensible. Loaded only in the browser (Leaflet needs `window`).

import "leaflet/dist/leaflet.css";
import L from "leaflet";
import { useEffect } from "react";
import { MapContainer, Marker, Polyline, TileLayer, Tooltip, useMap } from "react-leaflet";
import type { ScheduledStop } from "@/lib/schedule";

function pin(n: number) {
  return L.divIcon({
    className: "",
    html: `<div class="map-pin">${n}</div>`,
    iconSize: [26, 26],
    iconAnchor: [13, 13],
  });
}

function FitBounds({ points }: { points: [number, number][] }) {
  const map = useMap();
  useEffect(() => {
    if (points.length) map.fitBounds(points, { padding: [40, 40], maxZoom: 15 });
  }, [map, points]);
  return null;
}

export default function DayMap({ stops }: { stops: ScheduledStop[] }) {
  const points = stops.map((s) => [s.place.lat, s.place.lon] as [number, number]);
  return (
    <MapContainer center={points[0] ?? [42.5, 12.5]} zoom={13} scrollWheelZoom={false} className="h-full w-full">
      <TileLayer
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
      />
      <Polyline positions={points} pathOptions={{ color: "#b45309", weight: 3, dashArray: "6 6" }} />
      {stops.map((s, i) => (
        <Marker key={`${s.place.id}-${i}`} position={points[i]} icon={pin(i + 1)}>
          <Tooltip>{s.place.name}</Tooltip>
        </Marker>
      ))}
      <FitBounds points={points} />
    </MapContainer>
  );
}

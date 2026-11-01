// Small geometry helpers (no dependencies). Coordinates are GeoJSON order: [lng, lat].

function ringContains(ring, x, y) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function polygonContains(rings, x, y) {
  if (!ringContains(rings[0], x, y)) return false;
  for (let k = 1; k < rings.length; k++) if (ringContains(rings[k], x, y)) return false;
  return true;
}

function bbox(geometry) {
  const b = [Infinity, Infinity, -Infinity, -Infinity];
  const polys = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
  for (const p of polys) for (const [x, y] of p[0]) {
    if (x < b[0]) b[0] = x; if (y < b[1]) b[1] = y;
    if (x > b[2]) b[2] = x; if (y > b[3]) b[3] = y;
  }
  return b;
}

// Wraps a feature so contains() is cheap: bbox reject first, then ray casting.
function shape(feature) {
  const g = feature.geometry;
  const polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
  const b = bbox(g);
  return {
    props: feature.properties,
    bbox: b,
    contains(lng, lat) {
      if (lng < b[0] || lng > b[2] || lat < b[1] || lat > b[3]) return false;
      return polys.some((p) => polygonContains(p, lng, lat));
    },
    // Rough distance (km) from a point to this shape's bounding box; 0 if inside it.
    bboxKm(lng, lat) {
      const dx = Math.max(b[0] - lng, 0, lng - b[2]) * 111 * Math.cos((lat * Math.PI) / 180);
      const dy = Math.max(b[1] - lat, 0, lat - b[3]) * 111;
      return Math.hypot(dx, dy);
    },
  };
}

function km(lat1, lng1, lat2, lng2) {
  const r = Math.PI / 180;
  const a = Math.sin(((lat2 - lat1) * r) / 2) ** 2 +
    Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(((lng2 - lng1) * r) / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(a));
}

module.exports = { shape, km, bbox };

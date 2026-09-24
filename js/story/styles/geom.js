// js/story/styles/geom.js
// Shared geometry helpers used by every art style: colour conversion, the
// Tyler-Hobbs-style rough/displaced polygon used for watercolour-ish edges,
// and simple parametric point builders (circle/ellipse/star/prop). Kept
// style-agnostic - no canvas fill/stroke calls live here, only point maths.

// --- colour helpers (plain {r,g,b} objects) -----------------------------

export function hexToRgb(hex) {
  const h = hex.replace('#', '');
  return {
    r: parseInt(h.substring(0, 2), 16),
    g: parseInt(h.substring(2, 4), 16),
    b: parseInt(h.substring(4, 6), 16),
  };
}
export function rgbToCss({ r, g, b }, alpha = 1) {
  return `rgba(${r},${g},${b},${alpha})`;
}
export function rgbToHex({ r, g, b }) {
  const c = (v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`;
}
export function darkenRgb({ r, g, b }, amount) {
  return { r: Math.round(r * (1 - amount)), g: Math.round(g * (1 - amount)), b: Math.round(b * (1 - amount)) };
}
export function lightenRgb({ r, g, b }, amount) {
  return {
    r: Math.round(r + (255 - r) * amount),
    g: Math.round(g + (255 - g) * amount),
    b: Math.round(b + (255 - b) * amount),
  };
}
export function desaturateRgb({ r, g, b }, amount) {
  const gray = 0.3 * r + 0.59 * g + 0.11 * b;
  return {
    r: Math.round(r + (gray - r) * amount),
    g: Math.round(g + (gray - g) * amount),
    b: Math.round(b + (gray - b) * amount),
  };
}
export function mixRgb(a, b, t) {
  return {
    r: Math.round(a.r + (b.r - a.r) * t),
    g: Math.round(a.g + (b.g - a.g) * t),
    b: Math.round(a.b + (b.b - a.b) * t),
  };
}

// --- recursive midpoint displacement (Tyler Hobbs technique) -------------

function midpointDisplace(rng, p1, p2, depth, roughness, out) {
  if (depth <= 0) {
    out.push(p2);
    return;
  }
  const mx = (p1[0] + p2[0]) / 2;
  const my = (p1[1] + p2[1]) / 2;
  const dx = p2[0] - p1[0];
  const dy = p2[1] - p1[1];
  const len = Math.hypot(dx, dy) || 1;
  const nx = -dy / len;
  const ny = dx / len;
  const offset = (rng.next() - 0.5) * len * roughness;
  const mid = [mx + nx * offset, my + ny * offset];
  midpointDisplace(rng, p1, mid, depth - 1, roughness * 0.6, out);
  midpointDisplace(rng, mid, p2, depth - 1, roughness * 0.6, out);
}

export function roughPolygon(rng, basePoints, depth = 3, roughness = 0.22) {
  const out = [basePoints[0]];
  for (let i = 0; i < basePoints.length; i++) {
    const p1 = basePoints[i];
    const p2 = basePoints[(i + 1) % basePoints.length];
    midpointDisplace(rng, p1, p2, depth, roughness, out);
  }
  return out;
}

export function tracePolygon(ctx, points) {
  ctx.beginPath();
  points.forEach((p, i) => (i === 0 ? ctx.moveTo(p[0], p[1]) : ctx.lineTo(p[0], p[1])));
  ctx.closePath();
}

// --- simple shape builders -----------------------------------------------

export function circlePoints(cx, cy, r, n = 10) {
  const pts = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
  }
  return pts;
}

export function ellipsePoints(cx, cy, rx, ry, n = 10, rot = 0) {
  const pts = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const x = Math.cos(a) * rx;
    const y = Math.sin(a) * ry;
    pts.push([cx + x * Math.cos(rot) - y * Math.sin(rot), cy + x * Math.sin(rot) + y * Math.cos(rot)]);
  }
  return pts;
}

export function starPoints(cx, cy, rOuter, rInner, n = 5) {
  const pts = [];
  for (let i = 0; i < n * 2; i++) {
    const r = i % 2 === 0 ? rOuter : rInner;
    const a = (i / (n * 2)) * Math.PI * 2 - Math.PI / 2;
    pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
  }
  return pts;
}

// --- shared paper-grain texture (used by watercolour, papercut, crayon,
// ink - anything painted "on paper"). Generated once and cached; it's a
// fixed non-seeded texture, not part of any single game's deterministic
// content, so every panel/style/seed can share the same canvas. -----------

let grainCanvas = null;
export function paperGrainPattern(ctx) {
  if (!grainCanvas) {
    const size = 200;
    grainCanvas = document.createElement('canvas');
    grainCanvas.width = size;
    grainCanvas.height = size;
    const gctx = grainCanvas.getContext('2d');
    const imgData = gctx.createImageData(size, size);
    let s = 0x9e3779b9;
    const rand = () => {
      s = (s ^ (s << 13)) >>> 0;
      s = (s ^ (s >>> 17)) >>> 0;
      s = (s ^ (s << 5)) >>> 0;
      return (s >>> 0) / 4294967296;
    };
    for (let i = 0; i < imgData.data.length; i += 4) {
      const v = 195 + Math.floor(rand() * 45);
      const a = rand() < 0.6 ? 0 : Math.floor(rand() * 10);
      imgData.data[i] = v;
      imgData.data[i + 1] = v;
      imgData.data[i + 2] = v;
      imgData.data[i + 3] = a;
    }
    gctx.putImageData(imgData, 0, 0);
  }
  return ctx.createPattern(grainCanvas, 'repeat');
}

export function propPoints(type, cx, cy, s) {
  switch (type) {
    case 'tree':
      return [[cx, cy - 0.9 * s], [cx + 0.5 * s, cy + 0.3 * s], [cx - 0.5 * s, cy + 0.3 * s]];
    case 'wave':
      return [
        [cx - 0.6 * s, cy], [cx - 0.2 * s, cy - 0.2 * s], [cx + 0.2 * s, cy + 0.1 * s],
        [cx + 0.6 * s, cy - 0.15 * s], [cx + 0.6 * s, cy + 0.3 * s], [cx - 0.6 * s, cy + 0.3 * s],
      ];
    case 'star':
      return starPoints(cx, cy, 0.5 * s, 0.2 * s);
    case 'cloud':
      return circlePoints(cx, cy, 0.4 * s, 10);
    case 'rock':
      return circlePoints(cx, cy, 0.35 * s, 7);
    case 'flower':
      return circlePoints(cx, cy, 0.15 * s, 6);
    default:
      return null;
  }
}

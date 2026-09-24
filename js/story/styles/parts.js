// js/story/styles/parts.js
// Abstract hero "part lists": every hero (fox/bird/boat/kite/snail/lantern)
// is described once as a list of primitive shapes with a semantic `role`
// (body/head/ear/eye/tail/sail/string/...), in coordinates NORMALIZED to a
// unit hero size (multiply by the on-screen hero size `s` to place them).
// Every art style walks the same list and draws each part in its own manner
// (wash, flat fill, pixels, ink hatching, crayon strokes, neon tubes, bold
// geometry) - this is what keeps adding a new style cheap: styles never
// know hero-specific geometry, only shape primitives + roles.
//
// Shape kinds:
//   'ellipse' {cx,cy,rx,ry,rot?,n?}      - filled blob (rot in radians)
//   'polygon' {points:[[x,y],...]}        - filled closed shape
//   'dot'     {cx,cy,r}                   - small filled circle (eyes)
//   'path'    {ops:[[x,y],...], curve?}   - open stroked line/curve
//              curve:'quad' pairs points as [p0, ctrl, p1, ctrl, p2, ...]
//   'arc'     {cx,cy,r,a0,a1}             - open stroked arc
//   'spiral'  {cx,cy,r,turns,steps?}      - open stroked inward spiral
//
// colorSlot picks which resolved colour (see styles/colors.js resolvePalette)
// a part uses: 'hero' | 'heroDark' | 'accent' | 'accentDark' | 'accentLight'
// | 'ink'. `strokeOnly:true` parts are never filled (path/arc/spiral always
// behave this way regardless of the flag).

export const HERO_PARTS = {
  fox: [
    // Fox: a lean elongated body, a big fluffy two-part tail, and tall
    // sharp ears + a snout bump - the silhouette a bird/boat/etc. can't be
    // confused with even at small sizes.
    { role: 'body', shape: 'ellipse', cx: 0, cy: 0.15, rx: 0.36, ry: 0.24, rot: 0.05, colorSlot: 'hero' },
    { role: 'tail', shape: 'ellipse', cx: -0.5, cy: 0.02, rx: 0.32, ry: 0.15, rot: -0.55, colorSlot: 'accent' },
    { role: 'tail', shape: 'ellipse', cx: -0.74, cy: -0.1, rx: 0.15, ry: 0.11, rot: -0.5, colorSlot: 'accentLight' },
    { role: 'head', shape: 'ellipse', cx: 0.3, cy: -0.22, rx: 0.22, ry: 0.18, rot: 0.1, colorSlot: 'hero' },
    { role: 'snout', shape: 'polygon', points: [[0.46, -0.2], [0.6, -0.17], [0.47, -0.11]], colorSlot: 'accentLight' },
    { role: 'ear', shape: 'polygon', points: [[0.18, -0.38], [0.25, -0.72], [0.34, -0.38]], colorSlot: 'accent' },
    { role: 'ear', shape: 'polygon', points: [[0.32, -0.38], [0.44, -0.68], [0.49, -0.36]], colorSlot: 'accent' },
    { role: 'eye', shape: 'dot', cx: 0.38, cy: -0.24, r: 0.025, colorSlot: 'ink' },
  ],
  bird: [
    // Bird: plump rounded body, a sharp swept wing, a long beak and a
    // fanned tail - reads as "bird" from silhouette alone, not a fox blob.
    { role: 'body', shape: 'ellipse', cx: 0, cy: 0.1, rx: 0.3, ry: 0.27, rot: -0.05, colorSlot: 'hero' },
    { role: 'tail', shape: 'polygon', points: [[-0.2, 0.08], [-0.56, -0.06], [-0.3, 0.16]], colorSlot: 'accent' },
    { role: 'tail', shape: 'polygon', points: [[-0.2, 0.14], [-0.6, 0.14], [-0.3, 0.24]], colorSlot: 'accent' },
    { role: 'tail', shape: 'polygon', points: [[-0.2, 0.2], [-0.54, 0.34], [-0.28, 0.32]], colorSlot: 'accent' },
    { role: 'wing', shape: 'polygon', points: [[-0.06, 0.12], [-0.36, -0.04], [-0.12, -0.22], [0.06, -0.02]], colorSlot: 'heroDark' },
    { role: 'head', shape: 'ellipse', cx: 0.26, cy: -0.18, rx: 0.16, ry: 0.16, rot: 0, colorSlot: 'hero' },
    { role: 'beak', shape: 'polygon', points: [[0.38, -0.19], [0.64, -0.15], [0.38, -0.06]], colorSlot: 'accent' },
    { role: 'eye', shape: 'dot', cx: 0.3, cy: -0.21, r: 0.022, colorSlot: 'ink' },
  ],
  boat: [
    { role: 'body', shape: 'polygon', points: [[-0.5, 0.18], [0.5, 0.18], [0.32, 0.4], [-0.32, 0.4]], colorSlot: 'hero' },
    { role: 'mast', shape: 'path', ops: [[0, 0.18], [0, -0.62]], colorSlot: 'heroDark', widthFactor: 0.02, strokeAlpha: 0.35 },
    { role: 'sail', shape: 'polygon', points: [[0.01, -0.6], [0.4, 0.12], [0.01, 0.12]], colorSlot: 'accentLight' },
    { role: 'flag', shape: 'polygon', points: [[0, -0.62], [0.14, -0.55], [0, -0.5]], colorSlot: 'accent' },
  ],
  kite: [
    { role: 'body', shape: 'polygon', points: [[0, -0.55], [0.4, 0], [0, 0.4], [-0.4, 0]], colorSlot: 'hero' },
    { role: 'string', shape: 'path', ops: [[0, -0.55], [0, 0.4]], colorSlot: 'heroDark', widthFactor: 0.014, strokeAlpha: 0.3 },
    { role: 'string', shape: 'path', ops: [[-0.4, 0], [0.4, 0]], colorSlot: 'heroDark', widthFactor: 0.014, strokeAlpha: 0.3 },
    {
      role: 'tail', shape: 'path', curve: 'quad', colorSlot: 'accentDark', widthFactor: 0.012, strokeAlpha: 0.4,
      ops: [[0, 0.4], [0.18, 0.6], [0, 0.8], [-0.18, 1.0], [0, 1.2]],
    },
    {
      role: 'string', shape: 'path', curve: 'quad', colorSlot: 'ink', widthFactor: 0.006, strokeAlpha: 0.25,
      ops: [[0, 0.4], [-0.15, 0.9], [-0.1, 1.4]],
    },
    { role: 'bow', shape: 'polygon', points: [[-0.07, 0.62], [0, 0.57], [0.07, 0.62], [0, 0.67]], colorSlot: 'accent' },
    { role: 'bow', shape: 'polygon', points: [[-0.05, 0.92], [0.02, 0.87], [0.09, 0.92], [0.02, 0.97]], colorSlot: 'accent' },
    { role: 'bow', shape: 'polygon', points: [[-0.09, 1.14], [-0.02, 1.09], [0.05, 1.14], [-0.02, 1.19]], colorSlot: 'accent' },
  ],
  snail: [
    { role: 'body', shape: 'ellipse', cx: -0.05, cy: 0.18, rx: 0.4, ry: 0.14, rot: 0, colorSlot: 'hero' },
    { role: 'shell', shape: 'ellipse', cx: 0.12, cy: -0.05, rx: 0.32, ry: 0.32, rot: 0, colorSlot: 'accent' },
    { role: 'shell-detail', shape: 'spiral', cx: 0.12, cy: -0.05, r: 0.27, turns: 2.6, steps: 28, colorSlot: 'accentDark', widthFactor: 0.014, strokeAlpha: 0.35 },
    { role: 'ear', shape: 'path', ops: [[-0.42, 0.08], [-0.5, -0.14]], colorSlot: 'heroDark', widthFactor: 0.018, strokeAlpha: 0.4 },
    { role: 'ear', shape: 'path', ops: [[-0.3, 0.06], [-0.36, -0.16]], colorSlot: 'heroDark', widthFactor: 0.018, strokeAlpha: 0.4 },
    { role: 'eye', shape: 'dot', cx: -0.5, cy: -0.16, r: 0.022, colorSlot: 'ink' },
    { role: 'eye', shape: 'dot', cx: -0.36, cy: -0.18, r: 0.022, colorSlot: 'ink' },
  ],
  lantern: [
    {
      role: 'body', shape: 'polygon', colorSlot: 'hero',
      points: [[-0.28, -0.45], [0.28, -0.45], [0.34, 0.1], [0.16, 0.4], [-0.16, 0.4], [-0.34, 0.1]],
    },
    { role: 'glow', shape: 'ellipse', cx: 0, cy: -0.05, rx: 0.16, ry: 0.16, rot: 0, colorSlot: 'accent' },
    { role: 'string', shape: 'arc', cx: 0, cy: -0.55, r: 0.22, a0: Math.PI * 0.15, a1: Math.PI * 0.85, colorSlot: 'heroDark', widthFactor: 0.02, strokeAlpha: 0.35 },
  ],
};

export function heroParts(heroType) {
  return HERO_PARTS[heroType] || HERO_PARTS.fox;
}

/** Scale a normalized [x,y] pair by hero size `s`. */
export function sc(p, s) {
  return [p[0] * s, p[1] * s];
}
export function scPts(points, s) {
  return points.map((p) => sc(p, s));
}

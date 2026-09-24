// js/story/storygen.js
// Seeded story grammar: picks a hero/goal/palette and builds one "beat"
// (scene spec + caption) per song phrase, plus a cover beat and a good/bad
// ending beat. Scene specs are plain data consumed by js/story/watercolor.js
// - this module never touches canvas.

const HEROES = [
  { type: 'fox', label: 'a small fox' },
  { type: 'boat', label: 'a paper boat' },
  { type: 'bird', label: 'a little bird' },
  { type: 'kite', label: 'a bright kite' },
  { type: 'snail', label: 'a patient snail' },
  { type: 'lantern', label: 'a wandering lantern' },
];

const GOALS = [
  'the Lantern Star',
  'the far lighthouse',
  'the singing mountain',
  'the hidden garden',
  'the old oak by the sea',
  'the sleeping moon',
];

const ENVIRONMENTS = {
  setout: ['meadow', 'home shore', 'quiet harbor'],
  journey: ['forest', 'wide river', 'rolling hills', 'open sea', 'winding path', 'misty valley'],
  obstacle: ['storm', 'dark wood', 'steep cliff', 'tangled thicket'],
  climax: ['storm', 'dark wood', 'steep cliff'],
};

const PROPS = ['tree', 'wave', 'star', 'cloud', 'rock', 'flower', null];

// Vivid storybook-watercolour palettes: [sky, land/sea, accent (sun/prop),
// hero (a strong colour that contrasts with sky+ground)]. Kept saturated on
// purpose - the fumbled variant is what desaturates, not the base palette.
export const PALETTES = [
  ['#ff9d6c', '#2f9e8f', '#ffd23f', '#d7263d'], // warm sunset / teal sea
  ['#6ec9f2', '#57cc99', '#ffb703', '#e85d75'], // spring meadow
  ['#8f7bf6', '#3a506b', '#f7b32b', '#ff6b6b'], // violet dusk
  ['#4fd0e9', '#1b7f79', '#ffe066', '#fb5607'], // teal sea voyage
  ['#ffb4a2', '#6a994e', '#f4a261', '#5e548e'], // rose dawn
  ['#8ac6d1', '#2d6a4f', '#f9c74f', '#f3722c'], // emerald forest
];

const CAPTIONS = {
  setout: [
    (h, g) => `Once upon a time, ${h} set out to find ${g}.`,
    (h, g) => `${cap(h)} looked to the horizon and began the journey to ${g}.`,
  ],
  journey: [
    (h, g, env) => `${cap(h)} crossed the ${env}.`,
    (h, g, env) => `Onward through the ${env}, ${h} pressed on.`,
    (h, g, env) => `The ${env} stretched on, but ${h} did not stop.`,
  ],
  obstacle: [
    (h, g, env) => `Dark clouds gathered over the ${env}.`,
    (h, g, env) => `The ${env} grew wild, and ${h} had to be brave.`,
  ],
  climax: [
    (h, g, env) => `With one last effort, ${h} pushed through the ${env}.`,
    (h, g, env) => `The ${env} tested ${h} to the very end.`,
  ],
  goodEnding: [
    (h, g) => `${cap(h)} arrived at last - ${g} was found!`,
    (h, g) => `Tired but glad, ${h} reached ${g} under a clearing sky.`,
  ],
  badEnding: [
    (h, g) => `${cap(h)}, worn and turned around, watched ${g} fade into the mist.`,
    (h, g) => `The way was lost. ${cap(h)} would have to try again another day.`,
  ],
};

function cap(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function beatKind(index, numPhrases) {
  if (index === 0) return 'setout';
  const t = index / Math.max(1, numPhrases - 1);
  if (index === numPhrases - 1) return 'climax';
  if (t >= 0.65 && t < 0.85) return 'obstacle';
  return 'journey';
}

function buildScene(rng, kind, heroType, heroColorIdx, paletteIdx, env) {
  return {
    kind,
    heroType,
    heroColorIdx,
    paletteIdx,
    environment: env,
    prop: rng.pick(PROPS),
    timeOfDay: rng.pick(['day', 'day', 'dusk', 'dawn']),
  };
}

/**
 * Build the full story for `numPhrases` panels (one per song phrase).
 */
export function generateStory(rng, numPhrases) {
  const hero = rng.pick(HEROES);
  const goal = rng.pick(GOALS);
  const paletteIdx = rng.int(0, PALETTES.length - 1);
  const heroColorIdx = 3; // palette slot reserved for the hero's colour

  const panels = [];
  for (let i = 0; i < numPhrases; i++) {
    const kind = beatKind(i, numPhrases);
    const env = rng.pick(ENVIRONMENTS[kind]);
    const scene = buildScene(rng, kind, hero.type, heroColorIdx, paletteIdx, env);
    const captionFn = rng.pick(CAPTIONS[kind]);
    panels.push({ index: i, kind, scene, caption: captionFn(hero.label, goal, env) });
  }

  const coverScene = buildScene(rng, 'setout', hero.type, heroColorIdx, paletteIdx, rng.pick(ENVIRONMENTS.setout));
  const cover = {
    scene: coverScene,
    caption: `${cap(hero.label)} is about to set out to find ${goal}...`,
  };

  const goodEnv = rng.pick(ENVIRONMENTS.journey);
  const goodScene = { ...buildScene(rng, 'good', hero.type, heroColorIdx, paletteIdx, goodEnv), mood: 'triumphant' };
  const goodEnding = { scene: goodScene, caption: rng.pick(CAPTIONS.goodEnding)(hero.label, goal) };

  const badEnv = rng.pick(ENVIRONMENTS.obstacle);
  const badScene = { ...buildScene(rng, 'bad', hero.type, heroColorIdx, paletteIdx, badEnv), mood: 'somber' };
  const badEnding = { scene: badScene, caption: rng.pick(CAPTIONS.badEnding)(hero.label, goal) };

  return { hero, goal, paletteIdx, cover, panels, goodEnding, badEnding };
}

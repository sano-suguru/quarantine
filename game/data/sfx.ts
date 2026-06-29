/**
 * Single source of truth for the game's sound-effect set: each key maps to the ElevenLabs
 * prompt + generation parameters. `scripts/gen-sfx.ts` reads this to batch-generate the mp3s
 * into `game/audio/sfx/<key>[_n].mp3`, where `engine/audioAssets.ts` auto-discovers them.
 *
 * Keep this in lockstep with the playback keys in `engine/audio.ts` / `game.ts` — the keys are
 * `shot_<weapon>` (non-melee weapons), `groan_<enemyType>`, `melee`, and the fixed names below.
 * `game/data/sfx.test.ts` expands the dynamic keys from WEAPONS/ENEMY_TYPES and asserts every
 * code-side key has both a manifest entry here and a generated file (bidirectional drift guard).
 *
 * NOTE: this module is imported by the generator (Bun) and the test (Vitest node) only — NOT by
 * the browser runtime, so the prompt strings never reach the JS bundle.
 */
export type SfxSpec = {
  /** ElevenLabs sound-effect prompt. */
  text: string;
  /** clip length, 0.5–30s. */
  durationSeconds: number;
  /** 0–1: higher = closer to the prompt, lower = more variation between takes. */
  promptInfluence: number;
  /** how many takes to generate as `<key>_1..<key>_N` (default 1 → bare `<key>.mp3`). */
  variants?: number;
  /** seamless loop (start blends into end). Requires the v2 model → set `modelId` too. */
  loop?: boolean;
  /** ElevenLabs model id; required for `loop`. */
  modelId?: string;
};

const LOOP_MODEL = "eleven_text_to_sound_v2";

export const SFX: Record<string, SfxSpec> = {
  // --- weapons (fire) ---
  shot_pistol: {
    text: "Designed game sound effect: a single dry 9mm pistol shot. Tight punchy transient, sharp crack with a firm low-mid body and a fast metallic slide rattle, short snappy tail. Close-mic, dry, mono, no reverb, no music.",
    durationSeconds: 0.8,
    promptInfluence: 0.7,
    variants: 3,
  },
  shot_smg: {
    text: "Designed game sound effect: a short full-auto SMG burst, 4 to 6 rounds. Fast light mechanical rattle, crisp high-end clatter, tight rhythmic stutter, minimal tail. Dry, mono, no music.",
    durationSeconds: 1.3,
    promptInfluence: 0.6,
    variants: 3,
  },
  shot_shotgun: {
    text: "Designed game sound effect: a heavy pump-action shotgun blast. Massive low-end thump and a sharp wide crack, gritty mid texture, followed by a mechanical pump-action shell rack. Dry, mono, no music.",
    durationSeconds: 1.3,
    promptInfluence: 0.7,
    variants: 3,
  },
  shot_rifle: {
    text: "Designed game sound effect: a single assault-rifle shot. Punchy aggressive crack with a snappy supersonic whip tail and a hard metallic mechanism click. Military, dry, mono, no music.",
    durationSeconds: 0.9,
    promptInfluence: 0.7,
    variants: 3,
  },
  shot_lmg: {
    text: "Designed game sound effect: a sustained light-machine-gun burst. Thunderous deep automatic fire, heavy mechanical pounding, relentless and powerful, slight room body. Dry, mono, no music.",
    durationSeconds: 2.5,
    promptInfluence: 0.6,
    variants: 3,
  },
  shot_magnum: {
    text: "Designed game sound effect: a single .44 magnum hand-cannon shot. Enormous deep boom with a brutal transient and a long resonant decaying tail, powerful and slow. Dry, mono, no music.",
    durationSeconds: 1.8,
    promptInfluence: 0.7,
    variants: 3,
  },
  melee: {
    text: "Designed game sound effect: a fast combat-knife swing followed by a wet meaty stab. Quick air whoosh, sharp flesh slice, visceral squelch impact. Close-mic, dry, mono, no music.",
    durationSeconds: 0.7,
    promptInfluence: 0.7,
  },
  reload: {
    text: "Designed game sound effect: tactical magazine reload start, empty mag release and detach, metallic handling clinks. Dry, close-mic, mono, no music.",
    durationSeconds: 0.9,
    promptInfluence: 0.7,
  },
  reload_done: {
    text: "Designed game sound effect: reload finish, fresh magazine seated with a solid clack and a charging-handle bolt slide snapping forward. Dry, mono, no music.",
    durationSeconds: 0.7,
    promptInfluence: 0.7,
  },
  dry_fire: {
    text: "Designed game sound effect: a single hollow empty-gun click, dry metallic trigger and firing-pin snap, no gunshot. Close-mic, mono.",
    durationSeconds: 0.5,
    promptInfluence: 0.8,
  },
  // --- zombies (dry/mono; the engine pans + attenuates by distance) ---
  hit: {
    text: "Designed game sound effect: a single bullet impact into rotten flesh, a wet punchy thwack with a short squelch. Close-mic, dry, mono, no music.",
    durationSeconds: 0.5,
    promptInfluence: 0.7,
    variants: 3,
  },
  kill_small: {
    text: "Designed game sound effect: a zombie death, a choked wet gurgling groan cut short by a soft body collapse thud. Visceral, dry, mono, no music.",
    durationSeconds: 1.3,
    promptInfluence: 0.6,
    variants: 3,
  },
  kill_big: {
    text: "Designed game sound effect: a large brute zombie death, deep guttural dying bellow collapsing into a heavy wet thud. Monstrous, oversized, dry, mono, no music.",
    durationSeconds: 1.8,
    promptInfluence: 0.6,
    variants: 3,
  },
  groan_walker: {
    text: "Designed game sound effect: a slow agonized zombie groan, low wet raspy gurgling moan, shambling undead, weary and creepy. Dry, mono, no music.",
    durationSeconds: 2.2,
    promptInfluence: 0.6,
    variants: 3,
  },
  groan_runner: {
    text: "Designed game sound effect: a frenzied feral zombie snarl, high ragged hissing growl, twitchy and aggressive. Dry, mono, no music.",
    durationSeconds: 1.6,
    promptInfluence: 0.6,
    variants: 3,
  },
  groan_brute: {
    text: "Designed game sound effect: a huge undead brute growl, deep guttural bellowing rumble, slow and menacing, oversized creature. Dry, mono, no music.",
    durationSeconds: 2.6,
    promptInfluence: 0.6,
    variants: 3,
  },
  screech: {
    text: "Designed game sound effect: a startled zombie shriek, a sudden sharp rising scream as it spots prey, ragged and piercing. Dry, mono, no music.",
    durationSeconds: 0.7,
    promptInfluence: 0.7,
    variants: 3,
  },
  // --- player / items ---
  hurt: {
    text: "Designed game sound effect: a male grunt of pain, short sharp pained gasp with a breath catch. Close-mic, dry, mono, no music.",
    durationSeconds: 0.5,
    promptInfluence: 0.7,
    variants: 3,
  },
  pickup: {
    text: "Designed game sound effect: a quick item pickup, metallic gear clink with a short bright confirming blip. Crisp, dry, mono, no music.",
    durationSeconds: 0.5,
    promptInfluence: 0.7,
  },
  heal: {
    text: "Designed game sound effect: using a medkit, a syringe injection hiss and a fabric bandage wrap, with a soft reassuring tone underneath. Dry, mono, no music.",
    durationSeconds: 1.3,
    promptInfluence: 0.6,
  },
  repair: {
    text: "Designed game sound effect: boarding a barricade, three heavy hammer hits driving nails into wooden planks, solid woody thuds. Dry, mono, no music.",
    durationSeconds: 1.3,
    promptInfluence: 0.7,
  },
  click: {
    text: "Designed game sound effect: a flashlight toggle, a tactile mechanical switch click with a faint electrical ignition buzz. Close-mic, dry, mono.",
    durationSeconds: 0.5,
    promptInfluence: 0.8,
  },
  light_die: {
    text: "Designed game sound effect: a flashlight dying, a sputtering electrical buzz with a descending filament whine fading to silence. Dry, mono, no music.",
    durationSeconds: 0.8,
    promptInfluence: 0.7,
  },
  // --- cycle / stingers ---
  wave_start: {
    text: "Cinematic horror stinger: night falls, a deep ominous sub-bass rumble swelling into a booming low hit, rising dread, dark and oppressive. No music melody.",
    durationSeconds: 3,
    promptInfluence: 0.6,
    variants: 2,
  },
  dawn: {
    text: "Cinematic stinger: dawn after surviving, a warm hopeful rising tone with soft airy shimmer and distant faint birdsong, relief and calm.",
    durationSeconds: 4,
    promptInfluence: 0.5,
  },
  game_over: {
    text: "Cinematic horror stinger: death, a slow descending ominous drone collapsing into a hollow low boom, then fading to hopeless silence. Dark, no music melody.",
    durationSeconds: 4,
    promptInfluence: 0.5,
    variants: 2,
  },
  // --- UI ---
  ui_select: {
    text: "Designed UI sound effect: a crisp confirming menu blip, short clean two-note rising tick, digital and tactile. Dry, mono, no music.",
    durationSeconds: 0.5,
    promptInfluence: 0.8,
  },
  ui_reject: {
    text: "Designed UI sound effect: a low dull error buzz, short negative denied tone. Dry, mono, no music.",
    durationSeconds: 0.5,
    promptInfluence: 0.8,
  },
  // --- loops (seamless; require the v2 model) ---
  search: {
    text: "Designed game loopable sound effect: rummaging through a supply cache, continuous fabric rustle and small items clattering, hands digging through a container, seamless loop, dry, mono, no music.",
    durationSeconds: 1.2,
    promptInfluence: 0.6,
    loop: true,
    modelId: LOOP_MODEL,
  },
  amb_day: {
    text: "Looping ambience: desolate post-apocalyptic daytime, hollow wind over empty streets, faint distant debris rattle and metal creaks, sparse and lonely, seamless loop, no music.",
    durationSeconds: 12,
    promptInfluence: 0.4,
    loop: true,
    modelId: LOOP_MODEL,
  },
  amb_night: {
    text: "Looping ambience: tense nighttime horror, distant scattered zombie groans and metallic creaks with dry gusts of wind, sparse and far-off, no low drone or rumble, seamless loop, no music.",
    durationSeconds: 12,
    promptInfluence: 0.4,
    loop: true,
    modelId: LOOP_MODEL,
  },
};

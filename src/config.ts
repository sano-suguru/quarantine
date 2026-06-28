export const CONFIG = {
  simHz: 60,
  arena: 1600,
  zoom: 1.0,
  maxInstances: 40000,
  // co-op networking (host-authoritative). client interpolation / prediction params.
  net: {
    sendHz: 30, // host snapshot broadcast rate
    interpDelayMs: 100, // render remote entities this far in the past
    smoothCorrect: 0.2, // reconciliation lerp factor
    snapTeleportThresh: 80, // px error above which we hard-snap instead of lerp
    maxExtrapolateMs: 120, // cap on dead-reckoning when snapshots stall (used if extrapolation is enabled)
    // client-predicted "ghost" tracer lifetime (visual only). ~interpDelayMs/1000 so the
    // ghost fades just as the host-authoritative bullet (drawn ~interpDelay in the past)
    // becomes visible — minimizing the double-tracer window. Tune by feel.
    ghostLife: 0.12,
    // signaling host:port for room-code auto-connect (the ws/wss scheme is chosen from
    // location.protocol at connect time). Default = local `wrangler dev`. Swap to the
    // deployed Worker host for internet play.
    signalUrl: "127.0.0.1:8787",
    // ICE servers for WebRTC. STUN only by default (covers most home↔home NATs). Add a
    // TURN entry here (no code change) if a peer behind symmetric NAT/CGNAT can't connect.
    iceServers: [{ urls: "stun:stun.l.google.com:19302" }] as RTCIceServer[],
    // Non-trickle ICE bakes every candidate into ONE pasteable/relayed SDP, so we must not ship
    // before the useful candidates exist. Old code used a flat 3s that truncated slow srflx/relay
    // candidates on restrictive networks → guaranteed cross-NAT failure. See transport.ts.
    iceGatherMaxMs: 8000, // hard cap before shipping whatever candidates we have (backstop)
    iceGatherGraceMs: 1200, // STUN-only: after the first reflexive candidate, wait this then go
    p2pOpenTimeoutMs: 15000, // client lobby: if the P2P link never opens, surface a failure
    // Client auto-reconnect (P4). The client triggers a reconnect when BOTH data channels go
    // quiet (no snapshot AND no rel pong) for snapStarvationMs — a true loss, not a snap-only
    // blip (host keeps broadcasting through pause/shop, so a quiet snap path = the link died).
    // The host keeps a dropped player's body (gear/hp/pos) "absent" for graceMs so a quick
    // rejoin re-attaches in place (no respawn); past graceMs the body is removed → fresh respawn.
    reconnect: {
      snapStarvationMs: 2500, // both channels silent this long while running → reconnect
      backoffMs: [1000, 2000, 4000, 8000], // per-attempt delay; length = max attempts
      graceMs: 20000, // host holds a dropped player's body this long (> backoff total) for re-attach
      rejoinClaimTimeoutMs: 1000, // host waits this for the client's first rel (join/rejoin) before assuming fresh
    },
    // public-room browser / quick-match (D)
    registryPollMs: 3000, // OPEN RAIDS list refresh cadence while the hub is open
    registryMetaMs: 10000, // public host → relay meta cadence (registry liveness; Worker-clock driven)
    quickMatchTimeoutMs: 6000, // per-candidate connect wait before falling back to hosting
  },
  // speed is the only move speed now (sprint removed); the equipped weapon's moveMul scales it.
  // moveRampRate = how fast curMoveMul approaches the weapon's weight (per sec); switchRaise =
  // fire lockout after a weapon switch.
  // sample-based SFX (engine/audioAssets.ts). sfxVolume balances generated samples against
  // the procedural synth beds; maxSampleVoices caps simultaneous one-shots so a full horde
  // (uncapped hit/kill fire) can't pile up BufferSources and clip.
  // looping samples (search rummage, day/night ambience) layered over the procedural drone bed.
  // ambVolume/searchVolume scale each loop; loopFadeSec is the in/out (and day⇄night crossfade) ramp.
  audio: {
    sfxVolume: 0.8,
    maxSampleVoices: 12,
    ambVolume: 0.8,
    searchVolume: 0.7,
    loopFadeSec: 0.6,
  },
  player: { radius: 16, speed: 200, maxHp: 100, moveRampRate: 1.5, switchRaise: 0.25 },
  cam: { lerp: 8, shakeDecay: 8 },
  feel: {
    hitstop: 0.05, // seconds of slow-mo on a kill
    hitstopScale: 0.12, // dt multiplier while hitstop is active
    knockbackDecay: 13, // exp decay of zombie knockback velocity
    recoilDecay: 16, // exp decay of player recoil offset
    flashDecay: 7, // exp decay of full-screen damage flash
    hurtIframe: 0.12, // contact-damage cooldown floor (panic-proof)
  },
  horror: {
    lowHp: 0.35, // hp fraction that triggers dread (heartbeat/vignette)
    surroundCount: 5, // nearby zombies that count as "surrounded"
    surroundRadius: 170,
    lowAmmo: 0.25, // total-ammo fraction (vs one mag) that adds to dread
    // baseline dread when nothing's near. low → the soundscape drops near-silent between
    // threats so the next groan/attack lands harder ("silence" dynamic).
    dreadFloor: 0.04,
    // per-zombie voices (groan while lurking / screech when caught in the light). Re-derived
    // LOCALLY on host/client/single from the world relative to the local player — they never
    // travel in snapshots, so each client hears its own fear (see zombieVoices in game.ts).
    voiceWindowMs: 700, // rolling window for the concurrency cap (anti-saturation)
    maxConcurrentVoices: 3, // max individual zombie voices per window (4p × horde would clip)
    groanCooldown: 4.0, // per-zombie min seconds between groans
    groanChance: 0.55, // probability a due lurker actually groans (keeps the cadence irregular)
    lurkThinAt: 6, // lurking count above which individual voices thin out (lean on tension)
    // day is the explore/respite phase, so zombie voices are damped vs the night siege: groans
    // sound less often (interval × dayVoiceMul) and quieter (× dayVoiceVol). Night is unchanged.
    dayVoiceMul: 2.2, // groan-cadence interval multiplier during the day
    dayVoiceVol: 0.55, // groan volume scale during the day
    // "something darts across the light": a fast shadow streak across the cone when unseen
    // threats crowd the dark. Visual only, drawn in draw() (no sim state → single-player safe).
    dartChancePerLurk: 0.05, // per-second dart probability contributed by each lurking zombie
    dartSpeed: 900, // world units/sec the streak crosses at
    dartLife: 0.16, // seconds a streak lives
  },
  flashlight: {
    halfAngle: 0.55, // cone half-angle in radians (~63° total)
    range: 620, // cone reach in world units
    ambient: 0.05, // pitch-darkness floor outside the light
    personalRadius: 130, // dim bubble around the player
    personalMax: 0.5, // brightness of that bubble
    emissiveFloor: 0.4, // how much glows/eyes show in the dark (additive pass)
    batteryMax: 100,
    drainPerSec: 1.6, // ~60s of light on a full battery
    lowThreshold: 0.25, // battery fraction where the DEEP flicker begins
    flickerDepth: 0.4, // how deep the low-battery flicker dips the cone
    baseFlickerDepth: 0.04, // subtle constant flicker even at full battery (a failing bulb)
    shopBattery: 60, // safe-room battery resupply
    dropChance: 0.04, // chance a kill drops a battery (rarer than ammo)
    // dust motes drifting in the cone (visual only, drawn in draw() from state.time — no sim
    // state, so single-player stays byte-for-byte and each client renders its own).
    dustCount: 46, // motes sampled in the local player's cone
    dustSize: 2.0, // base mote radius in world units (per-mote variance on top)
    dustAlpha: 0.08, // faint — should read as "in the beam", not snow
    dustColor: [0.82, 0.8, 0.7] as [number, number, number],
  },
  heal: {
    duration: 2.0, // seconds a medkit takes (rooted + can't fire)
    amount: 50, // hp restored per medkit
    startMedkits: 1,
    maxMedkits: 4,
    shopMedkits: 1, // safe-room medkit resupply
  },
  ammo: {
    dropChance: 0.16, // base chance a slain zombie drops an ammo pickup
    bruteDropChance: 0.7, // brutes are far more generous
    healDropChance: 0.05, // chance (when no ammo dropped) of a medkit instead
    pickupRadius: 30, // auto-pickup distance (added to player radius)
    pickupLife: 30, // seconds a ground pickup persists before decaying
    ammoMagMul: 1, // an ammo pickup grants this many mags of the current gun
    shopRefillMags: 1.5, // safe-room (shop) resupply per gun, in mags
  },
  siege: {
    dayDuration: 35, // seconds of the lit scavenge/repair phase
    dayAmbient: 0.45, // bright enough to roam the arena in daylight
    nightAmbient: 0.04, // near-black; the flashlight cone is essential
    boardMaxHp: 120, // a fresh barricade's hp
    repairAmount: 40, // hp restored per repair press
    repairCost: 15, // credits per repair
    repairCd: 0.35, // seconds between repair presses
    interactRadius: 70, // how close you must be to interact (repair / search)
    roamersPerDay: 5, // wandering zombies seeded across the map each day
    spawnRing: 680, // base radius (world units) of the off-screen night-spawn ring
  },
  cache: {
    searchTime: 1.5, // seconds of holding interact (and standing still) to loot (day)
    nightSearchMul: 2.0, // night searches take this much longer (=3.0s) — exposure is the risk
    lureRadius: 220, // zombies within this of a night-searcher surge toward the rummaging noise
    lureSpeedSurge: 0.35, // +35% speed while lured — a "they heard you and close in", not a teleport
    tierDist: 500, // every this many world units from HOME raises the loot tier
    maxTier: 3,
  },
  // co-op economy (individual wallets). Single-player is unaffected: with one player the
  // bounty split short-circuits to that player and the wave multiplier is 1.
  econ: {
    // kill/loot bounty is split evenly among living players within this radius of the
    // kill, integer remainder to the poorest first (a no-comms catch-up for a teammate
    // who's fallen behind). Beyond it, nobody shares — stay near the fight to earn.
    bountyRadius: 256,
    // night horde scales with squad size: each extra player adds this fraction to every
    // spawn count (HP/speed unchanged). 0 in single-player → identical waves.
    waveCountPerPlayer: 0.5,
    // support-labor reward: repairing the shared barricade refunds this many credits at full
    // effect (scaled by hp actually restored). MUST stay < siege.repairCost so repair is
    // near-free labor (a support role stays solvent) but never turns a profit — no money
    // fountain from repair-spamming a wall you let the horde chew on.
    repairReward: 12,
  },
  // co-op peer support (reviving downed teammates). Uses siege.interactRadius for reach so
  // all context interactions share one distance. Single-player never triggers it (no allies).
  assist: {
    reviveTime: 2.5, // seconds a teammate must tend a downed ally to bring them back
    reviveHpFrac: 0.5, // revived in place at this fraction of max integrity
  },
  arsenal: {
    maxLevel: 3, // weapon upgrade levels per run
    dmgPerLevel: 0.15, // +15% damage per level
    magPerLevel: 0.2, // +20% magazine per level
    levelBaseCost: 60, // credits for a weapon's first upgrade
    levelStep: 45, // each further level costs this much more
    perkCost: 80, // credits for a field-upgrade perk
    salvagePerDay: 8, // SALVAGE banked per day survived
    salvagePerKill: 0.15, // SALVAGE banked per kill
  },
};

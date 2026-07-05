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
    roomAnswerTimeoutMs: 3000, // join-by-code: fake/empty rooms should fail quickly in lobby UI
    registryFetchTimeoutMs: 3000, // quick-match/browser: don't leave the hub stuck scanning
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
  // moveRampRate = how fast curMoveMul approaches the weapon's weight (per sec).
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
  // blood decals: a pool is a cluster of layered blobs, not one flat disc. Center blobs are
  // darker; satellites bias along the hit direction so it reads as a splatter, not a stamp.
  fx: {
    maxParticles: 2400, // hard cap on live particles; spawn() drops silently past this
    blood: {
      maxDecals: 480, // a pool now costs several decals; raised so pools don't churn the FIFO
      satellites: 4, // small blobs flung around each base blob
      baseRadiusBig: [16, 26] as [number, number],
      baseRadiusSmall: [8, 14] as [number, number],
      satRadius: [3, 9] as [number, number],
      satSpread: 22, // world-units satellites scatter from the base
      splatterBias: 28, // extra world-units satellites travel along the hit dir (the tail)
      centerColor: [0.16, 0.02, 0.03] as [number, number, number], // dark, near-clotted
      edgeColor: [0.34, 0.04, 0.05] as [number, number, number], // brighter fresh red
      life: [26, 40] as [number, number], // seconds before the decal fades out
      maxAlpha: 0.6, // fresh-pool peak alpha (drawn fade is life/maxLife * maxAlpha)
    },
    gore: {
      dmgRef: 90, // damage that saturates the "weapon weight" base intensity
      lowHpBand: 0.33, // hp fraction below which the finisher bonus ramps in
      finisherBonus: 0.6, // extra intensity for a near-lethal / killing hit
      sparks: [6, 16] as [number, number], // impact spark count, lerped by intensity (min = today's 6)
      specks: [3, 10] as [number, number], // blood-speck count, lerped by intensity (min = today's 3)
      poolBigAt: 0.6, // intensity at/above which the impact leaves a big blood pool
      gibThreshold: 0.5, // intensity below which no flesh chunks fly
      gibCount: [2, 7] as [number, number], // flesh-chunk count, lerped by intensity
      gibFillCap: 0.85, // skip gibs once the particle buffer is this full (reserve muzzle/spark headroom)
      woundTint: [0.5, 0.04, 0.05] as [number, number, number], // blood color the body bleeds toward as hp → 0
      woundDarken: 0.18, // max darkening at 0 hp (small, so finisher targets stay visible in-cone)
    },
  },
  // Action-feel: motion / prop / particle / payoff tuning for timed player actions.
  // First-pass values — locked by playtest (feel-first). No magic numbers live in systems/draw.
  actionFeel: {
    swingDecay: 0.3, // seconds a repair/mate-heal "swing" ramp takes to fade (discrete tap → continuous)
    lean: 6, // world-units the body leans toward the action focus at full phase
    bob: 3, // world-units of periodic bob while an action runs
    bobHz: 9, // bob oscillation frequency (Hz) — the "working" cadence
    propOffset: 10, // lateral (off-hand) offset for overlay props, away from the weapon rig axis
    heal: {
      auraPulseHz: 2.2, // breathing rate of the heal aura
      auraBase: 0.28, // aura alpha floor
      auraPulse: 0.18, // aura alpha added at the top of each pulse
      moteEveryS: 0.12, // seconds between rising heal motes
      burst: 10, // motes in the completion burst
    },
    search: {
      digHz: 6, // rummage bob frequency
      lidRattle: 1.5, // crate-lid jitter amplitude (world units)
      dustEveryS: 0.18, // seconds between dust puffs
    },
    repair: { dust: 4 }, // dust puffs per repair swing
    revive: { auraPulseHz: 1.6, beamAlpha: 0.25 },
    deploy: { emerge: 0.25 }, // seconds of the draw-only spawn-in scale/settle
  },
  // drawTime (per-weapon, in WeaponDef) is the fire-lockout + lower→raise draw beat after a swap,
  // paired with the weapon_switch SFX + move ramp. Tune per weapon by playtest, not clip length.
  player: { radius: 16, speed: 200, maxHp: 100, moveRampRate: 1.5 },
  cam: { lerp: 8, shakeDecay: 8 },
  input: {
    wheelBurstGapMs: 120, // ms of wheel silence that ends a "burst": trackpad inertia fires
    // wheel events for ~1s, so one-switch-per-burst (re-arm after this gap) stops the wheel
    // from spinning through the whole arsenal. Also used to drain wheel accrued while non-live.
  },
  feel: {
    hitstop: 0.05, // seconds of slow-mo on a kill
    hitstopScale: 0.12, // dt multiplier while hitstop is active
    knockbackDecay: 13, // exp decay of zombie knockback velocity
    recoilDecay: 16, // exp decay of player recoil offset
    flashDecay: 7, // exp decay of full-screen damage flash
    hurtIframe: 0.12, // contact-damage cooldown floor (panic-proof)
    shakeMax: 18, // ceiling on cam.shake (one camera = one cap, for fire/melee/kill alike)
    recoilKick: 0.9, // recoil-offset multiplier (gun kicks back, melee lunges forward)
    muzzleGun: 0.05, // muzzle-flash timer for a gunshot
    muzzleMelee: 0.1, // longer than a gun so the slash arc reads at the swing cadence
    meleeArcDefault: 0.9, // fallback half-angle of the melee cone when a weapon omits meleeArc
    meleeRangeDefault: 30, // fallback melee reach (added to player radius) when omitted
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
    // HP→world desaturation ease rate: exponential-lerp speed constant (per sec). ~12 → ~0.25 s
    // settle, matching the old CSS transition: filter 0.25s ease-out cadence.
    desatEaseRate: 12,
    // HP→world desaturation: the continuous "wound" readout that replaces the Integrity bar.
    // Full color at/above desatOnset (calm zone, day readability); saturation eases to
    // desatFloor and brightness drops by desatDim as HP drains to 0. desatGamma shapes the
    // curve (<1 front-loads so mid-HP damage is felt). The heartbeat + blood-vignette throb
    // (gated at lowHp above) stay the separate near-death alarm. All four are playtest-tuned.
    desatOnset: 0.65, // hp fraction at/above which the world is full color
    desatFloor: 0.2, // saturate() multiplier at death (>0 so blood/toxic still read)
    desatDim: 0.18, // brightness() reduction at death (1 → 1 - desatDim)
    desatGamma: 0.7, // curve shaping: <1 front-loads mid-HP sensitivity; 1 = linear
    // HP→blood vignette (shader pass): organic arterial red that creeps in from the edges and
    // churns as HP drops — the readable "you're bleeding" cue. Reuses integrityGrade. The
    // heartbeat throb is folded into the same shader (u_pulse). Shader-internal noise/breathe
    // constants live in blood.frag.
    bloodOnset: 0.85, // hp fraction at/above which no blood shows (starts early so damage reads)
    bloodGamma: 0.6, // <1 front-loads: mid-HP bleeding reads before the deep band
    bloodMax: 1.0, // scales the grade into u_blood; >1 also deepens the creep reach, not just opacity
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
    dimFloor: 0.45, // steady cone brightness floor while lit — the beam never dims below this between flickers (fairness)
    dimStart: 0.6, // battery fraction at/above which the cone is full-bright; below it the cone dims toward dimFloor (must be > 0)
    shopBattery: 60, // safe-room battery resupply
    dropChance: 0.04, // chance a kill drops a battery (rarer than ammo)
    // dust motes drifting in the cone (visual only, drawn in draw() from state.time — no sim
    // state, so single-player stays byte-for-byte and each client renders its own).
    dustCount: 46, // motes sampled in the local player's cone
    dustSize: 2.0, // base mote radius in world units (per-mote variance on top)
    dustAlpha: 0.08, // faint — should read as "in the beam", not snow
    dustColor: [0.82, 0.8, 0.7] as [number, number, number],
    shadowFloor: 0.02, // brightness of a wall-shadowed point (darker than nightAmbient so shadows truly hide)
    occludeFloor: true, // occlude the floor (grid.frag) too; set false as a low-end perf fallback
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
    dayAmbient: 0.55, // bright enough to roam the arena in daylight
    // gloom, not a void: high-albedo things (walls ~0.33, enemy sprites ~0.5) surface as faint
    // silhouettes out of cone while the low-albedo floor (grid base ~0.05) stays near-black — so
    // the cone still owns rich detail + reach. Raised from 0.04 (true near-black) after playtesters
    // reported the world unreadably dark; tuned by eye for "gloom, cone still the hero".
    nightAmbient: 0.1,
    boardMaxHp: 120, // a fresh barricade's hp
    repairAmount: 40, // hp restored per repair press
    repairCost: 0, // repair is free labor (time/repairCd-gated); SCRAP is reserved for the draft + fortify
    repairCd: 0.35, // seconds between repair presses
    interactRadius: 70, // how close you must be to interact (repair / search)
    roamersPerDay: 5, // wandering zombies seeded across the map each day
    spawnRing: 680, // base radius (world units) of the off-screen night-spawn ring
    // night is a timed hold, not a wipe-out: dawn arrives by the clock. Length ramps with the day.
    nightDurationBase: 55, // seconds of night on day 1
    nightDurationPerDay: 8, // each later day adds this many seconds of night
    nightDurationMax: 150, // clamp so very late nights stay finite
    // living-zombie cap during night: bounds perf/snapshot AND is the "cornered" wall. Day-scaled
    // for a gentler intro, under a hard ceiling so the snapshot stays within ~16KB.
    nightCapBase: 45, // cap on day 1
    nightCapPerDay: 5, // each later day raises the cap by this much
    nightCapMax: 90, // hard ceiling (perf / snapshot bound)
    duskFrac: 0.25, // fraction of the day over which light crossfades down to night (sunset)
    dawnFrac: 0.2, // fraction of the night over which light crossfades up to day (predawn)
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
    repairReward: 0, // no SCRAP fountain from repair (repair is free now — see siege.repairCost=0)
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
    // --- nightly draft (between-nights) ---
    offerSize: 3, // cards drawn each night
    freePicks: 1, // free picks per night before SCRAP is charged
    rerollBase: 30, // SCRAP for the first reroll of a night
    rerollStep: 25, // each further reroll this night costs this much more (resets next night)
  },
  ai: {
    perception: {
      baseHearing: 60, // noise radius (world units) the player emits while walking
      nightSenseMul: 3, // hearing radius multiplier at night (zombies hear further in the dark)
      searchTime: 4, // seconds a zombie searches the last-known player position before going idle
      searchArriveDist: 40, // world units — close enough to the search target to stop and look
      losEveryFrames: 4, // re-check LOS every N sim ticks (performance throttle; 4 = ~15 Hz)
      loseGraceMs: 700, // ms a zombie keeps hunting after losing LOS before falling to search
      // per-player noise model: p.noise rises on loud actions and decays each tick.
      // Task 4 (sight perception) reads p.noise as the hearing-radius bonus for sight-model zombies.
      // Tech-debt: rummage noise is double-sourced (lure in ai.ts + p.noise) until the Stalker phase
      // unifies the two into a single noise model. See task-3-brief.md for rationale.
      noise: {
        fire: 260, // noise added on each shot (loud, attracts distant sight-model zombies)
        run: 70, // noise added per second of movement (footstep clatter)
        rummage: 200, // noise added per second of active cache searching
        decay: 0.92, // multiplicative decay applied each sim tick (exponential falloff)
        max: 400, // clamp ceiling so simultaneous loud actions don't stack unboundedly
      },
    },
    nav: {
      whiskerLook: 40, // how far ahead (world units) the avoidance whiskers probe
      whiskerAngle: 0.6, // radians offset of the two side whiskers from the center probe
      avoidStrength: 1.0, // how hard to steer away when a wall is detected (multiplier on blockage)
      // flow-field (path nav): coarse grid rebuilt every rebuildFrames sim ticks.
      // walkable() uses effective clearance = clearance + cell/2 (halfCell), so the door band is:
      //   2 × (30 − clearance − cell/2) = 2 × (30 − 14 − 8) = 16 px
      // Phase-independence requires band ≥ cell → cell ≤ 30 − clearance = 16.
      // At cell=16 the band is exactly one cell wide, so a walkable column is guaranteed at every
      // grid phase. clearance=14 fits walker (r15) and runner (r13); brute (r27) is too wide for a
      // 60px door — give it nav:"avoid". Grid ≈ (3200/16)² = 200² = 40k cells; still fast.
      cell: 16,
      clearance: 14,
      rebuildFrames: 15, // rebuild the flow field every N sim ticks (~4× per second at 60Hz)
    },
  },
  deployables: {
    lightIntensity: 0.6, // deployable searchlight brightness (player flashlight is ~1); high enough
    // that the cone reads on near-black night ground, low enough to keep the player light primary
    lightRangeMul: 0.6, // deployable cone range as a fraction of the player flashlight range
    lightHalfAngle: 0.5, // deployable cone half-angle (rad); narrower than the player cone
  },
  stalker: {
    spawnDist: 900, // spawns this far from the target, in the dark
    advanceSpeed: 95, // px/s while aggro in the dark
    staggerSpeed: 40, // px/s backing off while staggered
    staggerWindow: 1.1, // s the stagger lingers after the beam leaves
    wardBatteryCost: 4, // battery units drained from the warding player per aggro→stagger edge
    contactDist: 34,
    contactDamage: 34,
    contactCd: 1.5, // s before it can grab again
    retreatSpeed: 220, // px/s leaving at dawn / after a grab
    noiseBias: 1.0, // how strongly it steers toward the loudest player
    telegraphNear: 460, // proximity where telegraph starts
    // --- telegraph tuning (stalkerFx.ts — render/audio only, not in sim) ---
    // dread = nearness (0..1 by telegraphNear) × unlit (1 if stalker NOT in the local cone, 0 if lit).
    // The three outputs scale with dread: footfall volume, cone flicker intensity, heartbeat add.
    footfallIntervalMin: 0.7, // s between footfall sounds at max dread (close + unlit)
    footfallIntervalMax: 3.0, // s between footfall sounds at min dread (far or lit)
    footfallVolMax: 0.55, // footfall volume at max dread (panned by direction)
    footfallVolMin: 0.05, // footfall volume at min dread (a faint tread, barely audible)
    flickerMax: 0.28, // cone alpha modulation at max dread (0 = no flicker, 1 = full extinction)
    heartbeatAdd: 0.45, // extra heartbeat strength contributed by dread (stacks with HP dread)
    heartbeatIntervalMin: 0.55, // s between heartbeats at max dread (stalker very close)
    // --- grab scare tuning (local victim only, game.ts) ---
    // Extended scare: hard flash → near-black collapse → camera drag toward the stalker.
    scareFlashBoost: 0.9, // added on top of the 0.7 base flash on a grab (both applied in game.ts)
    scareDragDist: 80, // world units the camera lurches toward the stalker during the scare
    wardFadeOut: 5, // vis fade-out rate (per second) while staggered — stalker melts into the dark
    bulletKnockback: 60, // world-units impulse applied to the stalker along the bullet direction
    bulletFlinch: 0.18, // vis dip on a bullet hit (clamped to 0.2 floor so it never fully vanishes)
    // --- phantom perception (Phase 1.5, stalkerPhantom.ts) — fake cues, render/audio-only ---
    phantomMax: 2, // concurrent fake silhouette cap
    phantomLife: 0.32, // fake silhouette lifetime (s), with sinusoidal fade in/out
    phantomSpawnIntervalMax: 5, // mean seconds between silhouette spawns at the ambient max rate (dread≈0)
    phantomDreadExp: 1.5, // shaping exponent k for the (1-dread)^k rate falloff
    phantomAlphaMax: 0.5, // peak silhouette alpha at mid-life
    phantomStepLockout: 0.6, // s after a real footfall during which no phantom step fires (owned by stalkerFx)
    phantomStepIntervalMax: 4, // mean seconds between phantom steps at the ambient max rate (dread≈0)
  },
};

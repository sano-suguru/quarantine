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
    maxExtrapolateMs: 120, // cap on dead-reckoning when snapshots stall
    bufferTargetCount: 2, // target snapshot buffer depth
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
  },
  player: { radius: 16, speed: 230, sprint: 1.55, maxHp: 100 },
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
    lowThreshold: 0.25, // battery fraction where flicker begins
    flickerDepth: 0.4, // how deep the flicker dips the cone
    shopBattery: 60, // safe-room battery resupply
    dropChance: 0.04, // chance a kill drops a battery (rarer than ammo)
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
    searchTime: 1.5, // seconds of holding interact (and standing still) to loot
    tierDist: 500, // every this many world units from HOME raises the loot tier
    maxTier: 3,
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

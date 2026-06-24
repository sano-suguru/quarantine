export const CONFIG = {
  simHz: 60,
  arena: 1600,
  zoom: 1.0,
  maxInstances: 40000,
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
    lightRadius: 640, // world radius of the player's light
    lowHp: 0.35, // hp fraction that triggers dread (heartbeat/vignette)
    surroundCount: 5, // nearby zombies that count as "surrounded"
    surroundRadius: 170,
  },
};

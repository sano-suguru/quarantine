import { describe, expect, it } from "vitest";
import { CONFIG } from "../config";
import { newState } from "../state";
import {
  ambientForClock,
  clockFrac,
  clockLabel,
  isFortressBreached,
  nightDuration,
  nightMaxZombies,
  rearmThaw,
  resetArena,
  startDay,
  startNight,
  sysSiege,
} from "./siege";
import { spawnStalker } from "./stalker";

// Guardrail: siege seeds roamers via spawnZombie (RNG positions), so we assert only the
// DETERMINISTIC surface — phase, timers, return values, and zombie *counts* — never the
// RNG-derived coordinates/wobble of the spawned bodies.

describe("startDay", () => {
  it("enters the lit day phase, resets the timer, and seeds the roamer count", () => {
    const s = newState();
    s.phase = "night";
    s.phaseT = 0;
    s.zombies = [];
    startDay(s);
    expect(s.phase).toBe("day");
    expect(s.phaseT).toBe(CONFIG.siege.dayDuration);
    expect(s.zombies.length).toBe(CONFIG.siege.roamersPerDay);
  });

  it("restocks every cache to unsearched", () => {
    const s = newState();
    for (const c of s.caches) {
      c.looted = true;
      c.searchT = 1;
    }
    startDay(s);
    expect(s.caches.every((c) => !c.looted && c.searchT === 0)).toBe(true);
  });
});

describe("startNight", () => {
  it("enters the night phase, arms a wave, and starts the night clock", () => {
    const s = newState();
    s.day = 3;
    startNight(s);
    expect(s.phase).toBe("night");
    expect(s.wave.n).toBe(3);
    expect(s.wave.def).not.toBeNull();
    expect(s.phaseT).toBe(nightDuration(3));
  });
});

describe("sysSiege", () => {
  it("returns null while the day timer is still running", () => {
    const s = newState();
    startDay(s);
    expect(sysSiege(s, 1)).toBeNull();
    expect(s.phase).toBe("day");
  });

  it("returns 'night' on the frame the day timer expires", () => {
    const s = newState();
    startDay(s);
    s.phaseT = 0.5;
    expect(sysSiege(s, 1)).toBe("night");
    expect(s.phase).toBe("night");
  });

  it("returns 'dawn' on the frame the night clock expires, even with zombies alive", () => {
    const s = newState();
    startNight(s);
    s.phaseT = 0.5;
    s.zombies = [{ id: 1 } as (typeof s.zombies)[number]]; // survivors remain — dawn still comes
    expect(sysSiege(s, 1)).toBe("dawn");
  });

  it("returns null at night while the clock is still running", () => {
    const s = newState();
    startNight(s); // phaseT = nightDuration(day) >> dt
    expect(sysSiege(s, 1)).toBeNull();
    expect(s.phase).toBe("night");
  });

  it("dawns at night's end with no held-night re-arm", () => {
    const s = newState();
    startNight(s);
    s.phaseT = 0.5;
    expect(sysSiege(s, 1)).toBe("dawn"); // no heldNight flag exists to re-arm the clock
  });
});

describe("nightDuration", () => {
  it("day 1 is the base duration", () => {
    expect(nightDuration(1)).toBe(55);
  });
  it("ramps with the day number", () => {
    expect(nightDuration(2)).toBe(63); // 55 + 1*8
    expect(nightDuration(5)).toBe(87); // 55 + 4*8
  });
  it("clamps to the max", () => {
    expect(nightDuration(100)).toBe(150);
  });
});

describe("nightMaxZombies", () => {
  it("day 1 is the base cap and ramps to the ceiling", () => {
    expect(nightMaxZombies(1)).toBe(45);
    expect(nightMaxZombies(2)).toBe(50); // 45 + 1*5
    expect(nightMaxZombies(10)).toBe(90); // 45 + 9*5, clamped at 90
    expect(nightMaxZombies(100)).toBe(90);
  });
});

describe("nightMaxZombies — occupancy", () => {
  it("is the day-only value for a single player (regression)", () => {
    expect(nightMaxZombies(1, 1)).toBe(CONFIG.siege.nightCapBase); // 45
    expect(nightMaxZombies(5, 1)).toBe(CONFIG.siege.nightCapBase + 4 * CONFIG.siege.nightCapPerDay);
  });

  it("raises the cap with squad size, bounded by nightCapPlayerMax", () => {
    expect(nightMaxZombies(1, 4)).toBe(45 + 3 * CONFIG.siege.nightCapPerPlayer);
    // the occupancy contribution is clamped
    const big = nightMaxZombies(1, 12);
    expect(big - 45).toBeLessThanOrEqual(CONFIG.siege.nightCapPlayerMax);
  });

  it("never exceeds the hard ceiling nightCapMax", () => {
    expect(nightMaxZombies(30, 12)).toBeLessThanOrEqual(CONFIG.siege.nightCapMax);
  });
});

describe("ambientForClock", () => {
  it("is full daylight mid-day", () => {
    // read from CONFIG so feel-tuning the ambient values doesn't break the curve tests
    expect(ambientForClock("day", 35, 1)).toBeCloseTo(CONFIG.siege.dayAmbient, 5); // phaseT == dayDuration
  });
  it("is gloom (not full black) mid-night", () => {
    expect(ambientForClock("night", nightDuration(1), 1)).toBeCloseTo(CONFIG.siege.nightAmbient, 5);
  });
  it("crossfades down toward dusk (late day darker than mid-day)", () => {
    const mid = ambientForClock("day", 35, 1);
    const dusk = ambientForClock("day", 1, 1); // almost dusk
    expect(dusk).toBeLessThan(mid);
    expect(dusk).toBeGreaterThanOrEqual(CONFIG.siege.nightAmbient);
  });
  it("lifts toward dawn (end of night brighter than mid-night)", () => {
    const midNight = ambientForClock("night", nightDuration(1), 1);
    const predawn = ambientForClock("night", 1, 1); // almost dawn
    expect(predawn).toBeGreaterThan(midNight);
  });
  it("holds flat dark during breached (phaseT is small, must not dawn-crossfade)", () => {
    expect(ambientForClock("breached", 3, 5)).toBe(CONFIG.siege.nightAmbient);
  });
  it("holds flat dark during resetting", () => {
    expect(ambientForClock("resetting", 0.5, 5)).toBe(CONFIG.siege.nightAmbient);
  });
});

describe("clockLabel / clockFrac", () => {
  it("day starts at 06:00 and ends at 18:00", () => {
    expect(clockLabel("day", 35, 1)).toBe("06:00"); // phaseT == dayDuration → start
    expect(clockLabel("day", 0, 1)).toBe("18:00"); // phaseT == 0 → dusk
  });
  it("night starts at 18:00 and ends at 06:00", () => {
    expect(clockLabel("night", nightDuration(1), 1)).toBe("18:00");
    expect(clockLabel("night", 0, 1)).toBe("06:00");
  });
  it("frac runs 0 at phase start to 1 at phase end", () => {
    expect(clockFrac("day", 35, 1)).toBeCloseTo(0, 5);
    expect(clockFrac("day", 0, 1)).toBeCloseTo(1, 5);
  });
});

function nightState() {
  const s = newState();
  s.running = true;
  startNight(s); // phase="night", phaseT=nightDuration(day)
  return s;
}

describe("isFortressBreached", () => {
  it("is false below the threshold and true at/above it", () => {
    expect(isFortressBreached(CONFIG.siege.breachZombies - 1)).toBe(false);
    expect(isFortressBreached(CONFIG.siege.breachZombies)).toBe(true);
    expect(isFortressBreached(CONFIG.siege.breachZombies + 5)).toBe(true);
  });
});

describe("isFortressBreached — occupancy", () => {
  it("uses the base threshold for a single player (regression)", () => {
    expect(isFortressBreached(CONFIG.siege.breachZombies - 1, 1)).toBe(false);
    expect(isFortressBreached(CONFIG.siege.breachZombies, 1)).toBe(true); // 14
  });

  it("raises the threshold with squad size (a big party is not more fragile)", () => {
    const players = 6;
    const raised = CONFIG.siege.breachZombies + (players - 1) * CONFIG.siege.breachPerPlayer;
    expect(isFortressBreached(CONFIG.siege.breachZombies, players)).toBe(false); // 14 no longer breaches
    expect(isFortressBreached(raised - 1, players)).toBe(false);
    expect(isFortressBreached(raised, players)).toBe(true);
  });
});

describe("sysSiege reset machine", () => {
  it("breached counts down to resetting, resetting counts down to 'reset'", () => {
    const s = newState();
    s.running = true;
    s.phase = "breached";
    s.phaseT = CONFIG.siege.breachedDuration;
    // exhaust breached
    let out: ReturnType<typeof sysSiege> = null;
    for (let i = 0; i < Math.ceil(CONFIG.siege.breachedDuration * 60) + 2; i++)
      out = sysSiege(s, 1 / 60);
    expect(s.phase).toBe("resetting");
    // exhaust resetting
    for (let i = 0; i < Math.ceil(CONFIG.siege.resettingDuration * 60) + 2 && out !== "reset"; i++)
      out = sysSiege(s, 1 / 60);
    expect(out).toBe("reset");
  });
});

describe("sysSiege breach detection", () => {
  it("fires 'breached' after the interior stays overrun for breachSustain, and freezes the clock there", () => {
    const s = nightState();
    // place enough zombies inside the HOME rect to be overrun. A fresh night state has zombies:[]
    // (startNight only arms the spawner), so DON'T spread s.zombies[0] (it is undefined) — build a
    // minimal literal; sysSiege's breach count reads only x/y. Matches the existing cast style in
    // this file (e.g. `{ id: 1 } as (typeof s.zombies)[number]`).
    for (let i = 0; i < CONFIG.siege.breachZombies + 2; i++) {
      s.zombies.push({ id: 1000 + i, x: 0, y: 0 } as (typeof s.zombies)[number]);
    }
    let out: ReturnType<typeof sysSiege> = null;
    // step past the sustain window
    const steps = Math.ceil(CONFIG.siege.breachSustain / (1 / 60)) + 2;
    for (let i = 0; i < steps && out !== "breached"; i++) out = sysSiege(s, 1 / 60);
    expect(out).toBe("breached");
    expect(s.phase).toBe("breached");
    expect(s.phaseT).toBeCloseTo(CONFIG.siege.breachedDuration, 5);
    expect(s.breachT).toBe(0); // sysSiege's breach transition zeroes breachT via enterBreached
  });

  it("does not fire when the interior is empty (breachT decays)", () => {
    const s = nightState();
    for (let i = 0; i < 30; i++) expect(sysSiege(s, 1 / 60)).not.toBe("breached");
    expect(s.breachT).toBe(0);
  });

  it("accumulates breachT while overrun then decays to 0 once interior clears", () => {
    const s = nightState();
    // Disarm the wave spawner so sysWave doesn't interfere with indoor counts.
    s.wave.def = null;
    // place enough zombies inside HOME to be overrun (above threshold)
    for (let i = 0; i < CONFIG.siege.breachZombies + 2; i++) {
      s.zombies.push({ id: 2000 + i, x: 0, y: 0 } as (typeof s.zombies)[number]);
    }
    // run for fewer frames than breachSustain allows — breachT accumulates but breach hasn't fired
    const accumFrames = Math.floor(CONFIG.siege.breachSustain * 0.5 * 60); // half the sustain window
    for (let i = 0; i < accumFrames; i++) sysSiege(s, 1 / 60);
    expect(s.phase).toBe("night"); // not yet breached — clock still running
    expect(s.breachT).toBeGreaterThan(0); // overrun count accumulated breachT
    // now clear the interior — breachT should decay back to 0
    s.zombies.length = 0;
    const decayFrames = Math.ceil(s.breachT * 60) + 5;
    for (let i = 0; i < decayFrames; i++) sysSiege(s, 1 / 60);
    expect(s.breachT).toBe(0); // decayed to 0 once interior is empty
  });
});

describe("resetArena", () => {
  it("rebuilds a fresh Day-1: clears the horde, restores barricades/economy, revives players", () => {
    const s = newState();
    s.running = true;
    s.day = 6;
    s.phase = "resetting";
    s.kills = 120;
    s.salvageBanked = 300;
    s.breachT = 5;
    s.zombies.push({ ...(s.zombies[0] ?? {}), id: 9999, x: 0, y: 0 } as (typeof s.zombies)[number]);
    s.bullets.push({} as (typeof s.bullets)[number]);
    for (const b of s.barricades) b.hp = 1;
    const p = s.players[0] as (typeof s.players)[number];
    p.hp = 0;

    resetArena(s);

    expect(s.day).toBe(1);
    expect(s.phase).toBe("day");
    expect(s.zombies.some((z) => z.id === 9999)).toBe(false); // the stale day-6 zombie is gone
    expect(s.zombies.length).toBe(CONFIG.siege.roamersPerDay); // fresh Day-1 roamers seeded
    expect(s.bullets.length).toBe(0);
    expect(s.kills).toBe(0);
    expect(s.salvageBanked).toBe(0);
    expect(s.breachT).toBe(0);
    expect(s.barricades.every((b) => b.hp === CONFIG.siege.boardMaxHp)).toBe(true);
    expect(p.hp).toBe(p.maxHp); // revived
  });

  it("despawns a live stalker so it does not carry into the fresh Day-1", () => {
    const s = newState();
    s.running = true;
    s.phase = "resetting";
    spawnStalker(s); // place a stalker as if a breach happened mid-night
    expect(s.stalker).not.toBeNull();

    resetArena(s);

    expect(s.stalker).toBeNull();
  });
});

describe("rearmThaw", () => {
  it("night: arms the wave without touching phaseT or caches", () => {
    const s = newState();
    s.phase = "night";
    s.day = 4;
    s.phaseT = 20;
    (s.caches[0] as (typeof s.caches)[number]).looted = true;
    rearmThaw(s);
    expect(s.phaseT).toBe(20); // clock preserved
    expect((s.caches[0] as (typeof s.caches)[number]).looted).toBe(true); // caches preserved
    expect(s.wave.def).not.toBeNull(); // wave armed (startWave ran)
    expect(s.zombies.length).toBe(0); // startWave arms the spawner; it doesn't spawn synchronously
  });

  it("day: seeds roamers without touching phaseT or caches", () => {
    const s = newState();
    s.phase = "day";
    s.phaseT = 15;
    (s.caches[0] as (typeof s.caches)[number]).looted = true;
    rearmThaw(s);
    expect(s.phaseT).toBe(15);
    expect((s.caches[0] as (typeof s.caches)[number]).looted).toBe(true);
    expect(s.zombies.length).toBe(CONFIG.siege.roamersPerDay);
  });
});

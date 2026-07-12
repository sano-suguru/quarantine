import { describe, expect, it } from "vitest";
import { newState } from "../state";
import { sysBullets } from "./bullets";
import { spawnZombie } from "./wave";

describe("bullets fx events", () => {
  it("killing a zombie pushes a kill event (no direct Audio/fx)", () => {
    const s = newState();
    spawnZombie(s, "walker", 1, 1);
    const z = s.zombies[s.zombies.length - 1];
    if (!z) throw new Error("spawnZombie did not add a zombie");
    z.x = 100;
    z.y = 100;
    z.hp = 1;
    // sysBullets queries the spatial hash — populate it so the bullet can hit the zombie
    s.hash.clear();
    s.hash.insert(s.zombies.length - 1, z.x, z.y);
    s.bullets.push({
      id: 1,
      x: 100,
      y: 100,
      px: 100,
      py: 100,
      vx: 0,
      vy: 0,
      r: 4,
      dmg: 999,
      life: 1,
      pierce: 0,
      knockback: 0,
      color: [1, 1, 1],
    });
    sysBullets(s, 1 / 60);
    const kills = s.fxEvents.filter((e) => e.t === "kill");
    expect(kills).toHaveLength(1);
    expect(kills[0]).toMatchObject({ big: false });
  });
});

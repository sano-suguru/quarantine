# Deployable Look + Drone Orbit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the three deployables read as what they are (quad drone, heavy sentry, supply crate) and give the drone an autonomous orbit-on-watch idle behaviour.

**Architecture:** One logic task (drone orbit + a target-release fix, TDD against `deployables.test.ts`) followed by three draw-only tasks that rewrite the branches of `game.ts:drawDeployables`. Visuals use only existing render primitives; behaviour rides the existing `movement` capability block and the host-only, `state.time`-driven sim — no new wire fields, no `CONFIG` change.

**Tech Stack:** TypeScript (strict), custom WebGL2 renderer (`R.rect/circle/glow/ring/tri/hex`), Vitest, Biome, Bun.

## Global Constraints

- **No engine changes, no bespoke branches.** Visuals use only `R.rect/circle/glow/ring/tri/hex`. Behaviour extends the existing `DeployableDef.movement` block. (CLAUDE.md: data-driven, zero special-case debt.)
- **Draw code may read only snapshot-synced deployable fields:** `id, defId, x, y, aim, hpFrac, reloading`. Host-only sim fields (`targetId, emitCd, weaponCd, reloadT, ammoLeft, hp, anchorId`) are **NOT** in the snapshot — using them in `drawDeployables` makes the visual wrong/dead on every non-host client. Drive any animated intensity from `reloading` or `state.time`.
- **Single-player must stay byte-for-byte unchanged** in behaviour; co-op stays in sync because all new sim is deterministic and `state.time`-driven.
- **Testing scope (CLAUDE.md):** only pure/deterministic logic is unit-tested. The drone orbit logic IS tested. The rendering ("feel") is **deliberately not** unit-tested — its gate is `typecheck` + `lint` + `build` plus a **playtest checkpoint**.
- Quality gates that must stay green: `bun run typecheck`, `bun run lint`, `bun run test`, `bun run build`.

---

### Task 1: Drone orbit-on-watch + target release fix

**Files:**
- Modify: `src/types.ts:312` (add `orbitSpeed` to the `movement` shape)
- Modify: `src/data/deployables.ts:47` (set `orbitSpeed` on the `drone` def)
- Modify: `src/systems/deployables.ts:69-74` (idle branch → orbit) and `src/systems/deployables.ts:112-114` (release `targetId`)
- Test: `src/systems/deployables.test.ts` (append two tests)

**Interfaces:**
- Consumes: `sysDeployables(state, dt)`, `DEPLOYABLE_TYPES`, `place()` / `zombieAt()` test helpers (already in the test file), `len()` from `engine/math`.
- Produces: `DeployableDef.movement.orbitSpeed: number` (required field). Idle drones orbit their anchor at radius `hoverDist`, angle `(id*1.618 % 2π) + state.time*orbitSpeed`. `d.targetId` is set to `undefined` whenever no zombie is in weapon range.

- [ ] **Step 1: Write the failing tests**

Append to `src/systems/deployables.test.ts`:

```ts
describe("sysDeployables — drone orbit-on-watch", () => {
  it("orbits the anchor over time instead of holding a fixed angle behind it", () => {
    const s = newState(); // player 0 at (0,0)
    s.zombies = [];
    const d = place(s, "drone");
    const p0 = s.players[0] as State["players"][number];
    const hoverDist = DEPLOYABLE_TYPES.drone?.movement?.hoverDist ?? 46;

    // settle at time 0
    for (let i = 0; i < 80; i++) sysDeployables(s, 0.05);
    const r0 = len(d.x - p0.x, d.y - p0.y);
    expect(r0).toBeLessThanOrEqual(hoverDist + 4); // sits on the orbit ring (+ deadzone slack)
    const angle0 = Math.atan2(d.y - p0.y, d.x - p0.x);

    // advance sim time → the orbit angle must sweep (a fixed-angle hover would not move)
    s.time = 3;
    for (let i = 0; i < 80; i++) sysDeployables(s, 0.05);
    const angle1 = Math.atan2(d.y - p0.y, d.x - p0.x);
    const dA = Math.abs(((angle1 - angle0 + Math.PI) % (2 * Math.PI)) - Math.PI);
    expect(dA).toBeGreaterThan(0.3);
  });

  it("releases targetId when the last zombie leaves weapon range (returns to orbit)", () => {
    const s = newState();
    s.zombies = [];
    const d = place(s, "drone");
    d.x = 0;
    d.y = 0;
    const z = zombieAt(s, 100, 0, 1e9); // inside drone weapon range (320)
    sysDeployables(s, 0.016);
    expect(d.targetId).toBe(z.id); // acquired

    z.x = 5000; // alive but far outside weapon range
    sysDeployables(s, 0.016); // tickWeapon must clear the stale target
    expect(d.targetId).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bunx vitest run src/systems/deployables.test.ts -t "orbit-on-watch"`
Expected: FAIL — the orbit test fails (current idle angle ignores `state.time`, so `dA ≈ 0`) and the release test fails (`d.targetId` stays set; also a TS error if `orbitSpeed` is read before Step 3 adds it).

- [ ] **Step 3: Add the `orbitSpeed` field to the type and the drone def**

In `src/types.ts:312`, change:
```ts
  movement?: { speed: number; leashMax: number; hoverDist: number; switchMargin: number };
```
to:
```ts
  movement?: { speed: number; leashMax: number; hoverDist: number; switchMargin: number; orbitSpeed: number };
```

In `src/data/deployables.ts:47`, change:
```ts
    movement: { speed: 210, leashMax: 160, hoverDist: 46, switchMargin: 80 },
```
to:
```ts
    movement: { speed: 210, leashMax: 160, hoverDist: 46, switchMargin: 80, orbitSpeed: 0.7 },
```

- [ ] **Step 4: Replace the idle branch with the orbit in `tickMovement`**

In `src/systems/deployables.ts`, replace the no-target `else` branch (currently lines 69-74):
```ts
  } else {
    // hover behind the anchor, with a per-id angular offset so multiple drones don't stack
    const a = anchor.aim + Math.PI + ((d.id * 1.618) % (Math.PI * 2));
    gx = anchor.x + Math.cos(a) * m.hoverDist;
    gy = anchor.y + Math.sin(a) * m.hoverDist;
  }
```
with:
```ts
  } else {
    // idle: orbit the anchor on watch. the per-id golden-angle phase spreads multiple drones
    // around the ring; state.time drives the sweep so it's deterministic (host & client agree).
    const a = ((d.id * 1.618) % (Math.PI * 2)) + state.time * m.orbitSpeed;
    gx = anchor.x + Math.cos(a) * m.hoverDist;
    gy = anchor.y + Math.sin(a) * m.hoverDist;
    // face the direction of travel (orbit tangent) + a slow scan wobble
    d.aim = a + Math.PI / 2 + Math.sin(state.time * 1.3) * 0.25;
  }
```

- [ ] **Step 5: Release `targetId` when nothing is in range in `tickWeapon`**

In `src/systems/deployables.ts`, in `tickWeapon`'s target resolution, change the final `else` (currently lines 112-114):
```ts
  } else {
    target = null;
  }
```
to:
```ts
  } else {
    target = null;
    d.targetId = undefined; // no zombie in range → release so tickMovement returns to orbit
  }
```

- [ ] **Step 6: Run the new tests + the whole deployables suite**

Run: `bunx vitest run src/systems/deployables.test.ts`
Expected: PASS — both new tests pass and all pre-existing deployable tests stay green (the leash test now converges to `hoverDist`, still `<= leashMax+1`).

- [ ] **Step 7: Typecheck**

Run: `bun run typecheck`
Expected: no errors (the `orbitSpeed` field is required and supplied by the only `movement` def).

- [ ] **Step 8: Commit**

```bash
git add src/types.ts src/data/deployables.ts src/systems/deployables.ts src/systems/deployables.test.ts
git commit -m "feat(deployables): drone orbit-on-watch idle + release stale target"
```

---

### Task 2: Drone visual — quad / X silhouette

**Files:**
- Modify: `src/game.ts:722-734` (the `visual === "drone"` branch of `drawDeployables`)

**Interfaces:**
- Consumes: `R` (renderer), `d` (deployable: reads `x, y, aim, reloading`), `r, g, b` (def colour), `state.time`, `drawDeployableHp(R, d, x, y)`.
- Produces: none (draw-only).

- [ ] **Step 1: Replace the drone draw branch**

In `src/game.ts`, replace the `if (visual === "drone") { … }` block (currently lines 722-734) with:
```ts
    if (visual === "drone") {
      // an airborne quad: a ground shadow stays put while the body bobs above it
      const by = d.y + Math.sin(state.time * 4 + d.x * 0.05) * 3;
      R.circle(d.x, d.y, 8, 0, 0, 0, 0.28); // shadow (no bob)
      R.glow(d.x, by, 18, r, g, b, d.reloading ? 0.2 : 0.45); // under-body scanner; dims on reload
      // chassis: two arms crossing in an X (oriented to aim) + a small core
      const arm = 11;
      R.rect(d.x, by, arm * 2, 2.5, d.aim + Math.PI / 4, r, g, b, 0.85);
      R.rect(d.x, by, arm * 2, 2.5, d.aim - Math.PI / 4, r, g, b, 0.85);
      R.hex(d.x, by, 5, state.time * 1.5, r, g, b, 1); // core body
      // four rotors at the arm tips; a fast-spinning tri reads as blade blur
      const rot = state.time * 14;
      for (const off of [Math.PI / 4, (3 * Math.PI) / 4, (5 * Math.PI) / 4, (7 * Math.PI) / 4]) {
        const rx = d.x + Math.cos(d.aim + off) * arm;
        const ry = by + Math.sin(d.aim + off) * arm;
        R.ring(rx, ry, 4, r, g, b, 0.7); // rotor housing
        R.tri(rx, ry, 3.5, rot, r, g, b, 0.5); // blade blur
      }
      // forward camera eye; dims while reloading (reloading is snapshot-synced, targetId is not)
      const ex = d.x + Math.cos(d.aim) * 9;
      const ey = by + Math.sin(d.aim) * 9;
      R.glow(ex, ey, 6, r, g, b, d.reloading ? 0.3 : 0.8);
      drawDeployableHp(R, d, d.x, by);
    } else if (visual === "crate") {
```

- [ ] **Step 2: Typecheck + lint**

Run: `bun run typecheck && bun run lint`
Expected: no errors.

- [ ] **Step 3: Build**

Run: `bun run build`
Expected: build succeeds (`dist/` produced).

- [ ] **Step 4: Playtest checkpoint (feel gate — required, not optional)**

Run `bun run dev`, start a run, buy a Hunter Drone, and confirm by eye: it reads as a small quadcopter (X arms + four spinning rotors + a forward eye), it visibly **circles the player on watch** when no zombies are near, and it breaks off to engage when one comes in range. Tune `arm`, rotor speed (`state.time * 14`), and `orbitSpeed` (Task 1, `data/deployables.ts`) in-game if needed. **State the result honestly before committing** (CLAUDE.md feel-first).

- [ ] **Step 5: Commit**

```bash
git add src/game.ts
git commit -m "feat(feel): drone reads as a quadcopter — X-arm chassis + four rotors"
```

---

### Task 3: Sentry/turret visual — heavier sentry

**Files:**
- Modify: `src/game.ts:743-752` (the turret `else` branch of `drawDeployables`)

**Interfaces:**
- Consumes: `R`, `d` (reads `x, y, aim, reloading`), `r, g, b`, `drawDeployableHp`.
- Produces: none (draw-only). Collider stays `radius: 12` — the drawn base/legs are sized close to it so the "what blocks me" read doesn't drift far from the silhouette.

- [ ] **Step 1: Replace the turret draw branch**

In `src/game.ts`, replace the final `else { … }` block of `drawDeployables` (currently lines 743-752) with:
```ts
    } else {
      // turret: tripod base + rotating housing + twin barrels that track the target
      R.glow(d.x, d.y, 26, r, g, b, d.reloading ? 0.2 : 0.4);
      // tripod: three static splayed struts under the base
      for (const leg of [Math.PI / 2, Math.PI / 2 + (2 * Math.PI) / 3, Math.PI / 2 + (4 * Math.PI) / 3]) {
        R.rect(d.x + Math.cos(leg) * 9, d.y + Math.sin(leg) * 9, 10, 3.5, leg, 0.28, 0.3, 0.32, 1);
      }
      R.circle(d.x, d.y, 12, 0.18, 0.2, 0.22, 1); // base plate (matches collider radius)
      R.ring(d.x, d.y, 12, r, g, b, 0.8);
      R.hex(d.x, d.y, 7, d.aim, r, g, b, 1); // rotating housing
      // twin barrels along aim, offset perpendicular so it reads as a gun not a stick
      const px = Math.cos(d.aim + Math.PI / 2);
      const py = Math.sin(d.aim + Math.PI / 2);
      const bx = d.x + Math.cos(d.aim) * 14;
      const byy = d.y + Math.sin(d.aim) * 14;
      R.rect(bx + px * 3, byy + py * 3, 20, 3.5, d.aim, r, g, b, 1);
      R.rect(bx - px * 3, byy - py * 3, 20, 3.5, d.aim, r, g, b, 1);
      // muzzle glow at the barrel tips; dims while reloading
      const mx = d.x + Math.cos(d.aim) * 24;
      const my = d.y + Math.sin(d.aim) * 24;
      R.glow(mx, my, d.reloading ? 4 : 7, r, g, b, d.reloading ? 0.2 : 0.5);
      drawDeployableHp(R, d, d.x, d.y);
    }
```

- [ ] **Step 2: Typecheck + lint**

Run: `bun run typecheck && bun run lint`
Expected: no errors.

- [ ] **Step 3: Build**

Run: `bun run build`
Expected: build succeeds.

- [ ] **Step 4: Playtest checkpoint (feel gate — required)**

Run `bun run dev`, buy an Auto-Sentry, and confirm: it reads as an anchored auto-cannon (tripod base, rotating housing, twin barrels) and the barrels track the nearest zombie with a muzzle flare on fire. **State the result honestly before committing.**

- [ ] **Step 5: Commit**

```bash
git add src/game.ts
git commit -m "feat(feel): sentry reads as a cannon — tripod base + twin tracking barrels"
```

---

### Task 4: Supply station visual — supply crate + beacon

**Files:**
- Modify: `src/game.ts:735-742` (the `visual === "crate"` branch of `drawDeployables`)

**Interfaces:**
- Consumes: `R`, `d` (reads `x, y`), `r, g, b`, `def.emitter?.interval`, `state.time`, `drawDeployableHp`.
- Produces: none (draw-only). Beacon brightness is driven by `state.time` (client-safe), NOT `d.emitCd` (host-only, not in the snapshot).

- [ ] **Step 1: Replace the crate draw branch**

In `src/game.ts`, replace the `else if (visual === "crate") { … }` block (currently lines 735-742) with:
```ts
    } else if (visual === "crate") {
      // supply station: a glowing crate with a beacon that ramps toward each drop.
      // phase from state.time (synced on host & client) — emitCd is host-only, not in snapshots.
      const interval = def.emitter?.interval ?? 8;
      const frac = (state.time % interval) / interval; // 0..1 toward the next drop
      const beacon = 0.3 + 0.6 * frac * frac; // ramps brighter as the drop nears
      R.glow(d.x, d.y, 24, r, g, b, 0.3 + beacon * 0.3);
      R.rect(d.x, d.y, 20, 16, 0, 0.5, 0.42, 0.26, 1); // crate body
      R.rect(d.x, d.y, 20, 4, 0, r, g, b, 0.9); // colour band
      // corner bolts
      for (const sx of [-1, 1]) {
        for (const sy of [-1, 1]) {
          R.rect(d.x + sx * 8, d.y + sy * 6, 2.5, 2.5, 0, r, g, b, 0.8);
        }
      }
      // supply mark: a small cross on the top face
      R.rect(d.x, d.y, 7, 2, 0, 0.9, 0.9, 0.85, 0.9);
      R.rect(d.x, d.y, 2, 7, 0, 0.9, 0.9, 0.85, 0.9);
      // beacon light on top, flashes as the drop nears
      R.glow(d.x, d.y - 12, 5, r, g, b, beacon);
      R.ring(d.x, d.y, 12, r, g, b, 0.7);
      drawDeployableHp(R, d, d.x, d.y);
    } else {
```

- [ ] **Step 2: Typecheck + lint**

Run: `bun run typecheck && bun run lint`
Expected: no errors.

- [ ] **Step 3: Build**

Run: `bun run build`
Expected: build succeeds.

- [ ] **Step 4: Playtest checkpoint (feel gate — required)**

Run `bun run dev`, buy a Supply Station, and confirm: it reads as a supply crate (corner bolts + a cross on top) and the beacon **visibly ramps brighter toward each ammo drop**, flashing around the drop. **State the result honestly before committing.**

- [ ] **Step 5: Commit**

```bash
git add src/game.ts
git commit -m "feat(feel): supply station reads as a crate + drop-countdown beacon"
```

---

## Self-Review

**Spec coverage:**
- §1 drone orbit (orbitSpeed field, idle branch, tangent/scan facing) → Task 1 steps 3-4. ✓
- §1 engage→idle `targetId` release fix → Task 1 step 5 (+ test step 1). ✓
- §1 dynamics-to-accept (anchor-moving arc, deadzone) → no code; documented in spec, not a task. ✓
- §2 drone quad visual → Task 2. ✓
- §3 sentry visual + collider unchanged note → Task 3 (collider untouched). ✓
- §4 station crate + beacon (state.time, not emitCd) → Task 4. ✓
- Testing: idle orbit bound + engage→idle release asserts → Task 1 step 1; visuals not unit-tested (playtest checkpoints) → Tasks 2-4 step 4. ✓

**Placeholder scan:** No TBD/TODO/"handle edge cases"; every code step shows full code. ✓

**Type consistency:** `orbitSpeed: number` added in Task 1 step 3 is the only new symbol; read as `m.orbitSpeed` in step 4 and supplied by the drone def. Draw code reads only `x, y, aim, reloading` (synced) + `state.time` + `def.emitter?.interval` — no host-only fields. `drawDeployableHp(R, d, x, y)` signature matches existing usage. ✓

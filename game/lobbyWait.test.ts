import { describe, expect, it } from "vitest";
import { clientLobbyWaitModel, hostLobbyWaitModel } from "./lobbyWait";

describe("hostLobbyWaitModel", () => {
  it("shows Deploy as actionable immediately when hosting with zero peers", () => {
    const model = hostLobbyWaitModel({ isPublic: false, peerPids: [] });

    expect(model.steps.map((s) => [s.id, s.state])).toEqual([
      ["room", "done"],
      ["squad", "info"],
      ["deploy", "current"],
      ["raid", "future"],
    ]);
    expect(model.headline).toBe("Room is ready. Deploy solo or invite players.");
    expect(model.slots.map((s) => [s.label, s.state])).toEqual([
      ["You (host)", "filled"],
      ["Open slot", "empty"],
      ["Open slot", "empty"],
      ["Open slot", "empty"],
    ]);
    expect(model.primaryAction).toBe("Deploy raid");
  });

  it("shows connected peers as filled host-side slots without making Squad a gate", () => {
    const model = hostLobbyWaitModel({ isPublic: true, peerPids: [1, 2] });

    expect(model.steps.find((s) => s.id === "squad")?.state).toBe("info");
    expect(model.steps.find((s) => s.id === "deploy")?.state).toBe("current");
    expect(model.headline).toBe("3 players in lobby. Deploy when ready.");
    expect(model.slots.map((s) => s.label)).toEqual(["You (host)", "P2", "P3", "Open slot"]);
  });
});

describe("clientLobbyWaitModel", () => {
  it("shows relay as busy while joining by room code", () => {
    const model = clientLobbyWaitModel({ k: "joining" });

    expect(model.steps.map((s) => [s.id, s.state])).toEqual([
      ["room", "busy"],
      ["link", "future"],
      ["host", "future"],
      ["raid", "future"],
    ]);
    expect(model.tone).toBe("busy");
  });

  it("shows host waiting after the P2P link opens", () => {
    const model = clientLobbyWaitModel({ k: "connected" });

    expect(model.steps.map((s) => [s.id, s.state])).toEqual([
      ["room", "done"],
      ["link", "done"],
      ["host", "current"],
      ["raid", "future"],
    ]);
    expect(model.headline).toBe("Connected. Waiting for host to deploy.");
    expect(model.primaryAction).toBeUndefined();
    expect(model.slots.map((s) => [s.label, s.state])).toEqual([
      ["You", "filled"],
      ["Host", "filled"],
      ["Squad", "unknown"],
      ["Squad", "unknown"],
    ]);
  });

  it("marks the failing step as an error for both recoverable and terminal failures", () => {
    const failed = clientLobbyWaitModel({
      k: "failed",
      step: "link",
      msg: "connection failed (network/NAT) — check the code or try a personal device/network.",
    });
    const lost = clientLobbyWaitModel({
      k: "lost",
      step: "host",
      msg: "room is full — the squad is already at capacity (4).",
    });

    expect(failed.steps.find((s) => s.id === "link")?.state).toBe("error");
    expect(failed.tone).toBe("warn");
    expect(lost.steps.find((s) => s.id === "host")?.state).toBe("error");
    expect(lost.tone).toBe("warn");
  });
});

import { describe, expect, it } from "vitest";
import {
  clientLobbyWaitModel,
  clientManualFallbackWaitModel,
  hostLobbyWaitModel,
  manualLobbyWaitModel,
} from "./lobbyWait";

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
    expect(model.showManualFallback).toBe(false);
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

  it("opens manual fallback only for recoverable failures", () => {
    const failed = clientLobbyWaitModel({
      k: "failed",
      step: "link",
      msg: "connection failed (network/NAT) — try manual connect below.",
    });
    const lost = clientLobbyWaitModel({
      k: "lost",
      step: "host",
      msg: "room is full — the squad is already at capacity (4).",
    });

    expect(failed.steps.find((s) => s.id === "link")?.state).toBe("error");
    expect(failed.showManualFallback).toBe(true);
    expect(lost.steps.find((s) => s.id === "host")?.state).toBe("error");
    expect(lost.showManualFallback).toBe(false);
  });

  it("keeps the failed step warning-visible when recoverable failure opens manual fallback", () => {
    const model = clientManualFallbackWaitModel({
      k: "failed",
      step: "link",
      msg: "connection failed (network/NAT) — try manual connect below.",
    });

    expect(model.steps.map((s) => [s.id, s.label, s.state])).toEqual([
      ["codes", "Codes", "done"],
      ["link", "Link", "error"],
      ["host", "Host", "future"],
      ["raid", "Raid", "future"],
    ]);
    expect(model.tone).toBe("warn");
    expect(model.steps.some((s) => s.label === "Room")).toBe(false);
  });
});

describe("manualLobbyWaitModel", () => {
  it("uses Codes instead of Room for manual SDP exchange", () => {
    const model = manualLobbyWaitModel({ k: "codes", role: "client" });

    expect(model.steps.map((s) => [s.id, s.label])).toEqual([
      ["codes", "Codes"],
      ["link", "Link"],
      ["host", "Host"],
      ["raid", "Raid"],
    ]);
    expect(model.steps.find((s) => s.id === "codes")?.state).toBe("busy");
    expect(model.steps.some((s) => s.label === "Room")).toBe(false);
    expect(model.slots.map((s) => [s.label, s.state])).toEqual([
      ["You", "filled"],
      ["Host", "unknown"],
      ["Squad", "unknown"],
      ["Squad", "unknown"],
    ]);
  });

  it("shows host waiting after manual link opens", () => {
    const model = manualLobbyWaitModel({ k: "connected", role: "client" });

    expect(model.steps.map((s) => [s.id, s.state])).toEqual([
      ["codes", "done"],
      ["link", "done"],
      ["host", "current"],
      ["raid", "future"],
    ]);
    expect(model.headline).toBe("Manual link connected. Waiting for host to deploy.");
  });

  it("prompts the manual host to deploy after the peer link opens", () => {
    const model = manualLobbyWaitModel({ k: "connected", role: "host" });

    expect(model.steps.map((s) => [s.id, s.state])).toEqual([
      ["codes", "done"],
      ["link", "done"],
      ["host", "current"],
      ["raid", "future"],
    ]);
    expect(model.headline).toBe("Manual peer connected. Deploy when ready.");
    expect(model.detail).toBe("Press Deploy raid when your squad is ready.");
    expect(model.slots.map((s) => [s.label, s.state])).toEqual([
      ["You (host)", "filled"],
      ["Manual peer", "filled"],
      ["Open slot", "empty"],
      ["Open slot", "empty"],
    ]);
  });
});

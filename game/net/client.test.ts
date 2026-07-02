import { describe, expect, it } from "vitest";
import { Client } from "./client";
import type { PeerLink } from "./transport";

/** Minimal PeerLink double: records close() calls; the wire()/handlers are inert no-ops. */
class FakeLink implements PeerLink {
  closeCalls = 0;
  sendSnap(): void {}
  sendRel(): void {}
  onSnap(): void {}
  onRel(): void {}
  onOpen(): void {}
  onClose(): void {}
  close(): void {
    this.closeCalls++;
  }
}

describe("Client.dispose", () => {
  it("closes the underlying link", () => {
    const link = new FakeLink();
    const client = new Client(link);
    client.dispose();
    expect(link.closeCalls).toBe(1);
  });

  it("is idempotent — a second dispose does not re-close the link", () => {
    const link = new FakeLink();
    const client = new Client(link);
    client.dispose();
    client.dispose();
    expect(link.closeCalls).toBe(1);
  });
});

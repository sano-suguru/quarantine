import { afterEach, describe, expect, it, vi } from "vitest";
import { joinRoom } from "./signaling";

type Listener = (event: MessageEvent<string>) => void;

class FakeWebSocket {
  static readonly OPEN = 1;
  static instances: FakeWebSocket[] = [];

  readonly listeners = new Map<string, Listener[]>();
  readyState = FakeWebSocket.OPEN;

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  send(): void {}

  close(): void {
    this.readyState = 3;
  }

  emit(type: string, data: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener({ data: JSON.stringify(data) } as MessageEvent<string>);
    }
  }
}

describe("joinRoom", () => {
  const realWebSocket = globalThis.WebSocket;
  const realLocation = globalThis.location;

  afterEach(() => {
    vi.useRealTimers();
    globalThis.WebSocket = realWebSocket;
    globalThis.location = realLocation;
    FakeWebSocket.instances = [];
  });

  it("rejects when the signaling relay reports no host for the room", async () => {
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
    globalThis.location = { protocol: "http:", host: "localhost:5173" } as Location;

    const result = joinRoom("FAKE").then(
      () => "resolved",
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );

    FakeWebSocket.instances[0]?.emit("message", { t: "nohost" });

    await expect(result).resolves.toBe("room not found");
  });

  it("rejects when the room never answers with an offer", async () => {
    vi.useFakeTimers();
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
    globalThis.location = { protocol: "http:", host: "localhost:5173" } as Location;

    const result = joinRoom("FAKE").then(
      () => "resolved",
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );

    await vi.advanceTimersByTimeAsync(3000);

    await expect(result).resolves.toBe("room did not answer");
  });

  it("rejects with AbortError and closes the socket when aborted before an offer", async () => {
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
    globalThis.location = { protocol: "http:", host: "localhost:5173" } as Location;

    const controller = new AbortController();
    const result = joinRoom("FAKE", controller.signal).then(
      () => "resolved",
      (error: unknown) => (error as { name?: string }).name ?? String(error),
    );

    const ws = FakeWebSocket.instances[0];
    controller.abort();

    await expect(result).resolves.toBe("AbortError");
    expect(ws?.readyState).toBe(3); // socket closed to release the relay slot
  });
});

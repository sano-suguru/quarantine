export type LobbyWaitStepId = "room" | "squad" | "deploy" | "raid" | "link" | "host";
export type LobbyWaitStepState = "done" | "current" | "future" | "busy" | "error" | "info";
export type LobbyWaitTone = "ready" | "busy" | "warn";
export type LobbyWaitSlotState = "filled" | "empty" | "unknown";

export interface LobbyWaitStep {
  id: LobbyWaitStepId;
  label: string;
  detail: string;
  state: LobbyWaitStepState;
}

export interface LobbyWaitSlot {
  label: string;
  state: LobbyWaitSlotState;
  pid?: number;
}

export interface LobbyWaitModel {
  role: "host" | "client";
  tone: LobbyWaitTone;
  headline: string;
  detail: string;
  steps: LobbyWaitStep[];
  slots: LobbyWaitSlot[];
  primaryAction?: string;
}

export interface HostLobbyWaitInput {
  isPublic: boolean;
  peerPids: readonly number[];
}

export type ClientLobbyDisplayState =
  | { k: "joining" }
  | { k: "linking" }
  | { k: "connected" }
  | { k: "failed"; step: "room" | "link"; msg: string }
  | { k: "lost"; step: "room" | "link" | "host"; msg: string };

const hostSteps = (squad: LobbyWaitStepState, deploy: LobbyWaitStepState): LobbyWaitStep[] => [
  { id: "room", label: "Room", detail: "created", state: "done" },
  { id: "squad", label: "Squad", detail: "players join", state: squad },
  { id: "deploy", label: "Deploy", detail: "host starts", state: deploy },
  { id: "raid", label: "Raid", detail: "survive", state: "future" },
];

const clientSteps = (
  room: LobbyWaitStepState,
  link: LobbyWaitStepState,
  host: LobbyWaitStepState,
): LobbyWaitStep[] => [
  { id: "room", label: "Room", detail: "found", state: room },
  { id: "link", label: "Link", detail: "P2P ready", state: link },
  { id: "host", label: "Host", detail: "deploys", state: host },
  { id: "raid", label: "Raid", detail: "auto-start", state: "future" },
];

const hostSlots = (peerPids: readonly number[]): LobbyWaitSlot[] => {
  const filled: LobbyWaitSlot[] = [
    { label: "You (host)", state: "filled", pid: 0 },
    ...peerPids.slice(0, 3).map((pid) => ({ label: `P${pid + 1}`, state: "filled" as const, pid })),
  ];
  while (filled.length < 4) filled.push({ label: "Open slot", state: "empty" });
  return filled;
};

const clientSlots = (): LobbyWaitSlot[] => [
  { label: "You", state: "filled" },
  { label: "Host", state: "filled" },
  { label: "Squad", state: "unknown" },
  { label: "Squad", state: "unknown" },
];

export function hostLobbyWaitModel(input: HostLobbyWaitInput): LobbyWaitModel {
  const players = input.peerPids.length + 1;
  return {
    role: "host",
    tone: "ready",
    headline:
      input.peerPids.length === 0
        ? "Room is ready. Deploy solo or invite players."
        : `${players} players in lobby. Deploy when ready.`,
    detail: input.isPublic
      ? "Public room is listed. Players can join until you deploy."
      : "Share the room code. Players can join until you deploy.",
    steps: hostSteps("info", "current"),
    slots: hostSlots(input.peerPids),
    primaryAction: "Deploy raid",
  };
}

export function clientLobbyWaitModel(state: ClientLobbyDisplayState): LobbyWaitModel {
  switch (state.k) {
    case "joining":
      return {
        role: "client",
        tone: "busy",
        headline: "Finding room through relay.",
        detail: "Keep this screen open while the room answers.",
        steps: clientSteps("busy", "future", "future"),
        slots: [{ label: "You", state: "filled" } as LobbyWaitSlot],
      };
    case "linking":
      return {
        role: "client",
        tone: "busy",
        headline: "Establishing peer link.",
        detail: "This can take a moment on strict networks.",
        steps: clientSteps("done", "busy", "future"),
        slots: [{ label: "You", state: "filled" } as LobbyWaitSlot],
      };
    case "connected":
      return {
        role: "client",
        tone: "ready",
        headline: "Connected. Waiting for host to deploy.",
        detail: "The raid starts automatically when the host deploys.",
        steps: clientSteps("done", "done", "current"),
        slots: clientSlots(),
      };
    case "failed":
      return {
        role: "client",
        tone: "warn",
        headline: state.msg,
        detail: "Check the code, or try a personal device/network, then join again.",
        steps:
          state.step === "room"
            ? clientSteps("error", "future", "future")
            : clientSteps("done", "error", "future"),
        slots: [{ label: "You", state: "filled" }],
      };
    case "lost":
      return {
        role: "client",
        tone: "warn",
        headline: state.msg,
        detail: "Try another room or return to co-op.",
        steps:
          state.step === "room"
            ? clientSteps("error", "future", "future")
            : state.step === "link"
              ? clientSteps("done", "error", "future")
              : clientSteps("done", "done", "error"),
        slots: clientSlots(),
      };
  }
}

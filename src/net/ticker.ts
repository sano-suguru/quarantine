export interface Ticker {
  stop(): void;
}

/**
 * A background-immune heartbeat for the host's authoritative loop.
 *
 * A dedicated Web Worker fires `postMessage` every ~stepMs. Worker timers are NOT
 * throttled when the tab is hidden (unlike requestAnimationFrame, which pauses, and
 * main-thread timers, which get clamped to ~1s in background tabs). The `onTick`
 * callback runs on the MAIN thread (in the worker's message handler), so it still has
 * full DOM/Input access — letting the host keep simulating + broadcasting while its tab
 * is backgrounded, so co-op clients don't freeze when the host alt-tabs.
 *
 * (If a strict CSP is ever added, it must allow `worker-src blob:`.)
 */
export function startTicker(stepMs: number, onTick: () => void): Ticker {
  const src = `let id=null;onmessage=(e)=>{if(e.data&&e.data.ms){clearInterval(id);id=setInterval(()=>postMessage(0),e.data.ms);}else if(e.data==='stop'){clearInterval(id);}};`;
  const url = URL.createObjectURL(new Blob([src], { type: "text/javascript" }));
  const worker = new Worker(url);
  worker.onmessage = () => onTick();
  worker.postMessage({ ms: stepMs });
  return {
    stop() {
      worker.postMessage("stop");
      worker.terminate();
      URL.revokeObjectURL(url);
    },
  };
}

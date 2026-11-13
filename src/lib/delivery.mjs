// Copied from pi-projects core/lib, which no longer has a copy; this one is maintained here.
export function mayDeliver({ modelSelected, idle, focused, pending, draft, lastInteraction, paused, promptOpen, inFlight, now = Date.now() }) {
  return modelSelected && idle && focused && !pending && !draft && !paused && !promptOpen && !inFlight && now - lastInteraction >= 1500;
}

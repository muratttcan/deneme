// Off-main-thread compute for the gold-chance display.
//
// The PIMC rollout in simulate.js takes ~1-2 seconds in late-game states
// with several hidden cells. Running it on the main thread froze the UI
// (the setTimeout(0) wrapper only deferred the start, not the work
// itself). This module worker runs the rollout off-thread so clicks
// stay responsive while the chance is being recomputed.
//
// Protocol:
//   main → worker: { jobId, state, options? }
//   worker → main: { jobId, result }   on success
//   worker → main: { jobId, error }    on failure
// The main thread tracks `jobId` and ignores stale responses when the
// state has moved on.

import { computeChestProbabilities } from "./simulate.js";

self.onmessage = (e) => {
  const { jobId, state, options } = e.data;
  try {
    const result = computeChestProbabilities(state, options);
    self.postMessage({ jobId, result });
  } catch (err) {
    self.postMessage({ jobId, error: String(err && err.stack || err) });
  }
};

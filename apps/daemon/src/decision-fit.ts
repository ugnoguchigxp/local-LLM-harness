import type { DecisionHead, DecisionObservation } from "@larm/core";
import { DecisionError } from "./decision-errors";
/** Keep the HTTP event loop available while fitting; at most one training worker runs. */
export function fitDecisionHeadAsync(labels: string[], questionHash: string, train: DecisionObservation[]): Promise<DecisionHead> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./decision-fit-worker.ts", import.meta.url).href);
    const timeout = setTimeout(() => { worker.terminate(); reject(new DecisionError("decision_head_fit_timeout", 503)); }, 120_000);
    const finish = () => { clearTimeout(timeout); worker.terminate(); };
    worker.onmessage = event => { finish(); if (event.data.error) reject(new DecisionError("decision_head_fit_failed", 503)); else resolve(event.data.head); };
    worker.onerror = () => { finish(); reject(new DecisionError("decision_head_fit_failed", 503)); };
    worker.postMessage({ labels, questionHash, train });
  });
}

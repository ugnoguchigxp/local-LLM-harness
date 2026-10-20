import { fitDecisionHead } from "@larm/core";
declare const self: Worker;
self.onmessage = (event: MessageEvent) => {
  const { labels, questionHash, train } = event.data;
  try { self.postMessage({ head: fitDecisionHead(labels, questionHash, train) }); }
  catch { self.postMessage({ error: "decision_head_fit_failed" }); }
};

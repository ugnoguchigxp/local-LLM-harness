import { expect, test } from "bun:test";
import { fitDecisionHead, headProbabilities, decisionMetrics } from "./decision-head";

test("frozen output head learns a reversed label convention and evaluates only supplied observations", () => {
  const train = Array.from({ length: 200 }, (_, i) => ({ probabilities: i % 2 ? [.9, .1] : [.1, .9], label: i % 2 ? 1 : 0 }));
  const head = fitDecisionHead(["true", "false"], "question-hash", train);
  const evalRows = [{ probabilities: [.85, .15], label: 1 }, { probabilities: [.15, .85], label: 0 }];
  expect(decisionMetrics(head.labels, evalRows).accuracy).toBe(0);
  const metrics = decisionMetrics(head.labels, evalRows.map(r => ({ ...r, probabilities: headProbabilities(head, r.probabilities) })));
  expect(metrics.accuracy).toBe(1);
  expect(metrics.confusionMatrix).toEqual([[1, 0], [0, 1]]);
  expect(metrics.brier!).toBeLessThan(.2);
  expect(headProbabilities(head, [0, 1]).every(Number.isFinite)).toBe(true);
});

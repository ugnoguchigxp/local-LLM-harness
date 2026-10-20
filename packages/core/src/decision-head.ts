/** A small discriminative head over frozen d1 option log-probabilities. No threshold fitting. */
export type DecisionHead = { labels: string[]; weights: number[][]; bias: number[]; questionHash: string };
export type DecisionObservation = { probabilities: number[]; label: number };
export function headProbabilities(head: DecisionHead, probabilities: number[]): number[] {
  const x = probabilities.map(p => Math.log(Math.max(1e-7, p)));
  const logits = head.weights.map((row, i) => row.reduce((s, w, j) => s + w * x[j]!, head.bias[i]!));
  const max = Math.max(...logits);
  const exps = logits.map(v => Math.exp(v - max));
  const sum = exps.reduce((a, b) => a + b, 0);
  return exps.map(v => v / sum);
}
export function fitDecisionHead(labels: string[], questionHash: string, train: DecisionObservation[]): DecisionHead {
  const n = labels.length;
  const head = { labels, questionHash, weights: labels.map((_, i) => labels.map((_, j) => i === j ? 1 : 0)), bias: labels.map(() => 0) };
  // Full-batch deterministic descent; an identity penalty limits changes on small datasets.
  const features = train.map(row => row.probabilities.map(p => Math.log(Math.max(1e-7, p))));
  for (let epoch = 0; epoch < 400; epoch++) {
    const dw = labels.map(() => labels.map(() => 0));
    const db = labels.map(() => 0);
    train.forEach((row, r) => {
      const p = headProbabilities(head, row.probabilities);
      for (let i = 0; i < n; i++) {
        const d = (p[i]! - (row.label === i ? 1 : 0)) / train.length;
        db[i]! += d;
        for (let j = 0; j < n; j++) dw[i]![j]! += d * features[r]![j]!;
      }
    });
    for (let i = 0; i < n; i++) {
      head.bias[i]! -= .03 * (db[i]! + .01 * head.bias[i]!);
      for (let j = 0; j < n; j++) head.weights[i]![j]! -= .03 * (dw[i]![j]! + .01 * (head.weights[i]![j]! - (i === j ? 1 : 0)));
    }
  }
  return head;
}
export function decisionMetrics(labels: string[], rows: DecisionObservation[]) {
  const confusionMatrix = labels.map(() => labels.map(() => 0));
  const bins = Array.from({ length: 10 }, () => ({ count: 0, confidence: 0, correct: 0 }));
  let correct = 0, brier = 0, logLoss = 0;
  for (const row of rows) {
    const best = row.probabilities.indexOf(Math.max(...row.probabilities));
    const hit = Number(best === row.label);
    correct += hit;
    confusionMatrix[row.label]![best]!++;
    brier += row.probabilities.reduce((s, p, i) => s + (p - Number(row.label === i)) ** 2, 0);
    logLoss -= Math.log(Math.max(1e-7, row.probabilities[row.label]!));
    const confidence = row.probabilities[best]!;
    const bin = bins[Math.min(9, Math.floor(confidence * 10))]!;
    bin.count++; bin.confidence += confidence; bin.correct += hit;
  }
  const count = rows.length;
  return { count, accuracy: count ? correct / count : null, brier: count ? brier / count : null,
    logLoss: count ? logLoss / count : null,
    ece10: count ? bins.reduce((s, b) => s + Math.abs(b.correct - b.confidence), 0) / count : null,
    labels, confusionMatrix };
}

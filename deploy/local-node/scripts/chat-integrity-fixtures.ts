/** Fixed synthetic evidence; only placement changes between the five cases. */
export function instructionPlacements() {
  const key = "LARM_SYNTHETIC_LEDGER_KEY";
  const value = "cobalt-582941";
  const document = (`Synthetic reference notes.\n${"The blue triangle is on the empty test shelf.\n".repeat(220)}`).slice(0, 8200)
    + `\n${key}=${value}\nEnd of synthetic reference.`;
  const system = { role: "system", content: "Read the reference and answer the final question. Reply with the exact reference value only. If absent reply MISSING." };
  const history = [{ role: "user", content: "We are checking a synthetic ledger." }, { role: "assistant", content: "Ready for the reference." }];
  const question = { role: "user", content: `What is the exact value of ${key}?` };
  const material = { role: "system", content: document };
  return { document, value, cases: {
    "first-system": [{ ...system, content: `${system.content}\n${document}` }, ...history, question],
    "system-after-history": [system, ...history, material, question],
    "second-leading-system": [system, material, ...history, question],
    "middle-of-three-systems": [system, material, { role: "system", content: "Keep the exact spelling of the reference value." }, ...history, question],
    "user-after-history": [system, ...history, { ...material, role: "user" }, question],
  } };
}

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { localServiceLeaseRequestSchema, parseLocalServices, localServiceRevision } from "./local-service";
import { ServiceResourceLedger } from "./service-resource-ledger";
import type { Registry } from "./registry";
import type { ClusterState } from "./schema";
const doc = () => parse(readFileSync("config/local-node/local-services.yaml", "utf8"));
test("service registration rejects node/unit conflicts and consumer command injection", () => {
  const d = parseLocalServices(doc(), ["local-node"])[0]!;
  expect(localServiceRevision(d)).toBe(localServiceRevision({ ...d }));
  expect(() => parseLocalServices(doc(), ["other"])).toThrow();
  expect(() => localServiceLeaseRequestSchema.parse({ command: "sh" })).toThrow();
  const v = doc(); v.services.other = v.services["docling-desk"];
  expect(() => parseLocalServices(v, ["local-node"])).toThrow("duplicate");
});
test("compatibility service markers never reserve capacity or subtract observed memory twice", () => {
  const gib=1024**3, now=Date.now();
  const registry={nodes:[{id:"n",resources:{memoryTotalGB:128,reservedMemoryGB:16}}],runtimes:[],profiles:[],routes:[]} as unknown as Registry;
  const state={generatedAt:new Date(now).toISOString(),node:{...registry.nodes[0],online:true,telemetry:{status:"available",source:"test",observedAt:new Date(now).toISOString(),systemMemoryAvailableBytes:89*gib,acceleratorMemoryAvailableBytes:75*gib}},runtimes:[]} as ClusterState;
  const ledger=new ServiceResourceLedger(),input={registry,state,allocations:[],now,maxAgeMs:1000,accelerator:true};
  ledger.reserve("a","n",100*gib,input);ledger.observe("a",20*gib);
  expect(ledger.reservations()).toEqual([{node:"n",bytes:0,pendingBytes:0}]);
  expect(ledger.admission("n",100*gib,input)).toMatchObject({ok:true,nodes:[{effectiveLiveAvailableMemoryGB:59,incrementalMemoryGB:0}]});
  expect(ledger.admission("n",1,{...input,now:now+2000})).toMatchObject({ok:false,reason:"telemetry_unavailable"});
  ledger.release("a");expect(ledger.reservations()).toEqual([]);
});
test("image and mesh start with actual headroom despite a 56 GiB historical runtime estimate", () => {
  const gib=1024**3,now=Date.now();
  const registry={nodes:[{id:"n",resources:{memoryTotalGB:128,reservedMemoryGB:16}}],runtimes:[{id:"conversation",node:"n",resources:{estimatedMemoryGB:56}}],profiles:[],routes:[]} as unknown as Registry;
  const state={node:{id:"n",resources:registry.nodes[0]!.resources,telemetry:{status:"available",source:"test",observedAt:new Date(now).toISOString(),systemMemoryAvailableBytes:89*gib,acceleratorMemoryAvailableBytes:75*gib}},runtimes:[{id:"conversation",status:"HOT"}]} as ClusterState;
  const ledger=new ServiceResourceLedger(),input={registry,state,allocations:[],now,maxAgeMs:1000,accelerator:true};
  expect(ledger.admission("n",34*gib,input).ok).toBe(true);
  state.node.telemetry!.acceleratorMemoryAvailableBytes=15*gib;
  expect(ledger.admission("n",34*gib,input)).toMatchObject({ok:false,reason:"live_memory_exhausted"});
  expect(ledger.admission("n",34*gib,{...input,accelerator:false}).ok).toBe(true);
});

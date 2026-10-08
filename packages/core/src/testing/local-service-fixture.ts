export function nativeFile() {
  return { schemaVersion: "larm.local-services.v2", services: { fixture: {
    node: "local-node", backend: "systemd-process",
    deployment: { unit: "larm-local-service-fixture.service", stopUnit: "larm-local-service-fixture-stop.service", observeUnit: "larm-local-service-fixture-observe.service", members: ["larm-local-service-fixture-member.service"], release: "fixture-v1", manifestDigest: "1".repeat(64), endpoint: "http://127.0.0.1:19876", publicEndpoint: "http://127.0.0.1:19876" },
    readiness: { timeoutSeconds: 2, path: "/health/ready", status: "ready", capabilities: {} },
    activity: { secretRef: "fixture-token", pollSeconds: 1, staleAfterSeconds: 3 },
    lifecycle: { minInstances: 0, idleSeconds: 0, leaseSeconds: 30, gracefulStopSeconds: 10, restartPolicy: "on-next-ensure" },
    resources: { startupReservationBytes: 1000, cpuMaxCores: 1, maxInstances: 1, gpuAccess: false },
    storage: { dataRoot: "/mnt/fixture/data", mountPoint: "/mnt/fixture", filesystemUuid: "de97577d-c5d3-4b57-ac4b-3753a2f6d331", minFreeBytes: 1000 },
  } } };
}

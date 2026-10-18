import type { AgentConnectionCatalog } from "./agent-connection";

type Service = AgentConnectionCatalog["profileSelectors"][number]["services"][number];

/** Control services are discoverable without selecting or acquiring a Profile. */
export function controlCatalogServices(catalog: AgentConnectionCatalog, requestUrl: string): Array<Service & { url: string }> {
  const origin = new URL(requestUrl).origin;
  const services = new Map<string, Service & { url: string }>();
  for (const selector of catalog.profileSelectors) for (const service of selector.services) {
    const key = JSON.stringify([service.capability, service.protocol, service.model, service.endpoint]);
    if (!services.has(key)) services.set(key, {
      ...structuredClone(service), url: new URL(service.endpoint, origin).toString(),
    });
  }
  return [...services.values()];
}

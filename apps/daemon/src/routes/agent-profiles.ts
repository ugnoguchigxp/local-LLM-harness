import { agentIdentifierSchema } from "@larm/core";
import type { Hono, Context } from "hono";
import type { AgentConnectionController } from "../agent-connection-controller";
import { errorBody } from "../app-http";
import type { ControlEvent } from "../controller";

type AgentProfileListResult = {
  status: number;
  body: unknown;
};

export function registerAgentProfileRoutes(
  app: Hono,
  deps: { onEvent?: (event: ControlEvent) => void },
  getController: (context: Context) => AgentConnectionController | Response,
  respond: (context: Context, result: AgentProfileListResult) => Response,
): void {
  app.get("/v1/agent-profiles", (c) => {
    const feature = getController(c);
    if (feature instanceof Response) return feature;
    const result = feature.listProfilesV1();
    if (result.status === 200) {
      deps.onEvent?.({ name: "agent_profile_catalog_served", labels: { contract: "agent-connection.v1" } });
    }
    return respond(c, result);
  });

  app.get("/v2/agent-profiles", (c) => {
    const feature = getController(c);
    if (feature instanceof Response) return feature;
    const result = feature.listProfilesV2();
    if (result.status === 200) {
      deps.onEvent?.({ name: "agent_profile_catalog_served", labels: { contract: "agent-connection.v2" } });
    }
    return respond(c, result);
  });

  app.get("/v3/agent-profiles", (c) => {
    const feature = getController(c);
    if (feature instanceof Response) return feature;
    const searchParams = new URL(c.req.url).searchParams;
    const requestedProfiles = searchParams.getAll("profile");
    if (
      [...searchParams].some(([name]) => name !== "profile")
      || requestedProfiles.length > 1
      || (requestedProfiles.length === 1 && !agentIdentifierSchema.safeParse(requestedProfiles[0]).success)
    ) {
      return c.json(errorBody(
        "invalid_request",
        "at most one valid profile query parameter and no other query parameters are allowed",
      ), 400);
    }
    const result = feature.listProfilesV3(requestedProfiles[0]);
    if (result.status === 200) {
      deps.onEvent?.({ name: "agent_profile_catalog_served", labels: { contract: "agent-connection.v3" } });
    }
    return respond(c, result);
  });
}

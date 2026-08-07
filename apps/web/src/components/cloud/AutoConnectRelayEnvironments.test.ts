import { Discovery } from "@t3tools/client-runtime/relay";
import { EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { describe, expect, it } from "vite-plus/test";

import { selectRelayEnvironmentsToAutoConnect } from "./AutoConnectRelayEnvironments";

function discovered(
  environmentId: string,
  availability: Discovery.RelayDiscoveredEnvironment["availability"],
) {
  return {
    environment: {
      environmentId: EnvironmentId.make(environmentId),
      label: environmentId,
      endpoint: {
        httpBaseUrl: `https://${environmentId}.example.test`,
        wsBaseUrl: `wss://${environmentId}.example.test`,
        providerKind: "t3_relay",
      },
      linkedAt: "2026-08-05T00:00:00.000Z",
    },
    availability,
    status: Option.none(),
    error: Option.none(),
  } as Discovery.RelayDiscoveredEnvironment;
}

describe("selectRelayEnvironmentsToAutoConnect", () => {
  it("selects only online environments that are not registered or already attempted", () => {
    const online = EnvironmentId.make("online");
    const registered = EnvironmentId.make("registered");
    const attempted = EnvironmentId.make("attempted");
    const environments = new Map([
      [online, discovered(online, "online")],
      [registered, discovered(registered, "online")],
      [attempted, discovered(attempted, "online")],
      ["offline", discovered("offline", "offline")],
    ]);

    expect(
      selectRelayEnvironmentsToAutoConnect(
        environments,
        new Set([registered]),
        new Set([attempted]),
      ).map((environment) => environment.environmentId),
    ).toEqual([online]);
  });
});

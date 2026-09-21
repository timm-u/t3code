import {
  RelayConnectionRegistration,
  RelayConnectionTarget,
} from "@t3tools/client-runtime/connection";
import type { EnvironmentId } from "@t3tools/contracts";
import { Discovery } from "@t3tools/client-runtime/relay";
import { useCallback, useEffect, useRef } from "react";

import { environmentCatalog } from "~/connection/catalog";
import { useEnvironments, useRelayEnvironmentDiscovery } from "~/state/environments";
import { relayEnvironmentDiscovery } from "~/state/relay";
import { useAtomCommand } from "~/state/use-atom-command";

export function selectRelayEnvironmentsToAutoConnect(
  discovered: ReadonlyMap<string, Discovery.RelayDiscoveredEnvironment>,
  registeredEnvironmentIds: ReadonlySet<EnvironmentId>,
  attemptedEnvironmentIds: ReadonlySet<EnvironmentId>,
) {
  return [...discovered.values()]
    .filter(
      ({ environment, availability }) =>
        availability === "online" &&
        !registeredEnvironmentIds.has(environment.environmentId) &&
        !attemptedEnvironmentIds.has(environment.environmentId),
    )
    .map(({ environment }) => environment);
}

/**
 * T3 Connect is a device mesh, so an online signed-in environment should be
 * immediately usable. Persist newly discovered environments in the normal
 * connection catalog; the catalog's supervisors then own reconnect behavior.
 */
export function AutoConnectRelayEnvironments() {
  const discovery = useRelayEnvironmentDiscovery();
  const { environments } = useEnvironments();
  const registerEnvironment = useAtomCommand(environmentCatalog.register, {
    reportFailure: false,
  });
  const refreshRelayEnvironments = useAtomCommand(relayEnvironmentDiscovery.refresh, {
    reportFailure: false,
  });
  const attemptedEnvironmentIdsRef = useRef(new Set<EnvironmentId>());

  useEffect(() => {
    void refreshRelayEnvironments();
  }, [refreshRelayEnvironments]);

  const connectEnvironment = useCallback(
    async (environmentId: EnvironmentId, label: string) => {
      const result = await registerEnvironment(
        new RelayConnectionRegistration({
          target: new RelayConnectionTarget({ environmentId, label }),
        }),
      );
      if (result._tag === "Failure") {
        // A later discovery refresh should be allowed to retry transient failures.
        attemptedEnvironmentIdsRef.current.delete(environmentId);
        console.error("[t3-connect] Automatic environment connection failed", {
          environmentId,
        });
      }
    },
    [registerEnvironment],
  );

  useEffect(() => {
    const registeredEnvironmentIds = new Set(
      environments.map((environment) => environment.environmentId),
    );
    const discoveredEnvironmentIds = new Set(
      [...discovery.environments.values()].map(({ environment }) => environment.environmentId),
    );

    for (const environmentId of attemptedEnvironmentIdsRef.current) {
      if (!discoveredEnvironmentIds.has(environmentId)) {
        attemptedEnvironmentIdsRef.current.delete(environmentId);
      }
    }

    const environmentsToConnect = selectRelayEnvironmentsToAutoConnect(
      discovery.environments,
      registeredEnvironmentIds,
      attemptedEnvironmentIdsRef.current,
    );
    for (const environment of environmentsToConnect) {
      attemptedEnvironmentIdsRef.current.add(environment.environmentId);
      void connectEnvironment(environment.environmentId, environment.label);
    }
  }, [connectEnvironment, discovery.environments, environments]);

  return null;
}

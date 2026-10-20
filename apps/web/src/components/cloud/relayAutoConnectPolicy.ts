import type { EnvironmentId } from "@t3tools/contracts";
import type { Discovery } from "@t3tools/client-runtime/relay";

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

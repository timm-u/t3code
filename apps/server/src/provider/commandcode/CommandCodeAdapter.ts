import { ProviderDriverKind, type ProviderInstanceId } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import { ChildProcessSpawner } from "effect/process";
import * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";
import {
  AcpProviderCapabilitiesV2,
  makeAcpAdapterV2,
  type AcpAdapterV2Options,
  type AcpAdapterV2RuntimeInput,
  type AcpAdapterV2Flavor,
} from "@t3tools/provider-acp/server/adapter";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as EffectAcpErrors from "effect-acp/errors";
import type { SelfInvocation } from "@t3tools/shared/nodeRuntime";
import { makeProviderFailure } from "@t3tools/provider-core/server/failure";
import type * as AcpSchema from "effect-acp/compat";

const decodeQuestion = Schema.decodeUnknownOption(
  Schema.Struct({ question: Schema.NonEmptyString, options: Schema.Array(Schema.NonEmptyString) }),
);
const decodeAnswer = Schema.decodeUnknownOption(
  Schema.Union([Schema.String, Schema.Array(Schema.String)]),
);
const isAcpRequestError = Schema.is(EffectAcpErrors.AcpRequestError);

function commandCodeQuestion(
  request: AcpSchema.RequestPermissionRequest,
): ReturnType<NonNullable<AcpAdapterV2Flavor["extractPermissionQuestion"]>> {
  const decoded = decodeQuestion(request.toolCall.rawInput);
  if (
    request.toolCall.kind !== "other" ||
    decoded._tag === "None" ||
    request.options.length === 0 ||
    request.options.length !== decoded.value.options.length ||
    !request.options.every(
      (option, index) => option.optionId === `option_${index}` && option.kind === "allow_once",
    )
  )
    return undefined;
  const id = request.toolCall.toolCallId;
  return {
    question: {
      id,
      header: "Question",
      question: decoded.value.question,
      multiSelect: false,
      allowCustomAnswer: false,
      options: request.options.map((option, index) => ({
        value: option.optionId,
        label: decoded.value.options[index]!,
        description: option.name,
      })),
    },
    respond: (answers) => {
      const answer = decodeAnswer(answers[id]);
      if (answer._tag === "None") return undefined;
      const value = typeof answer.value === "string" ? answer.value : answer.value[0];
      const option = request.options.find(
        (option, index) => option.optionId === value || decoded.value.options[index] === value,
      );
      return option ? { outcome: { outcome: "selected", optionId: option.optionId } } : undefined;
    },
  };
}

const COMMAND_CODE_DRIVER = ProviderDriverKind.make("commandcode");

export function commandCodeSessionMode(policy: ProviderAdapter.ProviderAdapterV2RuntimePolicy) {
  return policy.interactionMode === "plan"
    ? "plan"
    : policy.runtimeMode === "full-access"
      ? "bypass"
      : "default";
}

export const makeCommandCodeAcpRuntime = (
  options: {
    readonly binaryPath: string;
    readonly environment: NodeJS.ProcessEnv;
    readonly spawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  },
  input: AcpAdapterV2RuntimeInput,
): Effect.Effect<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  EffectAcpErrors.AcpError,
  Crypto.Crypto | Scope.Scope
> =>
  Effect.gen(function* () {
    const { runtimePolicy: _policy, processEnvironment, ...runtimeInput } = input;
    const context = yield* Layer.build(
      AcpSessionRuntime.layer({
        ...runtimeInput,
        spawn: {
          command: options.binaryPath,
          args: ["acp", "--no-auto-update"],
          cwd: input.cwd,
          env: { ...options.environment, ...processEnvironment },
          extendEnv: true,
        },
      }).pipe(
        Layer.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, options.spawner)),
      ),
    );
    return yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(Effect.provide(context));
  });

export const makeCommandCodeAdapter = Effect.fn("makeCommandCodeAdapter")(function* (options: {
  readonly binaryPath: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly instanceId: ProviderInstanceId;
  readonly selfInvocation: SelfInvocation;
  readonly nativeLogging?: AcpAdapterV2Options["nativeLogging"];
  readonly onSessionConfigurationUpdate?: AcpAdapterV2Flavor["onSessionConfigurationUpdate"];
}) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  return yield* makeAcpAdapterV2({
    instanceId: options.instanceId,
    selfInvocation: options.selfInvocation,
    ...(options.nativeLogging === undefined ? {} : { nativeLogging: options.nativeLogging }),
    flavor: {
      driver: COMMAND_CODE_DRIVER,
      capabilities: AcpProviderCapabilitiesV2,
      extractPermissionQuestion: commandCodeQuestion,
      promptFailure: (cause) =>
        makeProviderFailure({
          cause,
          class: "provider_error",
          ...(isAcpRequestError(cause)
            ? { message: cause.errorMessage, code: String(cause.code) }
            : {}),
        }),
      sessionModeForPolicy: commandCodeSessionMode,
      ...(options.onSessionConfigurationUpdate === undefined
        ? {}
        : { onSessionConfigurationUpdate: options.onSessionConfigurationUpdate }),
      makeRuntime: (input) => makeCommandCodeAcpRuntime({ ...options, spawner }, input),
    },
  });
});

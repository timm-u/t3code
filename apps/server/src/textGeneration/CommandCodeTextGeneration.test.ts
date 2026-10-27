import { expect, it } from "@effect/vitest";
import { CommandCodeSettings, ProviderInstanceId } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import { writeFakeCli } from "@t3tools/provider-testing/fakeCli";
import { makeCommandCodeTextGeneration } from "./CommandCodeTextGeneration.ts";
const decodeSettings = Schema.decodeEffect(CommandCodeSettings);

it.live("runs review investigation read-only without creating a saved conversation", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "commandcode-generation-" });
    const binaryPath = yield* Effect.sync(() =>
      writeFakeCli({
        directory: cwd,
        name: "commandcode-text",
        source: `
const args = process.argv.slice(2);
if(args[args.indexOf('--permission-mode') + 1] !== 'plan' || args.includes('--yolo') || !args.includes('--no-session')) process.exit(2);
if(Number(args[args.indexOf('--max-turns') + 1]) < 2) process.exit(3);
let prompt = ''; for await (const chunk of process.stdin) prompt += chunk;
if(!prompt.includes('git diff')) process.exit(4);
process.stdout.write(JSON.stringify({type: 'result', subtype: 'success', finalText: JSON.stringify({stops: [{title: 'Review the change', summary: 'A guided review', attention: null, excerpts: [], files: [], notes: [], questions: []}]})}) + '\\n');
`,
      }),
    );
    const settings = yield* decodeSettings({ binaryPath });
    const generation = yield* makeCommandCodeTextGeneration(settings, process.env);
    const guide = yield* generation.generateReviewGuide({
      cwd,
      number: 1,
      title: "Test change",
      description: "Test",
      baseBranch: "main",
      baseCommit: "1234567",
      settledReview: "",
      modelSelection: { instanceId: ProviderInstanceId.make("commandcode-test"), model: "default" },
    });
    expect(guide.stops[0]?.title).toBe("Review the change");
    expect(guide.stops[0]?.summary).toBe("A guided review");
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

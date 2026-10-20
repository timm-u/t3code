import packageJson from "../package.json" with { type: "json" };

declare const __T3CODE_BUILD_VERSION__: string | undefined;

const injectedBuildVersion =
  typeof __T3CODE_BUILD_VERSION__ === "undefined" ? undefined : __T3CODE_BUILD_VERSION__.trim();

/** The release version embedded by the bundler, with package.json as the
 * development and test fallback. */
export const SERVER_VERSION = injectedBuildVersion || packageJson.version;

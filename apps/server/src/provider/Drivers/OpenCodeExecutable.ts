/** Only auto-migrate the default command or a removed npm-managed v1 install. */
export function canDiscoverOpenCode2(binaryPath: string): boolean {
  const normalized = binaryPath.trim().replaceAll("\\", "/");
  return (
    normalized === "" ||
    normalized === "opencode" ||
    /\/node_modules\/opencode-ai\/(?:.*\/)?(?:opencode|opencode\.exe)$/i.test(normalized)
  );
}

export function isOpenCode2Command(binaryPath: string): boolean {
  return /(?:^|[\\/])opencode2(?:\.exe|\.cmd|\.ps1)?$/i.test(binaryPath.trim());
}

/** Released v2 uses the same command name as v1. */
export function isOpenCode2Version(output: string): boolean {
  return /^(?:opencode\s+)?v?2\.\d+\.\d+(?:[-+][\w.-]+)?$/im.test(output.trim());
}

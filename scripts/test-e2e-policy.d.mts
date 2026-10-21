export const integrationTestFiles: readonly string[];
export const smokeTestTitles: readonly string[];
export const smokeBuildFiles: readonly string[];
export function smokeTitlesForPlatform(platform?: NodeJS.Platform): readonly string[];
export function e2eOptions(
  arguments_: string[],
  platform?: NodeJS.Platform
): {
  mode: 'smoke' | 'integration' | 'full';
  list: boolean;
  arguments: string[];
};
export function assertSmokeReport(report: unknown, platform?: NodeJS.Platform): void;

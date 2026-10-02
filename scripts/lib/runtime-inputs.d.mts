/** Types for runtime-inputs.mjs, which plain-Node start-app.mjs also imports. */
export declare const RUNTIME_INPUT_DIRECTORIES: string[];
export declare const RUNTIME_INPUT_FILES: string[];
export declare const RUNTIME_TOOL_PACKAGES: string[];
export declare function runtimeInputFiles(root: string): Record<string, string>;
export declare function runtimeInputDigest(files: Record<string, string>): string;
export declare function appArchiveDigest(appPath: string): string | null;
export declare function buildStampPath(appPath: string): string;
export declare function removeBuildStamp(appPath: string): void;
export interface BuildStamp {
  version: 1;
  builtAt: string;
  identity: string;
  inputs: string;
  app: string | null;
  files: Record<string, string>;
}
export declare function writeBuildStamp(root: string, appPath: string, identityHash: string, files: Record<string, string>): BuildStamp | undefined;
export declare function staleBundleReason(root: string, appPath: string): string | undefined;

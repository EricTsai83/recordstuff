/** Types for after-pack.mjs, a plain script so electron-builder loads it as the afterPack hook with any Node. */
export declare const CAPTURE_HELPER_INFO: Record<string, boolean>;
export declare function captureHelperPlist(appPath: string, productName: string): string;
export default function afterPack(context: { appOutDir: string; electronPlatformName: string; packager: { appInfo: { productFilename: string } } }): Promise<void>;

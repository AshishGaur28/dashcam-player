/** "0.1.0", from the release tag or package.json. */
export const VERSION: string = __APP_VERSION__;
/** Short commit of a CI push build ("" for release and local builds). */
export const BUILD: string = __APP_BUILD__;
/** "v0.1.0" or "v0.1.0 (build 4b9350c)". */
export const VERSION_LABEL = `v${VERSION}${BUILD ? ` (build ${BUILD})` : ''}`;

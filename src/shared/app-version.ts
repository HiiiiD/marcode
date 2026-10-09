// require, not import: package.json sits outside rootDir, and tsx, bun and the bun bundle all resolve it.
export const APP_VERSION = (require('../../package.json') as { version: string }).version;

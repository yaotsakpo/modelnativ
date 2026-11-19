/** Ajv's CommonJS default export, normalised once for ESM consumers. */
import AjvModule from "ajv";
export const Ajv = ((AjvModule as unknown as { default: typeof AjvModule }).default ?? AjvModule) as typeof AjvModule;
export type { ValidateFunction } from "ajv";

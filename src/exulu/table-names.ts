import { sanitizeName } from "@SRC/utils/sanitize-name";
export const getTableName = (id: string): string => sanitizeName(id) + "_items";
export const getChunksTableName = (id: string): string => sanitizeName(id) + "_chunks";

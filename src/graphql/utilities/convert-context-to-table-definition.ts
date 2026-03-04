import type { ExuluTableDefinition } from "@EXULU_TYPES/exulu-table-definition";
import { getTableName } from "@SRC/exulu/context";
import type { ExuluContext } from "@SRC/exulu/context";
import { sanitizeName } from "@SRC/utils/sanitize-name";
import { addCoreFields } from "@SRC/postgres/core-schema";

export const convertContextToTableDefinition = (context: ExuluContext): ExuluTableDefinition => {
  const tableName = getTableName(context.id) as any;
  const definition: ExuluTableDefinition = {
    type: "items",
    id: context.id,
    name: {
      singular: tableName,
      plural: tableName?.endsWith("s") ? tableName : ((tableName + "s") as any),
    },
    RBAC: true,
    processor: context.processor,
    fields: context.fields.map((field) => ({
      name: sanitizeName(field.name) as any,
      type: field.type,
      required: field.required,
      default: field.default,
      index: field.index,
      enumValues: field.enumValues,
      allowedFileTypes: field.allowedFileTypes,
      unique: field.unique,
    })),
  };
  definition.fields.push({
    name: "id",
    type: "text",
  });
  definition.fields.push({
    // important: the contexts use the default knex timestamp
    // fields which are different to the regular
    // ExuluTableDefinition, i.e. created_at vs. createdAt.
    name: "createdAt",
    type: "date",
  });
  definition.fields.push({
    name: "source",
    type: "text",
  });
  definition.fields.push({
    name: "updatedAt",
    type: "date",
  });
  definition.fields.push({
    name: "textlength",
    type: "number",
  });
  definition.fields.push({
    name: "ttl",
    type: "text",
  });
  definition.fields.push({
    name: "chunks_count",
    type: "number",
  });
  definition.fields.push({
    name: "name",
    type: "text",
  });
  definition.fields.push({
    name: "description",
    type: "text",
  });
  definition.fields.push({
    name: "external_id",
    type: "text",
  });
  definition.fields.push({
    name: "tags",
    type: "text",
  });
  definition.fields.push({
    name: "archived",
    type: "boolean",
  });
  return addCoreFields(definition);
};

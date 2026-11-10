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
      // Task 4 fix round 2, Critical: without this, every context item
      // table's fields lose their declared json schema on the way into
      // createMutations/createQueries -- the GraphQL write path (and
      // vector-search.ts's filter path, Task 5) would see `schema:
      // undefined` for every field, no matter what the context declares.
      // This is an explicit allowlist with NO spread (by design, so a
      // write-only secret like `hidden` doesn't leak into read-side SDL by
      // accident) -- which also means every new ExuluContextFieldDefinition
      // property has to be added here deliberately. `hidden` itself is a
      // known, still-open instance of exactly this failure mode (not fixed
      // here -- out of this task's scope); `schema` must not become a
      // second one.
      schema: field.schema,
    })),
  };
  // The core/system fields below are pushed AFTER the context's own fields,
  // and prepareItemWrite's `fieldsByName` (`new Map(fields.map(...))`) keeps
  // the LAST entry for a given name. So a context field that happens to
  // share a name with one of these (e.g. "name", "tags") would have its
  // `schema` silently overridden by the schema-less core definition below on
  // the GraphQL side, while the tool path (which reads `field.schema`
  // straight off `this.fields`, never through this converter) still
  // validates it -- the exact two-paths-disagree shape Task 4's Critical
  // fix exists to close, reopened one level up. Almost certainly
  // unreachable in practice (the name would also collide with the physical
  // column these core fields are declared for), but worth a line here so
  // the next person does not have to rediscover it the hard way.
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

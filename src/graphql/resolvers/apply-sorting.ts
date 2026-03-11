export const applySorting = (
  query: any,
  sort?: { field: string; direction: "ASC" | "DESC" },
  field_prefix?: string,
) => {
  const prefix = field_prefix ? field_prefix + "." : "";
  if (sort) {
    sort.field = prefix + sort.field;
    query = query.orderBy(sort.field, sort.direction.toLowerCase());
  }
  return query;
};

import type { ExuluFieldTypes } from "@EXULU_TYPES/enums/field-types";

export const mapType = (t, type: ExuluFieldTypes | "date" | "uuid" | "array", name: string, defaultValue?: any, unique?: boolean) => {
    if (type === "text") {
        t.text(name);
        if (unique) t.unique(name);
        return;
    }
    if (type === "longText") {
        t.text(name);
        if (unique) t.unique(name);
        return;
    }
    if (type === "shortText") {
        t.string(name, 100);
        if (unique) t.unique(name);
        return;
    }
    if (type === "number") {
        t.float(name);
        if (unique) t.unique(name);
        return;
    }
    if (type === "boolean") {
        t.boolean(name).defaultTo(defaultValue || false);
        if (unique) t.unique(name);
        return;
    }
    if (type === "code") {
        t.text(name);
        if (unique) t.unique(name);
        return;
    }
    if (type === "json") {
        t.jsonb(name);
        if (unique) t.unique(name);
        return;
    }
    if (type === "date") {
        t.timestamp(name);
        if (unique) t.unique(name);
        return;
    }
    if (type === "uuid") {
        t.uuid(name);
        if (unique) t.unique(name);
        return;
    }
    throw new Error("Invalid type: " + type);
}
import type { ExuluFieldTypes } from "@EXULU_TYPES/enums/field-types";

export const mapType = (t, type: ExuluFieldTypes | "date" | "uuid" | "array", name: string, defaultValue?: any) => {
    if (type === "text") {
        t.text(name);
        return;
    }
    if (type === "longText") {
        t.text(name);
        return;
    }
    if (type === "shortText") {
        t.string(name, 100);
        return;
    }
    if (type === "number") {
        t.float(name);
        return;
    }
    if (type === "boolean") {
        t.boolean(name).defaultTo(defaultValue || false);
        return;
    }
    if (type === "code") {
        t.text(name);
        return;
    }
    if (type === "json") {
        t.jsonb(name);
        return;
    }
    if (type === "date") {
        t.date(name);
        return;
    }
    if (type === "uuid") {
        t.uuid(name);
        return;
    }
    throw new Error("Invalid type: " + type);
}
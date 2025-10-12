import type { ExuluFieldTypes } from "@EXULU_TYPES/enums/field-types";

export const mapType = (t, type: ExuluFieldTypes | "date" | "uuid" | "array", name: string, defaultValue?: any, unique?: boolean) => {
    if (type === "text" || type === "enum") {
        if (defaultValue) { 
            t.text(name).defaultTo(defaultValue);
         } else {
            t.text(name);
        }
        if (unique) t.unique(name);
        return;
    }
    if (type === "file") {
        if (defaultValue) {
            t.text(name).defaultTo(defaultValue);
        } else {
            t.text(name);
        }
        if (unique) t.unique(name);
        return;
    }
    if (type === "longText") {
        if (defaultValue) {
            t.text(name).defaultTo(defaultValue);
        } else {
            t.text(name);
        }
        if (unique) t.unique(name);
        return;
    }
    if (type === "markdown") {
        if (defaultValue) {
            t.text(name).defaultTo(defaultValue);
        } else {
            t.text(name);
        }
        if (unique) t.unique(name);
        return;
    }
    if (type === "shortText") {
        if (defaultValue) {
            t.string(name, 100).defaultTo(defaultValue);
        } else {
            t.string(name, 100);
        }
        if (unique) t.unique(name);
        return;
    }
    if (type === "number") {
        if (defaultValue) {
            t.float(name).defaultTo(defaultValue);
        } else {
            t.float(name);
        }
        if (unique) t.unique(name);
        return;
    }
    if (type === "boolean") {
        t.boolean(name).defaultTo(defaultValue || false);
        if (unique) t.unique(name);
        return;
    }
    if (type === "code") {
        if (defaultValue) {
            t.text(name).defaultTo(defaultValue);
        } else {
            t.text(name);
        }
        if (unique) t.unique(name);
        return;
    }
    if (type === "json") {
        if (defaultValue) {
            t.jsonb(name).defaultTo(defaultValue);
        } else {
            t.jsonb(name);
        }
        if (unique) t.unique(name);
        return;
    }
    if (type === "date") {
        if (defaultValue) {
            t.timestamp(name).defaultTo(defaultValue);
        } else {
            t.timestamp(name);
        }
        if (unique) t.unique(name);
        return;
    }
    if (type === "uuid") {
        if (defaultValue) {
            t.uuid(name).defaultTo(defaultValue);
        } else {
            t.uuid(name);
        }
        if (unique) t.unique(name);
        return;
    }
    throw new Error("Invalid type: " + type);
}
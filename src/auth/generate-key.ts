import bcrypt from "bcryptjs";
import { postgresClient } from "../postgres/client";
const SALT_ROUNDS = 12;

async function encryptApiKey(apikey) {
    const hash = await bcrypt.hash(apikey, SALT_ROUNDS);
    return hash;
}

export const deleteApiKey = async (name: string): Promise<{ message: string }> => {
    const { db } = await postgresClient()
    const existing = await db.from("users").where({ name: name, type: "api" }).first();
    if (!existing) {
        return {
            message: "API key not found."
        }
    }
    await db.from("users").where({ id: existing.id }).delete();
    return {
        message: "API key deleted."
    }
}

export const generateApiKey = async (name: string, email: string): Promise<{ key: string }> => {

    const { db } = await postgresClient()

    console.log("[EXULU] Inserting default user and admin role.")
    const existingRole = await db.from("roles").where({ name: "admin" }).first();
    let roleId;

    if (!existingRole) {
        console.log("[EXULU] Creating default admin role.");
        const role = await db.from("roles").insert({
            name: "admin",
            is_admin: true,
            agents: []
        }).returning("id");
        roleId = role[0].id;
    } else {
        roleId = existingRole.id;
    }

    const newKeyName = name;
    const plainKey = `sk_${Math.random().toString(36).substring(2, 15)}_${Math.random().toString(36).substring(2, 15)}`;
    const postFix = `/${newKeyName.toLowerCase().trim().replaceAll(" ", "_")}`
    const encryptedKey = await encryptApiKey(plainKey)

    const existingApiUser = await db.from("users").where({ email: email }).first();
    if (!existingApiUser) {
        console.log("[EXULU] Creating default api user.");
        await db.from("users").insert({
            name: name,
            email: email,
            super_admin: true,
            createdAt: new Date(),
            updatedAt: new Date(),
            type: "api",
            apikey: `${encryptedKey}${postFix}`,
            // password: "admin", todo add this again when we implement password auth / encryption as alternative to OTP
            role: roleId
        });
        console.log("[EXULU] Default api user created. Key: ", `${plainKey}${postFix}`)
    } else {
        console.log("[EXULU] API user with that name already exists.")
    }
    console.log("[EXULU] Key generated, copy and use the plain key from here, you will not be able to access it again.")
    console.log("[EXULU] Key: ", `${plainKey}${postFix}`)
    return {
        key: `${plainKey}${postFix}`
    }
}
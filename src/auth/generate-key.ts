import bcrypt from "bcryptjs";
import { postgresClient } from "../postgres/client";
export const SALT_ROUNDS = 12;

export async function encryptString(string: string) {
  const hash = await bcrypt.hash(string, SALT_ROUNDS);
  return hash;
}

export const deleteApiKey = async (name: string): Promise<{ message: string }> => {
  const { db } = await postgresClient();
  const existing = await db.from("users").where({ name: name, type: "api" }).first();
  if (!existing) {
    return {
      message: "API key not found.",
    };
  }
  await db.from("users").where({ id: existing.id }).delete();
  return {
    message: "API key deleted.",
  };
};

export const generateApiKey = async (
  name: string,
  email: string,
  options?: {
    superAdmin?: boolean;
    roleName?: string;
    rolePermissions?: Record<string, "read" | "write">;
  },
): Promise<{ key: string }> => {
  const { db } = await postgresClient();

  email = String(email).trim().toLowerCase();

  const superAdmin = options?.superAdmin ?? true;
  const roleName = options?.roleName ?? "admin";
  const rolePermissions = options?.rolePermissions ?? {
    agents: "write",
    workflows: "write",
    variables: "write",
    users: "write",
  };

  console.log("[EXULU] Inserting default user and admin role.");
  const existingRole = await db.from("roles").where({ name: roleName }).first();
  let roleId;

  if (!existingRole) {
    console.log(`[EXULU] Creating default ${roleName} role.`);
    const role = await db
      .from("roles")
      .insert({
        name: roleName,
        ...rolePermissions,
      })
      .returning("id");
    roleId = role[0].id;
  } else {
    roleId = existingRole.id;
  }

  const newKeyName = name;
  const plainKey = `sk_${Math.random().toString(36).substring(2, 15)}_${Math.random().toString(36).substring(2, 15)}`;
  const postFix = `/${newKeyName.toLowerCase().trim().replaceAll(" ", "_")}`;
  const encryptedKey = await encryptString(plainKey);

  const existingApiUser = await db.from("users").where({ email: email }).first();
  if (!existingApiUser) {
    console.log("[EXULU] Creating default api user.");
    await db.from("users").insert({
      name: name,
      email: email,
      super_admin: superAdmin,
      createdAt: new Date(),
      updatedAt: new Date(),
      type: "api",
      emailVerified: new Date(),
      apikey: `${encryptedKey}${postFix}`,
      // password: "admin", todo add this again when we implement password auth / encryption as alternative to OTP
      role: roleId,
    });
    console.log("[EXULU] Default api user created. Key: ", `${plainKey}${postFix}`);
  } else {
    console.log("[EXULU] API user with that name already exists.");
  }
  return {
    key: `${plainKey}${postFix}`,
  };
};

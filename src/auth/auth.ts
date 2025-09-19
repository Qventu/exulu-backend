import { type User } from "@EXULU_TYPES/models/user"
import bcrypt from "bcryptjs";
import type { Knex } from "knex";

export const authentication = async ({
    apikey,
    authtoken,
    internalkey,
    db,
}: {
    authtoken?: any,
    apikey?: string
    internalkey?: string,
    db: Knex
}): Promise<{ error: boolean, message?: string, code?: number, user?: User }> => {

    // Used for communication between "internal" services
    // such as between the backend and the uppy file uploader.
    if (internalkey) {
        if (!process.env.INTERNAL_SECRET) {
            return {
                error: true,
                message: `Header "internal" provided, but no INTERNAL_SECRET was provided in the environment variables.`,
                code: 401
            };
        }

        if (process.env.INTERNAL_SECRET !== internalkey) {
            return {
                error: true,
                message: `Internal key was provided in header but did not match the INTERNAL_SECRET environment variable.`,
                code: 401
            };
        }

        return {
            error: false,
            code: 200,
            user: {
                type: "api",
                id: 192837465,
                email: "internal@exulu.com",
                role: {
                    id: "internal",
                    name: "Internal",
                    agents: "read",
                    workflows: "read",
                    variables: "read",
                    users: "read"
                }
            }
        }

    }

    if (authtoken) {
        try {
            // uses the raw encrypted JWE token provided by next-auth via
            // a "Bearer {token}" in the authorization header.

            console.log("[EXULU] authtoken", authtoken)

            if (!authtoken?.email) {
                return {
                    error: true,
                    message: `No email provided in session ${JSON.stringify(authtoken)}`,
                    code: 401
                }
            }

            const user = await db.from("users").select("*").where("email", authtoken?.email).first()

            if (user?.role) {
                const role = await db.from("roles").select("*").where("id", user?.role).first()
                if (role) {
                    user.role = role;
                }
            }

            if (!user) {
                return {
                    error: true,
                    message: `No user found for email: ${authtoken.email}`,
                    code: 401
                }
            }
            return {
                error: false,
                code: 200,
                user
            };

        } catch (error: any) {
            console.error(error)
            return {
                error: true,
                message: "Invalid token.",
                code: 401
            };
        }
    }
    if (apikey) {

        const users = await db.from("users").select("*").where("type", "api")

        if (!users || users.length === 0) {
            return {
                error: true,
                message: `No API users found.`,
                code: 401
            };
        }

        const request_key_parts = apikey.split("/");
        const request_key_name = request_key_parts.pop();
        const request_key_last_slash_index = apikey.lastIndexOf("/");
        const request_key_compare_value = apikey.substring(0, request_key_last_slash_index);

        if (!request_key_name) {
            return {
                error: true,
                message: "Provided api key does not include postfix with key name ({key}/{name}).",
                code: 401
            }
        }

        if (!request_key_compare_value) {
            return {
                error: true,
                message: "Provided api key is not in the correct format.",
                code: 401
            }
        }

        const filtered = users.filter(({ apikey, id }: { apikey: string, id: string }) => apikey.includes(request_key_name))

        for (const user of filtered) {
            const user_key_last_slash_index = user.apikey.lastIndexOf("/");
            const user_key_compare_value = user.apikey.substring(0, user_key_last_slash_index);
            const isMatch = await bcrypt.compare(request_key_compare_value, user_key_compare_value);
            if (isMatch) {

                await db.from("users")
                    .where({ id: user.id })
                    .update({
                        last_used: new Date()
                    })
                    .returning("id");

                if (user?.role) {
                    const role = await db.from("roles").select("*").where("id", user?.role).first()
                    if (role) {
                        user.role = role;
                    }
                }

                return {
                    error: false,
                    code: 200,
                    user: user as any
                };
            }
        }
        console.log("[EXULU] No matching api key found.")
        return {
            error: true,
            message: "No matching api key found.",
            code: 401
        }
    }

    return {
        error: true,
        message: "Either an api key or authorization key must be provided.",
        code: 401
    }

}
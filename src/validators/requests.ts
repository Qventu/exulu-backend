import { type User } from "@EXULU_TYPES/models/user";
import { getToken } from "../auth/get-token.ts"; // old: next-auth/jwt
import { postgresClient } from "../postgres/client.ts";
import { authentication } from "../auth/auth.ts";

export const requestValidators = {
  authenticate: async (
    req,
  ): Promise<{ error: boolean; message?: string; code?: number; user?: User }> => {
    const apikey: any = req.headers["exulu-api-key"] || null;

    const { db } = await postgresClient();

    let authtoken: any = null;
    if (typeof apikey !== "string") {
      // default to next auth tokens to authenticate
      authtoken = await getToken((req.headers["authorization"] || req.headers["x-api-key"]) ?? "");
    }
    return await authentication({
      authtoken,
      apikey,
      db: db,
    });
  },
  workflows: (req): { error: boolean; message?: string; code?: number } => {
    const contentType = req.headers["content-type"] || "";

    if (!contentType.includes("application/json")) {
      return {
        error: true,
        code: 400,
        message: "Unsupported content type.",
      };
    }

    if (!req.body) {
      return {
        error: true,
        code: 400,
        message: "Missing body.",
      };
    }

    if (!req.body.agent) {
      return {
        error: true,
        code: 400,
        message: "Missing agent in body.",
      };
    }

    if (!req.body.session) {
      return {
        error: true,
        code: 400,
        message: "Missing session in body.",
      };
    }

    if (!req.body.inputs) {
      return {
        error: true,
        code: 400,
        message: "Missing inputs in body.",
      };
    }

    if (!req.body.label) {
      return {
        error: true,
        code: 400,
        message: "Missing label for job in body.",
      };
    }

    return {
      error: false,
    };
  },
  embedders: (
    req,
    configuration?: Record<
      string,
      {
        type: "string" | "number" | "query";
        example: string;
      }
    >,
  ): { error: boolean; message?: string; code?: number } => {
    const contentType = req.headers["content-type"] || "";

    if (!contentType.includes("application/json")) {
      return {
        error: true,
        code: 400,
        message: "Unsupported content type.",
      };
    }

    if (!req.body) {
      return {
        error: true,
        code: 400,
        message: "Missing body.",
      };
    }

    if (!req.body.inputs) {
      return {
        error: true,
        code: 400,
        message: "Missing inputs.",
      };
    }

    if (!req.body.label) {
      return {
        error: true,
        code: 400,
        message: "Missing label for job in body.",
      };
    }

    if (configuration) {
      for (const key in configuration) {
        if (!req.body.configuration[key]) {
          return {
            error: true,
            code: 400,
            message: `Missing ${key} in body.configuration.`,
          };
        }
      }
    }

    return {
      error: false,
    };
  },
  agents: (req): { error: boolean; message?: string; code?: number } => {
    const contentType = req.headers["content-type"] || "";
    if (!contentType.includes("application/json")) {
      return {
        error: true,
        code: 400,
        message: "Unsupported content type.",
      };
    }

    if (!req.body) {
      return {
        error: true,
        code: 400,
        message: "Missing body.",
      };
    }

    if (!req.body.message && !req.body.messages) {
      return {
        error: true,
        code: 400,
        message: 'Missing "message" or "messages" property in body.',
      };
    }

    return {
      error: false,
    };
  },
};

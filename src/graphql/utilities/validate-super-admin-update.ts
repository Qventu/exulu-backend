import { requestValidators } from "src/validators/requests";

export const validateCreateOrRemoveSuperAdminPermission = async (
  tableNamePlural: string,
  input: any,
  req: any,
) => {
  // Check if trying to update super_admin field for users table
  if (tableNamePlural === "users" && input.super_admin !== undefined) {
    const authResult = await requestValidators.authenticate(req);

    if (authResult.error || !authResult.user) {
      throw new Error("Authentication failed");
    }

    // Only super_admin can update super_admin field
    if (!authResult.user.super_admin) {
      throw new Error("Only super administrators can modify super_admin status");
    }
  }
};

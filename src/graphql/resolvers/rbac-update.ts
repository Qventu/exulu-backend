// Helper function to handle RBAC updates
export const handleRBACUpdate = async (
    db: any,
    entityName: string,
    resourceId: string,
    rbacData: any,
    existingRbacRecords: any[],
  ) => {
    const { users = [], roles = [] /* projects = [] */ } = rbacData;
  
    // Get existing RBAC records if not provided
    if (!existingRbacRecords) {
      existingRbacRecords = await db
        .from("rbac")
        .where({
          entity: entityName,
          target_resource_id: resourceId,
        })
        .select("*");
    }
  
    // Create sets for comparison
    const newUserRecords = new Set(users.map((u: any) => `${u.id}:${u.rights}`));
    const newRoleRecords = new Set(roles.map((r: any) => `${r.id}:${r.rights}`));
    // const newProjectRecords = new Set(projects.map((p: any) => `${p.id}:${p.rights}`));
    const existingUserRecords = new Set(
      existingRbacRecords
        .filter((r) => r.access_type === "User")
        .map((r) => `${r.user_id}:${r.rights}`),
    );
    const existingRoleRecords = new Set(
      existingRbacRecords
        .filter((r) => r.access_type === "Role")
        .map((r) => `${r.role_id}:${r.rights}`),
    );
  
    // Records to create
    const usersToCreate = users.filter(
      (u: any) => !existingUserRecords.has(`${u.id}:${u.rights}`),
    );
    const rolesToCreate = roles.filter(
      (r: any) => !existingRoleRecords.has(`${r.id}:${r.rights}`),
    );
    // const projectsToCreate = projects.filter((p: any) => !existingProjectRecords.has(`${p.id}:${p.rights}`));
  
    // Records to remove
    const usersToRemove = existingRbacRecords.filter(
      (r) =>
        r.access_type === "User" &&
        !newUserRecords.has(`${r.user_id}:${r.rights}`),
    );
    const rolesToRemove = existingRbacRecords.filter(
      (r) =>
        r.access_type === "Role" &&
        !newRoleRecords.has(`${r.role_id}:${r.rights}`),
    );
    // const projectsToRemove = existingRbacRecords
    //     .filter(r => r.access_type === 'Project' && !newProjectRecords.has(`${r.project_id}:${r.rights}`));
  
    // Remove obsolete records
    if (usersToRemove.length > 0) {
      await db
        .from("rbac")
        .whereIn(
          "id",
          usersToRemove.map((r) => r.id),
        )
        .del();
    }
    if (rolesToRemove.length > 0) {
      await db
        .from("rbac")
        .whereIn(
          "id",
          rolesToRemove.map((r) => r.id),
        )
        .del();
    }
  
    // Create new records
    const recordsToInsert: any[] = [];
  
    usersToCreate.forEach((user: any) => {
      recordsToInsert.push({
        entity: entityName,
        access_type: "User",
        target_resource_id: resourceId,
        user_id: user.id,
        rights: user.rights,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
    });
  
    rolesToCreate.forEach((role: any) => {
      recordsToInsert.push({
        entity: entityName,
        access_type: "Role",
        target_resource_id: resourceId,
        role_id: role.id,
        rights: role.rights,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
    });
  
    if (recordsToInsert.length > 0) {
      await db.from("rbac").insert(recordsToInsert);
    }
  };
  
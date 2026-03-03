export const RBACResolver = async (
    db: any,
    entityName: string,
    resourceId: string,
    rights_mode: string,
  ): Promise<{
    type: string;
    users: any[];
    roles: any[];
    // projects: any[]
  }> => {
    // Get RBAC records for this resource
    const rbacRecords = await db
      .from("rbac")
      .where({
        entity: entityName,
        target_resource_id: resourceId,
      })
      .select("*");
  
    const users = rbacRecords
      .filter((r) => r.access_type === "User")
      ?.map((r) => ({ id: r.user_id, rights: r.rights }));
  
    const roles = rbacRecords
      .filter((r) => r.access_type === "Role")
      ?.map((r) => ({ id: r.role_id, rights: r.rights }));
  
    /* const projects = rbacRecords
          .filter(r => r.access_type === 'Project')
          ?.map(r => ({ id: r.project_id, rights: r.rights })); */
  
    // Determine the type based on rights_mode or presence of records
    let type = rights_mode || "private";
    if (type === "users" && users.length === 0) type = "private";
    if (type === "roles" && roles.length === 0) type = "private";
    // if (type === 'projects' && projects.length === 0) type = 'private';
  
    return {
      type,
      users,
      roles,
      // projects
    };
  };
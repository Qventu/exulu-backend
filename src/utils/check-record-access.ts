import type { Agent } from "@EXULU_TYPES/models/agent";
import type { User } from "@EXULU_TYPES/models/user";

const checkRecordAccessCache = new Map<string, {
    hasAccess: boolean,
    expiresAt: Date
}>();

export const checkRecordAccess = async (record: any, request: "read" | "write", user?: User): Promise<boolean> => {

    const setRecordAccessCache = (hasAccess: boolean) => {
        checkRecordAccessCache.set(`${record.id}-${request}-${user?.id}`, {
            hasAccess: hasAccess,
            expiresAt: new Date(Date.now() + 1000 * 60 * 1) // 1 minute
        });
    }

    const cachedAccess = checkRecordAccessCache.get(`${record.id}-${request}-${user?.id}`);
    if (cachedAccess && cachedAccess.expiresAt > new Date()) {
        return cachedAccess.hasAccess;
    }
    // Check access rights
    const isPublic = record.rights_mode === "public";
    const byUsers = record.rights_mode === "users";
    const byRoles = record.rights_mode === "roles";

    const createdBy = typeof record.created_by === "string" ? record.created_by : record.created_by?.toString();
    const isCreator = user ? createdBy === user.id.toString() : false;
    const isAdmin = user ? user.super_admin : false;
    const isApi = user ? user.type === "api" : false;

    let hasAccess: "read" | "write" | "none" = "none";

    if (isPublic || isCreator || isAdmin || isApi) {
        setRecordAccessCache(true);
        return true;
    }

    if (byUsers) {
        if (!user) {
            setRecordAccessCache(false);
            return false;
        }
        hasAccess = record.RBAC?.users?.find(x => x.id === user.id)?.rights as "read" | "write" | "none" || "none";
        if (!hasAccess || hasAccess === "none" || hasAccess !== request) {
            console.error(`[EXULU] Your current user ${user.id} does not have access to this record, current access type is: ${hasAccess}.`);
            setRecordAccessCache(false);
            return false;
        } else {
            setRecordAccessCache(true);
            return true;
        }
    }

    if (byRoles) {
        if (!user) {
            setRecordAccessCache(false);
            return false;
        }
        hasAccess = record.RBAC?.roles?.find(x => x.id === user.role?.id)?.rights as "read" | "write" | "none" || "none";
        if (!hasAccess || hasAccess === "none" || hasAccess !== request) {
            console.error(`[EXULU] Your current role ${user.role?.name} does not have access to this record, current access type is: ${hasAccess}.`);
            setRecordAccessCache(false);
            return false;
        } else {
            setRecordAccessCache(true);
            return true;
        }
    }
    // todo add projects
    setRecordAccessCache(false);
    return false;
}
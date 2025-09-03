export interface AgentSession {
    createdAt: string;
    updatedAt: string;
    id: string;
    metadata: any;
    agentId: string;
    resourceId: string;
    title: string;
    created_by: string;
    rights_mode: 'private' | 'users' | 'roles' | 'public' | 'project'
    RBAC?: {
        type?: string;
        users?: Array<{ id: string; rights: 'read' | 'write' }>;
        roles?: Array<{ id: string; rights: 'read' | 'write' }>;
    };
}
export interface AgentMessage {
    id: string;
    thread_id: string;
    content: string;
    role: "function" | "data" | "user" | "system" | "assistant" | "tool";
    type: string;
    createdAt: Date;
}
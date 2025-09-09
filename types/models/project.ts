export interface Project {
    id: string;
    name: string;
    description: string;
    custom_instructions: string;
    rights_mode?: 'private' | 'users' | 'roles' | 'public';
    created_by?: string;
    RBAC?: {
        type?: string;
        users?: Array<{ id: string; rights: 'read' | 'write' }>;
        roles?: Array<{ id: string; rights: 'read' | 'write' }>;
    };
    createdAt?: string;
    updatedAt?: string;
}
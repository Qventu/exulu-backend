export interface Agent {
    id: string;
    backend: string;
    type: "chat" | "flow";
    name: string;
    active?: boolean;
    public?: boolean;
    description?: string;
    slug?: string;
    tools?: {
        id: string;
        description: string;
        type?: "context";
    }[];
    capabilities?: {
        text: boolean;
        images: string[];
        files: string[];
        audio: string[];
        video: string[];
    }
}
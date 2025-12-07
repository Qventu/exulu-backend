export interface Item {
    id?: string;
    name?: string;
    description?: string,
    createdAt?: string;
    updatedAt?: string;
    external_id?: string;
    source?: string;
    tags?: string[];
    textlength?: number;
    last_processed_at?: string;
    chunks?: {
        id: string;
        index: number;
        content: string;
        source: string;
        embedding_size: number;
        createdAt: string;
        updatedAt: string;
    }[];
    [key: string]: any;
}
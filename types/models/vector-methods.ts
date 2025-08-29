export const VectorMethodEnum = {
    "cosineDistance": "cosineDistance",
    "hybridSearch": "hybridSearch",
    "tsvector": "tsvector"
} as const;

export type VectorMethod = (typeof VectorMethodEnum)[keyof typeof VectorMethodEnum];
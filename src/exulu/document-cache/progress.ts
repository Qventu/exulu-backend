/** Progress of reading one document into the store; delivered to every caller waiting on it. */
export type ProgressFn = (p: {
  phase: "text" | "ocr" | "vision" | "storing";
  pagesDone: number;
  pagesTotal: number;
}) => void;

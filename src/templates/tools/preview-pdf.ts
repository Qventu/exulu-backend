import { z } from "zod";
import { ExuluTool } from "../../registry/classes";
import { getPresignedUrl } from "../../registry/uppy";

export const previewPdfTool = new ExuluTool({
    id: "preview_pdf",
    name: "Preview PDF",
    description: "Used to display a PDF file in an iframe web view",
    type: "function",
    config: [],
    inputSchema: z.object({
        s3key: z.string().describe("The S3 key of the PDF file to preview, can also optionally include a [bucket:name] to specify the bucket."),
        page: z.number().describe("The page number to preview, defaults to 1.").optional(),
    }),
    execute: async ({ s3key, page, exuluConfig }) => {
        const url = await getPresignedUrl(s3key, exuluConfig);
        if (!url) {
            throw new Error("No URL provided for PDF preview");
        }
        return {
            result: JSON.stringify({
                url,
                page: page ?? 1,
            }),
        };
    },
});
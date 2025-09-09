import { ExuluContext } from "../../registry/classes";

export const filesContext = new ExuluContext({
    id: "files_default_context",
    name: "Files",
    description: "Files that can be used with Exulu agents.",
    configuration: {
        defaultRightsMode: "private",
        calculateVectors: "manual"
    },
    fields: [
        {
            name: "type",
            type: "text"
        },
        {
            name: "s3bucket",
            type: "text"
        },
        {
            name: "s3region",
            type: "text"
        },
        {
            name: "url",
            type: "text"
        },
        {
            name: "s3key",  // ID of the file in S3 storage
            type: "text"
        },
        {
            name: "s3endpoint",
            type: "text"
        },
        {
            name: "content",
            type: "longText"
        }
    ],
    active: true
})
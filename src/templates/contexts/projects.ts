import { ExuluContext } from "../../registry/classes";

export const projectsContext = new ExuluContext({
    id: "projects",
    name: "Projects",
    description: "Default context that stores files and data related to projects in Exulu.",
    configuration: {
        defaultRightsMode: "projects",
    },
    fields: [{
        name: "Type",
        type: "text"
    }, {
        name: "Summary",
        type: "longText"
    }],
    active: true
})
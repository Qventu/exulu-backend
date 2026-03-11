import type { STATISTICS_TYPE } from "./enums/statistics";

export type ExuluStatisticParams = Omit<ExuluStatistic, "total" | "name" | "type">;

export type ExuluStatistic = {
    name: string;
    label: string;
    type: STATISTICS_TYPE;
    trigger: STATISTICS_LABELS;
    total: number;
};

export type STATISTICS_LABELS =
    | "tool"
    | "agent"
    | "flow"
    | "api"
    | "claude-code"
    | "user"
    | "processor";
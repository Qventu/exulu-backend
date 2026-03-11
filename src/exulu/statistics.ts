import type { ExuluStatistic } from "@EXULU_TYPES/statistics.ts";
import { postgresClient } from "../postgres/client";

export const updateStatistic = async (
  statistic: Omit<ExuluStatistic, "total"> & {
    count?: number;
    user?: number;
    role?: string;
    project?: string;
  },
) => {
  const currentDate = new Date().toISOString().split("T")[0];
  const { db } = await postgresClient();

  const existing = await db
    .from("tracking")
    .where({
      ...(statistic.user ? { user: statistic.user } : {}),
      ...(statistic.role ? { role: statistic.role } : {}),
      ...(statistic.project ? { project: statistic.project } : {}),
      name: statistic.name,
      label: statistic.label,
      type: statistic.type,
      createdAt: currentDate,
    })
    .first();

  // Update a specific statistic by name, label and type for a particular day.
  // If the statistic does not exist, it will be created.
  // If the statistic exists, it will be updated by incrementing the total count.
  if (!existing) {
    await db.from("tracking").insert({
      name: statistic.name,
      label: statistic.label,
      type: statistic.type,
      total: statistic.count ?? 1,
      createdAt: currentDate,
      ...(statistic.user ? { user: statistic.user } : {}),
      ...(statistic.role ? { role: statistic.role } : {}),
      ...(statistic.project ? { project: statistic.project } : {}),
    });
  } else {
    await db
      .from("tracking")
      .update({
        total: db.raw("total + ?", [statistic.count ?? 1]),
      })
      .where({
        id: existing.id,
      });
  }
};

import { z } from "zod";

export const conditionSchema = z.object({
  variableId: z.string(),
  operator: z.enum(["eq", "neq", "gt", "gte", "lt", "lte", "contains"]),
  value: z.union([
    z.number(),
    z.string(),
    z.boolean(),
    z.record(z.unknown()),
    z.array(z.unknown()),
  ]),
  valueRef: z.string().optional(),
});

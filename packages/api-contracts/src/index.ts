import { z } from "zod";

export const idSchema = z.string().min(3).max(96);
export const cursorSchema = z.string().max(512).optional();
export const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: cursorSchema,
  search: z
    .string()
    .trim()
    .max(200)
    .transform((value) => value || undefined)
    .optional(),
});

export const tablePreferenceIdSchema = z
  .string()
  .min(3)
  .max(96)
  .regex(/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/u);

const tableColumnIdSchema = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[A-Za-z0-9_.:-]+$/u);

export const tablePreferenceConfigSchema = z
  .object({
    version: z.literal(1),
    columnOrder: z.array(tableColumnIdSchema).max(64),
    columnVisibility: z
      .record(tableColumnIdSchema, z.boolean())
      .refine((value) => Object.keys(value).length <= 64),
    columnSizing: z
      .record(tableColumnIdSchema, z.number().int().min(48).max(2_000))
      .refine((value) => Object.keys(value).length <= 64),
    sorting: z
      .array(z.object({ id: tableColumnIdSchema, desc: z.boolean() }))
      .max(8),
  })
  .strict();

const overviewItemIdSchema = z
  .string()
  .min(3)
  .max(96)
  .regex(/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/u);

export const overviewPreferenceConfigSchema = z
  .object({
    version: z.literal(1),
    itemOrder: z
      .array(overviewItemIdSchema)
      .max(128)
      .refine((items) => new Set(items).size === items.length),
  })
  .strict();

export const firstAdminSchema = z.object({
  name: z.string().trim().min(2).max(120),
  email: z.email().transform((value) => value.trim().toLowerCase()),
  password: z.string().min(8).max(200),
});

export const invitationCreateSchema = z.object({
  email: z.email().transform((value) => value.trim().toLowerCase()),
  groupIds: z.array(idSchema).max(50).default([]),
  expiresInHours: z.number().int().min(1).max(168).default(48),
});

export const invitationAcceptSchema = z.object({
  token: z.string().min(32),
  name: z.string().trim().min(2).max(120),
  password: z.string().min(8).max(200),
});

export const userStatusSchema = z.enum(["active", "inactive", "pending"]);

const optionalTrimmed = (max: number) => z.string().trim().max(max).optional();

const isoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/u, "Use a date in YYYY-MM-DD format.")
  .optional()
  .or(z.literal(""));

const timeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/u);
const optionalTimeSchema = z
  .string()
  .refine((value) => value === "" || /^([01]\d|2[0-3]):[0-5]\d$/u.test(value))
  .default("");

export const weekScheduleSchema = z.object({
  dailyHours: z.array(timeSchema).length(7),
  entryTimes: z.array(optionalTimeSchema).length(7),
});

const userProfileSchema = {
  phone: optionalTrimmed(40),
  telegramId: optionalTrimmed(64),
  jobTitle: optionalTrimmed(120),
  birthDate: isoDateSchema,
  cpf: z
    .string()
    .trim()
    .refine((value) => value === "" || /^\d{11}$/u.test(value), {
      message: "CPF must contain exactly 11 digits.",
    })
    .optional(),
  tags: z.array(z.string().trim().min(1).max(60)).max(50).optional(),
  sectors: z.array(z.string().trim().min(1).max(60)).max(50).optional(),
  notes: optionalTrimmed(5000),
  status: userStatusSchema.optional(),
  schedule: weekScheduleSchema.optional(),
};

export const userCreateSchema = z.object({
  name: z.string().trim().min(2).max(120),
  email: z.email().transform((value) => value.trim().toLowerCase()),
  password: z.string().min(8).max(200),
  active: z.boolean().default(true),
  groupIds: z.array(idSchema).max(50).default([]),
  ...userProfileSchema,
});

const optionalPasswordSchema = z
  .string()
  .max(200)
  .refine((value) => value.length === 0 || value.length >= 8, {
    message: "Password must contain at least 8 characters.",
  })
  .optional()
  .transform((value) => value || undefined);

export const userUpdateSchema = z
  .object({
    name: z.string().trim().min(2).max(120).optional(),
    email: z
      .email()
      .transform((value) => value.trim().toLowerCase())
      .optional(),
    password: optionalPasswordSchema,
    active: z.boolean().optional(),
    groupIds: z.array(idSchema).max(50).optional(),
    phone: optionalTrimmed(40),
    telegramId: optionalTrimmed(64),
    jobTitle: optionalTrimmed(120),
    birthDate: isoDateSchema,
    cpf: userProfileSchema.cpf,
    tags: z.array(z.string().trim().min(1).max(60)).max(50).optional(),
    sectors: z.array(z.string().trim().min(1).max(60)).max(50).optional(),
    notes: optionalTrimmed(5000),
    status: userStatusSchema.optional(),
    schedule: weekScheduleSchema.optional(),
  })
  .refine(
    (input) =>
      input.name !== undefined ||
      input.email !== undefined ||
      input.password !== undefined ||
      input.active !== undefined ||
      input.groupIds !== undefined ||
      input.phone !== undefined ||
      input.telegramId !== undefined ||
      input.jobTitle !== undefined ||
      input.birthDate !== undefined ||
      input.cpf !== undefined ||
      input.tags !== undefined ||
      input.sectors !== undefined ||
      input.notes !== undefined ||
      input.status !== undefined ||
      input.schedule !== undefined,
    { message: "Provide at least one field to update." },
  );

export const groupCreateSchema = z.object({
  name: z.string().trim().min(2).max(80),
  permissionKeys: z
    .array(
      z.string().regex(/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/u),
    )
    .max(200),
});

export const leadCreateSchema = z.object({
  name: z.string().trim().min(2).max(160),
  email: z.email().optional(),
  phone: z.string().trim().max(40).optional(),
  company: z.string().trim().max(160).optional(),
  status: z.enum(["new", "qualified", "won", "lost"]).default("new"),
  notes: z.string().trim().max(5000).optional(),
});

export const leadUpdateSchema = leadCreateSchema.partial().extend({
  version: z.number().int().positive(),
});

export const webhookEndpointCreateSchema = z.object({
  name: z.string().trim().min(2).max(120),
  url: z.url(),
  eventTypes: z.array(z.string()).min(1).max(100),
});

export const reauthSchema = z.object({ password: z.string().min(1).max(200) });

export const apiKeyCreateSchema = z.object({
  name: z.string().trim().min(2).max(100),
  scopes: z.array(z.string()).min(1).max(200),
  expiresInDays: z.number().int().min(1).max(365).default(90),
});

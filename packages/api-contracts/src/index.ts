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

export const userCreateSchema = z.object({
  name: z.string().trim().min(2).max(120),
  email: z.email().transform((value) => value.trim().toLowerCase()),
  password: z.string().min(8).max(200),
  active: z.boolean().default(true),
  groupIds: z.array(idSchema).max(50).default([]),
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
  })
  .refine(
    (input) =>
      input.name !== undefined ||
      input.email !== undefined ||
      input.password !== undefined ||
      input.active !== undefined ||
      input.groupIds !== undefined,
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

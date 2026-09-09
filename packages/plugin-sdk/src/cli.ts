#!/usr/bin/env node
import { resolve } from "node:path";
import { buildPluginPackage } from "./package.js";

const root = resolve(process.argv[2] ?? ".");
const privateKey = process.env.PLUGIN_SIGNING_PRIVATE_KEY?.trim();
if (!privateKey) throw new Error("PLUGIN_SIGNING_PRIVATE_KEY is required.");
const output = await buildPluginPackage({
  root,
  privateKey,
  keyId: process.env.PLUGIN_SIGNING_KEY_ID?.trim() || "publisher-v1",
});
process.stdout.write(`${output}\n`);

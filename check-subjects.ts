import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { loadEnvConfig } = require("@next/env");

// Load the project's environment variables.
loadEnvConfig(process.cwd());

// Use the unpooled connection if DATABASE_URL is not set.
if (!process.env.DATABASE_URL && process.env.DATABASE_URL_UNPOOLED) {
  process.env.DATABASE_URL = process.env.DATABASE_URL_UNPOOLED;
}

// Import database modules only after loading environment variables.
const { db } = await import("./src/db");
const { subjects } = await import("./src/db/schema");

const rows = await db.select().from(subjects);

console.log("Total subjects:", rows.length);
console.table(rows);

process.exit(0);

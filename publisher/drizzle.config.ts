import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/repositories/sqlite/schema.ts",
  out: "./data/drizzle",
  dialect: "sqlite",
  dbCredentials: {
    url: "./data/radio.db",
  },
});

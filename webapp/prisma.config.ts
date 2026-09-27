import "dotenv/config";
import { defineConfig } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations" },
  // Client generation and image builds do not require a live database.
  datasource: { url: process.env.DATABASE_URL ?? "" },
});

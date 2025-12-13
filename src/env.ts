import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

export const env = createEnv({
  server: {
    HYTALE_EMAIL: z.string().email("HYTALE_EMAIL must be a valid email address"),
    HYTALE_PASSWORD: z.string().min(1, "HYTALE_PASSWORD must not be empty"),
    CORS_ORIGINS: z
      .string()
      .min(1, "CORS_ORIGINS must contain at least one origin")
      .transform((val) => val.split(',').map(origin => origin.trim()).filter(origin => origin.length > 0))
      .pipe(
        z.array(z.string().url("Each CORS origin must be a valid URL"))
          .min(1, "CORS_ORIGINS must contain at least one valid origin")
      ),
    REDIS_URL: z.string().url("REDIS_URL must be a valid URL").default("redis://localhost:6379"),
  },
  runtimeEnv: process.env,
  emptyStringAsUndefined: true,
});

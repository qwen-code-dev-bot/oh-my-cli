import { z } from "zod";

const ConfigSchema = z.object({
  apiKey: z.string().min(1, "OPENAI_API_KEY is required"),
  baseUrl: z.string().url("OPENAI_BASE_URL must be a valid URL"),
  model: z.string().min(1, "OPENAI_MODEL is required"),
});

export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const raw = {
    apiKey: env.OPENAI_API_KEY ?? "",
    baseUrl: env.OPENAI_BASE_URL ?? "https://api.openai.com/v1",
    model: env.OPENAI_MODEL ?? "",
  };

  const result = ConfigSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues.map((i) => i.message).join("; ");
    throw new Error(`Configuration error: ${issues}`);
  }
  return result.data;
}

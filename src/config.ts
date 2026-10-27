import { readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

export const DEFAULT_CONFIG_PATH = "config.json";

const httpUrl = z.url({ protocol: /^https?$/, error: "must be an http(s) URL" });
const labels = z.array(z.string().trim().min(1)).min(1);

export const ClassifierConfigSchema = z
    .object({
        // Base URL of the model server (the Immich machine-learning container)
        mlUrl: httpUrl.default("http://127.0.0.1:3003").transform((url) => url.replace(/\/+$/, "")),
        apiFormat: z.enum(["immich"]).default("immich"),
        // Bearer token, for a model server behind an authenticating reverse proxy
        apiKey: z.string().min(1).optional(),
        model: z.string().min(1).default("ViT-B-16-SigLIP2__webli"),
        // Descriptions an image must match, and the look-alikes to reject
        allowed: labels,
        disallowed: labels,
        // Minimum combined probability of the allowed labels for a post to be approved
        threshold: z.number().gt(0).lte(1).default(0.5),
        // Hostnames images may be linked from; empty allows any host
        allowedHosts: z
            .array(z.string().trim().min(1))
            .default([])
            .transform((hosts) => hosts.map((host) => host.toLowerCase())),
        // HTTP proxy for image downloads; unset downloads directly and the image host sees this machine's IP
        proxyUrl: httpUrl.optional()
    })
    .strict()
    .superRefine((config, ctx) => {
        const overlap = config.allowed.filter((label) => config.disallowed.includes(label));
        if (overlap.length > 0)
            ctx.addIssue({ code: "custom", message: `labels cannot be both allowed and disallowed: ${overlap.join(", ")}` });
    });

export const ConfigSchema = z
    .object({
        // pkc RPC of the bitsocial daemon that runs the community
        rpcUrl: z.string().min(1).default("ws://localhost:9138"),
        communityAddress: z.string().min(1),
        // Holds the bot's signing key (bot-signer.json)
        dataDir: z.string().min(1).default("data"),
        classifier: ClassifierConfigSchema,
        // Posts that could not be classified (model server down) are retried after base, 2x base, 4x base, ... capped at max
        retryBaseSeconds: z.number().positive().default(30),
        retryMaxSeconds: z.number().positive().default(1800),
        // The mod queue is also rescanned on this interval, so due retries run without a community update
        rescanIntervalSeconds: z.number().positive().default(60)
    })
    .strict();

export type ClassifierConfig = z.infer<typeof ClassifierConfigSchema>;
export type Config = z.infer<typeof ConfigSchema>;

export function parseConfig(raw: unknown, baseDir = process.cwd()): Config {
    const result = ConfigSchema.safeParse(raw);
    if (!result.success) {
        throw new Error(
            `Invalid config:\n${result.error.issues.map((issue) => `  ${issue.path.join(".") || "(root)"}: ${issue.message}`).join("\n")}`
        );
    }
    return { ...result.data, dataDir: path.resolve(baseDir, result.data.dataDir) };
}

export function loadConfig(file = process.env.CONFIG || DEFAULT_CONFIG_PATH): Config {
    const absolute = path.resolve(file);
    let raw: unknown;
    try {
        raw = JSON.parse(readFileSync(absolute, "utf8"));
    } catch (error) {
        throw new Error(`Could not read config ${absolute}. Copy config.example.json to config.json and fill it in.`, { cause: error });
    }
    return parseConfig(raw, path.dirname(absolute));
}

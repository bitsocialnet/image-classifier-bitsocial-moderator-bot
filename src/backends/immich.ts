import type { BackendConfig, EmbeddingBackend } from "./types.js";

// Immich machine-learning container (ghcr.io/immich-app/immich-machine-learning). Its POST /predict takes a
// multipart form with an `entries` JSON naming the task and model, plus either an `image` file or a `text`
// field, and answers {"clip": "<JSON array as a string>"}.
export function createImmichBackend({ mlUrl, apiKey, model }: BackendConfig): EmbeddingBackend {
    const predict = async (kind: "visual" | "textual", input: { image: Blob } | { text: string }, signal: AbortSignal) => {
        const form = new FormData();
        form.append("entries", JSON.stringify({ clip: { [kind]: { modelName: model, options: {} } } }));
        if ("image" in input) form.append("image", input.image, "image");
        else form.append("text", input.text);

        const response = await fetch(`${mlUrl}/predict`, {
            method: "POST",
            body: form,
            signal,
            headers: apiKey ? { authorization: `Bearer ${apiKey}` } : undefined
        });
        if (!response.ok) {
            throw new Error(`Immich ML returned HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
        }
        const body = (await response.json()) as { clip?: unknown };
        const embedding: unknown = typeof body.clip === "string" ? JSON.parse(body.clip) : body.clip;
        if (!Array.isArray(embedding) || embedding.length === 0 || !embedding.every((value) => typeof value === "number")) {
            throw new Error("Immich ML response did not contain a clip embedding");
        }
        return embedding as number[];
    };

    return {
        embedImage: (image, mimeType, signal) => predict("visual", { image: new Blob([image], { type: mimeType }) }, signal),
        embedText: (text, signal) => predict("textual", { text }, signal)
    };
}

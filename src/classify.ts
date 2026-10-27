import { createImmichBackend } from "./backends/immich.js";
import type { EmbeddingBackend } from "./backends/types.js";
import type { ClassifierConfig } from "./config.js";
import { ImageRejection, fetchImage } from "./fetch-image.js";
import { scoreLabels } from "./score.js";

export const ML_TIMEOUT_MS = 60_000;

export type Decision =
    | { kind: "approve"; allowedShare: number }
    | { kind: "reject"; reason: string; allowedShare?: number }
    // Something on our side failed (model server down, network trouble); the post stays queued and is retried
    | { kind: "retry"; error: string };

export type ClassifierDeps = {
    fetchImage: typeof fetchImage;
    backend: EmbeddingBackend;
};

export class ImageClassifier {
    private readonly labelEmbeddings = new Map<string, Promise<number[]>>();
    private readonly deps: ClassifierDeps;

    constructor(
        private readonly config: ClassifierConfig,
        deps: Partial<ClassifierDeps> = {}
    ) {
        this.deps = { fetchImage, backend: createImmichBackend(config), ...deps };
    }

    // Label embeddings never change for a given model, so each is computed once; a failed request is
    // dropped so the next post retries it.
    private embedLabel(label: string) {
        let embedding = this.labelEmbeddings.get(label);
        if (!embedding) {
            embedding = this.deps.backend.embedText(label, AbortSignal.timeout(ML_TIMEOUT_MS));
            embedding.catch(() => this.labelEmbeddings.delete(label));
            this.labelEmbeddings.set(label, embedding);
        }
        return embedding;
    }

    async classify(link: string | undefined): Promise<Decision> {
        const { config } = this;
        if (!link) return { kind: "reject", reason: "Posts must link directly to an image." };

        let image;
        try {
            image = await this.deps.fetchImage(link, { proxyUrl: config.proxyUrl, allowedHosts: config.allowedHosts });
        } catch (error) {
            if (error instanceof ImageRejection) return { kind: "reject", reason: error.message };
            return { kind: "retry", error: `downloading ${link} failed: ${String(error)}` };
        }

        const labels = [...config.allowed, ...config.disallowed];
        let scores;
        try {
            const [imageEmbedding, labelEmbeddings] = await Promise.all([
                this.deps.backend.embedImage(image.bytes, image.mimeType, AbortSignal.timeout(ML_TIMEOUT_MS)),
                Promise.all(labels.map((label) => this.embedLabel(label)))
            ]);
            scores = scoreLabels(imageEmbedding, labelEmbeddings, config.allowed.length);
        } catch (error) {
            return { kind: "retry", error: `model server request failed: ${String(error)}` };
        }

        const { allowedShare, topIndex } = scores;
        if (allowedShare >= config.threshold) return { kind: "approve", allowedShare };
        const accepted = config.allowed.map((label) => `"${label}"`).join(", ");
        const reason =
            topIndex >= config.allowed.length
                ? `Image rejected: it looks like "${labels[topIndex]}". This community only accepts: ${accepted}.`
                : `Image rejected: not confident enough that it matches: ${accepted}.`;
        return { kind: "reject", reason, allowedShare };
    }
}

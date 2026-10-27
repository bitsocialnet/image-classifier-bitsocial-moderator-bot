import { beforeEach, describe, expect, it, vi } from "vitest";
import { ImageClassifier } from "../src/classify.js";
import { ClassifierConfigSchema } from "../src/config.js";
import { ImageRejection } from "../src/fetch-image.js";

// Two-dimensional "embeddings": cat labels point along x, everything else along y.
const LABEL_VECTORS: Record<string, number[]> = {
    "a photo of a cat": [1, 0],
    "a photo of a dog": [0, 1],
    "a drawing of a cat": [0.6, 0.8]
};

const config = ClassifierConfigSchema.parse({
    allowed: ["a photo of a cat"],
    disallowed: ["a photo of a dog", "a drawing of a cat"],
    threshold: 0.5,
    allowedHosts: ["I.imgur.com"]
});

const fetchImage = vi.fn();
const embedImage = vi.fn();
const embedText = vi.fn();
const classifier = () => new ImageClassifier(config, { fetchImage, backend: { embedImage, embedText } });

beforeEach(() => {
    vi.resetAllMocks();
    fetchImage.mockResolvedValue({ bytes: new Uint8Array([1]), mimeType: "image/png" });
    embedText.mockImplementation(async (label: string) => LABEL_VECTORS[label]);
});

describe("ImageClassifier", () => {
    it("approves an image matching the allowed labels", async () => {
        embedImage.mockResolvedValue([1, 0.05]);
        await expect(classifier().classify("https://i.imgur.com/cat.png")).resolves.toMatchObject({ kind: "approve" });
        expect(fetchImage).toHaveBeenCalledWith("https://i.imgur.com/cat.png", { proxyUrl: undefined, allowedHosts: ["i.imgur.com"] });
    });

    it("rejects with the most likely disallowed label", async () => {
        embedImage.mockResolvedValue([0.05, 1]);
        await expect(classifier().classify("https://i.imgur.com/dog.png")).resolves.toMatchObject({
            kind: "reject",
            reason: 'Image rejected: it looks like "a photo of a dog". This community only accepts: "a photo of a cat".'
        });
    });

    it("rejects when an allowed label wins but its share is under the threshold", async () => {
        embedImage.mockResolvedValue([1, 0.05]);
        const strict = new ImageClassifier({ ...config, threshold: 1 }, { fetchImage, backend: { embedImage, embedText } });
        await expect(strict.classify("https://i.imgur.com/cat.png")).resolves.toMatchObject({
            kind: "reject",
            reason: 'Image rejected: not confident enough that it matches: "a photo of a cat".'
        });
    });

    it("rejects posts without a link", async () => {
        await expect(classifier().classify(undefined)).resolves.toEqual({
            kind: "reject",
            reason: "Posts must link directly to an image."
        });
    });

    it("rejects with the reason when the link itself is the problem", async () => {
        fetchImage.mockRejectedValue(new ImageRejection("The image is larger than 10 MB."));
        await expect(classifier().classify("https://i.imgur.com/big.png")).resolves.toEqual({
            kind: "reject",
            reason: "The image is larger than 10 MB."
        });
    });

    it("asks for a retry when the model server fails", async () => {
        embedImage.mockRejectedValue(new Error("connect ECONNREFUSED"));
        await expect(classifier().classify("https://i.imgur.com/cat.png")).resolves.toMatchObject({ kind: "retry" });
    });

    it("asks for a retry on an unexpected download error", async () => {
        fetchImage.mockRejectedValue(new TypeError("boom"));
        await expect(classifier().classify("https://i.imgur.com/cat.png")).resolves.toMatchObject({ kind: "retry" });
    });

    it("embeds each label once and retries a label that failed", async () => {
        embedImage.mockResolvedValue([1, 0]);
        const instance = classifier();
        await instance.classify("https://i.imgur.com/1.png");
        await instance.classify("https://i.imgur.com/2.png");
        expect(embedText).toHaveBeenCalledTimes(3);

        const failing = classifier();
        embedText.mockRejectedValueOnce(new Error("loading model"));
        await expect(failing.classify("https://i.imgur.com/3.png")).resolves.toMatchObject({ kind: "retry" });
        await expect(failing.classify("https://i.imgur.com/3.png")).resolves.toMatchObject({ kind: "approve" });
    });
});

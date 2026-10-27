// Cosine similarities are multiplied by this before the softmax, as CLIP does. Calibrated in the cats trial
// (scripts/evaluate.js) together with the default threshold, so changing it shifts every community's threshold.
export const LOGIT_SCALE = 100;

export type LabelScores = {
    /** Combined probability of all allowed labels, 0..1. */
    allowedShare: number;
    /** Index into [...allowed, ...disallowed] of the most likely label. */
    topIndex: number;
    probabilities: number[];
};

const normalize = (vector: number[]) => {
    const length = Math.hypot(...vector);
    return vector.map((value) => value / length);
};

const dot = (a: number[], b: number[]) => a.reduce((sum, value, index) => sum + value * b[index], 0);

/** Softmax over every label; labelEmbeddings holds the allowed labels first, then the disallowed ones. */
export function scoreLabels(imageEmbedding: number[], labelEmbeddings: number[][], allowedCount: number): LabelScores {
    const image = normalize(imageEmbedding);
    const logits = labelEmbeddings.map((label) => {
        if (label.length !== image.length) throw new Error("Image and label embeddings have different dimensions");
        return dot(image, normalize(label)) * LOGIT_SCALE;
    });
    const max = Math.max(...logits);
    const exps = logits.map((logit) => Math.exp(logit - max));
    const total = exps.reduce((sum, value) => sum + value, 0);
    const probabilities = exps.map((value) => value / total);
    return {
        allowedShare: probabilities.slice(0, allowedCount).reduce((sum, value) => sum + value, 0),
        topIndex: probabilities.indexOf(Math.max(...probabilities)),
        probabilities
    };
}

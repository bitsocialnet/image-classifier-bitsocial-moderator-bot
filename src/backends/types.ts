/** A model server that embeds images and text into the same vector space (CLIP/SigLIP). */
export interface EmbeddingBackend {
    embedImage(image: Uint8Array<ArrayBuffer>, mimeType: string, signal: AbortSignal): Promise<number[]>;
    embedText(text: string, signal: AbortSignal): Promise<number[]>;
}

export type BackendConfig = {
    mlUrl: string;
    apiKey?: string;
    model: string;
};

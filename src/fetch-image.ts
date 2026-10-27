import { lookup, type LookupAddress } from "node:dns";
import { lookup as lookupAsync } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { Agent, ProxyAgent, fetch, type Dispatcher } from "undici";

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const FETCH_TIMEOUT_MS = 10_000;
export const MAX_REDIRECTS = 3;
// Some image hosts refuse requests without a browser-like User-Agent; a generic one also avoids announcing the
// request comes from a community node.
const USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0";

/** A failure caused by the submitted link itself; its message is safe to show to the author. */
export class ImageRejection extends Error {}

export type FetchImageOptions = {
    proxyUrl?: string;
    allowedHosts?: string[];
    signal?: AbortSignal;
    /** Test-only escape hatch: lets tests fetch from a local server. */
    allowPrivateAddresses?: boolean;
};

export type FetchedImage = { bytes: Uint8Array<ArrayBuffer>; mimeType: string };

// Destinations a link must never make the community node (or its proxy) request: loopback, LAN, link-local,
// CGNAT, multicast and reserved ranges. Without this, a post could point the daemon at its own RPC port.
const privateRanges = new BlockList();
for (const [network, prefix] of [
    ["0.0.0.0", 8],
    ["10.0.0.0", 8],
    ["100.64.0.0", 10],
    ["127.0.0.0", 8],
    ["169.254.0.0", 16],
    ["172.16.0.0", 12],
    ["192.0.0.0", 24],
    ["192.168.0.0", 16],
    ["198.18.0.0", 15],
    ["224.0.0.0", 4],
    ["240.0.0.0", 4]
] as const) {
    privateRanges.addSubnet(network, prefix, "ipv4");
}
for (const [network, prefix] of [
    ["::", 128],
    ["::1", 128],
    ["fc00::", 7],
    ["fe80::", 10],
    ["ff00::", 8]
] as const) {
    privateRanges.addSubnet(network, prefix, "ipv6");
}

export const isPrivateAddress = (address: string): boolean => {
    const mappedV4 = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)?.[1];
    if (mappedV4) return privateRanges.check(mappedV4, "ipv4");
    const family = isIP(address);
    if (family === 4) return privateRanges.check(address, "ipv4");
    if (family === 6) return privateRanges.check(address, "ipv6");
    return true;
};

const privateHostError = () => new ImageRejection("The image link points to a private or local network address.");

// Checked again at connect time so a hostname can't pass the pre-check and then rebind to a private address.
const guardedLookup: typeof lookup = ((hostname: string, options: any, callback: any) => {
    lookup(hostname, { ...options, all: true }, (error, result) => {
        if (error) return callback(error);
        const addresses = result as unknown as LookupAddress[];
        if (addresses.some((entry) => isPrivateAddress(entry.address))) return callback(privateHostError());
        if (options?.all) return callback(null, addresses);
        callback(null, addresses[0].address, addresses[0].family);
    });
}) as typeof lookup;

const directDispatcher = new Agent({ connect: { lookup: guardedLookup } });
const proxyDispatchers = new Map<string, ProxyAgent>();

const getDispatcher = (proxyUrl: string | undefined, allowPrivateAddresses: boolean): Dispatcher | undefined => {
    if (proxyUrl) {
        let dispatcher = proxyDispatchers.get(proxyUrl);
        if (!dispatcher) {
            dispatcher = new ProxyAgent(proxyUrl);
            proxyDispatchers.set(proxyUrl, dispatcher);
        }
        return dispatcher;
    }
    return allowPrivateAddresses ? undefined : directDispatcher;
};

const hostAllowed = (hostname: string, allowedHosts: string[]) =>
    allowedHosts.length === 0 || allowedHosts.includes(hostname.toLowerCase());

const assertPublicHost = async (hostname: string) => {
    const bareHost = hostname.replace(/^\[|\]$/g, "");
    if (isIP(bareHost)) {
        if (isPrivateAddress(bareHost)) throw privateHostError();
        return;
    }
    let addresses: { address: string }[];
    try {
        addresses = await lookupAsync(bareHost, { all: true });
    } catch {
        throw new ImageRejection(`Could not resolve the image host "${bareHost}".`);
    }
    if (addresses.length === 0 || addresses.some((entry) => isPrivateAddress(entry.address))) throw privateHostError();
};

export const sniffImageMimeType = (bytes: Uint8Array): string | undefined => {
    const startsWith = (signature: number[], offset = 0) => signature.every((byte, index) => bytes[offset + index] === byte);
    if (startsWith([0xff, 0xd8, 0xff])) return "image/jpeg";
    if (startsWith([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
    if (startsWith([0x47, 0x49, 0x46, 0x38])) return "image/gif";
    if (startsWith([0x52, 0x49, 0x46, 0x46]) && startsWith([0x57, 0x45, 0x42, 0x50], 8)) return "image/webp";
    return undefined;
};

const readCapped = async (body: AsyncIterable<Uint8Array>, maxBytes: number) => {
    const chunks: Uint8Array[] = [];
    let total = 0;
    for await (const chunk of body) {
        total += chunk.byteLength;
        if (total > maxBytes) throw new ImageRejection(`The image is larger than ${maxBytes / 1024 / 1024} MB.`);
        chunks.push(chunk);
    }
    return Buffer.concat(chunks, total);
};

/** Downloads a post's linked image, following at most MAX_REDIRECTS redirects and checking every hop. */
export async function fetchImage(link: string, options: FetchImageOptions = {}): Promise<FetchedImage> {
    const { proxyUrl, allowedHosts = [], allowPrivateAddresses = false } = options;
    const signal = AbortSignal.any([AbortSignal.timeout(FETCH_TIMEOUT_MS), ...(options.signal ? [options.signal] : [])]);
    const dispatcher = getDispatcher(proxyUrl, allowPrivateAddresses);

    let url: URL;
    try {
        url = new URL(link);
    } catch {
        throw new ImageRejection("The post link is not a valid URL.");
    }

    for (let redirects = 0; ; redirects++) {
        if (url.protocol !== "http:" && url.protocol !== "https:") throw new ImageRejection("The image link must be an http(s) URL.");
        if (!hostAllowed(url.hostname, allowedHosts)) {
            throw new ImageRejection(`Images must be hosted on one of: ${allowedHosts.join(", ")}.`);
        }
        if (!allowPrivateAddresses) await assertPublicHost(url.hostname);

        let response: Awaited<ReturnType<typeof fetch>>;
        try {
            response = await fetch(url, {
                dispatcher,
                redirect: "manual",
                signal,
                headers: { accept: "image/*", "user-agent": USER_AGENT }
            });
        } catch (error) {
            if (error instanceof ImageRejection) throw error;
            if ((error as Error)?.cause instanceof ImageRejection) throw (error as Error).cause;
            if (signal.aborted) throw new ImageRejection("Timed out downloading the image.");
            throw new ImageRejection("Could not download the image.");
        }

        if (response.status >= 300 && response.status < 400) {
            const location = response.headers.get("location");
            await response.body?.cancel();
            if (!location) throw new ImageRejection("The image link redirected without a destination.");
            if (redirects >= MAX_REDIRECTS) throw new ImageRejection("The image link redirected too many times.");
            url = new URL(location, url);
            continue;
        }
        if (!response.ok || !response.body) {
            await response.body?.cancel();
            throw new ImageRejection(`Could not download the image (HTTP ${response.status}).`);
        }

        const declaredLength = Number(response.headers.get("content-length"));
        if (declaredLength > MAX_IMAGE_BYTES) {
            await response.body.cancel();
            throw new ImageRejection(`The image is larger than ${MAX_IMAGE_BYTES / 1024 / 1024} MB.`);
        }

        let bytes: Uint8Array<ArrayBuffer>;
        try {
            bytes = await readCapped(response.body as AsyncIterable<Uint8Array>, MAX_IMAGE_BYTES);
        } catch (error) {
            if (error instanceof ImageRejection) throw error;
            if (signal.aborted) throw new ImageRejection("Timed out downloading the image.");
            throw new ImageRejection("Could not download the image.");
        }
        const mimeType = sniffImageMimeType(bytes);
        if (!mimeType) throw new ImageRejection("The link must point directly to a JPEG, PNG, WebP or GIF image.");
        return { bytes, mimeType };
    }
}

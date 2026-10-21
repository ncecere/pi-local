import { createPhotonImages } from "@earendil-works/pi-durable/images";
import type { ImageProcessor } from "@earendil-works/pi-durable/tools";
import photonWasm from "./photon-wasm.ts";

let photon: Promise<ImageProcessor> | undefined;

/**
 * Prepares images for the model (read, attached images): turned upright, scaled to the model's limits and re-encoded
 * until they fit, so a large screenshot is sent smaller rather than refused. Photon loads on the first image.
 */
export const imageProcessor: ImageProcessor = {
	async prepare(bytes, mimeType, limits) {
		photon ??= photonWasm().then((wasm) => createPhotonImages(wasm));
		return (await photon).prepare(bytes, mimeType, limits);
	},
};

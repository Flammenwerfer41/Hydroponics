import encode, { init } from "@jsquash/webp/encode";
import standardWasm from "@jsquash/webp/codec/enc/webp_enc.wasm";
import simdWasm from "@jsquash/webp/codec/enc/webp_enc_simd.wasm";

let initialized;

function initialize() {
  if (!initialized) {
    initialized = init({
      locateFile(path) {
        return path.includes("simd") ? simdWasm : standardWasm;
      }
    });
  }
  return initialized;
}

self.addEventListener("message", async (event) => {
  const { id, width, height, pixels, quality } = event.data || {};
  try {
    await initialize();
    const image = new ImageData(new Uint8ClampedArray(pixels), width, height);
    const buffer = await encode(image, {
      quality,
      method: 4,
      pass: 1,
      use_sharp_yuv: 1,
      thread_level: 0
    });
    self.postMessage({ id, buffer }, [buffer]);
  } catch (error) {
    self.postMessage({ id, error: error?.message || "WebP encoding failed" });
  }
});

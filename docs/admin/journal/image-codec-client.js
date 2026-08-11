let encoderWorker;
let requestSequence = 0;
const pending = new Map();

function worker() {
  if (encoderWorker) return encoderWorker;
  encoderWorker = new Worker("./image-codec/webp-worker.js", { type: "module" });
  encoderWorker.addEventListener("message", (event) => {
    const request = pending.get(event.data.id);
    if (!request) return;
    pending.delete(event.data.id);
    if (event.data.error) request.reject(new Error(event.data.error));
    else request.resolve(new Blob([event.data.buffer], { type: "image/webp" }));
  });
  encoderWorker.addEventListener("error", (event) => {
    const failure = new Error(event.message || "WebP 변환기를 실행할 수 없습니다.");
    for (const request of pending.values()) request.reject(failure);
    pending.clear();
    encoderWorker?.terminate();
    encoderWorker = null;
  });
  return encoderWorker;
}

export function encodeWebp(imageData, quality) {
  const id = ++requestSequence;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    worker().postMessage({
      id,
      pixels: imageData.data.buffer,
      width: imageData.width,
      height: imageData.height,
      quality
    }, [imageData.data.buffer]);
  });
}

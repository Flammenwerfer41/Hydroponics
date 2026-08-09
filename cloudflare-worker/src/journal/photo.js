import { JournalRequestError } from "./contract.js";

export const PHOTO_LIMITS = Object.freeze({
  fullBytes: 2_000_000,
  thumbnailBytes: 300_000,
  maximumDimension: 2400
});

const MIME_TYPES = new Set(["image/jpeg", "image/webp"]);

function integer(value, name, minimum, maximum) {
  if (!/^\d+$/.test(String(value ?? ""))) {
    throw new JournalRequestError("invalid_photo", `${name} must be an integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new JournalRequestError(
      "invalid_photo",
      `${name} must be between ${minimum} and ${maximum}`
    );
  }
  return parsed;
}

function image(value, name, maximumBytes) {
  if (!value || typeof value.arrayBuffer !== "function" || typeof value.size !== "number") {
    throw new JournalRequestError("invalid_photo", `${name} is required`);
  }
  if (!MIME_TYPES.has(value.type)) {
    throw new JournalRequestError("invalid_photo", `${name} must be JPEG or WebP`);
  }
  if (value.size < 1 || value.size > maximumBytes) {
    throw new JournalRequestError(
      "photo_too_large",
      `${name} exceeds the ${maximumBytes} byte limit`,
      413
    );
  }
  return value;
}

export function parsePhotoUpload(formData) {
  if (!formData || typeof formData.get !== "function") {
    throw new JournalRequestError("invalid_photo", "Photo upload must use multipart/form-data");
  }
  const photo = image(formData.get("photo"), "photo", PHOTO_LIMITS.fullBytes);
  const thumbnail = image(
    formData.get("thumbnail"),
    "thumbnail",
    PHOTO_LIMITS.thumbnailBytes
  );
  if (photo.type !== thumbnail.type) {
    throw new JournalRequestError("invalid_photo", "Photo and thumbnail types must match");
  }
  return {
    photo,
    thumbnail,
    revision: integer(formData.get("revision"), "revision", 1, Number.MAX_SAFE_INTEGER),
    width: integer(formData.get("width"), "width", 1, PHOTO_LIMITS.maximumDimension),
    height: integer(formData.get("height"), "height", 1, PHOTO_LIMITS.maximumDimension),
    mimeType: photo.type
  };
}

export function photoExtension(mimeType) {
  return mimeType === "image/webp" ? "webp" : "jpg";
}

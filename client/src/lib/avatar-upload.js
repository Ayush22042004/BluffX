import { API_URL } from "./endpoints";
export const avatarUrl = (id) =>
  id ? `${API_URL}/auth/avatar/${encodeURIComponent(id)}` : null;
export async function prepareAvatar(file) {
  if (!file || !["image/png", "image/jpeg", "image/webp"].includes(file.type))
    throw Error("Choose a PNG, JPEG or WebP photo.");
  if (file.size > 5 * 1024 * 1024) throw Error("Choose a photo under 5 MB.");
  const url = URL.createObjectURL(file);
  try {
    const image = await new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(Error("This photo could not be opened."));
      img.src = url;
    });
    if (image.naturalWidth * image.naturalHeight > 25000000)
      throw Error("Choose a photo smaller than 25 megapixels.");
    const canvas = document.createElement("canvas");
    canvas.width = 128;
    canvas.height = 128;
    const size = Math.min(image.naturalWidth, image.naturalHeight);
    canvas
      .getContext("2d")
      .drawImage(
        image,
        (image.naturalWidth - size) / 2,
        (image.naturalHeight - size) / 2,
        size,
        size,
        0,
        0,
        128,
        128,
      );
    return canvas.toDataURL("image/webp", 0.82);
  } finally {
    URL.revokeObjectURL(url);
  }
}
export async function uploadAvatar(preview) {
  const image = await (await fetch(preview)).blob();
  const response = await fetch(
    `${import.meta.env.VITE_SERVER_URL || "http://localhost:4000"}/auth/avatar`,
    {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": image.type },
      body: image,
      signal: AbortSignal.timeout(20000),
    },
  );
  const result = await response.json();
  if (!response.ok)
    throw Error(result.message || "Your avatar could not be uploaded.");
  return result.avatarId;
}

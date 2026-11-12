import { api } from "@/lib/api";

export const MAX_BYTES = 4 * 1024 * 1024;
export const ACCEPT = "image/jpeg,image/png,image/webp,application/pdf";

/** Reads a file as base64 (without the data: prefix). */
function base64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
    reader.onerror = () => reject(new Error(`Could not read ${file.name}.`));
    reader.readAsDataURL(file);
  });
}

/** Sends files one by one to a claim. Stops at the first one the server refuses, naming it. */
export async function uploadFiles(token: string, files: File[], kind: "receipt" | "product_label" | "other") {
  for (const file of files) {
    if (file.size > MAX_BYTES) throw new Error(`${file.name} is larger than 4 MB. Send a smaller photo.`);
    try {
      await api.post(`/api/public/claims/status/${token}/files`, { kind, name: file.name, data: await base64(file) });
    } catch (err) {
      throw new Error(`${file.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

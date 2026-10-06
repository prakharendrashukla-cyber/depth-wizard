import { requireSupabase } from "./client.js";

export const BUCKET = "depth-wizard";
export const MAX_FILE_BYTES = 2 * 1024 * 1024;
const paths = row => [row.image_path, row.depth_path, row.preview_path, row.cloud_path, row.ply_path].filter(Boolean);
function checked({ data, error }) { if (error) throw error; return data; }
export function sanitizeAnalysisError(error, defaultKind = "generic") {
  if (!error) return "please try again";
  const msg = (error.message || error.error_description || String(error || "")).toLowerCase();
  const status = error.status || error.statusCode;

  // Session expired: 401, JWT expired, missing token, unverified user
  if (status === 401 || msg.includes("jwt") || msg.includes("session expired") || msg.includes("not authenticated") || msg.includes("verified user") || msg.includes("unauthorized")) {
    return "session expired";
  }

  // Storage full: limit reached
  if (msg.includes("user storage limit reached") || msg.includes("storage limit") || msg.includes("storage full")) {
    return "storage full";
  }

  // Daily limit reached: 429 or quota codes
  if (status === 429 || msg.includes("daily limit") || msg.includes("daily_limit") || msg.includes("capacity reached")) {
    return "daily limit reached";
  }

  // Specific file/payload size limit checks (safe client validations)
  if (msg.includes("2 mib") || msg.includes("cloud history limit") || msg.includes("sanitized image preview is missing")) {
    return error.message;
  }

  // Upload failed: upload loop errors, storage API issues
  if (defaultKind === "upload" || msg.includes("upload") || msg.includes("storage size metadata")) {
    return "upload failed";
  }

  // Generic fallback: never expose raw SQL, check constraints, or stack traces
  return "please try again";
}
export function base64Blob(value, type) {
  const bytes = Uint8Array.from(atob(value), character => character.charCodeAt(0));
  return new Blob([bytes], { type });
}
function blobBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader(); reader.onload = () => resolve(reader.result.split(",")[1]); reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}
// Binary PLY stays below 1 MB at the model's 55,000-point cap.
export function makePly(cloud) {
  const floats = value => new Float32Array(Uint8Array.from(atob(value), c => c.charCodeAt(0)).buffer);
  const positions = floats(cloud.positions), colors = floats(cloud.colors);
  if (positions.length !== cloud.count * 3 || colors.length !== positions.length) throw new Error("Invalid point cloud");
  const body = new ArrayBuffer(cloud.count * 15), view = new DataView(body);
  for (let i = 0; i < cloud.count; i++) for (let axis = 0; axis < 3; axis++) {
    view.setFloat32(i * 15 + axis * 4, positions[i * 3 + axis], true);
    view.setUint8(i * 15 + 12 + axis, Math.round(Math.max(0, Math.min(1, colors[i * 3 + axis])) * 255));
  }
  return new Blob([`ply\nformat binary_little_endian 1.0\ncomment Relative coordinates; apply saved scale_factor separately\nelement vertex ${cloud.count}\nproperty float x\nproperty float y\nproperty float z\nproperty uchar red\nproperty uchar green\nproperty uchar blue\nend_header\n`, body], { type: "application/octet-stream" });
}
export async function listAnalyses(page = 1) {
  const client = requireSupabase();
  const { data, error, count } = await client.from("analyses")
    .select("id,filename,model_id,created_at,status,ply_path", { count: "exact" })
    .order("created_at", { ascending: false }).order("id").range((page - 1) * 10, page * 10 - 1);
  if (error) throw error;
  return { items: data, total: count };
}
export async function deleteAnalysis(id, client = requireSupabase()) {
  const row = checked(await client.from("analyses").select("*").eq("id", id).single());
  checked(await client.from("analyses").update({ status: "deleting" }).eq("id", id).select("id").single());
  // Retain the row on failure so the user can retry; never delete Storage SQL rows directly.
  checked(await client.storage.from(BUCKET).remove(paths(row)));
  checked(await client.from("analyses").delete().eq("id", id).select("id").single());
}
export async function saveAnalysis({ result, original, userId, includePly = false }, client = requireSupabase()) {
  if (!result.original_image) throw new Error("The sanitized image preview is missing; run the analysis again to save it.");
  const id = crypto.randomUUID(), prefix = `${userId}/${id}`;
  const { original_image, depth_map, point_cloud, analysis_id, ...report } = result;
  const filename = (original.name || "upload").replace(/[\u0000-\u001f\u007f]/g, "").replace(/[\\/]/g, "_").slice(0, 255) || "upload";
  const row = { id, user_id: userId, filename, model_id: result.model_id,
    image_path: `${prefix}/input.jpg`, depth_path: `${prefix}/depth.png`, preview_path: `${prefix}/preview.jpg`,
    cloud_path: `${prefix}/cloud.json`, ply_path: includePly ? `${prefix}/cloud.ply` : null,
    metrics: result.height_analysis || {}, report, scale_factor: 1, scale_preset: "relative", status: "uploading" };
  const sanitizedInput = base64Blob(original_image, "image/jpeg");
  const files = [[row.image_path, sanitizedInput], [row.depth_path, base64Blob(depth_map, "image/png")],
    [row.preview_path, base64Blob(original_image, "image/jpeg")], [row.cloud_path, new Blob([JSON.stringify(point_cloud)], { type: "application/json" })]];
  if (includePly) files.push([row.ply_path, makePly(point_cloud)]);
  if (files.some(([, blob]) => blob.size > MAX_FILE_BYTES)) throw new Error("Analysis finished, but a file exceeds the 2 MiB cloud limit. Use a smaller original image to save history.");
  if (new Blob([JSON.stringify(report)]).size > 60000 || new Blob([JSON.stringify(row.metrics)]).size > 60000) throw new Error("Report exceeds the cloud history limit.");
  let previous;
  try {
    previous = checked(await client.from("analyses").select("id").order("created_at", { ascending: true }).order("id"));
    // Rolling history: remove the oldest first. A failed new upload does not restore it.
    if (previous.length >= 20) await deleteAnalysis(previous[0].id, client);
    checked(await client.from("analyses").insert(row));
  } catch (error) {
    throw new Error(sanitizeAnalysisError(error, "save"));
  }
  try {
    for (const [path, blob] of files) checked(await client.storage.from(BUCKET).upload(path, blob, { upsert: false, contentType: blob.type, cacheControl: "60" }));
    checked(await client.from("analyses").update({ status: "ready" }).eq("id", id).select("id").single());
    return id;
  } catch (error) {
    const safeMessage = sanitizeAnalysisError(error, "upload");
    try { await deleteAnalysis(id, client); }
    catch { throw new Error(`${safeMessage}. An incomplete entry remains in My Analyses; delete it to retry cleanup.`); }
    throw new Error(safeMessage);
  }
}
export async function signedFile(path) {
  const { signedUrl } = checked(await requireSupabase().storage.from(BUCKET).createSignedUrl(path, 60));
  return signedUrl; // Treat this as a temporary bearer link; do not store or log it.
}
export async function openAnalysis(id) {
  const row = checked(await requireSupabase().from("analyses").select("*").eq("id", id).single());
  if (row.status !== "ready") throw new Error("This upload is incomplete. Delete it and save the image again.");
  const download = async path => {
    const response = await fetch(await signedFile(path));
    if (!response.ok) throw new Error("The download expired or failed. Try opening the analysis again.");
    return response.blob();
  };
  const [preview, depth, cloud] = await Promise.all([download(row.preview_path), download(row.depth_path), download(row.cloud_path)]);
  return { ...row.report, analysis_id: row.id, scale_factor: row.scale_factor, scale_preset: row.scale_preset,
    original_image: await blobBase64(preview), depth_map: await blobBase64(depth), point_cloud: JSON.parse(await cloud.text()) };
}
export async function saveScale(id, scaleFactor, preset) {
  checked(await requireSupabase().from("analyses").update({ scale_factor: scaleFactor, scale_preset: preset }).eq("id", id).select("id").single());
}
export async function loadProfile() { return checked(await requireSupabase().from("profiles").select("display_name").single()); }
export async function saveProfile(name, userId) {
  return checked(await requireSupabase().from("profiles").update({ display_name: name.trim().slice(0, 100) }).eq("id", userId).select("display_name").single());
}

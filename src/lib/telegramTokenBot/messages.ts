export function escapeTelegramHtml(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export const TELEGRAM_HELP_MESSAGE = [
  "<b>QRouter Usage</b>",
  "/start - kết nối từ liên kết QRouter",
  "/status - trạng thái kết nối",
  "/usage - mức sử dụng",
  "/alerts - cảnh báo",
  "/mute - tắt cảnh báo 24 giờ",
  "/unmute - bật lại cảnh báo",
  "/disconnect - ngắt kết nối",
  "/help - trợ giúp",
].join("\n");

export const TELEGRAM_INVALID_CLAIM_MESSAGE =
  "Không thể kết nối. Hãy tạo liên kết mới trên QRouter.";

export const TELEGRAM_NOT_CONNECTED_MESSAGE = "Chưa kết nối. Hãy tạo liên kết mới trên QRouter.";

export function formatTelegramNumber(value: number | null | undefined): string {
  return Number.isFinite(value) ? new Intl.NumberFormat("en-US").format(value ?? 0) : "-";
}

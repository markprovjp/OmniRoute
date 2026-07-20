export function escapeTelegramHtml(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export const TELEGRAM_WELCOME_MESSAGE = [
  "<b>QRouter Usage</b>",
  "Gửi API key QRouter vào cuộc trò chuyện riêng này.",
  "Bot sẽ xóa tin nhắn chứa key, kiểm tra dữ liệu production và hiển thị tổng quan.",
  "Sau khi kết nối, dùng /check để xem lại Usage bất cứ lúc nào.",
].join("\n");

export const TELEGRAM_INVALID_CLAIM_MESSAGE =
  "API key không hợp lệ, đã hết hạn hoặc đã bị vô hiệu hóa.";

export const TELEGRAM_NOT_CONNECTED_MESSAGE =
  "Chưa kết nối được key. Hãy gửi API key QRouter trong cuộc trò chuyện riêng này.";

export function formatTelegramNumber(value: number | null | undefined): string {
  return Number.isFinite(value) ? new Intl.NumberFormat("en-US").format(value ?? 0) : "-";
}

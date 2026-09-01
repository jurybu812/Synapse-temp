/**
 * 附件共享常量 + 纯函数 —— Plan_5_M6 C6：从 AgentPanel 抽出，供底部输入框与编辑框（useAttachments hook）共用，避免循环依赖。
 */
import type { AttachmentRef } from '@/store/slices/conversation';

export const MAX_IMAGE_PAYLOAD_BYTES = 8 * 1024 * 1024;
// 非图片（文档/文本/压缩包）也走 sha256 内容寻址落地，与图片同契约；设上限兜底（与图片对称）。
export const MAX_FILE_PAYLOAD_BYTES = 25 * 1024 * 1024;

export function generateAttachmentId(): string {
  return `att_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export function formatBytes(bytes?: number): string {
  if (!bytes) return '0 B';
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

export function getAttachmentKind(file: File): AttachmentRef['kind'] {
  if (file.type.startsWith('image/')) return 'image';
  if (file.type.startsWith('text/') || /\.(md|txt|json|csv|ts|tsx|js|jsx|py|java|cpp|c|h)$/i.test(file.name)) return 'text';
  if (/\.(pdf|docx?|pptx?|xlsx?)$/i.test(file.name)) return 'document';
  if (/\.(zip|rar|7z|tar|gz)$/i.test(file.name)) return 'archive';
  return 'other';
}

export function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error('读取附件失败'));
    reader.readAsDataURL(file);
  });
}

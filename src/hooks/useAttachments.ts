/**
 * useAttachments —— Plan_5_M6 C6：把 AgentPanel 底部输入框的附件链路（上传/移除/还原/release）抽成可复用 hook，
 * 让「底部主输入框」与「编辑历史消息的输入框」共用同一套附件逻辑（类比 useAtMention）。本批先给编辑框用，底部迁移为收尾。
 *
 * ★ refCount 守恒核心（对抗 M2-R6 踩过的双计/泄漏）：newlyPutShasRef 只记录「本 hook 实例内通过 addFiles 新 put 的 sha」。
 *   - addFiles put 成功 → +1 且记入 newlyPut。
 *   - remove：只对 newlyPut 的项物理 delete（撤销 +1）；还原自旧消息的引用只移 UI、不 delete（其引用仍归属旧消息，物理 release 交保存/取消统一收口）。
 *   - releaseDrafts(keepShas)：release newlyPut 中不在 keepShas 的（取消编辑：全 release；卸载兜底）。
 *   - markCommitted：只清 newlyPut 记录、不 delete（保存成功：新上传引用已随消息转移走）。
 *   - restoreFrom：还原旧消息附件成草稿，不 addRef、不进 newlyPut。
 */
import { useCallback, useRef, useState } from 'react';
import { useAppDispatch } from '@/store/hooks';
import { platform } from '@/platform';
import { addNotification } from '@/store/slices/notifications';
import { resolveAttachmentDataUrl } from '@/services/attachmentRefs';
import type { AttachmentRef } from '@/store/slices/conversation';
import { MAX_IMAGE_PAYLOAD_BYTES, MAX_FILE_PAYLOAD_BYTES, generateAttachmentId, formatBytes, getAttachmentKind, readAsDataUrl } from '@/utils/attachments';

export interface UseAttachmentsApi {
  pending: AttachmentRef[];
  addFiles: (files: File[], kind: 'file' | 'image') => Promise<void>;
  remove: (id: string) => void;
  /** 把已发消息附件还原成可编辑草稿（剥运行标记、status ready、异步缩略图）。不 addRef（引用转移由 handleEdit 守恒）。 */
  restoreFrom: (atts: AttachmentRef[] | undefined) => void;
  /** 取消/卸载：release newlyPut 中不在 keepShas 的草稿（防孤儿）。 */
  releaseDrafts: (keepShas?: Set<string>) => void;
  /** 保存成功：只清 newlyPut 记录、不 delete（引用已随消息转移）。 */
  markCommitted: () => void;
  /** status === 'ready' 的附件。 */
  ready: () => AttachmentRef[];
}

export function useAttachments(): UseAttachmentsApi {
  const dispatch = useAppDispatch();
  const [pending, setPending] = useState<AttachmentRef[]>([]);
  const newlyPutShasRef = useRef<Set<string>>(new Set());

  const addFiles = useCallback(async (files: File[], kind: 'file' | 'image') => {
    const next: AttachmentRef[] = [];
    for (const file of files) {
      const id = generateAttachmentId();
      const fileKind: AttachmentRef['kind'] = kind === 'image' ? 'image' : getAttachmentKind(file);
      const path = (file as any).path || (file as any).webkitRelativePath || file.name;
      const base: AttachmentRef = { id, name: file.name, path, mimeType: file.type || undefined, size: file.size, kind: fileKind, status: 'ready' };
      const limit = fileKind === 'image' ? MAX_IMAGE_PAYLOAD_BYTES : MAX_FILE_PAYLOAD_BYTES;
      if (file.size > limit) {
        next.push({ ...base, status: 'error', error: `${fileKind === 'image' ? '图片' : '文件'}超过 ${formatBytes(limit)}，暂不发送` });
        continue;
      }
      try {
        const dataUrl = await readAsDataUrl(file);
        const ref = await platform.attachment.put({ data: dataUrl, mime: file.type || undefined, name: file.name, kind: fileKind });
        if ('error' in ref) {
          next.push({ ...base, status: 'error', error: (ref as any).message || '附件存储失败' });
        } else {
          newlyPutShasRef.current.add(ref.sha256); // ★ 记入「新上传」，取消时要 release
          next.push({ ...base, sha256: ref.sha256, size: ref.size || file.size, mimeType: ref.mime || base.mimeType, previewUrl: fileKind === 'image' ? dataUrl : undefined });
        }
      } catch (err: any) {
        next.push({ ...base, status: 'error', error: err?.message || '读取失败' });
      }
    }
    setPending(prev => [...prev, ...next]);
    const failed = next.filter(a => a.status === 'error').length;
    dispatch(addNotification({
      type: failed ? 'warning' : 'info',
      title: kind === 'image' ? '已加入图片附件' : '已加入文件附件',
      message: failed ? `${next.length - failed} 个成功，${failed} 个失败` : next.map(a => a.name).join(', '),
      duration: 2500,
    }));
  }, [dispatch]);

  const remove = useCallback((id: string) => {
    setPending(prev => {
      const removed = prev.find(a => a.id === id);
      // ★ 只 release 本实例新上传的草稿；还原自旧消息的项只移 UI（refCount 守恒路径 C）。
      if (removed?.sha256 && newlyPutShasRef.current.has(removed.sha256)) {
        void platform.attachment.delete(removed.sha256).catch(() => undefined);
        newlyPutShasRef.current.delete(removed.sha256);
      }
      return prev.filter(a => a.id !== id);
    });
  }, []);

  const restoreFrom = useCallback((atts: AttachmentRef[] | undefined) => {
    const list = atts ?? [];
    if (list.length === 0) { setPending([]); return; }
    const restored: AttachmentRef[] = list
      .filter(a => !!a.sha256)
      .map(a => ({ ...a, previewUrl: undefined, payloadUrl: undefined, status: 'ready' as const, error: undefined }));
    setPending(restored);
    for (const a of restored) {
      if (a.kind === 'image' && a.sha256) {
        void resolveAttachmentDataUrl(a.sha256).then(dataUrl => {
          if (!dataUrl) return;
          // 函数式 + 按 id 匹配：已删项 map 找不到则 no-op，不复活（异步缩略图竞态防护）。
          setPending(prev => prev.map(p => (p.id === a.id ? { ...p, previewUrl: dataUrl } : p)));
        });
      }
    }
  }, []);

  const releaseDrafts = useCallback((keepShas?: Set<string>) => {
    for (const sha of newlyPutShasRef.current) {
      if (!keepShas?.has(sha)) void platform.attachment.delete(sha).catch(() => undefined);
    }
    newlyPutShasRef.current = new Set();
  }, []);

  const markCommitted = useCallback(() => { newlyPutShasRef.current = new Set(); }, []);
  const ready = useCallback(() => pending.filter(a => a.status === 'ready'), [pending]);

  return { pending, addFiles, remove, restoreFrom, releaseDrafts, markCommitted, ready };
}

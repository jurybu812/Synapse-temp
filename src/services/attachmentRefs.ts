/**
 * 附件引用层工具（M2-R6 第2段）
 *
 * 统一封装「消息 ⇄ 附件实体」的引用收集 / 去 base64 净化 / 发送前还原 / refCount GC / 懒迁移 / 渲染还原，
 * 全部基于 platform.attachment（第1段：sha256 内容寻址 blob 存储，桌面 fs IPC / 网页 IndexedDB，两端签名一致）。
 *
 * 核心契约：
 *   - 对话本体 / DB 只存 sha256 引用 + 元数据（size/mime/name），绝不含 base64。
 *   - base64 仅活在【内存态即时预览】(blobURL / dataUrl) 与【发 API 那一刻的临时还原】。
 *   - sha256 是抽象边界——上层不感知桌面 fs / 网页 IndexedDB 的差异。
 *
 * 失败口径：所有写盘 / GC / 还原失败一律吞掉或降级（附件层是增强能力，绝不阻塞主对话 / 落库）。
 */

import { platform } from '@/platform';
import type { Message, MessageContentPart } from '@/store/slices/conversation';
import type { ChatMessage } from './aiClient';

/** 任意结构里取 attachment.kind → put 的 kind 入参（put 的 kind 是 string，宽松透传）。 */
function refKindToStoreKind(mime?: string, kind?: string): string {
  if (kind) return kind;
  if (mime?.startsWith('image/')) return 'image';
  return 'file';
}

function isDataUrl(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith('data:');
}

// ===== ⓪ 发送瞬时图片有效性预检（M2-S 任务1） =====

/**
 * 从 data:URL 解出前若干字节（仅取头部，不整图解码）。
 * 失败（非 data: / 非 base64 / 解码异常）返回 null。
 * @param maxBytes 需要嗅探的最大字节数（魔数最长的 WebP 需要 12 字节，取 16 留余量）。
 */
function sniffDataUrlBytes(dataUrl: string, maxBytes = 16): Uint8Array | null {
  if (typeof dataUrl !== 'string') return null;
  // data:[<mime>][;base64],<payload>
  const comma = dataUrl.indexOf(',');
  if (!dataUrl.startsWith('data:') || comma < 0) return null;
  const meta = dataUrl.slice(5, comma);          // "image/png;base64"
  const payload = dataUrl.slice(comma + 1);
  if (!payload) return null;

  const isBase64 = /;base64/i.test(meta);
  try {
    if (isBase64) {
      // 只解码足够覆盖魔数的前缀：base64 每 4 字符 → 3 字节，截一小段解码即可（避免整图解码）。
      const need = Math.ceil((maxBytes / 3) * 4);
      let head = payload.slice(0, need).replace(/\s/g, '');
      // base64 长度必须是 4 的倍数才能解；不足则按 4 对齐截断（丢掉不完整的尾组，头部魔数不受影响）。
      head = head.slice(0, head.length - (head.length % 4));
      if (!head) return null;
      const decode = (b64: string): Uint8Array => {
        if (typeof atob === 'function') {
          const bin = atob(b64);
          const out = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
          return out;
        }
        // Node / Electron 主进程兜底（一般渲染层有 atob，这里仅防御）。
        const BufferCtor = (globalThis as any).Buffer;
        if (BufferCtor) return new Uint8Array(BufferCtor.from(b64, 'base64'));
        return new Uint8Array(0);
      };
      const bytes = decode(head);
      return bytes.length ? bytes.slice(0, maxBytes) : null;
    }
    // 非 base64（百分号编码的 data:URL，图片极少这么传，但兜底解一下头部）。
    const decoded = decodeURIComponent(payload.slice(0, maxBytes * 4));
    const out = new Uint8Array(Math.min(decoded.length, maxBytes));
    for (let i = 0; i < out.length; i++) out[i] = decoded.charCodeAt(i) & 0xff;
    return out.length ? out : null;
  } catch {
    return null;
  }
}

function matchMagic(bytes: Uint8Array, magic: number[], offset = 0): boolean {
  if (bytes.length < offset + magic.length) return false;
  for (let i = 0; i < magic.length; i++) {
    if (bytes[offset + i] !== magic[i]) return false;
  }
  return true;
}

/**
 * 发送瞬时纯函数判断：dataUrl 是否「看起来是」一张合法图片（只读头部魔数，不整图解码）。
 *
 * 背景（M2-S 任务1）：多轮对话会重发历史所有图，只要历史里混进过一张无效图（损坏/非图片字节），
 * 上游对该请求里任一无效图会整体 400，把同请求里的有效图和正常对话一起拖垮。发送前对每张图做头部
 * 预检，无效图从请求体剔除，避免整条请求带病发出。
 *
 * 覆盖主流容器（魔数）：
 *   - PNG  : 89 50 4E 47
 *   - JPEG : FF D8 FF
 *   - GIF  : 47 49 46 38            ("GIF8")
 *   - WebP : 52 49 46 46 (RIFF) + 偏移8 处 57 45 42 50 ("WEBP")
 *   - BMP  : 42 4D                  ("BM")
 *   - AVIF/HEIC/HEIF : ISO BMFF ftyp 容器——偏移4 处 66 74 79 70 ("ftyp")
 *
 * 设计取舍：宁可漏过个别冷门格式（返回 true）也绝不误杀主流合法图——
 *   - 解不出字节（非 data: / 非图片 dataUrl，如外链 http url 不会进这里）→ 保守判 true（不剔除，交上游处理）。
 *   - 能解出字节但完全不匹配任一主流魔数 → 判 false（高概率是损坏/非图片字节，剔除）。
 */
export function isLikelyValidImage(dataUrl: string): boolean {
  // 只对 data:URL 做魔数预检；非 data:（如外链 http(s) 图片）无法读头部，保守放行。
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:')) return true;

  // SVG 是【文本型图】（无二进制魔数，解码后以 <?xml / <svg 开头），不能用二进制魔数判，按 mime 直接放行，避免误杀。
  const comma = dataUrl.indexOf(',');
  const mimeMeta = comma > 0 ? dataUrl.slice(5, comma).toLowerCase() : '';
  if (mimeMeta.includes('image/svg')) return true;

  const bytes = sniffDataUrlBytes(dataUrl, 16);
  // 解不出头部字节（空/解码失败/非 base64 无法嗅探）：保守放行，不在预检阶段误杀。
  if (!bytes || bytes.length < 2) return true;

  // PNG
  if (matchMagic(bytes, [0x89, 0x50, 0x4e, 0x47])) return true;
  // JPEG
  if (matchMagic(bytes, [0xff, 0xd8, 0xff])) return true;
  // GIF ("GIF8" 覆盖 87a/89a)
  if (matchMagic(bytes, [0x47, 0x49, 0x46, 0x38])) return true;
  // BMP ("BM")
  if (matchMagic(bytes, [0x42, 0x4d])) return true;
  // WebP : RIFF....WEBP
  if (matchMagic(bytes, [0x52, 0x49, 0x46, 0x46]) && matchMagic(bytes, [0x57, 0x45, 0x42, 0x50], 8)) return true;
  // AVIF / HEIC / HEIF : ISO BMFF，偏移4 处为 "ftyp"（major brand 多变，认 ftyp 容器即可）
  if (matchMagic(bytes, [0x66, 0x74, 0x79, 0x70], 4)) return true;
  // ICO(图标 00 00 01 00) / CUR(光标 00 00 02 00)：合法图标格式，避免误杀。
  if (matchMagic(bytes, [0x00, 0x00, 0x01, 0x00]) || matchMagic(bytes, [0x00, 0x00, 0x02, 0x00])) return true;

  // 能解出字节但不匹配任一主流魔数 → 判定为无效图（损坏/非图片字节）。
  return false;
}

// ===== ① 引用收集（GC 用） =====

/**
 * 从一组消息里收集所有附件 sha256（GC 用），口径与 put 严格守恒：
 *   - 【每条消息内同一 sha256 只计一次】：同一张图在一条消息里同时出现在 contentParts(image_url) 与
 *     attachments（发送 vs 展示两套），但上传时物理上只 put 了一次（refCount+1），故一条消息对一个 sha256
 *     的真实引用 = 1。若不按消息去重会双记账，删一条消息 release 两次、误删仍被别条引用的实体（Codex 高风险①）。
 *   - 【跨消息累加（不去重）】：每条消息上传时各 put 一次（put 去重命中也会 ref_count+1），
 *     故 N 条消息引用同一图 ⇒ refCount=N，逐条删各 release 一次，归零才删实体——守恒。
 * 来源：contentParts 的 image_url.sha256 / file 的 sha256，以及 attachments[].sha256。
 */
export function collectMessageShas(messages: Array<Pick<Message, 'contentParts' | 'attachments'>>): string[] {
  const shas: string[] = [];
  for (const msg of messages ?? []) {
    const perMessage = new Set<string>(); // 每条消息内去重
    for (const part of msg.contentParts ?? []) {
      if (part.type === 'image_url' && part.sha256) perMessage.add(part.sha256);
      else if (part.type === 'file' && part.file?.sha256) perMessage.add(part.file.sha256);
    }
    for (const att of msg.attachments ?? []) {
      if (att.sha256) perMessage.add(att.sha256);
    }
    for (const sha of perMessage) shas.push(sha);
  }
  return shas;
}

/**
 * 对被移除消息引用的每个 sha256 调 platform.attachment.delete（refCount-1，归零删实体 GC）。
 * fire-and-forget：逐个吞错，不阻塞调用方。一条消息引用同一 sha256 N 次则 release N 次（与 put 守恒）。
 */
export async function releaseMessageAttachments(
  messages: Array<Pick<Message, 'contentParts' | 'attachments'>>,
): Promise<void> {
  const shas = collectMessageShas(messages);
  if (shas.length === 0) return;
  await Promise.all(
    shas.map(sha => platform.attachment.delete(sha).catch(() => undefined)),
  );
}

// ===== ② 落库去 base64（持久化净化） =====

/**
 * 深净化一组消息用于持久化：把任何残留 base64（data: 开头）从
 *   contentParts image_url.url / file.data / file.url、attachments payloadUrl / previewUrl
 * 清掉（仅当该条已有 sha256 引用时清——无 sha256 的 data: 是尚未迁移的旧数据，留给懒迁移处理，
 * 这里不擅自丢弃，避免迁移前丢图）。返回新数组（不就地修改 store）。
 *
 * 这是「DB 绝不含 base64」的最后防线：即便 store 里临时带着 blobURL / base64，落库前也会被剥掉。
 */
export function sanitizeMessagesForPersistence(messages: Message[]): Message[] {
  if (!Array.isArray(messages)) return messages;
  return messages.map(msg => {
    let touched = false;

    const contentParts = msg.contentParts?.map((part): MessageContentPart => {
      if (part.type === 'image_url') {
        if (part.sha256 && isDataUrl(part.image_url?.url)) {
          touched = true;
          return { ...part, image_url: { ...part.image_url, url: '' } };
        }
        return part;
      }
      if (part.type === 'file') {
        const f = part.file;
        if (f?.sha256 && (isDataUrl(f.data) || isDataUrl(f.url))) {
          touched = true;
          return { ...part, file: { ...f, data: isDataUrl(f.data) ? undefined : f.data, url: isDataUrl(f.url) ? undefined : f.url } };
        }
        return part;
      }
      return part;
    });

    const attachments = msg.attachments?.map(att => {
      if (att.sha256 && (isDataUrl(att.payloadUrl) || isDataUrl(att.previewUrl))) {
        touched = true;
        return {
          ...att,
          payloadUrl: isDataUrl(att.payloadUrl) ? undefined : att.payloadUrl,
          previewUrl: isDataUrl(att.previewUrl) ? undefined : att.previewUrl,
        };
      }
      return att;
    });

    // ★ M4-8-S3：reconnect 是 UI 瞬态字段（退避重试进度），绝不持久化。这里显式剔除——
    //   sanitizeMessagesForPersistence 是【黑名单剔除式】：默认 ...msg 全量保留（含新增字段如 D1 的 richTokens），
    //   仅显式剔除瞬态运行态字段（当前只有 reconnect）。新增字段天然透传，无需改本函数；
    //   若需『绝不持久化』某字段才在此追加剔除分支。M6 D1 review HIGH#3-related：注释口径订正。
    //   若不剔，挂在 message 上的 reconnect 会被原样落库，历史恢复后带假「重连中」（Plan_5 风险二）。
    const hasReconnect = (msg as any).reconnect !== undefined;
    if (hasReconnect) touched = true;

    if (!touched) return msg;
    const next: Message = { ...msg, contentParts, attachments };
    if (hasReconnect) delete (next as any).reconnect;
    return next;
  });
}

// ===== ③ 发 API 前还原（模型需要真图） =====

export function downgradeApiMessageImagesToText(
  apiMessages: ChatMessage[],
): { messages: ChatMessage[]; downgradedImages: number } {
  let downgradedImages = 0;
  const messages = apiMessages.map((message): ChatMessage => {
    if (!Array.isArray(message.content)) return message;
    let touched = false;
    const content = message.content.map((part: any) => {
      if (!part || part.type !== 'image_url') return part;
      touched = true;
      downgradedImages++;
      const name = String(part.name || part.image_url?.name || '').trim();
      const sha = String(part.sha256 || '').trim();
      const identity = [name && `name=${name}`, sha && `sha256=${sha}`].filter(Boolean).join(' ');
      return {
        type: 'text' as const,
        text: `[图片未发送：当前模型不支持 Vision${identity ? `；${identity}` : ''}]`,
      };
    });
    return touched ? { ...message, content } : message;
  });
  return { messages, downgradedImages };
}

/**
 * 发送前把 apiMessages 里的 image_url / file part（持 sha256、url 非真 base64）按 sha256
 * platform.attachment.get 还原成真 dataUrl 再发给模型。返回新数组（不改 store）。
 *
 * - 只还原 content 为数组的消息（system prompt / 纯文本消息直接透传）。
 * - 已是 data: 的 url（懒迁移未及 / 内存态预览）保持不动。
 * - get 失败 / 找不到实体：image 留文字占位「[图片缺失]」，file 留 filename，不崩、不阻断发送。
 */
export async function restoreApiMessagesAttachments(
  apiMessages: ChatMessage[],
): Promise<{ messages: ChatMessage[]; skippedInvalidImages: number }> {
  // M2-S 任务1：发送瞬时对每张【还原后的真 data: 图】做头部魔数预检，无效图剔除为文字占位并计数，
  // 避免一张坏图让整条请求被上游整体 400 拖垮。计数返回给调用方（agentLoop）做用户提示。
  let skippedInvalidImages = 0;

  const messages = await Promise.all(apiMessages.map(async (msg): Promise<ChatMessage> => {
    if (typeof msg.content === 'string' || !Array.isArray(msg.content)) return msg;

    const parts = msg.content as any[];
    let touched = false;

    const restored = await Promise.all(parts.map(async (part) => {
      if (!part || part.type === 'text') return part;

      if (part.type === 'image_url') {
        const url: string = part.image_url?.url || '';
        const sha: string | undefined = part.sha256;
        // ★ 还原成功/已是 base64 都输出【纯净标准 part】——只留 { type, image_url:{url,detail} }，
        //   剥掉引用元数据(sha256/size/mime/name/attachmentId)，避免非标准字段进请求体被严格网关拒绝。
        const detail = part.image_url?.detail;
        const partName: string | undefined = part.name || part.image_url?.name;
        const cleanImage = (u: string) => ({ type: 'image_url', image_url: detail ? { url: u, detail } : { url: u } });
        // 真 data: 图发送前预检：无效（损坏/非图片字节）→ 剔除为文字占位 + 计数，不整条带病发出。
        const emitImageOrPlaceholder = (u: string) => {
          if (u.startsWith('data:') && !isLikelyValidImage(u)) {
            skippedInvalidImages++;
            const n = partName ? ` ${partName}` : '';
            return { type: 'text', text: `[图片无效已跳过${n}]` };
          }
          return cleanImage(u);
        };
        if (url.startsWith('data:')) { touched = true; return emitImageOrPlaceholder(url); } // 已有真 base64（内存预览/未迁移）
        if (!sha) return part;                                // 无引用可还原，原样（可能是外链 http url）
        const got = await platform.attachment.get(sha).catch(() => null);
        touched = true;
        if (got?.dataUrl) return emitImageOrPlaceholder(got.dataUrl);
        // 实体缺失：降级为文字占位，避免发出空 url 的 image part 被服务端拒绝
        const name = part.name ? ` ${part.name}` : '';
        return { type: 'text', text: `[图片缺失${name}]` };
      }

      if (part.type === 'file') {
        const f = part.file ?? {};
        const sha: string | undefined = f.sha256;
        const filename = f.filename || f.name || '文件';
        // 纯净标准 file part：只留 { type, file:{filename, file_data} }，剥掉 sha256/size/url 等。
        const cleanFile = (dataUrl: string) => ({ type: 'file', file: { filename, file_data: dataUrl } });
        if (f.file_data) { touched = true; return cleanFile(f.file_data); }
        if (f.data && String(f.data).startsWith('data:')) { touched = true; return cleanFile(f.data); }
        if (f.url && String(f.url).startsWith('data:')) { touched = true; return cleanFile(f.url); }
        if (!sha) return part;
        const got = await platform.attachment.get(sha).catch(() => null);
        touched = true;
        if (got?.dataUrl) return cleanFile(got.dataUrl);
        return { type: 'text', text: `[附件缺失 ${filename}]` };
      }

      return part;
    }));

    if (!touched) return msg;
    return { ...msg, content: restored } as ChatMessage;
  }));

  return { messages, skippedInvalidImages };
}

// ===== ④ record 源占位（去 base64 + 留可读占位） =====

/**
 * 把 ChatMessage.content 转成纯文本【供 record 源使用】：文本 part 直接取；
 * image/file part 转成「[图片 name]」「[附件 name]」占位（绝不含 base64，且比直接丢弃更可读）。
 * 与发 API 的 chatContentToText（纯丢非文本）区分：仅 record 源走本函数。
 */
export function chatContentToTextWithPlaceholder(content: ChatMessage['content']): string {
  if (typeof content === 'string') return content;
  return (content as any[])
    .map(part => {
      if (!part) return '';
      if (part.type === 'text') return part.text ?? '';
      if (part.type === 'image_url') {
        const name = part.name || part.image_url?.name || '';
        return name ? `[图片 ${name}]` : '[图片]';
      }
      if (part.type === 'file') {
        const name = part.file?.filename || part.file?.name || '';
        return name ? `[附件 ${name}]` : '[附件]';
      }
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

// ===== ⑤ 懒迁移（旧内联 base64 → sha256 引用） =====

/** 快速探测一组消息里是否存在尚未迁移的内联 base64（用于决定是否触发迁移，避免无谓扫描/回写）。 */
export function hasInlineBase64(messages: Message[]): boolean {
  for (const msg of messages ?? []) {
    for (const part of msg.contentParts ?? []) {
      if (part.type === 'image_url' && !part.sha256 && isDataUrl(part.image_url?.url)) return true;
      if (part.type === 'file' && !part.file?.sha256 && (isDataUrl(part.file?.data) || isDataUrl(part.file?.url))) return true;
    }
    for (const att of msg.attachments ?? []) {
      if (!att.sha256 && (isDataUrl(att.payloadUrl) || isDataUrl(att.previewUrl))) return true;
    }
  }
  return false;
}

/**
 * 懒迁移：把旧内联 base64（无 sha256 的 data:）调 platform.attachment.put 抽离成实体，
 * 换成 sha256 引用并清掉内联 data:。返回 { messages, changed }。
 *
 * 「用到才迁」：调用方在 load 后后台触发；任一附件 put 失败则保留其原内联 data:（不丢图），changed 仅在确有替换时为 true。
 */
export async function migrateMessagesAttachments(
  messages: Message[],
): Promise<{ messages: Message[]; changed: boolean; newShas: string[] }> {
  if (!Array.isArray(messages) || !hasInlineBase64(messages)) {
    return { messages, changed: false, newShas: [] };
  }
  let changed = false;
  // 本轮迁移净新增的引用（每条消息内每个 sha 的净增=1，与 collectMessageShas 口径一致）。
  // 供调用方在回写 DB 失败时成对 release 回滚——避免「put 成功但回写失败 → 下次再迁再 put」抬高 refCount。
  const newShas: string[] = [];

  // ★ Codex 高风险修复：R6 之前同一张图的 base64 同时内联在 contentParts(image_url) 与 attachments 两处，
  //   migrate 把两者当独立流各 put 一次 → 同一字节同一 sha → refCount 累加到 2（put 去重命中也 +1）。
  //   而 GC 侧 collectMessageShas【每条消息内同一 sha 只计一次】，删消息/对话时只 release 1 次 →
  //   refCount 2→1 永远到不了 0 → blob+账本行永久泄漏。
  //   修法：让【每条消息】对一个 sha 的净增严格 = 1，与 collectMessageShas 口径守恒。
  //   实现：本条消息内维护已 put 的 sha 集合；contentParts 先迁并登记 sha，attachments 迁移产出的 sha
  //   若已在集合内（同字节重复持有），立即把这次多 put 出来的引用 release 掉（净增回 1）。
  const next = await Promise.all(messages.map(async (msg): Promise<Message> => {
    let touched = false;
    const seenShas = new Set<string>();     // 本条消息内已计入净引用(=1)的 sha
    const surplusShas: string[] = [];       // 本条消息内重复 put 产生的多余引用，迁完成对 release

    // 登记一次 put 产出的 sha：首见则记账(净引用+1, 计入 newShas)，重复见则标记为多余引用待 release。
    const accountSha = (sha: string): void => {
      if (seenShas.has(sha)) surplusShas.push(sha);
      else { seenShas.add(sha); newShas.push(sha); }
    };

    const contentParts = msg.contentParts
      ? await Promise.all(msg.contentParts.map(async (part): Promise<MessageContentPart> => {
        if (part.type === 'image_url' && !part.sha256 && isDataUrl(part.image_url?.url)) {
          const ref = await platform.attachment.put({
            data: part.image_url.url,
            mime: part.mime,
            name: part.name,
            kind: 'image',
          }).catch(() => null);
          if (ref && !('error' in ref)) {
            touched = true;
            accountSha(ref.sha256);
            return {
              ...part,
              sha256: ref.sha256,
              size: ref.size,
              mime: ref.mime,
              name: part.name ?? ref.name,
              image_url: { ...part.image_url, url: '' },
            };
          }
          return part; // put 失败：保留原内联 data:（下次再试）
        }
        if (part.type === 'file' && !part.file?.sha256) {
          const data = isDataUrl(part.file?.data) ? part.file?.data : isDataUrl(part.file?.url) ? part.file?.url : undefined;
          if (data) {
            const ref = await platform.attachment.put({
              data,
              mime: part.file?.mimeType,
              name: part.file?.filename,
              kind: 'file',
            }).catch(() => null);
            if (ref && !('error' in ref)) {
              touched = true;
              accountSha(ref.sha256);
              return {
                ...part,
                file: {
                  ...part.file,
                  filename: part.file?.filename ?? ref.name,
                  mimeType: part.file?.mimeType ?? ref.mime,
                  sha256: ref.sha256,
                  size: ref.size,
                  data: undefined,
                  url: isDataUrl(part.file?.url) ? undefined : part.file?.url,
                },
              };
            }
          }
          return part;
        }
        return part;
      }))
      : msg.contentParts;

    const attachments = msg.attachments
      ? await Promise.all(msg.attachments.map(async (att) => {
        if (att.sha256) return att;
        const data = isDataUrl(att.payloadUrl) ? att.payloadUrl : isDataUrl(att.previewUrl) ? att.previewUrl : undefined;
        if (!data) return att;
        const ref = await platform.attachment.put({
          data,
          mime: att.mimeType,
          name: att.name,
          kind: refKindToStoreKind(att.mimeType, att.kind),
        }).catch(() => null);
        if (ref && !('error' in ref)) {
          touched = true;
          accountSha(ref.sha256);
          return {
            ...att,
            sha256: ref.sha256,
            size: att.size ?? ref.size,
            mimeType: att.mimeType ?? ref.mime,
            // 抽离后 payloadUrl 内联 data: 清掉；previewUrl 留作内存预览（落库时 sanitize 再清）
            payloadUrl: undefined,
          };
        }
        return att;
      }))
      : msg.attachments;

    // 本条消息内对同一 sha 的重复持有：每条多余引用 release 一次，使净增回落到 collectMessageShas 口径(=1)。
    if (surplusShas.length) {
      await Promise.all(surplusShas.map(sha => platform.attachment.release(sha).catch(() => undefined)));
    }

    if (!touched) return msg;
    changed = true;
    return { ...msg, contentParts, attachments };
  }));

  return { messages: next, changed, newShas };
}

/**
 * 回滚一批迁移产生的引用（迁移回写 DB 失败时调用）：每个 sha release 一次，与 migrate 的净增守恒。
 * 让「put 成功 → 回写失败」不残留多余引用——DB 保持旧内联态，下次重迁会重新 put，引用计数不漂移。
 * fire-and-forget：逐个吞错，绝不阻塞调用方。
 */
export async function rollbackMigratedShas(shas: string[]): Promise<void> {
  if (!shas?.length) return;
  await Promise.all(shas.map(sha => platform.attachment.release(sha).catch(() => undefined)));
}

// ===== ⑥ 渲染还原（按 sha256 懒加载 dataUrl，带缓存） =====

const dataUrlCache = new Map<string, Promise<string | null>>();

/**
 * 按 sha256 取还原后的 dataUrl（渲染历史附件预览用），带模块级缓存避免重复读盘/读 IndexedDB。
 * 找不到 / 失败返回 null（调用方回退到图标占位）。
 */
export function resolveAttachmentDataUrl(sha256: string): Promise<string | null> {
  if (!sha256) return Promise.resolve(null);
  const cached = dataUrlCache.get(sha256);
  if (cached) return cached;
  const p = platform.attachment.get(sha256)
    .then(got => got?.dataUrl ?? null)
    .catch(() => null);
  dataUrlCache.set(sha256, p);
  // 失败结果不长期缓存，下次可重试
  p.then(v => { if (v === null) dataUrlCache.delete(sha256); }).catch(() => dataUrlCache.delete(sha256));
  return p;
}

/**
 * Document Text Extract
 * 让 AI 工具能直接读 office/pdf 的【文本内容】（而非二进制乱码）。
 *
 * 统一在【渲染进程】完成提取：复用已装库（pdf.js / mammoth / jszip / xlsx）+ fileSystem.readBinary
 * 拿到 ArrayBuffer 再喂库，不改 electron 主进程 IPC（readBinary 已够用）。
 *
 * 支持扩展名：.pdf / .docx / .pptx / .xlsx / .xls / .csv
 * 与 synopsisEngine 的解析写法保持一致（pdf worker 同款 import、pptx 走 jszip + <a:t> 正则）。
 */

import { fileSystem } from './fileSystem';
import type { AgentFileAccessContext } from '@/platform';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.mjs?url';

/** 可被本模块文本提取的扩展名（小写，含点）。toolRegistry 的 view_file 用它决定是否走 extract 分支。 */
export const EXTRACTABLE_EXTENSIONS = new Set([
  '.pdf', '.docx', '.pptx', '.xlsx', '.xls', '.csv',
]);

/** 提取文本的最大字符数——超出截断（防把整本大书塞进上下文炸 token）。 */
const MAX_CHARS = 50000;

/** 取小写扩展名（含点）。无扩展名返回空串。 */
function extOf(path: string): string {
  const name = path.split(/[\\/]/).pop() || path;
  const idx = name.lastIndexOf('.');
  return idx >= 0 ? name.slice(idx).toLowerCase() : '';
}

/** 是否为本模块可文本提取的文档类型（office/pdf）。 */
export function isExtractableDocument(path: string): boolean {
  return EXTRACTABLE_EXTENSIONS.has(extOf(path));
}

/** 超长截断 + 提示。len 为截断前的总长度。 */
function clamp(text: string): string {
  if (text.length <= MAX_CHARS) return text;
  // ★ review M1：不报「原文约 N 字符」——多页 PDF/多 sheet 在解析超限时就提前 break，text.length 只是【已解析部分】
  //   长度（严重低估真实总长），会误导 AI「文档很短、已读完」而不再翻页。改为只说后续未显示 + 指引翻页。
  return (
    text.slice(0, MAX_CHARS) +
    `\n\n…[内容超长，已显示前 ${MAX_CHARS} 字符；文档后续内容未显示。如需更多，请用 read_document 指定 page 页码、或分段读取]`
  );
}

/** 解码 XML 常见实体（PPTX <a:t> 里 & < > " ' 被转义为 &amp; &lt; 等，不解码会读出 &amp;amp; 乱码——review M3）。 */
function decodeXmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, n: string) => { try { return String.fromCodePoint(Number(n)); } catch { return _m; } })
    .replace(/&amp;/g, '&'); // &amp; 必须最后解（否则 &amp;lt; 会被二次解码成 <）
}

/**
 * 提取文档的纯文本内容。
 * @param path 文件路径（应为调用方已解析好的可读路径——本函数原样交给 fileSystem.readBinary）。
 * @returns 提取出的纯文本（可能带 `--- Page N ---` / sheet 名分隔），超长会截断并附提示。
 * @throws 不支持的扩展名 / 读取或解析失败时抛错（调用方负责兜底成可读错误信息）。
 */
export async function extractDocumentText(path: string, access?: AgentFileAccessContext): Promise<string> {
  const ext = extOf(path);
  if (!EXTRACTABLE_EXTENSIONS.has(ext)) {
    throw new Error(`不支持的文档类型: ${ext || '(无扩展名)'}（支持 .pdf/.docx/.pptx/.xlsx/.xls/.csv）`);
  }

  const data = await fileSystem.readBinary(path, access);

  switch (ext) {
    case '.pdf':
      return clamp(await extractPdf(data));
    case '.docx':
      return clamp(await extractDocx(data));
    case '.pptx':
      return clamp(await extractPptx(data));
    case '.xlsx':
    case '.xls':
    case '.csv':
      return clamp(await extractSpreadsheet(data));
    default:
      // 理论不可达（上方已校验白名单）。
      throw new Error(`不支持的文档类型: ${ext}`);
  }
}

/** PDF：pdf.js 逐页 getTextContent 拼接（参考 synopsisEngine.addPdfFile）。 */
async function extractPdf(data: ArrayBuffer): Promise<string> {
  const pdfjsLib = await import('pdfjs-dist');
  pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

  const pdf = await pdfjsLib.getDocument({ data }).promise;
  const totalPages = pdf.numPages;
  let text = '';

  for (let p = 1; p <= totalPages; p++) {
    const page = await pdf.getPage(p);
    const content = await page.getTextContent();
    const pageText = content.items
      .map((item: any) => (typeof item?.str === 'string' ? item.str : ''))
      .join(' ');
    text += `\n--- Page ${p} ---\n${pageText}`;
    // 已超出上限就提前停（省得把超大 PDF 整本解析完再丢弃）。
    if (text.length > MAX_CHARS) break;
  }

  return text.trim();
}

/** DOCX：mammoth extractRawText（只要纯文本，不 convertToHtml，省 token）。 */
async function extractDocx(data: ArrayBuffer): Promise<string> {
  const mammoth = await import('mammoth');
  // mammoth 浏览器端接收 { arrayBuffer }。
  const result = await mammoth.extractRawText({ arrayBuffer: data });
  return (result?.value || '').trim();
}

/** PPTX：jszip 解包 + <a:t> 正则抠文本（参考 synopsisEngine.addPptxFile）。 */
async function extractPptx(data: ArrayBuffer): Promise<string> {
  const JSZip = (await import('jszip')).default;
  const zip = await JSZip.loadAsync(data);

  const slideFiles = Object.keys(zip.files)
    .filter(f => /^ppt\/slides\/slide\d+\.xml$/.test(f))
    .sort((a, b) => {
      const numA = parseInt(a.match(/slide(\d+)/)?.[1] || '0', 10);
      const numB = parseInt(b.match(/slide(\d+)/)?.[1] || '0', 10);
      return numA - numB;
    });

  let text = '';
  for (let i = 0; i < slideFiles.length; i++) {
    const xml = await zip.files[slideFiles[i]].async('text');
    const texts = xml.match(/<a:t[^>]*>([^<]*)<\/a:t>/g)?.map(
      (t: string) => decodeXmlEntities(t.replace(/<[^>]+>/g, '')),
    ) || [];
    text += `\n--- Slide ${i + 1} ---\n${texts.join(' ')}`;
    if (text.length > MAX_CHARS) break;
  }

  return text.trim();
}

/** XLSX/XLS/CSV：SheetJS 读取，每个 sheet 转 CSV，用 sheet 名分隔。 */
async function extractSpreadsheet(data: ArrayBuffer): Promise<string> {
  const XLSX = await import('xlsx');
  const wb = XLSX.read(data, { type: 'array' });

  const parts: string[] = [];
  for (const name of wb.SheetNames) {
    const sheet = wb.Sheets[name];
    if (!sheet) continue;
    const csv = XLSX.utils.sheet_to_csv(sheet);
    parts.push(`--- Sheet: ${name} ---\n${csv}`);
    if (parts.join('\n\n').length > MAX_CHARS) break;
  }

  return parts.join('\n\n').trim();
}

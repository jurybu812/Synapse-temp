/**
 * Synopsis Engine
 * 工作区文档解析 + 分块 + AI 概要生成
 */

import { store } from '@/store';
import { addNotification } from '@/store/slices/notifications';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.mjs?url';

export interface SynopsisChunk {
  id: string;
  fileId: string;
  pageRange: [number, number];
  text: string;
  summary?: string;
  status: 'pending' | 'processing' | 'done' | 'error';
}

export interface SynopsisFile {
  id: string;
  name: string;
  type: 'pdf' | 'pptx' | 'text' | 'markdown';
  chunks: SynopsisChunk[];
  totalPages: number;
  progress: number; // 0-100
}

const CHUNK_SIZE = 20; // pages per chunk

class SynopsisEngine {
  private files: Map<string, SynopsisFile> = new Map();
  private listeners: Set<() => void> = new Set();

  subscribe(fn: () => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private notify() {
    this.listeners.forEach(fn => fn());
  }

  getFiles(): SynopsisFile[] {
    return Array.from(this.files.values());
  }

  getFile(id: string): SynopsisFile | undefined {
    return this.files.get(id);
  }

  /**
   * Parse a text-based file (markdown, txt, etc.)
   */
  async addTextFile(name: string, content: string): Promise<string> {
    const id = `syn_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    
    // Split by paragraphs or sections
    const lines = content.split('\n');
    const chunkLines = Math.ceil(lines.length / CHUNK_SIZE);
    const chunks: SynopsisChunk[] = [];

    for (let i = 0; i < Math.ceil(lines.length / chunkLines); i++) {
      const start = i * chunkLines;
      const end = Math.min(start + chunkLines, lines.length);
      chunks.push({
        id: `${id}_chunk_${i}`,
        fileId: id,
        pageRange: [start + 1, end],
        text: lines.slice(start, end).join('\n'),
        status: 'pending',
      });
    }

    this.files.set(id, {
      id,
      name,
      type: name.endsWith('.md') ? 'markdown' : 'text',
      chunks,
      totalPages: lines.length,
      progress: 0,
    });

    this.notify();
    return id;
  }

  /**
   * Parse PDF using pdf.js (lazy loaded)
   */
  async addPdfFile(name: string, data: ArrayBuffer): Promise<string> {
    const id = `syn_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    
    try {
      // Dynamically import pdf.js
      const pdfjsLib = await import('pdfjs-dist');
      pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
      
      const pdf = await pdfjsLib.getDocument({ data }).promise;
      const totalPages = pdf.numPages;
      const chunks: SynopsisChunk[] = [];

      // Split into chunks of CHUNK_SIZE pages
      for (let start = 1; start <= totalPages; start += CHUNK_SIZE) {
        const end = Math.min(start + CHUNK_SIZE - 1, totalPages);
        let text = '';

        for (let p = start; p <= end; p++) {
          const page = await pdf.getPage(p);
          const content = await page.getTextContent();
          const pageText = content.items
            .map((item: any) => item.str)
            .join(' ');
          text += `\n--- Page ${p} ---\n${pageText}`;
        }

        chunks.push({
          id: `${id}_chunk_${Math.floor(start / CHUNK_SIZE)}`,
          fileId: id,
          pageRange: [start, end],
          text: text.trim(),
          status: 'pending',
        });
      }

      this.files.set(id, {
        id,
        name,
        type: 'pdf',
        chunks,
        totalPages,
        progress: 0,
      });

      this.notify();
      store.dispatch(addNotification({
        type: 'success',
        title: 'Synopsis',
        message: `已解析 ${name}: ${totalPages} 页, ${chunks.length} 个分块`,
      }));

      return id;
    } catch (err: any) {
      store.dispatch(addNotification({
        type: 'error',
        title: 'PDF 解析失败',
        message: err.message,
      }));
      throw err;
    }
  }

  /**
   * Parse PPTX using JSZip
   */
  async addPptxFile(name: string, data: ArrayBuffer): Promise<string> {
    const id = `syn_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

    try {
      const JSZip = (await import('jszip')).default;
      const zip = await JSZip.loadAsync(data);

      // Find slide XMLs
      const slideFiles = Object.keys(zip.files)
        .filter(f => f.match(/ppt\/slides\/slide\d+\.xml$/))
        .sort((a, b) => {
          const numA = parseInt(a.match(/slide(\d+)/)?.[1] || '0');
          const numB = parseInt(b.match(/slide(\d+)/)?.[1] || '0');
          return numA - numB;
        });

      const totalPages = slideFiles.length;
      const chunks: SynopsisChunk[] = [];

      for (let start = 0; start < slideFiles.length; start += CHUNK_SIZE) {
        const end = Math.min(start + CHUNK_SIZE, slideFiles.length);
        let text = '';

        for (let i = start; i < end; i++) {
          const xml = await zip.files[slideFiles[i]].async('text');
          // Extract text from XML tags
          const texts = xml.match(/<a:t[^>]*>([^<]*)<\/a:t>/g)?.map(
            (t: string) => t.replace(/<[^>]+>/g, '')
          ) || [];
          text += `\n--- Slide ${i + 1} ---\n${texts.join(' ')}`;
        }

        chunks.push({
          id: `${id}_chunk_${Math.floor(start / CHUNK_SIZE)}`,
          fileId: id,
          pageRange: [start + 1, end],
          text: text.trim(),
          status: 'pending',
        });
      }

      this.files.set(id, {
        id,
        name,
        type: 'pptx',
        chunks,
        totalPages,
        progress: 0,
      });

      this.notify();
      return id;
    } catch (err: any) {
      store.dispatch(addNotification({
        type: 'error',
        title: 'PPTX 解析失败',
        message: err.message,
      }));
      throw err;
    }
  }

  /**
   * Generate synopsis for a specific chunk using AI
   */
  async generateChunkSummary(fileId: string, chunkId: string, aiCall: (text: string) => Promise<string>): Promise<void> {
    const file = this.files.get(fileId);
    if (!file) return;

    const chunk = file.chunks.find(c => c.id === chunkId);
    if (!chunk) return;

    chunk.status = 'processing';
    this.notify();

    try {
      const prompt = `请为以下工作区文档生成简洁的中文概要（保留关键概念、结构、定义与重要细节）：\n\n${chunk.text.slice(0, 4000)}`;
      chunk.summary = await aiCall(prompt);
      chunk.status = 'done';
    } catch {
      chunk.status = 'error';
    }

    // Update progress
    const doneCount = file.chunks.filter(c => c.status === 'done').length;
    file.progress = Math.round((doneCount / file.chunks.length) * 100);

    this.notify();
  }

  /**
   * Generate all summaries for a file
   */
  async generateAll(fileId: string, aiCall: (text: string) => Promise<string>): Promise<void> {
    const file = this.files.get(fileId);
    if (!file) return;

    for (const chunk of file.chunks) {
      if (chunk.status !== 'done') {
        await this.generateChunkSummary(fileId, chunk.id, aiCall);
      }
    }
  }

  /**
   * Build full synopsis text for a file
   */
  buildSynopsis(fileId: string): string {
    const file = this.files.get(fileId);
    if (!file) return '';

    return file.chunks
      .filter(c => c.summary)
      .map(c => `## Pages ${c.pageRange[0]}-${c.pageRange[1]}\n${c.summary}`)
      .join('\n\n');
  }

  /**
   * Remove a file from synopsis
   */
  removeFile(fileId: string) {
    this.files.delete(fileId);
    this.notify();
  }
}

export const synopsisEngine = new SynopsisEngine();

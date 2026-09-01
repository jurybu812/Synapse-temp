// Type declarations for dynamically imported optional dependencies

declare module 'pdfjs-dist' {
  export const GlobalWorkerOptions: { workerSrc: string };
  export function getDocument(source: any): { promise: Promise<PDFDocumentProxy> };

  interface PDFDocumentProxy {
    numPages: number;
    getPage(pageNumber: number): Promise<PDFPageProxy>;
  }

  interface PDFPageProxy {
    getViewport(params: { scale: number }): PDFViewport;
    getTextContent(): Promise<{ items: Array<{ str: string }> }>;
    render(params: { canvasContext: CanvasRenderingContext2D; viewport: PDFViewport }): { promise: Promise<void> };
  }

  interface PDFViewport {
    width: number;
    height: number;
  }
}

declare module 'jszip' {
  interface JSZipObject {
    async(type: 'text'): Promise<string>;
    async(type: 'arraybuffer'): Promise<ArrayBuffer>;
    async(type: 'uint8array'): Promise<Uint8Array>;
  }
  
  interface JSZipInstance {
    files: Record<string, JSZipObject>;
  }

  export default class JSZip {
    static loadAsync(data: ArrayBuffer | Uint8Array | string): Promise<JSZipInstance>;
  }
}

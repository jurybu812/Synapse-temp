import { applyReviewTransition } from './diffReviewCore';
import { showNotice } from './confirmationCoordinator';
import { fileSystem, FileWriteConflictError } from './fileSystem';

export interface EditorFileSaveResult {
  content: string;
  merged: boolean;
}

async function reportConflict(fileName: string, message: string): Promise<never> {
  await showNotice({
    title: '保存冲突',
    message: `${fileName} 在打开后被 Agent 或其它程序修改，而且双方改到了同一区域。Synapse 已保留编辑器内容和磁盘内容，没有覆盖任何一方。请先复制当前编辑，重新加载文件后手动合并。\n\n${message}`,
    tone: 'danger',
  });
  throw new Error(message);
}

export async function saveEditorFileWithConflictProtection(
  filePath: string,
  fileName: string,
  nextContent: string,
  savedContent: string | undefined,
): Promise<EditorFileSaveResult> {
  const baselineContent = savedContent ?? await fileSystem.readFile(filePath);

  for (let attempt = 0; attempt < 3; attempt++) {
    let diskContent: string;
    try {
      diskContent = await fileSystem.readFile(filePath);
    } catch (error) {
      return reportConflict(fileName, error instanceof Error ? error.message : String(error));
    }

    let transition: EditorFileSaveResult;
    try {
      transition = applyReviewTransition(baselineContent, nextContent, diskContent);
    } catch (error) {
      return reportConflict(fileName, error instanceof Error ? error.message : String(error));
    }

    try {
      await fileSystem.writeFile(filePath, transition.content, undefined, undefined, undefined, {
        expectedContent: diskContent,
      });
      return transition;
    } catch (error) {
      if (error instanceof FileWriteConflictError && attempt < 2) continue;
      return reportConflict(fileName, error instanceof Error ? error.message : String(error));
    }
  }

  return reportConflict(fileName, '文件在保存期间持续变化，已停止写入');
}

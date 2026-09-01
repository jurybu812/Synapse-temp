import { Worker } from 'worker_threads';
import {
    ManagedTaskError,
    ManagedTaskExecutor,
    type ManagedTaskExecutionContext,
    type ManagedTaskOutput,
} from '../ManagedTaskExecutor';

interface SandboxJavascriptInput {
    code: string;
    timeoutMs: number;
}

interface SandboxWorkerMessage {
    ok: boolean;
    payload?: string;
    error?: { name?: string; message?: string };
}

const MAX_LOG_ENTRIES = 500;
const MAX_LOG_CHARS = 8_192;
const MAX_RESULT_CHARS = 64_000;

const WORKER_SOURCE = String.raw`
const { parentPort, workerData } = require('node:worker_threads');
const vm = require('node:vm');

(async () => {
  const context = vm.createContext(Object.create(null), {
    name: 'synapse-javascript-sandbox',
    codeGeneration: { strings: false, wasm: false },
  });
  context.__maxLogEntries = workerData.maxLogEntries;
  context.__maxLogChars = workerData.maxLogChars;
  context.__maxResultChars = workerData.maxResultChars;
  const setup = new vm.Script(
    "globalThis.__logs = [];" +
    "globalThis.__pushLog = (text) => {" +
      "if (__logs.length >= __maxLogEntries) return;" +
      "const value = String(text);" +
      "__logs.push(value.length > __maxLogChars ? value.slice(0, __maxLogChars) + '…[truncated]' : value);" +
    "};" +
    "globalThis.__format = (value) => {" +
      "if (typeof value === 'string') return value;" +
      "try { const json = JSON.stringify(value); return json === undefined ? String(value) : json; }" +
      "catch { return String(value); }" +
    "};" +
    "globalThis.console = Object.freeze({" +
      "log: (...values) => __pushLog(values.map(__format).join(' '))," +
      "info: (...values) => __pushLog(values.map(__format).join(' '))," +
      "warn: (...values) => __pushLog('[warn] ' + values.map(__format).join(' '))," +
      "error: (...values) => __pushLog('[error] ' + values.map(__format).join(' '))" +
    "});"
  );
  setup.runInContext(context, { timeout: 1000 });
  const script = new vm.Script("'use strict'; (async () => {\n" + workerData.code + "\n})()", {
    filename: 'synapse-sandbox.js',
  });
  context.__sandboxValue = await script.runInContext(context, { timeout: workerData.timeoutMs });
  const serialize = new vm.Script(
    "(() => {" +
      "const value = __sandboxValue === undefined ? null : __sandboxValue;" +
      "const serialized = JSON.stringify(value);" +
      "const result = serialized && serialized.length > __maxResultChars" +
        " ? { truncated: true, originalChars: serialized.length, preview: serialized.slice(0, __maxResultChars) }" +
        " : value;" +
      "return JSON.stringify({ logs: __logs, result });" +
    "})()"
  );
  const payload = serialize.runInContext(context, { timeout: 1000 });
  parentPort.postMessage({ ok: true, payload });
})().catch((error) => {
  parentPort.postMessage({
    ok: false,
    error: { name: error && error.name, message: error && error.message ? error.message : String(error) },
  });
});
`;

function parseInput(input: unknown): SandboxJavascriptInput {
    const value = input as Partial<SandboxJavascriptInput> | null;
    const code = typeof value?.code === 'string' ? value.code.trim() : '';
    if (!code) throw new ManagedTaskError('JavaScript 沙盒缺少 code', 'invalid_result', false);
    if (code.length > 50_000) throw new ManagedTaskError('JavaScript 沙盒代码超过 50,000 字符限制', 'invalid_result', false);
    const requestedTimeout = Number(value?.timeoutMs);
    const timeoutMs = Number.isFinite(requestedTimeout)
        ? Math.max(100, Math.min(30_000, Math.round(requestedTimeout)))
        : 5_000;
    return { code, timeoutMs };
}

function executeWorker(task: SandboxJavascriptInput, signal: AbortSignal): Promise<{ logs: string[]; result: unknown }> {
    return new Promise((resolve, reject) => {
        const worker = new Worker(WORKER_SOURCE, {
            eval: true,
            workerData: {
                ...task,
                maxLogEntries: MAX_LOG_ENTRIES,
                maxLogChars: MAX_LOG_CHARS,
                maxResultChars: MAX_RESULT_CHARS,
            },
            resourceLimits: {
                maxOldGenerationSizeMb: 64,
                maxYoungGenerationSizeMb: 16,
                stackSizeMb: 2,
            },
        });
        let settled = false;
        const finish = (callback: () => void) => {
            if (settled) return;
            settled = true;
            clearTimeout(deadline);
            signal.removeEventListener('abort', abort);
            callback();
        };
        const abort = () => {
            void worker.terminate();
            finish(() => reject(new Error('JavaScript 沙盒任务已取消')));
        };
        const deadline = setTimeout(() => {
            void worker.terminate();
            finish(() => reject(new ManagedTaskError(
                `JavaScript 沙盒执行超过 ${task.timeoutMs}ms`,
                'timeout',
                false,
            )));
        }, task.timeoutMs + 250);
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) {
            abort();
            return;
        }
        worker.on('message', (message: SandboxWorkerMessage) => {
            finish(() => {
                if (!message.ok) {
                    const detail = message.error?.message || '未知 JavaScript 执行错误';
                    const isTimeout = /timed out/i.test(detail);
                    reject(new ManagedTaskError(detail, isTimeout ? 'timeout' : 'invalid_result', false));
                    return;
                }
                try {
                    const parsed = JSON.parse(message.payload || '{}') as { logs?: unknown; result?: unknown };
                    resolve({
                        logs: Array.isArray(parsed.logs) ? parsed.logs.map(item => String(item)).slice(0, MAX_LOG_ENTRIES) : [],
                        result: parsed.result ?? null,
                    });
                } catch (error) {
                    reject(new ManagedTaskError(
                        `JavaScript 沙盒结果无法解析: ${error instanceof Error ? error.message : String(error)}`,
                        'invalid_result',
                        false,
                    ));
                }
            });
        });
        worker.on('error', error => {
            finish(() => reject(new ManagedTaskError(error.message, 'invalid_result', false)));
        });
        worker.on('exit', code => {
            if (code === 0 || settled) return;
            finish(() => reject(new ManagedTaskError(`JavaScript 沙盒工作线程异常退出（code=${code}）`, 'invalid_result', false)));
        });
    });
}

export class SandboxJavascriptTaskExecutor extends ManagedTaskExecutor {
    readonly kind = 'sandbox-javascript';

    protected hasUnknownSideEffect(): boolean {
        return false;
    }

    protected async execute(input: unknown, context: ManagedTaskExecutionContext): Promise<ManagedTaskOutput> {
        const task = parseInput(input);
        const startedAt = Date.now();
        const output = await executeWorker(task, context.signal);
        const resultText = output.result === null ? 'null' : JSON.stringify(output.result, null, 2);
        const logText = output.logs.length ? output.logs.join('\n') : '（无）';
        return {
            text: `JavaScript 沙盒执行完成\n\n日志:\n${logText}\n\n返回值:\n${resultText}`,
            structured: {
                logs: output.logs,
                result: output.result,
                executionTimeMs: Date.now() - startedAt,
                timeoutMs: task.timeoutMs,
                isolation: {
                    fileSystem: false,
                    network: false,
                    process: false,
                    dynamicCodeGeneration: false,
                },
            },
        };
    }
}

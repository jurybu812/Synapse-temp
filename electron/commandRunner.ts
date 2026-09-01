import { spawn } from 'child_process';
import * as fs from 'fs';

interface CommandRunnerPayload {
    shell: string;
    shellArgs: string[];
    cwd: string;
    startGatePath: string;
    stdoutPath: string;
    stderrPath: string;
}

const payloadPath = process.argv[2];
if (!payloadPath) {
    process.stderr.write('command runner 缺少 payload 路径\n');
    process.exit(127);
}

let payload: CommandRunnerPayload;
try {
    payload = JSON.parse(fs.readFileSync(payloadPath, 'utf8')) as CommandRunnerPayload;
    fs.rmSync(payloadPath, { force: true });
} catch (error: any) {
    process.stderr.write(`command runner 无法读取 payload: ${error?.message || error}\n`);
    process.exit(127);
}

async function waitForStartGate(): Promise<void> {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
        if (fs.existsSync(payload.startGatePath)) {
            fs.rmSync(payload.startGatePath, { force: true });
            return;
        }
        await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error('等待主进程持久化命令身份超时，拒绝启动用户命令');
}

async function main(): Promise<void> {
    await waitForStartGate();
    let stdoutFd: number | null = null;
    let stderrFd: number | null = null;
    let child: ReturnType<typeof spawn>;
    try {
        stdoutFd = fs.openSync(payload.stdoutPath, 'a');
        stderrFd = fs.openSync(payload.stderrPath, 'a');
        child = spawn(payload.shell, payload.shellArgs, {
            cwd: payload.cwd,
            env: { ...process.env },
            windowsHide: true,
            windowsVerbatimArguments: process.platform === 'win32',
            detached: false,
            stdio: ['ignore', stdoutFd, stderrFd],
        });
    } finally {
        if (stdoutFd !== null) fs.closeSync(stdoutFd);
        if (stderrFd !== null) fs.closeSync(stderrFd);
    }

    child.on('error', (error) => {
        process.stderr.write(`command runner 启动命令失败: ${error.message}\n`);
        process.exit(127);
    });

    child.on('close', (code) => {
        process.exit(code ?? 1);
    });
}

void main().catch((error: any) => {
    process.stderr.write(`command runner 未启动用户命令: ${error?.message || error}\n`);
    process.exit(127);
});

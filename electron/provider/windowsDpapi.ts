import { spawn } from 'node:child_process';

export function unprotectCurrentUserDpapi(ciphertextBase64: string): Promise<string> {
    const script = [
        "$ErrorActionPreference='Stop'",
        'Add-Type -AssemblyName System.Security',
        '[Console]::InputEncoding=[Text.UTF8Encoding]::new($false)',
        '[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)',
        '$encoded=[Console]::In.ReadToEnd().Trim()',
        '$cipher=[Convert]::FromBase64String($encoded)',
        '$plain=[System.Security.Cryptography.ProtectedData]::Unprotect($cipher,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser)',
        '[Console]::OpenStandardOutput().Write($plain,0,$plain.Length)',
    ].join(';');
    return new Promise((resolve, reject) => {
        const child = spawn('powershell.exe', [
            '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script,
        ], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
        const output: Buffer[] = [];
        child.stdout.on('data', chunk => output.push(Buffer.from(chunk)));
        child.once('error', () => reject(new Error('Windows DPAPI helper could not start')));
        child.once('close', code => {
            if (code !== 0) reject(new Error('Windows DPAPI operation failed'));
            else resolve(Buffer.concat(output).toString('utf8'));
        });
        child.stdin.end(ciphertextBase64, 'utf8');
    });
}

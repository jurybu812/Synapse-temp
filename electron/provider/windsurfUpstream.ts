import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const localRequire = createRequire(__filename);
const dynamicImport = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<any>;
const packageRoot = (() => {
    for (const searchRoot of localRequire.resolve.paths('opencode-windsurf-auth') ?? []) {
        const entry = join(searchRoot, 'opencode-windsurf-auth', 'dist', 'index.js');
        if (existsSync(entry)) return dirname(entry);
    }
    throw new Error('opencode-windsurf-auth package is not installed');
})();

function moduleUrl(...segments: string[]): string {
    return pathToFileURL(join(packageRoot, 'src', ...segments)).href;
}

let upstreamPromise: Promise<any> | null = null;

export function loadWindsurfUpstream(): Promise<any> {
    if (!upstreamPromise) {
        upstreamPromise = Promise.all([
            dynamicImport(moduleUrl('cloud-direct', 'chat.js')),
            dynamicImport(moduleUrl('cloud-direct', 'auth.js')),
            dynamicImport(moduleUrl('cloud-direct', 'metadata.js')),
            dynamicImport(moduleUrl('cloud-direct', 'wire.js')),
            dynamicImport(moduleUrl('oauth', 'register-user.js')),
            dynamicImport(moduleUrl('oauth', 'types.js')),
        ]).then(([chat, auth, metadata, wire, registration, oauthTypes]) => ({
            ...chat,
            ...auth,
            ...metadata,
            ...wire,
            ...registration,
            ...oauthTypes,
        }));
    }
    return upstreamPromise;
}

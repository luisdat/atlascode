import { BasicAuthInfo, PATAuthInfo, Product, ProductBitbucket, ProductJira, SiteInfo } from '../atlclients/authInfo';

/**
 * A site entry as written in the sites configuration file.
 * `token` is the NAME of an environment variable holding the token, never the token itself.
 */
export interface RawSiteConfigEntry {
    type?: unknown;
    url?: unknown;
    user?: unknown;
    token?: unknown;
    auth?: unknown;
}

export type SiteConfigAuthMode = 'pat' | 'basic';

export interface ResolvedSiteConfigEntry {
    /** Stable key for this entry, `<product>|<host><contextPath>`, used to track which sites the file manages. */
    key: string;
    /** Human readable label used in messages, e.g. `jira atmjira.indra.es`. */
    label: string;
    product: Product;
    site: SiteInfo;
    user: string;
    tokenEnvVar: string;
    authMode: SiteConfigAuthMode;
    authInfo: BasicAuthInfo | PATAuthInfo;
}

export interface SiteConfigEntryError {
    index: number;
    label: string;
    message: string;
    /** The site key, when type and url were valid enough to compute it. */
    key?: string;
}

export interface ParsedSitesConfig {
    entries: ResolvedSiteConfigEntry[];
    errors: SiteConfigEntryError[];
    /** Set when the file as a whole could not be used (invalid JSON or wrong shape). */
    fatal?: string;
}

const ENV_VAR_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function siteConfigKey(productKey: string, host: string, contextPath: string | undefined): string {
    return `${productKey}|${host.toLowerCase()}${contextPath ?? ''}`;
}

function productForType(type: unknown): Product | undefined {
    if (typeof type !== 'string') {
        return undefined;
    }
    switch (type.trim().toLowerCase()) {
        case 'jira':
            return ProductJira;
        case 'bitbucket':
            return ProductBitbucket;
        default:
            return undefined;
    }
}

/**
 * Parses `atmjira.indra.es`, `https://atmjira.indra.es`, `https://host:8443/jira/` into protocol/host/contextPath.
 */
export function parseSiteUrl(url: string): { protocol: string; host: string; contextPath: string } | undefined {
    const trimmed = url.trim();
    if (!trimmed) {
        return undefined;
    }
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    let parsed: URL;
    try {
        parsed = new URL(withScheme);
    } catch {
        return undefined;
    }
    if ((parsed.protocol !== 'https:' && parsed.protocol !== 'http:') || !parsed.host) {
        return undefined;
    }
    if (parsed.search || parsed.hash || parsed.username || parsed.password) {
        return undefined;
    }
    const contextPath = parsed.pathname.replace(/\/+$/, '');
    return { protocol: parsed.protocol, host: parsed.host.toLowerCase(), contextPath };
}

function describe(raw: RawSiteConfigEntry, index: number): string {
    const type = typeof raw?.type === 'string' ? raw.type : '?';
    const url = typeof raw?.url === 'string' ? raw.url : '?';
    return `entry #${index + 1} (${type} ${url})`;
}

/**
 * Parses and validates the sites configuration file. Invalid entries are reported individually and do not
 * prevent the valid ones from being applied. An entry whose token environment variable is not set (or empty)
 * is rejected.
 */
export function parseSitesConfig(text: string, env: Record<string, string | undefined>): ParsedSitesConfig {
    let json: unknown;
    try {
        json = JSON.parse(text);
    } catch (e) {
        return { entries: [], errors: [], fatal: `The file is not valid JSON: ${(e as Error).message}` };
    }

    const sites = (json as { sites?: unknown } | null)?.sites;
    if (typeof json !== 'object' || json === null || Array.isArray(json) || !Array.isArray(sites)) {
        return { entries: [], errors: [], fatal: 'The file must be a JSON object with a "sites" array.' };
    }

    const entries: ResolvedSiteConfigEntry[] = [];
    const errors: SiteConfigEntryError[] = [];
    const seen = new Set<string>();

    sites.forEach((value: unknown, index: number): void => {
        const raw = (typeof value === 'object' && value !== null ? value : {}) as RawSiteConfigEntry;
        const label = describe(raw, index);
        const product = productForType(raw.type);
        const parsedUrl = product && typeof raw.url === 'string' ? parseSiteUrl(raw.url) : undefined;
        const errorKey =
            product && parsedUrl ? siteConfigKey(product.key, parsedUrl.host, parsedUrl.contextPath) : undefined;
        const fail = (message: string): void => {
            errors.push({ index, label, message, key: errorKey });
        };

        if (!product) {
            return fail('"type" must be "jira" or "bitbucket".');
        }
        if (typeof raw.url !== 'string') {
            return fail('"url" is required.');
        }
        const url = parsedUrl;
        if (!url) {
            return fail(`"url" is not a valid http(s) address: ${raw.url}`);
        }
        if (typeof raw.user !== 'string' || !raw.user.trim()) {
            return fail('"user" is required.');
        }
        if (typeof raw.token !== 'string' || !ENV_VAR_NAME.test(raw.token.trim())) {
            return fail('"token" must be the name of an environment variable that holds the token.');
        }
        let authMode: SiteConfigAuthMode = 'pat';
        if (raw.auth !== undefined) {
            if (raw.auth !== 'pat' && raw.auth !== 'basic') {
                return fail('"auth" must be "pat" or "basic".');
            }
            authMode = raw.auth;
        }

        const tokenEnvVar = raw.token.trim();
        const token = env[tokenEnvVar];
        if (token === undefined || token.trim() === '') {
            return fail(`environment variable ${tokenEnvVar} is not set.`);
        }

        const key = siteConfigKey(product.key, url.host, url.contextPath);
        if (seen.has(key)) {
            errors.push({ index, label, message: 'the same site is configured more than once.' });
            return;
        }
        seen.add(key);

        const user = raw.user.trim();
        const site: SiteInfo = {
            host: url.host,
            protocol: url.protocol,
            product,
            contextPath: url.contextPath || undefined,
        };
        const authInfo =
            authMode === 'basic'
                ? ({ username: user, password: token.trim() } as BasicAuthInfo)
                : ({ token: token.trim() } as PATAuthInfo);

        entries.push({
            key,
            label: `${product.key} ${url.host}${url.contextPath}`,
            product,
            site,
            user,
            tokenEnvVar,
            authMode,
            authInfo,
        });
    });

    return { entries, errors };
}

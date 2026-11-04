import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    commands,
    ConfigurationChangeEvent,
    Disposable,
    Memento,
    RelativePattern,
    Uri,
    window,
    workspace,
} from 'vscode';

import {
    AuthInfo,
    AuthInfoEvent,
    DetailedSiteInfo,
    getSecretForAuthInfo,
    isUpdateAuthEvent,
    Product,
    ProductBitbucket,
    ProductJira,
} from '../atlclients/authInfo';
import { CredentialManager } from '../atlclients/authStore';
import { LoginManager } from '../atlclients/loginManager';
import { Logger } from '../logger';
import { SiteManager, SitesAvailableUpdateEvent } from '../siteManager';
import { parseSitesConfig, ResolvedSiteConfigEntry, siteConfigKey } from './sitesConfigParser';

export const SitesConfigFileSetting = 'atlascode.sitesConfigFile';
export const SitesConfigFileEnvVar = 'ATLASCODE_SITES_CONFIG';
export const ApplySitesConfigCommand = 'atlascode.applySitesConfig';
export const OpenSitesConfigCommand = 'atlascode.openSitesConfig';

const ManagedSitesKey = 'atlascode.sitesConfig.managed';
const DetachedSitesKey = 'atlascode.sitesConfig.detached';

/** What we remember about a site created by the configuration file. Never the token itself. */
interface ManagedSite {
    product: string;
    host: string;
    contextPath?: string;
    label: string;
    /** sha256 of the credential secret last applied from the file, used to detect manual credential changes. */
    fingerprint: string;
}

type ManagedSites = Record<string, ManagedSite>;

export interface SitesConfigDependencies {
    globalState: Memento;
    siteManager: SiteManager;
    credentialManager: CredentialManager;
    loginManager: LoginManager;
    removeClient: (site: DetailedSiteInfo) => Promise<void>;
    env?: Record<string, string | undefined>;
}

export function fingerprintSecret(secret: string): string {
    return createHash('sha256').update(secret).digest('hex');
}

export function defaultSitesConfigPath(): string {
    return path.join(os.homedir(), '.atlascode', 'sites.json');
}

/** Bitbucket Server user slugs are lower-cased with URL special characters replaced by `_`. */
function normalizeUser(product: Product, user: string): string {
    const lower = user.trim().toLowerCase();
    return product.key === ProductBitbucket.key ? lower.replace(/[\[:/?#@!$&'()*+,;=%\\\]]/g, '_') : lower;
}

function productForKey(key: string): Product {
    return key === ProductBitbucket.key ? ProductBitbucket : ProductJira;
}

function siteKey(site: DetailedSiteInfo): string {
    return siteConfigKey(site.product.key, site.host, site.contextPath || undefined);
}

/**
 * Creates and keeps Jira / Bitbucket (Server / Data Center) sites in sync with a JSON configuration file.
 *
 * Sites that the user changes manually (credentials edited or the site removed) stop being managed, and the user
 * is warned that the configuration file no longer applies to them until they choose to re-apply it.
 */
export class SitesConfigManager implements Disposable {
    private readonly disposables: Disposable[] = [];
    private fileWatcher: Disposable | undefined;
    private applying: Promise<void> | undefined;
    private reapplyRequested = false;
    /** Keys of sites being (re)authenticated or removed by this manager right now; their events are our own. */
    private readonly inFlight = new Set<string>();

    constructor(private readonly deps: SitesConfigDependencies) {}

    public start(): void {
        this.disposables.push(
            commands.registerCommand(ApplySitesConfigCommand, () => this.apply({ force: true, interactive: true })),
            commands.registerCommand(OpenSitesConfigCommand, () => this.openConfigFile()),
            this.deps.credentialManager.onDidAuthChange((e) => this.onAuthChange(e)),
            this.deps.siteManager.onDidSitesAvailableChange((e) => this.onSitesChange(e)),
            workspace.onDidChangeConfiguration((e) => this.onConfigurationChange(e)),
        );
        this.watchConfigFile();
        void this.apply();
    }

    public dispose(): void {
        this.fileWatcher?.dispose();
        this.disposables.forEach((d) => d.dispose());
    }

    public configFilePath(): string {
        const fromSetting = workspace.getConfiguration().get<string>(SitesConfigFileSetting)?.trim();
        const fromEnv = this.env()[SitesConfigFileEnvVar]?.trim();
        const configured = fromSetting || fromEnv;
        if (!configured) {
            return defaultSitesConfigPath();
        }
        return configured.startsWith('~') ? path.join(os.homedir(), configured.slice(1)) : configured;
    }

    /**
     * Reads the configuration file and applies it. Runs are serialized; a request made while a run is in progress
     * triggers one more run afterwards.
     *
     * @param force re-applies sites the user had changed manually (they become managed again).
     * @param interactive the user asked for this run explicitly, so report a missing file and a summary.
     */
    public async apply(options: { force?: boolean; interactive?: boolean } = {}): Promise<void> {
        if (this.applying) {
            this.reapplyRequested = true;
            await this.applying;
            if (!options.force && !options.interactive) {
                return;
            }
        }
        this.applying = this.doApply(options).finally(() => {
            this.applying = undefined;
        });
        await this.applying;
        if (this.reapplyRequested) {
            this.reapplyRequested = false;
            await this.apply();
        }
    }

    private env(): Record<string, string | undefined> {
        return this.deps.env ?? process.env;
    }

    private managed(): ManagedSites {
        return { ...this.deps.globalState.get<ManagedSites>(ManagedSitesKey, {}) };
    }

    private detached(): string[] {
        return [...this.deps.globalState.get<string[]>(DetachedSitesKey, [])];
    }

    private async saveManaged(managed: ManagedSites): Promise<void> {
        await this.deps.globalState.update(ManagedSitesKey, managed);
    }

    private async saveDetached(detached: string[]): Promise<void> {
        await this.deps.globalState.update(DetachedSitesKey, detached);
    }

    private async doApply({ force, interactive }: { force?: boolean; interactive?: boolean }): Promise<void> {
        const filePath = this.configFilePath();
        let text: string;
        try {
            text = await fs.readFile(filePath, 'utf8');
        } catch (e) {
            if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
                Logger.debug(`Sites configuration file not found at ${filePath}; nothing to apply.`);
                if (interactive) {
                    window.showWarningMessage(`Atlassian: no sites configuration file found at ${filePath}.`);
                }
            } else {
                this.reportErrors(filePath, [`Could not read the file: ${(e as Error).message}`]);
            }
            return;
        }

        const parsed = parseSitesConfig(text, this.env());
        if (parsed.fatal) {
            this.reportErrors(filePath, [parsed.fatal]);
            return;
        }

        let managed = this.managed();
        let detached = this.detached();
        if (force) {
            detached = [];
            await this.saveDetached(detached);
        }

        const errors = parsed.errors.map((e) => `${e.label}: ${e.message}`);
        const applied: string[] = [];

        for (const entry of parsed.entries) {
            if (detached.includes(entry.key)) {
                Logger.debug(`Sites configuration: skipping ${entry.label}, it was changed manually.`);
                continue;
            }
            try {
                if (await this.applyEntry(entry, managed)) {
                    applied.push(entry.label);
                }
            } catch (e) {
                errors.push(`${entry.label}: ${e instanceof Error ? e.message : String(e)}`);
            }
            managed = this.managed();
        }

        // Remove sites created by the file whose entry has been deleted from it. Entries that are still present but
        // currently invalid (e.g. the environment variable is missing) are left alone.
        const keysInFile = new Set([
            ...parsed.entries.map((e) => e.key),
            ...parsed.errors.map((e) => e.key).filter((k): k is string => !!k),
        ]);
        for (const [key, site] of Object.entries(managed)) {
            if (keysInFile.has(key)) {
                continue;
            }
            delete managed[key];
            await this.saveManaged(managed);
            const existing = this.findSite(productForKey(site.product), key);
            if (existing) {
                Logger.info(`Sites configuration: removing ${site.label}, it is no longer in the file.`);
                await this.deps.removeClient(existing);
                await this.deps.siteManager.removeSite(existing);
            }
        }
        await this.saveDetached(detached.filter((k) => keysInFile.has(k)));

        if (errors.length > 0) {
            this.reportErrors(filePath, errors);
        }
        if (interactive && errors.length === 0) {
            window.showInformationMessage(
                applied.length > 0
                    ? `Atlassian: sites configuration applied (${applied.join(', ')}).`
                    : 'Atlassian: sites configuration is already up to date.',
            );
        }
    }

    private findSite(product: Product, key: string): DetailedSiteInfo | undefined {
        return this.deps.siteManager.getSitesAvailable(product).find((s) => siteKey(s) === key);
    }

    /** @returns true when the site was (re)authenticated, false when it was already up to date. */
    private async applyEntry(entry: ResolvedSiteConfigEntry, managed: ManagedSites): Promise<boolean> {
        const secret = getSecretForAuthInfo(entry.authInfo);
        const fingerprint = fingerprintSecret(secret);
        const existing = this.findSite(entry.product, entry.key);

        if (existing && managed[entry.key]?.fingerprint === fingerprint) {
            const current = await this.deps.credentialManager.getAuthInfo(existing, false);
            if (current && getSecretForAuthInfo(current) === secret) {
                return false;
            }
        }

        // Record the fingerprint before logging in so the resulting credential update is recognised as ours.
        managed[entry.key] = {
            product: entry.product.key,
            host: entry.site.host,
            contextPath: entry.site.contextPath,
            label: entry.label,
            fingerprint,
        };
        await this.saveManaged(managed);

        this.inFlight.add(entry.key);
        try {
            await this.deps.loginManager.userInitiatedServerLogin(entry.site, { ...entry.authInfo } as AuthInfo);
        } catch (e) {
            if (!existing) {
                delete managed[entry.key];
                await this.saveManaged(managed);
            }
            throw e instanceof Error ? e : new Error(String(e));
        } finally {
            this.inFlight.delete(entry.key);
        }

        const site = this.findSite(entry.product, entry.key);
        const authInfo = site ? await this.deps.credentialManager.getAuthInfo(site, false) : undefined;
        const actualUser = authInfo?.user?.id;
        if (
            site &&
            actualUser &&
            normalizeUser(entry.product, actualUser) !== normalizeUser(entry.product, entry.user)
        ) {
            delete managed[entry.key];
            await this.saveManaged(managed);
            await this.deps.removeClient(site);
            await this.deps.siteManager.removeSite(site);
            throw new Error(`the token belongs to user "${actualUser}", not "${entry.user}".`);
        }
        Logger.info(`Sites configuration: applied ${entry.label}.`);
        return true;
    }

    private async onAuthChange(e: AuthInfoEvent): Promise<void> {
        if (!isUpdateAuthEvent(e)) {
            return;
        }
        const key = siteKey(e.site);
        const managedSite = this.managed()[key];
        if (!managedSite) {
            return;
        }
        const info = await this.deps.credentialManager.getAuthInfo(e.site, false);
        if (!info) {
            return;
        }
        const fingerprint = fingerprintSecret(getSecretForAuthInfo(info));
        if (fingerprint !== managedSite.fingerprint) {
            await this.detach(key, managedSite, 'its credentials were changed manually');
        }
    }

    private async onSitesChange(e: SitesAvailableUpdateEvent): Promise<void> {
        // Some events only list the sites that changed, so look at the full current list instead of `e.sites`.
        const current = this.deps.siteManager.getSitesAvailable(e.product);
        const managed = this.managed();
        for (const [key, site] of Object.entries(managed)) {
            if (site.product !== e.product.key || this.inFlight.has(key)) {
                continue;
            }
            if (!current.some((s) => siteKey(s) === key)) {
                await this.detach(key, site, 'it was removed manually');
            }
        }
    }

    private async detach(key: string, site: ManagedSite, reason: string): Promise<void> {
        const managed = this.managed();
        if (!managed[key]) {
            return;
        }
        delete managed[key];
        await this.saveManaged(managed);
        const detached = this.detached();
        if (!detached.includes(key)) {
            detached.push(key);
            await this.saveDetached(detached);
        }
        Logger.info(`Sites configuration: ${site.label} is no longer managed, ${reason}.`);

        const reapply = 'Re-apply configuration';
        const choice = await window.showWarningMessage(
            `Atlassian: ${site.host} was set up from the sites configuration file, but ${reason}. ` +
                'The automated configuration will no longer be applied to it.',
            reapply,
        );
        if (choice === reapply) {
            await this.apply({ force: true, interactive: true });
        }
    }

    private reportErrors(filePath: string, errors: string[]): void {
        errors.forEach((e) => Logger.warn(`Sites configuration (${filePath}): ${e}`));
        const open = 'Open file';
        const message =
            errors.length === 1
                ? `Atlassian: the sites configuration was not accepted. ${errors[0]}`
                : `Atlassian: ${errors.length} problems in the sites configuration: ${errors.join(' | ')}`;
        void window.showErrorMessage(message, open).then((choice) => {
            if (choice === open) {
                void this.openConfigFile();
            }
        });
    }

    private async openConfigFile(): Promise<void> {
        const filePath = this.configFilePath();
        try {
            await fs.access(filePath);
        } catch {
            await fs.mkdir(path.dirname(filePath), { recursive: true });
            await fs.writeFile(filePath, JSON.stringify(exampleConfig, undefined, 4) + '\n', 'utf8');
        }
        await window.showTextDocument(Uri.file(filePath));
    }

    private onConfigurationChange(e: ConfigurationChangeEvent): void {
        if (e.affectsConfiguration(SitesConfigFileSetting)) {
            this.watchConfigFile();
            void this.apply();
        }
    }

    private watchConfigFile(): void {
        this.fileWatcher?.dispose();
        const filePath = this.configFilePath();
        const watcher = workspace.createFileSystemWatcher(
            new RelativePattern(Uri.file(path.dirname(filePath)), path.basename(filePath)),
        );
        const onChange = () => void this.apply();
        this.fileWatcher = Disposable.from(watcher, watcher.onDidCreate(onChange), watcher.onDidChange(onChange));
    }
}

const exampleConfig = {
    sites: [
        { type: 'jira', url: 'jira.example.com', user: 'myuser', token: 'JIRA_TOKEN' },
        { type: 'bitbucket', url: 'bitbucket.example.com', user: 'myuser', token: 'BITBUCKET_TOKEN' },
    ],
};

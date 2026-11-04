import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { window, workspace } from 'vscode';

import {
    AuthChangeType,
    AuthInfo,
    AuthInfoEvent,
    DetailedSiteInfo,
    isPATAuthInfo,
    SiteInfo,
} from '../atlclients/authInfo';
import { SitesConfigManager } from './sitesConfigManager';

jest.mock('../logger', () => ({
    Logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

type Listener<T> = (e: T) => unknown;

class Emitter<T> {
    private listeners: Listener<T>[] = [];
    public event = (l: Listener<T>) => {
        this.listeners.push(l);
        return { dispose: () => (this.listeners = this.listeners.filter((x) => x !== l)) };
    };
    public async fire(e: T) {
        await Promise.all(this.listeners.map((l) => l(e)));
    }
}

class MemoryState {
    private data = new Map<string, unknown>();
    public get<T>(key: string, def?: T): T {
        return (this.data.has(key) ? this.data.get(key) : def) as T;
    }
    public async update(key: string, value: unknown) {
        this.data.set(key, JSON.parse(JSON.stringify(value)));
    }
    public keys() {
        return [...this.data.keys()];
    }
}

/** Minimal fakes of SiteManager / CredentialManager / LoginManager backed by in-memory maps. */
function createFakes(tokenOwner: Record<string, string>) {
    const sites: DetailedSiteInfo[] = [];
    const creds = new Map<string, AuthInfo>();
    const siteEvents = new Emitter<any>();
    const authEvents = new Emitter<AuthInfoEvent>();

    const siteManager = {
        getSitesAvailable: () => [...sites],
        onDidSitesAvailableChange: siteEvents.event,
        removeSite: jest.fn(async (site: SiteInfo) => {
            const i = sites.findIndex((s) => s.host === site.host);
            if (i < 0) {
                return false;
            }
            const [removed] = sites.splice(i, 1);
            creds.delete(removed.credentialId);
            await siteEvents.fire({ sites: [...sites], product: site.product });
            return true;
        }),
    };

    const credentialManager = {
        onDidAuthChange: authEvents.event,
        getAuthInfo: jest.fn(async (site: DetailedSiteInfo) => creds.get(site.credentialId)),
    };

    const saveCreds = async (site: DetailedSiteInfo, info: AuthInfo) => {
        creds.set(site.credentialId, info);
        await authEvents.fire({ type: AuthChangeType.Update, site } as AuthInfoEvent);
    };

    const loginManager = {
        userInitiatedServerLogin: jest.fn(async (site: SiteInfo, authInfo: AuthInfo) => {
            const token = isPATAuthInfo(authInfo) ? authInfo.token : (authInfo as any).password;
            const owner = tokenOwner[token];
            if (!owner) {
                return Promise.reject('Error authenticating with Jira: invalid credentials');
            }
            const detailed = {
                product: site.product,
                host: site.host,
                contextPath: site.contextPath ?? '',
                credentialId: `${site.host}::${owner}`,
                id: site.host,
                name: site.host,
                baseLinkUrl: `https://${site.host}`,
                baseApiUrl: `https://${site.host}/rest`,
                isCloud: false,
            } as DetailedSiteInfo;
            // Same order as LoginManager.saveDetailsForSite: credentials first (which fires a sites-changed
            // event for the product), then the site itself.
            await saveCreds(detailed, { ...authInfo, user: { id: owner } } as AuthInfo);
            await siteEvents.fire({ sites: [...sites], product: site.product });
            if (!sites.some((s) => s.host === site.host)) {
                sites.push(detailed);
            }
            // SiteManager.updateSite fires an event that only lists the updated site.
            await siteEvents.fire({ sites: [detailed], product: site.product });
        }),
    };

    return { sites, siteManager, credentialManager, loginManager, saveCreds };
}

describe('SitesConfigManager', () => {
    let dir: string;
    let file: string;
    let state: MemoryState;

    const writeConfig = (sites: object[]) => fs.writeFileSync(file, JSON.stringify({ sites }));
    const jira = (url: string, token: string, user = 'me') => ({ type: 'jira', url, user, token });

    beforeEach(() => {
        jest.clearAllMocks();
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sites-config-'));
        file = path.join(dir, 'sites.json');
        state = new MemoryState();
        (workspace.getConfiguration as jest.Mock).mockReturnValue({ get: () => '' });
        (window.showWarningMessage as jest.Mock).mockResolvedValue(undefined);
        (window.showErrorMessage as jest.Mock).mockResolvedValue(undefined);
    });

    afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

    function createManager(env: Record<string, string>, tokenOwner: Record<string, string> = { t1: 'me', t2: 'me' }) {
        const fakes = createFakes(tokenOwner);
        const manager = new SitesConfigManager({
            globalState: state as any,
            siteManager: fakes.siteManager as any,
            credentialManager: fakes.credentialManager as any,
            loginManager: fakes.loginManager as any,
            removeClient: jest.fn(async () => {}),
            env: { ATLASCODE_SITES_CONFIG: file, ...env },
        });
        // Subscribe to the events without registering commands / file watchers.
        (manager as any).deps.credentialManager.onDidAuthChange((e: AuthInfoEvent) => (manager as any).onAuthChange(e));
        (manager as any).deps.siteManager.onDidSitesAvailableChange((e: any) => (manager as any).onSitesChange(e));
        return { manager, ...fakes };
    }

    it('uses the path from the environment variable', () => {
        const { manager } = createManager({});
        expect(manager.configFilePath()).toBe(file);
    });

    it('adds the configured sites and does nothing on a second run', async () => {
        writeConfig([jira('atmjira.indra.es', 'ATM'), jira('jira.indra.es', 'JIRA')]);
        const { manager, sites, loginManager } = createManager({ ATM: 't1', JIRA: 't2' });

        await manager.apply();
        expect(sites.map((s) => s.host)).toEqual(['atmjira.indra.es', 'jira.indra.es']);
        expect(loginManager.userInitiatedServerLogin).toHaveBeenCalledTimes(2);
        expect(loginManager.userInitiatedServerLogin.mock.calls[0][1]).toEqual({ token: 't1' });

        await manager.apply();
        expect(loginManager.userInitiatedServerLogin).toHaveBeenCalledTimes(2);
        expect(window.showWarningMessage).not.toHaveBeenCalled();
        expect(window.showErrorMessage).not.toHaveBeenCalled();
    });

    it('rejects an entry whose environment variable is not set', async () => {
        writeConfig([jira('atmjira.indra.es', 'MISSING'), jira('jira.indra.es', 'JIRA')]);
        const { manager, sites } = createManager({ JIRA: 't2' });

        await manager.apply();
        expect(sites.map((s) => s.host)).toEqual(['jira.indra.es']);
        expect((window.showErrorMessage as jest.Mock).mock.calls[0][0]).toContain('MISSING is not set');
    });

    it('re-authenticates when the token in the environment changes, without warning', async () => {
        writeConfig([jira('jira.indra.es', 'JIRA')]);
        const first = createManager({ JIRA: 't1' });
        await first.manager.apply();

        // Same persisted state, new process environment.
        const second = createManager({ JIRA: 't2' });
        second.sites.push(...first.sites);
        await second.saveCreds(first.sites[0], { token: 't1', user: { id: 'me' } } as any);
        await second.manager.apply();

        expect(second.loginManager.userInitiatedServerLogin).toHaveBeenCalledTimes(1);
        expect(window.showWarningMessage).not.toHaveBeenCalled();
    });

    it('rejects a token that belongs to another user and removes the site', async () => {
        writeConfig([jira('jira.indra.es', 'JIRA', 'me')]);
        const { manager, sites } = createManager({ JIRA: 't1' }, { t1: 'someone-else' });

        await manager.apply();
        expect(sites).toEqual([]);
        expect((window.showErrorMessage as jest.Mock).mock.calls[0][0]).toContain('someone-else');
        expect(window.showWarningMessage).not.toHaveBeenCalled();
    });

    it('removes a managed site when its entry is deleted from the file', async () => {
        writeConfig([jira('atmjira.indra.es', 'ATM'), jira('jira.indra.es', 'JIRA')]);
        const { manager, sites } = createManager({ ATM: 't1', JIRA: 't2' });
        await manager.apply();

        writeConfig([jira('jira.indra.es', 'JIRA')]);
        await manager.apply();
        expect(sites.map((s) => s.host)).toEqual(['jira.indra.es']);
        expect(window.showWarningMessage).not.toHaveBeenCalled();
    });

    it('keeps a managed site whose entry is still in the file but currently invalid', async () => {
        writeConfig([jira('jira.indra.es', 'JIRA')]);
        const first = createManager({ JIRA: 't1' });
        await first.manager.apply();

        const second = createManager({});
        second.sites.push(...first.sites);
        await second.manager.apply();
        expect(second.siteManager.removeSite).not.toHaveBeenCalled();
    });

    it('warns and stops managing a site whose credentials are changed manually', async () => {
        writeConfig([jira('jira.indra.es', 'JIRA')]);
        const { manager, sites, saveCreds, loginManager } = createManager({ JIRA: 't1' }, { t1: 'me', manual: 'me' });
        await manager.apply();

        await saveCreds(sites[0], { username: 'me', password: 'manual', user: { id: 'me' } } as any);
        expect((window.showWarningMessage as jest.Mock).mock.calls[0][0]).toContain(
            'automated configuration will no longer be applied',
        );

        await manager.apply();
        expect(loginManager.userInitiatedServerLogin).toHaveBeenCalledTimes(1);
    });

    it('warns when a managed site is removed manually and does not add it back', async () => {
        writeConfig([jira('jira.indra.es', 'JIRA')]);
        const { manager, sites, siteManager } = createManager({ JIRA: 't1' });
        await manager.apply();

        await siteManager.removeSite(sites[0]);
        expect((window.showWarningMessage as jest.Mock).mock.calls[0][0]).toContain('removed manually');

        await manager.apply();
        expect(sites).toEqual([]);
    });

    it('re-applies a manually changed site when forced', async () => {
        writeConfig([jira('jira.indra.es', 'JIRA')]);
        const { manager, sites, siteManager } = createManager({ JIRA: 't1' });
        await manager.apply();
        await siteManager.removeSite(sites[0]);

        await manager.apply({ force: true });
        expect(sites.map((s) => s.host)).toEqual(['jira.indra.es']);
    });

    it('reports invalid JSON without touching existing sites', async () => {
        fs.writeFileSync(file, '{ nope');
        const { manager, siteManager } = createManager({});
        await manager.apply();
        expect((window.showErrorMessage as jest.Mock).mock.calls[0][0]).toContain('not valid JSON');
        expect(siteManager.removeSite).not.toHaveBeenCalled();
    });

    it('does nothing when the file does not exist', async () => {
        const { manager, loginManager } = createManager({});
        await manager.apply();
        expect(loginManager.userInitiatedServerLogin).not.toHaveBeenCalled();
        expect(window.showErrorMessage).not.toHaveBeenCalled();
    });
});

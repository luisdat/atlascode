// Exercises remote detection against the real git URL parser (bbUtils.test.ts mocks it),
// covering local remotes, malformed URLs and the supported network URL syntaxes.
// The webpack bundle resolves the CommonJS default export of git-url-parse; mirror that here.
jest.mock('git-url-parse', () => ({
    __esModule: true,
    default: jest.requireActual('git-url-parse'),
}));
jest.mock('../container', () => ({
    Container: {
        siteManager: {
            getSiteForHostname: jest.fn(),
        },
        config: {
            bitbucket: {
                preferredRemotes: ['upstream', 'origin'],
            },
        },
    },
}));
jest.mock('../logger', () => ({
    Logger: {
        error: jest.fn(),
        debug: jest.fn(),
        warn: jest.fn(),
        info: jest.fn(),
    },
}));

import { DetailedSiteInfo, Product, ProductBitbucket } from '../atlclients/authInfo';
import { Container } from '../container';
import { Logger } from '../logger';
import { Remote, Repository, RepositoryState } from '../typings/git';
import {
    bitbucketSiteForRemote,
    getBitbucketRemotes,
    isLocalGitRemoteUrl,
    siteDetailsForRemote,
    workspaceRepoFor,
} from './bbUtils';

const serverSite = {
    id: 'server',
    name: 'Bitbucket Server',
    host: 'bitbucket.example.com',
    isCloud: false,
    product: ProductBitbucket,
} as DetailedSiteInfo;

const cloudSite = {
    id: 'cloud',
    name: 'Bitbucket Cloud',
    host: 'bitbucket.org',
    isCloud: true,
    product: ProductBitbucket,
} as DetailedSiteInfo;

const sites = [serverSite, cloudSite];

// Same matching rule as SiteManager.getSiteForHostname: `site.host.includes(hostname)`,
// which means an empty hostname would match the first registered site.
function getSiteForHostname(product: Product, hostname: string): DetailedSiteInfo | undefined {
    return product.key === ProductBitbucket.key ? sites.find((s) => s.host.includes(hostname)) : undefined;
}

function remote(name: string, fetchUrl: string): Remote {
    return { name, fetchUrl, isReadOnly: false };
}

function repo(path: string, remotes: Remote[]): Repository {
    return {
        rootUri: { toString: () => path } as any,
        state: { remotes } as RepositoryState,
    } as Repository;
}

const httpsOrigin = remote('origin', 'https://bitbucket.example.com/scm/gt_navc/rs.git');
const localBare = remote('bare_mgrojo', '/home/users/nor/mgrojo/bare/navc_nmi_14_ss/drf.git');

describe('bbUtils remote detection with real URL parsing', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        (Container.siteManager.getSiteForHostname as jest.Mock).mockImplementation(getSiteForHostname);
        (Container.config.bitbucket as any).preferredRemotes = ['upstream', 'origin'];
    });

    describe('isLocalGitRemoteUrl', () => {
        it.each([
            '/home/users/nor/mgrojo/bare/navc_nmi_14_ss/drf.git',
            '../bare/drf.git',
            './drf.git',
            'bare/drf.git',
            'drf.git',
            'file:///home/users/nor/mgrojo/bare/navc_nmi_14_ss/drf.git',
            'FILE:///tmp/drf.git',
            'C:\\repos\\drf.git',
            'C:/repos/drf.git',
            '\\\\server\\share\\drf.git',
            './dir:with-colon/drf.git',
        ])('treats %s as local', (url) => {
            expect(isLocalGitRemoteUrl(url)).toBe(true);
        });

        it.each([
            'https://bitbucket.example.com/scm/gt_navc/rs.git',
            'http://bitbucket.example.com/scm/gt_navc/rs.git',
            'ssh://git@bitbucket.example.com:7999/gt_navc/rs.git',
            'git@bitbucket.example.com:gt_navc/rs.git',
            'bitbucket.example.com:gt_navc/rs.git',
            'git@bitbucket.org:workspace/repo.git',
        ])('treats %s as a network remote', (url) => {
            expect(isLocalGitRemoteUrl(url)).toBe(false);
        });
    });

    describe('siteDetailsForRemote / bitbucketSiteForRemote', () => {
        it.each([
            ['HTTPS', 'https://bitbucket.example.com/scm/gt_navc/rs.git', serverSite, 'gt_navc', 'rs'],
            ['SSH', 'ssh://git@bitbucket.example.com:7999/gt_navc/rs.git', serverSite, 'gt_navc', 'rs'],
            ['SCP', 'git@bitbucket.example.com:gt_navc/rs.git', serverSite, 'gt_navc', 'rs'],
            ['Cloud SCP', 'git@bitbucket.org:workspace/repo.git', cloudSite, 'workspace', 'repo'],
        ])('matches a %s remote', (_label, url, site, owner, name) => {
            const r = remote('origin', url);
            expect(siteDetailsForRemote(r)).toBe(site);
            expect(bitbucketSiteForRemote(r)).toEqual({ details: site, ownerSlug: owner, repoSlug: name });
        });

        it.each([
            '/home/users/nor/mgrojo/bare/navc_nmi_14_ss/drf.git',
            '../bare/drf.git',
            'file:///home/users/nor/mgrojo/bare/navc_nmi_14_ss/drf.git',
            'C:\\repos\\drf.git',
        ])('does not match local remote %s and does not log an error', (url) => {
            const r = remote('bare_mgrojo', url);
            expect(siteDetailsForRemote(r)).toBeUndefined();
            expect(bitbucketSiteForRemote(r)).toBeUndefined();
            expect(Logger.error).not.toHaveBeenCalled();
        });

        it('never looks up a site with an empty hostname for file:// remotes', () => {
            const r = remote('bare_mgrojo', 'file:///home/users/nor/mgrojo/bare/navc_nmi_14_ss/drf.git');
            expect(siteDetailsForRemote(r)).toBeUndefined();
            expect(Container.siteManager.getSiteForHostname).not.toHaveBeenCalled();
        });

        it('returns undefined for a remote without a URL', () => {
            expect(siteDetailsForRemote({ name: 'empty', isReadOnly: false })).toBeUndefined();
            expect(Logger.error).not.toHaveBeenCalled();
        });

        it('logs malformed network URLs without the URL itself and returns undefined', () => {
            const r = remote('broken', 'git@bitbucket.example.com:gt navc/s3cret repo.git');
            expect(siteDetailsForRemote(r)).toBeUndefined();
            expect(bitbucketSiteForRemote(r)).toBeUndefined();

            expect(Logger.error).toHaveBeenCalledWith(expect.any(Error), expect.stringContaining("'broken'"));
            for (const [err, message] of (Logger.error as jest.Mock).mock.calls) {
                expect(message).not.toContain('s3cret');
                expect((err as any).subject_url).toBeUndefined();
            }
        });
    });

    describe('workspaceRepoFor', () => {
        it.each([
            ['Bitbucket first', [httpsOrigin, localBare]],
            ['local first', [localBare, httpsOrigin]],
        ])('selects the Bitbucket remote with a local bare remote present (%s)', (_label, remotes) => {
            const result = workspaceRepoFor(repo('/ws/sub', remotes));

            expect(result.mainSiteRemote.remote).toBe(httpsOrigin);
            expect(result.mainSiteRemote.site).toEqual({
                details: serverSite,
                ownerSlug: 'gt_navc',
                repoSlug: 'rs',
            });
            expect(getBitbucketRemotes(repo('/ws/sub', remotes))).toEqual([httpsOrigin]);
            expect(result.siteRemotes.find((sr) => sr.remote === localBare)?.site).toBeUndefined();
        });

        it('keeps the preferred remote even when the local remote has a preferred name', () => {
            (Container.config.bitbucket as any).preferredRemotes = ['bare_mgrojo', 'origin'];

            const result = workspaceRepoFor(repo('/ws/sub', [localBare, httpsOrigin]));

            expect(result.mainSiteRemote.remote).toBe(httpsOrigin);
        });

        it('respects preferred remotes among valid Bitbucket remotes', () => {
            const upstream = remote('upstream', 'git@bitbucket.example.com:upstream_prj/rs.git');
            const remotes = [httpsOrigin, localBare, upstream];

            expect(workspaceRepoFor(repo('/ws/sub', remotes)).mainSiteRemote.remote).toBe(upstream);

            (Container.config.bitbucket as any).preferredRemotes = ['origin', 'upstream'];
            expect(workspaceRepoFor(repo('/ws/sub', remotes)).mainSiteRemote.remote).toBe(httpsOrigin);
        });

        it('does not classify a repository with only local remotes as Bitbucket', () => {
            const fileRemote = remote('file_remote', 'file:///home/users/nor/mgrojo/bare/navc_nmi_14_ss/drf.git');
            const result = workspaceRepoFor(repo('/ws/local-only', [localBare, fileRemote]));

            expect(result.mainSiteRemote.site).toBeUndefined();
            expect(result.siteRemotes.every((sr) => sr.site === undefined)).toBe(true);
            expect(getBitbucketRemotes(repo('/ws/local-only', [localBare, fileRemote]))).toEqual([]);
        });

        it('a malformed remote does not stop other remotes of the same repository', () => {
            const broken = remote('broken', 'git@bitbucket.example.com:gt navc/rs.git');
            const result = workspaceRepoFor(repo('/ws/sub', [broken, localBare, httpsOrigin]));

            expect(result.mainSiteRemote.remote).toBe(httpsOrigin);
            expect(result.siteRemotes).toHaveLength(3);
        });

        it('processes valid repositories before and after ones with local or malformed remotes', () => {
            const workspace = [
                repo('/ws/main', [httpsOrigin]),
                repo('/ws/local-only', [localBare]),
                repo('/ws/broken', [remote('origin', 'git@bitbucket.example.com:bad project/x.git')]),
                repo('/ws/mixed', [localBare, remote('origin', 'git@bitbucket.example.com:gt_navc/other.git')]),
            ];

            const bitbucketRepos = workspace
                .map((r) => workspaceRepoFor(r))
                .filter((wr) => wr.mainSiteRemote.site !== undefined)
                .map((wr) => wr.rootUri);

            expect(bitbucketRepos).toEqual(['/ws/main', '/ws/mixed']);
        });
    });
});

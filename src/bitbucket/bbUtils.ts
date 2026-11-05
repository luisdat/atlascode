import gitUrlParse from 'git-url-parse';

import { DetailedSiteInfo, ProductBitbucket } from '../atlclients/authInfo';
import { bbAPIConnectivityError } from '../constants';
import { Container } from '../container';
import { Logger } from '../logger';
import { Remote, Repository } from '../typings/git';
import { BitbucketApi, BitbucketSite, WorkspaceRepo } from './model';

const bbServerRepoRegEx = new RegExp(/(?<type>users|projects)\/(?<owner>.*)\/repos/);

// Override the max input length to support long Bitbucket Server URLs
// The error is thrown in `parse-url` <- `git-up` <- `git-url-parse`, hence the odd modification here
const parseUrl = require('parse-url');
parseUrl.MAX_INPUT_LENGTH = 3000;

export function parseGitUrl(url: string): gitUrlParse.GitUrl {
    const parsed = gitUrlParse(url);
    parsed.owner = parsed.owner.slice(parsed.owner.lastIndexOf('/') + 1);

    if (parsed.owner === 'repos') {
        const matches = url.match(bbServerRepoRegEx);
        if (matches && matches.groups && matches.groups.type && matches.groups.owner) {
            parsed.owner = matches.groups.type === 'users' ? `~${matches.groups.owner}` : matches.groups.owner;
            parsed.full_name = `${parsed.owner}/${parsed.name}`;
        }
    }
    return parsed;
}

export function getBitbucketRemotes(repository: Repository): Remote[] {
    return repository.state.remotes.filter((remote) => {
        return siteDetailsForRemote(remote) !== undefined;
    });
}

export function getBitbucketCloudRemotes(repository: Repository): Remote[] {
    return repository.state.remotes.filter((remote) => {
        const details = siteDetailsForRemote(remote);
        if (details) {
            return details.isCloud;
        }
        return false;
    });
}

const windowsDrivePathRegEx = /^[a-zA-Z]:[\\/]/;
const urlSchemeRegEx = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\//;

/**
 * Returns true when a git remote URL points to a repository on the local file system rather than to a server.
 * Follows git's own rules: `file://` URLs, Windows drive paths, and anything without a scheme where no `:` appears
 * before the first `/` (absolute paths, relative paths, bare directory names). Everything else (`https://`, `ssh://`,
 * and SCP-like `user@host:path`) is a network remote.
 */
export function isLocalGitRemoteUrl(url: string): boolean {
    const scheme = url.match(urlSchemeRegEx);
    if (scheme) {
        return scheme[1].toLowerCase() === 'file';
    }

    if (windowsDrivePathRegEx.test(url)) {
        return true;
    }

    const colon = url.indexOf(':');
    if (colon < 0) {
        return true;
    }

    const slash = url.indexOf('/');
    return slash >= 0 && slash < colon;
}

/**
 * Parses a remote's URL and finds the Bitbucket site it belongs to.
 * Returns undefined for remotes without a URL, local remotes, unparseable URLs, and hosts without a registered site.
 * Never throws for a bad remote, so one remote cannot stop the others (or other repositories) from being processed.
 */
function bitbucketRemoteInfo(remote: Remote): { site: DetailedSiteInfo; parsed: gitUrlParse.GitUrl } | undefined {
    const url = urlForRemote(remote);
    if (!url || isLocalGitRemoteUrl(url)) {
        // Local remotes have no hostname to match: an empty hostname would match any registered site.
        return undefined;
    }

    let parsed: gitUrlParse.GitUrl;
    try {
        parsed = parseGitUrl(url);
    } catch (err) {
        // URL parsing errors from `parse-url` carry the input as `subject_url`; anything else is unexpected.
        if (err?.subject_url === undefined) {
            throw err;
        }
        // Drop the URL from the error since it may contain credentials.
        err.subject_url = undefined;
        Logger.error(err, `Unable to parse the URL of git remote '${remote.name}'`);
        return undefined;
    }

    if (!parsed.resource) {
        return undefined;
    }

    const site = Container.siteManager.getSiteForHostname(ProductBitbucket, parsed.resource);
    if (site) {
        return { site, parsed };
    }

    const hostname = parsed.source;
    if (
        hostname.includes('bitbucket.org') ||
        hostname.includes('bitbucket_org') ||
        hostname.includes('bitbucket-org')
    ) {
        const cloudSite = Container.siteManager.getSiteForHostname(ProductBitbucket, 'bitbucket.org');
        if (cloudSite) {
            return { site: cloudSite, parsed };
        }
    }

    return undefined;
}

export function siteDetailsForRemote(remote: Remote): DetailedSiteInfo | undefined {
    return bitbucketRemoteInfo(remote)?.site;
}

export function bitbucketSiteForRemote(remote: Remote): BitbucketSite | undefined {
    const info = bitbucketRemoteInfo(remote);
    if (!info) {
        return undefined;
    }
    return {
        details: info.site,
        ownerSlug: info.parsed.owner,
        repoSlug: info.parsed.name,
    };
}

export function urlForRemote(remote: Remote): string {
    return remote ? remote.fetchUrl! || remote.pushUrl! : '';
}

export async function clientForRemote(remote: Remote): Promise<BitbucketApi> {
    const site = siteDetailsForRemote(remote);

    if (site) {
        return await Container.clientManager.bbClient(site);
    }

    return Promise.reject(bbAPIConnectivityError);
}

export async function clientForHostname(hostname: string): Promise<BitbucketApi> {
    const site = Container.siteManager.getSiteForHostname(ProductBitbucket, hostname);

    if (site) {
        return await Container.clientManager.bbClient(site);
    }

    return Promise.reject(bbAPIConnectivityError);
}

export async function clientForSite(site: BitbucketSite): Promise<BitbucketApi> {
    return clientForHostname(site.details.host);
}

// Use only for bitbucket repositories
function firstBitbucketRemote(repo: Repository, preferredRemotes: string[]): Remote {
    const remotes = getBitbucketRemotes(repo);

    for (const preferredRemote of preferredRemotes) {
        const foundRemote = remotes.find((r) => r.name === preferredRemote.trim());
        if (foundRemote) {
            return foundRemote;
        }
    }
    return remotes[0];
}

export function workspaceRepoFor(repository: Repository): WorkspaceRepo {
    const siteRemotes = repository.state.remotes.map((r) => ({
        site: bitbucketSiteForRemote(r),
        remote: r,
    }));

    const firstRemote =
        getBitbucketRemotes(repository).length > 0
            ? firstBitbucketRemote(repository, Container.config.bitbucket.preferredRemotes)
            : repository.state.remotes[0];

    const mainSiteRemote = {
        site: bitbucketSiteForRemote(firstRemote),
        remote: firstRemote,
    };

    return {
        rootUri: repository.rootUri.toString(),
        mainSiteRemote: mainSiteRemote,
        siteRemotes: siteRemotes,
    };
}

export function encodePathParts(path: string) {
    return path?.split('/').map(encodeURIComponent).join('/');
}

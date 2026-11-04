import { BasicAuthInfo, PATAuthInfo, ProductBitbucket, ProductJira } from '../atlclients/authInfo';
import { parseSitesConfig, parseSiteUrl } from './sitesConfigParser';

const env = { ATMJIRA_TOKEN: 'tok-atm', JIRA_TOKEN: 'tok-jira', BB_TOKEN: 'tok-bb', EMPTY: '  ' };

describe('parseSiteUrl', () => {
    it('assumes https for a bare host', () => {
        expect(parseSiteUrl('atmjira.indra.es')).toEqual({
            protocol: 'https:',
            host: 'atmjira.indra.es',
            contextPath: '',
        });
    });

    it('keeps an explicit scheme, port and context path, dropping the trailing slash', () => {
        expect(parseSiteUrl('http://Jira.Example.com:8080/jira/')).toEqual({
            protocol: 'http:',
            host: 'jira.example.com:8080',
            contextPath: '/jira',
        });
    });

    it.each(['', 'ftp://host', 'https://user:pw@host', 'https://host/?a=1', 'not a url at all'])(
        'rejects %p',
        (url) => {
            expect(parseSiteUrl(url)).toBeUndefined();
        },
    );
});

describe('parseSitesConfig', () => {
    it('resolves valid jira and bitbucket entries with PAT auth by default', () => {
        const result = parseSitesConfig(
            JSON.stringify({
                sites: [
                    { type: 'jira', url: 'atmjira.indra.es', user: 'me', token: 'ATMJIRA_TOKEN' },
                    { type: 'Bitbucket', url: 'https://bb.example.com/bitbucket', user: 'me', token: 'BB_TOKEN' },
                ],
            }),
            env,
        );

        expect(result.fatal).toBeUndefined();
        expect(result.errors).toEqual([]);
        expect(result.entries).toHaveLength(2);

        const [jira, bb] = result.entries;
        expect(jira.product).toBe(ProductJira);
        expect(jira.site).toEqual({
            host: 'atmjira.indra.es',
            protocol: 'https:',
            product: ProductJira,
            contextPath: undefined,
        });
        expect(jira.key).toBe('jira|atmjira.indra.es');
        expect((jira.authInfo as PATAuthInfo).token).toBe('tok-atm');
        expect(jira.authMode).toBe('pat');

        expect(bb.product).toBe(ProductBitbucket);
        expect(bb.site.contextPath).toBe('/bitbucket');
        expect(bb.key).toBe('bitbucket|bb.example.com/bitbucket');
    });

    it('uses username + token as password for basic auth', () => {
        const result = parseSitesConfig(
            JSON.stringify({
                sites: [{ type: 'jira', url: 'jira.indra.es', user: 'me', token: 'JIRA_TOKEN', auth: 'basic' }],
            }),
            env,
        );
        expect(result.entries[0].authInfo as BasicAuthInfo).toEqual({ username: 'me', password: 'tok-jira' });
    });

    it('rejects an entry whose environment variable is unset or empty but keeps the valid ones', () => {
        const result = parseSitesConfig(
            JSON.stringify({
                sites: [
                    { type: 'jira', url: 'a.example.com', user: 'me', token: 'MISSING_VAR' },
                    { type: 'jira', url: 'b.example.com', user: 'me', token: 'EMPTY' },
                    { type: 'jira', url: 'jira.indra.es', user: 'me', token: 'JIRA_TOKEN' },
                ],
            }),
            env,
        );
        expect(result.entries.map((e) => e.site.host)).toEqual(['jira.indra.es']);
        expect(result.errors).toHaveLength(2);
        expect(result.errors[0].message).toContain('MISSING_VAR is not set');
        expect(result.errors[1].message).toContain('EMPTY is not set');
    });

    it.each([
        [{ type: 'confluence', url: 'x.com', user: 'me', token: 'JIRA_TOKEN' }, '"type"'],
        [{ type: 'jira', user: 'me', token: 'JIRA_TOKEN' }, '"url" is required'],
        [{ type: 'jira', url: 'ftp://x.com', user: 'me', token: 'JIRA_TOKEN' }, '"url" is not a valid'],
        [{ type: 'jira', url: 'x.com', token: 'JIRA_TOKEN' }, '"user" is required'],
        [{ type: 'jira', url: 'x.com', user: 'me', token: 'not-a-var!' }, '"token" must be the name'],
        [{ type: 'jira', url: 'x.com', user: 'me', token: 'JIRA_TOKEN', auth: 'oauth' }, '"auth"'],
        ['just a string', '"type"'],
    ])('rejects invalid entry %p', (entry, expected) => {
        const result = parseSitesConfig(JSON.stringify({ sites: [entry] }), env);
        expect(result.entries).toEqual([]);
        expect(result.errors).toHaveLength(1);
        expect(result.errors[0].message).toContain(expected);
    });

    it('rejects a duplicated site', () => {
        const entry = { type: 'jira', url: 'jira.indra.es', user: 'me', token: 'JIRA_TOKEN' };
        const result = parseSitesConfig(
            JSON.stringify({ sites: [entry, { ...entry, url: 'https://JIRA.indra.es/' }] }),
            env,
        );
        expect(result.entries).toHaveLength(1);
        expect(result.errors[0].message).toContain('more than once');
    });

    it.each(['{ not json', '[]', '{"sites": {}}', 'null'])('marks %p as fatal', (text) => {
        const result = parseSitesConfig(text, env);
        expect(result.fatal).toBeDefined();
        expect(result.entries).toEqual([]);
    });
});

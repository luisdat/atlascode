const store: Record<string, any> = {};

jest.mock('../../container', () => ({
    Container: {
        context: {
            globalState: {
                get: jest.fn((key: string, defaultValue: any) => store[key] ?? defaultValue),
                update: jest.fn((key: string, value: any) => {
                    store[key] = value;
                    return Promise.resolve();
                }),
            },
        },
    },
}));

import { prFileViewedManager } from './prFileViewedManager';

describe('PRFileViewedManager', () => {
    beforeEach(() => {
        Object.keys(store).forEach((key) => delete store[key]);
        jest.clearAllMocks();
    });

    it('returns an empty array for a PR with no viewed files', () => {
        expect(prFileViewedManager.getViewedFiles('https://example.com/pr/1')).toEqual([]);
    });

    it('marks a file as viewed and persists it', async () => {
        await prFileViewedManager.setFileViewed('https://example.com/pr/1', 'src/foo.ts', true);

        expect(prFileViewedManager.getViewedFiles('https://example.com/pr/1')).toEqual(['src/foo.ts']);
    });

    it('does not duplicate a file that is already marked as viewed', async () => {
        await prFileViewedManager.setFileViewed('https://example.com/pr/1', 'src/foo.ts', true);
        await prFileViewedManager.setFileViewed('https://example.com/pr/1', 'src/foo.ts', true);

        expect(prFileViewedManager.getViewedFiles('https://example.com/pr/1')).toEqual(['src/foo.ts']);
    });

    it('unmarks a file as viewed', async () => {
        await prFileViewedManager.setFileViewed('https://example.com/pr/1', 'src/foo.ts', true);
        await prFileViewedManager.setFileViewed('https://example.com/pr/1', 'src/foo.ts', false);

        expect(prFileViewedManager.getViewedFiles('https://example.com/pr/1')).toEqual([]);
    });

    it('keeps state for different PRs separate', async () => {
        await prFileViewedManager.setFileViewed('https://example.com/pr/1', 'src/foo.ts', true);
        await prFileViewedManager.setFileViewed('https://example.com/pr/2', 'src/bar.ts', true);

        expect(prFileViewedManager.getViewedFiles('https://example.com/pr/1')).toEqual(['src/foo.ts']);
        expect(prFileViewedManager.getViewedFiles('https://example.com/pr/2')).toEqual(['src/bar.ts']);
    });
});

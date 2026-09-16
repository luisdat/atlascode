import { Container } from '../../container';

const STORAGE_KEY = 'atlascode.bitbucket.pr.viewedFiles';

class PRFileViewedManager {
    private readAll(): Record<string, string[]> {
        return Container.context.globalState.get(STORAGE_KEY, {});
    }

    getViewedFiles(prHref: string): string[] {
        return this.readAll()[prHref] ?? [];
    }

    async setFileViewed(prHref: string, file: string, viewed: boolean): Promise<string[]> {
        const all = this.readAll();
        const files = new Set(all[prHref] ?? []);
        viewed ? files.add(file) : files.delete(file);
        all[prHref] = Array.from(files);
        await Container.context.globalState.update(STORAGE_KEY, all);
        return all[prHref];
    }
}

export const prFileViewedManager = new PRFileViewedManager();

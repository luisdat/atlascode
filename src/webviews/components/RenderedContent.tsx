import DOMPurify from 'dompurify';
import React, { useEffect, useMemo, useRef } from 'react';

interface Props {
    html: string;
    fetchImage?: (url: string) => Promise<string>;
    fetchAttachment?: (url: string, filename: string) => void;
}
const VSCODE_IMG_CONTEXT = JSON.stringify({ webviewSection: 'jiraImageElement', preventDefaultContextMenuItems: true });

// Anchor points at a real uploaded file (not just a page on the same site) rather than a normal link -
// intercept only these so ordinary links (to other PRs, issues, external sites, ...) keep opening as before.
function looksLikeAttachmentLink(anchor: HTMLAnchorElement): boolean {
    if (anchor.hasAttribute('download')) {
        return true;
    }
    return /\/(downloads|attachments)\//i.test(anchor.pathname);
}

function filenameFromHref(href: string): string {
    try {
        const lastSegment = new URL(href).pathname.split('/').filter(Boolean).pop();
        return lastSegment ? decodeURIComponent(lastSegment) : 'attachment';
    } catch {
        return 'attachment';
    }
}

// Bitbucket Server/DC attachment URLs end in a numeric ID, not the real filename - prefer the link's own
// visible text when it looks like one (has an extension, isn't a whole sentence/URL).
function filenameFromAnchor(anchor: HTMLAnchorElement): string {
    const text = anchor.textContent?.trim();
    if (text && !text.includes('/') && /\.[a-z0-9]{1,8}$/i.test(text)) {
        return text;
    }
    // anchor.pathname is resolved-but-base-independent for a root-relative href, unlike anchor.href (see
    // below) - safe to use here even though the webview's own document base isn't the real site.
    const lastSegment = anchor.pathname.split('/').filter(Boolean).pop();
    return lastSegment ? decodeURIComponent(lastSegment) : 'attachment';
}

export const RenderedContent: React.FC<Props> = (props: Props) => {
    const ref = useRef<HTMLParagraphElement>(null);
    const sanitizedHtml = useMemo(
        () =>
            DOMPurify.sanitize(props.html, {
                ADD_ATTR: ['atlascode-original-src', 'atlascode-original-src-handled'],
            }),
        [props.html],
    );

    useEffect(() => {
        if (!ref.current || !props.fetchImage) {
            return;
        }
        const paragraphElement = ref.current;
        const errorListener = async (ee: ErrorEvent) => {
            if ((ee?.target as HTMLElement)?.nodeName === 'IMG') {
                const targetEL = ee.target as HTMLImageElement;
                const originalSrc = targetEL.getAttribute('atlascode-original-src');
                const handled = targetEL.getAttribute('atlascode-original-src-handled');
                if (originalSrc !== null && handled === null) {
                    targetEL.setAttribute('atlascode-original-src-handled', 'handled');
                    targetEL.setAttribute('data-vscode-context', VSCODE_IMG_CONTEXT);
                    const imgData = await props.fetchImage?.(originalSrc);
                    if (imgData && imgData.length > 0) {
                        targetEL.src = `data:image/*;base64,${imgData}`;
                        targetEL.alt = '';
                        targetEL.title = '';
                        targetEL.setAttribute('width', 'auto');
                        targetEL.setAttribute('height', 'auto');
                    }
                }
            }
        };

        paragraphElement.addEventListener('error', errorListener, { capture: true });

        return () => {
            paragraphElement?.removeEventListener('error', errorListener, { capture: true });
        };
    }, [props.fetchImage, ref]); // eslint-disable-line react-hooks/exhaustive-deps

    useEffect(() => {
        if (!ref.current || !props.fetchAttachment) {
            return;
        }
        const paragraphElement = ref.current;

        // VS Code's own webview link handling intercepts <a href> clicks and opens them externally before
        // any click listener added here gets a chance to preventDefault it, so a real href always wins
        // that race. Instead, stash the real target on a data attribute and strip the href up front, so
        // there's nothing left for VS Code to navigate to - our click listener below reads the stashed
        // target instead.
        //
        // Stash the *raw* href attribute, not anchor.href - the latter is resolved against the webview's
        // own internal document base (some vscode-resource.vscode-cdn.net pseudo-origin), never the real
        // site, so a relative Server/DC URL would otherwise get silently corrupted into a same-webview
        // resource URL instead of being resolved against the site's real base URL on the extension host.
        const attachmentLinks = paragraphElement.querySelectorAll<HTMLAnchorElement>('a[href]');
        attachmentLinks.forEach((anchor) => {
            if (!looksLikeAttachmentLink(anchor)) {
                return;
            }
            const rawHref = anchor.getAttribute('href')!;
            anchor.setAttribute('atlascode-attachment-href', rawHref);
            anchor.setAttribute('atlascode-attachment-filename', filenameFromAnchor(anchor));
            anchor.removeAttribute('href');
            anchor.style.cursor = 'pointer';
        });

        const clickListener = (ee: MouseEvent) => {
            const anchor = (ee.target as HTMLElement)?.closest?.('a[atlascode-attachment-href]');
            const href = anchor?.getAttribute('atlascode-attachment-href');
            if (!href) {
                return;
            }
            ee.preventDefault();
            const filename = anchor?.getAttribute('atlascode-attachment-filename') || filenameFromHref(href);
            props.fetchAttachment?.(href, filename);
        };

        paragraphElement.addEventListener('click', clickListener);

        return () => {
            paragraphElement?.removeEventListener('click', clickListener);
        };
    }, [props.fetchAttachment, sanitizedHtml]); // eslint-disable-line react-hooks/exhaustive-deps

    /* eslint-disable react-dom/no-dangerously-set-innerhtml -- sanitized with DOMPurify */
    return <p ref={ref} dangerouslySetInnerHTML={{ __html: sanitizedHtml }} />;
    /* eslint-enable react-dom/no-dangerously-set-innerhtml */
};

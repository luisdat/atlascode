import { createTheme, ThemeProvider } from '@mui/material/styles';
import { render, waitFor } from '@testing-library/react';
import React from 'react';

import InlineRenderedTextEditor from './InlineRenderedTextEditor';
import { PullRequestDetailsControllerApi, PullRequestDetailsControllerContext } from './pullRequestDetailsController';

// MarkdownEditor pulls in @atlassianlabs/guipi-core-components, which jest can't transform (pre-existing gap,
// unrelated to this test) - it's only rendered in edit mode, which these tests don't exercise.
jest.mock('../common/editor/MarkdownEditor', () => ({
    MarkdownEditor: () => <div data-testid="markdown-editor" />,
}));

const theme = createTheme();

describe('InlineRenderedTextEditor', () => {
    const renderWithContext = (htmlContent: string, fetchImage: jest.Mock) => {
        const mockController = { fetchImage } as unknown as PullRequestDetailsControllerApi;

        return render(
            <ThemeProvider theme={theme}>
                <PullRequestDetailsControllerContext.Provider value={mockController}>
                    <InlineRenderedTextEditor
                        rawContent="raw content"
                        htmlContent={htmlContent}
                        handleEditorFocus={jest.fn()}
                    />
                </PullRequestDetailsControllerContext.Provider>
            </ThemeProvider>,
        );
    };

    it('renders the provided HTML content', () => {
        const { container } = renderWithContext('<p>Test description</p>', jest.fn());

        expect(container.textContent).toContain('Test description');
    });

    it('fetches an image via the controller when it fails to load', async () => {
        const fetchImage = jest.fn().mockResolvedValue('base64imagedata');
        const html = '<img src="broken.png" atlascode-original-src="https://bitbucket.org/image.png" />';

        const { container } = renderWithContext(html, fetchImage);

        const img = container.querySelector('img') as HTMLImageElement;
        const errorEvent = new ErrorEvent('error', { target: img } as any);
        Object.defineProperty(errorEvent, 'target', { value: img, enumerable: true });
        img.dispatchEvent(errorEvent);

        await waitFor(() => {
            expect(fetchImage).toHaveBeenCalledWith('https://bitbucket.org/image.png');
        });
    });
});

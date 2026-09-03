/** @jest-environment jsdom */
import type { App } from 'obsidian';
import { FormatOptionsModal } from '../../src/ui/formatting/FormatOptions';
import { installObsidianDom } from '../helpers/obsidianDom';

jest.mock('obsidian', () => ({
    ...jest.requireActual('../mocks/obsidian.mock'),
    Modal: class {
        contentEl = document.createElement('div');
    },
}));

const appendTabs = (container: HTMLElement): HTMLElement[] =>
    Array.from({ length: 4 }, () => container.createDiv('format-tab-content'));

beforeAll(() => installObsidianDom(window));
afterEach(() => document.body.replaceChildren());

function modalWithRenderSpy() {
    const modal = new FormatOptionsModal({} as App, {}, jest.fn(), jest.fn());
    const render = jest.spyOn(modal as any, 'createAdvancedTab').mockImplementation(() => {});
    const refresh = () => (modal as any).updateNewNoteOptions();
    return { modal, render, refresh };
}

test('refresh is a no-op when the advanced tab has not been rendered or was removed', () => {
    const { modal, render, refresh } = modalWithRenderSpy();
    expect(refresh).not.toThrow();
    appendTabs(modal.contentEl);
    modal.contentEl.replaceChildren();
    expect(refresh).not.toThrow();
    expect(render).not.toHaveBeenCalled();
});

test('refresh only selects the advanced tab owned by this modal', () => {
    const otherModal = document.body.createDiv();
    appendTabs(otherModal);
    const { modal, render, refresh } = modalWithRenderSpy();
    document.body.appendChild(modal.contentEl);
    const ownTabs = appendTabs(modal.contentEl);
    refresh();
    expect(render).toHaveBeenCalledTimes(1);
    expect(render).toHaveBeenCalledWith(ownTabs[2]);
});

test('refresh finds the advanced tab in a popout document', () => {
    const frame = document.createElement('iframe');
    document.body.appendChild(frame);
    const popout = frame.contentWindow!;
    installObsidianDom(popout);
    const { modal, render, refresh } = modalWithRenderSpy();
    modal.contentEl = popout.document.createElement('div');
    popout.document.body.appendChild(modal.contentEl);
    const ownTabs = appendTabs(modal.contentEl);
    expect(document.querySelectorAll('.format-tab-content')).toHaveLength(0);
    expect(refresh).not.toThrow();
    expect(render).toHaveBeenCalledWith(ownTabs[2]);
});

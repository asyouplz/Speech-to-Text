/** @jest-environment jsdom */
import {
    App,
    Platform,
    requireApiVersion,
    Setting,
    SettingDefinitionRender,
    SettingGroup,
} from 'obsidian';
import { SettingsTab } from '../../src/ui/settings/SettingsTab';
import { SimpleSettingsTab } from '../../src/ui/settings/SimpleSettingsTab';
import { DEFAULT_SETTINGS } from '../../src/domain/models/Settings';
import type SpeechToTextPlugin from '../../src/main';

const mockChanges = new Map<string, (value: unknown) => Promise<void>>();

jest.mock('obsidian', () => {
    class MockSetting {
        settingEl: HTMLElement;
        name = '';
        constructor(container: HTMLElement) {
            this.settingEl = container.createDiv();
        }
        setName(name: string) {
            this.name = name;
            return this;
        }
        setDesc() {
            return this;
        }
        setHeading() {
            return this;
        }
        addDropdown(callback: Function) {
            return this.control(callback);
        }
        addToggle(callback: Function) {
            return this.control(callback);
        }
        addText(callback: Function) {
            return this.control(callback);
        }
        addTextArea(callback: Function) {
            return this.control(callback);
        }
        addButton(callback: Function) {
            return this.control(callback);
        }
        addSlider(callback: Function) {
            return this.control(callback);
        }
        control(callback: Function) {
            const inputEl = this.settingEl.createEl('input');
            const control: Record<string, any> = {
                inputEl,
                sliderEl: inputEl,
                setValue(value: string) {
                    inputEl.value = String(value);
                    return control;
                },
                getValue() {
                    return Number(inputEl.value);
                },
                onChange: (fn: (value: unknown) => Promise<void>) => {
                    mockChanges.set(this.name, fn);
                    return control;
                },
            };
            for (const method of [
                'addOption',
                'addOptions',
                'setPlaceholder',
                'setButtonText',
                'setCta',
                'setClass',
                'setLimits',
                'onClick',
            ]) {
                control[method] = () => control;
            }
            callback(control);
            return this;
        }
    }
    return {
        ...jest.requireActual('../mocks/obsidian.mock'),
        Setting: MockSetting,
        PluginSettingTab: class {
            containerEl = document.createElement('div');
            update = jest.fn();
            constructor(public app: unknown, public plugin: unknown) {}
        },
        requireApiVersion: jest.fn(() => true),
    };
});

function pluginStub(): SpeechToTextPlugin {
    return {
        settings: JSON.parse(JSON.stringify(DEFAULT_SETTINGS)),
        saveSettings: jest.fn().mockResolvedValue(undefined),
    } as unknown as SpeechToTextPlugin;
}

beforeEach(() => {
    mockChanges.clear();
    Platform.isMobile = false;
    jest.mocked(requireApiVersion).mockReturnValue(true);
});

test('settings search indexes existing controls without saving or rendering on registration', () => {
    const plugin = pluginStub();
    const tab = new SettingsTab({} as App, plugin);
    const definitions = tab.getSettingDefinitions() as SettingDefinitionRender[];
    const terms = definitions.flatMap((item) => [item.name, ...(item.aliases ?? [])]);
    expect(terms).toEqual(
        expect.arrayContaining([
            'API key',
            'Language',
            'Temperature',
            'Meeting context',
            'Enable cache',
            'Automatic speaker transcription after stopping',
        ])
    );
    expect(plugin.saveSettings).not.toHaveBeenCalled();
    expect(tab.containerEl.children).toHaveLength(0);
    expect(mockChanges.size).toBe(0);
});

test('searchable sections render existing controls and persist language and recording settings', async () => {
    const plugin = pluginStub();
    const tab = new SettingsTab({} as App, plugin);
    for (const definition of tab.getSettingDefinitions() as SettingDefinitionRender[]) {
        definition.render(new Setting(tab.containerEl), {} as SettingGroup);
    }
    expect(tab.containerEl.querySelectorAll('.sn-settings-section')).toHaveLength(6);
    await mockChanges.get('Language')?.('ko');
    await mockChanges.get('Enable live transcription')?.(true);
    expect(plugin.settings.language).toBe('ko');
    expect(plugin.settings.realtime?.enabled).toBe(true);
    expect(plugin.saveSettings).toHaveBeenCalledTimes(2);
});

test('mobile settings search does not offer desktop microphone controls', () => {
    Platform.isMobile = true;
    const tab = new SettingsTab({} as App, pluginStub());
    expect(JSON.stringify(tab.getSettingDefinitions())).not.toContain('Meeting context');
});

test.each([true, false])(
    'simple settings refresh works with settings search support=%s',
    async (supported) => {
        jest.mocked(requireApiVersion).mockReturnValue(supported);
        const plugin = pluginStub();
        const tab = new SimpleSettingsTab({} as App, plugin);
        if (supported) {
            const definition = tab.getSettingDefinitions()[0] as SettingDefinitionRender;
            definition.render(new Setting(tab.containerEl), {} as SettingGroup);
        } else {
            tab.display();
        }
        await mockChanges.get('Transcription provider')?.('whisper');
        expect(plugin.settings.provider).toBe('whisper');
        expect(plugin.saveSettings).toHaveBeenCalledTimes(1);
        expect(tab.update).toHaveBeenCalledTimes(supported ? 1 : 0);
        expect(mockChanges.has('General provider API key')).toBe(true);
    }
);

test('legacy mobile settings render no microphone controls', () => {
    Platform.isMobile = true;
    jest.mocked(requireApiVersion).mockReturnValue(false);
    const plugin = pluginStub();
    const tab = new SettingsTab({} as App, plugin);
    tab.display();
    expect(mockChanges.has('Language')).toBe(true);
    expect(mockChanges.has('Enable live transcription')).toBe(false);
    expect(mockChanges.has('Meeting context')).toBe(false);
    expect(plugin.saveSettings).not.toHaveBeenCalled();
});

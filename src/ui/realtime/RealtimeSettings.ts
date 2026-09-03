import { Platform, Setting } from 'obsidian';
import type SpeechToTextPlugin from '../../main';
import { normalizeRealtimeSettings } from '../../core/realtime/types';

export function displayRealtimeSettings(container: HTMLElement, plugin: SpeechToTextPlugin): void {
    if (Platform.isMobile) return;
    plugin.settings.realtime = normalizeRealtimeSettings(plugin.settings.realtime);
    const settings = plugin.settings.realtime;
    new Setting(container).setName('Live microphone transcription (preview)').setHeading();
    new Setting(container)
        .setName('Enable live transcription')
        .setDesc(
            'Uses your OpenAI key and saves audio locally. Start explicitly from the command palette. The feature is not started automatically.'
        )
        .addToggle((toggle) =>
            toggle.setValue(settings.enabled).onChange(async (value) => {
                settings.enabled = value;
                await plugin.saveSettings();
            })
        );
    new Setting(container).setName('Live transcription language').addDropdown((dropdown) =>
        dropdown
            .addOptions({
                ko: 'Korean',
                en: 'English',
                ja: 'Japanese',
                zh: 'Chinese',
                es: 'Spanish',
                fr: 'French',
                de: 'German',
            })
            .setValue(settings.language)
            .onChange(async (value) => {
                settings.language = value;
                await plugin.saveSettings();
            })
    );
    new Setting(container)
        .setName('Meeting context')
        .setDesc(
            'Optional context for names and terminology. Sent to OpenAI when you start a session.'
        )
        .addTextArea((text) =>
            text.setValue(settings.prompt).onChange(async (value) => {
                settings.prompt = value.slice(0, 1000);
                await plugin.saveSettings();
            })
        );
    new Setting(container)
        .setName('Stop after (minutes)')
        .setDesc(
            '1–55 minutes per recording. This limit is independent of file transcription budgets. Start another session for longer meetings.'
        )
        .addSlider((slider) =>
            slider
                .setLimits(1, 55, 1)
                .setValue(settings.maxMinutes)
                .setDynamicTooltip()
                .onChange(async (value) => {
                    settings.maxMinutes = value;
                    await plugin.saveSettings();
                })
        );
    new Setting(container)
        .setName('Automatic speaker transcription after stopping')
        .setDesc(
            'Uploads the saved recording to Deepgram using your Deepgram key, with additional API usage. Preserves the live transcript and adds a speaker transcript. Recovery never uploads automatically.'
        )
        .addToggle((toggle) =>
            toggle.setValue(settings.postProcess).onChange(async (value) => {
                settings.postProcess = value;
                await plugin.saveSettings();
            })
        );
}

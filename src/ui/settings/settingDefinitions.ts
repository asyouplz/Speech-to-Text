import type { SettingDefinition, SliderComponent } from 'obsidian';

/** Keep the existing section controls usable in the searchable settings renderer. */
export function defineSettingsSection(
    name: string,
    aliases: string[],
    render: (container: HTMLElement) => void
): SettingDefinition {
    return {
        name,
        aliases,
        render: (setting) => {
            setting.settingEl.empty();
            setting.settingEl.addClass('speech-to-text-settings', 'sn-settings-section');
            render(setting.settingEl);
        },
    };
}

/** Older supported Obsidian versions do not show slider values inline. */
export function withSliderTooltip(slider: SliderComponent): SliderComponent {
    const updateTitle = () => {
        slider.sliderEl.title = String(slider.getValue());
    };
    updateTitle();
    slider.sliderEl.addEventListener('input', updateTitle);
    return slider;
}

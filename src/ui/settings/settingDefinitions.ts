import { requireApiVersion, type SettingDefinition, type SliderComponent } from 'obsidian';

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

/** Add the inline value that Obsidian only provides automatically from 1.13.0 onward. */
export function withCompatibleSliderValue(slider: SliderComponent): SliderComponent {
    if (requireApiVersion('1.13.0')) {
        return slider;
    }

    const valueEl = slider.sliderEl.parentElement?.createSpan({ cls: 'sn-slider-value' });
    if (!valueEl) {
        return slider;
    }

    const updateValue = () => valueEl.setText(String(slider.getValue()));
    updateValue();
    slider.sliderEl.addEventListener('input', updateValue);
    return slider;
}

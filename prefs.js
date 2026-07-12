import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

function makeSpinRow(settings, key, title, subtitle, {lower, upper, step, digits = 0}) {
    const row = new Adw.SpinRow({
        title,
        subtitle,
        digits,
        adjustment: new Gtk.Adjustment({
            lower,
            upper,
            step_increment: step,
            page_increment: step * 10,
        }),
    });
    settings.bind(key, row, 'value', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

function makeSwitchRow(settings, key, title, subtitle) {
    const row = new Adw.SwitchRow({title, subtitle});
    settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

export default class SmoothWindowAnimationsPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        const page = new Adw.PreferencesPage({
            title: 'Animation',
            icon_name: 'preferences-desktop-effects-symbolic',
        });
        window.add(page);

        const openGroup = new Adw.PreferencesGroup({
            title: 'Opening',
            description: 'How windows animate in when they appear',
        });
        page.add(openGroup);

        openGroup.add(makeSpinRow(
            settings, 'open-duration', 'Duration', 'Milliseconds',
            {lower: 50, upper: 1000, step: 10}));

        openGroup.add(makeSpinRow(
            settings, 'open-start-scale', 'Start scale',
            'How small the window starts before growing to full size',
            {lower: 0.5, upper: 0.99, step: 0.01, digits: 2}));

        openGroup.add(makeSwitchRow(
            settings, 'enable-overshoot', 'Overshoot',
            'Grow slightly past full size before settling back'));

        const closeGroup = new Adw.PreferencesGroup({
            title: 'Closing',
            description: 'How windows animate out when they close',
        });
        page.add(closeGroup);

        closeGroup.add(makeSpinRow(
            settings, 'close-duration', 'Duration', 'Milliseconds',
            {lower: 50, upper: 1000, step: 10}));

        closeGroup.add(makeSpinRow(
            settings, 'close-end-scale', 'End scale',
            'How small the window shrinks to before disappearing',
            {lower: 0.5, upper: 0.99, step: 0.01, digits: 2}));

        window.set_default_size(480, 520);
    }
}

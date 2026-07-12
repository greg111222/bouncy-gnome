import Clutter from 'gi://Clutter';
import Meta from 'gi://Meta';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

// --- Tunables ---------------------------------------------------------
// Durations, scales, and the overshoot toggle are all user-configurable -
// see schemas/org.gnome.shell.extensions.smooth-window-animations.gschema.xml
// and prefs.js. Only the close animation's curve is fixed - it stays a
// plain monotonic ease since overshoot on close has nothing to settle into.
const CLOSE_MODE = Clutter.AnimationMode.EASE_IN_OUT_QUAD;

// Window types we bother animating. Things like desktop icons, docks,
// tooltips, notifications, etc. are left alone so we don't break other UI.
const ANIMATED_WINDOW_TYPES = new Set([
    Meta.WindowType.NORMAL,
    Meta.WindowType.DIALOG,
    Meta.WindowType.MODAL_DIALOG,
]);

export default class SmoothWindowAnimationsExtension extends Extension {
    enable() {
        this._settings = this.getSettings();

        // We can't intercept the shell's map/destroy signal handlers directly -
        // they're connected internally via `.bind(this)`, which produces a
        // closure we have no reference to. What we *can* patch is
        // `_shouldAnimateActor`, since the shell looks it up live (as
        // `this._shouldAnimateActor(...)`) right before it starts its own
        // animation. We use that seam to swap in our own effect.
        this._origShouldAnimateActor = Main.wm._shouldAnimateActor;

        const extensionThis = this;

        Main.wm._shouldAnimateActor = function (actor, types) {
            const stack = new Error().stack;
            const forOpening = stack.includes('_mapWindow@');
            const forClosing = stack.includes('_destroyWindow@');

            if ((forOpening || forClosing) && extensionThis._shouldHandle(actor)) {
                const origEase = actor.ease;

                // Intercept just the next call to actor.ease() - that's the
                // one the default _mapWindow/_destroyWindow makes to run
                // its own zoom/fade. We replace it with our animation.
                actor.ease = function (...params) {
                    const innerStack = new Error().stack;
                    const stillOpening = innerStack.includes('_mapWindow@');
                    const stillClosing = innerStack.includes('_destroyWindow@');

                    // Restore immediately so we only ever hijack one call.
                    actor.ease = origEase;

                    if (stillOpening || stillClosing) {
                        extensionThis._runAnimation(actor, stillOpening);
                    } else {
                        origEase.apply(this, params);
                    }
                };

                // Tell the shell "yes, animate this" so it proceeds through
                // its normal map/destroy path up to the ease() call we just
                // hijacked. It still does its own bookkeeping (adding the
                // actor to its internal tracking set) - we complete that
                // bookkeeping ourselves at the end of our animation.
                return true;
            }

            return extensionThis._origShouldAnimateActor.apply(this, [actor, types]);
        };
    }

    disable() {
        if (this._origShouldAnimateActor) {
            Main.wm._shouldAnimateActor = this._origShouldAnimateActor;
            this._origShouldAnimateActor = null;
        }
        this._settings = null;
    }

    _shouldHandle(actor) {
        if (!St.Settings.get().enable_animations)
            return false;

        const win = actor.meta_window;
        if (!win)
            return false;

        return ANIMATED_WINDOW_TYPES.has(win.get_window_type());
    }

    _runAnimation(actor, opening) {
        const settings = this._settings;

        actor.remove_all_transitions();
        actor.set_pivot_point(0.5, 0.5);

        if (opening) {
            const duration = settings.get_int('open-duration');
            const startScale = settings.get_double('open-start-scale');
            const scaleMode = settings.get_boolean('enable-overshoot')
                ? Clutter.AnimationMode.EASE_OUT_BACK
                : Clutter.AnimationMode.EASE_OUT_CUBIC;

            actor.scale_x = startScale;
            actor.scale_y = startScale;
            actor.opacity = 0;
            actor.show();

            // Opacity gets its own plain, monotonic ease. EASE_OUT_BACK (used
            // below for the scale) overshoots past its target before settling
            // - fine for scale, but if opacity rides the same curve it also
            // overshoots past 255 and dips back down, which showed up as a
            // flicker right at the overshoot peak.
            actor.ease({
                opacity: 255,
                duration,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });

            actor.ease({
                scale_x: 1,
                scale_y: 1,
                duration,
                mode: scaleMode,
                onStopped: () => {
                    // Does the shell's own cleanup (resets scale/opacity/
                    // pivot, removes actor from its tracking set, and calls
                    // shellwm.completed_map()).
                    Main.wm._mapWindowDone(global.window_manager, actor);
                },
            });
        } else {
            const duration = settings.get_int('close-duration');
            const endScale = settings.get_double('close-end-scale');

            actor.opacity = 255;
            actor.scale_x = 1;
            actor.scale_y = 1;

            actor.ease({
                scale_x: endScale,
                scale_y: endScale,
                opacity: 0,
                duration,
                mode: CLOSE_MODE,
                onStopped: () => {
                    Main.wm._destroyWindowDone(global.window_manager, actor);
                },
            });
        }
    }
}

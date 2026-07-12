import Clutter from 'gi://Clutter';
import Meta from 'gi://Meta';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

// --- Tunables ---------------------------------------------------------
const CLOSE_MODE = Clutter.AnimationMode.EASE_IN_OUT_QUAD;

const ANIMATED_WINDOW_TYPES = new Set([
    Meta.WindowType.NORMAL,
    Meta.WindowType.DIALOG,
    Meta.WindowType.MODAL_DIALOG,
]);

export default class SmoothWindowAnimationsExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._tracked = new Map(); // actor -> {rect, maximized, fullscreen}

        this._origShouldAnimateActor = Main.wm._shouldAnimateActor;

        const extensionThis = this;

        Main.wm._shouldAnimateActor = function (actor, types) {
            const stack = new Error().stack;
            const forOpening = stack.includes('_mapWindow@');
            const forClosing = stack.includes('_destroyWindow@');

            if ((forOpening || forClosing) && extensionThis._shouldHandle(actor)) {
                const origEase = actor.ease;

                actor.ease = function (...params) {
                    const innerStack = new Error().stack;
                    const stillOpening = innerStack.includes('_mapWindow@');
                    const stillClosing = innerStack.includes('_destroyWindow@');

                    actor.ease = origEase;

                    if (stillOpening || stillClosing) {
                        extensionThis._runAnimation(actor, stillOpening);
                    } else {
                        origEase.apply(this, params);
                    }
                };

                return true;
            }

            return extensionThis._origShouldAnimateActor.apply(this, [actor, types]);
        };

        // --- Resize/move animation --------------------------------------
        for (const actor of global.get_window_actors())
            this._trackActor(actor);

        this._mapId = global.window_manager.connect('map', (wm, actor) => {
            this._trackActor(actor);
        });
    }

    disable() {
        if (this._origShouldAnimateActor) {
            Main.wm._shouldAnimateActor = this._origShouldAnimateActor;
            this._origShouldAnimateActor = null;
        }

        if (this._mapId) {
            global.window_manager.disconnect(this._mapId);
            this._mapId = null;
        }

        if (this._tracked) {
            for (const actor of this._tracked.keys())
                actor.disconnectObject(actor);
            this._tracked = null;
        }

        this._settings = null;
    }

    _shouldHandle(actor) {
        if (!St.Settings.get().enable_animations)
            return false;

        // FIXED: Use the correct method call instead of an undefined property
        const win = actor.get_meta_window ? actor.get_meta_window() : null;
        if (!win)
            return false;

        return ANIMATED_WINDOW_TYPES.has(win.get_window_type());
    }

    _runAnimation(actor, opening) {
        const settings = this._settings;

        actor.remove_all_transitions();
        actor.set_pivot_point(0.5, 0.5);

        // FIXED: Temporarily turn off the blur shader during the open animation
        let dynamicBlurEffect = null;
        if (actor.get_effects) {
            dynamicBlurEffect = actor.get_effects().find(e => e.toString().includes('Blur'));
            if (dynamicBlurEffect) {
                dynamicBlurEffect.set_enabled(false);
            }
        }

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
                    // FIXED: Safely restore the blur effect only AFTER the window is fully opened and scaled to 1.0
                    if (dynamicBlurEffect) {
                        dynamicBlurEffect.set_enabled(true);
                    }
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

    _trackActor(actor) {
        if (!actor || this._tracked.has(actor))
            return;

        const win = actor.get_meta_window ? actor.get_meta_window() : null;
        if (!win)
            return;

        this._tracked.set(actor, {
            rect: win.get_frame_rect(),
            maximized: win.is_maximized ? win.is_maximized() : win.get_maximized(),
            fullscreen: win.is_fullscreen(),
        });

        win.connectObject(
            'size-changed', () => this._onGeometryChanged(actor),
            'position-changed', () => this._onGeometryChanged(actor),
            actor
        );
    }

    _onGeometryChanged(actor) {
        if (!this._tracked || !this._tracked.has(actor))
            return;

        const win = actor.get_meta_window ? actor.get_meta_window() : null;
        if (!win)
            return;

        const prev = this._tracked.get(actor);
        const rect = win.get_frame_rect();
        const maximized = win.is_maximized ? win.is_maximized() : win.get_maximized();
        const fullscreen = win.is_fullscreen();

        const oldRect = prev.rect;
        
        // Prevent infinite event loops if the dimensions match exactly
        if (oldRect.x === rect.x && oldRect.y === rect.y &&
            oldRect.width === rect.width && oldRect.height === rect.height) {
            return;
        }

        // Keep standard maximize/fullscreen transitions native to GNOME
        if (maximized !== prev.maximized || fullscreen !== prev.fullscreen) {
            this._tracked.set(actor, {rect, maximized, fullscreen});
            return;
        }

        if (!this._shouldHandle(actor))
            return;

        // Run the optimized slide-and-resize animation
        this._runResizeAnimation(actor, oldRect, rect);

        // Update baseline metrics immediately for the next layout shift
        this._tracked.set(actor, {rect, maximized, fullscreen});
    }

    _runResizeAnimation(actor, oldRect, newRect) {
        let duration = 220;
        try {
            duration = this._settings.get_int('resize-duration');
        } catch (e) {}

        // 1. Clear any active animations immediately
        actor.remove_all_transitions();

        // 2. HARD RESET: Force the transformation matrix back to identity first.
        actor.translation_x = 0;
        actor.translation_y = 0;
        actor.scale_x = 1.0;
        actor.scale_y = 1.0;

        // Temporarily pause Blur My Shell's application shader
        let dynamicBlurEffect = null;
        if (actor.effects && Array.isArray(actor.effects)) {
            dynamicBlurEffect = actor.effects.find(e => e.toString().includes('Blur'));
            if (dynamicBlurEffect) {
                dynamicBlurEffect.set_enabled(false);
            }
        }

        // 3. Set top-left anchor point for the transition
        actor.set_pivot_point(0, 0);
        
        // Calculate the initial display offsets
        actor.translation_x = oldRect.x - newRect.x;
        actor.translation_y = oldRect.y - newRect.y;
        actor.scale_x = oldRect.width / newRect.width;
        actor.scale_y = oldRect.height / newRect.height;

        // 4. Run the clean visual tween back to native properties (with fixed commas)
        actor.ease({
            translation_x: 0,
            translation_y: 0,
            scale_x: 1.0,
            scale_y: 1.0,
            duration,
            mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
            onStopped: () => {
                // 5. POST-ANIMATION CLEANUP: Restore the native pivot point and clean up transforms
                actor.set_pivot_point(0.5, 0.5);
                actor.translation_x = 0;
                actor.translation_y = 0;
                actor.scale_x = 1.0;
                actor.scale_y = 1.0;

                // Re-enable blur once layout is fully locked in place
                if (dynamicBlurEffect) {
                    dynamicBlurEffect.set_enabled(true);
                }
            }
        });
    }
}

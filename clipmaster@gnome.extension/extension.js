/*
 * ClipMaster - GNOME Shell Extension
 * 
 * Copyright (C) 2025 SFN
 * License: GPL-2.0-or-later
 */

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import St from 'gi://St';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import Clutter from 'gi://Clutter';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { Extension, gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';

import { SignalManager, ValidationUtils } from './src/Util/Utils.js';
import { setDebugMode, debugLog } from './src/Util/Constants.js';
import { ClipboardDatabase } from './src/Manager/Database.js';
import { ClipboardMonitor } from './src/Manager/ClipboardMonitor.js';
import { ClipboardPopup } from './src/UI/Popup.js';
import { ClipMasterIndicator } from './src/UI/Indicator.js';


export default class ClipMasterExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._extensionPath = this.path;
        this._signalManager = new SignalManager();

        setDebugMode(this._settings.get_boolean('debug-mode'));
        this._signalManager.connect(
            this._settings,
            'changed::debug-mode',
            () => setDebugMode(this._settings.get_boolean('debug-mode')),
            'debug-mode-changed'
        );

        const storagePath = this._settings.get_string('storage-path');
        this._database = new ClipboardDatabase(
            storagePath || null,
            this._settings,
            (title, message) => Main.notify(title, message)
        );

        // Initialize database asynchronously
        this._database.init().catch(e => {
            console.error(`ClipMaster: Database initialization error: ${e.message}`);
        });

        this._monitor = new ClipboardMonitor(
            this._settings,
            this._database,
            this._onNewItem.bind(this)
        );
        this._monitor.start();

        this._popup = new ClipboardPopup(this);
        this._popup.set_size(450, 550);
        this._popup.set_position(-10000, -10000); // Start off-screen
        this._popup.visible = false;
        this._popup.opacity = 0;
        this._popup.reactive = false;
        this._popupAddedToChrome = false;

        if (this._settings.get_boolean('show-indicator')) {
            this._indicator = new ClipMasterIndicator(this);
            Main.panel.addToStatusArea('clipmaster', this._indicator);
        }

        this._bindShortcuts();
        // Stylesheet is now loaded automatically by GNOME Shell 45+ if placed in root

        console.log('ClipMaster extension enabled');
    }

    disable() {
        this._unbindShortcuts();

        if (this._monitor) {
            this._monitor.stop();
            this._monitor = null;
        }

        if (this._popup) {
            // Ensure all handlers are cleaned up BEFORE any destruction
            this._popup._isPinned = false; // Force unpin to allow cleanup
            this._popup._isShowing = false;

            // Clean up internal state first
            if (this._popup.dispose_resources) {
                this._popup.dispose_resources();
            }

            // Remove from chrome before destroying
            if (this._popupAddedToChrome) {
                Main.layoutManager.removeChrome(this._popup);
                this._popupAddedToChrome = false;
            }

            this._popup.destroy();
            this._popup = null;
        }

        if (this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
        }

        if (this._database) {
            this._database.destroy();
            this._database = null;
        }

        if (this._signalManager) {
            this._signalManager.disconnectAll();
            this._signalManager = null;
        }

        setDebugMode(false);
        this._settings = null;

        console.log('ClipMaster extension disabled');
    }

    _bindShortcuts() {
        Main.wm.addKeybinding(
            'toggle-popup',
            this._settings,
            Meta.KeyBindingFlags.NONE,
            Shell.ActionMode.ALL,
            this.togglePopup.bind(this)
        );

        Main.wm.addKeybinding(
            'paste-as-plain',
            this._settings,
            Meta.KeyBindingFlags.NONE,
            Shell.ActionMode.ALL,
            this._pasteAsPlain.bind(this)
        );
    }

    _unbindShortcuts() {
        Main.wm.removeKeybinding('toggle-popup');
        Main.wm.removeKeybinding('paste-as-plain');
    }

    _onNewItem(itemId) {
        // Safety check - extension might be disabled during async callback
        if (!this._settings) {
            debugLog('_onNewItem: settings is null, skipping');
            return;
        }

        // Indicator might not exist if show-indicator is off
        if (this._indicator) {
            this._refreshIndicator();
        }

        if (this._settings && this._settings.get_boolean('show-notification')) {
            Main.notify('ClipMaster', _('New item added to clipboard'));
        }
    }

    _refreshIndicator() {
        // Safety check for disposed indicator
        if (!this._indicator) {
            return;
        }

        this._indicator.refresh();
    }

    showPopup() {
        if (!this._popup) {
            debugLog('showPopup: No popup available');
            return;
        }

        if (this._popup._isShowing) {
            debugLog('showPopup: Already showing, ignoring');
            return;
        }

        debugLog('showPopup: Starting to show popup');
        this._previousFocusWindow = global.display?.focus_window ?? null;

        // Add to chrome only when showing (prevents input blocking when hidden)
        if (!this._popupAddedToChrome) {
            Main.layoutManager.addChrome(this._popup, {
                affectsInputRegion: true,
                trackFullscreen: true
            });
            this._popupAddedToChrome = true;
            debugLog('showPopup: Added popup to chrome');
        }

        this._popup.cancelClickOutside();

        this._popup._isShowing = true;

        let popupWidth = ValidationUtils.validateNumber(
            this._settings.get_int('popup-width'),
            300, 2000, 450
        );
        let popupHeight = ValidationUtils.validateNumber(
            this._settings.get_int('popup-height'),
            300, 2000, 550
        );

        // Get cursor position first to determine which monitor to use
        const [mouseX, mouseY] = global.get_pointer();

        // Find the monitor where the cursor is located
        let monitor = Main.layoutManager.primaryMonitor;
        if (mouseX !== undefined && mouseY !== undefined &&
            !isNaN(mouseX) && !isNaN(mouseY)) {
            for (let i = 0; i < Main.layoutManager.monitors.length; i++) {
                const mon = Main.layoutManager.monitors[i];
                if (mouseX >= mon.x && mouseX < mon.x + mon.width &&
                    mouseY >= mon.y && mouseY < mon.y + mon.height) {
                    monitor = mon;
                    break;
                }
            }
        }

        if (!monitor || !monitor.width || !monitor.height) {
            console.log('ClipMaster: No valid monitor found');
            this._popup._isShowing = false;
            return;
        }

        // Default to center of the current monitor
        let posX = Math.round(monitor.x + (monitor.width - popupWidth) / 2);
        let posY = Math.round(monitor.y + (monitor.height - popupHeight) / 2);

        if (this._settings.get_boolean('popup-at-cursor')) {
            if (mouseX !== undefined && mouseY !== undefined &&
                !isNaN(mouseX) && !isNaN(mouseY) &&
                mouseX >= 0 && mouseY >= 0) {
                // Position popup centered horizontally on cursor, slightly above cursor
                posX = Math.round(mouseX - popupWidth / 2);
                posY = Math.round(mouseY - 50);

                // Clamp to the monitor where the cursor is located
                posX = Math.max(monitor.x + 10, Math.min(posX, monitor.x + monitor.width - popupWidth - 10));
                posY = Math.max(monitor.y + 50, Math.min(posY, monitor.y + monitor.height - popupHeight - 10));
            }
        }

        posX = ValidationUtils.validateNumber(posX, 0, 10000, 100);
        posY = ValidationUtils.validateNumber(posY, 0, 10000, 100);

        this._popup.set_size(Math.round(popupWidth), Math.round(popupHeight));
        this._popup.set_position(Math.round(posX), Math.round(posY));

        debugLog(`showPopup: Calling popup.show() at position (${posX}, ${posY})`);
        this._popup.show();
        debugLog('showPopup: Popup.show() completed');
    }

    _getActivationTimestamp() {
        try {
            if (global.display?.get_current_time_roundtrip) {
                return global.display.get_current_time_roundtrip();
            }
        } catch (e) {
            debugLog(`_getActivationTimestamp roundtrip failed: ${e.message}`);
        }

        try {
            if (global.get_current_time) {
                return global.get_current_time();
            }
        } catch (e) {
            debugLog(`_getActivationTimestamp global failed: ${e.message}`);
        }

        return Clutter.CURRENT_TIME;
    }

    _restorePreviousFocusWindow() {
        const window = this._previousFocusWindow;
        this._previousFocusWindow = null;

        if (!window) {
            return;
        }

        try {
            window.activate(this._getActivationTimestamp());
        } catch (e) {
            debugLog(`_restorePreviousFocusWindow failed: ${e.message}`);
        }
    }

    _emitPasteShortcut() {
        try {
            const seat = Clutter.get_default_backend()?.get_default_seat();
            if (!seat?.create_virtual_device) {
                debugLog('_emitPasteShortcut: no virtual keyboard seat available');
                return;
            }

            const keyboard = seat.create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
            const timestamp = Clutter.get_current_event_time() || this._getActivationTimestamp();

            keyboard.notify_keyval(timestamp, Clutter.KEY_Control_L, Clutter.KeyState.PRESSED);
            keyboard.notify_keyval(timestamp, Clutter.KEY_v, Clutter.KeyState.PRESSED);
            keyboard.notify_keyval(timestamp, Clutter.KEY_v, Clutter.KeyState.RELEASED);
            keyboard.notify_keyval(timestamp, Clutter.KEY_Control_L, Clutter.KeyState.RELEASED);
        } catch (e) {
            console.error(`ClipMaster: Failed to emit paste shortcut: ${e.message}`);
        }
    }

    pasteClipboardContents() {
        this.hidePopup();
        this._restorePreviousFocusWindow();

        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 80, () => {
            this._emitPasteShortcut();
            return GLib.SOURCE_REMOVE;
        });
    }

    hidePopup() {
        debugLog('hidePopup: Called');
        if (this._popup) {
            debugLog(`hidePopup: _isShowing=${this._popup._isShowing}, visible=${this._popup.visible}, _isPinned=${this._popup._isPinned}`);

            if (this._popup._isPinned) {
                debugLog('hidePopup: Popup is pinned, not hiding');
                return;
            }

            this._popup._isShowing = false;
            this._popup.hide();

            // Close indicator menu to signal Dash to Panel that menu is closed
            if (this._indicator?.menu) {
                this._indicator.menu.close();
            }

            // Remove from chrome when hidden to prevent any input interference
            if (this._popupAddedToChrome) {
                Main.layoutManager.removeChrome(this._popup);
                this._popupAddedToChrome = false;
                debugLog('hidePopup: Removed popup from chrome');
            }

            // Move off-screen as extra safety measure
            this._popup.set_position(-10000, -10000);
            debugLog('hidePopup: Popup hidden and moved off-screen');
        } else {
            debugLog('hidePopup: No popup available');
        }
    }

    togglePopup() {
        debugLog(`togglePopup: _isShowing=${this._popup ? this._popup._isShowing : 'no popup'}`);
        if (this._popup && this._popup._isShowing) {
            debugLog('togglePopup: Hiding popup');
            this.hidePopup();
        } else {
            debugLog('togglePopup: Showing popup');
            this.showPopup();
        }
    }

    _pasteAsPlain() {
        const items = this._database.getItems({ limit: 1 });
        if (items.length > 0) {
            this._monitor.copyToClipboard(items[0].plainText, true, true);
            this.pasteClipboardContents();
        }
    }
}

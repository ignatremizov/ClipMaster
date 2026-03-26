/*
 * ClipMaster - Panel Indicator
 * License: GPL-2.0-or-later
 */

import GObject from 'gi://GObject';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import St from 'gi://St';
import Clutter from 'gi://Clutter';

import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import { Extension, gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';

import { ItemType } from '../Util/Constants.js';

export const ClipMasterIndicator = GObject.registerClass(
    class ClipMasterIndicator extends PanelMenu.Button {
        _init(extension) {
            super._init(0.0, 'ClipMaster');

            this._extension = extension;
            this._settings = extension._settings;

            this._icon = new St.Icon({
                icon_name: this._settings.get_string('indicator-icon'),
                style_class: 'system-status-icon'
            });
            this.add_child(this._icon);

            this._buildMenu();
        }

        vfunc_event(event) {
            if (event.type() === Clutter.EventType.BUTTON_PRESS) {
                const button = event.get_button();

                if (button === 1) {
                    // Signal to panel extensions (like Dash to Panel) that a menu is open
                    // This prevents auto-hide from triggering when showing our custom popup
                    this.menu.open();
                    this.menu.actor.visible = false;
                    this._extension.togglePopup();
                    return Clutter.EVENT_STOP;
                } else if (button === 3) {
                    this.menu.toggle();
                    return Clutter.EVENT_STOP;
                }
            }

            return super.vfunc_event(event);
        }

        _buildMenu() {
            this._recentSection = new PopupMenu.PopupMenuSection();
            this.menu.addMenuItem(this._recentSection);

            this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

            this.menu.addAction(_('Show Clipboard Manager'), () => {
                this.menu.close();
                this._extension.showPopup();
            });

            this.menu.addAction(_('Clear History'), () => {
                this._extension._database.clearHistory(true);
                this._extension._refreshIndicator();
            });

            this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

            this.menu.addAction(_('Preferences'), () => {
                this.menu.close();
                this._extension.openPreferences();
            });
        }

        refresh() {
            // Safety check for disposed indicator
            if (!this._recentSection || !this._extension || !this._extension._database) {
                return;
            }

            this._recentSection.removeAll();

            const items = this._extension._database.getItems({ limit: 5 });

            if (items.length === 0) {
                const emptyItem = new PopupMenu.PopupMenuItem(_('No clipboard items'), {
                    reactive: false
                });
                this._recentSection.addMenuItem(emptyItem);
                return;
            }

            items.forEach(item => {
                // Check if we're still valid before adding each item
                if (!this._recentSection) return;

                let preview = item.preview || item.content || '';

                // Create menu item
                const menuItem = new PopupMenu.PopupBaseMenuItem();

                // Add thumbnail for image items
                if (item.type === ItemType.IMAGE && item.thumbnail) {
                    try {
                        const thumbData = GLib.base64_decode(item.thumbnail);
                        const bytes = new GLib.Bytes(thumbData);
                        const gicon = Gio.BytesIcon.new(bytes);

                        const thumbIcon = new St.Icon({
                            gicon: gicon,
                            icon_size: 24,
                            style_class: 'clipmaster-indicator-thumbnail'
                        });
                        menuItem.add_child(thumbIcon);
                    } catch (e) {
                        // Fallback to generic icon
                        const fallbackIcon = new St.Icon({
                            icon_name: 'image-x-generic-symbolic',
                            icon_size: 16,
                            style_class: 'popup-menu-icon'
                        });
                        menuItem.add_child(fallbackIcon);
                    }
                    preview = item.preview || 'Image';
                } else if (item.type === ItemType.IMAGE) {
                    // No thumbnail available, use generic icon
                    const imgIcon = new St.Icon({
                        icon_name: 'image-x-generic-symbolic',
                        icon_size: 16,
                        style_class: 'popup-menu-icon'
                    });
                    menuItem.add_child(imgIcon);
                    preview = item.preview || 'Image';
                }

                if (preview.length > 50) {
                    preview = preview.substring(0, 50) + '...';
                }
                preview = preview.replace(/\n/g, ' ');

                const label = new St.Label({
                    text: preview,
                    x_expand: true
                });
                menuItem.add_child(label);

                menuItem.connect('activate', () => {
                    // Safety check for disposed extension components
                    if (!this._extension || !this._extension._monitor) return;

                    if (item.type === ItemType.IMAGE && item.content) {
                        this._extension._monitor.copyImageToClipboard(item.content);
                    } else {
                        this._extension._monitor.copyToClipboard(item.content);
                    }
                });
                this._recentSection.addMenuItem(menuItem);
            });
        }
    });

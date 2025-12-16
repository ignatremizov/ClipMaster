/*
 * ClipMaster - Clipboard Monitor
 * License: GPL-2.0-or-later
 */

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import St from 'gi://St';
import Meta from 'gi://Meta';

import { SignalManager, TimeoutManager, SettingsCache, HashUtils, ValidationUtils } from '../Util/Utils.js';
import { ItemType, debugLog } from '../Util/Constants.js';

export class ClipboardMonitor {
    constructor(settings, database, onNewItem) {
        this._settings = settings;
        this._database = database;
        this._onNewItem = onNewItem;
        this._clipboard = St.Clipboard.get_default();
        this._selection = global.display.get_selection();
        this._lastContent = null;
        this._lastPrimaryContent = null;
        this._lastImageHash = null;
        this._imageCheckProcess = null;
        this._isStopped = false;

        this._signalManager = new SignalManager();
        this._timeoutManager = new TimeoutManager();
        this._settingsCache = new SettingsCache(settings);

        this._primaryGracePeriodEnd = 0;
        this._primaryGracePeriodMs = 5000;

        const maxItemSize = this._settingsCache.getInt('max-item-size-mb', 1) * 1024 * 1024;
        const maxImageSize = this._settingsCache.getInt('max-image-size-mb', 5) * 1024 * 1024;

        this._cachedSettings = {
            trackImages: this._settingsCache.getBoolean('track-images', false),
            maxItemSize: maxItemSize,
            maxImageSize: maxImageSize,
            historySize: this._settingsCache.getInt('history-size', 100)
        };

        this._signalManager.connect(
            settings,
            'changed',
            (settings, key) => this._updateCachedSetting(key),
            'settings-changed'
        );
    }

    _updateCachedSetting(key) {
        switch (key) {
            case 'track-images':
                this._cachedSettings.trackImages = this._settingsCache.getBoolean('track-images', false);
                break;
            case 'max-item-size-mb':
                this._cachedSettings.maxItemSize = this._settingsCache.getInt('max-item-size-mb', 1) * 1024 * 1024;
                break;
            case 'max-image-size-mb':
                this._cachedSettings.maxImageSize = this._settingsCache.getInt('max-image-size-mb', 5) * 1024 * 1024;
                break;
            case 'history-size':
                this._cachedSettings.historySize = this._settingsCache.getInt('history-size', 100);
                break;
        }
    }

    start() {
        this._signalManager.connect(
            this._selection,
            'owner-changed',
            this._onSelectionOwnerChanged.bind(this),
            'selection-owner-changed'
        );

        if (this._settingsCache.getBoolean('track-primary-selection', false)) {
            this._enablePrimaryTracking();
        }

        this._signalManager.connect(
            this._settings,
            'changed::track-primary-selection',
            () => {
                const enabled = this._settingsCache.getBoolean('track-primary-selection', false);
                if (enabled) {
                    this._enablePrimaryTracking();
                } else {
                    this._disablePrimaryTracking();
                }
            },
            'primary-selection-setting'
        );

        this._checkClipboard();
    }

    _enablePrimaryTracking() {
        this._primaryGracePeriodEnd = Date.now() + this._primaryGracePeriodMs;
        debugLog(`Primary selection tracking enabled. Grace period until: ${new Date(this._primaryGracePeriodEnd).toISOString()}`);

        this._signalManager.connect(
            this._selection,
            'owner-changed',
            this._onPrimarySelectionOwnerChanged.bind(this),
            'primary-selection-owner-changed'
        );

        this._checkPrimaryClipboard(true);
    }

    _disablePrimaryTracking() {
        this._signalManager.disconnect('primary-selection-owner-changed');
    }

    stop() {
        this._isStopped = true;

        this._signalManager.disconnectAll();
        this._timeoutManager.removeAll();

        if (this._settingsCache) {
            this._settingsCache.destroy();
            this._settingsCache = null;
        }

        this._cancelImageCheck();
    }

    _cancelImageCheck() {
        // No subprocess logic needed anymore
    }

    _onSelectionOwnerChanged(selection, selectionType, selectionSource) {
        if (this._isStopped) return;

        debugLog(`Selection owner changed, type=${selectionType}`);
        if (selectionType === Meta.SelectionType.SELECTION_CLIPBOARD) {
            debugLog(`Clipboard selection changed!`);
            this._timeoutManager.add(
                GLib.PRIORITY_DEFAULT,
                100,
                () => {
                    if (!this._isStopped) {
                        this._checkClipboard();
                    }
                    return GLib.SOURCE_REMOVE;
                },
                'clipboard-check'
            );
        }
    }

    _onPrimarySelectionOwnerChanged(selection, selectionType, selectionSource) {
        if (this._isStopped) return;

        debugLog(`Primary selection owner changed, type=${selectionType}`);
        if (selectionType === Meta.SelectionType.SELECTION_PRIMARY) {
            debugLog(`Primary selection changed!`);
            this._timeoutManager.add(
                GLib.PRIORITY_DEFAULT,
                100,
                () => {
                    if (!this._isStopped) {
                        this._checkPrimaryClipboard();
                    }
                    return GLib.SOURCE_REMOVE;
                },
                'primary-clipboard-check'
            );
        }
    }

    _checkClipboard() {
        if (this._isStopped) return;

        debugLog(`Checking clipboard...`);
        this._checkForImageWithCallback('CLIPBOARD', (imageFound) => {
            debugLog(`Image check callback: imageFound=${imageFound}, trackImages=${this._cachedSettings.trackImages}`);
            if (!imageFound) {
                this._checkClipboardText();
            } else {
                debugLog(`Image found and processed, skipping text check`);
            }
        });
    }

    _checkClipboardText() {
        this._clipboard.get_text(St.ClipboardType.CLIPBOARD, (clipboard, text) => {
            if (this._isStopped) return;

            // Log redacted for privacy
            debugLog(`Got text from clipboard (length: ${text ? text.length : 0})`);

            let skipDuplicates = true;
            if (this._settings) {
                skipDuplicates = this._settings.get_boolean('skip-duplicates');
            }

            if (text && text !== this._lastContent) {
                debugLog(`NEW content detected, processing...`);
                this._lastContent = text;
                this._processText(text, 'CLIPBOARD');
            } else if (text && text === this._lastContent && !skipDuplicates) {
                debugLog(`Same content but skip-duplicates=OFF, processing anyway...`);
                this._processText(text, 'CLIPBOARD');
            } else {
                debugLog(`Same content or null, skipping`);
            }
        });
    }

    _checkPrimaryClipboard(isInitialCheck = false) {
        debugLog(`Checking primary clipboard... (isInitialCheck=${isInitialCheck})`);
        this._clipboard.get_text(St.ClipboardType.PRIMARY, (clipboard, text) => {
            if (this._isStopped) return;

            debugLog(`Got text from primary (length: ${text ? text.length : 0})`);

            if (text) {
                const trimmedText = text.trim();
                if (trimmedText.length < 3) {
                    debugLog(`Ignoring PRIMARY selection: too short`);
                    this._lastPrimaryContent = text;
                    return;
                }
            }

            const now = Date.now();
            const inGracePeriod = now < this._primaryGracePeriodEnd;

            if (inGracePeriod) {
                debugLog(`In grace period. Updating lastPrimaryContent but NOT saving to history.`);
                if (text) {
                    this._lastPrimaryContent = text;
                }
                return;
            }

            let skipDuplicates = true;
            if (this._settings) {
                skipDuplicates = this._settings.get_boolean('skip-duplicates');
            }

            if (text && text !== this._lastPrimaryContent) {
                debugLog(`NEW primary content detected, processing...`);
                this._lastPrimaryContent = text;
                this._processText(text, 'PRIMARY');
            } else if (text && text === this._lastPrimaryContent && !skipDuplicates) {
                debugLog(`Same primary content but skip-duplicates=OFF, processing anyway...`);
                this._processText(text, 'PRIMARY');
            } else {
                debugLog(`Same primary content or null, skipping`);
            }
        });
    }

    _checkForImage(selectionType = 'CLIPBOARD') {
        this._checkForImageWithCallback(selectionType, null);
    }

    _checkForImageWithCallback(selectionType = 'CLIPBOARD', callback = null) {
        debugLog(`_checkForImageWithCallback called (selectionType=${selectionType})`);

        if (this._isStopped) {
            if (callback) callback(false);
            return;
        }

        // Use native Meta.Selection API
        try {
            const metaSelectionType = selectionType === 'PRIMARY'
                ? Meta.SelectionType.SELECTION_PRIMARY
                : Meta.SelectionType.SELECTION_CLIPBOARD;

            const mimetypes = this._selection.get_mimetypes(metaSelectionType);
            debugLog(`Available MIME types: ${mimetypes ? mimetypes.join(', ') : 'none'}`);

            if (mimetypes && mimetypes.length > 0) {
                const hasImage = mimetypes.some(mime =>
                    mime.startsWith('image/')
                );

                if (hasImage) {
                    debugLog(`✓ Image MIME type detected via Meta.Selection`);
                    const isWayland = GLib.getenv('XDG_SESSION_TYPE') === 'wayland';
                    this._fetchImageFromClipboard(isWayland, selectionType, callback);
                    return;
                }
            }

            debugLog(`✗ No image MIME type found`);
            if (callback) callback(false);
        } catch (e) {
            debugLog(`Meta.Selection check error: ${e.message}, text only fallback`);
            if (callback) callback(false);
        }
    }

    _fetchImageFromClipboard(isWayland, selectionType = 'CLIPBOARD', callback = null) {
        if (this._isStopped) {
            if (callback) callback(false);
            return;
        }

        const maxSize = this._cachedSettings.maxImageSize;
        const timestamp = Date.now();

        try {
            const metaSelectionType = selectionType === 'PRIMARY'
                ? Meta.SelectionType.SELECTION_PRIMARY
                : Meta.SelectionType.SELECTION_CLIPBOARD;

            const tempDir = GLib.get_tmp_dir();
            const tempPath = GLib.build_filenamev([tempDir, `clipmaster_${timestamp}.png`]);
            const tempFile = Gio.File.new_for_path(tempPath);

            const outputStream = tempFile.replace(null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);

            this._selection.transfer_async(
                metaSelectionType,
                'image/png',
                maxSize,
                outputStream,
                null,
                async (selection, result) => {
                    let imageSuccessfullyAdded = false;

                    try {
                        outputStream.close(null);
                    } catch (e) { }

                    if (this._isStopped) {
                        try { tempFile.delete(null); } catch (e) { }
                        return;
                    }

                    try {
                        const success = this._selection.transfer_finish(result);

                        if (success && tempFile.query_exists(null)) {
                            // query_info_async?
                            const info = await tempFile.query_info_async('standard::size', Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_DEFAULT, null);
                            const size = info.get_size();

                            if (size > 0 && size <= maxSize) {
                                // Use async load
                                const [contents] = await tempFile.load_contents_async(null);
                                const hash = HashUtils.hashImageData(contents);

                                if (hash !== this._lastImageHash) {
                                    this._lastImageHash = hash;

                                    if (this._cachedSettings && this._cachedSettings.trackImages) {
                                        const base64 = GLib.base64_encode(contents);

                                        const item = {
                                            type: ItemType.IMAGE,
                                            content: base64,
                                            plainText: `[Image ${timestamp}]`,
                                            preview: `Image (${Math.round(size / 1024)}KB)`,
                                            imageFormat: 'png',
                                            metadata: {
                                                size: size,
                                                hash: hash,
                                                storedAs: 'base64'
                                            }
                                        };

                                        if (!this._isStopped && this._database) {
                                            const itemId = this._database.addItem(item);
                                            this._database.enforceLimit(this._cachedSettings.historySize);

                                            if (this._onNewItem && !this._isStopped) {
                                                this._onNewItem(itemId);
                                            }
                                        }

                                        imageSuccessfullyAdded = true;
                                        debugLog(`Image successfully added via native API`);
                                    } else {
                                        debugLog(`Image found but trackImages=false`);
                                        imageSuccessfullyAdded = true;
                                    }
                                } else {
                                    debugLog(`Image duplicate detected`);
                                    imageSuccessfullyAdded = true;
                                }
                            }
                        }
                    } catch (e) {
                        debugLog(`Native image fetch error: ${e.message}`);
                    }

                    try { tempFile.delete(null); } catch (e) { }

                    if (callback) {
                        callback(imageSuccessfullyAdded);
                    }
                }
            );
        } catch (e) {
            debugLog(`Meta.Selection.transfer_async error: ${e.message}`);
            if (callback) callback(false);
        }
    }

    async _processText(text, selectionType = 'CLIPBOARD') {
        if (this._isStopped || !this._database) return;

        // Removed validation redundancy
        if (!ValidationUtils.isValidText(text, 1)) {
            return;
        }

        if (text.length > this._cachedSettings.maxItemSize) {
            text = text.substring(0, this._cachedSettings.maxItemSize);
        }

        const trimmed = text.trim();

        if (this._cachedSettings.trackImages) {
            const isImagePath = await this._isImageFilePath(trimmed); // Await async check

            if (isImagePath) {
                debugLog(`✓ Text appears to be an image file path`);
                this._processImageFile(trimmed, selectionType);
                return;
            }
        }

        let type = ItemType.TEXT;
        if (trimmed.match(/^https?:\/\//i)) {
            type = ItemType.URL;
        } else if (trimmed.match(/^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i)) {
            type = ItemType.COLOR;
        } else if (trimmed.startsWith('<') && trimmed.includes('>')) {
            type = ItemType.HTML;
        } else if (trimmed.startsWith('file://')) {
            type = ItemType.FILE;
        }

        const item = {
            type: type,
            content: text,
            plainText: text,
            preview: text.substring(0, 200).replace(/\n/g, ' '),
            sourceApp: selectionType === 'PRIMARY' ? 'PRIMARY' : null
        };

        const itemId = this._database.addItem(item);
        this._database.enforceLimit(this._cachedSettings.historySize);

        if (this._onNewItem && !this._isStopped) {
            this._onNewItem(itemId);
        }
    }

    async _isImageFilePath(text) {
        if (!text || text.length < 3) return false;

        const looksLikePath = text.startsWith('/') ||
            text.startsWith('~/') ||
            text.startsWith('./') ||
            (text.includes('/') && !text.includes('://'));

        if (!looksLikePath) return false;

        let filePath = text;
        if (text.startsWith('~/')) {
            filePath = GLib.build_filenamev([GLib.get_home_dir(), text.substring(2)]);
        }

        try {
            const file = Gio.File.new_for_path(filePath);
            if (!file.query_exists(null)) return false;

            // Use async query_info
            const info = await file.query_info_async('standard::content-type', Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_DEFAULT, null);
            const mimeType = info.get_content_type();

            if (mimeType && mimeType.startsWith('image/')) {
                return true;
            }
        } catch (e) {
            // ignore
        }

        // Fallback to extensions if MIME check fails
        const imageExtensions = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg', '.ico', '.tiff', '.tif'];
        const lowerText = text.toLowerCase();
        return imageExtensions.some(ext => lowerText.endsWith(ext));
    }

    async _processImageFile(filePath, selectionType = 'CLIPBOARD') {
        if (this._isStopped || !this._database) return;

        let fullPath = filePath;
        if (filePath.startsWith('~/')) {
            fullPath = GLib.build_filenamev([GLib.get_home_dir(), filePath.substring(2)]);
        }

        const file = Gio.File.new_for_path(fullPath);
        if (!file.query_exists(null)) return;

        try {
            // Async info query
            const info = await file.query_info_async('standard::size', Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_DEFAULT, null);
            const size = info.get_size();
            const maxSize = this._cachedSettings.maxImageSize;

            if (size > maxSize || size === 0) return;

            // Async load
            const [contents] = await file.load_contents_async(null);

            const hash = HashUtils.hashImageData(contents);

            if (hash === this._lastImageHash) return;

            this._lastImageHash = hash;
            const timestamp = Date.now();
            const base64 = GLib.base64_encode(contents);

            const originalExt = fullPath.substring(fullPath.lastIndexOf('.'));
            const ext = originalExt.toLowerCase();
            let imageFormat = 'png';
            if (ext === '.jpg' || ext === '.jpeg') imageFormat = 'jpeg';
            else if (ext === '.gif') imageFormat = 'gif';
            else if (ext === '.webp') imageFormat = 'webp';
            else if (ext === '.bmp') imageFormat = 'bmp';
            else if (ext === '.svg') imageFormat = 'svg';

            const item = {
                type: ItemType.IMAGE,
                content: base64,
                plainText: `[Image from ${GLib.path_get_basename(fullPath)}]`,
                preview: `Image (${Math.round(size / 1024)}KB)`,
                imageFormat: imageFormat,
                metadata: {
                    size: size,
                    originalPath: fullPath,
                    hash: hash,
                    storedAs: 'base64'
                }
            };

            // Check again in case stopped while awaiting
            if (this._isStopped || !this._database) return;

            const itemId = this._database.addItem(item);
            this._database.enforceLimit(this._cachedSettings.historySize);

            if (this._onNewItem && !this._isStopped) {
                this._onNewItem(itemId);
            }
        } catch (e) {
            console.error(`ClipMaster: Error processing image file: ${e.message}`);
        }
    }

    copyToClipboard(text, asPlainText = false) {
        if (asPlainText) {
            text = text.replace(/<[^>]*>/g, '');
        }
        this._lastContent = text;
        this._clipboard.set_text(St.ClipboardType.CLIPBOARD, text);
    }

    copyImageToClipboard(imageContent) {
        try {
            let imageData = null;

            if (imageContent.includes('/') && !imageContent.startsWith('data:')) {
                // Handle file path - we'd need to read it to get bytes
                // But this is synchronous, better to just avoid this if we can't use spawn?
                // Or use set_content?
                // For now, I'll log a warning that this feature requires revision
                console.warn("ClipMaster: Copying image file to clipboard not fully supported without spawn yet.");
                return;
            } else {
                // Base64
                try {
                    imageData = GLib.base64_decode(imageContent);
                } catch (e) {
                    console.error(`ClipMaster: Error decoding base64 image: ${e.message}`);
                    return;
                }
            }

            if (imageData) {
                const bytes = GLib.Bytes.new(imageData);
                this._clipboard.set_content(St.ClipboardType.CLIPBOARD, 'image/png', bytes);
            }
        } catch (e) {
            console.error(`ClipMaster: Error copying image to clipboard: ${e.message}`);
        }
    }
}

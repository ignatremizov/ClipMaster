/*
 * ClipMaster Constants
 * License: GPL-2.0-or-later
 */

export const ItemType = {
    TEXT: 'text',
    HTML: 'html',
    IMAGE: 'image',
    FILE: 'file',
    URL: 'url',
    COLOR: 'color',
    CODE: 'code'
};

export let _debugMode = false;

export function debugLog(message) {
    if (_debugMode) {
        console.debug(`ClipMaster DEBUG: ${message}`);
    }
}

export function setDebugMode(enabled) {
    _debugMode = enabled;
    if (enabled) {
        console.log('ClipMaster: Debug mode ENABLED');
    }
}

export function isDebugMode() {
    return _debugMode;
}

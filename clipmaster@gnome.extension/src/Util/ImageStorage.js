/*
 * ClipMaster - Image Storage Utility
 * License: GPL-2.0-or-later
 * 
 * Handles image file storage with thumbnail generation for optimized database size.
 * Images are stored as WebP files, thumbnails are kept small for popup display.
 */

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import GdkPixbuf from 'gi://GdkPixbuf';

import { debugLog } from './Constants.js';

export class ImageStorage {
    constructor(baseDir = null) {
        this._baseDir = baseDir || GLib.build_filenamev([
            GLib.get_user_data_dir(), 'clipmaster'
        ]);

        this._imagesDir = GLib.build_filenamev([this._baseDir, 'images']);
        this._thumbnailsDir = GLib.build_filenamev([this._baseDir, 'thumbnails']);

        // Thumbnail settings
        this._thumbSize = 128;      // pixels (width or height, maintaining aspect ratio)
        this._thumbQuality = '70';  // WebP quality (0-100)

        this._ensureDirectories();
    }

    _ensureDirectories() {
        try {
            GLib.mkdir_with_parents(this._imagesDir, 0o755);
            GLib.mkdir_with_parents(this._thumbnailsDir, 0o755);
            debugLog(`ImageStorage: Directories ensured at ${this._baseDir}`);
        } catch (e) {
            console.error(`ImageStorage: Failed to create directories: ${e.message}`);
        }
    }

    /**
     * Save an image from raw bytes and generate a thumbnail
     * @param {Uint8Array} imageData - Raw image data
     * @param {string} format - Image format (png, jpeg, webp, etc.)
     * @param {string} hash - Unique hash for the image
     * @returns {Promise<{imagePath: string, thumbnail: string, originalSize: number, thumbnailSize: number}|null>}
     */
    async saveImage(imageData, format = 'png', hash = null) {
        const timestamp = Date.now();
        const imageId = hash || `img_${timestamp}`;

        try {
            // Step 1: Save original image as WebP for compression
            const imagePath = GLib.build_filenamev([this._imagesDir, `${imageId}.webp`]);
            const thumbPath = GLib.build_filenamev([this._thumbnailsDir, `${imageId}.webp`]);

            // Load image data into pixbuf
            const inputStream = Gio.MemoryInputStream.new_from_bytes(new GLib.Bytes(imageData));
            const pixbuf = GdkPixbuf.Pixbuf.new_from_stream(inputStream, null);
            inputStream.close(null);

            if (!pixbuf) {
                debugLog('ImageStorage: Failed to create pixbuf from image data');
                return null;
            }

            const originalWidth = pixbuf.get_width();
            const originalHeight = pixbuf.get_height();

            // Step 2: Save full image as WebP (better compression than PNG)
            // Note: WebP support requires gdk-pixbuf-webp loader (usually installed)
            let savedAsWebp = false;
            try {
                pixbuf.savev(imagePath, 'webp', ['quality'], ['85']);
                savedAsWebp = true;
                debugLog(`ImageStorage: Saved WebP image to ${imagePath}`);
            } catch (e) {
                // Fallback to PNG if WebP not supported
                debugLog(`ImageStorage: WebP not supported, falling back to PNG: ${e.message}`);
                const pngPath = GLib.build_filenamev([this._imagesDir, `${imageId}.png`]);
                pixbuf.savev(pngPath, 'png', [], []);
                debugLog(`ImageStorage: Saved PNG image to ${pngPath}`);
            }

            // Step 3: Create thumbnail
            const thumbPixbuf = this._createThumbnail(pixbuf, this._thumbSize);

            // Step 4: Convert thumbnail to base64 for JSON storage
            let thumbnailBase64 = null;
            try {
                // Try WebP first for smaller size
                const [success, buffer] = thumbPixbuf.save_to_bufferv('webp', ['quality'], [this._thumbQuality]);
                if (success) {
                    thumbnailBase64 = GLib.base64_encode(buffer);
                }
            } catch (e) {
                // Fallback to PNG
                try {
                    const [success, buffer] = thumbPixbuf.save_to_bufferv('png', [], []);
                    if (success) {
                        thumbnailBase64 = GLib.base64_encode(buffer);
                    }
                } catch (e2) {
                    debugLog(`ImageStorage: Failed to create thumbnail buffer: ${e2.message}`);
                }
            }

            // Get file sizes
            const imageFile = Gio.File.new_for_path(savedAsWebp ? imagePath : imagePath.replace('.webp', '.png'));
            const imageInfo = imageFile.query_info('standard::size', Gio.FileQueryInfoFlags.NONE, null);
            const savedImageSize = imageInfo.get_size();

            const thumbnailSize = thumbnailBase64 ? Math.ceil(thumbnailBase64.length * 0.75) : 0;

            debugLog(`ImageStorage: Original ${originalWidth}x${originalHeight}, saved ${savedImageSize} bytes, thumb ~${thumbnailSize} bytes`);

            return {
                imagePath: savedAsWebp ? imagePath : imagePath.replace('.webp', '.png'),
                thumbnail: thumbnailBase64,
                originalSize: imageData.length,
                savedSize: savedImageSize,
                thumbnailSize: thumbnailSize,
                width: originalWidth,
                height: originalHeight,
                format: savedAsWebp ? 'webp' : 'png'
            };

        } catch (e) {
            console.error(`ImageStorage: Error saving image: ${e.message}`);
            return null;
        }
    }

    /**
     * Create a thumbnail from a pixbuf, maintaining aspect ratio
     */
    _createThumbnail(pixbuf, maxSize) {
        const width = pixbuf.get_width();
        const height = pixbuf.get_height();

        let newWidth, newHeight;

        if (width > height) {
            newWidth = maxSize;
            newHeight = Math.round((height / width) * maxSize);
        } else {
            newHeight = maxSize;
            newWidth = Math.round((width / height) * maxSize);
        }

        // Ensure at least 1 pixel
        newWidth = Math.max(1, newWidth);
        newHeight = Math.max(1, newHeight);

        return pixbuf.scale_simple(newWidth, newHeight, GdkPixbuf.InterpType.BILINEAR);
    }

    /**
     * Load the full image from disk
     * @param {string} imagePath - Path to the saved image
     * @returns {Uint8Array|null} - Raw image data or null
     */
    async loadImage(imagePath) {
        try {
            const file = Gio.File.new_for_path(imagePath);
            if (!file.query_exists(null)) {
                debugLog(`ImageStorage: Image not found: ${imagePath}`);
                return null;
            }

            const [loadOk, contents] = file.load_contents(null);
            if (!loadOk || !contents) {
                debugLog(`ImageStorage: Failed to load image bytes: ${imagePath}`);
                return null;
            }
            return contents;
        } catch (e) {
            console.error(`ImageStorage: Error loading image: ${e.message}`);
            return null;
        }
    }

    /**
     * Delete an image and its thumbnail
     * @param {string} imagePath - Path to the image file
     */
    deleteImage(imagePath) {
        try {
            // Delete main image
            const imageFile = Gio.File.new_for_path(imagePath);
            if (imageFile.query_exists(null)) {
                imageFile.delete(null);
                debugLog(`ImageStorage: Deleted image: ${imagePath}`);
            }

            // Delete corresponding thumbnail
            const basename = GLib.path_get_basename(imagePath);
            const thumbPath = GLib.build_filenamev([this._thumbnailsDir, basename]);
            const thumbFile = Gio.File.new_for_path(thumbPath);
            if (thumbFile.query_exists(null)) {
                thumbFile.delete(null);
                debugLog(`ImageStorage: Deleted thumbnail: ${thumbPath}`);
            }
        } catch (e) {
            console.error(`ImageStorage: Error deleting image: ${e.message}`);
        }
    }

    /**
     * Get storage statistics
     */
    async getStats() {
        const stats = {
            imageCount: 0,
            thumbnailCount: 0,
            totalImageSize: 0,
            totalThumbnailSize: 0
        };

        try {
            // Count images
            const imagesDir = Gio.File.new_for_path(this._imagesDir);
            const imagesEnum = imagesDir.enumerate_children('standard::name,standard::size', Gio.FileQueryInfoFlags.NONE, null);

            let info;
            while ((info = imagesEnum.next_file(null)) !== null) {
                stats.imageCount++;
                stats.totalImageSize += info.get_size();
            }
            imagesEnum.close(null);

            // Count thumbnails
            const thumbsDir = Gio.File.new_for_path(this._thumbnailsDir);
            const thumbsEnum = thumbsDir.enumerate_children('standard::name,standard::size', Gio.FileQueryInfoFlags.NONE, null);

            while ((info = thumbsEnum.next_file(null)) !== null) {
                stats.thumbnailCount++;
                stats.totalThumbnailSize += info.get_size();
            }
            thumbsEnum.close(null);

        } catch (e) {
            debugLog(`ImageStorage: Error getting stats: ${e.message}`);
        }

        return stats;
    }

    /**
     * Clean up orphaned images (images not in database)
     * @param {Set<string>} validPaths - Set of image paths that should be kept
     */
    cleanupOrphans(validPaths) {
        try {
            const imagesDir = Gio.File.new_for_path(this._imagesDir);
            const imagesEnum = imagesDir.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);

            let info;
            let deletedCount = 0;

            while ((info = imagesEnum.next_file(null)) !== null) {
                const name = info.get_name();
                const fullPath = GLib.build_filenamev([this._imagesDir, name]);

                if (!validPaths.has(fullPath)) {
                    this.deleteImage(fullPath);
                    deletedCount++;
                }
            }
            imagesEnum.close(null);

            debugLog(`ImageStorage: Cleaned up ${deletedCount} orphaned images`);
            return deletedCount;
        } catch (e) {
            console.error(`ImageStorage: Error cleaning orphans: ${e.message}`);
            return 0;
        }
    }

    get imagesDir() {
        return this._imagesDir;
    }

    get thumbnailsDir() {
        return this._thumbnailsDir;
    }
}

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const logger = require('screwdriver-logger');

/**
 * LuaScriptLoader - Manages loading and execution of Lua scripts in Redis
 *
 * Features:
 * - Load Lua scripts into Redis and cache their SHAs
 * - Auto-reload scripts if Redis loses them (NOSCRIPT error)
 * - Execute scripts by name with proper error handling
 * - Hash validation for cache consistency
 */
class LuaScriptLoader {
    /**
     * Constructor
     * @param {Object} redis - Redis client instance
     */
    constructor(redis) {
        this.redis = redis;
        this.scripts = new Map(); // Map<scriptName, {sha, content, hash}>
        this.scriptDir = path.join(__dirname, 'lua');
    }

    /**
     * Load a Lua script and return its SHA
     * @param {String} scriptName - Script filename (e.g., 'startBuild.lua')
     * @return {Promise<String>} SHA of loaded script
     */
    async loadScript(scriptName) {
        // Check if already loaded
        if (this.scripts.has(scriptName)) {
            const cached = this.scripts.get(scriptName);

            logger.info(`Lua script ${scriptName} already loaded (SHA: ${cached.sha.substring(0, 8)}...)`);

            return cached.sha;
        }

        const scriptPath = path.join(this.scriptDir, scriptName);

        // Check if file exists
        if (!fs.existsSync(scriptPath)) {
            throw new Error(`Lua script not found: ${scriptPath}`);
        }

        const scriptContent = fs.readFileSync(scriptPath, 'utf8');

        // Load script into Redis
        const sha = await this.redis.script('LOAD', scriptContent);

        // Cache script info
        this.scripts.set(scriptName, {
            sha,
            content: scriptContent,
            hash: this.hashScript(scriptContent)
        });

        logger.info(`Loaded Lua script: ${scriptName} (SHA: ${sha.substring(0, 8)}...)`);

        return sha;
    }

    /**
     * Get script SHA (load if not already loaded)
     * @param {String} scriptName
     * @return {Promise<String>}
     */
    async getScriptSha(scriptName) {
        if (!this.scripts.has(scriptName)) {
            await this.loadScript(scriptName);
        }

        return this.scripts.get(scriptName).sha;
    }

    /**
     * Execute a Lua script by name
     * @param {String} scriptName - Script filename
     * @param {Array} keys - KEYS array for script (usually empty for our scripts)
     * @param {Array} args - ARGV array for script
     * @return {Promise<Any>} Script result
     */
    async executeScript(scriptName, keys = [], args = []) {
        const sha = await this.getScriptSha(scriptName);

        try {
            // Execute script using EVALSHA (faster than EVAL)
            const result = await this.redis.evalsha(sha, keys.length, ...keys, ...args);

            return result;
        } catch (err) {
            // If script not found in Redis, reload and retry
            if (err.message && err.message.includes('NOSCRIPT')) {
                logger.warn(`Script ${scriptName} not found in Redis, reloading...`);

                // Remove from cache and reload
                this.scripts.delete(scriptName);
                await this.loadScript(scriptName);

                const newSha = this.scripts.get(scriptName).sha;

                // Retry execution
                return this.redis.evalsha(newSha, keys.length, ...keys, ...args);
            }

            // Re-throw other errors
            throw err;
        }
    }

    /**
     * Load all Lua scripts in the lua directory
     * @return {Promise<Number>} Number of scripts loaded
     */
    async loadAllScripts() {
        // Find all .lua files in lua directory (not in subdirectories)
        const files = fs.readdirSync(this.scriptDir);
        const luaFiles = files.filter(f => f.endsWith('.lua') && !f.startsWith('.'));

        let loadedCount = 0;

        for (const file of luaFiles) {
            try {
                await this.loadScript(file);
                loadedCount += 1;
            } catch (err) {
                logger.error(`Failed to load Lua script ${file}: ${err.message}`);
            }
        }

        logger.info(`Loaded ${loadedCount} Lua script(s)`);

        return loadedCount;
    }

    /**
     * Reload a specific script (useful for hot-reload during development)
     * @param {String} scriptName
     * @return {Promise<String>} New SHA
     */
    async reloadScript(scriptName) {
        this.scripts.delete(scriptName);

        return this.loadScript(scriptName);
    }

    /**
     * Reload all scripts
     * @return {Promise<Number>} Number of scripts reloaded
     */
    async reloadAllScripts() {
        this.scripts.clear();

        return this.loadAllScripts();
    }

    /**
     * Hash script content for cache validation
     * @param {String} content
     * @return {String} Hash (first 8 characters)
     */
    hashScript(content) {
        return crypto.createHash('sha256').update(content).digest('hex').substring(0, 8);
    }

    /**
     * Get info about loaded scripts
     * @return {Array<Object>} Script info
     */
    getLoadedScripts() {
        const scripts = [];

        for (const [name, info] of this.scripts.entries()) {
            scripts.push({
                name,
                sha: info.sha,
                hash: info.hash,
                size: info.content.length
            });
        }

        return scripts;
    }

    /**
     * Check if a script is loaded
     * @param {String} scriptName
     * @return {Boolean}
     */
    isScriptLoaded(scriptName) {
        return this.scripts.has(scriptName);
    }

    /**
     * Clear all cached scripts (does not remove from Redis)
     * @return {void}
     */
    clearCache() {
        this.scripts.clear();
        logger.info('Lua script cache cleared');
    }

    /**
     * Validate that a script exists in Redis
     * @param {String} scriptName
     * @return {Promise<Boolean>}
     */
    async validateScript(scriptName) {
        if (!this.scripts.has(scriptName)) {
            return false;
        }

        const { sha } = this.scripts.get(scriptName);

        try {
            // Check if script exists in Redis using SCRIPT EXISTS
            const exists = await this.redis.script('EXISTS', sha);

            return exists[0] === 1;
        } catch (err) {
            logger.error(`Error validating script ${scriptName}: ${err.message}`);

            return false;
        }
    }
}

module.exports = LuaScriptLoader;

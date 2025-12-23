'use strict';

/**
 * Helper for testing Lua scripts with REAL Redis (via redis-memory-server)
 */

const { RedisMemoryServer } = require('redis-memory-server');
const Redis = require('ioredis');
const fs = require('fs');
const path = require('path');

class LuaTestHelper {
    constructor() {
        this.redisServer = null;
        this.redis = null;
        this.loadedModules = {};
    }

    async start() {
        // Start Redis server in memory
        this.redisServer = await RedisMemoryServer.create();
        const host = await this.redisServer.getHost();
        const port = await this.redisServer.getPort();

        // Connect ioredis client
        this.redis = new Redis({
            host,
            port,
            lazyConnect: true
        });

        await this.redis.connect();
    }

    /**
     * Load a Lua helper module
     * @param {string} moduleName - Name of the module file (e.g., 'CollapseDecider.lua')
     * @return {string} The Lua module code
     */
    loadModule(moduleName) {
        if (this.loadedModules[moduleName]) {
            return this.loadedModules[moduleName];
        }

        const modulePath = path.join(__dirname, '../../../../../plugins/worker/lib/lua/lib', moduleName);

        const moduleCode = fs.readFileSync(modulePath, 'utf8');

        this.loadedModules[moduleName] = moduleCode;

        return moduleCode;
    }

    /**
     * Execute a Lua module function
     *
     * @param {string} moduleName - Name of the module (e.g., 'CollapseDecider.lua')
     * @param {string} functionName - Name of the function to call
     * @param {Array} args - Arguments to pass to the function
     * @return {Promise<any>} Result from the Lua function (parsed from JSON)
     */
    async executeModuleFunction(moduleName, functionName, args) {
        const moduleCode = this.loadModule(moduleName);
        const moduleBaseName = moduleName.replace('.lua', '');

        // Build Lua script that loads module and calls function
        const luaScript = `
-- Load the module
local function loadModule()
${moduleCode}
end

local ${moduleBaseName} = loadModule()

-- Parse arguments from ARGV (JSON encoded)
local args = {}
for i = 1, #ARGV do
    args[i] = cjson.decode(ARGV[i])
end

-- Call the function
local result = ${moduleBaseName}.${functionName}(unpack(args))

-- Return result as JSON (Redis supports cjson natively)
return cjson.encode(result)
`;

        // Convert args to JSON strings
        const jsonArgs = args.map(arg => JSON.stringify(arg));

        // Execute via real Redis EVAL
        const result = await this.redis.eval(luaScript, 0, ...jsonArgs);

        // Parse JSON result
        return JSON.parse(result);
    }

    /**
     * Clean up Redis server and connection
     */
    async cleanup() {
        if (this.redis) {
            await this.redis.quit();
            this.redis = null;
        }
        if (this.redisServer) {
            await this.redisServer.stop();
            this.redisServer = null;
        }
    }
}

module.exports = LuaTestHelper;

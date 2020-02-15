'use strict';

const logger = require('screwdriver-logger');

/**
 * Wrapper fn for registering plugins
 * @param {Object} server The Hapi server object
 * @param {Object} config The config object
 */
async function registerResourcePlugins(server) {
    try {
        const plugins = [
            'worker',
            'queue'
        ];

        return plugins.map(pluginName => server.register({
            /* eslint-disable global-require, import/no-dynamic-require */
            plugin: require(`../plugins/${pluginName}`),
            options: {
                name: pluginName
            },
            routes: {
                prefix: '/v1'
            }
        }));
    } catch (err) {
        logger.error(`Failed to register pulgin ${err}`);
        throw err;
    }
}
/**
 * Registers the plugins for the server
 * @async registerPlugins
 * @param {Object} server The Hapi server object
 * @param {Object} config The config object
 */
async function registerPlugins(server, config) {
    await registerResourcePlugins(server, config);
}

module.exports = registerPlugins;

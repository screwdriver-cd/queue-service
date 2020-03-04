'use strict';

const logger = require('screwdriver-logger');
const Blipp = require('blipp');

/**
 * Wrapper fn for registering plugins
 * @param {Object} server The Hapi server object
 * @param {Object} config The config object
 */
async function registerResourcePlugins(server, config) {
    try {
        const plugins = [
            'worker',
            'queue',
            'status'
        ];

        return plugins.map(pluginName => server.register({
            /* eslint-disable global-require, import/no-dynamic-require */
            plugin: require(`../plugins/${pluginName}`),
            options: Object.assign({}, config[pluginName] || {}, {
                name: pluginName
            }),
            routes: {
                prefix: '/v1'
            }
        }));
    } catch (err) {
        logger.error(`Failed to register pulgin: ${err}`);
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
    try {
        await registerResourcePlugins(server, config);
        await server.register({ plugin: Blipp, options: { showAuth: true } });
    } catch (err) {
        throw err;
    }
}

module.exports = registerPlugins;

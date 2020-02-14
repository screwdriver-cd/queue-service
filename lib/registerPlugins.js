'use strict';
const logger = require('screwdriver-logger');

// async function* registerPlugins(server) {
//     const plugins = [
//         'worker',
//         'executor',
//         'scheduler'
//     ]

//     for (const plugin of plugins) {
//         yield await require(plugin);
//         server.register(plugin, {
//             routes: {
//                 prefix: '/v1'
//             }
//         }, Promise.resolve([]));
//     }
// }


async function registerResourcePlugins(server, config) {
    try {
        const plugins = [
            'worker',
            'queue'
        ]

        return plugins.map(async (pluginName) => {
            return await server.register({
                plugin: require(`../plugins/${pluginName}`),
                options: {
                    name: pluginName,
                },
                routes: {
                    prefix: '/v1'
                }
            });
        });
    }
    catch (err) {
        logger.error(`Failed to register pulgin ${err}`);
    }
}

// plugin: require(`../plugins/${pluginName}`),
// options: {
//     name: pluginName,
// },
// routes: {
//     prefix: '/v1'
// }

// register: require(`../plugins/${pluginName}`).register,
//             options: {
//                 name: pluginName
//             }
//         }, {
//             routes: {
//                 prefix: '/v1'
//             }
//         });
async function registerPlugins(server, config) {
    await registerResourcePlugins(server, config)
}

module.exports = registerPlugins;
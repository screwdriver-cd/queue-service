'use strict';


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
    const plugins = [
        'worker',
        'queue'
    ]

    plugins.reduce(async (pluginName) => {
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
async function plugins(server, config) {
    registerResourcePlugins(server, config)
}

module.exports = plugins;
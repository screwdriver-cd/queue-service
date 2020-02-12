'use strict';


async function* registerPlugins(server) {
    const plugins = [
        'worker',
        'executor',
        'scheduler'
    ]

    for (const plugin of plugins) {
        yield await require(plugin);
        server.register(plugin, {
            routes: {
                prefix: '/v4'
            }
        }, Promise.resolve([]));
    }
}


async function registerResourcePlugins(server) {
    const plugins = [
        'worker',
        'executor',
        'scheduler'
    ]

    return plugins.reduce(async (plugin) => {
        const file = await require(plugin)
        return await server.register(file, {
            routes: {
                prefix: '/v1'
            }
        }, Promise.resolve([]));
    })
}

async function plugins(server) {
    registerPlugins(server)
}

module.exports = plugins;
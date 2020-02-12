'use strict';

const Hapi = require('@hapi/hapi');
const plugins = require('./plugins');
const ExecutorQueue = require('./queue');

module.exports = async (config) => {
    try {
        const server = Hapi.Server({
            port: process.env.NODE_PORT || 3000,
            host: 'localhost',
            connections: {
                routes: {
                    log: true
                },
                router: {
                    stripTrailingSlash: true
                }
            }
        });

        server.app.executorQueue = new ExecutorQueue(config);

        await plugins(server)

        await server.start();
        console.log('Server running on %s', server.info.uri);
    }
    catch(err) {
        console.log('Error in starting server', err)
    }
};

process.on('unhandledRejection', (err) => {

    console.log(err);
    process.exit(1);
});
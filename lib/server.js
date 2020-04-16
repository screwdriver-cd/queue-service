'use strict';

const Hapi = require('@hapi/hapi');
const logger = require('screwdriver-logger');
const Joi = require('@hapi/joi');
const hoek = require('@hapi/hoek');
const registerPlugins = require('./registerPlugins');
const ExecutorQueue = require('./queue');

/**
 * If we're throwing errors, let's have them say a little more than just 500
 * @method prettyPrintErrors
 * @param  {Hapi.Request}    request Hapi Request object
 * @param  {Hapi.h}     h   Hapi Response Toolkit
 */
function prettyPrintErrors(request, h) {
    const { response } = request;

    if (!response.isBoom) {
        return h.continue;
    }
    const err = response;
    const errName = err.output.payload.error;
    const errMessage = err.message;
    const { statusCode } = err.output.payload;
    const stack = err.stack || errMessage;

    if (statusCode === 500) {
        request.log(['server', 'error'], stack);
    }

    const res = {
        statusCode,
        error: errName,
        message: errMessage
    };

    if (err.data) {
        res.data = err.data;
    }

    return h.response(res).code(statusCode);
}

module.exports = async config => {
    try {
        const server = new Hapi.Server({
            port: config.httpd.port,
            host: config.httpd.host,
            uri: config.httpd.uri,
            routes: {
                log: { collect: true }
            },
            router: {
                stripTrailingSlash: true
            }
        });

        // Setup Executor
        const executor = new ExecutorQueue({
            ecosystem: hoek.clone(config.ecosystem),
            ...config.queueConfig
        });

        server.app = {
            executorQueue: executor
        };

        server.validator(Joi);

        // Write prettier errors
        server.ext('onPreResponse', prettyPrintErrors);

        await registerPlugins(server, config);

        logger.info('Server running on %s', server.info.uri);

        server.app.executorQueue.tokenGen = (profile, expiresIn) =>
            server.plugins.auth.generateToken(profile, expiresIn);

        server.app.executorQueue.userTokenGen = (username, metadata, scmContext) => {
            const profile = server.plugins.auth.generateProfile(username, scmContext, ['user'], metadata);

            return server.plugins.auth.generateToken(profile);
        };

        // init scheduler
        const res1 = await server.plugins.queue.init(server.app.executorQueue);

        logger.info('Initialized queue %s', res1);
        // start worker
        const res2 = await server.plugins.worker.init();

        logger.info('Started worker %s', res2);

        if (server.plugins.shutdown) {
            server.plugins.shutdown.handler({
                taskname: 'scheduler-cleanup',
                task: async () => {
                    await server.plugins.queue.cleanUp(server.app.executorQueue);
                }
            });
            server.plugins.shutdown.handler({
                taskname: 'worker-cleanup',
                task: async () => {
                    await server.plugins.worker.cleanUp();
                }
            });
        }

        await server.start();

        return server;
    } catch (err) {
        logger.error(`Error in starting server ${err}`);
        throw err;
    }
};

process.on('unhandledRejection', err => {
    logger.error('Unhandled error', err);
    process.exit(1);
});

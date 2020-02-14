'use strict';

const Hapi = require('@hapi/hapi');
const registerPlugins = require('./registerPlugins');
const logger = require('screwdriver-logger');
const laabr = require('laabr');
const Blipp = require('blipp');
const Joi = require('@hapi/joi');

/**
 * If we're throwing errors, let's have them say a little more than just 500
 * @method prettyPrintErrors
 * @param  {Hapi.Request}    request Hapi Request object
 * @param  {Hapi.h}      h   Hapi Reply object
 */
function prettyPrintErrors(request, h) {
    const response = request.response;
    if (!response.isBoom) {
        return h.continue;
    }
    const err = response;
    const errName = err.output.payload.error;
    const errMessage = err.message;
    const statusCode = err.output.payload.statusCode;
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
};


module.exports = async (config) => {
    try {
        const server = Hapi.Server({
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

        server.app = {
            executorQueue: config.stats.executor
        };

        server.validator(Joi);

        // Write prettier errors
        server.ext('onPreResponse', prettyPrintErrors);

        server.events.on('response', (request) => {
            console.log(request.info.remoteAddress + ': ' + request.method.toUpperCase() + ' '
                + request.path + ' --> ' + request.response.statusCode);
        });

        await registerPlugins(server, config);

        await server.register({
            plugin: laabr,
            options: {
                formats: { onPostStart: ':time :start :level :message' },
                tokens: { start: () => '[start]' },
                indent: 0
            }
        });
        await server.register({ plugin: Blipp, options: { showAuth: true } });

        await server.start();
        logger.info('Server running on %s', server.info.uri);
    }
    catch (err) {
        logger.error(`Error in starting server ${err}`)
    }
};

process.on('unhandledRejection', (err) => {
    console.log(err);
    process.exit(1);
});